import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApi } from '../../src/http/api.js'
import { KernelGateway } from '../../src/gateway/server.js'
import { TokenStore } from '../../src/gateway/tokens.js'
import { KernelInstaller } from '../../src/kernels/installer.js'
import { RegistrySelector } from '../../src/kernels/registry-probe.js'
import { KernelRunner } from '../../src/kernels/runner.js'
import { KernelService } from '../../src/kernels/service.js'
import type { LuluxFlowRuntime } from '../../src/runtime.js'
import { SettingsStore } from '../../src/settings.js'
import { WorkflowEngine } from '../../src/workflow/engine.js'
import { WorkflowStore } from '../../src/workflow/store.js'
import { signWebhook } from '../../src/workflow/webhook.js'
import { FakeUpstream, TARGET, tempDir } from '../helpers.js'

describe('canvas HTTP API', () => {
  const dir = tempDir()
  const store = new WorkflowStore(dir)
  const settings = new SettingsStore(dir)
  const tokens = new TokenStore()
  const gateway = new KernelGateway({ upstream: new FakeUpstream(), tokens, logger: { info: () => undefined, warn: () => undefined }, maxBodyBytes: 1024, requestTimeoutMs: 1000 })
  const selector = new RegistrySelector({ candidates: () => [], override: () => undefined, ttlMs: 1000, timeoutMs: 100, fetcher: async () => new Response('{}') })
  const installer = new KernelInstaller({ installRoot: `${dir}/k`, selector, timeoutMs: 1000 })
  const runner = new KernelRunner({ tokens, gatewayUrl: () => 'http://127.0.0.1:1', runsRoot: `${dir}/tmp`, installRoot: `${dir}/k`, approvalBridge: false, resolve: () => undefined })
  const kernels = new KernelService(runner, installer, settings, { provider: id => `lulux-flow-${id}`, chatRoute: id => `lulux-flow-${id}` })
  const engine = new WorkflowEngine({ store, executors: { agent: async c => ({ output: `echo ${String(c.prompt)}` }) }, scriptsAllowed: false, knownKernels: () => ['claude-code'], requireReview: true })
  const runtime: LuluxFlowRuntime = {
    store,
    engine,
    kernels,
    settings,
    gateway,
    selector,
    scriptsAllowed: false,
    upstreamTarget: () => TARGET,
    upstreamInfo: () => ({ target: TARGET, source: 'dsh-default' }),
    generate: async () => {
      throw new Error('not used')
    },
    startRun: (id, inputs, trigger) => engine.start(store.getWorkflow(id)!, inputs, trigger),
    logger: { info: () => undefined, warn: () => undefined },
  }
  let authorized: 401 | 403 | undefined = undefined
  const handler = createApi({ runtime, authorize: () => authorized, maxBodyBytes: 64 * 1024, version: 'test' })
  let server: Server
  let base = ''
  beforeAll(async () => {
    server = createServer((req, res) => void handler(req, res))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-lulux-flow`
  })
  afterAll(() => server.close())

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/api${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-lulux-flow-request': '1', ...(init.headers as Record<string, string> | undefined) } })

  it('requires DSH browser authentication', async () => {
    authorized = 401
    expect((await api('/workflows')).status).toBe(401)
    authorized = undefined
    expect((await api('/workflows')).status).toBe(200)
  })

  it('rejects mutations without the CSRF header or JSON content type', async () => {
    expect((await fetch(`${base}/api/workflows`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(403)
    expect((await fetch(`${base}/api/workflows`, { method: 'POST', body: 'a=b', headers: { 'x-lulux-flow-request': '1', 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415)
  })

  let workflowId = ''
  it('creates, lints, runs, exports and imports workflows', async () => {
    const created = (await (
      await api('/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'API flow', nodes: [{ id: 'a', type: 'agent', config: { prompt: 'hi' } }, { id: 'o', type: 'output' }], edges: [{ id: 'e', source: 'a', target: 'o' }], triggers: { webhook: { enabled: true } } }),
      })
    ).json()) as { workflow: { id: string }; issues: unknown[] }
    workflowId = created.workflow.id
    expect(created.issues).toEqual([])
    const run = (await (await api(`/workflows/${workflowId}/run`, { method: 'POST', body: '{}' })).json()) as { run: { id: string } }
    const done = await engine.wait(run.run.id)
    expect(done?.output).toBe('echo hi')
    const detail = (await (await api(`/runs/${run.run.id}`)).json()) as { run: { nodes: Record<string, { status: string }> } }
    expect(detail.run.nodes.a!.status).toBe('succeeded')
    const exported = (await (await api(`/workflows/${workflowId}/export`)).json()) as { workflow: unknown }
    const imported = (await (await api('/workflows/import', { method: 'POST', body: JSON.stringify(exported) })).json()) as { workflow: { id: string; name: string } }
    expect(imported.workflow.id).not.toBe(workflowId)
    expect(imported.workflow.name).toBe('API flow')
    expect((await api('/workflows/..%2F..%2Fx')).status).toBe(404)
  })

  it('imported workflows need an explicit, digest-bound approval before they run', async () => {
    const graph = { name: 'Imported', nodes: [{ id: 'a', type: 'agent', config: { prompt: 'hi' } }, { id: 'o', type: 'output' }], edges: [{ id: 'e', source: 'a', target: 'o' }] }
    const imported = (await (await api('/workflows/import', { method: 'POST', body: JSON.stringify({ workflow: { ...graph, review: { status: 'approved', source: 'user' } } }) })).json()) as {
      workflow: { id: string }
      review: { status: string; source: string; digest: string; runnable: boolean }
    }
    expect(imported.review).toMatchObject({ status: 'unreviewed', source: 'import', runnable: false })
    const id = imported.workflow.id
    const refused = await api(`/workflows/${id}/run`, { method: 'POST', body: '{}' })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { code: string }).code).toBe('unreviewed')
    // editing in the canvas does not approve it
    const edited = (await (await api(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify({ ...graph, name: 'Imported (edited)' }) })).json()) as { review: { status: string; digest: string } }
    expect(edited.review.status).toBe('unreviewed')
    // approve needs the digest of the version the user saw
    expect((await api(`/workflows/${id}/approve`, { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await api(`/workflows/${id}/approve`, { method: 'POST', body: JSON.stringify({ digest: 'sha256-old' }) })).status).toBe(409)
    const approved = (await (await api(`/workflows/${id}/approve`, { method: 'POST', body: JSON.stringify({ digest: edited.review.digest }) })).json()) as { review: { status: string; by: string; runnable: boolean } }
    expect(approved.review).toMatchObject({ status: 'approved', by: 'canvas', runnable: true })
    const run = (await (await api(`/workflows/${id}/run`, { method: 'POST', body: '{}' })).json()) as { run: { id: string } }
    expect((await engine.wait(run.run.id))?.status).toBe('succeeded')
    // a canvas edit of an approved workflow keeps it approved
    const kept = (await (await api(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify({ ...graph, nodes: [{ id: 'a', type: 'agent', config: { prompt: 'bye' } }, { id: 'o', type: 'output' }] }) })).json()) as { review: { status: string } }
    expect(kept.review.status).toBe('approved')
    const list = (await (await api('/workflows')).json()) as { workflows: Array<{ id: string; review: { status: string } }> }
    expect(list.workflows.find(w => w.id === id)!.review.status).toBe('approved')
    // the run snapshot was approved, so rerunning it works
    expect(((await (await api(`/runs/${run.run.id}/rerun`, { method: 'POST', body: '{}' })).json()) as { run?: unknown }).run).toBeDefined()
  })

  it('decisions are recorded from the canvas', async () => {
    const graph = { name: 'Gate', nodes: [{ id: 'g', type: 'approval', config: { message: 'ok?' } }, { id: 'o', type: 'output' }], edges: [{ id: 'e', source: 'g', target: 'o' }] }
    const created = (await (await api('/workflows', { method: 'POST', body: JSON.stringify(graph) })).json()) as { workflow: { id: string } }
    const run = (await (await api(`/workflows/${created.workflow.id}/run`, { method: 'POST', body: '{}' })).json()) as { run: { id: string } }
    await new Promise(r => setTimeout(r, 50))
    expect((await api(`/runs/${run.run.id}/nodes/g/decision`, { method: 'POST', body: JSON.stringify({ approved: true, note: 'fine' }) })).status).toBe(200)
    const done = (await engine.wait(run.run.id))!
    expect(done.nodes.g!.decision).toMatchObject({ approved: true, by: 'canvas', note: 'fine' })
    expect((await api(`/runs/${run.run.id}/nodes/g/decision`, { method: 'POST', body: JSON.stringify({ approved: true }) })).status).toBe(409)
  })

  it('refuses http registry overrides', async () => {
    expect((await api('/settings', { method: 'PUT', body: JSON.stringify({ registryOverride: 'http://mirror.example.com' }) })).status).toBe(400)
    const ok = (await (await api('/settings', { method: 'PUT', body: JSON.stringify({ registryOverride: 'https://registry.npmmirror.com', registryTrustMirror: true }) })).json()) as { settings: { registryOverride: string; registryTrustMirror: boolean } }
    expect(ok.settings).toMatchObject({ registryOverride: 'https://registry.npmmirror.com', registryTrustMirror: true })
  })

  it('triggers runs from signed webhooks only', async () => {
    const secret = ((await (await api(`/workflows/${workflowId}/webhook`, { method: 'POST', body: '{}' })).json()) as { secret: string }).secret
    const body = JSON.stringify({ inputs: {} })
    const ts = Math.floor(Date.now() / 1000)
    const unsigned = await fetch(`${base}/hooks/${workflowId}`, { method: 'POST', body })
    expect(unsigned.status).toBe(401)
    const signed = await fetch(`${base}/hooks/${workflowId}`, { method: 'POST', body, headers: { 'x-lulux-flow-timestamp': String(ts), 'x-lulux-flow-signature': signWebhook(secret, ts, body) } })
    expect(signed.status).toBe(202)
    const replay = await fetch(`${base}/hooks/${workflowId}`, { method: 'POST', body, headers: { 'x-lulux-flow-timestamp': String(ts), 'x-lulux-flow-signature': signWebhook(secret, ts, body) } })
    expect(replay.status).toBe(409)
  })

  it('exposes kernels and settings', async () => {
    const list = (await (await api('/kernels')).json()) as { kernels: Array<{ id: string; installed: boolean; provider: string; permissions: string[] }> }
    expect(list.kernels.map(k => k.id)).toEqual(['claude-code', 'codex', 'gemini-cli', 'qwen-code', 'grok'])
    expect(list.kernels[0]!.provider).toBe('lulux-flow-claude-code')
    expect(list.kernels[0]!.permissions).toEqual(['read-only', 'ask', 'edit', 'full'])
    expect(list.kernels.find(k => k.id === 'grok')!.permissions).toEqual(['read-only', 'ask', 'full'])
    const updated = (await (await api('/settings', { method: 'PUT', body: JSON.stringify({ kernels: { codex: { permission: 'edit' } } }) })).json()) as { settings: { kernels: { codex: { permission: string } } } }
    expect(updated.settings.kernels.codex.permission).toBe('edit')
  })

  it('refuses deleting a workflow with active runs, then deletes', async () => {
    const res = await api(`/workflows/${workflowId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect((await api(`/workflows/${workflowId}`)).status).toBe(404)
  })
})
