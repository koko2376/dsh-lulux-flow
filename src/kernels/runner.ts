/**
 * Runs one kernel (external CLI) invocation end to end:
 * isolated home → run-scoped token → spawn → parse JSONL → settle → revoke.
 *
 * Invariants:
 * - the token is revoked in `finally`, whatever happens;
 * - the isolated home is removed after the run unless `keepHome` is set;
 * - provider keys are never passed to the child (not in argv, env or the
 *   config files written here). The child runs as the same OS user as DSH,
 *   so it can still read files that user can read; see SECURITY.md.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { UpstreamTarget } from '../gateway/canonical.js'
import type { TokenStore } from '../gateway/tokens.js'
import { redact, TailBuffer } from '../util/redact.js'
import { safeJoin } from '../util/fs.js'
import { nodeSpawnEnv, resolveBinary, spawnArgs, type ResolvedBinary } from './binary.js'
import { globalBaseEnv, scopedBaseEnv } from './env.js'
import { killTree } from './kill.js'
import type { SessionStateStore } from './session-state.js'
import type { KernelQueueStatus } from './limiter.js'
import type { KernelDefinition, KernelEvent, KernelMode, KernelPermission } from './types.js'

export interface KernelRunRequest {
  kernel: KernelDefinition
  prompt: string
  cwd: string
  mode: KernelMode
  permission: KernelPermission
  /** Upstream the gateway routes this run to (scoped mode). */
  target: UpstreamTarget
  runId: string
  sessionId?: string
  resumeSessionId?: string
  timeoutMs: number
  signal?: AbortSignal
  onEvent?: (event: KernelEvent) => void
  /**
   * Extra system instructions (an agent identity). Delivered the way the
   * kernel declares in `systemPromptVia`; never repeated in the prompt of a
   * resumed native session.
   */
  appendSystemPrompt?: string
  /** Called once when the run has to wait for a free slot (see KernelService.run). */
  onQueued?: (status: KernelQueueStatus) => void
}

/** Where a run's extra system instructions go: the CLI's own option, the top of the prompt, or nowhere. */
export function systemPromptPlacement(kernel: KernelDefinition, text: string | undefined, resuming: boolean): 'flag' | 'prompt' | undefined {
  if (text === undefined || text.trim() === '') return undefined
  const via = kernel.systemPromptVia ?? 'prompt'
  if (via === 'flag') return 'flag'
  if (resuming) return undefined
  return via === 'flag-new-session' ? 'flag' : 'prompt'
}

/** A new native session's prompt with the extra system instructions on top (CLIs without an option for them). */
export function withSystemPrompt(text: string, prompt: string): string {
  return `Instructions for this conversation (treat them as your system prompt):\n\n${text.trim()}\n\n---\n\n${prompt}`
}

export interface KernelRunResult {
  status: 'completed' | 'error' | 'aborted' | 'timeout'
  text: string
  /** Native CLI session id, when the CLI reported one. */
  nativeSessionId?: string
  usage: { inputTokens: number; outputTokens: number; requests: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  exitCode: number | null
  durationMs: number
  diagnostic?: string
  tools: Array<{ name: string; detail: string }>
}

export interface KernelRunnerDeps {
  tokens: TokenStore
  gatewayUrl: () => string
  /** Root of per-run isolated homes. */
  runsRoot: string
  /** Root of LULUX Flow-managed CLI installs. */
  installRoot: string
  binaryOverride?: (kernelId: string) => string | undefined
  approvalBridge: boolean
  keepHome?: boolean
  graceMs?: number
  /** Spawn hook for tests. */
  resolve?: (kernel: KernelDefinition) => ResolvedBinary | undefined
  /** Extra variable names for scoped CLIs (plugin Config `kernelEnvPassthrough`). */
  envPassthrough?: () => readonly string[]
  /** Paths CLIs are told not to read (DSH home, plugin data dir). */
  protectedPaths?: () => readonly string[]
  /** Cap on CLI stdout kept per run (bytes). Default 16 MB. */
  maxOutputBytes?: number
  /** Keeps native session transcripts between scoped runs so `--resume` finds them. */
  sessionState?: SessionStateStore
}

const LOGIN_PATTERN = /\b(log ?in|sign ?in|unauthori[sz]ed|authenticat|api[ _-]?key|credential|\/login|oauth)/i

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export class KernelRunner {
  constructor(private readonly deps: KernelRunnerDeps) {}

  resolveBinary(kernel: KernelDefinition): ResolvedBinary | undefined {
    if (this.deps.resolve) return this.deps.resolve(kernel)
    const override = this.deps.binaryOverride?.(kernel.id)
    return resolveBinary(kernel, { installRoot: this.deps.installRoot, ...(override ? { overridePath: override } : {}) })
  }

  async run(request: KernelRunRequest): Promise<KernelRunResult> {
    const started = Date.now()
    const { kernel } = request
    const tools: KernelRunResult['tools'] = []
    const base: Omit<KernelRunResult, 'status' | 'durationMs'> = { text: '', usage: { inputTokens: 0, outputTokens: 0, requests: 0 }, exitCode: null, tools }
    const binary = this.resolveBinary(kernel)
    if (binary === undefined) {
      return { ...base, status: 'error', durationMs: 0, diagnostic: `${kernel.name} is not installed. Install it from DSH-LULUX Flow → Kernels, or put \`${kernel.bin}\` on PATH.` }
    }
    if (binary.problem !== undefined) return { ...base, status: 'error', durationMs: 0, diagnostic: `${kernel.name} cannot be started: ${binary.problem}` }
    if (request.signal?.aborted) return { ...base, status: 'aborted', durationMs: 0 }
    if (!isDirectory(request.cwd)) {
      // spawn() reports a missing cwd as "spawn <binary> ENOENT", which reads as "CLI not installed".
      return { ...base, status: 'error', durationMs: 0, diagnostic: `working directory does not exist: ${request.cwd}` }
    }

    mkdirSync(this.deps.runsRoot, { recursive: true, mode: 0o700 })
    const home = mkdtempSync(join(this.deps.runsRoot, `${kernel.id}-`))
    chmodSync(home, 0o700)
    const scoped = request.mode === 'scoped'
    const issued = scoped
      ? this.deps.tokens.issue(
          {
            runId: request.runId,
            kernelId: kernel.id,
            target: request.target,
            protocols: kernel.protocols,
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
          },
          request.timeoutMs + 60_000,
        )
      : undefined

    try {
      const resume = request.resumeSessionId !== undefined && kernel.supportsResume ? request.resumeSessionId : undefined
      // Scoped homes are fresh per run: put the saved transcript back before resuming it.
      const keepsState = scoped && this.deps.sessionState !== undefined && (kernel.sessionStateDirs?.length ?? 0) > 0
      if (resume !== undefined && keepsState && !this.deps.sessionState!.restore(kernel, resume, home)) {
        return { ...base, status: 'error', durationMs: Date.now() - started, diagnostic: `${kernel.name} has no saved session ${resume} to resume` }
      }
      const placement = systemPromptPlacement(kernel, request.appendSystemPrompt, resume !== undefined)
      const prompt = placement === 'prompt' ? withSystemPrompt(request.appendSystemPrompt!, request.prompt) : request.prompt
      const launch = kernel.launch({
        mode: request.mode,
        permission: request.permission,
        home,
        gatewayUrl: scoped ? this.deps.gatewayUrl() : '',
        token: issued?.token ?? '',
        model: request.target.model,
        ...(resume !== undefined ? { resumeSessionId: resume } : {}),
        approvalBridge: scoped && this.deps.approvalBridge && kernel.supportsApprovalBridge,
        protectedPaths: this.deps.protectedPaths?.() ?? [],
        ...(placement === 'flag' ? { appendSystemPrompt: request.appendSystemPrompt!.trim() } : {}),
      })
      for (const [rel, content] of Object.entries(launch.files ?? {})) {
        let file: string
        try {
          file = safeJoin(home, rel)
        } catch {
          throw new Error('kernel adapter tried to write outside its home')
        }
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        writeFileSync(file, content, { mode: 0o600 })
      }
      let promptFile: string | undefined
      if (launch.promptVia === 'file') {
        promptFile = join(home, 'prompt.txt')
        writeFileSync(promptFile, prompt, { mode: 0o600 })
      }
      const args = launch.args.map(arg => arg.replaceAll('{home}', home).replaceAll('{promptFile}', promptFile ?? ''))
      if (launch.promptVia === 'arg') args.push(prompt)
      const env = { ...(scoped ? scopedBaseEnv(process.env, this.deps.envPassthrough?.() ?? []) : globalBaseEnv()), ...launch.env }

      const result = await this.spawnAndParse(binary, args, env, request, launch.promptVia === 'stdin' ? prompt : undefined, tools)
      if (keepsState && result.nativeSessionId !== undefined) {
        try {
          this.deps.sessionState!.save(kernel, result.nativeSessionId, home)
        } catch {
          /* a failed save only costs the next turn its native resume (it falls back to replayed context) */
        }
      }
      if (issued !== undefined) {
        const stats = issued.record.stats
        result.usage = {
          inputTokens: stats.inputTokens || result.usage.inputTokens,
          outputTokens: stats.outputTokens || result.usage.outputTokens,
          requests: stats.requests,
          ...(stats.cacheReadTokens > 0 ? { cacheReadTokens: stats.cacheReadTokens } : {}),
          ...(stats.cacheWriteTokens > 0 ? { cacheWriteTokens: stats.cacheWriteTokens } : {}),
        }
        if (result.status === 'error' && result.text === '' && stats.reasoningOnlyReplies > 0 && result.diagnostic?.startsWith(`${kernel.name} finished without an answer`)) {
          const times = stats.reasoningOnlyReplies > 1 ? ` (${stats.reasoningOnlyReplies} replies in a row)` : ''
          result.diagnostic = `${kernel.name} finished without an answer: ${request.target.model} returned only its reasoning and no reply text${times}. Ask again, or choose a lower reasoning effort for this model in DSH.`
        }
        if (result.status === 'error' && stats.lastError !== null && result.diagnostic !== undefined && !result.diagnostic.includes(stats.lastError)) {
          result.diagnostic = `${result.diagnostic} (upstream: ${redact(stats.lastError)})`
        }
      }
      if (!scoped && result.status === 'error' && result.diagnostic !== undefined && LOGIN_PATTERN.test(result.diagnostic)) {
        result.diagnostic = `${kernel.name} needs its own login in global mode. ${kernel.loginHint} (${result.diagnostic})`
      }
      result.durationMs = Date.now() - started
      return result
    } finally {
      issued?.revoke()
      if (!this.deps.keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    }
  }

  private spawnAndParse(
    binary: ResolvedBinary,
    args: string[],
    env: Record<string, string>,
    request: KernelRunRequest,
    stdinText: string | undefined,
    tools: KernelRunResult['tools'],
  ): Promise<KernelRunResult> {
    return new Promise(resolve => {
      const parser = request.kernel.parser()
      const stderr = new TailBuffer(4000)
      let text = ''
      let finalText: string | undefined
      let nativeSessionId: string | undefined
      let fatal: string | undefined
      let lastError: string | undefined
      let reasoningSeen = false
      const usage = { inputTokens: 0, outputTokens: 0, requests: 0 }
      let settled = false
      let timedOut = false
      let aborted = false

      const spec = spawnArgs(binary, args)
      const child = spawn(spec.command, spec.args, {
        cwd: request.cwd,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        env: nodeSpawnEnv(spec.command, env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })

      const terminate = (): void => {
        killTree(child.pid, 'SIGTERM')
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) killTree(child.pid, 'SIGKILL')
        }, this.deps.graceMs ?? 3000).unref()
      }
      const timer = setTimeout(() => {
        timedOut = true
        terminate()
      }, request.timeoutMs)
      const onAbort = (): void => {
        aborted = true
        terminate()
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const emit = (event: KernelEvent): void => {
        switch (event.type) {
          case 'text':
            if (event.final === true) text += (text && !text.endsWith('\n') ? '\n\n' : '') + event.text
            else text += event.text
            break
          case 'reasoning':
            reasoningSeen = true
            break
          case 'tool':
            tools.push({ name: event.name, detail: event.detail })
            break
          case 'session':
            nativeSessionId = event.id
            break
          case 'usage':
            usage.inputTokens = event.inputTokens
            usage.outputTokens = event.outputTokens
            break
          case 'error':
            if (event.fatal) fatal = event.message
            else lastError = event.message
            break
          case 'done':
            if (event.text) finalText = event.text
            break
          default:
            break
        }
        try {
          request.onEvent?.(event)
        } catch {
          /* observer failures never break the run */
        }
      }

      let buffer = ''
      let received = 0
      const maxOutput = this.deps.maxOutputBytes ?? 16 * 1024 * 1024
      let overflow = false
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (overflow) return
        received += chunk.length
        if (received > maxOutput || buffer.length + chunk.length > 4 * 1024 * 1024) {
          overflow = true
          fatal = `${request.kernel.name} produced more than ${received > maxOutput ? `${maxOutput} bytes of output` : 'a 4 MB line'}; stopped`
          terminate()
          return
        }
        buffer += chunk
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '').trim()
          buffer = buffer.slice(index + 1)
          index = buffer.indexOf('\n')
          if (!line.startsWith('{')) continue
          try {
            for (const event of parser.line(JSON.parse(line) as Record<string, unknown>)) emit(event)
          } catch {
            /* non-JSON noise */
          }
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => stderr.push(chunk))

      const finish = (code: number | null, spawnError?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        const output = (text || finalText || '').trim()
        const base = { text: output, usage, exitCode: code, durationMs: 0, tools, ...(nativeSessionId !== undefined ? { nativeSessionId } : {}) }
        if (spawnError) return resolve({ ...base, status: 'error', diagnostic: `failed to start ${request.kernel.name}: ${spawnError.message}` })
        if (aborted) return resolve({ ...base, status: 'aborted' })
        if (timedOut) return resolve({ ...base, status: 'timeout', diagnostic: `${request.kernel.name} exceeded ${request.timeoutMs} ms` })
        if (fatal !== undefined) {
          // a bare fatal message gains the CLI's own stderr, which usually names the cause
          const tail = /reported an error|failed while running$/.test(fatal) ? stderr.toString().replace(/\s+/g, ' ').trim().slice(-400) : ''
          return resolve({ ...base, status: 'error', diagnostic: redact(tail ? `${fatal}: ${tail}` : fatal) })
        }
        if (code !== 0) {
          const detail = redact((lastError ?? stderr.toString()).replace(/\s+/g, ' ').trim().slice(-400))
          return resolve({ ...base, status: 'error', diagnostic: `${request.kernel.name} exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}` })
        }
        if (!output) {
          const why = lastError !== undefined ? `: ${redact(lastError)}` : reasoningSeen ? ': the model returned only its reasoning and no reply text' : ''
          return resolve({ ...base, status: 'error', diagnostic: `${request.kernel.name} finished without an answer${why}` })
        }
        resolve({ ...base, status: 'completed' })
      }
      child.on('error', error => finish(null, error))
      child.on('close', code => finish(code))
      child.stdin.on('error', () => undefined)
      if (stdinText !== undefined) child.stdin.end(stdinText)
      else child.stdin.end()
    })
  }
}
