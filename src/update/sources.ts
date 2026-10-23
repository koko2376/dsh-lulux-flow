/**
 * Where update checks ask "what is the latest release?".
 *
 * Official nodes talk to GitHub itself and are authoritative:
 * - `github-api`: `api.github.com/repos/<repo>/releases/latest` (latest
 *   published, non-draft, non-prerelease release; carries the notes; 60
 *   unauthenticated requests per hour per IP).
 * - `github-web`: `github.com/<repo>/releases/latest`, read without following
 *   the redirect: the `Location` names the latest release tag. No API quota.
 *
 * Mirror nodes serve the repository's tagged files through jsDelivr
 * (`<host>/gh/<repo>@latest/package.json`, `latest` = highest semver tag,
 * cached by jsDelivr for up to 7 days). Several jsDelivr hostnames are probed
 * because which one is reachable differs by network in mainland China.
 * A mirror is trusted for one thing only: a version number. Links are always
 * built locally from that version and point at github.com; mirrors never
 * supply notes or urls.
 */
import { timedGet, type Fetcher } from '../kernels/registry-probe.js'
import { isAllowedReleaseUrl, releaseUrlFor, summarizeNotes } from './release.js'
import { cleanVersion, isPrerelease } from './semver.js'

export type NodeKind = 'official' | 'mirror'

export interface UpdateNode {
  /** Stable id, persisted as the cached choice (`github-api`, `jsdelivr:fastly.jsdelivr.net`). */
  id: string
  kind: NodeKind
  url: string
  /** Only GET is ever used; this is the redirect mode for that GET. */
  redirect?: 'follow' | 'manual' | 'error'
  /** Turn the answer into a release, or throw. */
  parse(response: { status: number; headers: Headers; body: string }, context: ParseContext): LatestRelease
}

export interface ParseContext {
  repository: string
  packageName: string
}

export interface LatestRelease {
  /** Normalized semver (no `v`). */
  version: string
  /** Always an allowlisted github.com release url. */
  url: string
  /** Plain-text summary lines; empty when the node cannot provide notes. */
  notes: string[]
  publishedAt?: string
  prerelease: boolean
}

export interface NodeAnswer {
  node: string
  kind: NodeKind
  ok: boolean
  latencyMs: number
  throughput: number
  release?: LatestRelease
  error?: string
  /** Set for HTTP 403/429 from a rate-limited API: when to try again (epoch ms). */
  retryAt?: number
}

/** Mirrors that serve GitHub tags through jsDelivr; https only. */
export const DEFAULT_UPDATE_MIRRORS = ['https://fastly.jsdelivr.net', 'https://gcore.jsdelivr.net', 'https://testingcf.jsdelivr.net', 'https://cdn.jsdelivr.net'] as const

const SMALL_ANSWER_THROUGHPUT = 10_000_000

export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message)
  }
}

function expectStatus(status: number, ok: (s: number) => boolean, headers: Headers): void {
  if (ok(status)) return
  if (status === 429 || (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')))) {
    const retryAfter = Number(headers.get('retry-after'))
    const reset = Number(headers.get('x-ratelimit-reset'))
    const retryAt = Number.isFinite(retryAfter) && retryAfter > 0 ? Date.now() + retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 3600_000
    throw new RateLimitedError(`rate limited (HTTP ${status})`, Math.min(retryAt, Date.now() + 24 * 3600_000))
  }
  throw new Error(`HTTP ${status}`)
}

function json(body: string): Record<string, unknown> {
  const value = JSON.parse(body) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed response')
  return value as Record<string, unknown>
}

export function officialNodes(repository: string, apiBase = 'https://api.github.com', webBase = 'https://github.com'): UpdateNode[] {
  return [
    {
      id: 'github-api',
      kind: 'official',
      url: `${apiBase}/repos/${repository}/releases/latest`,
      parse(response, context) {
        expectStatus(response.status, s => s === 200, response.headers)
        const data = json(response.body)
        if (data.draft === true) throw new Error('latest release is a draft')
        const version = cleanVersion(data.tag_name)
        if (version === undefined) throw new Error('release tag is not a semantic version')
        return {
          version,
          url: isAllowedReleaseUrl(data.html_url, context.repository) ? data.html_url : releaseUrlFor(version, context.repository),
          notes: summarizeNotes(data.body),
          ...(typeof data.published_at === 'string' && !Number.isNaN(Date.parse(data.published_at)) ? { publishedAt: new Date(data.published_at).toISOString() } : {}),
          prerelease: data.prerelease === true || isPrerelease(version),
        }
      },
    },
    {
      id: 'github-web',
      kind: 'official',
      url: `${webBase}/${repository}/releases/latest`,
      redirect: 'manual',
      parse(response, context) {
        expectStatus(response.status, s => s >= 300 && s < 400, response.headers)
        const location = response.headers.get('location') ?? ''
        const match = /\/releases\/tag\/([^/?#]+)\/?$/.exec(location)
        if (match === null) throw new Error('redirect does not name a release')
        let tag: string
        try {
          tag = decodeURIComponent(match[1]!)
        } catch {
          throw new Error('malformed release tag')
        }
        const version = cleanVersion(tag)
        if (version === undefined) throw new Error('release tag is not a semantic version')
        return { version, url: releaseUrlFor(version, context.repository), notes: [], prerelease: isPrerelease(version) }
      },
    },
  ]
}

/** Normalize a mirror base url: https only (http on loopback for tests), no credentials, no trailing slash. */
export function normalizeMirror(value: string): string {
  const url = new URL(value.trim())
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('update mirror must be an https:// URL')
  if (url.username || url.password || url.search || url.hash) throw new Error('update mirror must be a plain base URL')
  return url.toString().replace(/\/+$/, '')
}

export function mirrorNodes(repository: string, bases: readonly string[]): UpdateNode[] {
  const nodes: UpdateNode[] = []
  const seen = new Set<string>()
  for (const raw of bases) {
    let base: string
    try {
      base = normalizeMirror(raw)
    } catch {
      continue
    }
    if (seen.has(base)) continue
    seen.add(base)
    nodes.push({
      id: `jsdelivr:${new URL(base).host}${new URL(base).pathname.replace(/\/$/, '')}`,
      kind: 'mirror',
      url: `${base}/gh/${repository}@latest/package.json`,
      parse(response, context) {
        expectStatus(response.status, s => s === 200, response.headers)
        const data = json(response.body)
        if (data.name !== context.packageName) throw new Error('mirror served a different package')
        const version = cleanVersion(data.version)
        if (version === undefined) throw new Error('mirror version is not a semantic version')
        // Untrusted beyond the version: the link is built here, notes are never taken from a mirror.
        return { version, url: releaseUrlFor(version, context.repository), notes: [], prerelease: isPrerelease(version) }
      },
    })
  }
  return nodes
}

export async function askNode(node: UpdateNode, context: ParseContext & { timeoutMs: number; userAgent: string; fetcher?: Fetcher }): Promise<NodeAnswer> {
  const started = performance.now()
  try {
    const response = await timedGet(node.url, {
      timeoutMs: context.timeoutMs,
      ...(context.fetcher !== undefined ? { fetcher: context.fetcher } : {}),
      ...(node.redirect !== undefined ? { redirect: node.redirect } : {}),
      headers: {
        accept: node.id === 'github-api' ? 'application/vnd.github+json' : 'application/json',
        'user-agent': context.userAgent,
      },
      maxBytes: 512 * 1024,
    })
    const release = node.parse(response, context)
    // These answers are a few KB at most (a redirect has no body): throughput says nothing about them,
    // so they are scored on time to first byte alone (a nominal throughput keeps scoreOf's penalty near zero).
    return { node: node.id, kind: node.kind, ok: true, latencyMs: response.latencyMs, throughput: SMALL_ANSWER_THROUGHPUT, release }
  } catch (error: unknown) {
    return {
      node: node.id,
      kind: node.kind,
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      throughput: 0,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      ...(error instanceof RateLimitedError ? { retryAt: error.retryAt } : {}),
    }
  }
}
