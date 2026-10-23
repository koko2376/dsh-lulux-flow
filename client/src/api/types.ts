/**
 * Wire types of the plugin HTTP API. Graph, run and kernel shapes are imported
 * type-only from the Host source so the two halves cannot drift.
 */
import type {
  EdgeRoute,
  NodeEvidence,
  NodeStatus,
  NodeType,
  RunStatus,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunSummary,
  EngineEvent,
  CronTrigger,
  WorkflowInputSpec,
  WorkflowReview,
  WorkflowReviewSource,
} from '../../../src/workflow/types.js'
import type { LintIssue } from '../../../src/workflow/validate.js'
import type { KernelInfo } from '../../../src/kernels/service.js'
import type { InstallState, InstallStatus } from '../../../src/kernels/installer.js'
import type { ProbeResult, RankedRegistries } from '../../../src/kernels/registry-probe.js'
import type { KernelMode, KernelPermission } from '../../../src/kernels/types.js'
import type { LuluxFlowSettings, KernelSettings } from '../../../src/settings.js'
import type { CheckOutcome, UpdateSourceMode, UpdateStatus } from '../../../src/update/service.js'

export type {
  CheckOutcome,
  UpdateSourceMode,
  UpdateStatus,
  EdgeRoute,
  NodeEvidence,
  NodeStatus,
  NodeType,
  RunStatus,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunSummary,
  EngineEvent,
  CronTrigger,
  WorkflowInputSpec,
  WorkflowReview,
  WorkflowReviewSource,
  LintIssue,
  KernelInfo,
  InstallState,
  InstallStatus,
  ProbeResult,
  RankedRegistries,
  KernelMode,
  KernelPermission,
  LuluxFlowSettings,
  KernelSettings,
}

export const NODE_TYPES: readonly NodeType[] = ['input', 'output', 'agent', 'kernel', 'script', 'http', 'condition', 'loop', 'approval', 'notify']
export const PERMISSIONS: readonly KernelPermission[] = ['read-only', 'ask', 'edit', 'full']

const RANK: Record<KernelPermission, number> = { 'read-only': 0, ask: 1, edit: 2, full: 3 }

/** Levels a CLI can enforce (older Hosts do not send them: then every level). */
export function permissionsFor(kernel: Pick<KernelInfo, 'permissions'> | undefined): readonly KernelPermission[] {
  return kernel?.permissions?.length ? kernel.permissions : PERMISSIONS
}

/** Whether `a` grants more than `b`. */
export function exceeds(a: KernelPermission, b: KernelPermission): boolean {
  return RANK[a] > RANK[b]
}

export interface Meta {
  brand: { id: string; displayName: string }
  version: string
  scriptsAllowed: boolean
  gateway: { listening: boolean }
  upstream: { provider: string; model: string } | null
  /** Where the gateway's real model came from (newer Hosts). */
  upstreamSource?: 'node' | 'setting' | 'dsh-default' | 'remembered' | null
  /** Who turned script nodes on: the plugin Config (read-only here) or the runtime setting. */
  scriptsSource?: 'config' | 'settings' | null
  /** Set when no real model is known; shown as a banner. */
  upstreamError?: string | null
}

export interface WorkflowListItem {
  id: string
  name: string
  description: string
  nodes: number
  updatedAt: string
  lastRun: WorkflowRun | WorkflowRunSummary | null
  /** Older Hosts omit it. */
  review?: { status: WorkflowReview['status']; source: WorkflowReviewSource }
}

/**
 * Review state the Host attaches to a workflow. `runnable` is false until a
 * person approves the current content; Approve must echo `digest` back.
 */
export interface ReviewInfo extends WorkflowReview {
  digest: string
  runnable: boolean
  problem: string | null
}

export interface WebhookInfo {
  configured: boolean
  fingerprint: string | null
  path: string
}

export interface WorkflowDetail {
  workflow: Workflow
  issues: LintIssue[]
  webhook?: WebhookInfo
  review?: ReviewInfo
}

export interface WebhookSecret {
  secret: string
  path: string
  note: string
}

/** Settings as the client edits them (same shape as the Host's persisted settings). */
export type FlowSettingsView = LuluxFlowSettings

/** Routes each node type may start. */
export function routesFor(type: NodeType): readonly EdgeRoute[] {
  if (type === 'condition') return ['true', 'false']
  if (type === 'output') return []
  return ['success', 'failure']
}
