import { chmodSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KernelGateway } from '../../src/gateway/server.js'
import { TokenStore } from '../../src/gateway/tokens.js'
import { createApi } from '../../src/http/api.js'
import { KernelInstaller } from '../../src/kernels/installer.js'
import { RegistrySelector } from '../../src/kernels/registry-probe.js'
import { KernelRunner } from '../../src/kernels/runner.js'
import { KERNEL_TEST_PROMPT, KernelService } from '../../src/kernels/service.js'
import type { LuluxFlowRuntime } from '../../src/runtime.js'
import { SCRIPT_NODES_WARNING, SettingsStore } from '../../src/settings.js'
import { WorkflowEngine } from '../../src/workflow/engine.js'
import { WorkflowStore } from '../../src/workflow/store.js'
import { FakeUpstream, TARGET, tempDir, textReply } from '../helpers.js'

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs')

describe('kernel connection test + runtime script setting (HTTP)', () => {
  const dir = tempDir()
  const upstream = new FakeUpstream(() => textReply('OK'))
  const tokens = new TokenStore()
  const gateway = new KernelGateway({ upstream, tokens, logger: { info: () => undefined, warn: () => undefined }, maxBodyBytes: 1 << 20, requestTimeoutMs: 5000 })
  const store = new WorkflowStore(dir)
  const settings = new SettingsStore(dir)
  const selector = new RegistrySelector({ candidates: () => [], override: () => undefined, ttlMs: 1000, timeoutMs: 100, fetcher: async () => new Response('{}') })
  const installer = new KernelInstaller({ installRoot: join(dir, 'k'), selector, timeoutMs: 1000 })
  chmodSync(FAKE, 0o755)
  const runner = new KernelRunner({
    tokens,
    gatewayUrl: () => gateway.baseUrl,
    runsRoot: join(dir, 'tmp'),
    installRoot: join(dir, 'k'),
    approvalBridge: false,
    graceMs: 200,
    // Only Claude Code is "installed" (the fake CLI); everything else is missing.
    resolve: kernel => (kernel.id === 'claude-code' ? { command: process.execPath, prefixArgs: [FAKE], source: 'settings', file: FAKE } : undefined),
  })
  const kernels = new KernelService(runner, installer, settings, { provider: id => `lulux-flow-${id}`, chatRoute: id => `lulux-flow-${id}` })
  let configScripts = false
  const engine = new WorkflowEngine({ store, executors: {}, scriptsAllowed: () => configScripts })
  const warnings: string[] = []
  let upstreamFails = false
  const runtime: LuluxFlowRuntime = {
    store,
    engine,
    kernels,
    settings,
    gateway,
    selector,
    get scriptsAllowed() {
      return engine.scriptsAllowed()
    },
    get scriptsForcedByConfig() {
      return configScripts
    },
    testCwd: dir,
    upstreamTarget: () => {
      if (upstreamFails) throw new Error('no real model is configured')
      return TARGET
    },
    upstreamInfo: () => ({ target: TARGET, source: 'dsh-default' }),
    generate: async () => {
      throw new Error('not used')
    },
    startRun: (id, inputs, trigger) => engine.start(store.getWorkflow(id)!, inputs, trigger),
    logger: { info: () => undefined, warn: m => warnings.push(m) },
  }
  const handler = createApi({ runtime, authorize: () => undefined, maxBodyBytes: 64 * 1024, version: 'test' })
  let server: Server
  let base = ''
  beforeAll(async () => {
    await gateway.start()
    server = createServer((req, res) => void handler(req, res))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-lulux-flow/api`
  })
  afterAll(async () => {
    server.close()
    await gateway.stop()
  })
  const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-lulux-flow-request': '1' } })

  it('POST /kernels/:id/test does a real minimal scoped run through the gateway', async () => {
    const before = upstream.requests.length
    const res = await api('/kernels/claude-code/test', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; latencyMs: number; output?: string; error?: string }
    expect(body.ok).toBe(true)
    expect(body.output).toBe('OK')
    expect(body.latencyMs).toBeGreaterThanOrEqual(0)
    expect(body.error).toBeUndefined()
    expect(upstream.requests.length).toBe(before + 1)
    expect(JSON.stringify(upstream.requests.at(-1)!.request.turns)).toContain('connectivity test')
    expect(KERNEL_TEST_PROMPT.length).toBeLessThan(120)
    // the run-scoped token is revoked after the run
    expect(tokens.size).toBe(0)
  })

  it('reports a missing CLI, a missing upstream model and an unknown kernel', async () => {
    const missing = (await (await api('/kernels/codex/test', { method: 'POST', body: '{}' })).json()) as { ok: boolean; error?: string; output?: string }
    expect(missing.ok).toBe(false)
    expect(missing.error).toMatch(/not installed/)
    expect(missing.output).toBeUndefined()

    upstreamFails = true
    const noModel = (await (await api('/kernels/claude-code/test', { method: 'POST', body: '{}' })).json()) as { ok: boolean; error?: string }
    upstreamFails = false
    expect(noModel).toMatchObject({ ok: false, error: 'no real model is configured' })

    expect((await api('/kernels/nope/test', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(`${base}/kernels/claude-code/test`, { method: 'POST', body: '{}' })).status).toBe(403)
  })

  it('ships with only Claude Code and Codex enabled, permission "ask"', async () => {
    const list = (await (await api('/kernels')).json()) as { kernels: Array<{ id: string; settings: { enabled: boolean; permission: string; mode: string } }> }
    const byId = Object.fromEntries(list.kernels.map(k => [k.id, k.settings]))
    expect(byId['claude-code']).toMatchObject({ enabled: true, permission: 'ask', mode: 'scoped' })
    expect(byId.codex).toMatchObject({ enabled: true, permission: 'ask' })
    for (const id of ['gemini-cli', 'qwen-code', 'grok']) expect(byId[id]).toMatchObject({ enabled: false, permission: 'ask' })
  })

  it('script nodes cannot be switched on from the browser (plugin config only)', async () => {
    const meta0 = (await (await api('/meta')).json()) as { scriptsAllowed: boolean; scriptsSource: string | null }
    expect(meta0).toMatchObject({ scriptsAllowed: false, scriptsSource: null })
    expect(((await (await api('/settings')).json()) as { settings: { allowScriptNodes: boolean } }).settings.allowScriptNodes).toBe(false)

    const on = await api('/settings', { method: 'PUT', body: JSON.stringify({ allowScriptNodes: true }) })
    expect(on.status).toBe(403)
    expect(((await on.json()) as { code: string }).code).toBe('config_only')
    expect(new SettingsStore(dir).get().allowScriptNodes).toBe(false)
    const meta1 = (await (await api('/meta')).json()) as { scriptsAllowed: boolean }
    expect(meta1.scriptsAllowed).toBe(false)

    const wf = { id: 'w', name: 'w', nodes: [{ id: 's', type: 'script', name: 's', position: { x: 0, y: 0 }, config: { code: 'return 1' } }], edges: [], createdAt: '', updatedAt: '' }
    expect(engine.lint(wf as never).some(i => /script nodes are disabled/.test(i.message))).toBe(true)
    expect((await api('/settings', { method: 'PUT', body: JSON.stringify({ allowScriptNodes: 'yes' }) })).status).toBe(400)
    const off = (await (await api('/settings', { method: 'PUT', body: JSON.stringify({ allowScriptNodes: false }) })).json()) as { settings: { allowScriptNodes: boolean }; warning?: string }
    expect(off.settings.allowScriptNodes).toBe(false)
    expect(off.warning).toBeUndefined()
  })

  it('language defaults to Chinese, is validated and persists', async () => {
    expect(((await (await api('/settings')).json()) as { settings: { language: string } }).settings.language).toBe('zh-CN')
    expect((await api('/settings', { method: 'PUT', body: JSON.stringify({ language: 'fr' }) })).status).toBe(400)
    expect((await api('/settings', { method: 'PUT', body: JSON.stringify({ language: 'zh' }) })).status).toBe(400)
    const en = (await (await api('/settings', { method: 'PUT', body: JSON.stringify({ language: 'en' }) })).json()) as { settings: { language: string } }
    expect(en.settings.language).toBe('en')
    expect(new SettingsStore(dir).get().language).toBe('en')
    await api('/settings', { method: 'PUT', body: JSON.stringify({ language: 'zh-CN' }) })
    expect(new SettingsStore(dir).get().language).toBe('zh-CN')
  })

  it('with the plugin config switch on, the API reports it and warns', async () => {
    configScripts = true
    const meta = (await (await api('/meta')).json()) as { scriptsAllowed: boolean; scriptsSource: string | null }
    expect(meta).toMatchObject({ scriptsAllowed: true, scriptsSource: 'config' })
    const res = (await (await api('/settings', { method: 'PUT', body: JSON.stringify({ allowScriptNodes: true }) })).json()) as { warning?: string }
    expect(res.warning).toBe(SCRIPT_NODES_WARNING)
    configScripts = false
  })
})
