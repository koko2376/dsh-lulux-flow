/**
 * Permission policy for kernel runs started by workflows.
 *
 * The Kernels page setting is the ceiling. A workflow node may ask for a
 * lower permission, never a higher one, and may use `global` mode only when
 * the user set that CLI to `global`. Workflow runs are unattended, so `ask`
 * cannot prompt anyone and degrades to `read-only`.
 */
import type { KernelDefinition, KernelMode, KernelPermission } from './types.js'

export const PERMISSIONS: readonly KernelPermission[] = ['read-only', 'ask', 'edit', 'full']
export const MODES: readonly KernelMode[] = ['scoped', 'global']

const RANK: Record<KernelPermission, number> = { 'read-only': 0, ask: 1, edit: 2, full: 3 }

export function isPermission(value: unknown): value is KernelPermission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}

export function isMode(value: unknown): value is KernelMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

/** Permission levels a CLI can actually enforce (default: all). */
export function supportedPermissions(def: Pick<KernelDefinition, 'permissions'>): readonly KernelPermission[] {
  return def.permissions ?? PERMISSIONS
}

export interface KernelPolicyInput {
  /** What the node asks for (raw config value; anything that is not a literal level is ignored). */
  requestedMode?: unknown
  requestedPermission?: unknown
  /** The user's Kernels page setting for this CLI. */
  setting: { mode: KernelMode; permission: KernelPermission }
  def: Pick<KernelDefinition, 'permissions' | 'name'>
  /** Unattended runs turn `ask` into `read-only`. Default true. */
  unattended?: boolean
}

export interface KernelPolicy {
  mode: KernelMode
  permission: KernelPermission
  /** Human-readable notes when the request was lowered. */
  notes: string[]
}

/** Lower of two permissions. */
export function minPermission(a: KernelPermission, b: KernelPermission): KernelPermission {
  return RANK[a] <= RANK[b] ? a : b
}

export function effectiveKernelPolicy(input: KernelPolicyInput): KernelPolicy {
  const notes: string[] = []
  const { setting, def } = input
  let mode: KernelMode = setting.mode
  if (input.requestedMode === 'scoped') mode = 'scoped'
  else if (input.requestedMode === 'global' && setting.mode !== 'global') notes.push(`node asked for global mode; ${def.name} is set to scoped on the Kernels page, so it runs scoped`)
  const requested = isPermission(input.requestedPermission) ? input.requestedPermission : setting.permission
  let permission = minPermission(requested, setting.permission)
  if (permission !== requested) notes.push(`node asked for "${requested}"; capped at "${setting.permission}" (the Kernels page setting)`)
  const supported = supportedPermissions(def)
  if (!supported.includes(permission)) {
    // Never round up: fall back to the strongest supported level below the request.
    const lower = [...supported].filter(p => RANK[p] < RANK[permission]).sort((a, b) => RANK[b] - RANK[a])[0] ?? 'read-only'
    notes.push(`${def.name} cannot enforce "${permission}"; running "${lower}"`)
    permission = lower
  }
  if ((input.unattended ?? true) && permission === 'ask') permission = 'read-only'
  return { mode, permission, notes }
}

/** Whether a policy grants more than reading: file edits, unrestricted tools or the user's own CLI login. */
export function isElevated(policy: Pick<KernelPolicy, 'mode' | 'permission'>): boolean {
  return policy.permission === 'edit' || policy.permission === 'full' || policy.mode === 'global'
}
