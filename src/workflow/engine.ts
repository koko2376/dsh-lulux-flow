/**
 * DAG execution engine.
 *
 * Scheduling: a node becomes ready when every inbound edge is resolved. An
 * edge is *taken* when its source finished on the edge's route, *dead* when
 * the source finished on another route or was skipped. A node whose inbound
 * edges are all dead is skipped (and its outbound edges die); otherwise it
 * runs once at least one inbound edge is taken.
 *
 * Failure: a failed node with a `failure` edge routes there; with
 * `continueOnFailure` it continues on `success` with `{ error }` as output;
 * otherwise the failure is unhandled — its downstream stays pending,
 * independent branches finish, and the run ends `failed` (resumable).
 *
 * Durability: the run (frozen workflow snapshot + per-node evidence) is
 * persisted after every state change. After a crash, `recover()` marks
 * in-flight runs `interrupted`; `resume()` re-executes only nodes that did
 * not succeed.
 */
import { randomBytes } from 'node:crypto'
import { evaluate } from './expr.js'
import { renderDeep, renderString, type TemplateScope } from './template.js'
import { lintWorkflow, LIMITS } from './validate.js'
import { reviewDigest, reviewProblem } from './review.js'
import type { WorkflowStore } from './store.js'
import {
  summarize,
  type EdgeRoute,
  type EngineEvent,
  type NodeArtifact,
  type NodeEvidence,
  type RunStatus,
  type TriggerKind,
  type Workflow,
  type WorkflowNode,
  type WorkflowRun,
} from './types.js'
import { redact, redactDeep } from '../util/redact.js'

export interface StepContext {
  run: Readonly<WorkflowRun>
  node: Readonly<WorkflowNode>
  scope: TemplateScope
  signal: AbortSignal
  trace(line: string): void
}

export interface StepResult {
  output: unknown
  usage?: { inputTokens: number; outputTokens: number }
  artifacts?: NodeArtifact[]
}

export type StepExecutor = (config: Record<string, unknown>, ctx: StepContext) => Promise<StepResult>

export interface ExternalApproval {
  /** Ask through another channel (e.g. DSH's approval dialog). Resolve undefined when unavailable. */
  ask(run: Readonly<WorkflowRun>, node: Readonly<WorkflowNode>, message: string, signal: AbortSignal): Promise<{ approved: boolean; by: string } | undefined>
}

export interface EngineDeps {
  store: WorkflowStore
  executors: Partial<Record<'agent' | 'kernel' | 'script' | 'http' | 'notify', StepExecutor>>
  /** Static flag or a live getter (runtime settings can flip it). */
  scriptsAllowed: boolean | (() => boolean)
  knownKernels?: () => readonly string[]
  logger?: { warn(message: string): void; info?(message: string): void }
  defaultConcurrency?: number
  /** Run deadline when the workflow sets none (ms). */
  defaultDeadlineMs?: number
  /**
   * Refuse to start workflows that are not approved (see review.ts). On in
   * the plugin; tests that drive the engine directly may leave it off.
   */
  requireReview?: boolean
  /** Maximum runs executing at once across all workflows; further starts are refused. */
  maxActiveRuns?: number
}

export interface StartOptions {
  /**
   * A person approved this one run of an unreviewed workflow through another
   * channel (DSH's approval dialog). Recorded in the trigger detail.
   * Requires `approvedDigest`.
   */
  approvedOnceBy?: string
  /**
   * Review digest of the exact workflow the person was shown. The run is
   * refused when the workflow being started has a different digest (it was
   * changed while the approval dialog was open).
   */
  approvedDigest?: string
}

/** Channels allowed to decide an approval node. A model claiming that a person agreed is not one of them. */
export const HUMAN_DECISION_CHANNELS: readonly string[] = ['canvas', 'api', 'dsh-approval', 'timeout']

class RunAbort extends Error {}

/** Thrown by start() for a workflow that needs review first (the API maps it to 409). */
export class UnreviewedWorkflowError extends Error {
  readonly code = 'unreviewed'
  constructor(
    message: string,
    /** `changed`: the workflow differs from what a one-time approval was given for. */
    readonly reason: 'unreviewed' | 'changed' = 'unreviewed',
  ) {
    super(message)
  }
}

interface Waiter {
  resolve(decision: { approved: boolean; by: string; note?: string }): void
}

function nowIso(): string {
  return new Date().toISOString()
}

function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error))
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new RunAbort('cancelled'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new RunAbort('cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted']

export class WorkflowEngine {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<WorkflowRun>; reason?: string }>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private externalApproval: ExternalApproval | undefined

  constructor(private readonly deps: EngineDeps) {}

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setExternalApproval(channel: ExternalApproval | undefined): void {
    this.externalApproval = channel
  }

  emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* contained */
      }
    }
  }

  /** Mark runs that were in flight when the process died as interrupted. */
  recover(): number {
    let count = 0
    for (const summary of this.deps.store.listRuns({ limit: Number.MAX_SAFE_INTEGER })) {
      if (TERMINAL.includes(summary.status)) continue
      const run = this.deps.store.getRun(summary.id)
      if (run === undefined) continue
      for (const evidence of Object.values(run.nodes)) {
        if (evidence.status === 'running' || evidence.status === 'queued' || evidence.status === 'waiting') {
          evidence.status = 'cancelled'
          evidence.error = 'interrupted by a DSH restart'
          evidence.endedAt = nowIso()
        }
      }
      run.status = 'interrupted'
      run.error = 'interrupted by a DSH restart; resume to continue from the failed nodes'
      run.endedAt = nowIso()
      this.deps.store.saveRun(run)
      count += 1
    }
    return count
  }

  /** Whether script nodes may run right now. */
  scriptsAllowed(): boolean {
    const flag = this.deps.scriptsAllowed
    return typeof flag === 'function' ? flag() : flag
  }

  lint(workflow: Workflow): ReturnType<typeof lintWorkflow> {
    return lintWorkflow(workflow, { scriptsAllowed: this.scriptsAllowed(), ...(this.deps.knownKernels ? { knownKernels: this.deps.knownKernels() } : {}) })
  }

  /** Validate inputs against the workflow's input spec (defaults applied). */
  resolveInputs(workflow: Workflow, raw: Record<string, unknown> = {}): Record<string, unknown> {
    const out: Record<string, unknown> = { ...raw }
    for (const spec of workflow.inputs ?? []) {
      let value = raw[spec.name]
      if (value === undefined || value === '') value = spec.default
      if (value === undefined) {
        if (spec.required === true) throw new Error(`missing required input "${spec.name}"`)
        continue
      }
      if (spec.type === 'number') {
        const n = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(n)) throw new Error(`input "${spec.name}" must be a number`)
        value = n
      } else if (spec.type === 'boolean') {
        value = value === true || value === 'true' || value === 1 || value === '1'
      } else if (spec.type === 'json' && typeof value === 'string') {
        try {
          value = JSON.parse(value) as unknown
        } catch {
          throw new Error(`input "${spec.name}" must be JSON`)
        }
      } else if (spec.type === 'string' && typeof value !== 'string') {
        value = JSON.stringify(value)
      }
      out[spec.name] = value
    }
    return out
  }

  /** Create a run and start executing it. Returns as soon as the run is persisted. */
  start(workflow: Workflow, rawInputs: Record<string, unknown>, trigger: { kind: TriggerKind; detail?: string }, rerunOf?: string, options: StartOptions = {}): WorkflowRun {
    const errors = this.lint(workflow).filter(issue => issue.level === 'error')
    if (errors.length > 0) throw new Error(`workflow has errors: ${errors.map(e => e.message).join('; ')}`)
    if (options.approvedOnceBy !== undefined && options.approvedDigest === undefined) throw new UnreviewedWorkflowError('a one-time approval must name the digest of what was approved')
    if (options.approvedDigest !== undefined && reviewDigest(workflow) !== options.approvedDigest) {
      throw new UnreviewedWorkflowError('this workflow changed while the approval was pending; nothing was started, ask for approval again', 'changed')
    }
    if (this.deps.requireReview === true && options.approvedOnceBy === undefined) {
      const problem = reviewProblem(workflow)
      if (problem !== undefined) throw new UnreviewedWorkflowError(`${problem}; open it in DSH-LULUX Flow, review it and approve it before running`)
    }
    const maxActive = this.deps.maxActiveRuns
    if (maxActive !== undefined && this.active.size >= maxActive) throw new Error(`too many runs in progress (limit ${maxActive}); wait for one to finish`)
    if (options.approvedOnceBy !== undefined) trigger = { ...trigger, detail: `${trigger.detail ? `${trigger.detail}; ` : ''}approved once by ${options.approvedOnceBy}` }
    const inputs = this.resolveInputs(workflow, rawInputs)
    const run: WorkflowRun = {
      schemaVersion: 1,
      id: `run_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: 'queued',
      trigger,
      inputs,
      snapshot: structuredClone(workflow),
      nodes: Object.fromEntries(workflow.nodes.map(node => [node.id, { status: 'pending', attempts: [], trace: [], artifacts: [] } satisfies NodeEvidence])),
      createdAt: nowIso(),
      resumes: 0,
      usage: { inputTokens: 0, outputTokens: 0, nodeRuns: 0 },
      ...(rerunOf !== undefined ? { rerunOf } : {}),
    }
    this.deps.store.saveRun(run)
    this.execute(run)
    return run
  }

  /** Resume a failed/interrupted/cancelled run: non-succeeded nodes are reset and execution continues. */
  resume(runId: string): WorkflowRun {
    if (this.active.has(runId)) throw new Error('run is still active')
    const run = this.deps.store.getRun(runId)
    if (run === undefined) throw new Error('run not found')
    if (run.status === 'succeeded') throw new Error('run already succeeded; use rerun instead')
    for (const evidence of Object.values(run.nodes)) {
      if (evidence.status === 'succeeded' || evidence.status === 'skipped') continue
      if (evidence.status === 'failed' && evidence.route !== undefined) continue // handled failure stays as routed
      evidence.status = 'pending'
      delete evidence.error
      delete evidence.route
      delete evidence.decision
      evidence.trace.push(`— resumed at ${nowIso()} —`)
    }
    run.resumes += 1
    run.status = 'queued'
    delete run.error
    delete run.endedAt
    this.deps.store.saveRun(run)
    this.execute(run)
    return run
  }

  /** Start a fresh run from the same frozen snapshot and inputs. */
  rerun(runId: string): WorkflowRun {
    const run = this.deps.store.getRun(runId)
    if (run === undefined) throw new Error('run not found')
    return this.start(run.snapshot, run.inputs, { kind: 'rerun', detail: runId }, runId)
  }

  cancel(runId: string, reason = 'cancelled by user'): boolean {
    const active = this.active.get(runId)
    if (active === undefined) return false
    active.reason = reason
    active.controller.abort(new RunAbort(reason))
    return true
  }

  /** Resolve a waiting approval node. */
  decide(runId: string, nodeId: string, approved: boolean, by: string, note?: string): boolean {
    if (!HUMAN_DECISION_CHANNELS.includes(by)) return false
    const waiter = this.waiters.get(`${runId}:${nodeId}`)
    if (waiter === undefined) return false
    waiter.resolve({ approved, by, ...(note !== undefined ? { note } : {}) })
    return true
  }

  isActive(runId: string): boolean {
    return this.active.has(runId)
  }

  wait(runId: string): Promise<WorkflowRun | undefined> {
    const active = this.active.get(runId)
    return active === undefined ? Promise.resolve(this.deps.store.getRun(runId)) : active.done
  }

  /** Stop everything (plugin unload). Runs end as interrupted and stay resumable. */
  async shutdown(): Promise<void> {
    const pending = [...this.active.entries()].map(([id, a]) => {
      a.reason = 'interrupted by plugin shutdown'
      a.controller.abort(new RunAbort('shutdown'))
      return a.done.catch(() => undefined).then(() => id)
    })
    await Promise.all(pending)
  }

  // ── execution ──────────────────────────────────────────────────────────────

  private execute(run: WorkflowRun): void {
    const controller = new AbortController()
    const entry: { controller: AbortController; done: Promise<WorkflowRun>; reason?: string } = { controller, done: Promise.resolve(run) }
    entry.done = this.drive(run, controller, entry).finally(() => {
      this.active.delete(run.id)
    })
    this.active.set(run.id, entry)
  }

  private persist(run: WorkflowRun, nodeId?: string): void {
    this.deps.store.saveRun(run)
    if (nodeId !== undefined) this.emit({ type: 'node', runId: run.id, nodeId, evidence: run.nodes[nodeId]! })
    else this.emit({ type: 'run', run: summarize(run) })
  }

  private scope(run: WorkflowRun, loop?: TemplateScope['loop']): TemplateScope {
    return {
      inputs: run.inputs,
      nodes: Object.fromEntries(
        Object.entries(run.nodes).map(([id, n]) => [id, { output: n.output, status: n.status, ...(n.error !== undefined ? { error: n.error } : {}) }]),
      ),
      run: { id: run.id, workflowId: run.workflowId, trigger: run.trigger.kind },
      ...(loop !== undefined ? { loop } : {}),
    }
  }

  private async drive(run: WorkflowRun, controller: AbortController, entry: { reason?: string }): Promise<WorkflowRun> {
    const workflow = run.snapshot
    const inbound = new Map<string, typeof workflow.edges>(workflow.nodes.map(n => [n.id, []]))
    const outbound = new Map<string, typeof workflow.edges>(workflow.nodes.map(n => [n.id, []]))
    for (const edge of workflow.edges) {
      inbound.get(edge.target)?.push(edge)
      outbound.get(edge.source)?.push(edge)
    }
    const concurrency = Math.max(1, Math.min(16, workflow.concurrency ?? this.deps.defaultConcurrency ?? 4))
    const deadlineMs = workflow.deadlineMs ?? this.deps.defaultDeadlineMs
    const deadline = deadlineMs !== undefined ? setTimeout(() => this.cancel(run.id, `run deadline of ${deadlineMs} ms exceeded`), deadlineMs) : undefined
    run.status = 'running'
    run.startedAt ??= nowIso()
    this.persist(run)

    const finished = (id: string): boolean => {
      const n = run.nodes[id]!
      return n.status === 'succeeded' || n.status === 'skipped' || (n.status === 'failed' && n.route !== undefined)
    }
    const edgeState = (edge: (typeof workflow.edges)[number]): 'taken' | 'dead' | 'open' => {
      const source = run.nodes[edge.source]!
      if (!finished(edge.source)) return 'open'
      if (source.status === 'skipped') return 'dead'
      const route = edge.route ?? 'success'
      return source.route === route ? 'taken' : 'dead'
    }

    const running = new Map<string, Promise<void>>()
    let unhandledFailure: string | undefined
    try {
      for (;;) {
        if (controller.signal.aborted) break
        // Skip propagation and readiness.
        let progressed = true
        while (progressed) {
          progressed = false
          for (const node of workflow.nodes) {
            const evidence = run.nodes[node.id]!
            if (evidence.status !== 'pending' || running.has(node.id)) continue
            const edges = inbound.get(node.id)!
            if (edges.length === 0) continue
            const states = edges.map(edgeState)
            if (states.includes('open')) continue
            if (!states.includes('taken')) {
              evidence.status = 'skipped'
              evidence.endedAt = nowIso()
              this.persist(run, node.id)
              progressed = true
            }
          }
        }
        const ready = workflow.nodes.filter(node => {
          const evidence = run.nodes[node.id]!
          if (evidence.status !== 'pending' || running.has(node.id)) return false
          const states = inbound.get(node.id)!.map(edgeState)
          return !states.includes('open') && (states.length === 0 || states.includes('taken'))
        })
        for (const node of ready) {
          if (running.size >= concurrency) break
          run.nodes[node.id]!.status = 'queued'
          const task = this.runNode(run, node, controller.signal, outbound.get(node.id)!.some(e => e.route === 'failure'))
            .then(() => {
              const evidence = run.nodes[node.id]!
              if (evidence.status === 'failed' && evidence.route === undefined) unhandledFailure ??= `${node.name}: ${evidence.error ?? 'failed'}`
            })
            .catch((error: unknown) => {
              if (!(error instanceof RunAbort)) unhandledFailure ??= `${node.name}: ${errorMessage(error)}`
            })
            .finally(() => running.delete(node.id))
          running.set(node.id, task)
        }
        if (running.size === 0) break
        // Reflect "waiting" when only approval gates are pending.
        const anyWaiting = Object.values(run.nodes).some(n => n.status === 'waiting')
        const anyRunning = Object.values(run.nodes).some(n => n.status === 'running')
        const nextStatus: RunStatus = anyWaiting && !anyRunning ? 'waiting' : 'running'
        if (run.status !== nextStatus) {
          run.status = nextStatus
          this.persist(run)
        }
        await Promise.race(running.values())
        this.checkBudget(run)
      }
      await Promise.allSettled(running.values())
    } catch (error: unknown) {
      if (!(error instanceof RunAbort)) unhandledFailure ??= errorMessage(error)
      controller.abort(new RunAbort(errorMessage(error)))
      await Promise.allSettled(running.values())
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
    }

    const outputs = workflow.nodes.filter(n => n.type === 'output' && run.nodes[n.id]!.status === 'succeeded')
    if (outputs.length === 1) run.output = run.nodes[outputs[0]!.id]!.output
    else if (outputs.length > 1) run.output = Object.fromEntries(outputs.map(n => [n.name || n.id, run.nodes[n.id]!.output]))

    if (controller.signal.aborted) {
      const reason = entry.reason ?? 'cancelled'
      for (const evidence of Object.values(run.nodes)) {
        if (evidence.status === 'running' || evidence.status === 'queued' || evidence.status === 'waiting') {
          evidence.status = 'cancelled'
          evidence.endedAt = nowIso()
        }
      }
      run.status = reason.startsWith('interrupted') ? 'interrupted' : /deadline|budget/.test(reason) ? 'failed' : 'cancelled'
      run.error = reason
    } else if (unhandledFailure !== undefined) {
      run.status = 'failed'
      run.error = unhandledFailure
    } else {
      run.status = 'succeeded'
    }
    run.endedAt = nowIso()
    this.persist(run)
    return run
  }

  private checkBudget(run: WorkflowRun): void {
    const budget = run.snapshot.budget
    if (budget === undefined) return
    if (budget.maxNodeRuns !== undefined && run.usage.nodeRuns > budget.maxNodeRuns) this.cancel(run.id, `budget exceeded: more than ${budget.maxNodeRuns} node runs`)
    const tokens = run.usage.inputTokens + run.usage.outputTokens
    if (budget.maxTokens !== undefined && tokens > budget.maxTokens) this.cancel(run.id, `budget exceeded: ${tokens} tokens > ${budget.maxTokens}`)
  }

  private async runNode(run: WorkflowRun, node: WorkflowNode, runSignal: AbortSignal, hasFailureEdge: boolean): Promise<void> {
    const evidence = run.nodes[node.id]!
    evidence.status = 'running'
    evidence.startedAt = nowIso()
    delete evidence.endedAt
    this.persist(run, node.id)
    const trace = (line: string): void => {
      const clean = redact(line).slice(0, 2000)
      evidence.trace.push(clean)
      if (evidence.trace.length > 500) evidence.trace.splice(0, evidence.trace.length - 500)
      this.emit({ type: 'trace', runId: run.id, nodeId: node.id, line: clean })
    }
    const maxAttempts = 1 + Math.max(0, Math.min(LIMITS.maxRetries, node.retry?.max ?? 0))
    let lastError = ''
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (runSignal.aborted) throw new RunAbort('cancelled')
      run.usage.nodeRuns += 1
      const record = { attempt, startedAt: nowIso(), status: 'succeeded' as 'succeeded' | 'failed' | 'cancelled' } as (typeof evidence.attempts)[number]
      evidence.attempts.push(record)
      const timeout = node.timeoutMs !== undefined ? AbortSignal.timeout(node.timeoutMs) : undefined
      const signal = timeout !== undefined ? AbortSignal.any([runSignal, timeout]) : runSignal
      try {
        const result = await this.executeNode(run, node, signal, trace, evidence)
        record.endedAt = nowIso()
        evidence.output = result.output
        evidence.route = result.route
        if (result.usage !== undefined) {
          evidence.usage = {
            inputTokens: (evidence.usage?.inputTokens ?? 0) + result.usage.inputTokens,
            outputTokens: (evidence.usage?.outputTokens ?? 0) + result.usage.outputTokens,
          }
          run.usage.inputTokens += result.usage.inputTokens
          run.usage.outputTokens += result.usage.outputTokens
        }
        if (result.artifacts !== undefined) evidence.artifacts.push(...result.artifacts)
        if (result.route === 'failure') {
          // Node decided to route to failure (e.g. approval rejected).
          evidence.status = 'failed'
          evidence.error = result.error ?? 'routed to failure'
          if (!hasFailureEdge && !node.continueOnFailure) delete evidence.route
          else if (!hasFailureEdge && node.continueOnFailure) evidence.route = 'success'
        } else {
          evidence.status = 'succeeded'
          delete evidence.error
        }
        evidence.endedAt = nowIso()
        this.persist(run, node.id)
        return
      } catch (error: unknown) {
        record.endedAt = nowIso()
        if (runSignal.aborted) {
          record.status = 'cancelled'
          evidence.status = 'cancelled'
          evidence.endedAt = nowIso()
          this.persist(run, node.id)
          throw new RunAbort('cancelled')
        }
        record.status = 'failed'
        lastError = timeout?.aborted === true ? `timed out after ${node.timeoutMs} ms` : errorMessage(error)
        record.error = lastError
        trace(`attempt ${attempt}/${maxAttempts} failed: ${lastError}`)
        this.persist(run, node.id)
        if (attempt < maxAttempts) {
          const wait = Math.min(60_000, (node.retry?.backoffMs ?? 1000) * 2 ** (attempt - 1))
          trace(`retrying in ${wait} ms`)
          await delay(wait, runSignal)
        }
      }
    }
    evidence.status = 'failed'
    evidence.error = lastError
    evidence.endedAt = nowIso()
    if (hasFailureEdge) evidence.route = 'failure'
    else if (node.continueOnFailure) {
      evidence.route = 'success'
      evidence.output = { error: lastError }
      trace('continuing on failure')
    } else delete evidence.route
    this.persist(run, node.id)
  }

  private async executeNode(
    run: WorkflowRun,
    node: WorkflowNode,
    signal: AbortSignal,
    trace: (line: string) => void,
    evidence: NodeEvidence,
  ): Promise<StepResult & { route: EdgeRoute; error?: string }> {
    const scope = this.scope(run)
    const ctx: StepContext = { run, node, scope, signal, trace }
    switch (node.type) {
      case 'input':
        evidence.input = redactDeep(run.inputs)
        return { output: run.inputs, route: 'success' }
      case 'output': {
        const value = node.config.value !== undefined ? renderDeep(node.config.value, scope) : this.upstreamOutputs(run, node)
        evidence.input = redactDeep(node.config)
        return { output: value, route: 'success' }
      }
      case 'condition': {
        const expression = String(node.config.expression ?? '')
        const result = evaluate(expression, scope)
        evidence.input = { expression }
        trace(`${expression} → ${String(result)}`)
        return { output: result, route: result ? 'true' : 'false' }
      }
      case 'approval':
        return this.approval(run, node, signal, trace, evidence, scope)
      case 'loop':
        return { ...(await this.loop(run, node, ctx, evidence)), route: 'success' }
      default: {
        const executor = this.deps.executors[node.type as 'agent']
        if (executor === undefined) throw new Error(`no executor for ${node.type} nodes`)
        if (node.type === 'script' && !this.scriptsAllowed()) throw new Error('script nodes are disabled (enable them in DSH-LULUX Flow settings, or set allowScriptNodes: true in the plugin config)')
        const config = renderDeep(node.config, scope) as Record<string, unknown>
        evidence.input = redactDeep(config)
        const result = await executor(config, ctx)
        return { ...result, route: 'success' }
      }
    }
  }

  private upstreamOutputs(run: WorkflowRun, node: WorkflowNode): unknown {
    const sources = run.snapshot.edges.filter(e => e.target === node.id).map(e => e.source)
    const done = sources.filter(id => run.nodes[id]?.status === 'succeeded' || run.nodes[id]?.route !== undefined)
    if (done.length === 1) return run.nodes[done[0]!]!.output
    return Object.fromEntries(done.map(id => [id, run.nodes[id]!.output]))
  }

  private async approval(
    run: WorkflowRun,
    node: WorkflowNode,
    signal: AbortSignal,
    trace: (line: string) => void,
    evidence: NodeEvidence,
    scope: TemplateScope,
  ): Promise<StepResult & { route: EdgeRoute; error?: string }> {
    const message = String(renderString(String(node.config.message ?? 'Approve to continue?'), scope))
    evidence.input = { message }
    evidence.status = 'waiting'
    this.persist(run, node.id)
    this.persist(run)
    trace('waiting for approval')
    const key = `${run.id}:${node.id}`
    const timeoutMs = Number(node.config.timeoutMs ?? 0)
    const onTimeout = node.config.onTimeout === 'approve' ? 'approve' : 'reject'
    const local = new AbortController()
    const decision = await new Promise<{ approved: boolean; by: string; note?: string }>((resolve, reject) => {
      let settled = false
      const settle = (value: { approved: boolean; by: string; note?: string }): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const timer = timeoutMs > 0 ? setTimeout(() => settle({ approved: onTimeout === 'approve', by: 'timeout' }), timeoutMs) : undefined
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new RunAbort('cancelled'))
      }
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.waiters.delete(key)
        local.abort()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.set(key, { resolve: settle })
      this.externalApproval
        ?.ask(run, node, message, local.signal)
        .then(result => {
          if (result !== undefined) settle(result)
        })
        .catch(() => undefined)
    })
    evidence.status = 'running'
    evidence.decision = { approved: decision.approved, by: decision.by, at: nowIso(), ...(decision.note !== undefined ? { note: decision.note } : {}) }
    trace(`${decision.approved ? 'approved' : 'rejected'} by ${decision.by}`)
    const output = { approved: decision.approved, by: decision.by, ...(decision.note !== undefined ? { note: decision.note } : {}) }
    return decision.approved ? { output, route: 'success' } : { output, route: 'failure', error: `rejected by ${decision.by}` }
  }

  private async loop(run: WorkflowRun, node: WorkflowNode, ctx: StepContext, evidence: NodeEvidence): Promise<StepResult> {
    const config = node.config
    const max = Math.min(LIMITS.maxLoopIterations, Math.max(1, Number(config.maxIterations ?? 10)))
    const body = (config.body ?? {}) as { type?: string; config?: Record<string, unknown> }
    const executor = this.deps.executors[body.type as 'agent']
    if (executor === undefined || !['agent', 'kernel', 'script', 'http'].includes(String(body.type))) throw new Error('loop body must be an agent, kernel, script or http step')
    if (body.type === 'script' && !this.scriptsAllowed()) throw new Error('script nodes are disabled')
    const mode = config.mode === 'until' ? 'until' : config.count !== undefined && config.items === undefined ? 'count' : 'items'
    let items: unknown[] = []
    if (mode === 'items') {
      const resolved = renderDeep(config.items, this.scope(run))
      const list = typeof resolved === 'string' ? (JSON.parse(resolved) as unknown) : resolved
      if (!Array.isArray(list)) throw new Error('loop items did not resolve to an array')
      if (list.length > max) ctx.trace(`items truncated from ${list.length} to maxIterations=${max}`)
      items = list.slice(0, max)
    } else if (mode === 'count') {
      const count = Math.min(max, Math.max(0, Math.trunc(Number(renderDeep(config.count, this.scope(run))))))
      items = Array.from({ length: count }, (_, i) => i)
    }
    evidence.input = redactDeep({ mode, maxIterations: max, items: mode === 'items' ? items : undefined, body })
    const results: unknown[] = []
    let previous: unknown
    const usage = { inputTokens: 0, outputTokens: 0 }
    const total = mode === 'until' ? max : items.length
    for (let index = 0; index < total; index += 1) {
      if (ctx.signal.aborted) throw new RunAbort('cancelled')
      const loopScope = this.scope(run, { item: mode === 'until' ? index : items[index], index, previous })
      const stepConfig = renderDeep(body.config ?? {}, loopScope) as Record<string, unknown>
      ctx.trace(`iteration ${index + 1}/${total}`)
      const result = await executor(stepConfig, { ...ctx, scope: loopScope })
      run.usage.nodeRuns += 1
      if (result.usage !== undefined) {
        usage.inputTokens += result.usage.inputTokens
        usage.outputTokens += result.usage.outputTokens
      }
      results.push(result.output)
      previous = result.output
      this.checkBudget(run)
      if (mode === 'until') {
        const done = evaluate(String(config.until), this.scope(run, { item: index, index, previous }))
        if (done) {
          ctx.trace(`until condition met after ${index + 1} iteration(s)`)
          break
        }
        if (index === total - 1) ctx.trace(`stopped at maxIterations=${max} without meeting the until condition`)
      }
    }
    return { output: { iterations: results.length, results, last: previous }, usage }
  }
}
