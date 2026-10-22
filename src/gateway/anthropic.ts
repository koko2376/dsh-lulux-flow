/**
 * Anthropic Messages API ⇄ canonical model. Used by Claude Code
 * (`ANTHROPIC_BASE_URL`). Text, tool_use and tool_result blocks are
 * translated; thinking blocks are dropped on input; inline images are kept.
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
  sse,
  type CanonicalEvent,
  type CanonicalImage,
  type CanonicalRequest,
  type CanonicalTool,
  type CanonicalToolCall,
  type CanonicalTurn,
  type CollectedResponse,
  type FinishKind,
} from './canonical.js'

export function anthropicToCanonical(body: unknown): CanonicalRequest {
  const input = asRecord(body)
  const system = typeof input.system === 'string' ? input.system : flattenContent(input.system)
  const turns: CanonicalTurn[] = []

  for (const raw of asArray(input.messages)) {
    const message = asRecord(raw)
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content = message.content
    if (typeof content === 'string') {
      turns.push(role === 'assistant' ? { role, text: content } : { role, text: content })
      continue
    }
    const blocks = asArray(content).map(asRecord)
    if (role === 'assistant') {
      const text: string[] = []
      const calls: CanonicalToolCall[] = []
      for (const block of blocks) {
        if (block.type === 'text') text.push(asString(block.text))
        else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          calls.push({
            id: asString(block.id) || randomId('toolu_'),
            name: asString(block.name),
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
      }
      turns.push({ role: 'assistant', text: text.join(''), ...(calls.length > 0 ? { toolCalls: calls } : {}) })
      continue
    }
    // tool_result blocks become tool turns (they must directly follow the
    // assistant turn); remaining blocks form a user turn afterwards.
    const rest: unknown[] = []
    const toolImages: CanonicalImage[] = []
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        toolImages.push(...extractImages(block.content))
        turns.push({
          role: 'tool',
          toolCallId: asString(block.tool_use_id),
          text: flattenContent(block.content),
          ...(block.is_error === true ? { isError: true } : {}),
        })
      } else {
        rest.push(block)
      }
    }
    const images = [...toolImages, ...extractImages(rest)]
    const text = flattenContent(rest)
    if (text.trim() !== '' || images.length > 0) {
      turns.push(images.length > 0 ? { role: 'user', text, images } : { role: 'user', text })
    }
  }

  const tools: CanonicalTool[] = []
  for (const raw of asArray(input.tools)) {
    const tool = asRecord(raw)
    // Server tools (web_search_20250305, ...) cannot be executed upstream.
    if (tool.type !== undefined && tool.type !== 'custom') continue
    const name = asString(tool.name)
    if (!name) continue
    tools.push({ name, description: asString(tool.description), parameters: normalizeSchema(tool.input_schema) })
  }

  const maxTokens = asNumber(input.max_tokens)
  const temperature = asNumber(input.temperature)
  const stop = asArray(input.stop_sequences).filter((s): s is string => typeof s === 'string')
  return {
    model: asString(input.model),
    system,
    turns,
    tools,
    stream: input.stream === true,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(stop.length > 0 ? { stop } : {}),
  }
}

function stopReason(finish: FinishKind, sawToolUse: boolean): string {
  if (finish === 'max_tokens') return 'max_tokens'
  if (sawToolUse || finish === 'tool_use') return 'tool_use'
  return 'end_turn'
}

/** Incremental encoder: canonical events → Anthropic SSE frames, streaming tool arguments as they arrive. */
export class AnthropicStreamEncoder {
  readonly id = randomId('msg_')
  private index = 0
  private open: { kind: 'text' | 'thinking' | 'tool'; toolId?: string } | null = null
  private sawToolUse = false
  private outputTokens = 0
  private inputTokens: number
  private cacheRead = 0

  constructor(
    private readonly model: string,
    estimatedInputTokens: number,
  ) {
    this.inputTokens = estimatedInputTokens
  }

  start(): string {
    return (
      sse('message_start', {
        type: 'message_start',
        message: {
          id: this.id,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      }) + sse('ping', { type: 'ping' })
    )
  }

  private close(): string {
    if (this.open === null) return ''
    this.open = null
    const frame = sse('content_block_stop', { type: 'content_block_stop', index: this.index })
    this.index += 1
    return frame
  }

  push(event: CanonicalEvent): string {
    switch (event.type) {
      case 'text': {
        if (!event.text) return ''
        let out = ''
        if (this.open?.kind !== 'text') {
          out += this.close()
          out += sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } })
          this.open = { kind: 'text' }
        }
        return out + sse('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: event.text } })
      }
      case 'reasoning': {
        if (!event.text) return ''
        let out = ''
        if (this.open?.kind !== 'thinking') {
          out += this.close()
          out += sse('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'thinking', thinking: '' } })
          this.open = { kind: 'thinking' }
        }
        return out + sse('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'thinking_delta', thinking: event.text } })
      }
      case 'tool-call-start': {
        this.sawToolUse = true
        let out = this.close()
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: this.index,
          content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
        })
        this.open = { kind: 'tool', toolId: event.id }
        return out
      }
      case 'tool-call-delta':
        if (this.open?.kind !== 'tool' || !event.argumentsDelta) return ''
        return sse('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: event.argumentsDelta } })
      case 'tool-call-end':
        return this.open?.kind === 'tool' ? this.close() : ''
      case 'usage':
        this.inputTokens = event.usage.inputTokens
        this.outputTokens = event.usage.outputTokens
        this.cacheRead = event.usage.cacheReadTokens ?? 0
        return ''
      case 'finish':
        if (event.reason === 'error' || event.reason === 'aborted') return this.close() + this.error(event.error ?? event.reason)
        return this.finish(event.reason)
      default:
        return ''
    }
  }

  finish(reason: FinishKind = 'stop'): string {
    return (
      this.close() +
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason(reason, this.sawToolUse), stop_sequence: null },
        usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens, cache_read_input_tokens: this.cacheRead },
      }) +
      sse('message_stop', { type: 'message_stop' })
    )
  }

  error(message: string): string {
    return sse('error', { type: 'error', error: { type: 'api_error', message } })
  }
}

export function anthropicMessageFrom(model: string, estimatedInputTokens: number, collected: CollectedResponse): Record<string, unknown> {
  const content: Record<string, unknown>[] = []
  if (collected.reasoning) content.push({ type: 'thinking', thinking: collected.reasoning, signature: '' })
  if (collected.text) content.push({ type: 'text', text: collected.text })
  for (const call of collected.toolCalls) {
    let input: unknown = {}
    try {
      input = JSON.parse(call.arguments || '{}')
    } catch {
      input = {}
    }
    content.push({ type: 'tool_use', id: call.id, name: call.name, input })
  }
  return {
    id: randomId('msg_'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason(collected.finish, collected.toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: collected.usage?.inputTokens ?? estimatedInputTokens,
      output_tokens: collected.usage?.outputTokens ?? 0,
      cache_read_input_tokens: collected.usage?.cacheReadTokens ?? 0,
    },
  }
}

export function anthropicError(status: number, message: string): Record<string, unknown> {
  const type =
    status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 404
          ? 'not_found_error'
          : status === 400 || status === 413
            ? 'invalid_request_error'
            : status === 429
              ? 'rate_limit_error'
              : 'api_error'
  return { type: 'error', error: { type, message } }
}
