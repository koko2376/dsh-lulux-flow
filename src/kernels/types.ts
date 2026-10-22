import type { GatewayProtocol } from '../gateway/tokens.js'

/** How a kernel authenticates: through the LULUX Flow gateway (scoped) or with its own native login (global). */
export type KernelMode = 'scoped' | 'global'

/**
 * Provider-neutral permission level, mapped to each CLI's own flags.
 * - `read-only`: read/search tools only.
 * - `ask`: anything beyond reads asks the user (through DSH approvals where the CLI supports a prompt hook; denied otherwise).
 * - `edit`: file edits allowed in the workspace, other actions ask/deny.
 * - `full`: no permission checks. Dangerous; explicit opt-in only.
 */
export type KernelPermission = 'read-only' | 'ask' | 'edit' | 'full'

export interface KernelLaunchContext {
  mode: KernelMode
  permission: KernelPermission
  /** Isolated per-run config directory (scoped mode). */
  home: string
  /** Gateway base URL, e.g. http://127.0.0.1:43123 (scoped mode). */
  gatewayUrl: string
  /** Run-scoped bearer token (scoped mode), valid until the run ends. Only ever placed in the child's env or a 0600 file inside `home`. */
  token: string
  /** Model id the CLI should ask for (echo only; the gateway routes by token). */
  model: string
  /** Native CLI session id to resume (main-session mode), when the CLI supports it. */
  resumeSessionId?: string
  /** True when the gateway's MCP approval endpoint is available for this run. */
  approvalBridge: boolean
  /**
   * Absolute paths the CLI should be told not to read (DSH home, the plugin
   * data directory). Enforced only by CLIs with path rules (Claude Code);
   * this is defence in depth, not an OS sandbox.
   */
  protectedPaths?: readonly string[]
}

export interface KernelLaunch {
  args: string[]
  env: Record<string, string>
  /** Prompt delivery: via stdin (default) or a file whose path replaces `{promptFile}` in args. */
  promptVia: 'stdin' | 'file' | 'arg'
  /** Files to write before launch, relative to `home` (mode 0600). */
  files?: Record<string, string>
}

/** Normalized events parsed from a CLI's JSON output. */
export type KernelEvent =
  | { type: 'text'; text: string; final?: boolean }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'session'; id: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'done'; text?: string }

export interface KernelParser {
  /** Feed one JSON line; returns zero or more events. */
  line(event: Record<string, unknown>): KernelEvent[]
}

export interface KernelDefinition {
  id: string
  name: string
  vendor: string
  npmPackage: string
  bin: string
  /** Minimum supported version (">=x.y.z"). */
  minVersion: string
  /** Wire protocols the CLI uses against the gateway. */
  protocols: GatewayProtocol[]
  /** Avatar file name in `client/assets/avatars/`. */
  avatar: string
  /** Brand tint used by the UI. */
  color: string
  /** Hint shown when global mode needs a native login. */
  loginHint: string
  /** Whether the CLI can resume a native session across turns (main-session mode). */
  supportsResume: boolean
  /** Whether permission prompts can be bridged to DSH approvals. */
  supportsApprovalBridge: boolean
  /** Permission levels the CLI can enforce. Default: all four. Lower levels are used instead of missing ones. */
  permissions?: readonly KernelPermission[]
  launch(ctx: KernelLaunchContext): KernelLaunch
  parser(): KernelParser
  /** Environment variables that indicate an existing native login (global mode detection). */
  loginEnv: string[]
  /** Files under the user's home that indicate an existing native login. */
  loginFiles: string[][]
}
