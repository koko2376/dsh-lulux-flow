/**
 * Upstream implementation backed by DSH's own model runtime (`ctx.llm`).
 * The gateway never sees an API key: DSH's registered adapter for the
 * selected provider does the actual provider call.
 */
import { createAssistantMessage, createToolResultMessage, type GenerateOptions, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CanonicalEvent, CanonicalRequest, FinishKind, Upstream, UpstreamTarget } from '../gateway/canonical.js'

/** The part of `ctx.llm` this module uses. */
export interface LlmStreamer {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

type Brand<T> = T & { readonly __brand?: never }

export function toGenerateOptions(request: CanonicalRequest, target: UpstreamTarget, signal: AbortSignal): GenerateOptions {
  const messages: RequestMessage[] = []
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      let text = turn.text
      if (turn.images !== undefined && turn.images.length > 0) {
        text = `${text}${text ? '\n' : ''}[${turn.images.length} image(s) omitted: DSH-LULUX Flow forwards text only to the DSH model runtime]`
      }
      messages.push({ role: 'user', content: [{ type: 'text', text: text || ' ' }] })
    } else if (turn.role === 'assistant') {
      const content: Array<{ type: 'text'; text: string } | { type: 'tool-call'; id: string; name: string; arguments: string }> = []
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

/** Translate DSH stream chunks into canonical gateway events. */
export async function* fromDshChunks(chunks: AsyncIterable<StreamChunk>): AsyncIterable<CanonicalEvent> {
  const tools = new Map<number, { id: string; name: string; args: string; started: boolean }>()
  let finished = false
  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        if (chunk.text) yield { type: 'text', text: chunk.text }
        break
      case 'reasoning-delta':
        if (chunk.text) yield { type: 'reasoning', text: chunk.text }
        break
      case 'block-start':
        if (chunk.blockType === 'tool-call') tools.set(chunk.index, { id: '', name: '', args: '', started: false })
        break
      case 'tool-call-delta': {
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
        const block = chunk.block
        if (block.type === 'tool-call') {
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
    return fromDshChunks(this.llm().stream(toGenerateOptions(request, target, signal)))
  }
}

async function* refuse(message: string): AsyncIterable<CanonicalEvent> {
  yield { type: 'finish', reason: 'error', error: message }
}
