/**
 * Best-effort secret redaction for anything that may reach logs, traces,
 * run evidence or notifications.
 */
const PATTERNS: RegExp[] = [
  /dshlf_[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s"',;]+/gi,
  /((?:api[_-]?key|secret|password|passwd|token)\s*["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
]

export function redact(text: string): string {
  let out = text
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match: string, prefix?: string, bearer?: string) => {
      if (typeof prefix === 'string' && prefix.length > 0 && match.startsWith(prefix)) return `${prefix}${bearer ?? ''}[REDACTED]`
      return '[REDACTED]'
    })
  }
  return out
}

/**
 * Field and header names that carry secrets: Authorization, Cookie,
 * X-Auth-Token, Private-Token, x-goog-api-key, api-token, client_secret,
 * accessToken, … Matches whole name segments, so `inputTokens` or `keyword`
 * are not caught.
 */
const SECRET_SEGMENT = /(?:^|[-_.])(?:authorization|auth|token|secret|password|passwd|pwd|cookie|set-cookie|signature|credentials?|session|api[-_]?key|apikey|key|private[-_]?key|access[-_]?key)$/i
const SECRET_CAMEL = /(?:apiKey|accessToken|refreshToken|authToken|idToken|sessionToken|clientSecret|secretKey|privateKey|accessKey|password|Secret|Token)$/

export function isSecretName(name: string): boolean {
  return SECRET_SEGMENT.test(name) || SECRET_CAMEL.test(name) || /^(?:proxy-authorization|set-cookie|cookie|x-api-key|x-auth-token|private-token|x-goog-api-key)$/i.test(name)
}

/** Redact every string inside a JSON-like value, and every value under a secret-named key (returns a copy). */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 32) return value
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map(item => redactDeep(item, depth + 1)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSecretName(key) && inner !== null && typeof inner !== 'object' && inner !== '' ? '[REDACTED]' : redactDeep(inner, depth + 1)
    }
    return out as T
  }
  return value
}

/** Keep only the last `max` characters of a stream (e.g. child stderr). */
export class TailBuffer {
  private value = ''
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    this.value = (this.value + chunk).slice(-this.max)
  }
  toString(): string {
    return redact(this.value)
  }
}
