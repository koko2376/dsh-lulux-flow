/**
 * Structural validation ("lint") of a workflow graph and normalization of
 * imported JSON. A run only starts from a graph without errors.
 */
import { checkExpression } from './expr.js'
import { referencesIn } from './template.js'
import { EDGE_ROUTES, NODE_TYPES, type EdgeRoute, type NodeType, type Workflow, type WorkflowEdge, type WorkflowNode } from './types.js'
import { SAFE_ID } from '../util/fs.js'
import { isMode, isPermission } from '../kernels/policy.js'
import { LITERAL_FIELDS } from './review.js'

export interface LintIssue {
  level: 'error' | 'warning'
  message: string
  nodeId?: string
  edgeId?: string
}

export const LIMITS = {
  maxNodes: 200,
  maxNodeName: 120,
  maxEdges: 600,
  maxLoopIterations: 100,
  maxRetries: 10,
  maxTimeoutMs: 6 * 3600_000,
} as const

export function routesFor(type: NodeType): readonly EdgeRoute[] {
  if (type === 'condition') return ['true', 'false']
  if (type === 'output') return []
  return ['success', 'failure']
}

/** Topological order; returns undefined when the graph has a cycle. */
export function topoOrder(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[]): string[] | undefined {
  const indegree = new Map(nodes.map(n => [n.id, 0]))
  const out = new Map<string, string[]>(nodes.map(n => [n.id, []]))
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    out.get(edge.source)!.push(edge.target)
  }
  const queue = nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of out.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1
      indegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  return order.length === nodes.length ? order : undefined
}

/** Privilege-bearing fields must be literals: templates there would let run inputs choose privileges. */
function checkLiteralFields(type: string, config: Record<string, unknown>, nodeId: string, err: (message: string, extra?: Partial<LintIssue>) => void, where = ''): void {
  for (const field of LITERAL_FIELDS[type] ?? []) {
    const value = config[field]
    if (value === undefined || value === '') continue
    if (typeof value !== 'string') err(`${where}${type} "${field}" must be a string`, { nodeId })
    else if (value.includes('{{')) err(`${where}${type} "${field}" cannot use templates (it decides privileges); set a fixed value`, { nodeId })
  }
  if (type === 'kernel') {
    if (config.mode !== undefined && config.mode !== '' && !isMode(config.mode)) err(`${where}kernel mode must be "scoped" or "global"`, { nodeId })
    if (config.permission !== undefined && config.permission !== '' && !isPermission(config.permission)) err(`${where}kernel permission must be read-only, ask, edit or full`, { nodeId })
  }
}

export function lintWorkflow(workflow: Workflow, options: { scriptsAllowed: boolean; knownKernels?: readonly string[] } = { scriptsAllowed: false }): LintIssue[] {
  const issues: LintIssue[] = []
  const err = (message: string, extra: Partial<LintIssue> = {}): void => void issues.push({ level: 'error', message, ...extra })
  const warn = (message: string, extra: Partial<LintIssue> = {}): void => void issues.push({ level: 'warning', message, ...extra })

  if (!SAFE_ID.test(workflow.id)) err('workflow id must match [A-Za-z0-9_-]{1,64}')
  if (!workflow.name.trim()) err('workflow name is required')
  if (workflow.nodes.length === 0) err('workflow has no nodes')
  if (workflow.nodes.length > LIMITS.maxNodes) err(`too many nodes (max ${LIMITS.maxNodes})`)
  if (workflow.edges.length > LIMITS.maxEdges) err(`too many edges (max ${LIMITS.maxEdges})`)

  const ids = new Set<string>()
  for (const node of workflow.nodes) {
    if (!SAFE_ID.test(node.id)) err(`invalid node id "${node.id}"`, { nodeId: node.id })
    if (ids.has(node.id)) err(`duplicate node id "${node.id}"`, { nodeId: node.id })
    ids.add(node.id)
    if (!(NODE_TYPES as readonly string[]).includes(node.type)) err(`unknown node type "${node.type}"`, { nodeId: node.id })
    if (node.name.length > LIMITS.maxNodeName) err(`node name is too long (max ${LIMITS.maxNodeName} characters)`, { nodeId: node.id })
    if (node.retry !== undefined && (node.retry.max < 0 || node.retry.max > LIMITS.maxRetries)) err(`retry.max must be 0–${LIMITS.maxRetries}`, { nodeId: node.id })
    if (node.timeoutMs !== undefined && (node.timeoutMs <= 0 || node.timeoutMs > LIMITS.maxTimeoutMs)) err('timeoutMs out of range', { nodeId: node.id })
    const c = node.config
    checkLiteralFields(node.type, c, node.id, err)
    if (node.type === 'loop') {
      const body = (c.body ?? {}) as { type?: string; config?: Record<string, unknown> }
      if (body.config !== null && typeof body.config === 'object') checkLiteralFields(String(body.type ?? ''), body.config, node.id, err, 'loop body: ')
    }
    switch (node.type) {
      case 'agent':
        if (typeof c.prompt !== 'string' || !c.prompt.trim()) err('agent node needs a prompt', { nodeId: node.id })
        break
      case 'kernel':
        if (typeof c.prompt !== 'string' || !c.prompt.trim()) err('kernel node needs a prompt', { nodeId: node.id })
        if (typeof c.kernel !== 'string' || !c.kernel) err('kernel node needs a kernel id', { nodeId: node.id })
        else if (options.knownKernels !== undefined && !options.knownKernels.includes(c.kernel)) err(`unknown kernel "${c.kernel}"`, { nodeId: node.id })
        break
      case 'script':
        if (typeof c.code !== 'string' || !c.code.trim()) err('script node needs code', { nodeId: node.id })
        if (!options.scriptsAllowed) warn('script nodes are disabled (they can only be enabled with allowScriptNodes: true in the plugin config); this node will fail', { nodeId: node.id })
        break
      case 'http':
      case 'notify':
        if (typeof c.url !== 'string' || !c.url.trim()) err(`${node.type} node needs a url`, { nodeId: node.id })
        break
      case 'condition': {
        const problem = typeof c.expression === 'string' ? checkExpression(c.expression) : 'condition node needs an expression'
        if (problem !== undefined) err(`condition: ${problem}`, { nodeId: node.id })
        break
      }
      case 'loop': {
        const max = Number(c.maxIterations ?? 10)
        if (!(max >= 1 && max <= LIMITS.maxLoopIterations)) err(`loop maxIterations must be 1–${LIMITS.maxLoopIterations}`, { nodeId: node.id })
        const body = c.body as { type?: string } | undefined
        if (body === undefined || !['agent', 'kernel', 'script', 'http'].includes(String(body.type))) err('loop body must be an agent, kernel, script or http step', { nodeId: node.id })
        if (c.mode === 'until') {
          const problem = typeof c.until === 'string' ? checkExpression(c.until) : 'loop "until" mode needs an until expression'
          if (problem !== undefined) err(`loop: ${problem}`, { nodeId: node.id })
        } else if (c.items === undefined && c.count === undefined) err('loop needs items, count, or until', { nodeId: node.id })
        break
      }
      default:
        break
    }
    for (const ref of referencesIn(node.config)) {
      const match = /^nodes\.([A-Za-z0-9_-]+)/.exec(ref)
      if (match !== null && !workflow.nodes.some(n => n.id === match[1])) err(`reference to unknown node "${match[1]}"`, { nodeId: node.id })
      if (!/^(inputs|nodes|run|loop)\b/.test(ref)) warn(`variable "${ref}" does not start with inputs., nodes., run. or loop.`, { nodeId: node.id })
    }
  }

  const edgeIds = new Set<string>()
  for (const edge of workflow.edges) {
    if (edgeIds.has(edge.id)) err(`duplicate edge id "${edge.id}"`, { edgeId: edge.id })
    edgeIds.add(edge.id)
    const source = workflow.nodes.find(n => n.id === edge.source)
    if (source === undefined || !ids.has(edge.target)) {
      err('edge references a missing node', { edgeId: edge.id })
      continue
    }
    if (edge.source === edge.target) err('self-loop edges are not allowed (use a loop node)', { edgeId: edge.id })
    const route = edge.route ?? (source.type === 'condition' ? undefined : 'success')
    if (route === undefined || !routesFor(source.type).includes(route)) err(`edge route "${edge.route ?? ''}" is not valid for a ${source.type} node`, { edgeId: edge.id })
    if (edge.route !== undefined && !(EDGE_ROUTES as readonly string[]).includes(edge.route)) err(`unknown edge route "${edge.route}"`, { edgeId: edge.id })
  }

  if (topoOrder(workflow.nodes, workflow.edges) === undefined) err('the graph contains a cycle; use a loop node for repetition')
  if (!workflow.nodes.some(n => n.type === 'output')) warn('no output node: the run result will be empty')
  return issues
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Coerce untrusted JSON (import, model tool, HTTP body) into a Workflow.
 * Unknown keys are dropped; structural checks are left to {@link lintWorkflow}.
 */
export function normalizeWorkflow(raw: unknown, overrides: { id?: string; now?: string } = {}): Workflow {
  const input = (raw ?? {}) as Record<string, unknown>
  const now = overrides.now ?? new Date().toISOString()
  const nodes: WorkflowNode[] = (Array.isArray(input.nodes) ? input.nodes : []).slice(0, LIMITS.maxNodes + 1).map((rawNode, index) => {
    const n = (rawNode ?? {}) as Record<string, unknown>
    const position = (n.position ?? {}) as Record<string, unknown>
    const retry = n.retry as Record<string, unknown> | undefined
    const node: WorkflowNode = {
      id: str(n.id, `n${index + 1}`),
      type: str(n.type) as NodeType,
      name: str(n.name, str(n.type, 'node')),
      position: { x: Number(position.x ?? index * 260) || 0, y: Number(position.y ?? 0) || 0 },
      config: n.config !== null && typeof n.config === 'object' && !Array.isArray(n.config) ? structuredClone(n.config as Record<string, unknown>) : {},
    }
    if (retry !== undefined && typeof retry === 'object') node.retry = { max: Math.trunc(Number(retry.max ?? 0)), backoffMs: Math.max(0, Number(retry.backoffMs ?? 1000)) }
    if (typeof n.timeoutMs === 'number') node.timeoutMs = n.timeoutMs
    if (n.continueOnFailure === true) node.continueOnFailure = true
    return node
  })
  const edges: WorkflowEdge[] = (Array.isArray(input.edges) ? input.edges : []).slice(0, LIMITS.maxEdges + 1).map((rawEdge, index) => {
    const e = (rawEdge ?? {}) as Record<string, unknown>
    const edge: WorkflowEdge = { id: str(e.id, `e${index + 1}`), source: str(e.source), target: str(e.target) }
    if (typeof e.route === 'string' && e.route) edge.route = e.route as EdgeRoute
    return edge
  })
  const workflow: Workflow = {
    schemaVersion: 1,
    id: overrides.id ?? str(input.id, ''),
    name: str(input.name, 'Untitled workflow').slice(0, 120),
    nodes,
    edges,
    createdAt: str(input.createdAt, now),
    updatedAt: now,
  }
  if (typeof input.description === 'string') workflow.description = input.description.slice(0, 2000)
  if (Array.isArray(input.inputs)) {
    workflow.inputs = input.inputs.slice(0, 50).map(rawSpec => {
      const s = (rawSpec ?? {}) as Record<string, unknown>
      const type = ['string', 'number', 'boolean', 'json'].includes(str(s.type)) ? (str(s.type) as 'string') : 'string'
      return {
        name: str(s.name, 'input'),
        type,
        ...(s.required === true ? { required: true } : {}),
        ...(s.default !== undefined ? { default: s.default } : {}),
        ...(typeof s.description === 'string' ? { description: s.description } : {}),
      }
    })
  }
  const budget = input.budget as Record<string, unknown> | undefined
  if (budget !== undefined && typeof budget === 'object') {
    workflow.budget = {
      ...(typeof budget.maxNodeRuns === 'number' ? { maxNodeRuns: budget.maxNodeRuns } : {}),
      ...(typeof budget.maxTokens === 'number' ? { maxTokens: budget.maxTokens } : {}),
    }
  }
  if (typeof input.deadlineMs === 'number') workflow.deadlineMs = input.deadlineMs
  if (typeof input.concurrency === 'number') workflow.concurrency = Math.min(16, Math.max(1, Math.trunc(input.concurrency)))
  const triggers = input.triggers as Record<string, unknown> | undefined
  if (triggers !== undefined && typeof triggers === 'object') {
    workflow.triggers = {}
    if (Array.isArray(triggers.cron)) {
      workflow.triggers.cron = triggers.cron.slice(0, 20).map((rawCron, index) => {
        const c = (rawCron ?? {}) as Record<string, unknown>
        return {
          id: str(c.id, `cron${index + 1}`),
          expression: str(c.expression),
          enabled: c.enabled !== false,
          ...(c.inputs !== null && typeof c.inputs === 'object' ? { inputs: c.inputs as Record<string, unknown> } : {}),
        }
      })
    }
    const webhook = triggers.webhook as Record<string, unknown> | undefined
    if (webhook !== undefined && typeof webhook === 'object') workflow.triggers.webhook = { enabled: webhook.enabled === true }
  }
  return workflow
}
