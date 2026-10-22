/**
 * Model-facing tools so any DSH agent can list, create (from JSON or natural
 * language), run and inspect workflows, and see available kernels.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { BRAND } from './brand.js'
import type { LuluxFlowRuntime } from './runtime.js'
import type { HostAgent } from './dsh/host-types.js'
import { normalizeWorkflow } from './workflow/validate.js'
import { summarize, type Workflow, type WorkflowRun } from './workflow/types.js'
import { APPROVAL_REASON_MAX, approvalSummary, markUnreviewed, reviewDigest, reviewProblem, riskFacts, type RiskContext, type TextLanguage } from './workflow/review.js'
import { UnreviewedWorkflowError, type StartOptions } from './workflow/engine.js'
import { findKernel } from './kernels/catalog.js'
import { redact, redactDeep } from './util/redact.js'

const P = BRAND.toolPrefix
const text = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }

/** Runs started by a chat tool in wait mode: approvals can be asked in that chat turn. */
export interface ChatRunBindings {
  bind(runId: string, agent: HostAgent, callId: string): void
  unbind(runId: string): void
}

function compactRun(run: WorkflowRun): Record<string, unknown> {
  // Tool output goes back to the model: secret-named fields and secret-shaped strings are redacted.
  return redactDeep({
    ...summarize(run),
    output: run.output,
    nodes: Object.fromEntries(
      Object.entries(run.nodes).map(([id, n]) => [
        id,
        { status: n.status, route: n.route, error: n.error, output: typeof n.output === 'string' ? n.output.slice(0, 2000) : n.output, attempts: n.attempts.length },
      ]),
    ),
  })
}

/**
 * Language for text a person reads (DSH's approval dialog) and for the
 * messages the model relays: the plugin's language setting. Tool
 * descriptions stay in English; they are read by the model, not shown.
 * Without a settings store (bare test runtimes) English is used.
 */
function textLanguage(rt: LuluxFlowRuntime): TextLanguage {
  try {
    return (rt.settings as LuluxFlowRuntime['settings'] | undefined)?.get().language ?? 'en'
  } catch {
    return 'en'
  }
}

const MESSAGES = {
  en: {
    reviewHint: `It is marked unreviewed: the user has to open it in ${BRAND.displayName}, review it and approve it before it can run (or approve one run in DSH's approval dialog when you start it).`,
    runWorkflow: (name: string) => `run workflow "${name}"`,
    controlRun: (action: string, id: string, name: string) => `${action} run ${id} of "${name}"`,
    noChannel: (what: string, summary: string) => `Not started: ${what} needs the user's approval (${summary}), and no DSH approval channel is available here. Ask the user to start it from ${BRAND.displayName}.`,
    declined: (what: string, rejected: boolean) => `Not started: the user ${rejected ? 'rejected' : 'did not approve'} ${what} in DSH.`,
    changed: 'Not started: the workflow changed while the approval was pending, so the approval no longer applies. Nothing ran; start it again to ask for a new approval.',
    notStarted: (detail: string) => `Not started: ${detail}`,
  },
  'zh-CN': {
    reviewHint: `它已标记为待审核：用户需要在 ${BRAND.displayNameZh} 中打开、检查并批准后才能运行（或在你启动时，于 DSH 审批弹窗中批准这一次运行）。`,
    runWorkflow: (name: string) => `运行工作流「${name}」`,
    controlRun: (action: string, id: string, name: string) => `${action === 'resume' ? '继续' : '重新运行'}「${name}」的运行 ${id}`,
    noChannel: (what: string, summary: string) => `未启动：${what}需要用户批准（${summary}），但这里没有可用的 DSH 审批通道。请让用户在 ${BRAND.displayNameZh} 中启动。`,
    declined: (what: string, rejected: boolean) => `未启动：用户在 DSH 中${rejected ? '拒绝了' : '没有批准'}${what}。`,
    changed: '未启动：等待审批期间工作流被改动，之前的批准不再适用。没有运行任何内容；请重新启动以再次请求批准。',
    notStarted: (detail: string) => `未启动：${detail}`,
  },
} as const

/**
 * A run started by the model needs a person's yes through DSH's approval
 * dialog when the workflow is unreviewed or does more than read (elevated
 * kernels, scripts, outbound requests, agent presets). On a yes, returns the
 * start options that bind the run to the digest of exactly what was shown;
 * otherwise an error message for the model.
 */
async function gateModelRun(
  rt: LuluxFlowRuntime,
  workflow: Workflow,
  what: string,
  exec: { agent?: unknown; callId?: unknown; signal: AbortSignal },
): Promise<{ ok: true; options: StartOptions } | { ok: false; message: string }> {
  const lang = textLanguage(rt)
  const M = MESSAGES[lang]
  const risk: RiskContext = { kernel: id => findKernel(id), setting: id => rt.kernels.settingsOf(id) }
  // Freeze what is shown: the digest is taken before the dialog opens.
  const digest = reviewDigest(workflow)
  const unreviewed = reviewProblem(workflow)
  const risks = riskFacts(workflow, risk)
  if (unreviewed === undefined && risks.length === 0) return { ok: true, options: { approvedDigest: digest } }
  const summary = redact(approvalSummary(what, workflow, risk, lang)).slice(0, APPROVAL_REASON_MAX)
  const service = rt.approval?.()
  if (service === undefined || exec.agent === undefined) return { ok: false, message: M.noChannel(what, summary) }
  const outcome = await service.request({
    agent: exec.agent as HostAgent,
    toolName: `${P}_workflow_run`,
    ...(exec.callId !== undefined ? { callId: String(exec.callId) } : {}),
    reason: summary,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') return { ok: false, message: M.declined(what, outcome === 'rejected') }
  return { ok: true, options: { approvedDigest: digest, ...(unreviewed !== undefined ? { approvedOnceBy: 'dsh-approval' } : {}) } }
}

function startError(rt: LuluxFlowRuntime, error: unknown): string {
  const M = MESSAGES[textLanguage(rt)]
  if (error instanceof UnreviewedWorkflowError && error.reason === 'changed') return M.changed
  return M.notStarted(error instanceof Error ? error.message : String(error))
}

function json(value: unknown): string {
  const out = JSON.stringify(value, null, 2)
  return out.length > 60_000 ? `${out.slice(0, 60_000)}\n… (truncated)` : out
}

export function createTools(rt: LuluxFlowRuntime, chatRuns: ChatRunBindings): ToolDefinition[] {
  return [
    defineTool({
      name: `${P}_workflow_list`,
      description: `List ${BRAND.displayName} workflows (DAG canvases) with their last run status.`,
      parameters: {},
      output: text,
      async execute() {
        const runs = rt.store.listRuns({ limit: 500 })
        return json(rt.store.listWorkflows().map(wf => ({ id: wf.id, name: wf.name, description: wf.description, nodes: wf.nodes.length, lastRun: runs.find(r => r.workflowId === wf.id)?.status ?? null })))
      },
    }),
    defineTool({
      name: `${P}_workflow_get`,
      description: 'Get one workflow graph (nodes, edges, inputs) and its lint issues.',
      parameters: { workflowId: { type: 'string', required: true } },
      output: text,
      async execute(args) {
        const wf = rt.store.getWorkflow(args.workflowId)
        if (wf === undefined) return `No workflow with id ${args.workflowId}.`
        return json({ workflow: wf, issues: rt.engine.lint(wf) })
      },
    }),
    defineTool({
      name: `${P}_workflow_create`,
      description:
        'Create a workflow. Either pass `description` (natural language; the DAG is generated with the DSH model) or a full `workflow` JSON (nodes, edges, inputs). Node types: input, agent, kernel (external CLI such as claude-code/codex), script, http, condition, loop, approval, notify, output.',
      parameters: {
        description: { type: 'string', description: 'What the workflow should do, in plain language.' },
        workflow: { type: 'json', description: 'Explicit workflow JSON instead of a description.' },
      },
      output: text,
      async execute(args, exec) {
        if (args.workflow !== undefined) {
          const wf = markUnreviewed(normalizeWorkflow(args.workflow, { id: rt.store.newId() }), 'model')
          rt.store.saveWorkflow(wf)
          rt.engine.emit({ type: 'workflow', workflowId: wf.id })
          return json({ created: wf.id, review: 'unreviewed', issues: rt.engine.lint(wf), hint: MESSAGES[textLanguage(rt)].reviewHint })
        }
        if (typeof args.description !== 'string' || !args.description.trim()) return 'Pass either `description` or `workflow`.'
        const { workflow, issues } = await rt.generate(args.description, exec.signal)
        markUnreviewed(workflow, 'generated')
        rt.store.saveWorkflow(workflow)
        rt.engine.emit({ type: 'workflow', workflowId: workflow.id })
        return json({ created: workflow.id, name: workflow.name, review: 'unreviewed', nodes: workflow.nodes.map(n => `${n.id} (${n.type})`), issues, hint: MESSAGES[textLanguage(rt)].reviewHint })
      },
    }),
    defineTool({
      name: `${P}_workflow_update`,
      description: 'Replace a workflow graph with new JSON (same shape as returned by get). The workflow becomes unreviewed until the user approves it again.',
      parameters: { workflowId: { type: 'string', required: true }, workflow: { type: 'json', required: true } },
      output: text,
      async execute(args) {
        const current = rt.store.getWorkflow(args.workflowId)
        if (current === undefined) return `No workflow with id ${args.workflowId}.`
        const wf = markUnreviewed(normalizeWorkflow(args.workflow, { id: current.id }), 'model')
        wf.createdAt = current.createdAt
        rt.store.saveWorkflow(wf)
        rt.engine.emit({ type: 'workflow', workflowId: wf.id })
        return json({ updated: wf.id, review: 'unreviewed', issues: rt.engine.lint(wf), hint: MESSAGES[textLanguage(rt)].reviewHint })
      },
    }),
    defineTool({
      name: `${P}_workflow_run`,
      description:
        'Run a workflow. Unreviewed workflows, and workflows with edit/full kernels, script, http or notify nodes, first ask the user in DSH\'s approval dialog. With wait=true the tool waits for the result (approval gates then ask the user in this chat).',
      parameters: {
        workflowId: { type: 'string', required: true },
        inputs: { type: 'json', description: 'Input values keyed by input name.' },
        wait: { type: 'boolean', description: 'Wait for completion (default false).' },
        timeoutSeconds: { type: 'number', description: 'Max seconds to wait when wait=true (default 600).' },
      },
      output: text,
      async execute(args, exec) {
        const workflow = rt.store.getWorkflow(args.workflowId)
        if (workflow === undefined) return `No workflow with id ${args.workflowId}.`
        const errors = rt.engine.lint(workflow).filter(i => i.level === 'error')
        if (errors.length > 0) return MESSAGES[textLanguage(rt)].notStarted(errors.map(e => e.message).join('; '))
        const gate = await gateModelRun(rt, workflow, MESSAGES[textLanguage(rt)].runWorkflow(workflow.name), exec)
        if (!gate.ok) return gate.message
        let run: WorkflowRun
        try {
          run = rt.startRun(args.workflowId, (args.inputs as Record<string, unknown> | undefined) ?? {}, { kind: 'chat' }, gate.options)
        } catch (error: unknown) {
          return startError(rt, error)
        }
        if (args.wait !== true) return json({ runId: run.id, status: run.status, hint: `Use ${P}_run_status to follow it.` })
        if (exec.agent !== undefined) chatRuns.bind(run.id, exec.agent as unknown as HostAgent, String(exec.callId))
        const timeout = Math.min(3600, Math.max(5, Number(args.timeoutSeconds ?? 600))) * 1000
        try {
          const finished = await Promise.race([
            rt.engine.wait(run.id),
            new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), timeout).unref()),
            new Promise<undefined>(resolve => exec.signal.addEventListener('abort', () => resolve(undefined), { once: true })),
          ])
          const latest = finished ?? rt.store.getRun(run.id)
          return json(latest !== undefined ? compactRun(latest) : { runId: run.id })
        } finally {
          chatRuns.unbind(run.id)
        }
      },
    }),
    defineTool({
      name: `${P}_run_status`,
      description: 'Get a workflow run: status, per-node status/output/errors, and the final output.',
      parameters: { runId: { type: 'string', required: true } },
      output: text,
      async execute(args) {
        const run = rt.store.getRun(args.runId)
        return run === undefined ? `No run with id ${args.runId}.` : json(compactRun(run))
      },
    }),
    defineTool({
      name: `${P}_run_control`,
      description:
        'Control a run: cancel, resume (from failed nodes) or rerun (fresh run, same snapshot). Approval nodes are decided only by the user in DSH-LULUX Flow or in DSH\'s approval dialog, never through this tool.',
      parameters: {
        runId: { type: 'string', required: true },
        action: { type: 'string', enum: ['cancel', 'resume', 'rerun'], required: true },
      },
      output: text,
      async execute(args, exec) {
        if (args.action === 'cancel') return rt.engine.cancel(args.runId) ? 'Cancelled.' : 'Run is not active.'
        if (args.action !== 'resume' && args.action !== 'rerun') return 'Approvals cannot be decided by the model. Ask the user to approve or reject in DSH-LULUX Flow.'
        const run = rt.store.getRun(args.runId)
        if (run === undefined) return `No run with id ${args.runId}.`
        const gate = await gateModelRun(rt, run.snapshot, MESSAGES[textLanguage(rt)].controlRun(args.action, run.id, run.workflowName), exec)
        if (!gate.ok) return gate.message
        try {
          if (args.action === 'resume') return json(summarize(rt.engine.resume(args.runId)))
          if (gate.options.approvedOnceBy !== undefined) return json(summarize(rt.engine.start(run.snapshot, run.inputs, { kind: 'rerun', detail: run.id }, run.id, gate.options)))
          return json(summarize(rt.engine.rerun(args.runId)))
        } catch (error: unknown) {
          return startError(rt, error)
        }
      },
    }),
    defineTool({
      name: `${P}_kernel_list`,
      description: 'List external coding CLIs (kernels) DSH-LULUX Flow can run on the DSH model, with install status and the subagent provider / chat route names.',
      parameters: {},
      output: text,
      async execute() {
        const kernels = await rt.kernels.list()
        return json(kernels.map(k => ({ id: k.id, name: k.name, installed: k.installed, version: k.version ?? null, mode: k.settings.mode, permission: k.settings.permission, subagentProvider: k.provider, chatRoute: k.chatRoute })))
      },
    }),
  ]
}
