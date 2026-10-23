/**
 * External CLIs as the *main agent* of a normal DSH chat session.
 *
 * DSH's agent loop is fixed, but its model layer is an open seam: LULUX Flow
 * registers one LLM provider route per kernel (`lulux-flow-claude-code`, ...).
 * Selecting that route in DSH's model picker makes every chat turn go to the
 * CLI: the CLI receives the user's message, runs its own tools in the
 * session's working directory (on DSH's real model via the scoped gateway),
 * and its answer streams back as the assistant message. CLI tool activity is
 * shown as reasoning lines; CLI permission prompts (Claude Code) surface as
 * DSH approval prompts.
 *
 * What is NOT possible through this seam (documented in docs/architecture.md):
 * DSH's own tools are not offered to the CLI, and the CLI's tool calls are
 * not DSH tool calls — the CLI executes them itself.
 */
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { KernelService } from '../kernels/service.js'
import { queuedLine, type KernelQueueStatus } from '../kernels/limiter.js'
import type { KernelDefinition, KernelEvent } from '../kernels/types.js'
import type { UpstreamTarget } from '../gateway/canonical.js'
import { readJsonFile, writeJsonAtomic } from '../util/fs.js'

export const CHAT_MODEL_ID = 'default'

interface SessionBinding {
  kernelId: string
  nativeSessionId?: string
  /** Number of user turns already delivered to the CLI. */
  deliveredTurns: number
  updatedAt: string
}

export class ChatSessionMap {
  private readonly file: string
  private value: Record<string, SessionBinding>

  constructor(dataDir: string) {
    this.file = join(dataDir, 'chat-sessions.json')
    this.value = readJsonFile<Record<string, SessionBinding>>(this.file) ?? {}
  }

  get(sessionId: string, kernelId: string): SessionBinding | undefined {
    const binding = this.value[sessionId]
    return binding?.kernelId === kernelId ? binding : undefined
  }

  set(sessionId: string, binding: SessionBinding): void {
    this.value[sessionId] = binding
    const entries = Object.entries(this.value).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, 2000)
    this.value = Object.fromEntries(entries)
    writeJsonAtomic(this.file, this.value)
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as { type?: string; text?: string }
      return b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : b.type === 'file' ? '[file]' : ''
    })
    .join('')
}

interface Turn {
  role: 'user' | 'assistant'
  text: string
}

interface SourceLike {
  kind?: unknown
  form?: unknown
}

/**
 * Context forms that only describe state or reference material (a clock, a
 * catalog, workspace instructions, recalled history). They are never a message
 * addressed to the agent, so the CLI does not receive them as turns.
 */
const CONTEXT_ONLY_FORMS = new Set(['snapshot', 'catalog', 'instructions', 'recall'])

/**
 * Whether a user-role message is something the agent should answer, as opposed
 * to context a plugin or the runtime injected.
 *
 * - no source (a hand-built input) or `kind: 'user'`: typed by the user;
 * - `form: 'relay'`: a message another agent addressed to this one (for
 *   example a ds-bot group turn, a request or reply between Bots, a handoff or a
 *   team kickoff), whatever its producer `kind`;
 * - `kind: 'schedule'`: a scheduled task firing.
 *
 * Context-only forms (`snapshot`, `catalog`, ...) are skipped even when their
 * kind would match. Any other kind is skipped, as before. Unknown future
 * shapes therefore degrade to "skipped", never to a crash.
 */
export function isConversationMessage(source: unknown): boolean {
  if (source === undefined || source === null || typeof source !== 'object') return true
  const { kind, form } = source as SourceLike
  if (typeof form === 'string' && CONTEXT_ONLY_FORMS.has(form)) return false
  if (kind === undefined || kind === 'user' || kind === 'schedule') return true
  return form === 'relay'
}

export function conversationTurns(options: Pick<GenerateOptions, 'messages'>): Turn[] {
  const turns: Turn[] = []
  for (const message of options.messages) {
    const m = message as { role: string; content: unknown; source?: unknown }
    if (m.role === 'user') {
      if (!isConversationMessage(m.source)) continue
      const text = textOf(m.content).trim()
      if (text) turns.push({ role: 'user', text })
    } else if (m.role === 'assistant') {
      const text = textOf(m.content).trim()
      if (text) turns.push({ role: 'assistant', text })
    }
  }
  return turns
}

/** Upper bound for the identity text passed to a CLI as extra system instructions. */
export const MAX_IDENTITY_CHARS = 12_000

const IDENTITY_HEADING = /^# Your identity[ \t]*$/m

/**
 * The agent's identity from the request's system prompt, for the CLI.
 *
 * Only the `# Your identity` section is taken (ds-bot renders a Bot's name,
 * role, instructions and team rules there), up to the next top-level heading
 * and at most {@link MAX_IDENTITY_CHARS}. The rest of DSH's system prompt is
 * not forwarded: it describes DSH's own tools and runtime, which the CLI does
 * not have, and the CLI brings its own system prompt. Returns undefined when
 * the request carries no identity section (an ordinary DSH chat session).
 */
export function identityPrompt(options: Pick<GenerateOptions, 'messages'>, kernelName: string): string | undefined {
  let system = ''
  for (const message of options.messages) {
    const m = message as { role: string; content: unknown }
    if (m.role === 'system') system = textOf(m.content)
  }
  const start = IDENTITY_HEADING.exec(system)
  if (start === null) return undefined
  const rest = system.slice(start.index + start[0].length)
  const next = /^# \S/m.exec(rest)
  let section = `${start[0].trim()}${next === null ? rest : rest.slice(0, next.index)}`.trim()
  if (section.length > MAX_IDENTITY_CHARS) {
    const cut = section.lastIndexOf('\n', MAX_IDENTITY_CHARS)
    section = `${section.slice(0, cut > MAX_IDENTITY_CHARS / 2 ? cut : MAX_IDENTITY_CHARS).trimEnd()}\n…`
  }
  return [
    section,
    '',
    `## Running as ${kernelName}`,
    `You answer through ${kernelName} and have only its own tools. Tools named above that ${kernelName} does not have (such as message_bot, ask_user, show_view, list_bots, update_bot, post_to_group, request_secret, read_own_chat or read_group_chat) are not available: do not call them and do not write them out as text. In a group chat, call on another member by writing @Name with their exact name. Your final text in a turn is your message.`,
  ].join('\n')
}

/** Build the prompt for this turn: the new message(s), plus earlier context when the CLI cannot resume. */
export function buildTurnPrompt(turns: Turn[], binding: SessionBinding | undefined, kernel: KernelDefinition, maxContextChars = 24_000): { prompt: string; resume?: string; userTurns: number } {
  const userTurns = turns.filter(t => t.role === 'user').length
  const last = [...turns].reverse().find(t => t.role === 'user')
  if (last === undefined) return { prompt: '', userTurns }
  if (kernel.supportsResume && binding?.nativeSessionId !== undefined && binding.deliveredTurns >= 1 && binding.deliveredTurns < userTurns) {
    // Everything after the last delivered user turn. Several user turns arrive at
    // once when messages queued while the CLI was busy (a steered or deferred
    // message); they go together, as long as no reply the CLI never wrote sits
    // between them.
    let seen = 0
    const pending = turns.filter(t => (t.role === 'user' ? ++seen > binding.deliveredTurns : seen > binding.deliveredTurns))
    if (pending.every(t => t.role === 'user')) {
      return { prompt: pending.map(t => t.text).join('\n\n'), resume: binding.nativeSessionId, userTurns }
    }
  }
  const earlier = turns.slice(0, turns.lastIndexOf(last))
  if (earlier.length === 0) return { prompt: last.text, userTurns }
  let context = ''
  for (const turn of [...earlier].reverse()) {
    const line = `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}\n\n`
    if (context.length + line.length > maxContextChars) break
    context = line + context
  }
  return {
    prompt: `Earlier conversation in this DSH session (for context):\n\n${context.trim()}\n\n---\n\nCurrent request:\n${last.text}`,
    userTurns,
  }
}

/**
 * Show tool-step paths relative to the session workspace: `/home/me/repo/src/a.ts`
 * becomes `src/a.ts` and the workspace itself becomes `.`, so chat transcripts
 * neither leak nor drown in absolute paths.
 */
export function workspaceRelative(detail: string, cwd: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  if (!root) return detail
  let out = ''
  let rest = detail
  for (;;) {
    const at = rest.indexOf(root)
    if (at < 0) return out + rest
    const after = rest.charAt(at + root.length)
    const before = at > 0 ? rest.charAt(at - 1) : ''
    const boundary = before === '' || /[\s"'`(=:,]/.test(before)
    if (boundary && (after === '/' || after === '\\')) {
      const next = rest.charAt(at + root.length + 1)
      out += rest.slice(0, at) + (next === '' || /[\s"'`),:]/.test(next) ? '.' : '')
      rest = rest.slice(at + root.length + 1)
    } else if (boundary && (after === '' || /[\s"'`),:]/.test(after))) {
      out += rest.slice(0, at) + '.'
      rest = rest.slice(at + root.length)
    } else {
      out += rest.slice(0, at + root.length)
      rest = rest.slice(at + root.length)
    }
  }
}

export interface KernelChatDeps {
  kernels: KernelService
  sessions: ChatSessionMap
  target: () => UpstreamTarget
  cwdFor: (sessionId: string | undefined) => string
  timeoutMs: number
  /** Route auxiliary calls (session titles, compaction) to the real upstream model instead of a CLI. */
  auxiliary(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export async function* kernelChatStream(kernel: KernelDefinition, options: GenerateOptions, deps: KernelChatDeps): AsyncIterable<StreamChunk> {
  const sessionId = options.sessionId as string | undefined
  const settings = deps.kernels.settingsOf(kernel.id)
  const turns = conversationTurns(options)
  const binding = sessionId !== undefined ? deps.sessions.get(sessionId, kernel.id) : undefined
  const { prompt, resume, userTurns } = buildTurnPrompt(turns, binding, kernel)
  const identity = identityPrompt(options, kernel.name)
  let index = 0
  let open: 'text' | 'reasoning' | undefined
  let textBuffer = ''
  let reasoningBuffer = ''
  const queue: StreamChunk[] = []
  let wake: (() => void) | undefined
  const push = (chunk: StreamChunk): void => {
    queue.push(chunk)
    wake?.()
  }
  const close = (): void => {
    if (open === 'text') push({ type: 'block-end', index, block: { type: 'text', text: textBuffer } } as StreamChunk)
    if (open === 'reasoning') push({ type: 'block-end', index, block: { type: 'reasoning', text: reasoningBuffer } } as StreamChunk)
    if (open !== undefined) index += 1
    open = undefined
  }
  const write = (kind: 'text' | 'reasoning', text: string): void => {
    if (!text) return
    if (open !== kind) {
      close()
      open = kind
      if (kind === 'text') textBuffer = ''
      else reasoningBuffer = ''
      push({ type: 'block-start', index, blockType: kind } as StreamChunk)
    }
    if (kind === 'text') {
      textBuffer += text
      push({ type: 'text-delta', index, text } as StreamChunk)
    } else {
      reasoningBuffer += text
      push({ type: 'reasoning-delta', index, text } as StreamChunk)
    }
  }

  if (!prompt) {
    write('text', 'There is no user message to send.')
    close()
    yield* queue
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    return
  }
  if (!settings.enabled) {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: `${kernel.name} is disabled in DSH-LULUX Flow settings`, code: 'KERNEL_DISABLED' } } } as StreamChunk
    return
  }

  let target: UpstreamTarget
  try {
    target = deps.target()
  } catch (error: unknown) {
    // e.g. the DSH default is a CLI route and no real model is known: report it in the chat, do not throw.
    yield { type: 'finish', reason: { kind: 'error', failure: { message: error instanceof Error ? error.message : String(error), code: 'GATEWAY_MODEL_UNSET' } } } as StreamChunk
    return
  }

  let finalSeen = false
  let emitted = false
  const cwd = deps.cwdFor(sessionId)
  type RunResult = Awaited<ReturnType<KernelService['run']>>
  async function* attempt(turnPrompt: string, turnResume: string | undefined): AsyncGenerator<StreamChunk, { result: RunResult | undefined; failure: unknown }> {
    const runPromise = deps.kernels
      .run({
        kernel,
        prompt: turnPrompt,
        cwd,
        mode: settings.mode,
        permission: settings.permission,
        target,
        runId: `chat.${sessionId ?? 'anon'}.${Date.now().toString(36)}`,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(turnResume !== undefined ? { resumeSessionId: turnResume } : {}),
        timeoutMs: deps.timeoutMs,
        ...(identity !== undefined ? { appendSystemPrompt: identity } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        onQueued: (status: KernelQueueStatus) => write('reasoning', `${queuedLine(kernel.name, status)}\n`),
        onEvent: (event: KernelEvent) => {
          if (event.type === 'text') {
            if (event.final === true && textBuffer) write('text', '\n\n')
            write('text', event.text)
            finalSeen = true
            emitted = true
          } else if (event.type === 'reasoning') write('reasoning', event.text)
          else if (event.type === 'tool') write('reasoning', `▸ ${event.name}${event.detail ? ` · ${workspaceRelative(event.detail, cwd)}` : ''}\n`)
          else if (event.type === 'error' && !event.fatal) write('reasoning', `! ${event.message}\n`)
        },
      })

    // Settle state and wake the consumer in ONE callback: waking from a separate
    // `.finally()` raced the `.then()` that stores the result and could leave the
    // loop parked forever with the run already finished (seen live in DSH).
    let result: RunResult | undefined
    let failure: unknown
    let settled = false
    void runPromise.then(
      r => {
        result = r
        settled = true
        wake?.()
      },
      (error: unknown) => {
        failure = error
        settled = true
        wake?.()
      },
    )
    for (;;) {
      while (queue.length > 0) yield queue.shift()!
      if (settled) break
      await new Promise<void>(resolve => {
        wake = resolve
        if (queue.length > 0 || settled) resolve()
      })
      wake = undefined
    }

    return { result, failure }
  }

  let outcome = yield* attempt(prompt, resume)
  // A native session that can no longer be resumed (deleted, made in another
  // folder, or left broken by an interrupted turn) fails before any answer.
  // Retry once as a fresh session with the earlier turns replayed as context.
  if (resume !== undefined && !emitted && (outcome.result === undefined || outcome.result.status === 'error')) {
    const fresh = buildTurnPrompt(turns, undefined, kernel)
    write('reasoning', `! ${kernel.name} could not resume the previous session; continuing in a new one with the conversation as context.\n`)
    close()
    outcome = yield* attempt(fresh.prompt, undefined)
  }
  const { result, failure } = outcome
  if (result === undefined) {
    const message = failure instanceof Error ? failure.message : String(failure)
    yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'KERNEL_FAILED' } } } as StreamChunk
    return
  }
  if (!finalSeen && result.text) write('text', result.text)
  close()
  while (queue.length > 0) yield queue.shift()!

  if (sessionId !== undefined && result.status === 'completed') {
    deps.sessions.set(sessionId, {
      kernelId: kernel.id,
      ...(result.nativeSessionId !== undefined ? { nativeSessionId: result.nativeSessionId } : {}),
      deliveredTurns: userTurns,
      updatedAt: new Date().toISOString(),
    })
  }
  yield {
    type: 'usage',
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      ...(result.usage.cacheReadTokens !== undefined ? { cacheReadTokens: result.usage.cacheReadTokens } : {}),
      ...(result.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}),
    },
  } as StreamChunk
  if (result.status === 'completed') yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  else if (result.status === 'aborted') yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } } as StreamChunk
  else yield { type: 'finish', reason: { kind: 'error', failure: { message: result.diagnostic ?? `${kernel.name} ${result.status}`, code: 'KERNEL_FAILED' } } } as StreamChunk
}
