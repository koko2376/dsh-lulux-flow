/** Workflow graph, run and evidence model (persisted as JSON, schemaVersion 1). */

export const NODE_TYPES = ['input', 'output', 'agent', 'kernel', 'script', 'http', 'condition', 'loop', 'approval', 'notify'] as const
export type NodeType = (typeof NODE_TYPES)[number]

/** Edge routes. `success`/`failure` for ordinary nodes, `true`/`false` for conditions. */
export const EDGE_ROUTES = ['success', 'failure', 'true', 'false'] as const
export type EdgeRoute = (typeof EDGE_ROUTES)[number]

export interface RetryPolicy {
  /** Extra attempts after the first (0–10). */
  max: number
  /** Delay before the first retry; doubles each time (capped at 60 s). */
  backoffMs: number
}

export interface WorkflowNode {
  id: string
  type: NodeType
  name: string
  position: { x: number; y: number }
  config: Record<string, unknown>
  retry?: RetryPolicy
  timeoutMs?: number
  /** On failure without a failure edge, continue as success with `{ error }` as output. */
  continueOnFailure?: boolean
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  route?: EdgeRoute
}

export interface WorkflowInputSpec {
  name: string
  type: 'string' | 'number' | 'boolean' | 'json'
  required?: boolean
  default?: unknown
  description?: string
}

export interface WorkflowBudget {
  /** Maximum node executions (attempts) per run. */
  maxNodeRuns?: number
  /** Maximum total tokens reported by agent/kernel nodes. */
  maxTokens?: number
}

export interface CronTrigger {
  id: string
  expression: string
  enabled: boolean
  inputs?: Record<string, unknown>
}

export interface WorkflowTriggers {
  cron?: CronTrigger[]
  webhook?: { enabled: boolean }
}

/** Who wrote the current content: the user in the canvas, the model, the AI generator, an import, or an older version. */
export type WorkflowReviewSource = 'user' | 'model' | 'generated' | 'import' | 'legacy'

export interface WorkflowReview {
  status: 'unreviewed' | 'approved'
  source: WorkflowReviewSource
  /** Digest of the executable content that was approved (see review.ts). */
  digest?: string
  by?: string
  at?: string
}

export interface Workflow {
  schemaVersion: 1
  id: string
  name: string
  description?: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  inputs?: WorkflowInputSpec[]
  budget?: WorkflowBudget
  /** Wall-clock deadline for a whole run, in ms. */
  deadlineMs?: number
  /** Maximum nodes executing at once (default 4). */
  concurrency?: number
  triggers?: WorkflowTriggers
  /** Server-controlled review state; never taken from imported or submitted JSON. */
  review?: WorkflowReview
  createdAt: string
  updatedAt: string
}

export type NodeStatus = 'pending' | 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type TriggerKind = 'canvas' | 'chat' | 'cron' | 'webhook' | 'api' | 'rerun'

export interface NodeAttempt {
  attempt: number
  startedAt: string
  endedAt?: string
  status: 'succeeded' | 'failed' | 'cancelled'
  error?: string
}

export interface NodeArtifact {
  name: string
  kind: 'text' | 'json' | 'file'
  /** Inline value for text/json; path for file. */
  value: string
}

export interface NodeEvidence {
  status: NodeStatus
  /** Route taken (success/failure/true/false) once finished. */
  route?: EdgeRoute
  /** Resolved configuration actually used (templates rendered, secrets redacted). */
  input?: unknown
  output?: unknown
  error?: string
  attempts: NodeAttempt[]
  /** Short human-readable trace lines (tool calls, retries, decisions). */
  trace: string[]
  artifacts: NodeArtifact[]
  usage?: { inputTokens: number; outputTokens: number }
  startedAt?: string
  endedAt?: string
  /** For approval nodes: who decided and how. */
  decision?: { approved: boolean; by: string; at: string; note?: string }
}

export interface WorkflowRun {
  schemaVersion: 1
  id: string
  workflowId: string
  workflowName: string
  status: RunStatus
  trigger: { kind: TriggerKind; detail?: string }
  inputs: Record<string, unknown>
  /** Frozen copy of the workflow at run start; edits never affect a run. */
  snapshot: Workflow
  nodes: Record<string, NodeEvidence>
  output?: unknown
  error?: string
  createdAt: string
  startedAt?: string
  endedAt?: string
  /** Resume history: each resume increments this. */
  resumes: number
  usage: { inputTokens: number; outputTokens: number; nodeRuns: number }
  /** Parent run when this run was created by "rerun". */
  rerunOf?: string
}

/** Live events streamed to the canvas over SSE. */
export type EngineEvent =
  | { type: 'run'; run: WorkflowRunSummary }
  | { type: 'node'; runId: string; nodeId: string; evidence: NodeEvidence }
  | { type: 'trace'; runId: string; nodeId: string; line: string }
  | { type: 'workflow'; workflowId: string; deleted?: boolean }

export interface WorkflowRunSummary {
  id: string
  workflowId: string
  workflowName: string
  status: RunStatus
  trigger: WorkflowRun['trigger']
  createdAt: string
  startedAt?: string
  endedAt?: string
  error?: string
  usage: WorkflowRun['usage']
  waitingApprovals: string[]
}

export function summarize(run: WorkflowRun): WorkflowRunSummary {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    trigger: run.trigger,
    createdAt: run.createdAt,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    usage: run.usage,
    waitingApprovals: Object.entries(run.nodes)
      .filter(([, n]) => n.status === 'waiting')
      .map(([id]) => id),
  }
}
