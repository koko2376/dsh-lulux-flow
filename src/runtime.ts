/**
 * The assembled plugin runtime shared by the HTTP API, model tools and the
 * DSH registrations. Built once per plugin activation in `index.ts`.
 */
import type { UpstreamTarget } from './gateway/canonical.js'
import type { ResolvedUpstream } from './dsh/upstream-resolver.js'
import type { KernelGateway } from './gateway/server.js'
import type { KernelService } from './kernels/service.js'
import type { RegistrySelector } from './kernels/registry-probe.js'
import type { SettingsStore } from './settings.js'
import type { WorkflowEngine } from './workflow/engine.js'
import type { WorkflowStore } from './workflow/store.js'
import type { LintIssue } from './workflow/validate.js'
import type { TriggerKind, Workflow, WorkflowRun } from './workflow/types.js'
import type { StartOptions } from './workflow/engine.js'
import type { HostApproval } from './dsh/host-types.js'

export interface LuluxFlowRuntime {
  store: WorkflowStore
  engine: WorkflowEngine
  kernels: KernelService
  settings: SettingsStore
  gateway: KernelGateway
  selector: RegistrySelector
  /** Effective: plugin Config `allowScriptNodes` OR the runtime setting. */
  readonly scriptsAllowed: boolean
  /** True when the plugin Config forces script nodes on (the setting cannot turn them off). */
  scriptsForcedByConfig?: boolean
  /** Directory for throwaway kernel test runs (defaults to the OS temp dir). */
  testCwd?: string
  /** Upstream model for gateway traffic (never a LULUX Flow kernel route). */
  upstreamTarget(): UpstreamTarget
  /** Same as upstreamTarget, plus where the choice came from (node, setting, dsh-default, remembered). */
  upstreamInfo(): ResolvedUpstream
  generate(description: string, signal: AbortSignal): Promise<{ workflow: Workflow; issues: LintIssue[] }>
  startRun(workflowId: string, inputs: Record<string, unknown>, trigger: { kind: TriggerKind; detail?: string }, options?: StartOptions): WorkflowRun
  /** DSH's approval service (asks the person in the DSH UI), when the profile has one. */
  approval?: () => HostApproval | undefined
  logger: { info(m: string): void; warn(m: string): void }
}
