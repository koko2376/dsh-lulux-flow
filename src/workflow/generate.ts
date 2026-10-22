/**
 * Natural language → workflow DAG, using the DSH model through the same
 * upstream the gateway uses. The model must answer with JSON; the result is
 * normalized, auto-laid-out and linted, with one repair round on errors.
 */
import { topoOrder } from './validate.js'
import type { LintIssue } from './validate.js'
import { normalizeWorkflow } from './validate.js'
import type { Workflow } from './types.js'

export type Completer = (system: string, user: string, signal: AbortSignal) => Promise<string>

export function generationPrompt(kernels: readonly string[], scriptsAllowed: boolean): string {
  return [
    'You design workflows for DSH-LULUX Flow, a DAG workflow engine inside DeepSeek Harness.',
    'Answer with ONE JSON object and nothing else (no prose, no code fences).',
    'Schema: { "name": string, "description": string, "inputs": [{ "name", "type": "string|number|boolean|json", "required"?, "default"? }],',
    '  "nodes": [{ "id": "short_snake_id", "type": NodeType, "name": string, "config": object, "retry"?: { "max": 0-3, "backoffMs": number }, "timeoutMs"?: number, "continueOnFailure"?: boolean }],',
    '  "edges": [{ "id": string, "source": nodeId, "target": nodeId, "route"?: "success|failure|true|false" }] }',
    'Node types and config:',
    '- input: {}  — exposes run inputs.',
    '- agent: { "prompt": string, "system"?: string }  — a DSH agent with tools.',
    `- kernel: { "kernel": one of ${JSON.stringify(kernels)}, "prompt": string, "permission"?: "read-only|edit" }  — an external coding CLI running on DSH's model.`,
    scriptsAllowed ? '- script: { "code": "return {...}" }  — JavaScript body receiving `input`.' : '- (script nodes are disabled; do not use them)',
    '- http: { "method": "GET|POST|...", "url": string, "headers"?: object, "body"?: any }',
    '- condition: { "expression": "nodes.x.output.score >= 0.8" }  — outgoing edges use route "true"/"false".',
    '- loop: { "mode": "items|count|until", "items"?: "{{ nodes.x.output.list }}", "count"?: number, "until"?: expression, "maxIterations": 1-20, "body": { "type": "agent|kernel|http", "config": {...uses {{ loop.item }} / {{ loop.previous }}} } }',
    '- approval: { "message": string }  — a human approves (success) or rejects (failure route).',
    '- notify: { "url": string, "format": "json|slack|feishu|dingtalk|discord", "message": string }',
    '- output: { "value": "{{ nodes.x.output }}" }',
    'Templates: {{ inputs.NAME }}, {{ nodes.ID.output }}, {{ nodes.ID.output.field }}, filters | json | default("x").',
    'Rules: the graph must be acyclic; start with an input node, end with an output node; keep it to the smallest useful graph (3–10 nodes); use ids, never names, in templates.',
  ].join('\n')
}

/** Simple layered layout: x by topological depth, y by order within the layer. */
export function autoLayout(workflow: Workflow): Workflow {
  const order = topoOrder(workflow.nodes, workflow.edges) ?? workflow.nodes.map(n => n.id)
  const depth = new Map<string, number>()
  for (const id of order) {
    const parents = workflow.edges.filter(e => e.target === id).map(e => depth.get(e.source) ?? 0)
    depth.set(id, parents.length > 0 ? Math.max(...parents) + 1 : 0)
  }
  const perLayer = new Map<number, number>()
  for (const id of order) {
    const d = depth.get(id) ?? 0
    const row = perLayer.get(d) ?? 0
    perLayer.set(d, row + 1)
    const node = workflow.nodes.find(n => n.id === id)
    if (node !== undefined) node.position = { x: 80 + d * 300, y: 80 + row * 170 }
  }
  return workflow
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const candidate = fenced ? fenced[1]! : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
  return JSON.parse(candidate) as unknown
}

export async function generateWorkflow(
  description: string,
  options: {
    complete: Completer
    lint: (workflow: Workflow) => LintIssue[]
    kernels: readonly string[]
    scriptsAllowed: boolean
    newId: () => string
    signal: AbortSignal
  },
): Promise<{ workflow: Workflow; issues: LintIssue[] }> {
  const system = generationPrompt(options.kernels, options.scriptsAllowed)
  let user = `Design a workflow for this request:\n${description.slice(0, 8000)}`
  let last: { workflow: Workflow; issues: LintIssue[] } | undefined
  for (let round = 0; round < 2; round += 1) {
    const answer = await options.complete(system, user, options.signal)
    let parsed: unknown
    try {
      parsed = extractJson(answer)
    } catch {
      user = `${user}\n\nYour previous answer was not valid JSON. Answer with the JSON object only.`
      continue
    }
    const workflow = autoLayout(normalizeWorkflow(parsed, { id: options.newId() }))
    const issues = options.lint(workflow)
    last = { workflow, issues }
    const errors = issues.filter(i => i.level === 'error')
    if (errors.length === 0) return last
    user = `${user}\n\nYour previous workflow had these errors, fix them and answer with the corrected JSON only:\n${errors.map(e => `- ${e.message}${e.nodeId ? ` (node ${e.nodeId})` : ''}`).join('\n')}\n\nPrevious JSON:\n${JSON.stringify(parsed)}`
  }
  if (last !== undefined) return last
  throw new Error('the model did not return a usable workflow')
}
