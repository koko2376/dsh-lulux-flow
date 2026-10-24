/**
 * Registrations that make kernels first-class in DSH:
 * - `LuluxFlowSubagentProvider`: one `ctx.subagents` provider per kernel
 *   (`lulux-flow-claude-code`, ...), so DSH's own subagent tool and workflows can
 *   delegate to the CLI. Distinct names from the official
 *   `claude-code` / `codex` providers, so both can be installed.
 * - `LuluxFlowKernelAdapter`: one LLM provider route per kernel, so the CLI can
 *   be chosen as the main agent of a chat session in DSH's model picker.
 */
import { randomUUID } from 'node:crypto'
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { BRAND } from '../brand.js'
import type { UpstreamTarget } from '../gateway/canonical.js'
import type { KernelService } from '../kernels/service.js'
import type { KernelDefinition } from '../kernels/types.js'
import { CHAT_MODEL_ID, kernelChatStream, type KernelChatDeps } from './kernel-chat.js'

const TEXT_ONLY: NonNullable<LlmModelInfo['inputModalities']> = ['text']

/**
 * Whether a request is a one-shot model call rather than a turn of the agent
 * loop. By the dsh-llm contract (GenerateOptions): `purpose` marks auxiliary
 * calls (compaction, session titles); `system` is set only by hand-built
 * one-shot callers, loop-built requests carry the system prompt as a leading
 * system message and leave it undefined; and a loop-built request holds
 * durable Session messages, each with an `id` and a `source`, while a
 * hand-built one may hold only request inputs, which have neither.
 *
 * A hand-built request can also put one request input after a copy of a
 * Session's durable messages: a side question asked on a snapshot of the
 * conversation (DS Bot's `/btw` aside, from ds-bot 0.2.1). Nothing of it is
 * written into the Session, so it must not reach the CLI either: a resumed
 * CLI session would keep the question in its own history, and the Session's
 * delivered-turn count would run ahead of the Session, which costs the next
 * real turn its resume.
 */
export function isOneShotRequest(options: Pick<GenerateOptions, 'purpose' | 'system' | 'messages'>): boolean {
  if (options.purpose !== undefined || options.system !== undefined) return true
  const messages = options.messages as ReadonlyArray<{ role?: unknown; id?: unknown; source?: unknown }>
  if (messages.length === 0) return false
  const isInput = (message: { id?: unknown; source?: unknown }): boolean => message.id === undefined && message.source === undefined
  if (messages.every(isInput)) return true
  return isSnapshotQuestion(messages)
}

/**
 * A question on a snapshot of a Session: durable Session messages, then a
 * trailing user-role request input (no `id`, no `source`). The agent loop never
 * builds this shape: every message it sends is a durable Session message.
 */
export function isSnapshotQuestion(messages: ReadonlyArray<{ role?: unknown; id?: unknown; source?: unknown }>): boolean {
  const last = messages.at(-1)
  if (last === undefined || last.role !== 'user' || last.id !== undefined || last.source !== undefined) return false
  return messages.some(message => message.id !== undefined)
}

export const providerName = (kernelId: string): string => `${BRAND.providerPrefix}-${kernelId}`
export const chatRoute = (kernelId: string): string => `${BRAND.providerPrefix}-${kernelId}`

/** Structural copies of the subagent seam types (see @deepseek-ai/dsh-subagent). */
interface SubagentStartRequest {
  readonly cwd: string
  readonly prompt: ReadonlyArray<{ type: string; text?: string }>
  readonly signal: AbortSignal
  readonly parent?: { session?: { id?: string } }
}

interface SubagentResult {
  readonly output: ReadonlyArray<{ type: 'text'; text: string }>
  readonly diagnostic?: string
  readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
}

export class LuluxFlowSubagentProvider {
  readonly capabilities = { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }
  readonly inheritsParentContext = false
  readonly name: string

  constructor(
    private readonly kernel: KernelDefinition,
    private readonly deps: { kernels: KernelService; target: () => UpstreamTarget; timeoutMs: number; logger: { warn(m: string): void } },
  ) {
    this.name = providerName(kernel.id)
  }

  start(request: SubagentStartRequest): Promise<{ id: string; result: Promise<SubagentResult>; dispose(): Promise<void> }> {
    const prompt = request.prompt.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()
    if (!prompt) return Promise.reject(new Error(`${this.name}: the task must contain text`))
    if (request.signal.aborted) return Promise.reject(new Error(`${this.name}: aborted before start`))
    const settings = this.deps.kernels.settingsOf(this.kernel.id)
    if (!settings.enabled) return Promise.reject(new Error(`${this.kernel.name} is disabled in DSH-LULUX Flow settings`))
    const controller = new AbortController()
    const forward = (): void => controller.abort()
    request.signal.addEventListener('abort', forward, { once: true })
    const id = `${this.name}-${randomUUID()}`
    const result = this.deps.kernels
      .run({
        kernel: this.kernel,
        prompt,
        cwd: request.cwd,
        mode: settings.mode,
        // Subagents run unattended: "ask" has nobody to ask, so it maps to read-only.
        permission: settings.permission === 'ask' ? 'read-only' : settings.permission,
        target: this.deps.target(),
        runId: id,
        timeoutMs: this.deps.timeoutMs,
        signal: controller.signal,
      })
      .then((run): SubagentResult => {
        if (run.status !== 'completed') this.deps.logger.warn(`${this.name}: ${run.status}: ${run.diagnostic ?? ''}`)
        return {
          output: run.text ? [{ type: 'text', text: run.text }] : [],
          stopReason: run.status === 'completed' ? 'completed' : run.status === 'aborted' ? 'aborted' : 'error',
          ...(run.status !== 'completed' ? { diagnostic: run.diagnostic ?? run.status } : {}),
        }
      })
      .finally(() => request.signal.removeEventListener('abort', forward))
    return Promise.resolve({
      id,
      result,
      dispose: async () => {
        controller.abort()
        await result.catch(() => undefined)
      },
    })
  }
}

export class LuluxFlowKernelAdapter extends LlmAdapter {
  constructor(
    private readonly kernelFor: (provider: string) => KernelDefinition | undefined,
    private readonly deps: KernelChatDeps,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const kernel = this.kernelFor(provider)
    return { id: provider, name: kernel !== undefined ? `${kernel.name} · ${BRAND.displayName}` : provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const kernel = this.kernelFor(provider)
    if (kernel === undefined) return Promise.resolve([])
    return Promise.resolve([
      {
        provider,
        id: CHAT_MODEL_ID,
        name: kernel.name,
        description: `${kernel.vendor} ${kernel.name} CLI as the session agent, running on your DSH model through the ${BRAND.displayName} gateway. Uses its own tools, not DSH tools.`,
        // The CLI receives text only; declaring it lets callers (e.g. ds-bot) turn images into text first.
        inputModalities: TEXT_ONLY,
      },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const kernel = this.kernelFor(provider)
    return Promise.resolve({ provider, id: model, name: kernel?.name ?? model, context: { contextWindow: 200_000 }, inputModalities: TEXT_ONLY })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const kernel = this.kernelFor(options.provider)
    if (kernel === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `unknown kernel route ${options.provider}`, code: 'KERNEL_UNKNOWN' } } } as StreamChunk
      return
    }
    // One-shot calls (titles, compaction, a plugin's summary, a side question on a
    // snapshot of the chat) must not spawn a CLI or touch the session's native resume
    // state: answer them through the upstream model.
    if (isOneShotRequest(options)) {
      yield* this.deps.auxiliary(options)
      return
    }
    yield* kernelChatStream(kernel, options, this.deps)
  }
}
