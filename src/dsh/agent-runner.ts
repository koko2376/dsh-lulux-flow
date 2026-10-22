/**
 * Runs a DSH agent node: a real in-process DSH agent created through
 * `ctx.agents`, driven like DSH's own headless runner (followup → idle →
 * read the durable session log).
 */
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentRunner, AgentRunRequest, AgentRunResult } from '../workflow/executors.js'
import type { HostAgent, HostAgents, ModelSelection } from './host-types.js'

interface Deps {
  agents: () => HostAgents | undefined
  defaultModel: () => ModelSelection | undefined
  installModelSelection: (agentCtx: unknown, selection: { current: ModelSelection; assembled: undefined }) => void
  defaultCwd: () => string
  waitForChildren?: (agent: HostAgent) => Promise<boolean>
}

function summarize(agent: HostAgent, firstSeq: number): { text: string; reason: string; usage: { inputTokens: number; outputTokens: number } } {
  let text = ''
  let reason = 'unknown'
  const usage = { inputTokens: 0, outputTokens: 0 }
  let started = false
  for (let seq = firstSeq; seq < agent.session.seq; seq += 1) {
    const event = agent.session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/start') started = true
    if (!started) continue
    const data = (event.data ?? {}) as Record<string, unknown>
    if (event.type === 'assistant/message') {
      const message = (data.message ?? {}) as { content?: Array<{ type: string; text?: string }> }
      const joined = (message.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      if (joined) text = joined
      const u = (data.usage ?? (data.message as Record<string, unknown> | undefined)?.usage) as { inputTokens?: number; outputTokens?: number } | undefined
      if (u !== undefined) {
        usage.inputTokens += u.inputTokens ?? 0
        usage.outputTokens += u.outputTokens ?? 0
      }
    }
    if (event.type === 'turn/end') {
      const r = data.reason as { kind?: string; error?: { message?: string } } | undefined
      reason = r?.kind ?? 'unknown'
      if (r?.kind === 'error' && r.error?.message) text = text || r.error.message
    }
  }
  return { text, reason, usage }
}

export class DshAgentRunner implements AgentRunner {
  constructor(private readonly deps: Deps) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const agents = this.deps.agents()
    if (agents === undefined) throw new Error('ctx.agents is not available')
    const fallback = this.deps.defaultModel()
    let selection: ModelSelection | undefined = fallback
    if (request.model !== undefined) {
      const index = request.model.indexOf('/')
      if (index <= 0) throw new Error('agent model must be provider/model')
      selection = { provider: request.model.slice(0, index), model: request.model.slice(index + 1) }
    }
    if (selection === undefined) throw new Error('no default DSH model is configured')
    const sessionId = `lulux-flow-${randomUUID()}`
    const current = selection
    const handle = await agents.create({
      sessionId,
      meta: { cwd: request.cwd ?? this.deps.defaultCwd(), ...(request.preset !== undefined ? { agentPreset: request.preset } : {}) },
      agentOptions: { provider: current.provider, model: current.model },
      // setup must return void (or an AgentSetupCommit): DSH calls `.commit()` on any returned value.
      // installModelSelection's listeners live on agentCtx and are disposed with the agent.
      setup: agentCtx => {
        this.deps.installModelSelection(agentCtx, { current, assembled: undefined })
      },
    })
    const agent = handle.agent
    const onAbort = (): void => {
      void agent.cancel?.()
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await agent.whenIdle()
      const firstSeq = agent.session.seq
      const prompt = request.system ? `${request.system}\n\n---\n\n${request.prompt}` : request.prompt
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      for (;;) {
        await agent.whenIdle()
        if (request.signal.aborted) break
        const idleSeq = agent.session.seq
        const waited = (await this.deps.waitForChildren?.(agent)) ?? false
        if (!waited && agent.status === 'idle' && agent.session.seq === idleSeq) break
      }
      if (request.signal.aborted) throw new Error('cancelled')
      const outcome = summarize(agent, firstSeq)
      return { text: outcome.text, sessionId, usage: outcome.usage, stopReason: outcome.reason }
    } finally {
      request.signal.removeEventListener('abort', onAbort)
      await handle.dispose().catch(() => undefined)
    }
  }
}
