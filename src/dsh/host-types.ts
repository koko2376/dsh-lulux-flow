/**
 * Minimal structural views of the DSH services LULUX Flow uses. Keeping them
 * structural (instead of importing every service type) lets the core stay
 * testable without a running DSH host; the real services satisfy them.
 */

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface HostSessionEvent {
  type: string
  seq?: number
  data?: unknown
}

export interface HostSession {
  readonly seq: number
  readonly header?: { cwd?: string }
  eventAt(seq: number): HostSessionEvent | undefined
}

export interface HostAgent {
  readonly status: string
  readonly session: HostSession
  followup(message: unknown): unknown
  whenIdle(): Promise<void>
  cancel?(): unknown
}

export interface HostAgentHandle {
  agent: HostAgent
  dispose(): Promise<void>
}

export interface HostAgents {
  create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: { provider: string; model: string }
    /** Must not return a non-commit value: DSH treats a returned object as an AgentSetupCommit. */
    setup?: (agentCtx: unknown) => void | { commit(): void }
  }): Promise<HostAgentHandle>
  get(sessionId: string): HostAgent | undefined
}

export interface HostApproval {
  request(req: { agent: HostAgent; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

export interface HostLogger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  debug(format: string, ...args: unknown[]): void
}
