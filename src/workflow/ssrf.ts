/**
 * Outbound HTTP for HTTP/notify nodes with an SSRF guard.
 *
 * - only http/https;
 * - the destination IP is checked *at connect time* through a custom DNS
 *   lookup, so DNS rebinding cannot swap in a private address after the check;
 * - loopback, private, link-local, CGNAT, multicast, unspecified and cloud
 *   metadata ranges are refused unless the host is on the allowlist;
 * - redirects are followed manually (max 5), each hop re-checked; when a
 *   redirect leaves the original origin, Authorization, Cookie and other
 *   secret-named headers are dropped (as browsers and curl do);
 * - response bodies are size-limited; every request has a timeout.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { isSecretName } from '../util/redact.js'

const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96], // deprecated IPv4-compatible addresses (::127.0.0.1)
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
] as const) blocked.addSubnet(net, prefix, 'ipv6')

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return true
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    if (mapped) return blocked.check(mapped[1]!, 'ipv4')
    return blocked.check(address, 'ipv6')
  }
  return blocked.check(address, 'ipv4')
}

export interface OutboundPolicy {
  /** Hostnames (exact, or `*.example.com`) allowed even when they resolve to private ranges. */
  allowPrivateHosts: readonly string[]
  maxResponseBytes: number
  timeoutMs: number
}

export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return allow.some(rule => {
    const r = rule.toLowerCase().trim()
    if (!r) return false
    if (r.startsWith('*.')) return h.endsWith(r.slice(1))
    return h === r
  })
}

export interface OutboundResponse {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
  url: string
}

export class SsrfError extends Error {}

/** A credential-like word anywhere in a header name (`Api-Token-V2`, `X-Secret-Id`): stricter than redaction, since dropping an extra header on a redirect is harmless. */
const SECRET_WORD = /(?:^|[-_.])(?:authorization|auth|token|secret|password|passwd|pwd|cookie|signature|credentials?|session|api[-_]?key|apikey|key)(?:$|[-_.])/i

/** Headers kept across a cross-origin redirect: everything except credentials. */
export function stripSecretHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !isSecretName(key) && !SECRET_WORD.test(key)))
}

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '')
      const list = addresses as LookupAddress[]
      const safe = allowPrivate ? list : list.filter(a => !isBlockedAddress(a.address))
      if (safe.length === 0) return callback(new SsrfError(`blocked: ${hostname} resolves to a private or reserved address`) as NodeJS.ErrnoException, '')
      if ((options as { all?: boolean }).all === true) return callback(null, safe)
      callback(null, safe[0]!.address, safe[0]!.family)
    })
  }
}

export async function outboundRequest(
  rawUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  policy: OutboundPolicy,
): Promise<OutboundResponse> {
  let url = new URL(rawUrl)
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body
  let headers: Record<string, string> = { ...(init.headers ?? {}) }
  for (let hop = 0; hop <= 5; hop += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError(`blocked: unsupported protocol ${url.protocol}`)
    const allowPrivate = hostAllowed(url.hostname, policy.allowPrivateHosts)
    const literal = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(literal) !== 0 && !allowPrivate && isBlockedAddress(literal)) throw new SsrfError(`blocked: ${literal} is a private or reserved address`)
    const response = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http
      const req = transport.request(
        url,
        {
          method,
          headers: { 'user-agent': 'dsh-lulux-flow-workflow', ...headers },
          lookup: guardedLookup(allowPrivate) as never,
          timeout: policy.timeoutMs,
          ...(init.signal !== undefined ? { signal: init.signal } : {}),
        },
        res => {
          const chunks: Buffer[] = []
          let size = 0
          let truncated = false
          res.on('data', (chunk: Buffer) => {
            if (truncated) return
            size += chunk.length
            if (size > policy.maxResponseBytes) {
              truncated = true
              chunks.push(chunk.subarray(0, chunk.length - (size - policy.maxResponseBytes)))
              res.destroy()
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated })
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }))
          res.on('error', reject)
        },
      )
      req.on('timeout', () => req.destroy(new Error(`request timed out after ${policy.timeoutMs} ms`)))
      req.on('error', reject)
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') req.write(body)
      req.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.status) && typeof response.headers.location === 'string') {
      const next = new URL(response.headers.location, url)
      if (next.origin !== url.origin) headers = stripSecretHeaders(headers)
      url = next
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)))
      }
      continue
    }
    const responseHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value
    return { status: response.status, headers: responseHeaders, body: response.body.toString('utf8'), truncated: response.truncated, url: url.toString() }
  }
  throw new SsrfError('too many redirects')
}
