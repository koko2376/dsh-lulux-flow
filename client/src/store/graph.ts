/**
 * Pure graph helpers for the editor: ids, node defaults, local lint for
 * instant feedback (the Host lint stays authoritative), and layout.
 */
import { NODE_TYPES, routesFor, type EdgeRoute, type LintIssue, type NodeType, type Workflow, type WorkflowEdge, type WorkflowNode } from '../api/types.ts'

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const stem = base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'node'
  if (!used.has(stem)) return stem
  for (let i = 2; ; i += 1) if (!used.has(`${stem}_${i}`)) return `${stem}_${i}`
}

export function defaultConfig(type: NodeType, kernels: readonly string[] = []): Record<string, unknown> {
  switch (type) {
    case 'agent':
      return { prompt: '' }
    case 'kernel':
      return { kernel: kernels[0] ?? 'claude-code', prompt: '', permission: 'ask' }
    case 'script':
      return { code: 'return { ok: true, input }' }
    case 'http':
      return { method: 'GET', url: '' }
    case 'condition':
      return { expression: '' }
    case 'loop':
      return { mode: 'items', items: '', maxIterations: 10, body: { type: 'agent', config: { prompt: '{{ loop.item }}' } } }
    case 'approval':
      return { message: '' }
    case 'notify':
      return { url: '', format: 'json', message: '' }
    case 'output':
      return {}
    default:
      return {}
  }
}

export function createNode(type: NodeType, position: { x: number; y: number }, existing: readonly WorkflowNode[], name: string, kernels: readonly string[] = []): WorkflowNode {
  return {
    id: uniqueId(type, existing.map(n => n.id)),
    type,
    name,
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    config: defaultConfig(type, kernels),
  }
}

export function connect(workflow: Workflow, source: string, target: string, route?: EdgeRoute): Workflow {
  const from = workflow.nodes.find(n => n.id === source)
  if (from === undefined || source === target || !workflow.nodes.some(n => n.id === target)) return workflow
  const allowed = routesFor(from.type)
  const chosen = route !== undefined && allowed.includes(route) ? route : allowed[0]
  if (chosen === undefined) return workflow
  if (workflow.edges.some(e => e.source === source && e.target === target && (e.route ?? 'success') === chosen)) return workflow
  const edge: WorkflowEdge = { id: uniqueId(`e_${source}_${target}`, workflow.edges.map(e => e.id)), source, target, route: chosen }
  return { ...workflow, edges: [...workflow.edges, edge] }
}

export function removeNode(workflow: Workflow, id: string): Workflow {
  return { ...workflow, nodes: workflow.nodes.filter(n => n.id !== id), edges: workflow.edges.filter(e => e.source !== id && e.target !== id) }
}

export function removeEdge(workflow: Workflow, id: string): Workflow {
  return { ...workflow, edges: workflow.edges.filter(e => e.id !== id) }
}

export function hasCycle(workflow: Workflow): boolean {
  const indegree = new Map(workflow.nodes.map(n => [n.id, 0]))
  for (const e of workflow.edges) if (indegree.has(e.target)) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1)
  const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id)
  let seen = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    seen += 1
    for (const e of workflow.edges) {
      if (e.source !== id) continue
      const d = (indegree.get(e.target) ?? 0) - 1
      indegree.set(e.target, d)
      if (d === 0) queue.push(e.target)
    }
  }
  return seen !== workflow.nodes.length
}

/** Issue codes are translated by the UI; `message` keeps the Host's English text for Host issues. */
export interface LocalIssue extends LintIssue {
  code?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Fast client-side checks mirroring the Host rules that matter while editing. */
export function localLint(workflow: Workflow, options: { scriptsAllowed: boolean }): LocalIssue[] {
  const issues: LocalIssue[] = []
  const err = (code: string, nodeId?: string, edgeId?: string): void =>
    void issues.push({ level: 'error', code, message: code, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) })
  if (workflow.nodes.length === 0) err('issue.empty')
  if (!workflow.name.trim()) err('issue.name')
  for (const node of workflow.nodes) {
    const c = node.config
    if (!(NODE_TYPES as readonly string[]).includes(node.type)) err('issue.type', node.id)
    if (node.name.length > 120) err('issue.nodeName', node.id)
    if ((node.type === 'agent' || node.type === 'kernel') && !str(c.prompt).trim()) err('issue.prompt', node.id)
    if (node.type === 'kernel' && !str(c.kernel)) err('issue.kernel', node.id)
    if (node.type === 'script' && !str(c.code).trim()) err('issue.code', node.id)
    if (node.type === 'script' && !options.scriptsAllowed) issues.push({ level: 'warning', code: 'issue.scriptDisabled', message: 'issue.scriptDisabled', nodeId: node.id })
    if ((node.type === 'http' || node.type === 'notify') && !str(c.url).trim()) err('issue.url', node.id)
    if (node.type === 'condition' && !str(c.expression).trim()) err('issue.expression', node.id)
    if (node.retry !== undefined && (node.retry.max < 0 || node.retry.max > 10)) err('issue.retry', node.id)
  }
  for (const edge of workflow.edges) {
    const source = workflow.nodes.find(n => n.id === edge.source)
    if (source === undefined || !workflow.nodes.some(n => n.id === edge.target)) {
      err('issue.edgeMissing', undefined, edge.id)
      continue
    }
    const route = edge.route ?? (source.type === 'condition' ? undefined : 'success')
    if (route === undefined || !routesFor(source.type).includes(route)) err('issue.route', undefined, edge.id)
  }
  if (hasCycle(workflow)) err('issue.cycle')
  return issues
}

/** Merge Host issues (authoritative) with local ones, dropping local duplicates on the same target. */
export function mergeIssues(host: readonly LintIssue[], local: readonly LocalIssue[]): LocalIssue[] {
  const out: LocalIssue[] = [...host]
  for (const issue of local) {
    const covered = host.some(h => h.level === issue.level && h.nodeId === issue.nodeId && h.edgeId === issue.edgeId)
    if (!covered) out.push(issue)
  }
  return out
}

/** Layered left-to-right layout by topological depth. */
export function autoLayout(workflow: Workflow): Workflow {
  const depth = new Map<string, number>()
  const indeg = new Map(workflow.nodes.map(n => [n.id, 0]))
  for (const e of workflow.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  const queue = workflow.nodes.filter(n => (indeg.get(n.id) ?? 0) === 0).map(n => n.id)
  for (const id of queue) depth.set(id, 0)
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const e of workflow.edges) {
      if (e.source !== id) continue
      depth.set(e.target, Math.max(depth.get(e.target) ?? 0, (depth.get(id) ?? 0) + 1))
      const d = (indeg.get(e.target) ?? 0) - 1
      indeg.set(e.target, d)
      if (d === 0) queue.push(e.target)
    }
  }
  const rows = new Map<number, number>()
  const nodes = workflow.nodes.map(n => {
    const col = depth.get(n.id) ?? 0
    const row = rows.get(col) ?? 0
    rows.set(col, row + 1)
    return { ...n, position: { x: 80 + col * 280, y: 80 + row * 150 } }
  })
  return { ...workflow, nodes }
}

/** Variables a template in `nodeId` may reference (for autocomplete). */
export function templateVariables(workflow: Workflow, nodeId?: string): string[] {
  const vars: string[] = []
  for (const input of workflow.inputs ?? []) vars.push(`inputs.${input.name}`)
  for (const node of workflow.nodes) {
    if (node.id === nodeId) continue
    vars.push(`nodes.${node.id}.output`, `nodes.${node.id}.status`, `nodes.${node.id}.error`)
  }
  vars.push('run.id', 'run.workflowId', 'run.trigger')
  const self = workflow.nodes.find(n => n.id === nodeId)
  if (self?.type === 'loop') vars.push('loop.item', 'loop.index', 'loop.previous')
  return vars
}

export const TEMPLATE_FILTERS = ['json', 'default("")', 'trim', 'upper', 'lower', 'length'] as const
