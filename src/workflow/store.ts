/**
 * File-backed persistence for workflows, runs and webhook secrets under the
 * plugin data directory. Every write is atomic (temp + rename); every path is
 * derived from a validated id and checked to stay inside the data directory.
 */
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { assertSafeId, readJsonFile, safeJoin, writeJsonAtomic } from '../util/fs.js'
import { summarize, type Workflow, type WorkflowRun, type WorkflowRunSummary } from './types.js'

export class WorkflowStore {
  private readonly workflowsDir: string
  private readonly runsDir: string
  private readonly secretsFile: string
  private runIndex: Map<string, WorkflowRunSummary> | undefined

  constructor(
    private readonly dataDir: string,
    private readonly maxRunsPerWorkflow = 200,
  ) {
    this.workflowsDir = safeJoin(dataDir, 'workflows')
    this.runsDir = safeJoin(dataDir, 'runs')
    this.secretsFile = safeJoin(dataDir, 'secrets', 'webhooks.json')
    mkdirSync(this.workflowsDir, { recursive: true, mode: 0o700 })
    mkdirSync(this.runsDir, { recursive: true, mode: 0o700 })
  }

  get root(): string {
    return this.dataDir
  }

  // ── workflows ──────────────────────────────────────────────────────────────

  listWorkflows(): Workflow[] {
    const out: Workflow[] = []
    for (const file of readdirSync(this.workflowsDir)) {
      if (!file.endsWith('.json')) continue
      const wf = readJsonFile<Workflow>(safeJoin(this.workflowsDir, file))
      if (wf !== undefined && wf.schemaVersion === 1) out.push(wf)
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  getWorkflow(id: string): Workflow | undefined {
    return readJsonFile<Workflow>(safeJoin(this.workflowsDir, `${assertSafeId(id, 'workflow id')}.json`))
  }

  saveWorkflow(workflow: Workflow): Workflow {
    writeJsonAtomic(safeJoin(this.workflowsDir, `${assertSafeId(workflow.id, 'workflow id')}.json`), workflow)
    return workflow
  }

  deleteWorkflow(id: string): boolean {
    const file = safeJoin(this.workflowsDir, `${assertSafeId(id, 'workflow id')}.json`)
    const existed = readJsonFile(file) !== undefined
    rmSync(file, { force: true })
    this.deleteWebhookSecret(id)
    return existed
  }

  newId(prefix = 'wf'): string {
    return `${prefix}_${randomBytes(8).toString('hex')}`
  }

  // ── runs ───────────────────────────────────────────────────────────────────

  private index(): Map<string, WorkflowRunSummary> {
    if (this.runIndex === undefined) {
      this.runIndex = new Map()
      for (const file of readdirSync(this.runsDir)) {
        if (!file.endsWith('.json')) continue
        const run = readJsonFile<WorkflowRun>(safeJoin(this.runsDir, file))
        if (run !== undefined && run.schemaVersion === 1) this.runIndex.set(run.id, summarize(run))
      }
    }
    return this.runIndex
  }

  getRun(id: string): WorkflowRun | undefined {
    return readJsonFile<WorkflowRun>(safeJoin(this.runsDir, `${assertSafeId(id, 'run id')}.json`))
  }

  saveRun(run: WorkflowRun): void {
    writeJsonAtomic(safeJoin(this.runsDir, `${assertSafeId(run.id, 'run id')}.json`), run)
    const isNew = !this.index().has(run.id)
    this.index().set(run.id, summarize(run))
    if (isNew) this.prune(run.workflowId)
  }

  listRuns(filter: { workflowId?: string; limit?: number } = {}): WorkflowRunSummary[] {
    const all = [...this.index().values()].filter(r => filter.workflowId === undefined || r.workflowId === filter.workflowId)
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return all.slice(0, filter.limit ?? 100)
  }

  deleteRun(id: string): void {
    rmSync(safeJoin(this.runsDir, `${assertSafeId(id, 'run id')}.json`), { force: true })
    this.index().delete(id)
  }

  private prune(workflowId: string): void {
    const runs = this.listRuns({ workflowId, limit: Number.MAX_SAFE_INTEGER })
    const active = new Set(['queued', 'running', 'waiting'])
    for (const run of runs.slice(this.maxRunsPerWorkflow)) if (!active.has(run.status)) this.deleteRun(run.id)
  }

  // ── webhook secrets (0600 file, only digests are ever returned) ────────────

  private secrets(): Record<string, string> {
    return readJsonFile<Record<string, string>>(this.secretsFile) ?? {}
  }

  /** Create or rotate a workflow's webhook secret. The plaintext is returned once. */
  rotateWebhookSecret(workflowId: string): string {
    assertSafeId(workflowId, 'workflow id')
    const secret = `whsec_${randomBytes(24).toString('base64url')}`
    writeJsonAtomic(this.secretsFile, { ...this.secrets(), [workflowId]: secret })
    return secret
  }

  webhookSecret(workflowId: string): string | undefined {
    const all = this.secrets()
    return Object.hasOwn(all, workflowId) && typeof all[workflowId] === 'string' ? all[workflowId] : undefined
  }

  webhookFingerprint(workflowId: string): string | undefined {
    const secret = this.webhookSecret(workflowId)
    return secret === undefined ? undefined : createHash('sha256').update(secret).digest('hex').slice(0, 12)
  }

  deleteWebhookSecret(workflowId: string): void {
    const all = this.secrets()
    if (Object.hasOwn(all, workflowId)) {
      delete all[workflowId]
      writeJsonAtomic(this.secretsFile, all)
    }
  }
}
