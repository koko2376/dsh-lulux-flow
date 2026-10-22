/**
 * Picks the real model the scoped gateway forwards kernel traffic to.
 *
 * DSH's model picker persists whatever the user selects as the profile's
 * default model (`agentDefaultModel.saveSelection`). After the user picks a
 * LULUX Flow chat route (`lulux-flow-claude-code/default`, ...) the DSH default is a
 * CLI, not a model, so the gateway cannot simply follow it. Resolution order:
 *
 * 1. an explicit `provider/model` on the workflow node, if it is a real model;
 * 2. the pinned "Gateway model" setting, if set;
 * 3. DSH's current default model, if it is a real model (it is remembered);
 * 4. the last real default model remembered for this DSH profile;
 * 5. otherwise a clear error telling the user to set "Gateway model".
 *
 * Loop guard: a candidate whose provider is one of LULUX Flow's own kernel routes
 * is never returned, so a CLI can never be routed to itself (or to another
 * CLI). Remembered models whose provider is no longer registered are skipped.
 */
import { join } from 'node:path'
import { BRAND } from '../brand.js'
import type { UpstreamTarget } from '../gateway/canonical.js'
import { readJsonFile, writeJsonAtomic } from '../util/fs.js'
import type { ModelSelection } from './host-types.js'

export type UpstreamSource = 'node' | 'setting' | 'dsh-default' | 'remembered'

export interface ResolvedUpstream {
  target: UpstreamTarget
  source: UpstreamSource
}

export class UpstreamLoopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamLoopError'
  }
}

interface MemoryFile {
  /** Last real (non-LULUX-Flow) DSH default model, keyed by DSH profile name. */
  profiles: Record<string, ModelSelection & { seenAt: string }>
}

/** Persists the last real DSH default model per profile in `<dataDir>/model-memory.json`. */
export class ModelMemory {
  private readonly file: string
  private value: MemoryFile

  constructor(dataDir: string) {
    this.file = join(dataDir, 'model-memory.json')
    const loaded = readJsonFile<Partial<MemoryFile>>(this.file)
    this.value = { profiles: loaded?.profiles !== undefined && typeof loaded.profiles === 'object' ? loaded.profiles : {} }
  }

  get(profile: string): ModelSelection | undefined {
    const entry = this.value.profiles[profile]
    if (entry === undefined || typeof entry.provider !== 'string' || typeof entry.model !== 'string') return undefined
    return { provider: entry.provider, model: entry.model, ...(typeof entry.reasoningEffort === 'string' ? { reasoningEffort: entry.reasoningEffort } : {}) }
  }

  /** Remember `selection` for `profile`; writes only when it changed. */
  remember(profile: string, selection: ModelSelection): void {
    const current = this.value.profiles[profile]
    if (current !== undefined && current.provider === selection.provider && current.model === selection.model && current.reasoningEffort === selection.reasoningEffort) return
    this.value.profiles[profile] = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
      seenAt: new Date().toISOString(),
    }
    writeJsonAtomic(this.file, this.value)
  }
}

/** Parse `provider/model` (model ids may contain further slashes). */
export function parseModelRef(value: string): UpstreamTarget | undefined {
  const trimmed = value.trim()
  const i = trimmed.indexOf('/')
  if (i <= 0 || i === trimmed.length - 1 || /\s/.test(trimmed)) return undefined
  return { provider: trimmed.slice(0, i), model: trimmed.slice(i + 1) }
}

export interface ResolverDeps {
  /** True for LULUX Flow's own kernel chat routes (`lulux-flow-claude-code`, ...). */
  isKernelRoute(provider: string): boolean
  /** DSH's current default model selection, if the service is available. */
  dshDefault(): ModelSelection | undefined
  /** The pinned "Gateway model" setting (`provider/model` or empty). */
  pinned(): string
  /** DSH profile name used to key the memory. */
  profile(): string
  memory: ModelMemory
  /** Whether a provider route is currently registered in DSH (skip stale memory). Optional. */
  providerExists?(provider: string): boolean
}

export class UpstreamResolver {
  constructor(private readonly deps: ResolverDeps) {}

  /** Record DSH's current default if it is a real model. Safe to call often. */
  observe(): void {
    const selection = this.deps.dshDefault()
    // Only remember routes DSH can actually serve right now (skips stale or foreign provider ids).
    if (selection !== undefined && this.isReal(selection.provider) && (this.deps.providerExists?.(selection.provider) ?? true)) {
      this.deps.memory.remember(this.deps.profile(), selection)
    }
  }

  resolve(explicit?: string): ResolvedUpstream {
    if (explicit !== undefined && explicit.trim() !== '') {
      const t = parseModelRef(explicit)
      if (t === undefined) throw new Error(`model must look like provider/model, got ${JSON.stringify(explicit).slice(0, 80)}`)
      if (this.isReal(t.provider)) return { target: t, source: 'node' }
      // An explicit kernel route is a loop request: fall through to the real model instead of looping.
    }
    const pinned = this.deps.pinned().trim()
    if (pinned) {
      const t = parseModelRef(pinned)
      if (t !== undefined && this.isReal(t.provider)) return { target: t, source: 'setting' }
    }
    const selection = this.deps.dshDefault()
    if (selection !== undefined && this.isReal(selection.provider)) {
      this.deps.memory.remember(this.deps.profile(), selection)
      return { target: toTarget(selection), source: 'dsh-default' }
    }
    const remembered = this.deps.memory.get(this.deps.profile())
    if (remembered !== undefined && this.isReal(remembered.provider) && (this.deps.providerExists?.(remembered.provider) ?? true)) {
      return { target: toTarget(remembered), source: 'remembered' }
    }
    throw new UpstreamLoopError(
      `${BRAND.displayName}: DSH's default model is a CLI route and no real model is known yet. ` +
        `Pick a normal model in DSH once, or set "Gateway model" (provider/model) in ${BRAND.displayName} settings.`,
    )
  }

  private isReal(provider: string): boolean {
    return provider.length > 0 && !this.deps.isKernelRoute(provider)
  }
}

function toTarget(selection: ModelSelection): UpstreamTarget {
  return { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}) }
}
