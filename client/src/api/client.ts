/**
 * Plugin HTTP client. Every call is same-origin and rides DSH's own browser
 * authentication cookie; mutating calls add the CSRF header (`BRAND.headers.csrf`) and
 * a JSON body, which the Host requires as its CSRF fence.
 */
import { API_ROOT, BRAND } from '../brand.ts'
import type {
  FlowSettingsView,
  EngineEvent,
  InstallState,
  KernelInfo,
  LintIssue,
  Meta,
  RankedRegistries,
  ReviewInfo,
  WebhookSecret,
  Workflow,
  WorkflowDetail,
  WorkflowListItem,
  WorkflowRun,
  WorkflowRunSummary,
} from './types.ts'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable reason the Host sends with some errors (e.g. `unreviewed`, `stale_review`, `config_only`). */
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  close(): void
  onerror: ((event: Event) => void) | null
}

export interface ApiTransport {
  fetch: FetchLike
  eventSource: (url: string) => EventSourceLike
}

const defaultTransport = (): ApiTransport => ({
  fetch: (input, init) => globalThis.fetch(input, init),
  eventSource: url => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike,
})

export class FlowApi {
  private readonly transport: ApiTransport

  constructor(
    private readonly root: string = API_ROOT,
    transport?: Partial<ApiTransport>,
  ) {
    this.transport = { ...defaultTransport(), ...transport }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const init: RequestInit = { method, headers, credentials: 'same-origin' }
    if (method !== 'GET') {
      headers[BRAND.headers.csrf] = '1'
      headers['content-type'] = 'application/json'
      if (method !== 'DELETE' || body !== undefined) init.body = JSON.stringify(body ?? {})
    }
    const response = await this.transport.fetch(`${this.root}${path}`, init)
    const text = await response.text()
    let data: unknown = undefined
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = { error: text.slice(0, 300) }
      }
    }
    if (!response.ok) {
      const payload = data as { error?: string; code?: unknown } | undefined
      const message = payload?.error ?? `HTTP ${response.status}`
      throw new ApiError(response.status, message, typeof payload?.code === 'string' ? payload.code : undefined)
    }
    return data as T
  }

  meta = () => this.request<Meta>('GET', '/meta')
  listWorkflows = () => this.request<{ workflows: WorkflowListItem[] }>('GET', '/workflows').then(r => r.workflows)
  getWorkflow = (id: string) => this.request<WorkflowDetail>('GET', `/workflows/${encodeURIComponent(id)}`)
  createWorkflow = (draft: Partial<Workflow>) => this.request<WorkflowDetail>('POST', '/workflows', draft)
  saveWorkflow = (wf: Workflow) => this.request<WorkflowDetail>('PUT', `/workflows/${encodeURIComponent(wf.id)}`, wf)
  deleteWorkflow = (id: string) => this.request<{ deleted: boolean }>('DELETE', `/workflows/${encodeURIComponent(id)}`)
  approveWorkflow = (id: string, digest: string) =>
    this.request<{ workflow: Workflow; review: ReviewInfo }>('POST', `/workflows/${encodeURIComponent(id)}/approve`, { digest })
  importWorkflow = (json: unknown) => this.request<WorkflowDetail>('POST', '/workflows/import', json)
  exportWorkflow = (id: string) => this.request<{ format: string; version: number; workflow: Workflow }>('GET', `/workflows/${encodeURIComponent(id)}/export`)
  lintWorkflow = (wf: Workflow) => this.request<{ issues: LintIssue[] }>('POST', `/workflows/${encodeURIComponent(wf.id)}/lint`, wf).then(r => r.issues)
  generateWorkflow = (description: string) => this.request<WorkflowDetail>('POST', '/workflows/generate', { description })
  runWorkflow = (id: string, inputs: Record<string, unknown>) => this.request<{ run: WorkflowRunSummary }>('POST', `/workflows/${encodeURIComponent(id)}/run`, { inputs }).then(r => r.run)
  rotateWebhook = (id: string) => this.request<WebhookSecret>('POST', `/workflows/${encodeURIComponent(id)}/webhook`, {})
  deleteWebhook = (id: string) => this.request<{ deleted: boolean }>('DELETE', `/workflows/${encodeURIComponent(id)}/webhook`)
  cronPreview = (expression: string) => this.request<{ next: string[] }>('POST', '/cron/preview', { expression }).then(r => r.next)

  listRuns = (workflowId?: string, limit = 50) =>
    this.request<{ runs: WorkflowRun[] }>('GET', `/runs?${new URLSearchParams({ ...(workflowId ? { workflowId } : {}), limit: String(limit) }).toString()}`).then(r => r.runs)
  getRun = (id: string) => this.request<{ run: WorkflowRun }>('GET', `/runs/${encodeURIComponent(id)}`).then(r => r.run)
  cancelRun = (id: string) => this.request<{ cancelled: boolean }>('POST', `/runs/${encodeURIComponent(id)}/cancel`, {})
  resumeRun = (id: string) => this.request<{ run: WorkflowRunSummary }>('POST', `/runs/${encodeURIComponent(id)}/resume`, {}).then(r => r.run)
  rerun = (id: string) => this.request<{ run: WorkflowRunSummary }>('POST', `/runs/${encodeURIComponent(id)}/rerun`, {}).then(r => r.run)
  decide = (runId: string, nodeId: string, approved: boolean, note?: string) =>
    this.request<{ ok: boolean }>('POST', `/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/decision`, { approved, ...(note ? { note } : {}) })

  listKernels = (refresh = false) => this.request<{ kernels: KernelInfo[] }>('GET', `/kernels${refresh ? '?refresh=1' : ''}`).then(r => r.kernels)
  installKernel = (id: string) => this.request<{ install: InstallState }>('POST', `/kernels/${encodeURIComponent(id)}/install`, {}).then(r => r.install)
  uninstallKernel = (id: string) => this.request<{ install: InstallState }>('POST', `/kernels/${encodeURIComponent(id)}/uninstall`, {}).then(r => r.install)
  registries = (refresh = false) => this.request<{ registries: RankedRegistries }>('GET', `/registries${refresh ? '?refresh=1' : ''}`).then(r => r.registries)
  getSettings = () => this.request<{ settings: FlowSettingsView }>('GET', '/settings').then(r => r.settings)
  updateSettings = (patch: Partial<FlowSettingsView> | Record<string, unknown>) => this.request<{ settings: FlowSettingsView }>('PUT', '/settings', patch).then(r => r.settings)

  /** Live engine events. Returns a disposer; reconnects with backoff while subscribed. */
  subscribe(listener: (event: EngineEvent) => void, onStatus?: (connected: boolean) => void): () => void {
    let source: EventSourceLike | undefined
    let stopped = false
    let delay = 1000
    let timer: ReturnType<typeof setTimeout> | undefined
    const open = (): void => {
      if (stopped) return
      try {
        source = this.transport.eventSource(`${this.root}/events`)
      } catch {
        onStatus?.(false)
        return
      }
      const forward = (event: MessageEvent): void => {
        try {
          listener(JSON.parse(String(event.data)) as EngineEvent)
        } catch {
          /* a malformed frame never breaks the stream */
        }
      }
      for (const type of ['run', 'node', 'trace', 'workflow']) source.addEventListener(type, forward)
      source.addEventListener('hello', () => {
        delay = 1000
        onStatus?.(true)
      })
      source.onerror = () => {
        onStatus?.(false)
        source?.close()
        if (stopped) return
        timer = setTimeout(open, delay)
        delay = Math.min(delay * 2, 30_000)
      }
    }
    open()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      source?.close()
    }
  }
}
