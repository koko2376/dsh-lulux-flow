/**
 * OpenAI Chat Completions ⇄ canonical model. Used by Qwen Code and any
 * OpenAI-compatible CLI (`OPENAI_BASE_URL`).
 */
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  extractImages,
  flattenContent,
  normalizeSchema,
  randomId,
  type CanonicalEvent,
  type CanonicalRequest,
  type CanonicalTool,
  type CanonicalToolCall,
  type CanonicalTurn,
  type CollectedResponse,
  type FinishKind,
} from './canonical.js'

export function chatToCanonical(body: unknown): CanonicalRequest {
  const input = asRecord(body)
  const systemParts: string[] = []
  const turns: CanonicalTurn[] = []
  for (const raw of asArray(input.messages)) {
    const message = asRecord(raw)
    const role = asString(message.role)
    if (role === 'system' || role === 'developer') {
      systemParts.push(flattenContent(message.content))
      continue
    }
    if (role === 'assistant') {
      const calls: CanonicalToolCall[] = []
      for (const rawCall of asArray(message.tool_calls)) {
        const call = asRecord(rawCall)
        const fn = asRecord(call.function)
        calls.push({ id: asString(call.id) || randomId('call_'), name: asString(fn.name), arguments: asString(fn.arguments) || '{}' })
      }
      turns.push({ role: 'assistant', text: flattenContent(message.content), ...(calls.length > 0 ? { toolCalls: calls } : {}) })
      continue
    }
    if (role === 'tool') {
      turns.push({ role: 'tool', toolCallId: asString(message.tool_call_id), text: flattenContent(message.content) })
      continue
    }
    const images = extractImages(message.content)
    const text = flattenContent(message.content)
    turns.push(images.length > 0 ? { role: 'user', text, images } : { role: 'user', text })
  }

  const tools: CanonicalTool[] = []
  for (const raw of asArray(input.tools)) {
    const tool = asRecord(raw)
    if (tool.type !== undefined && tool.type !== 'function') continue
    const fn = asRecord(tool.function)
    const name = asString(fn.name)
    if (!name) continue
    tools.push({ name, description: asString(fn.description), parameters: normalizeSchema(fn.parameters) })
  }
  const maxTokens = asNumber(input.max_completion_tokens) ?? asNumber(input.max_tokens)
  const temperature = asNumber(input.temperature)
  const stop = typeof input.stop === 'string' ? [input.stop] : asArray(input.stop).filter((s): s is string => typeof s === 'string')
  return {
    model: asString(input.model),
    system: systemParts.join('\n\n'),
    turns,
    tools,
    stream: input.stream === true,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(stop.length > 0 ? { stop } : {}),
  }
}

function finishReason(finish: FinishKind, sawTools: boolean): string {
  if (finish === 'max_tokens') return 'length'
  if (sawTools || finish === 'tool_use') return 'tool_calls'
  return 'stop'
}

/** Canonical events → `chat.completion.chunk` SSE frames (`data: ...`), tool arguments streamed incrementally. */
export class ChatStreamEncoder {
  readonly id = randomId('chatcmpl-')
  private readonly created = Math.floor(Date.now() / 1000)
  private toolIndex = new Map<string, number>()
  private sentRole = false
  private usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined

  constructor(
    private readonly model: string,
    private readonly includeUsage: boolean,
  ) {}

  private chunk(delta: Record<string, unknown>, finish: string | null = null): string {
    if (!this.sentRole) {
      delta = { role: 'assistant', ...delta }
      this.sentRole = true
    }
    return `data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  }

  push(event: CanonicalEvent): string {
    switch (event.type) {
      case 'text':
        return event.text ? this.chunk({ content: event.text }) : ''
      case 'reasoning':
        return event.text ? this.chunk({ reasoning_content: event.text }) : ''
      case 'tool-call-start': {
        const index = this.toolIndex.size
        this.toolIndex.set(event.id, index)
        return this.chunk({ tool_calls: [{ index, id: event.id, type: 'function', function: { name: event.name, arguments: '' } }] })
      }
      case 'tool-call-delta': {
        const index = this.toolIndex.get(event.id)
        if (index === undefined || !event.argumentsDelta) return ''
        return this.chunk({ tool_calls: [{ index, function: { arguments: event.argumentsDelta } }] })
      }
      case 'usage':
        this.usage = {
          prompt_tokens: event.usage.inputTokens,
          completion_tokens: event.usage.outputTokens,
          total_tokens: event.usage.inputTokens + event.usage.outputTokens,
        }
        return ''
      case 'finish':
        if (event.reason === 'error' || event.reason === 'aborted') return this.error(event.error ?? event.reason)
        return this.finish(event.reason)
      default:
        return ''
    }
  }

  finish(reason: FinishKind = 'stop'): string {
    let out = this.chunk({}, finishReason(reason, this.toolIndex.size > 0))
    if (this.includeUsage && this.usage) {
      out += `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: this.usage })}\n\n`
    }
    return out + 'data: [DONE]\n\n'
  }

  error(message: string): string {
    return `data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\ndata: [DONE]\n\n`
  }
}

export function chatCompletionFrom(model: string, estimatedInputTokens: number, collected: CollectedResponse): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content: collected.text || null }
  if (collected.reasoning) message.reasoning_content = collected.reasoning
  if (collected.toolCalls.length > 0) {
    message.tool_calls = collected.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }))
  }
  const prompt = collected.usage?.inputTokens ?? estimatedInputTokens
  const completion = collected.usage?.outputTokens ?? 0
  return {
    id: randomId('chatcmpl-'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(collected.finish, collected.toolCalls.length > 0) }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  }
}

export function openaiError(status: number, message: string): Record<string, unknown> {
  const type = status === 401 ? 'invalid_api_key' : status === 400 || status === 413 ? 'invalid_request_error' : status === 429 ? 'rate_limit_exceeded' : 'server_error'
  return { error: { message, type, code: type } }
}
