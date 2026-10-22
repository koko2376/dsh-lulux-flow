/**
 * HTTP API under `/dsh-lulux-flow/` on the DSH web server.
 *
 * - `/dsh-lulux-flow/api/*`: the canvas API. Every request must pass DSH's own
 *   browser authentication (`ctx.connection.requestRejection`). Mutating
 *   requests also need `X-Lulux-Flow-Request: 1` and a JSON content type, which a
 *   cross-site form or simple request cannot produce (CSRF defence).
 * - `/dsh-lulux-flow/hooks/<workflowId>`: webhook trigger, authenticated by
 *   HMAC signature instead of a browser session.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BRAND, ROUTE_PREFIX } from '../brand.js'
import type { LuluxFlowRuntime } from '../runtime.js'
import { nextRun } from '../workflow/cron.js'
import { normalizeWorkflow } from '../workflow/validate.js'
import { summarize, type EngineEvent } from '../workflow/types.js'
import { ReplayCache, verifyWebhook } from '../workflow/webhook.js'
import { headerValue, HttpError, readBody, readJson, sendJson, startSse } from '../util/http.js'
import { assertSafeId, safeJoin } from '../util/fs.js'
import { SCRIPT_NODES_WARNING } from '../settings.js'
import { markApproved, markUnreviewed, reviewInfo, reviewProblem } from '../workflow/review.js'
import { UnreviewedWorkflowError } from '../workflow/engine.js'

export interface ApiOptions {
  runtime: LuluxFlowRuntime
  /** Browser-session check; returns a status to reject with, or undefined to allow. */
  authorize: (req: IncomingMessage) => 401 | 403 | undefined
  maxBodyBytes: number
  version: string
}

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[]; url: URL; body: () => Promise<unknown> }) => Promise<void> | void

interface Route {
  method: string
  pattern: RegExp
  handler: Handler
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function createApi(options: ApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const rt = options.runtime
  const replay = new ReplayCache(undefined, safeJoin(rt.store.root, 'secrets', 'webhook-replay.json'))
  const sseClients = new Set<ServerResponse>()
  rt.engine.onEvent((event: EngineEvent) => {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    for (const client of sseClients) client.write(frame)
  })

  const routes: Route[] = []
  const route = (method: string, path: string, handler: Handler): void => {
    const pattern = new RegExp(`^${path.replace(/:([a-z]+)/gi, '([A-Za-z0-9_.-]+)')}$`)
    routes.push({ method, pattern, handler })
  }
  const workflowOr404 = (id: string) => {
    const wf = rt.store.getWorkflow(assertSafeId(id))
    if (wf === undefined) throw new HttpError(404, 'workflow not found')
    return wf
  }

  route('GET', '/meta', ({ res }) =>
    sendJson(res, 200, {
      brand: BRAND,
      version: options.version,
      scriptsAllowed: rt.scriptsAllowed,
      scriptsSource: rt.scriptsAllowed ? 'config' : null,
      gateway: { listening: rt.gateway.listening },
      ...(() => {
        try {
          const info = rt.upstreamInfo()
          return { upstream: info.target, upstreamSource: info.source, upstreamError: null }
        } catch (error: unknown) {
          return { upstream: null, upstreamSource: null, upstreamError: error instanceof Error ? error.message : String(error) }
        }
      })(),
    }),
  )

  // ── workflows ──
  route('GET', '/workflows', ({ res }) => {
    const runs = rt.store.listRuns({ limit: 1000 })
    sendJson(res, 200, {
      workflows: rt.store.listWorkflows().map(wf => ({
        id: wf.id,
        name: wf.name,
        description: wf.description ?? '',
        nodes: wf.nodes.length,
        updatedAt: wf.updatedAt,
        review: { status: reviewProblem(wf) === undefined ? 'approved' : 'unreviewed', source: wf.review?.source ?? 'legacy' },
        lastRun: runs.find(r => r.workflowId === wf.id) ?? null,
      })),
    })
  })
  // A workflow built in the canvas is the user's own; imported or generated ones need review first.
  route('POST', '/workflows', async ({ res, body }) => {
    const wf = markApproved(normalizeWorkflow(await body(), { id: rt.store.newId() }), 'canvas', 'user')
    rt.store.saveWorkflow(wf)
    rt.engine.emit({ type: 'workflow', workflowId: wf.id })
    sendJson(res, 201, { workflow: wf, issues: rt.engine.lint(wf), review: reviewInfo(wf) })
  })
  route('POST', '/workflows/import', async ({ res, body }) => {
    const raw = (await body()) as Record<string, unknown>
    const wf = markUnreviewed(normalizeWorkflow(raw.workflow ?? raw, { id: rt.store.newId() }), 'import')
    rt.store.saveWorkflow(wf)
    rt.engine.emit({ type: 'workflow', workflowId: wf.id })
    sendJson(res, 201, { workflow: wf, issues: rt.engine.lint(wf), review: reviewInfo(wf) })
  })
  route('POST', '/workflows/generate', async ({ req, res, body }) => {
    const { description } = (await body()) as { description?: string }
    if (typeof description !== 'string' || !description.trim()) throw new HttpError(400, 'description is required')
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    const { workflow, issues } = await rt.generate(description, controller.signal)
    markUnreviewed(workflow, 'generated')
    rt.store.saveWorkflow(workflow)
    rt.engine.emit({ type: 'workflow', workflowId: workflow.id })
    sendJson(res, 201, { workflow, issues, review: reviewInfo(workflow) })
  })
  route('GET', '/workflows/:id', ({ res, params }) => {
    const wf = workflowOr404(params[0]!)
    sendJson(res, 200, { workflow: wf, issues: rt.engine.lint(wf), review: reviewInfo(wf), webhook: { configured: rt.store.webhookFingerprint(wf.id) !== undefined, fingerprint: rt.store.webhookFingerprint(wf.id) ?? null, path: `${ROUTE_PREFIX}/hooks/${wf.id}` } })
  })
  route('PUT', '/workflows/:id', async ({ res, params, body }) => {
    const current = workflowOr404(params[0]!)
    const wf = normalizeWorkflow(await body(), { id: current.id })
    wf.createdAt = current.createdAt
    // Editing an approved workflow in the canvas keeps it approved (the user wrote the change);
    // editing an unreviewed one does not approve it: that takes the explicit approve call.
    if (reviewProblem(current) === undefined) markApproved(wf, 'canvas', current.review?.source ?? 'user')
    else markUnreviewed(wf, current.review?.source ?? 'legacy')
    rt.store.saveWorkflow(wf)
    rt.engine.emit({ type: 'workflow', workflowId: wf.id })
    sendJson(res, 200, { workflow: wf, issues: rt.engine.lint(wf), review: reviewInfo(wf) })
  })
  route('POST', '/workflows/:id/approve', async ({ res, params, body }) => {
    const current = workflowOr404(params[0]!)
    const { digest } = (await body()) as { digest?: unknown }
    const info = reviewInfo(current)
    if (typeof digest !== 'string' || !digest) throw new HttpError(400, 'digest is required (the review.digest of the version you reviewed)', 'digest_required')
    if (digest !== info.digest) throw new HttpError(409, 'the workflow changed since you opened it; reload and review it again', 'stale_review')
    markApproved(current, 'canvas')
    rt.store.saveWorkflow(current)
    rt.engine.emit({ type: 'workflow', workflowId: current.id })
    sendJson(res, 200, { workflow: current, review: reviewInfo(current) })
  })
  route('DELETE', '/workflows/:id', ({ res, params }) => {
    const id = assertSafeId(params[0]!)
    const active = rt.store.listRuns({ workflowId: id }).filter(r => r.status === 'running' || r.status === 'waiting' || r.status === 'queued')
    if (active.length > 0) throw new HttpError(409, 'workflow has active runs; cancel them first')
    rt.store.deleteWorkflow(id)
    rt.engine.emit({ type: 'workflow', workflowId: id, deleted: true })
    sendJson(res, 200, { deleted: true })
  })
  route('GET', '/workflows/:id/export', ({ res, params }) => {
    const wf = workflowOr404(params[0]!)
    sendJson(res, 200, { format: `${BRAND.id}.workflow`, version: 1, workflow: wf }, { 'content-disposition': `attachment; filename="${wf.id}.lulux-flow.json"` })
  })
  route('POST', '/workflows/:id/lint', async ({ res, params, body }) => {
    const current = workflowOr404(params[0]!)
    const draft = normalizeWorkflow(await body(), { id: current.id })
    sendJson(res, 200, { issues: rt.engine.lint(draft) })
  })
  route('POST', '/workflows/:id/run', async ({ res, params, body }) => {
    const { inputs } = (await body()) as { inputs?: Record<string, unknown> }
    const run = rt.startRun(assertSafeId(params[0]!), inputs ?? {}, { kind: 'canvas' })
    sendJson(res, 202, { run: summarize(run) })
  })
  route('POST', '/workflows/:id/webhook', ({ res, params }) => {
    const wf = workflowOr404(params[0]!)
    const secret = rt.store.rotateWebhookSecret(wf.id)
    sendJson(res, 200, { secret, path: `${ROUTE_PREFIX}/hooks/${wf.id}`, note: 'Store this secret now; it is not shown again.' })
  })
  route('DELETE', '/workflows/:id/webhook', ({ res, params }) => {
    rt.store.deleteWebhookSecret(workflowOr404(params[0]!).id)
    sendJson(res, 200, { deleted: true })
  })
  route('POST', '/cron/preview', async ({ res, body }) => {
    const { expression } = (await body()) as { expression?: string }
    const out: string[] = []
    let from = new Date()
    for (let i = 0; i < 3; i += 1) {
      const next = nextRun(String(expression ?? ''), from)
      if (next === undefined) break
      out.push(next.toISOString())
      from = next
    }
    sendJson(res, 200, { next: out })
  })

  // ── runs ──
  route('GET', '/runs', ({ res, url }) => {
    const workflowId = url.searchParams.get('workflowId') ?? undefined
    sendJson(res, 200, { runs: rt.store.listRuns({ ...(workflowId ? { workflowId } : {}), limit: Number(url.searchParams.get('limit') ?? 50) || 50 }) })
  })
  route('GET', '/runs/:id', ({ res, params }) => {
    const run = rt.store.getRun(assertSafeId(params[0]!))
    if (run === undefined) throw new HttpError(404, 'run not found')
    sendJson(res, 200, { run })
  })
  route('POST', '/runs/:id/cancel', ({ res, params }) => sendJson(res, 200, { cancelled: rt.engine.cancel(assertSafeId(params[0]!)) }))
  route('POST', '/runs/:id/resume', ({ res, params }) => sendJson(res, 202, { run: summarize(rt.engine.resume(assertSafeId(params[0]!))) }))
  route('POST', '/runs/:id/rerun', ({ res, params }) => sendJson(res, 202, { run: summarize(rt.engine.rerun(assertSafeId(params[0]!))) }))
  route('POST', '/runs/:id/nodes/:node/decision', async ({ res, params, body }) => {
    const { approved, note } = (await body()) as { approved?: boolean; note?: string }
    const ok = rt.engine.decide(assertSafeId(params[0]!), assertSafeId(params[1]!), approved === true, 'canvas', typeof note === 'string' ? note.slice(0, 500) : undefined)
    if (!ok) throw new HttpError(409, 'this node is not waiting for a decision')
    sendJson(res, 200, { ok })
  })
  route('GET', '/events', ({ req, res }) => {
    startSse(res)
    res.write(`event: hello\ndata: {}\n\n`)
    sseClients.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    req.on('close', () => {
      clearInterval(ping)
      sseClients.delete(res)
    })
  })

  // ── kernels & settings ──
  route('GET', '/kernels', async ({ res, url }) => sendJson(res, 200, { kernels: await rt.kernels.list(url.searchParams.get('refresh') === '1') }))
  route('POST', '/kernels/:id/install', ({ res, params }) => sendJson(res, 202, { install: rt.kernels.install(params[0]!) }))
  route('POST', '/kernels/:id/test', async ({ res, params }) => {
    const id = assertSafeId(params[0]!)
    if (rt.kernels.find(id) === undefined) throw new HttpError(404, 'unknown kernel')
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    sendJson(res, 200, await rt.kernels.test(id, () => rt.upstreamTarget(), { signal: controller.signal, ...(rt.testCwd !== undefined ? { cwd: rt.testCwd } : {}) }))
  })
  route('POST', '/kernels/:id/uninstall', ({ res, params }) => sendJson(res, 200, { install: rt.kernels.uninstall(params[0]!) }))
  route('GET', '/registries', async ({ res, url }) => {
    const ranked = await rt.selector.select('@openai/codex', '>=0.0.0', url.searchParams.get('refresh') === '1')
    sendJson(res, 200, { registries: ranked })
  })
  route('GET', '/settings', ({ res }) => sendJson(res, 200, { settings: rt.settings.get() }))
  route('PUT', '/settings', async ({ res, body }) => {
    const patch = (await body()) as Record<string, unknown> | null
    // Script nodes run code as the DSH user; a browser request alone cannot switch them on.
    if (patch !== null && typeof patch === 'object' && patch.allowScriptNodes === true && !rt.scriptsAllowed) {
      throw new HttpError(403, 'script nodes can only be enabled by the operator: set allowScriptNodes: true in the plugin config (cordis.patch.yml) and restart DSH', 'config_only')
    }
    const settings = rt.settings.update(patch)
    sendJson(res, 200, { settings, ...(rt.scriptsAllowed ? { warning: SCRIPT_NODES_WARNING } : {}) })
  })

  const handleWebhook = async (req: IncomingMessage, res: ServerResponse, workflowId: string): Promise<void> => {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
    const raw = await readBody(req, options.maxBodyBytes)
    const verdict = verifyWebhook(
      rt.store.webhookSecret(workflowId),
      { timestamp: headerValue(req, BRAND.headers.timestamp), signature: headerValue(req, BRAND.headers.signature) },
      raw,
      replay,
    )
    if (!verdict.ok) throw new HttpError(verdict.status, verdict.reason)
    const wf = rt.store.getWorkflow(workflowId)
    if (wf?.triggers?.webhook?.enabled !== true) throw new HttpError(403, 'webhook trigger is disabled for this workflow')
    let inputs: Record<string, unknown> = {}
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
        inputs = (parsed.inputs as Record<string, unknown> | undefined) ?? parsed
      } catch {
        throw new HttpError(400, 'body must be JSON')
      }
    }
    const run = rt.startRun(workflowId, inputs, { kind: 'webhook' })
    sendJson(res, 202, { runId: run.id, status: run.status })
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    try {
      const hook = /^\/hooks\/([A-Za-z0-9_-]{1,64})$/.exec(path)
      if (hook !== null) return await handleWebhook(req, res, hook[1]!)
      if (!path.startsWith('/api/')) throw new HttpError(404, 'not found')
      const rejection = options.authorize(req)
      if (rejection !== undefined) throw new HttpError(rejection, rejection === 401 ? 'authentication required' : 'forbidden')
      const method = req.method ?? 'GET'
      if (MUTATING.has(method)) {
        if (headerValue(req, BRAND.headers.csrf) !== '1') throw new HttpError(403, `missing ${BRAND.headers.csrf} header`)
        const type = headerValue(req, 'content-type') ?? ''
        if (method !== 'DELETE' && !type.startsWith('application/json')) throw new HttpError(415, 'content-type must be application/json')
      }
      const sub = path.slice(4)
      for (const r of routes) {
        if (r.method !== method) continue
        const match = r.pattern.exec(sub)
        if (match === null) continue
        let cached: Promise<unknown> | undefined
        await r.handler({ req, res, params: match.slice(1), url, body: () => (cached ??= readJson(req, options.maxBodyBytes)) })
        return
      }
      throw new HttpError(404, 'not found')
    } catch (error: unknown) {
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message, code: error.code })
      else if (error instanceof UnreviewedWorkflowError) sendJson(res, 409, { error: error.message, code: error.code })
      else {
        const message = error instanceof Error ? error.message : String(error)
        rt.logger.warn(`api ${req.method ?? ''} ${path}: ${message}`)
        sendJson(res, 400, { error: message })
      }
    }
  }
}
