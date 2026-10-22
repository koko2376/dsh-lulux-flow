/**
 * DSH-LULUX Flow — host plugin entry.
 *
 * Wires: the scoped kernel gateway (loopback, run-scoped tokens, forwarding
 * to `ctx.llm`), kernel subagent providers, kernel chat routes (a CLI as the
 * main agent of a chat session), the workflow engine + persistence + cron,
 * the canvas HTTP API, webhook triggers and model tools.
 */
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { BRAND, ROUTE_PREFIX } from './brand.js'
import { collect, type CanonicalRequest, type UpstreamTarget } from './gateway/canonical.js'
import { KernelGateway } from './gateway/server.js'
import { TokenStore } from './gateway/tokens.js'
import { DshAgentRunner } from './dsh/agent-runner.js'
import type { HostAgent, HostAgents, HostApproval, ModelSelection } from './dsh/host-types.js'
import { ChatSessionMap } from './dsh/kernel-chat.js'
import { DshLlmUpstream, type LlmStreamer } from './dsh/llm-upstream.js'
import { ModelMemory, UpstreamResolver } from './dsh/upstream-resolver.js'
import { LuluxFlowKernelAdapter, LuluxFlowSubagentProvider, chatRoute, providerName } from './dsh/providers.js'
import { createApi } from './http/api.js'
import { listKernels } from './kernels/catalog.js'
import { KernelInstaller } from './kernels/installer.js'
import { DEFAULT_REGISTRIES, RegistrySelector } from './kernels/registry-probe.js'
import { KernelRunner } from './kernels/runner.js'
import { KernelService } from './kernels/service.js'
import type { LuluxFlowRuntime } from './runtime.js'
import { SettingsStore } from './settings.js'
import { createTools } from './tools.js'
import { matches, parseCron, startMinuteTicker } from './workflow/cron.js'
import { WorkflowEngine } from './workflow/engine.js'
import { createExecutors } from './workflow/executors.js'
import { generateWorkflow } from './workflow/generate.js'
import { WorkflowStore } from './workflow/store.js'

export const name = BRAND.id
/** Only the model runtime is required; the web server, agents, subagents and tools attach when present (so headless profiles work too). */
export const inject = ['llm']

export { BRAND } from './brand.js'
export { registerKernel } from './kernels/catalog.js'
export type { KernelDefinition } from './kernels/types.js'

export interface Config {
  dataDir?: string
  allowScriptNodes: boolean
  scriptTimeoutMs: number
  scriptMaxHeapMb: number
  gatewayMaxBodyMb: number
  gatewayRequestTimeoutMs: number
  kernelTimeoutMs: number
  registerSubagentProviders: boolean
  registerChatRoutes: boolean
  registerTools: boolean
  allowPrivateHosts: string[]
  outboundMaxResponseKb: number
  outboundTimeoutMs: number
  registries: string[]
  registryProbeTimeoutMs: number
  registryCacheTtlMs: number
  installTimeoutMs: number
  defaultConcurrency: number
  maxRunsPerWorkflow: number
  modelObserveIntervalMs: number
  defaultRunDeadlineMs: number
  maxActiveRuns: number
  kernelEnvPassthrough: string[]
}

export const Config: z<Config> = z.object({
  dataDir: z.string().description('Where workflows, runs and settings are stored. Default: <DSH home>/dsh-lulux-flow.'),
  allowScriptNodes: z.boolean().default(false).description('Operator opt-in to script nodes. This is the only switch that enables them. Not a sandbox: a script node runs code as your OS user (a separate Node process with the permission model, no file system or child processes, but network access).'),
  scriptTimeoutMs: z.number().min(100).max(60_000).default(5_000),
  scriptMaxHeapMb: z.number().min(8).max(1024).default(64),
  gatewayMaxBodyMb: z.number().min(1).max(256).default(32),
  gatewayRequestTimeoutMs: z.number().min(10_000).default(600_000),
  kernelTimeoutMs: z.number().min(10_000).default(1_800_000),
  registerSubagentProviders: z.boolean().default(true),
  registerChatRoutes: z.boolean().default(true),
  registerTools: z.boolean().default(true),
  allowPrivateHosts: z.array(z.string()).default([]).description('Hosts HTTP/notify nodes may reach even if they resolve to private ranges.'),
  outboundMaxResponseKb: z.number().min(1).default(2048),
  outboundTimeoutMs: z.number().min(1000).default(30_000),
  registries: z.array(z.string()).default([...DEFAULT_REGISTRIES]),
  registryProbeTimeoutMs: z.number().min(500).default(4_000),
  registryCacheTtlMs: z.number().min(60_000).default(6 * 3600_000),
  installTimeoutMs: z.number().min(60_000).default(15 * 60_000),
  defaultConcurrency: z.number().min(1).max(16).default(4),
  maxRunsPerWorkflow: z.number().min(10).default(200),
  modelObserveIntervalMs: z.number().min(1000).default(5_000).description('How often the DSH default model is sampled to remember the last real (non-CLI) model.'),
  defaultRunDeadlineMs: z.number().min(0).default(6 * 3600_000).description('Wall-clock limit for a workflow run that sets no deadline of its own (0 = none).'),
  maxActiveRuns: z.number().min(1).max(256).default(16).description('Maximum workflow runs executing at once; further starts are refused.'),
  kernelEnvPassthrough: z.array(z.string()).default([]).description('Extra environment variable names passed to scoped CLIs (the scoped environment is an allowlist). Example: SSH_AUTH_SOCK for git over SSH. Anything listed here is visible to the CLI.'),
}) as z<Config>

function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

function defaultDataDir(): string {
  return join(dshHome(), BRAND.id)
}

const VERSION = '0.1.0'

export function apply(ctx: Context, config: Config): void {
  const c = ctx as unknown as {
    llm: LlmStreamer & { registerAdapter(providers: string[], adapter: unknown): () => void }
    webServer: { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void> }): () => void }
    logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; debug(...a: unknown[]): void }
    get(name: string): unknown
    effect(fn: () => (() => void) | (() => Promise<void>), label?: string): void
    plugin(plugin: unknown, config?: unknown): unknown
    on(event: string, listener: (...args: unknown[]) => unknown): () => void
  }
  const log = {
    info: (m: string) => c.logger.info(`[${BRAND.id}] ${m}`),
    warn: (m: string) => c.logger.warn(`[${BRAND.id}] ${m}`),
    debug: (m: string) => c.logger.debug(`[${BRAND.id}] ${m}`),
  }
  const dataDir = config.dataDir?.trim() || defaultDataDir()
  const settings = new SettingsStore(dataDir, provider => provider.startsWith(`${BRAND.providerPrefix}-`))
  const store = new WorkflowStore(dataDir, config.maxRunsPerWorkflow)
  const tokens = new TokenStore()
  const agents = (): HostAgents | undefined => c.get('agents') as HostAgents | undefined
  const approval = (): HostApproval | undefined => c.get('approval') as HostApproval | undefined
  const defaultModel = (): ModelSelection | undefined => (c.get('agentDefaultModel') as { currentSelection(): ModelSelection } | undefined)?.currentSelection()
  const kernelRoutes = new Set(listKernels().map(k => chatRoute(k.id)))
  const isKernelRoute = (provider: string): boolean => kernelRoutes.has(provider) || listKernels().some(k => chatRoute(k.id) === provider)
  const profileName = (): string => {
    const name = (c.get('profileContext') as { name?: unknown } | undefined)?.name
    return typeof name === 'string' && name ? name : 'default'
  }
  const resolver = new UpstreamResolver({
    isKernelRoute,
    dshDefault: defaultModel,
    pinned: () => settings.get().gatewayModel,
    profile: profileName,
    memory: new ModelMemory(dataDir),
    providerExists: provider => {
      try {
        return (c.llm as unknown as { listProviders(): Array<{ id: string }> }).listProviders().some(p => p.id === provider)
      } catch {
        return true
      }
    },
  })

  /** The model gateway traffic goes to — never one of LULUX Flow's own kernel routes (loop guard). */
  const upstreamTarget = (explicit?: string): UpstreamTarget => resolver.resolve(explicit).target

  const upstream = new DshLlmUpstream(() => c.llm, isKernelRoute)
  const gateway = new KernelGateway({
    upstream,
    tokens,
    logger: log,
    maxBodyBytes: config.gatewayMaxBodyMb * 1024 * 1024,
    requestTimeoutMs: config.gatewayRequestTimeoutMs,
    approvals: {
      async request(record, ask) {
        const agent = record.sessionId !== undefined ? agents()?.get(record.sessionId) : undefined
        const service = approval()
        if (agent === undefined || service === undefined) return { allow: false, message: 'No DSH approval channel is available for this run.' }
        const detail = JSON.stringify(ask.input ?? {}).slice(0, 400)
        const outcome = await service.request({ agent, toolName: `${record.kernelId}: ${ask.toolName}`, reason: `${ask.toolName} ${detail}` })
        return outcome === 'allowed-once' ? { allow: true } : { allow: false, message: `The user ${outcome === 'rejected' ? 'rejected' : 'did not approve'} this action in DSH.` }
      },
    },
  })

  const selector = new RegistrySelector({
    candidates: () => config.registries,
    override: () => settings.get().registryOverride || undefined,
    ttlMs: config.registryCacheTtlMs,
    timeoutMs: config.registryProbeTimeoutMs,
  })
  const installRoot = join(dataDir, 'kernels')
  const installer = new KernelInstaller({ installRoot, selector, timeoutMs: config.installTimeoutMs, trustMirror: () => settings.get().registryTrustMirror })
  const runner = new KernelRunner({
    tokens,
    gatewayUrl: () => gateway.baseUrl,
    runsRoot: join(dataDir, 'tmp'),
    installRoot,
    binaryOverride: id => settings.kernel(id).binaryPath || undefined,
    approvalBridge: true,
    envPassthrough: () => config.kernelEnvPassthrough,
    protectedPaths: () => [dshHome(), dataDir],
  })
  const kernels = new KernelService(runner, installer, settings, { provider: providerName, chatRoute })

  const complete = async (system: string, user: string, signal: AbortSignal): Promise<string> => {
    const request: CanonicalRequest = { model: '', system, turns: [{ role: 'user', text: user }], tools: [], stream: true }
    const result = await collect(upstream.stream(request, upstreamTarget(), signal))
    if (result.finish === 'error' || result.finish === 'aborted') throw new Error(result.error ?? 'model call failed')
    return result.text
  }

  const executors = createExecutors({
    agents: new DshAgentRunner({
      agents,
      defaultModel: () => {
        try {
          const t = upstreamTarget()
          return { provider: t.provider, model: t.model }
        } catch {
          return undefined
        }
      },
      installModelSelection: (agentCtx, selection) => installModelSelection(agentCtx as never, selection as never),
      defaultCwd: () => process.cwd(),
      waitForChildren: async agent => ((await (c.get('subagents') as { waitForChildren?(a: unknown): Promise<boolean> } | undefined)?.waitForChildren?.(agent)) ?? false),
    }),
    kernels,
    kernelTarget: model => upstreamTarget(model),
    defaultCwd: () => process.cwd(),
    outbound: { allowPrivateHosts: config.allowPrivateHosts, maxResponseBytes: config.outboundMaxResponseKb * 1024, timeoutMs: config.outboundTimeoutMs },
    script: { timeoutMs: config.scriptTimeoutMs, maxHeapMb: config.scriptMaxHeapMb },
    kernelTimeoutMs: config.kernelTimeoutMs,
  })

  // Script nodes are an operator decision (plugin Config only); the browser cannot switch them on.
  const scriptsAllowed = (): boolean => config.allowScriptNodes
  const engine = new WorkflowEngine({
    store,
    executors,
    scriptsAllowed,
    knownKernels: () => listKernels().map(k => k.id),
    logger: log,
    defaultConcurrency: config.defaultConcurrency,
    requireReview: true,
    maxActiveRuns: config.maxActiveRuns,
    ...(config.defaultRunDeadlineMs > 0 ? { defaultDeadlineMs: config.defaultRunDeadlineMs } : {}),
  })
  const chatRuns = new Map<string, { agent: HostAgent; callId: string }>()
  engine.setExternalApproval({
    async ask(run, node, message, signal) {
      const binding = chatRuns.get(run.id)
      const service = approval()
      if (binding === undefined || service === undefined) return undefined
      const outcome = await service.request({ agent: binding.agent, toolName: `${BRAND.toolPrefix}_workflow_run`, callId: binding.callId, reason: `${run.workflowName} › ${node.name}: ${message}`, signal })
      if (outcome === 'unavailable' || outcome === 'cancelled') return undefined
      return { approved: outcome === 'allowed-once', by: 'dsh-approval' }
    },
  })

  const runtime: LuluxFlowRuntime = {
    store,
    engine,
    kernels,
    settings,
    gateway,
    selector,
    get scriptsAllowed() {
      return scriptsAllowed()
    },
    scriptsForcedByConfig: config.allowScriptNodes,
    upstreamTarget: () => upstreamTarget(),
    upstreamInfo: () => resolver.resolve(),
    generate: (description, signal) =>
      generateWorkflow(description, {
        complete,
        lint: wf => engine.lint(wf),
        kernels: listKernels().map(k => k.id),
        scriptsAllowed: scriptsAllowed(),
        newId: () => store.newId(),
        signal,
      }),
    startRun: (workflowId, inputs, trigger, options) => {
      const wf = store.getWorkflow(workflowId)
      if (wf === undefined) throw new Error(`workflow not found: ${workflowId}`)
      return engine.start(wf, inputs, trigger, undefined, options)
    },
    approval,
    logger: log,
  }

  // Lifecycle: gateway up, crashed runs marked, cron ticking, everything torn down on unload.
  c.effect(() => {
    let stopped = false
    // Per-run homes left behind by a crash hold configs with (expired) tokens and prompts.
    try {
      rmSync(join(dataDir, 'tmp'), { recursive: true, force: true, maxRetries: 3 })
    } catch (error: unknown) {
      log.warn(`could not clean ${join(dataDir, 'tmp')}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const recovered = engine.recover()
    if (recovered > 0) log.info(`${recovered} run(s) were interrupted by a restart and can be resumed`)
    void gateway.start().catch((error: unknown) => log.warn(`gateway failed to start: ${error instanceof Error ? error.message : String(error)}`))
    const lastFired = new Map<string, string>()
    // Remember the last real DSH default model per profile (DSH has no change event; this is a cheap read).
    const observe = (): void => {
      try {
        resolver.observe()
      } catch (error: unknown) {
        log.debug(`model memory: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    observe()
    const observer = setInterval(observe, config.modelObserveIntervalMs)
    observer.unref?.()
    const stopTicker = startMinuteTicker(now => {
      if (stopped) return
      // Local minute (cron evaluates in local time), so a DST fall-back hour does not fire twice.
      const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`
      for (const wf of store.listWorkflows()) {
        for (const trigger of wf.triggers?.cron ?? []) {
          if (!trigger.enabled) continue
          const key = `${wf.id}:${trigger.id}`
          if (lastFired.get(key) === minute) continue
          try {
            if (!matches(parseCron(trigger.expression), now)) continue
          } catch {
            continue
          }
          lastFired.set(key, minute)
          const active = store.listRuns({ workflowId: wf.id, limit: 20 }).some(r => r.trigger.kind === 'cron' && r.trigger.detail === trigger.id && ['queued', 'running', 'waiting'].includes(r.status))
          if (active) {
            log.info(`cron ${key}: previous run still active, skipping`)
            continue
          }
          try {
            engine.start(wf, trigger.inputs ?? {}, { kind: 'cron', detail: trigger.id })
          } catch (error: unknown) {
            log.warn(`cron ${key}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    })
    return async () => {
      stopped = true
      clearInterval(observer)
      stopTicker()
      await engine.shutdown()
      tokens.clear()
      await gateway.stop()
    }
  }, `${BRAND.id}: runtime`)

  // HTTP API + webhooks on the DSH web server, when the profile has one (web/desktop).
  c.plugin({
    name: `${BRAND.id}-http`,
    inject: ['webServer'],
    apply(sub: { webServer: typeof c.webServer }) {
      sub.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createApi({
          runtime,
          authorize: req => {
            const connection = c.get('connection') as { requestRejection(r: { headers: unknown }): 401 | 403 | undefined } | undefined
            if (connection === undefined) return 403
            return connection.requestRejection({ headers: req.headers })
          },
          maxBodyBytes: 4 * 1024 * 1024,
          version: VERSION,
        }),
      })
    },
  })

  // A CLI as the main agent of a chat session (DSH model picker).
  if (config.registerChatRoutes) {
    const sessions = new ChatSessionMap(dataDir)
    const adapter = new LuluxFlowKernelAdapter(
      provider => listKernels().find(k => chatRoute(k.id) === provider),
      {
        kernels,
        sessions,
        target: () => upstreamTarget(),
        cwdFor: sessionId => (sessionId !== undefined ? agents()?.get(sessionId)?.session.header?.cwd : undefined) ?? process.cwd(),
        timeoutMs: config.kernelTimeoutMs,
        auxiliary: (options: GenerateOptions) => {
          const t = upstreamTarget()
          return c.llm.stream({ ...options, provider: t.provider, model: t.model })
        },
      },
    )
    c.effect(() => c.llm.registerAdapter([...kernelRoutes], adapter), `${BRAND.id}: kernel chat routes`)
  }

  // Subagent providers (`lulux-flow-claude-code`, ...) once ctx.subagents exists.
  if (config.registerSubagentProviders) {
    c.plugin({
      name: `${BRAND.id}-subagents`,
      inject: ['subagents'],
      apply(sub: { subagents: { registerProvider(p: unknown): () => void }; effect: typeof c.effect }) {
        for (const kernel of listKernels()) {
          sub.subagents.registerProvider(new LuluxFlowSubagentProvider(kernel, { kernels, target: () => upstreamTarget(), timeoutMs: config.kernelTimeoutMs, logger: log }))
        }
      },
    })
  }

  // Model tools once ctx.tools exists.
  if (config.registerTools) {
    c.plugin({
      name: `${BRAND.id}-tools`,
      inject: ['tools'],
      apply(sub: { tools: { register(tool: unknown): () => void } }) {
        for (const tool of createTools(runtime, {
          bind: (runId, agent, callId) => chatRuns.set(runId, { agent, callId }),
          unbind: runId => chatRuns.delete(runId),
        })) {
          sub.tools.register(tool)
        }
      },
    })
  }

  log.info(`ready (data: ${dataDir.replace(homedir(), '~')})`)
}
