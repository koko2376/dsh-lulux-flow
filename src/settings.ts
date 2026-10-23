/**
 * Runtime settings edited from the LULUX Flow settings page and persisted in
 * `<dataDir>/settings.json`. Deployment-level defaults come from the plugin
 * Config (cordis.patch.yml); these settings override them per user.
 */
import { join } from 'node:path'
import { BRAND } from './brand.js'
import type { KernelMode, KernelPermission } from './kernels/types.js'
import { readJsonFile, writeJsonAtomic } from './util/fs.js'
import { findKernel } from './kernels/catalog.js'
import { supportedPermissions } from './kernels/policy.js'
import { normalizeRegistry } from './kernels/registry-probe.js'
import { isUpdateSourceMode, type UpdateSourceMode } from './update/service.js'

export interface KernelSettings {
  enabled: boolean
  mode: KernelMode
  permission: KernelPermission
  /** Explicit executable path; empty means auto-detect. */
  binaryPath: string
}

export interface LuluxFlowSettings {
  kernels: Record<string, Partial<KernelSettings>>
  /** Preferred npm registry for kernel installs; empty = auto-detect fastest. */
  registryOverride: string
  /**
   * "Gateway model": pin the real model kernel traffic is forwarded to
   * (`provider/model`). Empty = follow DSH's default model, falling back to
   * the last real model remembered for this profile when the default is a
   * LULUX Flow CLI route. LULUX Flow routes are refused here (loop guard).
   */
  gatewayModel: string
  /**
   * Kept for compatibility with 0.1.0 settings files; no longer enables
   * anything. Script nodes run code as your OS user and can only be enabled
   * with the plugin Config option `allowScriptNodes: true`.
   */
  allowScriptNodes: boolean
  /**
   * Install kernels from a mirror even when registry.npmjs.org cannot be
   * reached to build the lockfile. Off by default: then every tarball is
   * checked against integrity hashes from npmjs.org, and without npmjs.org
   * the install is refused. On: the mirror is trusted for the whole tree.
   */
  registryTrustMirror: boolean
  /**
   * Language of the plugin's UI and of the text it puts in DSH's approval
   * dialog. Independent of DSH's own locale; Chinese by default.
   */
  language: PluginLanguage
  /** Check for new releases automatically; null = follow the plugin Config (`updateAutoCheck`). */
  updateAutoCheck: boolean | null
  /** Where update checks ask: auto (fastest), official (GitHub) or mirror; null = follow the plugin Config. */
  updateSource: UpdateSourceMode | null
}

export type PluginLanguage = 'zh-CN' | 'en'
export const PLUGIN_LANGUAGES: readonly PluginLanguage[] = ['zh-CN', 'en']
export const DEFAULT_LANGUAGE: PluginLanguage = 'zh-CN'

export function isPluginLanguage(value: unknown): value is PluginLanguage {
  return typeof value === 'string' && (PLUGIN_LANGUAGES as readonly string[]).includes(value)
}

export const DEFAULT_KERNEL_SETTINGS: KernelSettings = { enabled: false, mode: 'scoped', permission: 'ask', binaryPath: '' }

/** Kernels enabled out of the box; every other CLI is opt-in from the Kernels page. */
export const DEFAULT_ENABLED_KERNELS: readonly string[] = ['claude-code', 'codex']

/** Product defaults for one kernel before any user override. */
export function defaultKernelSettings(id: string): KernelSettings {
  return { ...DEFAULT_KERNEL_SETTINGS, enabled: DEFAULT_ENABLED_KERNELS.includes(id) }
}

export const SCRIPT_NODES_WARNING =
  'Script nodes are on (plugin config allowScriptNodes). They are not a sandbox: treat a script node like running a program as your OS user. Only run script nodes you wrote or reviewed.'

const PERMISSIONS: readonly KernelPermission[] = ['read-only', 'ask', 'edit', 'full']

export class SettingsStore {
  private value: LuluxFlowSettings
  private readonly file: string

  constructor(
    dataDir: string,
    private readonly isKernelRoute: (provider: string) => boolean = provider => provider.startsWith(`${BRAND.providerPrefix}-`),
  ) {
    this.file = join(dataDir, 'settings.json')
    const loaded = readJsonFile<Partial<LuluxFlowSettings>>(this.file) ?? {}
    this.value = {
      kernels: loaded.kernels !== undefined && typeof loaded.kernels === 'object' ? loaded.kernels : {},
      registryOverride: typeof loaded.registryOverride === 'string' ? loaded.registryOverride : '',
      gatewayModel: typeof loaded.gatewayModel === 'string' ? loaded.gatewayModel : '',
      allowScriptNodes: loaded.allowScriptNodes === true,
      registryTrustMirror: loaded.registryTrustMirror === true,
      language: isPluginLanguage(loaded.language) ? loaded.language : DEFAULT_LANGUAGE,
      updateAutoCheck: typeof loaded.updateAutoCheck === 'boolean' ? loaded.updateAutoCheck : null,
      updateSource: isUpdateSourceMode(loaded.updateSource) ? loaded.updateSource : null,
    }
  }

  get(): LuluxFlowSettings {
    return structuredClone(this.value)
  }

  kernel(id: string, defaults: Partial<KernelSettings> = {}): KernelSettings {
    return { ...defaultKernelSettings(id), ...defaults, ...(this.value.kernels[id] ?? {}) }
  }

  update(patch: unknown): LuluxFlowSettings {
    const input = (patch ?? {}) as Partial<LuluxFlowSettings>
    const next = this.get()
    if (typeof input.registryOverride === 'string') {
      const value = input.registryOverride.trim()
      if (value) normalizeRegistry(value)
      next.registryOverride = value
    }
    if (typeof input.gatewayModel === 'string') {
      const value = input.gatewayModel.trim()
      if (value && !/^[^/\s]+\/\S+$/.test(value)) throw new Error('gatewayModel must look like provider/model')
      if (value && this.isKernelRoute(value.slice(0, value.indexOf('/')))) throw new Error(`gatewayModel must be a real model, not a ${BRAND.displayName} CLI route (that would route a CLI to itself)`)
      next.gatewayModel = value
    }
    if (input.allowScriptNodes !== undefined) {
      if (typeof input.allowScriptNodes !== 'boolean') throw new Error('allowScriptNodes must be true or false')
      next.allowScriptNodes = input.allowScriptNodes
    }
    if (input.registryTrustMirror !== undefined) {
      if (typeof input.registryTrustMirror !== 'boolean') throw new Error('registryTrustMirror must be true or false')
      next.registryTrustMirror = input.registryTrustMirror
    }
    if (input.language !== undefined) {
      if (!isPluginLanguage(input.language)) throw new Error(`language must be one of ${PLUGIN_LANGUAGES.join(', ')}`)
      next.language = input.language
    }
    if (input.updateAutoCheck !== undefined) {
      if (input.updateAutoCheck !== null && typeof input.updateAutoCheck !== 'boolean') throw new Error('updateAutoCheck must be true, false or null')
      next.updateAutoCheck = input.updateAutoCheck
    }
    if (input.updateSource !== undefined) {
      if (input.updateSource !== null && !isUpdateSourceMode(input.updateSource)) throw new Error('updateSource must be auto, official or mirror')
      next.updateSource = input.updateSource
    }
    if (input.kernels !== undefined && typeof input.kernels === 'object') {
      for (const [id, raw] of Object.entries(input.kernels)) {
        if (!/^[a-z0-9-]{1,40}$/.test(id) || raw === null || typeof raw !== 'object') continue
        const current = next.kernels[id] ?? {}
        const k = raw as Partial<KernelSettings>
        if (typeof k.enabled === 'boolean') current.enabled = k.enabled
        if (k.mode === 'scoped' || k.mode === 'global') current.mode = k.mode
        if (typeof k.permission === 'string' && PERMISSIONS.includes(k.permission)) {
          const def = findKernel(id)
          if (def !== undefined && !supportedPermissions(def).includes(k.permission)) throw new Error(`${def.name} cannot enforce "${k.permission}" (see docs/kernels.md); choose another level`)
          current.permission = k.permission
        }
        if (typeof k.binaryPath === 'string') current.binaryPath = k.binaryPath.trim()
        next.kernels[id] = current
      }
    }
    this.value = next
    writeJsonAtomic(this.file, next)
    return this.get()
  }
}
