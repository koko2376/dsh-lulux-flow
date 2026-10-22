/**
 * Client state and its complete mutation API. `createFlowController`
 * is called once in the plugin `apply` and handed to every registration, so
 * the page, the settings section and the session switcher share one view of
 * workflows, runs and kernels.
 */
import { BRAND } from '../brand.ts'
import { ApiError, type FlowApi } from '../api/client.ts'
import type {
  FlowSettingsView,
  EdgeRoute,
  EngineEvent,
  KernelInfo,
  KernelSettings,
  LintIssue,
  Meta,
  NodeType,
  RankedRegistries,
  ReviewInfo,
  WebhookInfo,
  WebhookSecret,
  Workflow,
  WorkflowListItem,
  WorkflowRun,
} from '../api/types.ts'
import { autoLayout, connect, createNode, removeEdge, removeNode } from './graph.ts'
import { createStore, type Store } from './store.ts'

export type View = 'workflows' | 'runs' | 'kernels'
export type Selection = { kind: 'node' | 'edge'; id: string } | null
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface Toast {
  id: number
  tone: 'info' | 'success' | 'error'
  /** Locale key, or verbatim text when `raw` is set. */
  text: string
  params?: Record<string, string | number>
  raw?: boolean
}

export interface KernelTest {
  status: 'running' | 'ok' | 'failed'
  detail?: string
  latencyMs?: number
}

export interface FlowState {
  meta: Meta | null
  connected: boolean
  view: View
  workflows: { status: LoadStatus; items: WorkflowListItem[]; error?: string }
  editor: {
    workflow: Workflow | null
    /** JSON of the last saved version, for dirty tracking. */
    saved: string
    issues: LintIssue[]
    selection: Selection
    webhook: WebhookInfo | null
    /** Host review state of the saved version; null on Hosts that do not send one. */
    review: ReviewInfo | null
    saving: boolean
    approving: boolean
    loading: boolean
  }
  runs: { status: LoadStatus; items: WorkflowRun[]; active: WorkflowRun | null; focusNode: string | null }
  kernels: { status: LoadStatus; items: KernelInfo[]; registries: RankedRegistries | null; probing: boolean; tests: Record<string, KernelTest> }
  settings: { status: LoadStatus; value: FlowSettingsView | null; saving: boolean; error: string | null }
  toasts: Toast[]
}

export const initialState = (): FlowState => ({
  meta: null,
  connected: false,
  view: 'workflows',
  workflows: { status: 'idle', items: [] },
  editor: { workflow: null, saved: '', issues: [], selection: null, webhook: null, review: null, saving: false, approving: false, loading: false },
  runs: { status: 'idle', items: [], active: null, focusNode: null },
  kernels: { status: 'idle', items: [], registries: null, probing: false, tests: {} },
  settings: { status: 'idle', value: null, saving: false, error: null },
  toasts: [],
})

export const isDirty = (s: FlowState): boolean => s.editor.workflow !== null && JSON.stringify(s.editor.workflow) !== s.editor.saved
export const ACTIVE_RUN: readonly string[] = ['queued', 'running', 'waiting']
/** The open workflow must be approved before it can run. */
export const needsReview = (s: FlowState): boolean => s.editor.review !== null && !s.editor.review.runnable

export interface FlowActions {
  start(): () => void
  setView(view: View): void
  refreshWorkflows(): Promise<void>
  openWorkflow(id: string): Promise<void>
  newWorkflow(name: string): Promise<void>
  closeWorkflow(): void
  updateWorkflow(update: (wf: Workflow) => Workflow): void
  select(selection: Selection): void
  addNode(type: NodeType, position: { x: number; y: number }, name: string): string | undefined
  connectNodes(source: string, target: string, route?: EdgeRoute): void
  deleteSelection(): void
  layout(): void
  save(): Promise<boolean>
  /** Approve the reviewed version (saves pending edits first). */
  approve(): Promise<boolean>
  lint(): Promise<void>
  deleteWorkflow(id: string): Promise<void>
  importJson(text: string): Promise<boolean>
  exportJson(): Promise<{ name: string; json: string } | undefined>
  generate(description: string): Promise<boolean>
  run(inputs: Record<string, unknown>): Promise<void>
  rotateWebhook(): Promise<WebhookSecret | undefined>
  deleteWebhook(): Promise<void>
  cronPreview(expression: string): Promise<string[]>
  refreshRuns(workflowId?: string): Promise<void>
  openRun(id: string | null): Promise<void>
  focusRunNode(id: string | null): void
  cancelRun(id: string): Promise<void>
  resumeRun(id: string): Promise<void>
  rerun(id: string): Promise<void>
  decide(runId: string, nodeId: string, approved: boolean, note?: string): Promise<void>
  refreshKernels(refresh?: boolean): Promise<void>
  probeRegistries(refresh?: boolean): Promise<void>
  installKernel(id: string): Promise<void>
  uninstallKernel(id: string): Promise<void>
  updateKernel(id: string, patch: Partial<KernelSettings>): Promise<void>
  testKernel(id: string): Promise<void>
  /** Re-read /meta (gateway model, script flag); surfaces outside the page call it on mount. */
  refreshMeta(): Promise<void>
  loadSettings(): Promise<void>
  saveSettings(patch: Partial<FlowSettingsView> | Record<string, unknown>): Promise<boolean>
  toast(tone: Toast['tone'], text: string, params?: Record<string, string | number>, raw?: boolean): void
  dismissToast(id: number): void
}

export interface FlowController {
  store: Store<FlowState>
  actions: FlowActions
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isCode = (error: unknown, status: number, code: string): boolean => error instanceof ApiError && error.status === status && error.code === code

export function createFlowController(api: FlowApi, options: { pollMs?: number } = {}): FlowController {
  const store = createStore<FlowState>(initialState())
  const get = store.getSnapshot
  const patch = <K extends keyof FlowState>(key: K, value: Partial<FlowState[K]>): void =>
    store.set(s => ({ ...s, [key]: { ...(s[key] as object), ...value } }))
  let toastSeq = 0
  let installPoll: ReturnType<typeof setTimeout> | undefined
  let lintTimer: ReturnType<typeof setTimeout> | undefined
  const pollMs = options.pollMs ?? 1000

  const toast: FlowActions['toast'] = (tone, text, params, raw) => {
    const id = ++toastSeq
    store.set(s => ({ ...s, toasts: [...s.toasts.slice(-3), { id, tone, text, ...(params ? { params } : {}), ...(raw ? { raw } : {}) }] }))
    setTimeout(() => actions.dismissToast(id), tone === 'error' ? 8000 : 4000)
  }
  const fail = (key: string, error: unknown): void => toast('error', key, { message: message(error) })

  const upsertRun = (run: WorkflowRun): void => {
    store.set(s => {
      const items = s.runs.items.some(r => r.id === run.id) ? s.runs.items.map(r => (r.id === run.id ? run : r)) : [run, ...s.runs.items]
      return { ...s, runs: { ...s.runs, items, active: s.runs.active?.id === run.id ? run : s.runs.active } }
    })
  }

  const onEvent = (event: EngineEvent): void => {
    const s = get()
    if (event.type === 'run') {
      const summary = event.run
      const known = s.runs.items.find(r => r.id === summary.id)
      if (known !== undefined) upsertRun({ ...known, ...summary } as WorkflowRun)
      else if (s.runs.active === null || s.editor.workflow?.id === summary.workflowId) void api.getRun(summary.id).then(upsertRun).catch(() => undefined)
      if (s.runs.active?.id === summary.id && !ACTIVE_RUN.includes(summary.status)) void api.getRun(summary.id).then(upsertRun).catch(() => undefined)
      if (!ACTIVE_RUN.includes(summary.status)) void actions.refreshWorkflows()
    } else if (event.type === 'node') {
      store.set(st => {
        const apply = (run: WorkflowRun): WorkflowRun => (run.id === event.runId ? { ...run, nodes: { ...run.nodes, [event.nodeId]: event.evidence } } : run)
        return { ...st, runs: { ...st.runs, items: st.runs.items.map(apply), active: st.runs.active ? apply(st.runs.active) : null } }
      })
    } else if (event.type === 'trace') {
      store.set(st => {
        const active = st.runs.active
        if (active === null || active.id !== event.runId) return st
        const node = active.nodes[event.nodeId]
        if (node === undefined) return st
        return { ...st, runs: { ...st.runs, active: { ...active, nodes: { ...active.nodes, [event.nodeId]: { ...node, trace: [...node.trace, event.line].slice(-500) } } } } }
      })
    } else if (event.type === 'workflow') {
      void actions.refreshWorkflows()
      // An approval from the DSH dialog (or a change by the model) moves the review state of the open workflow.
      if (s.editor.workflow !== null && s.editor.workflow.id === event.workflowId) void refreshReview(event.workflowId)
    }
  }

  const refreshReview = async (id: string): Promise<void> => {
    try {
      const detail = await api.getWorkflow(id)
      if (get().editor.workflow?.id === id) patch('editor', { review: detail.review ?? null })
    } catch {
      /* the next open or save brings it back */
    }
  }

  /** Run and rerun answer 409 `unreviewed` for a workflow nobody approved: show the banner, not an error. */
  const unreviewed = (error: unknown, workflowId: string | undefined): boolean => {
    if (!isCode(error, 409, 'unreviewed')) return false
    const open = get().editor.workflow
    if (open !== null && open.id === workflowId) void refreshReview(open.id)
    toast('info', 'toast.runUnreviewed')
    return true
  }

  const scheduleLint = (): void => {
    if (lintTimer !== undefined) clearTimeout(lintTimer)
    lintTimer = setTimeout(() => void actions.lint(), 600)
  }

  const pollInstalls = (): void => {
    if (installPoll !== undefined) return
    const tick = async (): Promise<void> => {
      installPoll = undefined
      await actions.refreshKernels()
      const busy = get().kernels.items.some(k => k.install.status === 'installing' || k.install.status === 'probing')
      if (busy) installPoll = setTimeout(() => void tick(), pollMs)
      else void actions.probeRegistries()
    }
    installPoll = setTimeout(() => void tick(), pollMs)
  }

  const actions: FlowActions = {
    start() {
      void api
        .meta()
        .then(meta => store.set(s => ({ ...s, meta })))
        .catch(() => undefined)
      void actions.refreshWorkflows()
      void actions.refreshRuns()
      void actions.refreshKernels()
      const stop = api.subscribe(onEvent, connected => store.set(s => (s.connected === connected ? s : { ...s, connected })))
      return () => {
        stop()
        if (installPoll !== undefined) clearTimeout(installPoll)
        if (lintTimer !== undefined) clearTimeout(lintTimer)
      }
    },
    setView(view) {
      store.set(s => ({ ...s, view }))
      if (view === 'kernels') {
        if (get().kernels.status === 'idle') void actions.refreshKernels()
        if (get().kernels.registries === null && !get().kernels.probing) void actions.probeRegistries()
      }
      if (view === 'runs') void actions.refreshRuns()
    },
    async refreshWorkflows() {
      if (get().workflows.items.length === 0) patch('workflows', { status: 'loading' })
      try {
        const items = await api.listWorkflows()
        patch('workflows', { status: 'ready', items })
      } catch (error) {
        patch('workflows', { status: 'error', error: message(error) })
      }
    },
    async openWorkflow(id) {
      patch('editor', { loading: true })
      try {
        const detail = await api.getWorkflow(id)
        store.set(s => ({
          ...s,
          view: 'workflows',
          editor: { ...s.editor, workflow: detail.workflow, saved: JSON.stringify(detail.workflow), issues: detail.issues, selection: null, webhook: detail.webhook ?? null, review: detail.review ?? null, loading: false },
          runs: { ...s.runs, active: s.runs.active?.workflowId === id ? s.runs.active : null },
        }))
        void actions.refreshRuns(id)
      } catch (error) {
        patch('editor', { loading: false })
        fail('toast.openFailed', error)
      }
    },
    async newWorkflow(name) {
      try {
        const now = new Date().toISOString()
        const detail = await api.createWorkflow({
          schemaVersion: 1,
          name,
          nodes: [
            { id: 'input', type: 'input', name: 'Input', position: { x: 80, y: 160 }, config: {} },
            { id: 'output', type: 'output', name: 'Output', position: { x: 520, y: 160 }, config: {} },
          ],
          edges: [{ id: 'e_input_output', source: 'input', target: 'output', route: 'success' }],
          createdAt: now,
          updatedAt: now,
        })
        await actions.refreshWorkflows()
        await actions.openWorkflow(detail.workflow.id)
      } catch (error) {
        fail('toast.createFailed', error)
      }
    },
    closeWorkflow() {
      patch('editor', { workflow: null, saved: '', issues: [], selection: null, webhook: null, review: null })
    },
    updateWorkflow(update) {
      const wf = get().editor.workflow
      if (wf === null) return
      patch('editor', { workflow: update(wf) })
      scheduleLint()
    },
    select(selection) {
      patch('editor', { selection })
    },
    addNode(type, position, name) {
      const wf = get().editor.workflow
      if (wf === null) return undefined
      const kernels = get().kernels.items.map(k => k.id)
      const node = createNode(type, position, wf.nodes, name, kernels)
      patch('editor', { workflow: { ...wf, nodes: [...wf.nodes, node] }, selection: { kind: 'node', id: node.id } })
      scheduleLint()
      return node.id
    },
    connectNodes(source, target, route) {
      actions.updateWorkflow(wf => connect(wf, source, target, route))
    },
    deleteSelection() {
      const { selection } = get().editor
      if (selection === null) return
      actions.updateWorkflow(wf => (selection.kind === 'node' ? removeNode(wf, selection.id) : removeEdge(wf, selection.id)))
      patch('editor', { selection: null })
    },
    layout() {
      actions.updateWorkflow(autoLayout)
    },
    async save() {
      const wf = get().editor.workflow
      if (wf === null) return false
      patch('editor', { saving: true })
      try {
        const detail = await api.saveWorkflow(wf)
        store.set(s => ({ ...s, editor: { ...s.editor, saving: false, saved: JSON.stringify(s.editor.workflow), issues: detail.issues, ...(detail.review ? { review: detail.review } : {}) } }))
        toast('success', 'toast.saved')
        void actions.refreshWorkflows()
        return true
      } catch (error) {
        patch('editor', { saving: false })
        fail('toast.saveFailed', error)
        return false
      }
    },
    async approve() {
      const wf = get().editor.workflow
      if (wf === null || get().editor.approving) return false
      if (isDirty(get()) && !(await actions.save())) return false
      const review = get().editor.review
      if (review === null) return false
      patch('editor', { approving: true })
      try {
        const out = await api.approveWorkflow(wf.id, review.digest)
        if (get().editor.workflow?.id === wf.id) patch('editor', { review: out.review, approving: false })
        else patch('editor', { approving: false })
        toast('success', 'toast.reviewApproved')
        void actions.refreshWorkflows()
        return true
      } catch (error) {
        patch('editor', { approving: false })
        if (isCode(error, 409, 'stale_review')) {
          // Someone (or the model) changed it after it was opened: show the new version to review.
          toast('info', 'toast.reviewStale')
          await actions.openWorkflow(wf.id)
        } else fail('toast.reviewFailed', error)
        return false
      }
    },
    async lint() {
      const wf = get().editor.workflow
      if (wf === null) return
      try {
        const issues = await api.lintWorkflow(wf)
        if (get().editor.workflow === wf) patch('editor', { issues })
      } catch {
        /* local lint still covers the canvas */
      }
    },
    async deleteWorkflow(id) {
      try {
        await api.deleteWorkflow(id)
        if (get().editor.workflow?.id === id) actions.closeWorkflow()
        toast('success', 'toast.deleted')
        await actions.refreshWorkflows()
      } catch (error) {
        fail(error instanceof ApiError && error.status === 409 ? 'toast.deleteActive' : 'toast.deleteFailed', error)
      }
    },
    async importJson(text) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        toast('error', 'toast.importInvalid')
        return false
      }
      try {
        const detail = await api.importWorkflow(parsed)
        toast('success', 'toast.imported', { name: detail.workflow.name })
        await actions.refreshWorkflows()
        await actions.openWorkflow(detail.workflow.id)
        return true
      } catch (error) {
        fail('toast.importFailed', error)
        return false
      }
    },
    async exportJson() {
      const wf = get().editor.workflow
      if (wf === null) return undefined
      try {
        const body = await api.exportWorkflow(wf.id)
        return { name: `${wf.id}.${BRAND.id}.json`, json: JSON.stringify(body, null, 2) }
      } catch (error) {
        fail('toast.exportFailed', error)
        return undefined
      }
    },
    async generate(description) {
      try {
        const detail = await api.generateWorkflow(description)
        await actions.refreshWorkflows()
        await actions.openWorkflow(detail.workflow.id)
        toast('success', 'toast.generated', { name: detail.workflow.name })
        return true
      } catch (error) {
        fail('toast.generateFailed', error)
        return false
      }
    },
    async run(inputs) {
      const wf = get().editor.workflow
      if (wf === null) return
      if (isDirty(get()) && !(await actions.save())) return
      try {
        const summary = await api.runWorkflow(wf.id, inputs)
        const run = await api.getRun(summary.id)
        upsertRun(run)
        store.set(s => ({ ...s, runs: { ...s.runs, active: run, focusNode: null } }))
      } catch (error) {
        if (!unreviewed(error, wf.id)) fail('toast.runFailed', error)
      }
    },
    async rotateWebhook() {
      const wf = get().editor.workflow
      if (wf === null) return undefined
      try {
        const secret = await api.rotateWebhook(wf.id)
        const detail = await api.getWorkflow(wf.id)
        patch('editor', { webhook: detail.webhook ?? null })
        return secret
      } catch (error) {
        fail('toast.webhookFailed', error)
        return undefined
      }
    },
    async deleteWebhook() {
      const wf = get().editor.workflow
      if (wf === null) return
      try {
        await api.deleteWebhook(wf.id)
        const detail = await api.getWorkflow(wf.id)
        patch('editor', { webhook: detail.webhook ?? null })
      } catch (error) {
        fail('toast.webhookFailed', error)
      }
    },
    async cronPreview(expression) {
      try {
        return await api.cronPreview(expression)
      } catch {
        return []
      }
    },
    async refreshRuns(workflowId) {
      patch('runs', { status: get().runs.items.length === 0 ? 'loading' : get().runs.status })
      try {
        const items = await api.listRuns(workflowId)
        store.set(s => {
          const others = workflowId === undefined ? [] : s.runs.items.filter(r => r.workflowId !== workflowId)
          const merged = [...items, ...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          return { ...s, runs: { ...s.runs, status: 'ready', items: merged } }
        })
      } catch {
        patch('runs', { status: 'error' })
      }
    },
    async openRun(id) {
      if (id === null) {
        patch('runs', { active: null, focusNode: null })
        return
      }
      try {
        const run = await api.getRun(id)
        upsertRun(run)
        patch('runs', { active: run, focusNode: null })
      } catch (error) {
        fail('toast.openFailed', error)
      }
    },
    focusRunNode(id) {
      patch('runs', { focusNode: id })
    },
    async cancelRun(id) {
      try {
        await api.cancelRun(id)
      } catch (error) {
        fail('toast.runActionFailed', error)
      }
    },
    async resumeRun(id) {
      try {
        await api.resumeRun(id)
        await actions.openRun(id)
      } catch (error) {
        fail('toast.runActionFailed', error)
      }
    },
    async rerun(id) {
      try {
        const summary = await api.rerun(id)
        await actions.openRun(summary.id)
      } catch (error) {
        const workflowId = get().runs.items.find(r => r.id === id)?.workflowId ?? (get().runs.active?.id === id ? get().runs.active?.workflowId : undefined)
        if (!unreviewed(error, workflowId)) fail('toast.runActionFailed', error)
      }
    },
    async decide(runId, nodeId, approved, note) {
      try {
        await api.decide(runId, nodeId, approved, note)
        toast('success', approved ? 'toast.approved' : 'toast.rejected')
      } catch (error) {
        fail('toast.runActionFailed', error)
      }
    },
    async refreshKernels(refresh = false) {
      if (get().kernels.items.length === 0) patch('kernels', { status: 'loading' })
      try {
        const items = await api.listKernels(refresh)
        patch('kernels', { status: 'ready', items })
        if (items.some(k => k.install.status === 'installing' || k.install.status === 'probing')) pollInstalls()
      } catch {
        patch('kernels', { status: 'error' })
      }
    },
    async probeRegistries(refresh = false) {
      patch('kernels', { probing: true })
      try {
        const registries = await api.registries(refresh)
        patch('kernels', { registries, probing: false })
      } catch {
        patch('kernels', { probing: false })
      }
    },
    async installKernel(id) {
      try {
        const install = await api.installKernel(id)
        store.set(s => ({ ...s, kernels: { ...s.kernels, items: s.kernels.items.map(k => (k.id === id ? { ...k, install } : k)) } }))
        pollInstalls()
      } catch (error) {
        fail('toast.installFailed', error)
      }
    },
    async uninstallKernel(id) {
      try {
        await api.uninstallKernel(id)
        await actions.refreshKernels(true)
      } catch (error) {
        fail('toast.installFailed', error)
      }
    },
    async updateKernel(id, change) {
      store.set(s => ({
        ...s,
        kernels: { ...s.kernels, items: s.kernels.items.map(k => (k.id === id ? { ...k, settings: { ...k.settings, ...change } } : k)) },
      }))
      const ok = await actions.saveSettings({ kernels: { [id]: change } })
      if (!ok) await actions.refreshKernels()
    },
    async refreshMeta() {
      try {
        const meta = await api.meta()
        store.set(s => ({ ...s, meta }))
      } catch {
        /* the page shows its own connection state */
      }
    },
    async testKernel(id) {
      store.set(s => ({ ...s, kernels: { ...s.kernels, tests: { ...s.kernels.tests, [id]: { status: 'running' } } } }))
      const started = performance.now()
      let result: KernelTest
      try {
        const out = await api.request<{ ok: boolean; output?: string; error?: string; latencyMs?: number }>('POST', `/kernels/${encodeURIComponent(id)}/test`, {})
        result = { status: out.ok ? 'ok' : 'failed', latencyMs: out.latencyMs ?? Math.round(performance.now() - started), ...(out.output || out.error ? { detail: out.output ?? out.error } : {}) }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          // Host without a test endpoint: fall back to a fresh version probe.
          const items = await api.listKernels(true).catch(() => [] as KernelInfo[])
          const kernel = items.find(k => k.id === id)
          if (items.length > 0) patch('kernels', { items })
          result = kernel?.installed && kernel.versionOk
            ? { status: 'ok', latencyMs: Math.round(performance.now() - started), detail: kernel.version ?? '' }
            : { status: 'failed', detail: kernel?.installed ? 'version' : 'missing' }
        } else result = { status: 'failed', detail: message(error) }
      }
      store.set(s => ({ ...s, kernels: { ...s.kernels, tests: { ...s.kernels.tests, [id]: result } } }))
    },
    async loadSettings() {
      patch('settings', { status: 'loading' })
      try {
        const value = await api.getSettings()
        patch('settings', { status: 'ready', value })
      } catch {
        patch('settings', { status: 'error' })
      }
    },
    async saveSettings(change) {
      patch('settings', { saving: true, error: null })
      try {
        const value = await api.updateSettings(change)
        patch('settings', { saving: false, value, status: 'ready' })
        store.set(s => ({
          ...s,
          kernels: { ...s.kernels, items: s.kernels.items.map(k => ({ ...k, settings: { ...k.settings, ...(value.kernels[k.id] ?? {}) } as KernelSettings })) },
        }))
        return true
      } catch (error) {
        // The Host explains a rejected value (registry URL, unsupported permission) in its 400 message.
        patch('settings', { saving: false, error: message(error) })
        fail(isCode(error, 403, 'config_only') ? 'toast.scriptsConfigOnly' : 'toast.settingsFailed', error)
        return false
      }
    },
    toast,
    dismissToast(id) {
      store.set(s => ({ ...s, toasts: s.toasts.filter(t => t.id !== id) }))
    },
  }
  return { store, actions }
}
