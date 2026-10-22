/**
 * Step executors for agent, kernel, script, http and notify nodes. The engine
 * passes configs with templates already rendered.
 */
import type { StepContext, StepExecutor, StepResult } from './engine.js'
import { runScript } from './script.js'
import { outboundRequest, type OutboundPolicy } from './ssrf.js'
import { stringify } from './template.js'
import type { KernelService } from '../kernels/service.js'
import { effectiveKernelPolicy, isMode, isPermission } from '../kernels/policy.js'
import type { UpstreamTarget } from '../gateway/canonical.js'
import { redact, redactDeep } from '../util/redact.js'

export interface AgentRunRequest {
  prompt: string
  system?: string
  cwd?: string
  /** `provider/model`; omitted = DSH default model. */
  model?: string
  preset?: string
  signal: AbortSignal
  label: string
  onTrace?: (line: string) => void
}

export interface AgentRunResult {
  text: string
  sessionId: string
  usage?: { inputTokens: number; outputTokens: number }
  stopReason: string
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>
}

export interface ExecutorDeps {
  agents?: AgentRunner
  kernels?: KernelService
  /** Upstream the gateway should use for a kernel run (honours an explicit `provider/model`). */
  kernelTarget: (model?: string) => UpstreamTarget
  defaultCwd: () => string
  outbound: OutboundPolicy
  script: { timeoutMs: number; maxHeapMb: number }
  kernelTimeoutMs: number
}

function text(value: unknown): string {
  return stringify(value)
}

function maybeJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return raw
    }
  }
  // Agents often wrap JSON in a fenced block.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!) as unknown
    } catch {
      return raw
    }
  }
  return raw
}

export function createExecutors(deps: ExecutorDeps): Record<'agent' | 'kernel' | 'script' | 'http' | 'notify', StepExecutor> {
  const agent: StepExecutor = async (config, ctx) => {
    if (deps.agents === undefined) throw new Error('DSH agents are not available in this profile')
    const result = await deps.agents.run({
      prompt: text(config.prompt),
      ...(config.system !== undefined && text(config.system) ? { system: text(config.system) } : {}),
      ...(config.cwd !== undefined && text(config.cwd) ? { cwd: text(config.cwd) } : {}),
      ...(config.model !== undefined && text(config.model) ? { model: text(config.model) } : {}),
      ...(config.preset !== undefined && text(config.preset) ? { preset: text(config.preset) } : {}),
      signal: ctx.signal,
      label: `${ctx.run.workflowName} › ${ctx.node.name}`,
      onTrace: ctx.trace,
    })
    ctx.trace(`agent session ${result.sessionId} finished (${result.stopReason})`)
    if (result.stopReason !== 'completed' && result.stopReason !== 'stop') throw new Error(`agent stopped: ${result.stopReason}${result.text ? ` — ${result.text.slice(0, 300)}` : ''}`)
    const parsed = config.parseJson === false ? result.text : maybeJson(result.text)
    return {
      output: parsed,
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      artifacts: [{ name: 'answer.md', kind: 'text', value: result.text }],
    }
  }

  const kernel: StepExecutor = async (config, ctx) => {
    if (deps.kernels === undefined) throw new Error('kernel service unavailable')
    const def = deps.kernels.require(text(config.kernel))
    const settings = deps.kernels.settingsOf(def.id)
    if (!settings.enabled) throw new Error(`${def.name} is disabled in DSH-LULUX Flow settings`)
    // The Kernels page setting is the ceiling; a node can only ask for less (see kernels/policy.ts).
    for (const field of ['kernel', 'mode', 'permission', 'cwd']) {
      const value = config[field]
      if (value !== undefined && typeof value !== 'string') throw new Error(`kernel "${field}" must be a string`)
    }
    if (config.mode !== undefined && config.mode !== '' && !isMode(config.mode)) throw new Error('kernel mode must be "scoped" or "global"')
    if (config.permission !== undefined && config.permission !== '' && !isPermission(config.permission)) throw new Error('kernel permission must be read-only, ask, edit or full')
    const policy = effectiveKernelPolicy({ requestedMode: config.mode, requestedPermission: config.permission, setting: settings, def })
    for (const note of policy.notes) ctx.trace(note)
    const { mode, permission } = policy
    const result = await deps.kernels.run({
      kernel: def,
      prompt: text(config.prompt),
      cwd: text(config.cwd) || deps.defaultCwd(),
      mode,
      permission,
      target: deps.kernelTarget(text(config.model) || undefined),
      runId: `${ctx.run.id}.${ctx.node.id}.${Date.now().toString(36)}`,
      timeoutMs: Number(config.timeoutMs ?? 0) > 0 ? Number(config.timeoutMs) : deps.kernelTimeoutMs,
      signal: ctx.signal,
      onEvent: event => {
        if (event.type === 'tool') ctx.trace(`▸ ${event.name} ${event.detail}`)
        else if (event.type === 'error' && !event.fatal) ctx.trace(`! ${event.message}`)
      },
    })
    ctx.trace(`${def.name} ${result.status} in ${result.durationMs} ms (${mode}, ${permission}); gateway requests: ${result.usage.requests}`)
    if (result.status !== 'completed') throw new Error(result.diagnostic ?? `${def.name} ${result.status}`)
    return {
      output: config.parseJson === false ? result.text : maybeJson(result.text),
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      artifacts: [
        { name: 'answer.md', kind: 'text', value: result.text },
        ...(result.tools.length > 0 ? [{ name: 'tool-calls.json', kind: 'json' as const, value: JSON.stringify(result.tools, null, 2) }] : []),
      ],
    }
  }

  const script: StepExecutor = async (config, ctx) => {
    const input = config.input !== undefined ? config.input : ctx.scope
    const result = await runScript(text(config.code), input, {
      timeoutMs: Math.min(Number(config.timeoutMs ?? deps.script.timeoutMs) || deps.script.timeoutMs, 60_000),
      maxHeapMb: deps.script.maxHeapMb,
      signal: ctx.signal,
    })
    for (const line of result.logs) ctx.trace(`console: ${line}`)
    return { output: result.value }
  }

  const http: StepExecutor = async (config, ctx) => {
    const method = text(config.method || 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((config.headers ?? {}) as Record<string, unknown>)) headers[key] = text(value)
    let body: string | undefined
    if (config.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      body = typeof config.body === 'string' ? config.body : JSON.stringify(config.body)
      if (typeof config.body !== 'string' && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
    }
    ctx.trace(`${method} ${redact(text(config.url))}`)
    const response = await outboundRequest(text(config.url), { method, headers, ...(body !== undefined ? { body } : {}), signal: ctx.signal }, {
      ...deps.outbound,
      ...(Number(config.timeoutMs) > 0 ? { timeoutMs: Number(config.timeoutMs) } : {}),
    })
    ctx.trace(`→ ${response.status}${response.truncated ? ' (body truncated)' : ''}`)
    const expect = config.expectStatus !== undefined ? Number(config.expectStatus) : undefined
    const ok = expect !== undefined ? response.status === expect : response.status < 400
    // Response headers such as Set-Cookie are not kept in run records, events or tool output.
    const output = { status: response.status, headers: redactDeep(response.headers), body: maybeJson(response.body), url: redact(response.url) }
    if (!ok) throw new Error(`HTTP ${response.status}: ${redact(response.body.slice(0, 300))}`)
    return { output }
  }

  const notify: StepExecutor = async (config, ctx): Promise<StepResult> => {
    const message = text(config.message ?? `${ctx.run.workflowName}: ${ctx.node.name}`)
    const format = text(config.format || 'json')
    const payload =
      format === 'slack' || format === 'discord'
        ? format === 'slack'
          ? { text: message }
          : { content: message.slice(0, 2000) }
        : format === 'feishu'
          ? { msg_type: 'text', content: { text: message } }
          : format === 'dingtalk' || format === 'wecom'
            ? { msgtype: 'text', text: { content: message } }
            : { event: 'lulux-flow.notify', workflow: ctx.run.workflowName, runId: ctx.run.id, node: ctx.node.name, message }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    for (const [key, value] of Object.entries((config.headers ?? {}) as Record<string, unknown>)) headers[key] = text(value)
    const response = await outboundRequest(text(config.url), { method: 'POST', headers, body: JSON.stringify(payload), signal: ctx.signal }, deps.outbound)
    ctx.trace(`notify (${format}) → ${response.status}`)
    if (response.status >= 400) throw new Error(`notification failed: HTTP ${response.status}`)
    return { output: { delivered: true, status: response.status } }
  }

  return { agent, kernel, script, http, notify }
}

export type { StepContext }
