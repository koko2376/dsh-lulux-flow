/**
 * Protocol-neutral request/stream model used by the scoped kernel gateway.
 *
 * Every wire protocol the gateway speaks (Anthropic Messages, OpenAI Chat
 * Completions, OpenAI Responses, Gemini generateContent) is decoded into a
 * {@link CanonicalRequest}, forwarded to an {@link Upstream}, and the
 * resulting {@link CanonicalEvent} stream is re-encoded for the caller.
 */

export interface CanonicalImage {
  mime: string
  /** Base64 payload without the data-URL prefix. */
  data: string
}

export interface CanonicalToolCall {
  id: string
  name: string
  /** Raw JSON arguments string. */
  arguments: string
}

export type CanonicalTurn =
  | { role: 'user'; text: string; images?: CanonicalImage[] }
  | { role: 'assistant'; text: string; toolCalls?: CanonicalToolCall[] }
  | { role: 'tool'; toolCallId: string; text: string; isError?: boolean }

export interface CanonicalTool {
  name: string
  description: string
  /** JSON Schema object. */
  parameters: Record<string, unknown>
}

export interface CanonicalRequest {
  /** Model name the client asked for (echoed back; routing uses the token's binding). */
  model: string
  system: string
  turns: CanonicalTurn[]
  tools: CanonicalTool[]
  stream: boolean
  maxTokens?: number
  temperature?: number
  stop?: string[]
}

export type FinishKind = 'stop' | 'tool_use' | 'max_tokens' | 'error' | 'aborted'

export interface CanonicalUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

export type CanonicalEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-delta'; id: string; argumentsDelta: string }
  | { type: 'tool-call-end'; id: string; name: string; arguments: string }
  | { type: 'usage'; usage: CanonicalUsage }
  | { type: 'finish'; reason: FinishKind; error?: string }

/** What a request is routed to: fixed by the run token, never by the client. */
export interface UpstreamTarget {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The model backend behind the gateway (DSH's `ctx.llm` in production, a fake in tests). */
export interface Upstream {
  stream(request: CanonicalRequest, target: UpstreamTarget, signal: AbortSignal): AsyncIterable<CanonicalEvent>
}

// ── small decoding helpers shared by the protocol modules ───────────────────

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export function parseImageDataUrl(url: string): CanonicalImage | null {
  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url)
  if (!match) return null
  const mime = match[1]!.toLowerCase()
  if (!(IMAGE_MIMES as readonly string[]).includes(mime)) return null
  return { mime, data: match[2]!.replace(/\s+/g, '') }
}

/** Extract inline base64 images from a protocol content block; remote URLs are not fetched. */
export function imageFromBlock(raw: unknown): CanonicalImage | null {
  const block = asRecord(raw)
  const type = asString(block.type)
  if (type === 'image') {
    const source = asRecord(block.source)
    const mime = asString(source.media_type).toLowerCase()
    if (source.type === 'base64' && (IMAGE_MIMES as readonly string[]).includes(mime) && asString(source.data)) {
      return { mime, data: asString(source.data) }
    }
    return null
  }
  if (type === 'image_url' || type === 'input_image') {
    const url = typeof block.image_url === 'string' ? block.image_url : asString(asRecord(block.image_url).url)
    return parseImageDataUrl(url)
  }
  const inline = asRecord(block.inlineData ?? block.inline_data)
  const mime = asString(inline.mimeType ?? inline.mime_type).toLowerCase()
  if (mime && (IMAGE_MIMES as readonly string[]).includes(mime) && asString(inline.data)) {
    return { mime, data: asString(inline.data) }
  }
  return null
}

export function extractImages(content: unknown): CanonicalImage[] {
  return asArray(content)
    .map(imageFromBlock)
    .filter((image): image is CanonicalImage => image !== null)
}

/**
 * Collapse a protocol "content" value (string or block array) into text.
 * Non-text blocks that cannot be forwarded become short placeholders so the
 * model knows something was omitted.
 */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === null || content === undefined ? '' : JSON.stringify(content)
  const parts: string[] = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      parts.push(raw)
      continue
    }
    const block = asRecord(raw)
    const type = asString(block.type)
    if (typeof block.text === 'string' && (type === '' || type.includes('text'))) parts.push(block.text)
    else if (type.includes('image')) {
      if (!imageFromBlock(block)) parts.push('[image omitted: the gateway forwards inline images only]')
    } else if (type === 'document' || type === 'input_file' || type === 'file') parts.push('[file omitted: the gateway forwards text only]')
    else if (type === 'tool_result' || type === 'tool_use' || type === 'thinking' || type === 'redacted_thinking') continue
    else if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Normalize a JSON Schema: lowercase OpenAPI-style types, drop `$schema`, guarantee an object root. */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node === null || typeof node !== 'object') return node
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$schema') continue
      if (key === 'type' && typeof value === 'string') out.type = value.toLowerCase()
      else if (key === 'type' && Array.isArray(value)) out.type = value.map(item => (typeof item === 'string' ? item.toLowerCase() : item))
      else out[key] = walk(value)
    }
    return out
  }
  const result = asRecord(walk(schema))
  if (!result.type) result.type = 'object'
  if (result.type === 'object' && !result.properties) result.properties = {}
  return result
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return {}
  }
}

/** Rough token estimate without a tokenizer (ASCII ≈ 4 chars/token, CJK ≈ 1 char/token). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) ascii += 1
    else wide += 1
  }
  return Math.max(1, Math.ceil(ascii / 4 + wide))
}

export function estimateRequestTokens(request: CanonicalRequest): number {
  let text = request.system
  for (const turn of request.turns) {
    text += turn.text
    if (turn.role === 'assistant') for (const call of turn.toolCalls ?? []) text += call.name + call.arguments
  }
  for (const tool of request.tools) text += tool.name + tool.description + JSON.stringify(tool.parameters)
  return estimateTokens(text)
}

/**
 * Collect a full event stream into a single assistant result. Used by
 * non-streaming endpoints.
 */
export interface CollectedResponse {
  text: string
  reasoning: string
  toolCalls: CanonicalToolCall[]
  usage: CanonicalUsage | undefined
  finish: FinishKind
  error?: string
}

export async function collect(events: AsyncIterable<CanonicalEvent>): Promise<CollectedResponse> {
  const result: CollectedResponse = { text: '', reasoning: '', toolCalls: [], usage: undefined, finish: 'stop' }
  for await (const event of events) {
    switch (event.type) {
      case 'text':
        result.text += event.text
        break
      case 'reasoning':
        result.reasoning += event.text
        break
      case 'tool-call-end':
        result.toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments })
        break
      case 'usage':
        result.usage = event.usage
        break
      case 'finish':
        result.finish = event.reason
        if (event.error !== undefined) result.error = event.error
        break
      default:
        break
    }
  }
  if (result.toolCalls.length > 0 && result.finish === 'stop') result.finish = 'tool_use'
  return result
}

export function sse(event: string | undefined, data: unknown): string {
  return `${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`
}

export function randomId(prefix: string, bytes = 12): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const values = crypto.getRandomValues(new Uint8Array(bytes * 2))
  let out = ''
  for (const value of values) out += alphabet[value % alphabet.length]
  return `${prefix}${out}`
}
