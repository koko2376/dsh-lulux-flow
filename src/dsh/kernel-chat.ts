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

export function conversationTurns(options: Pick<GenerateOptions, 'messages'>): Turn[] {
  const turns: Turn[] = []
  for (const message of options.messages) {
    const m = message as { role: string; content: unknown; source?: { kind?: string } }
    if (m.role === 'user') {
      // Skip runtime/context injections; keep what the user typed.
      if (m.source !== undefined && m.source.kind !== undefined && m.source.kind !== 'user') continue
      const text = textOf(m.content).trim()
      if (text) turns.push({ role: 'user', text })
    } else if (m.role === 'assistant') {
      const text = textOf(m.content).trim()
      if (text) turns.push({ role: 'assistant', text })
    }
  }
  return turns
}

/** Build the prompt for this turn: the new message, plus earlier context when the CLI cannot resume. */
export function buildTurnPrompt(turns: Turn[], binding: SessionBinding | undefined, kernel: KernelDefinition, maxContextChars = 24_000): { prompt: string; resume?: string; userTurns: number } {
  const userTurns = turns.filter(t => t.role === 'user').length
  const last = [...turns].reverse().find(t => t.role === 'user')
  if (last === undefined) return { prompt: '', userTurns }
  if (kernel.supportsResume && binding?.nativeSessionId !== undefined && binding.deliveredTurns === userTurns - 1) {
    return { prompt: last.text, resume: binding.nativeSessionId, userTurns }
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
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
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
  yield { type: 'usage', usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } } as StreamChunk
  if (result.status === 'completed') yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  else if (result.status === 'aborted') yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } } as StreamChunk
  else yield { type: 'finish', reason: { kind: 'error', failure: { message: result.diagnostic ?? `${kernel.name} ${result.status}`, code: 'KERNEL_FAILED' } } } as StreamChunk
}
