/**
 * npm registry selection for kernel installs.
 *
 * Candidate registries are probed in parallel with one small metadata
 * request (`/<pkg>/latest`, a few KB) under a short timeout. Each answer is
 * scored by time-to-first-byte and throughput, filtered by whether it offers
 * a version that satisfies the kernel's minimum, and cross-checked: the
 * `dist.integrity` a mirror advertises is compared with the canonical
 * registry's. The probe only ranks mirrors; what gets installed is pinned by
 * a lockfile resolved against the canonical registry (see installer.ts).
 */
import { satisfiesMinVersion } from './binary.js'

export const DEFAULT_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
  'https://mirrors.cloud.tencent.com/npm',
  'https://repo.huaweicloud.com/repository/npm',
] as const

export const CANONICAL_REGISTRY = 'https://registry.npmjs.org'

export interface ProbeResult {
  registry: string
  ok: boolean
  latencyMs: number
  /** Bytes per second for the metadata body; 0 when unknown. */
  throughput: number
  version?: string
  integrity?: string
  tarball?: string
  error?: string
  /** True when this registry offers a version meeting the minimum. */
  satisfies: boolean
  /** True when its integrity matches the reference integrity. */
  trusted: boolean
  score: number
}

export interface RankedRegistries {
  packageName: string
  probedAt: number
  results: ProbeResult[]
  /** Integrity every installed tarball must match. */
  referenceIntegrity?: string
  referenceVersion?: string
}

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect?: 'follow' | 'manual' | 'error' }) => Promise<Response>

/** One timed GET: what the probes score (time to first byte, body throughput). */
export interface TimedResponse {
  status: number
  headers: Headers
  body: string
  latencyMs: number
  /** Bytes per second for the body; 0 when it was empty. */
  throughput: number
}

/**
 * A single GET under a hard timeout, timed the way every mirror probe here is
 * scored (kernel registries and update sources). Rejects with
 * `timeout after <n> ms` when the deadline passes; HTTP errors resolve, the
 * caller decides what a status means. The body is capped at `maxBytes`.
 */
export async function timedGet(url: string, options: { timeoutMs: number; headers?: Record<string, string>; fetcher?: Fetcher; redirect?: 'follow' | 'manual' | 'error'; maxBytes?: number }): Promise<TimedResponse> {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      signal: controller.signal,
      headers: options.headers ?? {},
      ...(options.redirect !== undefined ? { redirect: options.redirect } : {}),
    })
    const ttfb = performance.now() - started
    const body = await response.text()
    const max = options.maxBytes ?? 4 * 1024 * 1024
    if (body.length > max) throw new Error(`response larger than ${max} bytes`)
    const total = Math.max(1, performance.now() - started)
    return { status: response.status, headers: response.headers, body, latencyMs: Math.round(ttfb), throughput: body.length > 0 ? Math.round((body.length / total) * 1000) : 0 }
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new Error(`timeout after ${options.timeoutMs} ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Registries must be https (plain http only on loopback, e.g. a local cache). */
export function normalizeRegistry(url: string): string {
  const parsed = new URL(url.trim())
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) throw new Error('registry must be an https:// URL (http:// only for 127.0.0.1/localhost)')
  if (parsed.username || parsed.password) throw new Error('registry URL must not contain credentials')
  return parsed.toString().replace(/\/+$/, '')
}

function encodePackage(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
}

export async function probeRegistry(registry: string, packageName: string, minVersion: string, timeoutMs: number, fetcher: Fetcher = fetch): Promise<ProbeResult> {
  const started = performance.now()
  try {
    const response = await timedGet(`${registry}/${encodePackage(packageName)}/latest`, {
      timeoutMs,
      fetcher,
      headers: { accept: 'application/json', 'user-agent': 'dsh-lulux-flow-registry-probe' },
    })
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`)
    const json = JSON.parse(response.body) as { version?: string; dist?: { integrity?: string; shasum?: string; tarball?: string } }
    const version = typeof json.version === 'string' ? json.version : undefined
    const integrity = json.dist?.integrity ?? (json.dist?.shasum ? `sha1-${Buffer.from(json.dist.shasum, 'hex').toString('base64')}` : undefined)
    return {
      registry,
      ok: true,
      latencyMs: response.latencyMs,
      throughput: response.throughput,
      ...(version !== undefined ? { version } : {}),
      ...(integrity !== undefined ? { integrity } : {}),
      ...(json.dist?.tarball !== undefined ? { tarball: json.dist.tarball } : {}),
      satisfies: version !== undefined && satisfiesMinVersion(version, minVersion),
      trusted: false,
      score: 0,
    }
  } catch (error: unknown) {
    return {
      registry,
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      throughput: 0,
      error: error instanceof Error ? error.message : String(error),
      satisfies: false,
      trusted: false,
      score: Number.POSITIVE_INFINITY,
    }
  }
}

/** Lower is better: latency dominates, low throughput adds a penalty. */
export function scoreOf(result: Pick<ProbeResult, 'ok' | 'latencyMs' | 'throughput'>): number {
  if (!result.ok) return Number.POSITIVE_INFINITY
  const throughputPenalty = result.throughput > 0 ? Math.min(2000, 200_000 / result.throughput) : 500
  return result.latencyMs + throughputPenalty
}

export function rank(packageName: string, results: ProbeResult[], now = Date.now(), canonicalRegistry: string = CANONICAL_REGISTRY): RankedRegistries {
  const canonical = results.find(r => r.registry === canonicalRegistry && r.ok && r.integrity !== undefined)
  let referenceIntegrity: string | undefined
  let referenceVersion: string | undefined
  if (canonical !== undefined) {
    referenceIntegrity = canonical.integrity
    referenceVersion = canonical.version
  } else {
    // Majority vote over (version, integrity) pairs from reachable mirrors.
    const votes = new Map<string, { count: number; version?: string; integrity: string }>()
    for (const r of results) {
      if (!r.ok || r.integrity === undefined) continue
      const key = `${r.version ?? ''}|${r.integrity}`
      const entry = votes.get(key) ?? { count: 0, integrity: r.integrity, ...(r.version !== undefined ? { version: r.version } : {}) }
      entry.count += 1
      votes.set(key, entry)
    }
    const best = [...votes.values()].sort((a, b) => b.count - a.count)[0]
    if (best !== undefined && (best.count >= 2 || results.filter(r => r.ok).length === 1)) {
      referenceIntegrity = best.integrity
      referenceVersion = best.version
    }
  }
  const scored = results.map(r => {
    // A mirror that lags behind (older version) is still usable if it satisfies the minimum, but its
    // integrity can only be compared when it serves the same version as the reference.
    const sameVersion = referenceVersion === undefined || r.version === referenceVersion
    const trusted = r.ok && referenceIntegrity !== undefined && sameVersion && r.integrity === referenceIntegrity
    return { ...r, trusted, score: scoreOf(r) }
  })
  scored.sort((a, b) => Number(b.trusted && b.satisfies) - Number(a.trusted && a.satisfies) || a.score - b.score)
  return {
    packageName,
    probedAt: now,
    results: scored,
    ...(referenceIntegrity !== undefined ? { referenceIntegrity } : {}),
    ...(referenceVersion !== undefined ? { referenceVersion } : {}),
  }
}

export class RegistrySelector {
  private readonly cache = new Map<string, RankedRegistries>()

  constructor(
    private readonly options: {
      candidates: () => string[]
      override: () => string | undefined
      ttlMs: number
      timeoutMs: number
      fetcher?: Fetcher
      /** Canonical registry (tests point this at a fake). */
      canonical?: string
    },
  ) {}

  cached(packageName: string): RankedRegistries | undefined {
    const hit = this.cache.get(packageName)
    if (hit === undefined || Date.now() - hit.probedAt > this.options.ttlMs) return undefined
    return hit
  }

  async select(packageName: string, minVersion: string, force = false): Promise<RankedRegistries> {
    if (!force) {
      const hit = this.cached(packageName)
      if (hit !== undefined) return hit
    }
    const override = this.options.override()
    const canonical = normalizeRegistry(this.options.canonical ?? CANONICAL_REGISTRY)
    const candidates = [...new Set([...(override ? [normalizeRegistry(override)] : []), ...this.options.candidates().flatMap(c => {
      try {
        return [normalizeRegistry(c)]
      } catch {
        return [] // http:// mirrors are ignored
      }
    })])]
    if (!candidates.includes(canonical)) candidates.push(canonical) // lockfile source and integrity reference
    const results = await Promise.all(candidates.map(registry => probeRegistry(registry, packageName, minVersion, this.options.timeoutMs, this.options.fetcher)))
    const ranked = rank(packageName, results, Date.now(), canonical)
    if (override) {
      // The user's choice goes first when it is usable and trustworthy.
      const index = ranked.results.findIndex(r => r.registry === normalizeRegistry(override))
      const chosen = ranked.results[index]
      if (index > 0 && chosen !== undefined && chosen.ok && chosen.satisfies && chosen.trusted) {
        ranked.results.splice(index, 1)
        ranked.results.unshift(chosen)
      }
    }
    this.cache.set(packageName, ranked)
    return ranked
  }

  /** Registries to try in order: usable and trusted ones first. */
  static usable(ranked: RankedRegistries): ProbeResult[] {
    return ranked.results.filter(r => r.ok && r.satisfies && r.trusted)
  }
}
