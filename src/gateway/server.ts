/**
 * The scoped kernel gateway: a loopback-only HTTP server that speaks the
 * Anthropic, OpenAI (Chat + Responses) and Gemini wire protocols and forwards
 * every call to DSH's configured model through an {@link Upstream}.
 *
 * Security properties (see SECURITY.md):
 * - binds 127.0.0.1 on a random port; refuses any other bind address;
 * - every request needs a run-scoped token from {@link TokenStore};
 * - Host header must be the loopback authority (DNS-rebinding guard);
 * - requests carrying an Origin header are refused (no browser access, no CORS);
 * - request bodies are size-limited; upstream calls have a deadline;
 * - nothing about request bodies or tokens is logged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { anthropicError, anthropicMessageFrom, AnthropicStreamEncoder, anthropicToCanonical } from './anthropic.js'
import {
  asRecord,
  asString,
  collect,
  estimateRequestTokens,
  type CanonicalEvent,
  type CanonicalRequest,
  type Upstream,
} from './canonical.js'
import { geminiError, geminiResponseFrom, GeminiStreamEncoder, geminiToCanonical } from './gemini.js'
import { McpEndpoint, type ApprovalBridge } from './mcp.js'
import { chatCompletionFrom, ChatStreamEncoder, chatToCanonical, openaiError } from './openai-chat.js'
import { responsesFrom, ResponsesStreamEncoder, responsesToCanonical } from './responses.js'
import type { GatewayProtocol, TokenRecord, TokenStore } from './tokens.js'
import { bearerToken, headerValue, HttpError, readJson, sendJson, startSse } from '../util/http.js'


/** Concurrent upstream calls one run token may have open. */
export const MAX_INFLIGHT_PER_TOKEN = 8
/** Time allowed to receive a request body. */
export const BODY_TIMEOUT_MS = 60_000

export interface GatewayLogger {
  info(message: string): void
  warn(message: string): void
  debug?(message: string): void
}

export interface GatewayOptions {
  upstream: Upstream
  tokens: TokenStore
  logger: GatewayLogger
  /** Maximum request body in bytes. */
  maxBodyBytes: number
  /** Upstream deadline per request in milliseconds. */
  requestTimeoutMs: number
  /** Bridges Claude Code permission prompts to DSH approvals (optional). */
  approvals?: ApprovalBridge
  /** Port to bind; 0 (default) picks a random free port. */
  port?: number
}

interface Encoder {
  start?(): string
  push(event: CanonicalEvent): string
  finish(): string
  error(message: string): string
}

type ProtocolKind = Exclude<GatewayProtocol, 'mcp'>

function errorBody(protocol: ProtocolKind, status: number, message: string): unknown {
  if (protocol === 'anthropic') return anthropicError(status, message)
  if (protocol === 'gemini') return geminiError(status, message)
  return openaiError(status, message)
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export class KernelGateway {
  private server: Server | undefined
  private port = 0
  private readonly mcp: McpEndpoint

  constructor(private readonly options: GatewayOptions) {
    this.mcp = new McpEndpoint(options.approvals)
  }

  /** Base URL children use, e.g. `http://127.0.0.1:43123`. */
  get baseUrl(): string {
    if (this.server === undefined) throw new Error('gateway is not listening')
    return `http://127.0.0.1:${this.port}`
  }

  get listening(): boolean {
    return this.server !== undefined
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.options.logger.warn(`gateway: unhandled error: ${error instanceof Error ? error.message : String(error)}`)
        if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal gateway error' } })
        else res.end()
      })
    })
    server.headersTimeout = 30_000
    server.requestTimeout = 0 // streaming responses may legitimately be long; upstream has its own deadline
    server.keepAliveTimeout = 5_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.port = (server.address() as AddressInfo).port
    this.server = server
    this.options.logger.info(`gateway listening on 127.0.0.1:${this.port}`)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  private checkHost(req: IncomingMessage): boolean {
    const host = headerValue(req, 'host')
    if (host === undefined) return false
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host)
    if (!match) return false
    if (!LOOPBACK_HOSTS.has(match[1]!.toLowerCase())) return false
    return match[2] === undefined || Number(match[2]) === this.port
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const protocol = this.protocolOf(path)
    const fail = (status: number, message: string): void => {
      sendJson(res, status, protocol === undefined || protocol === 'mcp' ? { error: { message } } : errorBody(protocol, status, message))
    }
    try {
      if (!this.checkHost(req)) return fail(403, 'forbidden host')
      if (headerValue(req, 'origin') !== undefined) return fail(403, 'browser requests are not allowed')
      if (req.method === 'OPTIONS') return fail(405, 'method not allowed')
      if (protocol === undefined) return fail(404, 'not found')

      const presented =
        bearerToken(req) ?? headerValue(req, 'x-api-key') ?? headerValue(req, 'x-goog-api-key') ?? (protocol === 'gemini' ? url.searchParams.get('key') ?? undefined : undefined)
      const record = this.options.tokens.resolve(presented, protocol)
      if (record === undefined) return fail(401, 'invalid or expired gateway token')

      if (protocol === 'mcp') {
        if (req.method === 'GET') return fail(405, 'server-initiated streams are not supported')
        if (req.method === 'DELETE') {
          res.writeHead(204).end()
          return
        }
        const body = await this.readBodyWithDeadline(req)
        const reply = await this.mcp.handle(body, record)
        if (reply === undefined) {
          res.writeHead(202).end()
          return
        }
        sendJson(res, 200, reply, { 'mcp-session-id': record.runId })
        return
      }

      // Lightweight endpoints that do not call upstream.
      if (req.method === 'GET' && (path.endsWith('/models') || path.endsWith('/v1/models'))) {
        return this.models(res, protocol, record)
      }
      if (req.method !== 'POST') return fail(405, 'method not allowed')
      if (record.inflight.size >= MAX_INFLIGHT_PER_TOKEN) return fail(429, `too many concurrent requests for this run (max ${MAX_INFLIGHT_PER_TOKEN})`)

      const body = await this.readBodyWithDeadline(req)
      if (protocol === 'anthropic' && path.endsWith('/count_tokens')) {
        sendJson(res, 200, { input_tokens: estimateRequestTokens(anthropicToCanonical(body)) })
        return
      }
      if (protocol === 'gemini' && path.endsWith(':countTokens')) {
        const model = this.geminiModel(path)
        sendJson(res, 200, { totalTokens: estimateRequestTokens(geminiToCanonical(asRecord(body).generateContentRequest ?? body, model, false)) })
        return
      }
      await this.forward(req, res, protocol, path, url, body, record)
    } catch (error: unknown) {
      if (error instanceof HttpError) fail(error.status, error.message)
      else throw error
    } finally {
      this.options.logger.debug?.(`gateway ${req.method ?? '?'} ${path} ${res.statusCode} ${Date.now() - started}ms`)
    }
  }

  /** Request bodies must arrive within BODY_TIMEOUT_MS (responses may stream for long; bodies may not trickle). */
  private readBodyWithDeadline(req: IncomingMessage): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new HttpError(408, `request body not received within ${BODY_TIMEOUT_MS} ms`))
        req.destroy()
      }, BODY_TIMEOUT_MS)
    })
    return Promise.race([readJson(req, this.options.maxBodyBytes), deadline]).finally(() => clearTimeout(timer))
  }

  private protocolOf(path: string): GatewayProtocol | undefined {
    if (path === '/mcp') return 'mcp'
    if (path.startsWith('/anthropic/')) return 'anthropic'
    if (path === '/openai/v1/responses' || path === '/openai/responses') return 'openai-responses'
    if (path.startsWith('/openai/')) return 'openai-chat'
    if (path.startsWith('/gemini/')) return 'gemini'
    return undefined
  }

  private geminiModel(path: string): string {
    const match = /\/models\/([^/:]+)(?::[A-Za-z]+)?$/.exec(path)
    return decodeURIComponent(match?.[1] ?? '')
  }

  private models(res: ServerResponse, protocol: ProtocolKind, record: TokenRecord): void {
    const id = record.target.model
    if (protocol === 'anthropic') {
      sendJson(res, 200, { data: [{ type: 'model', id, display_name: id, created_at: new Date(record.createdAt).toISOString() }], has_more: false, first_id: id, last_id: id })
    } else if (protocol === 'gemini') {
      sendJson(res, 200, { models: [{ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] }] })
    } else {
      sendJson(res, 200, { object: 'list', data: [{ id, object: 'model', created: Math.floor(record.createdAt / 1000), owned_by: 'dsh' }] })
    }
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    protocol: ProtocolKind,
    path: string,
    url: URL,
    body: unknown,
    record: TokenRecord,
  ): Promise<void> {
    let request: CanonicalRequest
    let customTools = new Set<string>()
    if (protocol === 'anthropic') {
      if (!path.endsWith('/messages')) throw new HttpError(404, 'not found')
      request = anthropicToCanonical(body)
    } else if (protocol === 'openai-chat') {
      if (!path.endsWith('/chat/completions')) throw new HttpError(404, 'not found')
      request = chatToCanonical(body)
    } else if (protocol === 'openai-responses') {
      const parsed = responsesToCanonical(body)
      customTools = parsed.customTools
      request = parsed
    } else {
      const streaming = path.endsWith(':streamGenerateContent')
      if (!streaming && !path.endsWith(':generateContent')) throw new HttpError(404, 'not found')
      request = geminiToCanonical(body, this.geminiModel(path), streaming)
      if (streaming && url.searchParams.get('alt') !== 'sse') request.stream = true
    }
    if (request.turns.length === 0) throw new HttpError(400, 'request has no messages')
    const echoModel = request.model || record.target.model
    const estimated = estimateRequestTokens(request)

    const controller = new AbortController()
    record.inflight.add(controller)
    record.stats.requests += 1
    const timeout = setTimeout(() => controller.abort(new Error('upstream deadline exceeded')), this.options.requestTimeoutMs)
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort(new Error('client disconnected'))
    }
    res.on('close', onClose)
    const events = this.track(this.options.upstream.stream(request, record.target, controller.signal), record)
    let streamEncoder: Encoder | undefined
    try {
      if (!request.stream) {
        const collected = await collect(events)
        if (collected.finish === 'error' || collected.finish === 'aborted') {
          record.stats.lastError = collected.error ?? collected.finish
          sendJson(res, 502, errorBody(protocol, 502, collected.error ?? 'upstream failed'))
          return
        }
        const payload =
          protocol === 'anthropic'
            ? anthropicMessageFrom(echoModel, estimated, collected)
            : protocol === 'openai-chat'
              ? chatCompletionFrom(echoModel, estimated, collected)
              : protocol === 'openai-responses'
                ? responsesFrom(echoModel, estimated, collected, customTools)
                : geminiResponseFrom(echoModel, estimated, collected)
        sendJson(res, 200, payload)
        return
      }
      const encoder: Encoder =
        protocol === 'anthropic'
          ? new AnthropicStreamEncoder(echoModel, estimated)
          : protocol === 'openai-chat'
            ? new ChatStreamEncoder(echoModel, asRecord(asRecord(body).stream_options).include_usage === true)
            : protocol === 'openai-responses'
              ? new ResponsesStreamEncoder(echoModel, estimated, customTools)
              : new GeminiStreamEncoder(echoModel, estimated)
      streamEncoder = encoder
      startSse(res)
      if (encoder.start) res.write(encoder.start())
      let finished = false
      for await (const event of events) {
        if (event.type === 'finish') {
          finished = true
          if (event.reason === 'error' || event.reason === 'aborted') record.stats.lastError = event.error ?? event.reason
        }
        const frame = encoder.push(event)
        if (frame) res.write(frame)
        if (finished) break
      }
      if (!finished) res.write(encoder.finish())
      res.end()
    } catch (error: unknown) {
      const message = controller.signal.aborted ? asString((controller.signal.reason as Error | undefined)?.message) || 'aborted' : error instanceof Error ? error.message : String(error)
      record.stats.lastError = message
      this.options.logger.warn(`gateway: upstream failure for kernel ${record.kernelId}: ${message}`)
      if (!res.headersSent) sendJson(res, 502, errorBody(protocol, 502, message))
      else {
        if (streamEncoder !== undefined && !res.writableEnded) res.write(streamEncoder.error(message))
        res.end()
      }
    } finally {
      clearTimeout(timeout)
      res.off('close', onClose)
      record.inflight.delete(controller)
      void req
    }
  }

  private async *track(events: AsyncIterable<CanonicalEvent>, record: TokenRecord): AsyncIterable<CanonicalEvent> {
    for await (const event of events) {
      if (event.type === 'usage') this.options.tokens.recordUsage(record, event.usage)
      yield event
    }
  }
}
