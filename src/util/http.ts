import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
  ) {
    super(message)
  }
}

/** Read a request body with a hard byte limit; rejects with 413 when exceeded. */
export function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0')
    if (Number.isFinite(declared) && declared > limitBytes) {
      reject(new HttpError(413, `request body exceeds ${limitBytes} bytes`, 'payload_too_large'))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > limitBytes) {
        done = true
        reject(new HttpError(413, `request body exceeds ${limitBytes} bytes`, 'payload_too_large'))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', error => {
      if (!done) {
        done = true
        reject(error)
      }
    })
  })
}

export async function readJson(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const raw = await readBody(req, limitBytes)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'request body is not valid JSON', 'invalid_json')
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
    ...extra,
  })
  res.end(payload)
}

export function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const auth = headerValue(req, 'authorization')
  if (auth === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
  return match?.[1]?.trim()
}
