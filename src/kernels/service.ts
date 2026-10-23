/**
 * Facade over the kernel catalog, settings, detection, installer and runner.
 */
import { hasNativeLogin, probeVersion, satisfiesMinVersion } from './binary.js'
import { findKernel, listKernels } from './catalog.js'
import type { KernelInstaller, InstallState } from './installer.js'
import type { KernelRunner, KernelRunRequest, KernelRunResult } from './runner.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { UpstreamTarget } from '../gateway/canonical.js'
import type { KernelDefinition, KernelPermission } from './types.js'
import { supportedPermissions } from './policy.js'
import { AbortedWhileQueued, KernelLimiter, type KernelLimits } from './limiter.js'

export interface KernelTestResult {
  ok: boolean
  latencyMs: number
  output?: string
  error?: string
}

/** Tiny, side-effect-free prompt for the connection test. */
export const KERNEL_TEST_PROMPT = 'This is a connectivity test. Do not use any tools. Reply with exactly the single word: OK'
export const KERNEL_TEST_TIMEOUT_MS = 45_000
import type { KernelSettings, SettingsStore } from '../settings.js'

export interface KernelInfo {
  id: string
  name: string
  vendor: string
  npmPackage: string
  avatar: string
  color: string
  minVersion: string
  supportsResume: boolean
  supportsApprovalBridge: boolean
  /** Permission levels this CLI can enforce; the pickers offer only these. */
  permissions: readonly KernelPermission[]
  installed: boolean
  /** Found but cannot be started, and why (shown on the Kernels page). */
  problem?: string
  source?: 'settings' | 'managed' | 'path'
  version?: string
  versionOk: boolean
  nativeLogin: boolean
  settings: KernelSettings
  install: InstallState
  /** Subagent provider name registered on ctx.subagents. */
  provider: string
  /** LLM provider route that makes this CLI selectable as a chat session's main agent. */
  chatRoute: string
}

/** Defaults for the CLI concurrency caps (plugin Config `kernelMaxConcurrent` / `kernelMaxConcurrentPerCli`). */
export const DEFAULT_KERNEL_LIMITS: KernelLimits = { global: 6, perKernel: 3 }

export class KernelService {
  private readonly versions = new Map<string, { file: string; version: string | undefined }>()
  readonly limiter: KernelLimiter

  constructor(
    private readonly runner: KernelRunner,
    private readonly installer: KernelInstaller,
    private readonly settings: SettingsStore,
    private readonly names: { provider: (id: string) => string; chatRoute: (id: string) => string },
    limits: () => KernelLimits = () => DEFAULT_KERNEL_LIMITS,
  ) {
    this.limiter = new KernelLimiter(limits)
  }

  find(id: string): KernelDefinition | undefined {
    return findKernel(id)
  }

  settingsOf(id: string): KernelSettings {
    return this.settings.kernel(id)
  }

  async info(def: KernelDefinition, refresh = false): Promise<KernelInfo> {
    const binary = this.runner.resolveBinary(def)
    let version: string | undefined
    if (binary !== undefined) {
      const cached = this.versions.get(def.id)
      if (!refresh && cached !== undefined && cached.file === binary.file) version = cached.version
      else {
        version = await probeVersion(binary)
        this.versions.set(def.id, { file: binary.file, version })
      }
    }
    return {
      id: def.id,
      name: def.name,
      vendor: def.vendor,
      npmPackage: def.npmPackage,
      avatar: def.avatar,
      color: def.color,
      minVersion: def.minVersion,
      supportsResume: def.supportsResume,
      supportsApprovalBridge: def.supportsApprovalBridge,
      permissions: supportedPermissions(def),
      installed: binary !== undefined,
      ...(binary?.problem !== undefined ? { problem: binary.problem } : {}),
      ...(binary !== undefined ? { source: binary.source } : {}),
      ...(version !== undefined ? { version } : {}),
      versionOk: version !== undefined ? satisfiesMinVersion(version, def.minVersion) : binary !== undefined && binary.problem === undefined,
      nativeLogin: hasNativeLogin(def),
      settings: this.settings.kernel(def.id),
      install: this.installer.state(def.id),
      provider: this.names.provider(def.id),
      chatRoute: this.names.chatRoute(def.id),
    }
  }

  async list(refresh = false): Promise<KernelInfo[]> {
    return Promise.all(listKernels().map(def => this.info(def, refresh)))
  }

  install(id: string): InstallState {
    const def = this.require(id)
    this.versions.delete(id)
    return this.installer.install(def, { forceProbe: true })
  }

  uninstall(id: string): InstallState {
    this.versions.delete(id)
    return this.installer.uninstall(this.require(id))
  }

  /**
   * One CLI run, within the concurrency caps: when they are full the run waits
   * in a FIFO queue (reported once through `request.onQueued`) and an abort
   * while waiting settles it as `aborted` without starting the CLI. The run's
   * timeout starts when the CLI starts.
   */
  async run(request: KernelRunRequest): Promise<KernelRunResult> {
    const queuedAt = Date.now()
    try {
      return await this.limiter.run(request.kernel.id, () => this.runner.run(request), {
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        ...(request.onQueued !== undefined ? { onQueued: request.onQueued } : {}),
      })
    } catch (error: unknown) {
      if (!(error instanceof AbortedWhileQueued)) throw error
      return { status: 'aborted', text: '', usage: { inputTokens: 0, outputTokens: 0, requests: 0 }, exitCode: null, durationMs: Date.now() - queuedAt, diagnostic: 'cancelled while queued', tools: [] }
    }
  }

  /**
   * Connection test: one real minimal run in the kernel's configured mode,
   * forced to read-only permission, in an empty temp directory, with a short
   * timeout. Never throws; failures come back as `{ ok: false, error }`.
   */
  async test(id: string, target: () => UpstreamTarget, options: { timeoutMs?: number; cwd?: string; signal?: AbortSignal } = {}): Promise<KernelTestResult> {
    const started = Date.now()
    const def = this.require(id)
    const settings = this.settings.kernel(id)
    let upstream: UpstreamTarget
    try {
      upstream = settings.mode === 'scoped' ? target() : { provider: 'native', model: 'default' }
    } catch (error: unknown) {
      return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
    }
    const cwd = mkdtempSync(join(options.cwd ?? tmpdir(), `lulux-flow-test-${id}-`))
    try {
      const result = await this.runner.run({
        kernel: def,
        prompt: KERNEL_TEST_PROMPT,
        cwd,
        mode: settings.mode,
        permission: 'read-only',
        target: upstream,
        runId: `test-${randomUUID()}`,
        timeoutMs: options.timeoutMs ?? KERNEL_TEST_TIMEOUT_MS,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
      const latencyMs = Date.now() - started
      if (result.status === 'completed') return { ok: true, latencyMs, output: result.text.trim().slice(0, 200) }
      return { ok: false, latencyMs, error: (result.diagnostic ?? result.status).slice(0, 500) }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  require(id: string): KernelDefinition {
    const def = findKernel(id)
    if (def === undefined) throw new Error(`unknown kernel: ${id}`)
    return def
  }
}
