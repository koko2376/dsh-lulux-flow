/**
 * Gemini generateContent / streamGenerateContent ⇄ canonical model. Used by
 * Gemini CLI (`GOOGLE_GEMINI_BASE_URL`). A functionCall without an id is
 * paired with its functionResponse by name, in order.
 */
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  imageFromBlock,
  normalizeSchema,
  randomId,
  type CanonicalEvent,
  type CanonicalImage,
  type CanonicalRequest,
  type CanonicalTool,
  type CanonicalToolCall,
  type CanonicalTurn,
  type CollectedResponse,
  type FinishKind,
} from './canonical.js'

export function geminiToCanonical(body: unknown, model: string, stream: boolean): CanonicalRequest {
  const input = asRecord(body)
  const system = asArray(asRecord(input.systemInstruction ?? input.system_instruction).parts)
    .map(part => asString(asRecord(part).text))
    .filter(Boolean)
    .join('\n')
  const turns: CanonicalTurn[] = []
  const pending = new Map<string, string[]>()

  for (const raw of asArray(input.contents)) {
    const content = asRecord(raw)
    const parts = asArray(content.parts).map(asRecord)
    if (content.role === 'model') {
      const text: string[] = []
      const calls: CanonicalToolCall[] = []
      for (const part of parts) {
        if (part.thought === true) continue
        if (typeof part.text === 'string') text.push(part.text)
        const call = asRecord(part.functionCall ?? part.function_call)
        const name = asString(call.name)
        if (name) {
          const id = asString(call.id) || randomId('gcall_')
          const queue = pending.get(name) ?? []
          queue.push(id)
          pending.set(name, queue)
          calls.push({ id, name, arguments: JSON.stringify(call.args ?? {}) })
        }
      }
      turns.push({ role: 'assistant', text: text.join(''), ...(calls.length > 0 ? { toolCalls: calls } : {}) })
      continue
    }
    const text: string[] = []
    const images: CanonicalImage[] = []
    for (const part of parts) {
      const response = asRecord(part.functionResponse ?? part.function_response)
      const name = asString(response.name)
      if (name) {
        let id = asString(response.id)
        const queue = pending.get(name) ?? []
        if (id && queue.includes(id)) queue.splice(queue.indexOf(id), 1)
        else id = queue.shift() ?? (id || randomId('gcall_'))
        turns.push({ role: 'tool', toolCallId: id, text: JSON.stringify(response.response ?? {}) })
      } else if (typeof part.text === 'string') {
        text.push(part.text)
      } else if (part.inlineData !== undefined || part.inline_data !== undefined || part.fileData !== undefined) {
        const image = imageFromBlock(part)
        if (image) images.push(image)
        else text.push('[file omitted: the gateway forwards inline images only]')
      }
    }
    if (text.length > 0 || images.length > 0) {
      const joined = text.join('\n')
      turns.push(images.length > 0 ? { role: 'user', text: joined, images } : { role: 'user', text: joined })
    }
  }

  const tools: CanonicalTool[] = []
  for (const raw of asArray(input.tools)) {
    const tool = asRecord(raw)
    for (const declRaw of asArray(tool.functionDeclarations ?? tool.function_declarations)) {
      const decl = asRecord(declRaw)
      const name = asString(decl.name)
      if (!name) continue
      tools.push({
        name,
        description: asString(decl.description),
        parameters: normalizeSchema(decl.parametersJsonSchema ?? decl.parameters ?? { type: 'object', properties: {} }),
      })
    }
  }
  const generation = asRecord(input.generationConfig ?? input.generation_config)
  const maxTokens = asNumber(generation.maxOutputTokens)
  const temperature = asNumber(generation.temperature)
  const stop = asArray(generation.stopSequences).filter((s): s is string => typeof s === 'string')
  return {
    model,
    system,
    turns,
    tools,
    stream,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(stop.length > 0 ? { stop } : {}),
  }
}

function finishReason(finish: FinishKind): string {
  return finish === 'max_tokens' ? 'MAX_TOKENS' : 'STOP'
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

/** Canonical events → `streamGenerateContent?alt=sse` frames. Gemini has no argument deltas, so calls are emitted whole. */
export class GeminiStreamEncoder {
  private usage = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }

  constructor(
    private readonly model: string,
    estimatedInputTokens: number,
  ) {
    this.usage.promptTokenCount = estimatedInputTokens
    this.usage.totalTokenCount = estimatedInputTokens
  }

  private frame(parts: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, index: 0, ...extra }], modelVersion: this.model })}\r\n\r\n`
  }

  push(event: CanonicalEvent): string {
    switch (event.type) {
      case 'text':
        return event.text ? this.frame([{ text: event.text }]) : ''
      case 'reasoning':
        return event.text ? this.frame([{ text: event.text, thought: true }]) : ''
      case 'tool-call-end':
        return this.frame([{ functionCall: { id: event.id, name: event.name, args: parseArgs(event.arguments) } }])
      case 'usage':
        this.usage = {
          promptTokenCount: event.usage.inputTokens,
          candidatesTokenCount: event.usage.outputTokens,
          totalTokenCount: event.usage.inputTokens + event.usage.outputTokens,
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
    return `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: finishReason(reason), index: 0 }],
      usageMetadata: this.usage,
      modelVersion: this.model,
    })}\r\n\r\n`
  }

  error(message: string): string {
    return `data: ${JSON.stringify({ error: { code: 502, message, status: 'UNAVAILABLE' } })}\r\n\r\n`
  }
}

export function geminiResponseFrom(model: string, estimatedInputTokens: number, collected: CollectedResponse): Record<string, unknown> {
  const parts: Record<string, unknown>[] = []
  if (collected.reasoning) parts.push({ text: collected.reasoning, thought: true })
  if (collected.text) parts.push({ text: collected.text })
  for (const call of collected.toolCalls) parts.push({ functionCall: { id: call.id, name: call.name, args: parseArgs(call.arguments) } })
  if (parts.length === 0) parts.push({ text: '' })
  const prompt = collected.usage?.inputTokens ?? estimatedInputTokens
  const output = collected.usage?.outputTokens ?? 0
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: finishReason(collected.finish), index: 0 }],
    usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: output, totalTokenCount: prompt + output },
    modelVersion: model,
  }
}

export function geminiError(status: number, message: string): Record<string, unknown> {
  const statusText =
    status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'PERMISSION_DENIED' : status === 400 || status === 413 ? 'INVALID_ARGUMENT' : status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE'
  return { error: { code: status, message, status: statusText } }
}
