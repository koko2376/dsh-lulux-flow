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
        description: `${kernel.vendor} ${kernel.name} CLI as the session agent, running on your DSH model through the ${BRAND.displayName} gateway.`,
      },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const kernel = this.kernelFor(provider)
    return Promise.resolve({ provider, id: model, name: kernel?.name ?? model, context: { contextWindow: 200_000 } })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const kernel = this.kernelFor(options.provider)
    if (kernel === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `unknown kernel route ${options.provider}`, code: 'KERNEL_UNKNOWN' } } } as StreamChunk
      return
    }
    // Auxiliary calls (titles, compaction) must not spawn a CLI: answer them through the upstream model.
    if (options.purpose !== undefined) {
      yield* this.deps.auxiliary(options)
      return
    }
    yield* kernelChatStream(kernel, options, this.deps)
  }
}
