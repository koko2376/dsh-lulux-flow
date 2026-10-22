/**
 * OpenAI Responses API ⇄ canonical model. Used by Codex (`wire_api =
 * "responses"`). Supports `instructions`, string or item-array `input`
 * (message / function_call / function_call_output / custom_tool_call /
 * custom_tool_call_output), function tools and free-text custom tools.
 * Built-in tools (web_search, local_shell, ...) cannot run upstream and are dropped.
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
  type CanonicalTurn,
  type CollectedResponse,
  type FinishKind,
} from './canonical.js'

export interface ResponsesCanonical extends CanonicalRequest {
  /** Names of `custom` (free-text) tools: their calls are answered as custom_tool_call with `{input}` arguments. */
  customTools: Set<string>
}

export function responsesToCanonical(body: unknown): ResponsesCanonical {
  const input = asRecord(body)
  const system: string[] = []
  if (typeof input.instructions === 'string' && input.instructions.trim()) system.push(input.instructions)
  const turns: CanonicalTurn[] = []
  const lastAssistant = (): Extract<CanonicalTurn, { role: 'assistant' }> => {
    const last = turns.at(-1)
    if (last?.role === 'assistant') return last
    const turn: Extract<CanonicalTurn, { role: 'assistant' }> = { role: 'assistant', text: '' }
    turns.push(turn)
    return turn
  }
  const items = typeof input.input === 'string' ? [{ type: 'message', role: 'user', content: input.input }] : asArray(input.input)
  for (const raw of items) {
    const item = asRecord(raw)
    const type = asString(item.type) || (item.role !== undefined ? 'message' : '')
    if (type === 'message') {
      const role = asString(item.role)
      const content = flattenContent(item.content)
      if (role === 'system' || role === 'developer') system.push(content)
      else if (role === 'assistant') {
        const last = turns.at(-1)
        if (last?.role === 'assistant' && !(last.toolCalls?.length ?? 0)) last.text += content
        else turns.push({ role: 'assistant', text: content })
      } else {
        const images = extractImages(item.content)
        turns.push(images.length > 0 ? { role: 'user', text: content, images } : { role: 'user', text: content })
      }
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const turn = lastAssistant()
      turn.toolCalls = [
        ...(turn.toolCalls ?? []),
        {
          id: asString(item.call_id) || asString(item.id) || randomId('call_'),
          name: asString(item.name),
          arguments:
            type === 'custom_tool_call'
              ? JSON.stringify({ input: asString(item.input) })
              : typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments ?? {}),
        },
      ]
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      turns.push({ role: 'tool', toolCallId: asString(item.call_id), text: flattenContent(item.output) })
    }
  }

  const tools: CanonicalTool[] = []
  const customTools = new Set<string>()
  for (const raw of asArray(input.tools)) {
    const tool = asRecord(raw)
    const name = asString(tool.name)
    if (!name) continue
    if (tool.type === 'function') {
      tools.push({ name, description: asString(tool.description), parameters: normalizeSchema(tool.parameters) })
    } else if (tool.type === 'custom') {
      customTools.add(name)
      tools.push({
        name,
        description: asString(tool.description),
        parameters: { type: 'object', properties: { input: { type: 'string', description: 'Raw free-form tool input' } }, required: ['input'] },
      })
    }
  }
  const maxTokens = asNumber(input.max_output_tokens)
  const temperature = asNumber(input.temperature)
  return {
    model: asString(input.model),
    system: system.join('\n\n'),
    turns,
    tools,
    customTools,
    stream: input.stream === true,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  }
}

type OutputItem = Record<string, unknown>

/** Canonical events → Responses SSE (`response.created` … `response.completed`). */
export class ResponsesStreamEncoder {
  readonly id = randomId('resp_')
  private readonly createdAt = Math.floor(Date.now() / 1000)
  private seq = 0
  private output: OutputItem[] = []
  private text: { itemId: string; index: number; value: string } | null = null
  private reasoning: { itemId: string; index: number; value: string } | null = null
  private tools = new Map<string, { itemId: string; index: number; name: string; args: string; custom: boolean }>()
  private usageValue = { input: 0, output: 0, cached: 0, reasoning: 0 }

  constructor(
    private readonly model: string,
    estimatedInputTokens: number,
    private readonly customTools: Set<string> = new Set(),
  ) {
    this.usageValue.input = estimatedInputTokens
  }

  private sse(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...data })}\n\n`
  }

  private response(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: this.id,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: this.output,
      parallel_tool_calls: true,
      tool_choice: 'auto',
      tools: [],
      error: null,
      incomplete_details: null,
      ...extra,
    }
  }

  start(): string {
    return (
      this.sse('response.created', { response: this.response('in_progress', { output: [] }) }) +
      this.sse('response.in_progress', { response: this.response('in_progress', { output: [] }) })
    )
  }

  push(event: CanonicalEvent): string {
    switch (event.type) {
      case 'text': {
        if (!event.text) return ''
        let out = this.closeReasoning()
        if (this.text === null) {
          const itemId = randomId('msg_')
          const index = this.output.length
          const item = { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
          this.output.push(item)
          this.text = { itemId, index, value: '' }
          out += this.sse('response.output_item.added', { output_index: index, item })
          out += this.sse('response.content_part.added', {
            item_id: itemId,
            output_index: index,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          })
        }
        this.text.value += event.text
        return (
          out +
          this.sse('response.output_text.delta', {
            item_id: this.text.itemId,
            output_index: this.text.index,
            content_index: 0,
            delta: event.text,
            logprobs: [],
          })
        )
      }
      case 'reasoning': {
        if (!event.text) return ''
        let out = ''
        if (this.reasoning === null) {
          const itemId = randomId('rs_')
          const index = this.output.length
          const item = { id: itemId, type: 'reasoning', summary: [] }
          this.output.push(item)
          this.reasoning = { itemId, index, value: '' }
          out += this.sse('response.output_item.added', { output_index: index, item })
          out += this.sse('response.reasoning_summary_part.added', { item_id: itemId, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } })
        }
        this.reasoning.value += event.text
        return out + this.sse('response.reasoning_summary_text.delta', { item_id: this.reasoning.itemId, output_index: this.reasoning.index, summary_index: 0, delta: event.text })
      }
      case 'tool-call-start': {
        let out = this.closeText() + this.closeReasoning()
        const custom = this.customTools.has(event.name)
        const itemId = randomId(custom ? 'ctc_' : 'fc_')
        const index = this.output.length
        const item = custom
          ? { id: itemId, type: 'custom_tool_call', status: 'in_progress', call_id: event.id, name: event.name, input: '' }
          : { id: itemId, type: 'function_call', status: 'in_progress', call_id: event.id, name: event.name, arguments: '' }
        this.output.push(item)
        this.tools.set(event.id, { itemId, index, name: event.name, args: '', custom })
        out += this.sse('response.output_item.added', { output_index: index, item })
        return out
      }
      case 'tool-call-delta': {
        const tool = this.tools.get(event.id)
        if (tool === undefined || !event.argumentsDelta) return ''
        tool.args += event.argumentsDelta
        // Custom tools need the decoded `input` string; it is only known at the end.
        if (tool.custom) return ''
        return this.sse('response.function_call_arguments.delta', { item_id: tool.itemId, output_index: tool.index, delta: event.argumentsDelta })
      }
      case 'tool-call-end': {
        const tool = this.tools.get(event.id)
        if (tool === undefined) return ''
        this.tools.delete(event.id)
        const args = event.arguments || tool.args || '{}'
        if (tool.custom) {
          let inputText = ''
          try {
            inputText = String((JSON.parse(args) as { input?: unknown }).input ?? '')
          } catch {
            inputText = args
          }
          const item = { id: tool.itemId, type: 'custom_tool_call', status: 'completed', call_id: event.id, name: tool.name, input: inputText }
          this.output[tool.index] = item
          return (
            this.sse('response.custom_tool_call_input.delta', { item_id: tool.itemId, output_index: tool.index, delta: inputText }) +
            this.sse('response.custom_tool_call_input.done', { item_id: tool.itemId, output_index: tool.index, input: inputText }) +
            this.sse('response.output_item.done', { output_index: tool.index, item })
          )
        }
        const item = { id: tool.itemId, type: 'function_call', status: 'completed', call_id: event.id, name: tool.name, arguments: args }
        this.output[tool.index] = item
        return (
          this.sse('response.function_call_arguments.done', { item_id: tool.itemId, output_index: tool.index, arguments: args }) +
          this.sse('response.output_item.done', { output_index: tool.index, item })
        )
      }
      case 'usage':
        this.usageValue = {
          input: event.usage.inputTokens,
          output: event.usage.outputTokens,
          cached: event.usage.cacheReadTokens ?? 0,
          reasoning: event.usage.reasoningTokens ?? 0,
        }
        return ''
      case 'finish':
        if (event.reason === 'error' || event.reason === 'aborted') return this.error(event.error ?? event.reason)
        return this.finish(event.reason)
      default:
        return ''
    }
  }

  private closeText(): string {
    if (this.text === null) return ''
    const { itemId, index, value } = this.text
    this.text = null
    const part = { type: 'output_text', text: value, annotations: [] }
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [part] }
    this.output[index] = item
    return (
      this.sse('response.output_text.done', { item_id: itemId, output_index: index, content_index: 0, text: value, logprobs: [] }) +
      this.sse('response.content_part.done', { item_id: itemId, output_index: index, content_index: 0, part }) +
      this.sse('response.output_item.done', { output_index: index, item })
    )
  }

  private closeReasoning(): string {
    if (this.reasoning === null) return ''
    const { itemId, index, value } = this.reasoning
    this.reasoning = null
    const item = { id: itemId, type: 'reasoning', summary: [{ type: 'summary_text', text: value }] }
    this.output[index] = item
    return (
      this.sse('response.reasoning_summary_text.done', { item_id: itemId, output_index: index, summary_index: 0, text: value }) +
      this.sse('response.output_item.done', { output_index: index, item })
    )
  }

  private usage(): Record<string, unknown> {
    return {
      input_tokens: this.usageValue.input,
      input_tokens_details: { cached_tokens: this.usageValue.cached },
      output_tokens: this.usageValue.output,
      output_tokens_details: { reasoning_tokens: this.usageValue.reasoning },
      total_tokens: this.usageValue.input + this.usageValue.output,
    }
  }

  finish(reason: FinishKind = 'stop'): string {
    const out = this.closeText() + this.closeReasoning()
    const status = reason === 'max_tokens' ? 'incomplete' : 'completed'
    const extra: Record<string, unknown> = { usage: this.usage() }
    if (status === 'incomplete') extra.incomplete_details = { reason: 'max_output_tokens' }
    return out + this.sse(status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: this.response(status, extra) })
  }

  /** Final non-streaming response object. */
  final(reason: FinishKind = 'stop'): Record<string, unknown> {
    this.closeText()
    this.closeReasoning()
    const status = reason === 'max_tokens' ? 'incomplete' : 'completed'
    return this.response(status, { usage: this.usage(), ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) })
  }

  error(message: string): string {
    return this.sse('response.failed', { response: this.response('failed', { error: { code: 'server_error', message } }) })
  }
}

export function responsesFrom(model: string, estimatedInputTokens: number, collected: CollectedResponse, customTools: Set<string>): Record<string, unknown> {
  const encoder = new ResponsesStreamEncoder(model, estimatedInputTokens, customTools)
  if (collected.reasoning) encoder.push({ type: 'reasoning', text: collected.reasoning })
  if (collected.text) encoder.push({ type: 'text', text: collected.text })
  for (const call of collected.toolCalls) {
    encoder.push({ type: 'tool-call-start', id: call.id, name: call.name })
    encoder.push({ type: 'tool-call-end', id: call.id, name: call.name, arguments: call.arguments })
  }
  if (collected.usage) encoder.push({ type: 'usage', usage: collected.usage })
  return encoder.final(collected.finish)
}
