import { describe, expect, it, vi } from 'vitest'
import { createFlowController, isDirty } from '../src/store/flow.ts'
import { fakeApi, kernel, run, workflow, type Route } from './helpers.tsx'

const flush = () => new Promise(r => setTimeout(r, 0))

function setup(extra: Route = () => undefined) {
  let saved = workflow()
  const { api, calls } = fakeApi((method, path, body) => {
    const x = extra(method, path, body)
    if (x) return x
    if (method === 'GET' && path === '/workflows') return { body: { workflows: [{ id: 'wf1', name: 'Triage', description: '', nodes: 4, updatedAt: '', lastRun: null }] } }
    if (method === 'GET' && path === '/workflows/wf1') return { body: { workflow: saved, issues: [], webhook: { configured: false, fingerprint: null, path: '/dsh-lulux-flow/hooks/wf1' } } }
    if (method === 'PUT' && path === '/workflows/wf1') {
      saved = body as typeof saved
      return { body: { workflow: saved, issues: [{ level: 'warning', message: 'host says hi', nodeId: 'review' }] } }
    }
    if (method === 'POST' && path === '/workflows/wf1/lint') return { body: { issues: [] } }
    if (method === 'GET' && path.startsWith('/runs?')) return { body: { runs: [] } }
    if (method === 'GET' && path.startsWith('/kernels')) return { body: { kernels: [kernel(), kernel({ id: 'grok', name: 'Grok CLI', chatRoute: 'lulux-flow-grok', installed: false, version: undefined })] } }
    if (method === 'PUT' && path === '/settings') return { body: { settings: { kernels: (body as { kernels?: object }).kernels ?? {}, registryOverride: '', gatewayModel: '' } } }
    return undefined
  })
  return { ...createFlowController(api, { pollMs: 5 }), calls }
}

describe('flow controller', () => {
  it('opens a workflow, tracks dirty edits, and saves with Host issues', async () => {
    const { store, actions, calls } = setup()
    await actions.openWorkflow('wf1')
    expect(store.getSnapshot().editor.workflow?.name).toBe('Triage')
    expect(isDirty(store.getSnapshot())).toBe(false)
    const id = actions.addNode('agent', { x: 1, y: 2 }, 'Agent')
    expect(id).toBe('agent')
    expect(store.getSnapshot().editor.selection).toEqual({ kind: 'node', id: 'agent' })
    actions.connectNodes('review', 'agent', 'failure')
    expect(isDirty(store.getSnapshot())).toBe(true)
    expect(await actions.save()).toBe(true)
    expect(isDirty(store.getSnapshot())).toBe(false)
    expect(store.getSnapshot().editor.issues).toEqual([{ level: 'warning', message: 'host says hi', nodeId: 'review' }])
    const put = calls.find(c => c.method === 'PUT')!
    expect((put.body as { edges: Array<{ route: string }> }).edges.at(-1)?.route).toBe('failure')
    expect(store.getSnapshot().toasts.at(-1)).toMatchObject({ tone: 'success', text: 'toast.saved' })
  })

  it('deletes the selection with its edges', async () => {
    const { store, actions } = setup()
    await actions.openWorkflow('wf1')
    actions.select({ kind: 'node', id: 'review' })
    actions.deleteSelection()
    const wf = store.getSnapshot().editor.workflow!
    expect(wf.nodes.map(n => n.id)).not.toContain('review')
    expect(wf.edges.some(e => e.source === 'review' || e.target === 'review')).toBe(false)
  })

  it('reports a 409 on delete with the specific message', async () => {
    const { store, actions } = setup((method, path) => (method === 'DELETE' && path === '/workflows/wf1' ? { status: 409, body: { error: 'busy' } } : undefined))
    await actions.deleteWorkflow('wf1')
    expect(store.getSnapshot().toasts.at(-1)).toMatchObject({ tone: 'error', text: 'toast.deleteActive' })
  })

  it('rejects malformed import JSON without calling the Host', async () => {
    const { store, actions, calls } = setup()
    expect(await actions.importJson('{nope')).toBe(false)
    expect(calls.some(c => c.path === '/workflows/import')).toBe(false)
    expect(store.getSnapshot().toasts.at(-1)?.text).toBe('toast.importInvalid')
  })

  it('starts a run and opens it in the inspector', async () => {
    const r = run({ status: 'running' })
    const { store, actions } = setup((method, path) => {
      if (method === 'POST' && path === '/workflows/wf1/run') return { status: 202, body: { run: { id: r.id } } }
      if (method === 'GET' && path === `/runs/${r.id}`) return { body: { run: r } }
      return undefined
    })
    await actions.openWorkflow('wf1')
    await actions.run({ topic: 'x' })
    expect(store.getSnapshot().runs.active?.id).toBe(r.id)
  })

  it('updates kernel settings optimistically and persists them', async () => {
    const { store, actions, calls } = setup()
    await actions.refreshKernels()
    await actions.updateKernel('claude-code', { permission: 'edit' })
    expect(store.getSnapshot().kernels.items[0]!.settings.permission).toBe('edit')
    expect(calls.find(c => c.method === 'PUT' && c.path === '/settings')!.body).toEqual({ kernels: { 'claude-code': { permission: 'edit' } } })
  })

  it('falls back to a version probe when the Host has no kernel test endpoint', async () => {
    const { store, actions } = setup()
    await actions.refreshKernels()
    await actions.testKernel('claude-code')
    expect(store.getSnapshot().kernels.tests['claude-code']).toMatchObject({ status: 'ok', detail: '2.1.4' })
    await actions.testKernel('grok')
    expect(store.getSnapshot().kernels.tests.grok).toMatchObject({ status: 'failed', detail: 'missing' })
  })

  it('polls installs until they finish', async () => {
    let polls = 0
    const { store, actions } = setup((method, path) => {
      if (method === 'POST' && path === '/kernels/grok/install') return { status: 202, body: { install: { kernelId: 'grok', status: 'installing', log: ['npm i'] } } }
      if (method === 'GET' && path.startsWith('/kernels')) {
        polls += 1
        const status = polls < 3 ? 'installing' : 'installed'
        return { body: { kernels: [kernel({ id: 'grok', install: { kernelId: 'grok', status, log: [] } })] } }
      }
      if (path.startsWith('/registries')) return { body: { registries: { packageName: '@openai/codex', probedAt: 0, results: [] } } }
      return undefined
    })
    await actions.installKernel('grok')
    await vi.waitFor(() => expect(store.getSnapshot().kernels.items[0]?.install.status).toBe('installed'))
    expect(polls).toBeGreaterThanOrEqual(3)
  })

  it('folds live node evidence and trace events into the active run', async () => {
    let emit: (e: unknown) => void = () => undefined
    const r = run({ status: 'running' })
    const { api } = fakeApi((method, path) => (method === 'GET' && path === `/runs/${r.id}` ? { body: { run: r } } : method === 'GET' ? { body: { workflows: [], runs: [] } } : undefined))
    api.subscribe = listener => {
      emit = listener as (e: unknown) => void
      return () => undefined
    }
    const { store, actions } = createFlowController(api)
    const stop = actions.start()
    await actions.openRun(r.id)
    emit({ type: 'node', runId: r.id, nodeId: 'gate', evidence: { status: 'succeeded', route: 'success', attempts: [], trace: [], artifacts: [] } })
    emit({ type: 'trace', runId: r.id, nodeId: 'gate', line: 'approved by canvas' })
    const gate = store.getSnapshot().runs.active!.nodes.gate!
    expect(gate.status).toBe('succeeded')
    expect(gate.trace).toEqual(['approved by canvas'])
    stop()
    await flush()
  })
})
