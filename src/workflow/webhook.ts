/**
 * Webhook trigger authentication: HMAC-SHA256 over `<timestamp>.<raw body>`
 * with the workflow's secret, a ±5 minute timestamp window, constant-time
 * comparison and a replay cache for seen signatures (persisted to disk when
 * given a file, so a restart does not reopen the 5-minute window).
 *
 *   X-Lulux-Flow-Timestamp: 1767225600
 *   X-Lulux-Flow-Signature: sha256=<hex>
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readJsonFile, writeJsonAtomic } from '../util/fs.js'

export const WEBHOOK_TOLERANCE_SECONDS = 300

export function signWebhook(secret: string, timestamp: number, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`
}

export class ReplayCache {
  private readonly seen = new Map<string, number>()
  constructor(
    private readonly ttlMs = WEBHOOK_TOLERANCE_SECONDS * 2000,
    private readonly file?: string,
  ) {
    if (file !== undefined) {
      const saved = readJsonFile<Record<string, number>>(file) ?? {}
      for (const [key, at] of Object.entries(saved)) if (typeof at === 'number') this.seen.set(key, at)
    }
  }
  /** Returns false when the key was already seen within the TTL. */
  remember(key: string, now = Date.now()): boolean {
    for (const [k, at] of this.seen) if (now - at > this.ttlMs) this.seen.delete(k)
    if (this.seen.has(key)) return false
    if (this.seen.size > 10_000) this.seen.delete(this.seen.keys().next().value as string)
    this.seen.set(key, now)
    if (this.file !== undefined) {
      try {
        writeJsonAtomic(this.file, Object.fromEntries(this.seen))
      } catch {
        /* best effort; the in-memory cache still applies */
      }
    }
    return true
  }
}

export type WebhookVerdict = { ok: true } | { ok: false; status: 401 | 409; reason: string }

export function verifyWebhook(
  secret: string | undefined,
  headers: { timestamp: string | undefined; signature: string | undefined },
  rawBody: Buffer,
  replay: ReplayCache,
  nowSeconds = Math.floor(Date.now() / 1000),
): WebhookVerdict {
  if (secret === undefined) return { ok: false, status: 401, reason: 'webhook is not configured for this workflow' }
  const ts = Number(headers.timestamp)
  if (!Number.isInteger(ts)) return { ok: false, status: 401, reason: 'missing or invalid timestamp' }
  if (Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, status: 401, reason: 'timestamp outside the allowed window' }
  const presented = headers.signature ?? ''
  const expected = signWebhook(secret, ts, rawBody)
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, reason: 'invalid signature' }
  if (!replay.remember(presented)) return { ok: false, status: 409, reason: 'replayed request' }
  return { ok: true }
}
