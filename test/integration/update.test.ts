/**
 * Update check against fake GitHub / jsDelivr servers on loopback, through
 * real `fetch` and the plugin HTTP API: node choice by speed, official data
 * preferred, rate limits and outages handled quietly, only GET requests with
 * nothing but a User-Agent, and the notice state (skip / remind) persisted.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApi } from '../../src/http/api.js'
import type { LuluxFlowRuntime } from '../../src/runtime.js'
import { SettingsStore } from '../../src/settings.js'
import { UpdateChecker, type UpdateSourceMode, type UpdateStatus } from '../../src/update/service.js'
import { mirrorNodes, officialNodes } from '../../src/update/sources.js'
import { tempDir } from '../helpers.js'

const REPO = 'koko2376/dsh-lulux-flow'

interface Seen {
  server: string
  method: string
  url: string
  headers: IncomingMessage['headers']
}

type Behaviour = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const seen: Seen[] = []
const behaviours: Record<string, Behaviour> = {}

async function fakeServer(name: string): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    seen.push({ server: name, method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    void behaviours[name]!(req, res)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const release = (tag: string) => ({ tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, body: '## Added\n- Update notice\n- <script>alert(1)</script>Safer links', draft: false, prerelease: false, published_at: '2026-10-30T00:00:00Z' })

describe('update check against fake servers', () => {
  const servers: Server[] = []
  let apiBase = ''
  let webBase = ''
  let mirrorBase = ''
  let deadBase = ''
  let mode: UpdateSourceMode = 'auto'
  const dir = tempDir('lf-update-int-')
  let checker: UpdateChecker

  beforeAll(async () => {
    for (const name of ['api', 'web', 'mirror', 'dead']) {
      const { server, base } = await fakeServer(name)
      servers.push(server)
      if (name === 'api') apiBase = base
      if (name === 'web') webBase = base
      if (name === 'mirror') mirrorBase = base
      if (name === 'dead') deadBase = base
    }
    // A closed port: connection refused.
    await new Promise<void>(r => servers.pop()!.close(() => r()))
    checker = new UpdateChecker({
      currentVersion: '0.1.1',
      repository: REPO,
      packageName: 'dsh-lulux-flow',
      stateFile: join(dir, 'update-state.json'),
      nodes: () => [...officialNodes(REPO, apiBase, webBase), ...mirrorNodes(REPO, [mirrorBase, deadBase])],
      mode: () => mode,
      autoCheck: () => true,
      userAgent: 'dsh-lulux-flow/0.1.1',
      timeoutMs: 800,
      regionHint: () => undefined,
    })
  })
  afterAll(() => {
    for (const s of servers) s.close()
  })

  it('asks every node once in parallel, believes GitHub and caches the fastest node', async () => {
    behaviours.api = async (_req, res) => {
      await sleep(150)
      json(res, 200, release('v0.2.0'))
    }
    behaviours.web = async (_req, res) => {
      await sleep(100)
      res.writeHead(302, { location: `https://github.com/${REPO}/releases/tag/v0.2.0` })
      res.end()
    }
    behaviours.mirror = (_req, res) => json(res, 200, { name: 'dsh-lulux-flow', version: '0.2.0' })
    seen.length = 0
    const { outcome, status } = await checker.check({ manual: true })
    expect(outcome).toBe('available')
    expect(status).toMatchObject({ latest: '0.2.0', notice: true, source: 'github-api', url: `https://github.com/${REPO}/releases/tag/v0.2.0`, notes: ['Update notice', 'Safer links'] })
    expect(seen.map(s => s.server).sort()).toEqual(['api', 'mirror', 'web'])
    expect(seen.find(s => s.server === 'api')?.url).toBe(`/repos/${REPO}/releases/latest`)
    expect(seen.find(s => s.server === 'web')?.url).toBe(`/${REPO}/releases/latest`)
    expect(seen.find(s => s.server === 'mirror')?.url).toBe(`/gh/${REPO}@latest/package.json`)
    // Only GET, no cookies, no auth, no query string; the User-Agent carries the plugin version and nothing else identifies the user.
    for (const s of seen) {
      expect(s.method).toBe('GET')
      expect(s.url).not.toContain('?')
      expect(s.headers['user-agent']).toBe('dsh-lulux-flow/0.1.1')
      expect(s.headers.cookie).toBeUndefined()
      expect(s.headers.authorization).toBeUndefined()
    }
    // Next scheduled check goes to the fastest node only (the mirror), then fetches notes from the API.
    seen.length = 0
    await checker.check()
    expect(seen.map(s => s.server)).toEqual(['mirror', 'api'])
  })

  it('keeps working when the API is rate limited and a mirror serves garbage', async () => {
    behaviours.api = (_req, res) => json(res, 429, { message: 'slow down' }, { 'retry-after': '60' })
    behaviours.mirror = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>captive portal</html>')
    }
    behaviours.web = (_req, res) => {
      res.writeHead(302, { location: `https://github.com/${REPO}/releases/tag/v0.2.1` })
      res.end()
    }
    const { outcome, status } = await checker.check({ manual: true })
    expect(outcome).toBe('available')
    expect(status).toMatchObject({ latest: '0.2.1', source: 'github-web', notes: [], url: `https://github.com/${REPO}/releases/tag/v0.2.1` })
    // The API is left alone until its retry-after passes.
    seen.length = 0
    await checker.check({ manual: true })
    expect(seen.some(s => s.server === 'api')).toBe(false)
  })

  it('mirror mode never reaches GitHub; offline fails quietly', async () => {
    mode = 'mirror'
    behaviours.mirror = (_req, res) => json(res, 200, { name: 'dsh-lulux-flow', version: '0.2.1' })
    seen.length = 0
    const ok = await checker.check({ manual: true })
    expect(ok.outcome).toBe('available')
    expect(seen.every(s => s.server === 'mirror')).toBe(true)
    behaviours.mirror = (req, res) => {
      req.socket.destroy()
      res.end()
    }
    const down = await checker.check({ manual: true })
    expect(down.outcome).toBe('failed')
    expect(down.status.latest).toBe('0.2.1')
    expect(down.status.lastError).toMatch(/jsdelivr:127\.0\.0\.1/)
    mode = 'auto'
  })

  describe('through the plugin HTTP API', () => {
    let server: Server
    let base = ''
    beforeAll(async () => {
      behaviours.api = (_req, res) => json(res, 200, release('v0.3.0'))
      behaviours.web = (_req, res) => {
        res.writeHead(302, { location: `https://github.com/${REPO}/releases/tag/v0.3.0` })
        res.end()
      }
      behaviours.mirror = (_req, res) => json(res, 200, { name: 'dsh-lulux-flow', version: '0.3.0' })
      const runtime = { settings: new SettingsStore(dir), updates: checker, store: { root: dir }, engine: { onEvent: () => () => undefined }, logger: { info: () => undefined, warn: () => undefined } } as unknown as LuluxFlowRuntime
      const handler = createApi({ runtime, authorize: () => undefined, maxBodyBytes: 64 * 1024, version: '0.1.1' })
      server = createServer((req, res) => void handler(req, res))
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-lulux-flow/api`
    })
    afterAll(() => server.close())
    const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-lulux-flow-request': '1' } })

    it('exposes status, manual check, remind later and skip', async () => {
      const before = (await (await fetch(`${base}/update`)).json()) as { update: UpdateStatus }
      expect(before.update.current).toBe('0.1.1')
      expect((await fetch(`${base}/update/check`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(403) // CSRF header required
      const checked = (await (await post('/update/check')).json()) as { outcome: string; update: UpdateStatus }
      expect(checked).toMatchObject({ outcome: 'available', update: { latest: '0.3.0', notice: true } })
      const reminded = (await (await post('/update/remind')).json()) as { update: UpdateStatus }
      expect(reminded.update.notice).toBe(false)
      expect(reminded.update.remindUntil).not.toBeNull()
      expect((await post('/update/skip', { version: 'nope' })).status).toBe(400)
      const skipped = (await (await post('/update/skip', { version: '0.3.0' })).json()) as { update: UpdateStatus }
      expect(skipped.update).toMatchObject({ notice: false, skippedVersion: '0.3.0' })
      const after = (await (await fetch(`${base}/update`)).json()) as { update: UpdateStatus }
      expect(after.update).toMatchObject({ latest: '0.3.0', notice: false, skippedVersion: '0.3.0' })
    })
  })
})
