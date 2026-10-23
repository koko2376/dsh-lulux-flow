/**
 * Update check and notice state. Never downloads or installs anything: it
 * finds out whether a newer release exists and remembers what the user said
 * about it (remind later, skip this version).
 *
 * Node choice reuses the kernel-registry probe: candidates are asked in
 * parallel with one small GET under a short timeout and scored by the same
 * `scoreOf` (time to first byte plus a throughput penalty). The fastest
 * usable node is cached and asked alone on later checks; when it fails, all
 * nodes are probed again. Locale/timezone only breaks near-ties. Official
 * answers win over mirror answers whenever both arrive.
 */
import { scoreOf, type Fetcher } from '../kernels/registry-probe.js'
import { readJsonFile, writeJsonAtomic } from '../util/fs.js'
import { isAllowedReleaseUrl, releaseUrlFor, summarizeNotes } from './release.js'
import { cleanVersion, isNewer } from './semver.js'
import { askNode, type LatestRelease, type NodeAnswer, type UpdateNode } from './sources.js'

export type UpdateSourceMode = 'auto' | 'official' | 'mirror'
export const UPDATE_SOURCE_MODES: readonly UpdateSourceMode[] = ['auto', 'official', 'mirror']
export const isUpdateSourceMode = (value: unknown): value is UpdateSourceMode => typeof value === 'string' && (UPDATE_SOURCE_MODES as readonly string[]).includes(value)

export type RegionHint = 'cn' | 'global' | undefined

const CN_ZONES = new Set(['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Urumqi', 'Asia/Kashgar', 'PRC'])

/** Weak hint for near-ties only: the system time zone, then the locale. */
export function regionHint(timeZone: string | undefined = safeTimeZone(), locale: string = process.env.LC_ALL || process.env.LANG || ''): RegionHint {
  if (timeZone !== undefined && CN_ZONES.has(timeZone)) return 'cn'
  if (/^zh[-_]CN\b/i.test(locale) || /^zh[-_]Hans[-_]CN\b/i.test(locale)) return 'cn'
  if (timeZone !== undefined && timeZone !== '' && timeZone !== 'UTC') return 'global'
  return undefined
}

function safeTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/** Usable for the stable channel: answered, parsed, and not a pre-release. */
export const usable = (a: NodeAnswer): a is NodeAnswer & { release: LatestRelease } => a.ok && a.release !== undefined && !a.release.prerelease

/**
 * Fastest usable node. Two answers count as tied when their scores are within
 * 80 ms or 15 %; then the region hint prefers mirrors (`cn`) or official
 * nodes (`global`).
 */
export function chooseNode(answers: readonly NodeAnswer[], hint: RegionHint): NodeAnswer | undefined {
  const candidates = answers.filter(usable).map(a => ({ a, score: scoreOf(a) }))
  candidates.sort((x, y) => x.score - y.score)
  const best = candidates[0]
  if (best === undefined || hint === undefined) return best?.a
  const preferred = hint === 'cn' ? 'mirror' : 'official'
  if (best.a.kind === preferred) return best.a
  const tied = candidates.find(c => c.a.kind === preferred && c.score - best.score <= Math.max(80, best.score * 0.15))
  return (tied ?? best).a
}

/** The release to believe: the GitHub API, then github.com, then the chosen mirror. */
export function pickRelease(answers: readonly NodeAnswer[], chosen: NodeAnswer | undefined): (LatestRelease & { source: string }) | undefined {
  const official = answers.filter(usable).filter(a => a.kind === 'official')
  const from = official.find(a => a.node === 'github-api') ?? official[0] ?? (chosen !== undefined && usable(chosen) ? chosen : undefined)
  return from?.release !== undefined ? { ...from.release, source: from.node } : undefined
}

export interface StoredRelease extends LatestRelease {
  source: string
}

export interface UpdateState {
  lastCheckAt?: number
  lastSuccessAt?: number
  latest?: StoredRelease
  lastError?: string
  skippedVersion?: string
  remind?: { version: string; until: number }
  chosen?: { node: string; at: number }
  /** Per node: do not ask before this time (rate limits). */
  retryAt?: Record<string, number>
}

export interface UpdateStatus {
  current: string
  latest: string | null
  /** A newer stable release exists. */
  updateAvailable: boolean
  /** Show the notice: an update exists, and it is neither skipped nor snoozed. */
  notice: boolean
  url: string
  notes: string[]
  publishedAt: string | null
  /** Node the latest answer came from (`github-api`, `github-web`, `jsdelivr:<host>`). */
  source: string | null
  checkedAt: string | null
  lastError: string | null
  skippedVersion: string | null
  remindUntil: string | null
  checking: boolean
  autoCheck: boolean
  sourceMode: UpdateSourceMode
}

export type CheckOutcome = 'latest' | 'available' | 'failed'

export interface UpdateCheckerOptions {
  currentVersion: string
  repository: string
  packageName: string
  stateFile: string
  /** Every candidate node; the source mode filters them. */
  nodes: () => UpdateNode[]
  mode: () => UpdateSourceMode
  autoCheck: () => boolean
  userAgent: string
  fetcher?: Fetcher
  timeoutMs?: number
  initialDelayMs?: number
  intervalMs?: number
  /** How long the chosen node is reused before everything is probed again. */
  nodeTtlMs?: number
  remindMs?: number
  regionHint?: () => RegionHint
  logger?: { info(m: string): void; debug(m: string): void }
  now?: () => number
}

const DAY = 24 * 3600_000

export class UpdateChecker {
  private state: UpdateState
  private inflight: Promise<{ outcome: CheckOutcome; status: UpdateStatus }> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: UpdateCheckerOptions) {
    this.state = loadState(options.stateFile, options.repository)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  status(): UpdateStatus {
    const s = this.state
    const current = this.options.currentVersion
    const latest = s.latest?.version ?? null
    const updateAvailable = latest !== null && isNewer(latest, current)
    const snoozed = s.remind !== undefined && s.remind.version === latest && this.now() < s.remind.until
    return {
      current,
      latest,
      updateAvailable,
      notice: updateAvailable && s.skippedVersion !== latest && !snoozed,
      url: s.latest?.url ?? releaseUrlFor('', this.options.repository),
      notes: s.latest?.notes ?? [],
      publishedAt: s.latest?.publishedAt ?? null,
      source: s.latest?.source ?? null,
      checkedAt: s.lastCheckAt !== undefined ? new Date(s.lastCheckAt).toISOString() : null,
      lastError: s.lastError ?? null,
      skippedVersion: s.skippedVersion ?? null,
      remindUntil: snoozed && s.remind !== undefined ? new Date(s.remind.until).toISOString() : null,
      checking: this.inflight !== undefined,
      autoCheck: this.options.autoCheck(),
      sourceMode: this.options.mode(),
    }
  }

  /** Skip one version for good (a newer one shows again). */
  skip(version: string): UpdateStatus {
    const clean = cleanVersion(version)
    if (clean === undefined) throw new Error('version must be a semantic version')
    this.state = { ...this.state, skippedVersion: clean }
    this.save()
    return this.status()
  }

  /** Hide the notice for the current latest version for a while (default 24 h). */
  remindLater(): UpdateStatus {
    const latest = this.state.latest?.version
    if (latest !== undefined) {
      this.state = { ...this.state, remind: { version: latest, until: this.now() + (this.options.remindMs ?? DAY) } }
      this.save()
    }
    return this.status()
  }

  /** One check; concurrent callers share it. Never throws. */
  check(options: { manual?: boolean } = {}): Promise<{ outcome: CheckOutcome; status: UpdateStatus }> {
    this.inflight ??= this.run(options.manual === true).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private candidates(): UpdateNode[] {
    const mode = this.options.mode()
    const now = this.now()
    return this.options.nodes().filter(n => (mode === 'auto' || (mode === 'official' ? n.kind === 'official' : n.kind === 'mirror')) && (this.state.retryAt?.[n.id] ?? 0) <= now)
  }

  private ask(node: UpdateNode): Promise<NodeAnswer> {
    return askNode(node, {
      repository: this.options.repository,
      packageName: this.options.packageName,
      timeoutMs: this.options.timeoutMs ?? 4_000,
      userAgent: this.options.userAgent,
      ...(this.options.fetcher !== undefined ? { fetcher: this.options.fetcher } : {}),
    })
  }

  private async run(manual: boolean): Promise<{ outcome: CheckOutcome; status: UpdateStatus }> {
    const now = this.now()
    const nodes = this.candidates()
    const answers: NodeAnswer[] = []
    let release: StoredRelease | undefined
    let chosen: NodeAnswer | undefined
    try {
      const cached = this.state.chosen
      const cachedNode = !manual && cached !== undefined && now - cached.at < (this.options.nodeTtlMs ?? 7 * DAY) ? nodes.find(n => n.id === cached.node) : undefined
      if (cachedNode !== undefined) {
        const answer = await this.ask(cachedNode)
        answers.push(answer)
        if (usable(answer)) {
          chosen = answer
          release = { ...answer.release, source: answer.node }
        } else this.options.logger?.debug(`update: cached node ${cachedNode.id} failed (${answer.error ?? 'pre-release'}); probing all`)
      }
      if (release === undefined) {
        const rest = nodes.filter(n => n.id !== cachedNode?.id)
        const probed = await Promise.all(rest.map(n => this.ask(n)))
        answers.push(...probed)
        chosen = chooseNode(probed, this.options.regionHint?.() ?? regionHint())
        release = pickRelease(probed, chosen)
      }
      // A newer version from a node without notes: one try for the notes from the API (never from a mirror).
      if (release !== undefined && release.source !== 'github-api' && release.notes.length === 0 && isNewer(release.version, this.options.currentVersion) && this.options.mode() !== 'mirror') {
        const api = nodes.find(n => n.id === 'github-api')
        if (api !== undefined && !answers.some(a => a.node === api.id)) {
          const extra = await this.ask(api)
          answers.push(extra)
          if (usable(extra) && extra.release.version === release.version) release = { ...release, notes: extra.release.notes, url: extra.release.url, ...(extra.release.publishedAt !== undefined ? { publishedAt: extra.release.publishedAt } : {}) }
        }
      }
    } catch (error: unknown) {
      this.options.logger?.info(`update check failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    const retryAt = { ...(this.state.retryAt ?? {}) }
    for (const a of answers) {
      if (a.retryAt !== undefined) retryAt[a.node] = a.retryAt
      else if (a.ok) delete retryAt[a.node]
    }
    for (const [node, at] of Object.entries(retryAt)) if (at <= now) delete retryAt[node]

    if (release === undefined) {
      const reason = nodes.length === 0 ? 'no update source is available right now' : summarizeFailures(answers)
      this.options.logger?.info(`update check failed: ${reason}`)
      this.state = { ...this.state, lastCheckAt: now, lastError: reason, retryAt }
      this.save()
      return { outcome: 'failed', status: { ...this.status(), checking: false } }
    }
    this.state = {
      ...this.state,
      lastCheckAt: now,
      lastSuccessAt: now,
      latest: release,
      retryAt,
      ...(chosen !== undefined ? { chosen: { node: chosen.node, at: chosen.node === this.state.chosen?.node ? (this.state.chosen?.at ?? now) : now } } : {}),
    }
    delete this.state.lastError
    this.save()
    const status = { ...this.status(), checking: false }
    this.options.logger?.debug(`update: latest ${release.version} via ${release.source} (current ${this.options.currentVersion})`)
    return { outcome: status.updateAvailable ? 'available' : 'latest', status }
  }

  /** Delayed first check, then one every interval while auto-check is on. Returns a stopper. */
  start(): () => void {
    const interval = this.options.intervalMs ?? DAY
    const initial = this.options.initialDelayMs ?? 90_000
    const schedule = (delay: number): void => {
      this.timer = setTimeout(() => {
        void (async () => {
          if (this.options.autoCheck()) await this.check()
          schedule(interval)
        })()
      }, delay)
      this.timer.unref?.()
    }
    const last = this.state.lastCheckAt
    schedule(last === undefined ? initial : Math.max(initial, Math.min(interval, last + interval - this.now())))
    return () => {
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private save(): void {
    try {
      writeJsonAtomic(this.options.stateFile, this.state)
    } catch (error: unknown) {
      this.options.logger?.info(`update: could not save state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function summarizeFailures(answers: readonly NodeAnswer[]): string {
  if (answers.length === 0) return 'no answer'
  return answers.map(a => `${a.node}: ${a.ok ? (a.release?.prerelease ? 'pre-release ignored' : 'no release') : (a.error ?? 'failed')}`).join('; ').slice(0, 500)
}

/** Read the state file defensively: anything malformed is dropped, links are re-checked. */
export function loadState(file: string, repository: string): UpdateState {
  const raw = readJsonFile<Record<string, unknown>>(file)
  if (raw === undefined || raw === null || typeof raw !== 'object') return {}
  const state: UpdateState = {}
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const lastCheckAt = num(raw.lastCheckAt)
  if (lastCheckAt !== undefined) state.lastCheckAt = lastCheckAt
  const lastSuccessAt = num(raw.lastSuccessAt)
  if (lastSuccessAt !== undefined) state.lastSuccessAt = lastSuccessAt
  if (typeof raw.lastError === 'string') state.lastError = raw.lastError.slice(0, 500)
  const skipped = cleanVersion(raw.skippedVersion)
  if (skipped !== undefined) state.skippedVersion = skipped
  const remind = raw.remind as { version?: unknown; until?: unknown } | undefined
  if (remind !== undefined && remind !== null && typeof remind === 'object') {
    const version = cleanVersion(remind.version)
    const until = num(remind.until)
    if (version !== undefined && until !== undefined) state.remind = { version, until }
  }
  const chosen = raw.chosen as { node?: unknown; at?: unknown } | undefined
  if (chosen !== undefined && chosen !== null && typeof chosen === 'object' && typeof chosen.node === 'string' && num(chosen.at) !== undefined) state.chosen = { node: chosen.node.slice(0, 200), at: num(chosen.at)! }
  if (raw.retryAt !== null && typeof raw.retryAt === 'object') {
    const retryAt: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw.retryAt as Record<string, unknown>)) if (num(v) !== undefined) retryAt[k.slice(0, 200)] = num(v)!
    state.retryAt = retryAt
  }
  const latest = raw.latest as Record<string, unknown> | undefined
  if (latest !== undefined && latest !== null && typeof latest === 'object') {
    const version = cleanVersion(latest.version)
    if (version !== undefined) {
      state.latest = {
        version,
        url: isAllowedReleaseUrl(latest.url, repository) ? latest.url : releaseUrlFor(version, repository),
        notes: Array.isArray(latest.notes) ? summarizeNotes(latest.notes.filter((n): n is string => typeof n === 'string').join('\n')) : [],
        ...(typeof latest.publishedAt === 'string' && !Number.isNaN(Date.parse(latest.publishedAt)) ? { publishedAt: latest.publishedAt } : {}),
        prerelease: latest.prerelease === true,
        source: typeof latest.source === 'string' ? latest.source.slice(0, 200) : 'unknown',
      }
    }
  }
  return state
}
