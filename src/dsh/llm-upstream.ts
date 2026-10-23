/**
 * Upstream implementation backed by DSH's own model runtime (`ctx.llm`).
 * The gateway never sees an API key: DSH's registered adapter for the
 * selected provider does the actual provider call.
 */
import { createHash } from 'node:crypto'
import { createAssistantMessage, createToolResultMessage, type ContentBlock, type GenerateOptions, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CanonicalEvent, CanonicalRequest, CanonicalTurn, FinishKind, Upstream, UpstreamTarget } from '../gateway/canonical.js'

type AssistantTurn = Extract<CanonicalTurn, { role: 'assistant' }>
type AssistantBlock = { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'tool-call'; id: string; name: string; arguments: string }

/** One finished model response as DSH assembled it, with the adapter's replay metadata. */
export interface RecordedResponse {
  provider: string
  model: string
  blocks: AssistantBlock[]
  replayState: unknown
}

/**
 * Identity of an assistant turn independent of how a client re-splits or
 * re-spaces it: reasoning, text and tool calls with whitespace removed.
 */
export function turnFingerprint(parts: { reasoning: string; text: string; calls: Array<{ id: string; name: string }> }): string {
  const squash = (value: string): string => value.replace(/\s+/g, '')
  return createHash('sha256')
    .update(squash(parts.reasoning))
    .update('\u0000')
    .update(squash(parts.text))
    .update('\u0000')
    .update(parts.calls.map(call => `${call.id}:${call.name}`).join(','))
    .digest('hex')
}

function blocksFingerprint(blocks: readonly AssistantBlock[]): string {
  return turnFingerprint({
    reasoning: blocks.map(b => (b.type === 'reasoning' ? b.text : '')).join(''),
    text: blocks.map(b => (b.type === 'text' ? b.text : '')).join(''),
    calls: blocks.flatMap(b => (b.type === 'tool-call' ? [{ id: b.id, name: b.name }] : [])),
  })
}

/**
 * Remembers recent responses so that when a client sends one back as history
 * it is replayed to DSH exactly as DSH produced it: same blocks, plus the
 * adapter's replay state (native thinking signatures). Without it a
 * thinking-mode model gets its earlier turns back stripped of their
 * reasoning. Bounded, in memory; a miss falls back to the client's copy.
 */
export class ReplayCache {
  private readonly entries = new Map<string, RecordedResponse>()
  constructor(private readonly max = 512) {}

  remember(response: RecordedResponse): void {
    if (response.blocks.length === 0) return
    const key = blocksFingerprint(response.blocks)
    this.entries.delete(key)
    this.entries.set(key, response)
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string)
  }

  find(turn: AssistantTurn, target: UpstreamTarget): RecordedResponse | undefined {
    const key = turnFingerprint({ reasoning: turn.reasoning ?? '', text: turn.text, calls: turn.toolCalls ?? [] })
    const hit = this.entries.get(key)
    return hit !== undefined && hit.provider === target.provider && hit.model === target.model ? hit : undefined
  }

  get size(): number {
    return this.entries.size
  }
}

/** The part of `ctx.llm` this module uses. */
export interface LlmStreamer {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

type Brand<T> = T & { readonly __brand?: never }

export function toGenerateOptions(request: CanonicalRequest, target: UpstreamTarget, signal: AbortSignal, replay?: ReplayCache): GenerateOptions {
  const messages: RequestMessage[] = []
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      let text = turn.text
      if (turn.images !== undefined && turn.images.length > 0) {
        text = `${text}${text ? '\n' : ''}[${turn.images.length} image(s) omitted: DSH-LULUX Flow forwards text only to the DSH model runtime]`
      }
      messages.push({ role: 'user', content: [{ type: 'text', text: text || ' ' }] })
    } else if (turn.role === 'assistant') {
      const recorded = replay?.find(turn, target)
      if (recorded !== undefined) {
        messages.push(
          createAssistantMessage({
            content: recorded.blocks as never,
            source: { provider: recorded.provider, model: recorded.model, ...(recorded.replayState !== undefined ? { replayState: recorded.replayState } : {}) },
          }),
        )
        continue
      }
      const content: AssistantBlock[] = []
      // Reasoning first, as the model produced it; adapters for thinking-mode models replay it.
      if (turn.reasoning) content.push({ type: 'reasoning', text: turn.reasoning })
      if (turn.text) content.push({ type: 'text', text: turn.text })
      for (const call of turn.toolCalls ?? []) content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments || '{}' })
      if (content.length === 0) content.push({ type: 'text', text: '' })
      messages.push(createAssistantMessage({ content: content as never, source: { provider: target.provider, model: target.model } }))
    } else {
      messages.push(createToolResultMessage({ callId: turn.toolCallId as Brand<string> as never, content: [{ type: 'text', text: turn.text || ' ' }], isError: turn.isError === true }))
    }
  }
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    signal,
    ...(request.system ? { system: request.system } : {}),
    ...(request.tools.length > 0 ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.stop !== undefined ? { stop: request.stop } : {}),
    ...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort as never } : {}),
  }
  return options
}

/**
 * Translate DSH stream chunks into canonical gateway events.
 * @param onResponse - receives the assembled blocks and replay state of a successful response.
 */
export async function* fromDshChunks(chunks: AsyncIterable<StreamChunk>, onResponse?: (blocks: AssistantBlock[], replayState: unknown) => void): AsyncIterable<CanonicalEvent> {
  const tools = new Map<number, { id: string; name: string; args: string; started: boolean }>()
  /** Text already streamed per block index, so a block-end carrying more is not lost. */
  const streamed = new Map<number, string>()
  /** Assembled blocks by index, kept in first-seen order (the order adapters key replay metadata by). */
  const blocks = new Map<number, AssistantBlock | undefined>()
  const seen = (index: number): void => {
    if (!blocks.has(index)) blocks.set(index, undefined)
  }
  let finished = false
  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        seen(chunk.index)
        if (chunk.text) {
          streamed.set(chunk.index, (streamed.get(chunk.index) ?? '') + chunk.text)
          yield { type: 'text', text: chunk.text }
        }
        break
      case 'reasoning-delta':
        seen(chunk.index)
        if (chunk.text) {
          streamed.set(chunk.index, (streamed.get(chunk.index) ?? '') + chunk.text)
          yield { type: 'reasoning', text: chunk.text }
        }
        break
      case 'block-start':
        seen(chunk.index)
        if (chunk.blockType === 'tool-call') tools.set(chunk.index, { id: '', name: '', args: '', started: false })
        break
      case 'tool-call-delta': {
        seen(chunk.index)
        const tool = tools.get(chunk.index) ?? { id: '', name: '', args: '', started: false }
        tools.set(chunk.index, tool)
        if (chunk.id) tool.id = chunk.id
        if (chunk.name) tool.name = chunk.name
        if (!tool.started && tool.id && tool.name) {
          tool.started = true
          yield { type: 'tool-call-start', id: tool.id, name: tool.name }
        }
        if (chunk.argumentsDelta) {
          tool.args += chunk.argumentsDelta
          if (tool.started) yield { type: 'tool-call-delta', id: tool.id, argumentsDelta: chunk.argumentsDelta }
        }
        break
      }
      case 'block-end': {
        const block = chunk.block as ContentBlock
        if (block.type === 'text' || block.type === 'reasoning') {
          // Adapters that deliver a block whole (no deltas, or fewer than the block) still reach the client.
          const sent = streamed.get(chunk.index) ?? ''
          if (block.text.length > sent.length && block.text.startsWith(sent)) {
            const rest = block.text.slice(sent.length)
            yield block.type === 'text' ? { type: 'text', text: rest } : { type: 'reasoning', text: rest }
          }
          streamed.delete(chunk.index)
          seen(chunk.index)
          blocks.set(chunk.index, { type: block.type, text: block.text })
        }
        if (block.type === 'tool-call') {
          seen(chunk.index)
          blocks.set(chunk.index, { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments })
          const tool = tools.get(chunk.index)
          tools.delete(chunk.index)
          if (tool === undefined || !tool.started) yield { type: 'tool-call-start', id: block.id, name: block.name }
          yield { type: 'tool-call-end', id: block.id, name: block.name, arguments: block.arguments }
        }
        break
      }
      case 'usage':
        yield {
          type: 'usage',
          usage: {
            inputTokens: chunk.usage.inputTokens,
            outputTokens: chunk.usage.outputTokens,
            ...(chunk.usage.cacheReadTokens !== undefined ? { cacheReadTokens: chunk.usage.cacheReadTokens } : {}),
            ...(chunk.usage.reasoningTokens !== undefined ? { reasoningTokens: chunk.usage.reasoningTokens } : {}),
          },
        }
        break
      case 'finish': {
        finished = true
        const kind = chunk.reason.kind
        if (kind !== 'error' && kind !== 'aborted' && onResponse !== undefined) {
          const assembled = [...blocks.values()]
          // A block that never ended cannot be replayed faithfully; record nothing then.
          if (assembled.every(b => b !== undefined)) onResponse(assembled as AssistantBlock[], chunk.replayState)
        }
        const reason: FinishKind = kind === 'tool-calls' ? 'tool_use' : kind === 'max-tokens' ? 'max_tokens' : kind === 'error' ? 'error' : kind === 'aborted' ? 'aborted' : 'stop'
        const failure = 'failure' in chunk.reason ? chunk.reason.failure : undefined
        yield failure !== undefined ? { type: 'finish', reason, error: failure.message } : { type: 'finish', reason }
        return
      }
      default:
        break
    }
  }
  if (!finished) yield { type: 'finish', reason: 'stop' }
}

export class DshLlmUpstream implements Upstream {
  readonly replay = new ReplayCache()
  /**
   * @param llm - DSH's model runtime.
   * @param isKernelRoute - loop guard: targets on LULUX Flow's own CLI routes are refused, never streamed.
   */
  constructor(
    private readonly llm: () => LlmStreamer,
    private readonly isKernelRoute: (provider: string) => boolean = () => false,
  ) {}

  stream(request: CanonicalRequest, target: UpstreamTarget, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    if (this.isKernelRoute(target.provider)) return refuse(`refusing to route gateway traffic to the CLI route ${target.provider} (loop guard)`)
    return fromDshChunks(this.llm().stream(toGenerateOptions(request, target, signal, this.replay)), (blocks, replayState) =>
      this.replay.remember({ provider: target.provider, model: target.model, blocks, replayState }),
    )
  }
}

async function* refuse(message: string): AsyncIterable<CanonicalEvent> {
  yield { type: 'finish', reason: 'error', error: message }
}
