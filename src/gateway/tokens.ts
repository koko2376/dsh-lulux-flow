/**
 * Run-scoped bearer tokens for the kernel gateway.
 *
 * - A token is minted for exactly one kernel run and is reusable for the
 *   whole run (TTL = run timeout + 60 s, revoked when the run ends). It is
 *   bound to the upstream provider/model chosen by DSH at that moment and to
 *   the wire protocols that CLI uses.
 * - Only the SHA-256 digest is stored in the gateway. The plaintext is given
 *   to the child in its environment and, for Claude Code's MCP approval
 *   bridge, in a 0600 config file inside the per-run home (deleted after the
 *   run).
 * - Lookup is by digest, followed by a constant-time comparison of the
 *   digest bytes, so timing does not depend on how much of a guess matches.
 * - Tokens expire after `ttlMs` and are revoked explicitly when the run ends;
 *   revocation aborts any in-flight upstream request made with the token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { BRAND } from '../brand.js'
import type { CanonicalUsage, UpstreamTarget } from './canonical.js'

export type GatewayProtocol = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini' | 'mcp'

export interface TokenBinding {
  runId: string
  kernelId: string
  target: UpstreamTarget
  /** Protocols this token may call. */
  protocols: readonly GatewayProtocol[]
  /** DSH session that owns the run, when known (used for approvals). */
  sessionId?: string
}

export interface TokenStats {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  lastError: string | null
}

export interface TokenRecord extends TokenBinding {
  readonly digest: Buffer
  readonly createdAt: number
  readonly expiresAt: number
  readonly stats: TokenStats
  /** Abort controllers of in-flight requests made with this token. */
  readonly inflight: Set<AbortController>
}

export interface IssuedToken {
  token: string
  record: TokenRecord
  /** Revoke the token and abort its in-flight requests. Idempotent. */
  revoke(): void
}

const TOKEN_BYTES = 32
const MAX_TOKEN_LENGTH = 256

function digestOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

export class TokenStore {
  private readonly records = new Map<string, TokenRecord>()

  constructor(private readonly now: () => number = Date.now) {}

  issue(binding: TokenBinding, ttlMs: number): IssuedToken {
    if (!(ttlMs > 0)) throw new Error('token ttl must be positive')
    this.sweep()
    const token = `${BRAND.tokenPrefix}${randomBytes(TOKEN_BYTES).toString('base64url')}`
    const digest = digestOf(token)
    const createdAt = this.now()
    const record: TokenRecord = {
      ...binding,
      protocols: [...binding.protocols],
      digest,
      createdAt,
      expiresAt: createdAt + ttlMs,
      stats: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, lastError: null },
      inflight: new Set(),
    }
    const key = digest.toString('hex')
    this.records.set(key, record)
    return {
      token,
      record,
      revoke: () => this.revokeKey(key),
    }
  }

  /** Resolve a presented token; returns undefined for unknown, expired, revoked or wrong-protocol tokens. */
  resolve(presented: string | null | undefined, protocol: GatewayProtocol): TokenRecord | undefined {
    if (typeof presented !== 'string' || presented.length === 0 || presented.length > MAX_TOKEN_LENGTH) return undefined
    if (!presented.startsWith(BRAND.tokenPrefix)) return undefined
    const digest = digestOf(presented)
    const key = digest.toString('hex')
    const record = this.records.get(key)
    if (record === undefined) return undefined
    if (!timingSafeEqual(record.digest, digest)) return undefined
    if (this.now() >= record.expiresAt) {
      this.revokeKey(key)
      return undefined
    }
    if (!record.protocols.includes(protocol)) return undefined
    return record
  }

  /** Revoke every token minted for a run. */
  revokeRun(runId: string): number {
    let count = 0
    for (const [key, record] of this.records) {
      if (record.runId === runId) {
        this.revokeKey(key)
        count += 1
      }
    }
    return count
  }

  recordUsage(record: TokenRecord, usage: CanonicalUsage): void {
    record.stats.inputTokens += usage.inputTokens
    record.stats.outputTokens += usage.outputTokens
    record.stats.cacheReadTokens += usage.cacheReadTokens ?? 0
  }

  get size(): number {
    return this.records.size
  }

  /** Revoke everything (plugin unload). */
  clear(): void {
    for (const key of [...this.records.keys()]) this.revokeKey(key)
  }

  private revokeKey(key: string): void {
    const record = this.records.get(key)
    if (record === undefined) return
    this.records.delete(key)
    for (const controller of record.inflight) controller.abort(new Error('gateway token revoked'))
    record.inflight.clear()
  }

  private sweep(): void {
    const now = this.now()
    for (const [key, record] of this.records) if (now >= record.expiresAt) this.revokeKey(key)
  }
}
