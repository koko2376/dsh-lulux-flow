/**
 * Semantic Versioning 2.0.0 parsing and precedence, enough for release
 * checks: `1.2.3`, `v1.2.3`, `1.2.3-rc.1`, `1.2.3+build` (build metadata is
 * ignored for precedence, as the spec says).
 */
export interface SemVer {
  major: number
  minor: number
  patch: number
  prerelease: Array<string | number>
  raw: string
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** Parse a version or tag (`v` prefix allowed); undefined when it is not valid semver. */
export function parseSemver(input: unknown): SemVer | undefined {
  if (typeof input !== 'string' || input.length > 128) return undefined
  const match = SEMVER.exec(input.trim())
  if (match === null) return undefined
  const nums = [match[1], match[2], match[3]].map(Number)
  if (nums.some(n => !Number.isSafeInteger(n))) return undefined
  return {
    major: nums[0]!,
    minor: nums[1]!,
    patch: nums[2]!,
    prerelease: match[4] === undefined ? [] : match[4].split('.').map(id => (/^\d+$/.test(id) ? Number(id) : id)),
    raw: `${nums[0]}.${nums[1]}.${nums[2]}${match[4] !== undefined ? `-${match[4]}` : ''}`,
  }
}

/** Normalized version string (no `v`, no build metadata), or undefined. */
export function cleanVersion(input: unknown): string | undefined {
  return parseSemver(input)?.raw
}

export function isPrerelease(input: unknown): boolean {
  return (parseSemver(input)?.prerelease.length ?? 0) > 0
}

/** -1 / 0 / 1 by semver precedence. Throws on invalid input. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (x === undefined || y === undefined) throw new Error(`not a semantic version: ${x === undefined ? a : b}`)
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1
  }
  // A version without a pre-release has higher precedence than one with.
  if (x.prerelease.length === 0 || y.prerelease.length === 0) return x.prerelease.length === y.prerelease.length ? 0 : x.prerelease.length === 0 ? 1 : -1
  const len = Math.max(x.prerelease.length, y.prerelease.length)
  for (let i = 0; i < len; i += 1) {
    const p = x.prerelease[i]
    const q = y.prerelease[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    // Numeric identifiers sort before alphanumeric ones.
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1
    if (typeof p === 'number') return -1
    if (typeof q === 'number') return 1
    return p < q ? -1 : 1
  }
  return 0
}

/** True when `candidate` is a valid version strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  if (parseSemver(candidate) === undefined || parseSemver(current) === undefined) return false
  return compareSemver(candidate, current) > 0
}
