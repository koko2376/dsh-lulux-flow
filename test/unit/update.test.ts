/** Update check: semver, node choice, link allowlist, notes, persistence and quiet failure handling. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Fetcher } from '../../src/kernels/registry-probe.js'
import { SettingsStore } from '../../src/settings.js'
import { isAllowedReleaseUrl, releaseUrlFor, safeReleaseUrl, summarizeNotes } from '../../src/update/release.js'
import { cleanVersion, compareSemver, isNewer, isPrerelease, parseSemver } from '../../src/update/semver.js'
import { chooseNode, loadState, pickRelease, regionHint, UpdateChecker, type UpdateSourceMode } from '../../src/update/service.js'
import { askNode, DEFAULT_UPDATE_MIRRORS, mirrorNodes, normalizeMirror, officialNodes, type NodeAnswer } from '../../src/update/sources.js'
import { tempDir } from '../helpers.js'

const REPO = 'koko2376/dsh-lulux-flow'
const PKG = 'dsh-lulux-flow'
const API = `https://api.github.com/repos/${REPO}/releases/latest`
const WEB = `https://github.com/${REPO}/releases/latest`
const mirrorUrl = (host: string) => `https://${host}/gh/${REPO}@latest/package.json`

describe('semver', () => {
  it('parses versions and tags, rejects junk', () => {
    expect(parseSemver('v1.2.3-rc.1+build.5')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: ['rc', 1], raw: '1.2.3-rc.1' })
    expect(cleanVersion('v0.1.0')).toBe('0.1.0')
    for (const bad of ['1.2', '01.2.3', '1.2.3-', 'latest', '', 'v', '1.2.3-01', 42, null, `1.2.3-${'a'.repeat(200)}`]) expect(parseSemver(bad), String(bad)).toBeUndefined()
  })

  it('orders by semver precedence, pre-releases included', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0']
    for (let i = 0; i < ordered.length - 1; i += 1) {
      expect(compareSemver(ordered[i]!, ordered[i + 1]!), `${ordered[i]} < ${ordered[i + 1]}`).toBe(-1)
      expect(compareSemver(ordered[i + 1]!, ordered[i]!)).toBe(1)
    }
    expect(compareSemver('1.0.0+a', '1.0.0+b')).toBe(0)
    expect(isNewer('0.1.2', '0.1.1')).toBe(true)
    expect(isNewer('0.1.1', '0.1.1')).toBe(false)
    expect(isNewer('0.1.1', '0.1.2-rc.1')).toBe(false)
    expect(isNewer('0.1.2', '0.1.2-rc.1')).toBe(true)
    expect(isNewer('garbage', '0.1.1')).toBe(false)
    expect(isPrerelease('0.2.0-beta.1')).toBe(true)
    expect(() => compareSemver('x', '1.0.0')).toThrow(/not a semantic version/)
  })
})

describe('release links and notes', () => {
  it('allows only github.com release pages of this repository', () => {
    const ok = [`https://github.com/${REPO}/releases`, `https://github.com/${REPO}/releases/`, `https://github.com/${REPO}/releases/tag/v0.2.0`, `https://github.com/${REPO}/releases/tag/v1.0.0-rc.1`]
    for (const url of ok) expect(isAllowedReleaseUrl(url, REPO), url).toBe(true)
    const bad = [
      `http://github.com/${REPO}/releases/tag/v0.2.0`,
      `https://github.com.evil.example/${REPO}/releases/tag/v0.2.0`,
      `https://evil.example/${REPO}/releases/tag/v0.2.0`,
      `https://raw.githubusercontent.com/${REPO}/releases/tag/v0.2.0`,
      `https://github.com:8443/${REPO}/releases/tag/v0.2.0`,
      `https://user:pw@github.com/${REPO}/releases/tag/v0.2.0`,
      `https://github.com/${REPO}/releases/tag/v0.2.0?x=1`,
      `https://github.com/${REPO}/releases/tag/v0.2.0#x`,
      `https://github.com/someone/else/releases/tag/v0.2.0`,
      `https://github.com/${REPO}/releases/download/v0.2.0/x.tgz`,
      `https://github.com/${REPO}/releases/tag/v0.2.0/../../../../evil`,
      `https://github.com/${REPO}/releases/tag/%3Cscript%3E`,
      `javascript:alert(1)`,
      `data:text/html,hi`,
      '',
      42,
    ]
    for (const url of bad) expect(isAllowedReleaseUrl(url, REPO), String(url)).toBe(false)
    expect(safeReleaseUrl('https://evil.example/', REPO)).toBe(`https://github.com/${REPO}/releases`)
    expect(releaseUrlFor('v0.2.0', REPO)).toBe(`https://github.com/${REPO}/releases/tag/v0.2.0`)
    expect(releaseUrlFor('not-a-version', REPO)).toBe(`https://github.com/${REPO}/releases`)
  })

  it('summarizes release bodies as plain text', () => {
    const body = [
      'First release. Requires DSH `>=0.2.1 <0.3.0` and Node.js `>=22.15.0`.',
      '',
      '### Added',
      '',
      '- **Gateway.** A loopback gateway that speaks',
      '  several wire formats. See [docs](https://example.com/docs).',
      '- Routes `lulux-flow-<kernel>/default` <img src=x onerror=alert(1)>',
      '<script>alert("x")</script>',
      '```js',
      'console.log("code")',
      '```',
      '* [ ] task item ![logo](https://x/y.png) https://bare.example/url',
    ].join('\n')
    expect(summarizeNotes(body)).toEqual([
      'First release. Requires DSH >=0.2.1 <0.3.0 and Node.js >=22.15.0.',
      'Gateway. A loopback gateway that speaks several wire formats. See docs.',
      'Routes lulux-flow-<kernel>/default',
      'task item',
    ])
    expect(summarizeNotes('x'.repeat(500))[0]).toHaveLength(158)
    expect(summarizeNotes(Array.from({ length: 20 }, (_, i) => `- item ${i}`).join('\n'))).toHaveLength(5)
    expect(summarizeNotes(undefined)).toEqual([])
    expect(summarizeNotes('a\u202eb\u0007c')).toEqual(['abc'])
  })
})

const answer = (node: string, kind: 'official' | 'mirror', latencyMs: number, version = '0.2.0', extra: Partial<NodeAnswer> = {}): NodeAnswer => ({
  node,
  kind,
  ok: true,
  latencyMs,
  throughput: 10_000_000,
  release: { version, url: releaseUrlFor(version, REPO), notes: [], prerelease: version.includes('-') },
  ...extra,
})

describe('node selection', () => {
  it('picks the fastest usable node; the region hint only breaks near-ties', () => {
    const answers = [answer('github-api', 'official', 400), answer('jsdelivr:a', 'mirror', 60), answer('jsdelivr:b', 'mirror', 90), { node: 'github-web', kind: 'official' as const, ok: false, latencyMs: 4000, throughput: 0, error: 'timeout after 4000 ms' }]
    expect(chooseNode(answers, undefined)?.node).toBe('jsdelivr:a')
    expect(chooseNode(answers, 'global')?.node).toBe('jsdelivr:a') // official is 340 ms slower: not a tie
    const close = [answer('github-api', 'official', 120), answer('jsdelivr:a', 'mirror', 100)]
    expect(chooseNode(close, 'global')?.node).toBe('github-api')
    expect(chooseNode(close, 'cn')?.node).toBe('jsdelivr:a')
    expect(chooseNode([answer('github-api', 'official', 100), answer('jsdelivr:a', 'mirror', 150)], 'cn')?.node).toBe('jsdelivr:a')
    expect(chooseNode([answer('jsdelivr:pre', 'mirror', 10, '0.3.0-rc.1')], undefined)).toBeUndefined()
  })

  it('believes the GitHub API, then github.com, then the chosen mirror', () => {
    const mirror = answer('jsdelivr:a', 'mirror', 10, '9.9.9')
    expect(pickRelease([mirror, answer('github-web', 'official', 300, '0.2.0'), answer('github-api', 'official', 500, '0.2.0')], mirror)?.source).toBe('github-api')
    expect(pickRelease([mirror, answer('github-web', 'official', 300, '0.2.0')], mirror)?.source).toBe('github-web')
    expect(pickRelease([mirror], mirror)).toMatchObject({ source: 'jsdelivr:a', version: '9.9.9', url: `https://github.com/${REPO}/releases/tag/v9.9.9` })
  })

  it('uses time zone, then locale, as the weak region hint', () => {
    expect(regionHint('Asia/Shanghai', '')).toBe('cn')
    expect(regionHint('Asia/Hong_Kong', '')).toBe('global')
    expect(regionHint('UTC', 'zh_CN.UTF-8')).toBe('cn')
    expect(regionHint('UTC', 'en_US.UTF-8')).toBeUndefined()
    expect(regionHint('Europe/Berlin', 'en_US')).toBe('global')
  })
})

/** Scripted fetcher keyed by url; records every request. */
function fakeNet(routes: Record<string, () => Response | Promise<Response>>) {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; redirect?: string }> = []
  const fetcher: Fetcher = async (url, init) => {
    requests.push({ url, method: 'GET', headers: init.headers, ...(init.redirect !== undefined ? { redirect: init.redirect } : {}) })
    const route = routes[url]
    if (route === undefined) throw new TypeError('fetch failed')
    return route()
  }
  return { fetcher, requests }
}

const apiRelease = (tag: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, body: '- Faster\n- <b>Safer</b>', draft: false, prerelease: false, published_at: '2026-10-30T00:00:00Z', ...extra }), { status: 200 })
const redirectTo = (tag: string) => new Response(null, { status: 302, headers: { location: `https://github.com/${REPO}/releases/tag/${tag}` } })
const pkg = (version: string, name = PKG) => new Response(JSON.stringify({ name, version }), { status: 200 })
const ctx = (fetcher: Fetcher) => ({ repository: REPO, packageName: PKG, timeoutMs: 1000, userAgent: 'dsh-lulux-flow/0.1.1', fetcher })

describe('update sources', () => {
  const [api, web] = officialNodes(REPO)
  const [mirror] = mirrorNodes(REPO, ['https://fastly.jsdelivr.net'])

  it('reads the API, the github.com redirect and a jsDelivr package.json', async () => {
    const net = fakeNet({ [API]: () => apiRelease('v0.2.0'), [WEB]: () => redirectTo('v0.2.0'), [mirrorUrl('fastly.jsdelivr.net')]: () => pkg('0.2.0') })
    expect((await askNode(api!, ctx(net.fetcher))).release).toEqual({ version: '0.2.0', url: `https://github.com/${REPO}/releases/tag/v0.2.0`, notes: ['Faster', 'Safer'], publishedAt: '2026-10-30T00:00:00.000Z', prerelease: false })
    expect((await askNode(web!, ctx(net.fetcher))).release).toMatchObject({ version: '0.2.0', notes: [] })
    expect((await askNode(mirror!, ctx(net.fetcher))).release).toMatchObject({ version: '0.2.0', url: `https://github.com/${REPO}/releases/tag/v0.2.0`, notes: [] })
    expect(net.requests.find(r => r.url === WEB)?.redirect).toBe('manual')
    for (const r of net.requests) {
      expect(r.method).toBe('GET')
      expect(Object.keys(r.headers).sort()).toEqual(['accept', 'user-agent'])
      expect(r.headers['user-agent']).toBe('dsh-lulux-flow/0.1.1')
    }
  })

  it('reports rate limits, malformed answers and untrusted fields as failures', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600
    const cases: Array<[typeof api, () => Response, RegExp]> = [
      [api, () => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }), /rate limited \(HTTP 403\)/],
      [api, () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }), /rate limited \(HTTP 429\)/],
      [api, () => new Response('not json', { status: 200 }), /JSON|Unexpected/],
      [api, () => new Response('[1,2]', { status: 200 }), /malformed/],
      [api, () => apiRelease('nightly'), /not a semantic version/],
      [api, () => apiRelease('v0.2.0', { draft: true }), /draft/],
      [api, () => new Response('{}', { status: 404 }), /HTTP 404/],
      [web, () => new Response(null, { status: 302, headers: { location: 'https://github.com/login' } }), /does not name a release/],
      [web, () => new Response('ok', { status: 200 }), /HTTP 200/],
      [mirror, () => pkg('0.2.0', 'evil-package'), /different package/],
      [mirror, () => pkg('latest'), /not a semantic version/],
    ]
    for (const [node, respond, error] of cases) {
      const res = await askNode(node!, ctx(fakeNet({ [node!.url]: respond }).fetcher))
      expect(res.ok, node!.id).toBe(false)
      expect(res.error).toMatch(error)
    }
    const limited = await askNode(api!, ctx(fakeNet({ [API]: cases[0]![1] }).fetcher))
    expect(limited.retryAt).toBe(reset * 1000)
    const offline = await askNode(api!, ctx(fakeNet({}).fetcher))
    expect(offline).toMatchObject({ ok: false, error: 'fetch failed' })
  })

  it('never takes a link from the API that is not a release page of this repository', async () => {
    const res = await askNode(api!, ctx(fakeNet({ [API]: () => apiRelease('v0.2.0', { html_url: 'https://evil.example/x' }) }).fetcher))
    expect(res.release?.url).toBe(`https://github.com/${REPO}/releases/tag/v0.2.0`)
  })

  it('times out quietly', async () => {
    const slow: Fetcher = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const res = await askNode(api!, { ...ctx(slow), timeoutMs: 50 })
    expect(res).toMatchObject({ ok: false, error: 'timeout after 50 ms' })
  })

  it('accepts only https mirrors (http on loopback for tests)', () => {
    expect(normalizeMirror('https://fastly.jsdelivr.net/')).toBe('https://fastly.jsdelivr.net')
    expect(() => normalizeMirror('http://mirror.example')).toThrow(/https/)
    expect(() => normalizeMirror('https://u:p@mirror.example')).toThrow(/plain/)
    expect(normalizeMirror('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(mirrorNodes(REPO, ['http://evil.example', 'https://a.example', 'https://a.example/']).map(n => n.id)).toEqual(['jsdelivr:a.example'])
    expect(mirrorNodes(REPO, DEFAULT_UPDATE_MIRRORS).map(n => n.url)).toContain(`https://gcore.jsdelivr.net/gh/${REPO}@latest/package.json`)
  })
})

describe('UpdateChecker', () => {
  afterEach(() => vi.useRealTimers())
  const nodes = () => [...officialNodes(REPO), ...mirrorNodes(REPO, ['https://fastly.jsdelivr.net', 'https://gcore.jsdelivr.net'])]
  const make = (fetcher: Fetcher, options: { dir?: string; mode?: UpdateSourceMode; current?: string; autoCheck?: () => boolean; now?: () => number; hint?: 'cn' | 'global' } = {}) => {
    const dir = options.dir ?? tempDir('lf-update-')
    const logs: string[] = []
    const checker = new UpdateChecker({
      currentVersion: options.current ?? '0.1.1',
      repository: REPO,
      packageName: PKG,
      stateFile: join(dir, 'update-state.json'),
      nodes,
      mode: () => options.mode ?? 'auto',
      autoCheck: options.autoCheck ?? (() => true),
      userAgent: 'dsh-lulux-flow/0.1.1',
      fetcher,
      timeoutMs: 200,
      regionHint: () => options.hint,
      logger: { info: m => logs.push(m), debug: m => logs.push(m) },
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
    return { checker, dir, logs }
  }
  const delayed = (ms: number, make: () => Response) => () => new Promise<Response>(r => setTimeout(() => r(make()), ms))

  it('finds a newer release, prefers official data and caches the fastest node', async () => {
    const net = fakeNet({
      [API]: delayed(60, () => apiRelease('v0.2.0')),
      [WEB]: delayed(40, () => redirectTo('v0.2.0')),
      [mirrorUrl('fastly.jsdelivr.net')]: () => pkg('0.2.0'),
      [mirrorUrl('gcore.jsdelivr.net')]: delayed(30, () => pkg('0.2.0')),
    })
    const { checker } = make(net.fetcher)
    const first = await checker.check()
    expect(first.outcome).toBe('available')
    expect(first.status).toMatchObject({ current: '0.1.1', latest: '0.2.0', notice: true, source: 'github-api', notes: ['Faster', 'Safer'], checking: false })
    expect(net.requests).toHaveLength(4)
    // Second check asks only the cached (fastest) node.
    net.requests.length = 0
    const second = await checker.check()
    expect(second.outcome).toBe('available')
    expect(net.requests.map(r => r.url)).toEqual([mirrorUrl('fastly.jsdelivr.net'), API]) // mirror version, then notes from the API
    expect(second.status.source).toBe('jsdelivr:fastly.jsdelivr.net')
    expect(second.status.notes).toEqual(['Faster', 'Safer'])
  })

  it('re-probes when the cached node fails, and a manual check always re-probes', async () => {
    let mirrorUp = true
    const net = fakeNet({
      [API]: delayed(50, () => apiRelease('v0.1.1')),
      [WEB]: delayed(50, () => redirectTo('v0.1.1')),
      [mirrorUrl('fastly.jsdelivr.net')]: () => (mirrorUp ? pkg('0.1.1') : new Response('bad gateway', { status: 502 })),
    })
    const { checker } = make(net.fetcher)
    expect((await checker.check()).outcome).toBe('latest')
    mirrorUp = false
    net.requests.length = 0
    expect((await checker.check()).outcome).toBe('latest')
    expect(net.requests[0]!.url).toBe(mirrorUrl('fastly.jsdelivr.net'))
    expect(net.requests.length).toBeGreaterThan(2)
    net.requests.length = 0
    await checker.check({ manual: true })
    expect(net.requests.length).toBe(4)
  })

  it('filters nodes by the source mode', async () => {
    const routes = { [API]: () => apiRelease('v0.2.0'), [WEB]: () => redirectTo('v0.2.0'), [mirrorUrl('fastly.jsdelivr.net')]: () => pkg('0.2.0'), [mirrorUrl('gcore.jsdelivr.net')]: () => pkg('0.2.0') }
    const official = fakeNet(routes)
    await make(official.fetcher, { mode: 'official' }).checker.check()
    expect(official.requests.every(r => r.url.startsWith('https://api.github.com/') || r.url.startsWith('https://github.com/'))).toBe(true)
    const mirror = fakeNet(routes)
    const res = await make(mirror.fetcher, { mode: 'mirror' }).checker.check()
    expect(mirror.requests.every(r => r.url.includes('jsdelivr.net'))).toBe(true)
    expect(res.status.notes).toEqual([]) // mirrors never supply notes, and mirror mode does not reach for GitHub
    expect(res.status.url).toBe(`https://github.com/${REPO}/releases/tag/v0.2.0`)
  })

  it('ignores pre-releases on the stable channel', async () => {
    const net = fakeNet({ [mirrorUrl('fastly.jsdelivr.net')]: () => pkg('0.3.0-rc.1'), [mirrorUrl('gcore.jsdelivr.net')]: () => pkg('0.2.0') })
    const res = await make(net.fetcher, { mode: 'mirror' }).checker.check()
    expect(res.status.latest).toBe('0.2.0')
  })

  it('fails quietly offline, keeps the last good answer and logs instead of throwing', async () => {
    let online = true
    const routes = { [API]: () => apiRelease('v0.2.0') }
    const fetcher: Fetcher = async (url, init) => {
      if (!online) throw new TypeError('fetch failed')
      return fakeNet(routes).fetcher(url, init)
    }
    const { checker, logs } = make(fetcher)
    expect((await checker.check()).status.latest).toBe('0.2.0')
    online = false
    const res = await checker.check({ manual: true })
    expect(res.outcome).toBe('failed')
    expect(res.status.latest).toBe('0.2.0')
    expect(res.status.notice).toBe(true)
    expect(res.status.lastError).toMatch(/fetch failed/)
    expect(logs.some(l => l.startsWith('update check failed'))).toBe(true)
  })

  it('backs off a rate-limited API until its reset time', async () => {
    let now = Date.now()
    const net = fakeNet({
      [API]: () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 3600) } }),
      [WEB]: () => redirectTo('v0.2.0'),
    })
    const { checker } = make(net.fetcher, { mode: 'official', now: () => now })
    expect((await checker.check({ manual: true })).status.source).toBe('github-web')
    net.requests.length = 0
    await checker.check({ manual: true })
    expect(net.requests.map(r => r.url)).toEqual([WEB])
    now += 3601_000
    net.requests.length = 0
    await checker.check({ manual: true })
    expect(net.requests.map(r => r.url).sort()).toEqual([API, WEB].sort())
  })

  it('persists skip and remind-later across restarts; a newer version shows again', async () => {
    let now = Date.parse('2026-10-30T00:00:00Z')
    let latest = 'v0.2.0'
    const net = fakeNet({ [API]: () => apiRelease(latest) })
    const first = make(net.fetcher, { mode: 'official', now: () => now })
    await first.checker.check()
    expect(first.checker.remindLater().notice).toBe(false)
    const restarted = make(net.fetcher, { dir: first.dir, mode: 'official', now: () => now })
    expect(restarted.checker.status()).toMatchObject({ latest: '0.2.0', notice: false })
    now += 24 * 3600_000 + 1
    expect(restarted.checker.status().notice).toBe(true)
    expect(restarted.checker.skip('v0.2.0')).toMatchObject({ notice: false, skippedVersion: '0.2.0' })
    const again = make(net.fetcher, { dir: first.dir, mode: 'official', now: () => now })
    expect(again.checker.status()).toMatchObject({ notice: false, skippedVersion: '0.2.0' })
    latest = 'v0.2.1'
    expect((await again.checker.check()).status).toMatchObject({ latest: '0.2.1', notice: true })
    expect(() => again.checker.skip('banana')).toThrow(/semantic version/)
  })

  it('drops malformed or tampered state', () => {
    const dir = tempDir('lf-update-state-')
    const file = join(dir, 'update-state.json')
    new SettingsStore(dir) // the data dir exists like in the plugin
    const write = (value: unknown) => writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
    write('{not json')
    expect(loadState(file, REPO)).toEqual({})
    write({ latest: { version: '0.2.0', url: 'https://evil.example/', notes: ['<b>x</b>', 5] }, skippedVersion: 'nope', remind: { version: '0.2.0', until: 'soon' } })
    expect(loadState(file, REPO)).toEqual({ latest: { version: '0.2.0', url: `https://github.com/${REPO}/releases/tag/v0.2.0`, notes: ['x'], prerelease: false, source: 'unknown' } })
  })

  it('checks after the startup delay and then every interval, only while auto-check is on', async () => {
    vi.useFakeTimers()
    let auto = true
    const net = fakeNet({ [API]: () => apiRelease('v0.2.0') })
    const checker = new UpdateChecker({
      currentVersion: '0.1.1',
      repository: REPO,
      packageName: PKG,
      stateFile: join(tempDir('lf-update-timer-'), 'update-state.json'),
      nodes: () => officialNodes(REPO).slice(0, 1),
      mode: () => 'auto',
      autoCheck: () => auto,
      userAgent: 'ua',
      fetcher: net.fetcher,
      initialDelayMs: 1000,
      intervalMs: 10_000,
    })
    const stop = checker.start()
    await vi.advanceTimersByTimeAsync(999)
    expect(net.requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(net.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(net.requests).toHaveLength(2)
    auto = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(net.requests).toHaveLength(2)
    stop()
  })

  it('shares one check between concurrent callers', async () => {
    const net = fakeNet({ [API]: delayed(20, () => apiRelease('v0.2.0')) })
    const { checker } = make(net.fetcher, { mode: 'official' })
    await Promise.all([checker.check(), checker.check(), checker.check()])
    expect(net.requests.filter(r => r.url === API)).toHaveLength(1)
  })
})

describe('update settings', () => {
  it('stores auto-check and source overrides; null follows the plugin Config', () => {
    const dir = tempDir('lf-update-settings-')
    const settings = new SettingsStore(dir)
    expect(settings.get()).toMatchObject({ updateAutoCheck: null, updateSource: null })
    settings.update({ updateAutoCheck: false, updateSource: 'mirror' })
    expect(new SettingsStore(dir).get()).toMatchObject({ updateAutoCheck: false, updateSource: 'mirror' })
    settings.update({ updateAutoCheck: null, updateSource: null })
    expect(settings.get()).toMatchObject({ updateAutoCheck: null, updateSource: null })
    expect(() => settings.update({ updateSource: 'ftp' })).toThrow(/auto, official or mirror/)
    expect(() => settings.update({ updateAutoCheck: 'yes' })).toThrow(/true, false or null/)
  })
})
