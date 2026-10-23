/**
 * ds-bot member turns end to end inside the plugin: kernel chat route →
 * KernelService (concurrency caps) → KernelRunner → fake Claude Code CLI →
 * scoped gateway → fake upstream. Message shapes follow ds-bot 0.2.x
 * (src/host/delivery.js, prompt.js, time-context.js).
 */
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChatSessionMap, kernelChatStream, type KernelChatDeps } from '../../src/dsh/kernel-chat.js'
import { LuluxFlowKernelAdapter } from '../../src/dsh/providers.js'
import { KernelGateway } from '../../src/gateway/server.js'
import { TokenStore } from '../../src/gateway/tokens.js'
import { findKernel } from '../../src/kernels/catalog.js'
import type { KernelInstaller } from '../../src/kernels/installer.js'
import { KernelRunner } from '../../src/kernels/runner.js'
import { KernelService } from '../../src/kernels/service.js'
import { SessionStateStore } from '../../src/kernels/session-state.js'
import type { KernelDefinition } from '../../src/kernels/types.js'
import { SettingsStore } from '../../src/settings.js'
import { FakeUpstream, TARGET, tempDir, textReply } from '../helpers.js'

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs')

let seq = 0
const msg = (role: string, text: string, source: Record<string, unknown>) => ({ id: `m${++seq}`, role, content: [{ type: 'text', text }], source })
const IDENTITY = "# Your identity\nYou are Coder, a Bot on the user's team in DS Bot. Your role: Dev.\n\n## How your Bot team works\n- Reply in the user's language."
const SYSTEM = msg('system', `# DeepSeek Harness\n\nYou are DSH.\n\n${IDENTITY}\n\n# Environment\n\ncwd: /x`, { kind: 'system-prompt' })
const room = (text: string) => msg('user', `[Group chat "Team" · new message]\n${text}`, { kind: 'bot', form: 'relay', role: 'room', exchangeId: `ex-${seq}`, senderName: 'You', roomId: 'room-1' })
const clock = () => msg('user', 'Current time: 2026-10-23 10:00:00', { kind: 'ds-bot-time-context', form: 'snapshot', sections: [{ name: 'ds-bot-time-context', text: 'Current time' }] })
const reply = (text: string) => msg('assistant', text, { kind: 'model' })

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}
const textOf = (chunks: StreamChunk[], type: 'text-delta' | 'reasoning-delta' = 'text-delta') => chunks.filter(c => c.type === type).map(c => (c as { text: string }).text).join('')

describe('ds-bot member turns through a fake Claude Code CLI', () => {
  const root = tempDir('lulux-flow-dsbot-')
  const upstream = new FakeUpstream(request => textReply(`echo:${request.turns.at(-1)?.text.slice(-40) ?? ''}`))
  const tokens = new TokenStore()
  const gateway = new KernelGateway({ upstream, tokens, logger: { info: () => undefined, warn: () => undefined }, maxBodyBytes: 1 << 20, requestTimeoutMs: 10_000 })
  const runner = new KernelRunner({
    tokens,
    gatewayUrl: () => gateway.baseUrl,
    runsRoot: join(root, 'tmp'),
    installRoot: join(root, 'kernels'),
    approvalBridge: false,
    resolve: () => ({ command: process.execPath, prefixArgs: [FAKE], source: 'settings', file: FAKE }),
    graceMs: 200,
    sessionState: new SessionStateStore(join(root, 'kernel-sessions')),
  })
  const settings = new SettingsStore(root, () => false)
  const limits = { global: 4, perKernel: 1 }
  const kernels = new KernelService(runner, {} as KernelInstaller, settings, { provider: id => id, chatRoute: id => id }, () => limits)
  const sessions = new ChatSessionMap(root)
  let auxiliaryCalls = 0
  const deps: KernelChatDeps = {
    kernels,
    sessions,
    target: () => TARGET,
    cwdFor: () => root,
    timeoutMs: 15_000,
    auxiliary: () => {
      auxiliaryCalls += 1
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      })()
    },
  }
  const claude = findKernel('claude-code')!
  const adapter = new LuluxFlowKernelAdapter(() => claude, deps)
  const turn = (sessionId: string, messages: unknown[], signal?: AbortSignal) =>
    drain(adapter.stream({ provider: 'lulux-flow-claude-code', model: 'default', sessionId, messages, ...(signal ? { signal } : {}) } as unknown as GenerateOptions))

  beforeAll(async () => {
    settings.update({ kernels: { 'claude-code': { permission: 'read-only' } } })
    await gateway.start()
  })
  afterAll(() => gateway.stop())

  it('answers a group relay turn, sends the identity as system text, and resumes natively on the next turn', async () => {
    upstream.requests.length = 0
    const first = [SYSTEM, clock(), room('You: hello team, @Coder what is 2+2?')]
    const chunks = await turn('grp-1', first)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(textOf(chunks)).toContain('echo:')
    const firstRequest = upstream.requests.at(-1)!.request
    expect(firstRequest.system).toContain('You are Coder')
    expect(firstRequest.system).toContain('## Running as Claude Code')
    expect(firstRequest.system).not.toContain('DeepSeek Harness')
    expect(firstRequest.turns.at(-1)!.text).toContain('@Coder what is 2+2?')
    expect(firstRequest.turns.at(-1)!.text).not.toContain('Current time')
    expect(sessions.get('grp-1', claude.id)).toMatchObject({ deliveredTurns: 1, nativeSessionId: 'native-session-1' })

    const second = [...first, reply(textOf(chunks)), clock(), room('Ada: [PASS]\nYou: thanks')]
    const again = await turn('grp-1', second)
    expect(again.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const secondRequest = upstream.requests.at(-1)!.request
    // Native resume: the transcript holds the first exchange; only the new message is sent.
    expect(secondRequest.turns.at(-1)!.text).toBe('[Group chat "Team" · new message]\nAda: [PASS]\nYou: thanks')
    expect(secondRequest.turns.length).toBeGreaterThanOrEqual(3)
    expect(secondRequest.system).toContain('You are Coder')
    expect(sessions.get('grp-1', claude.id)?.deliveredTurns).toBe(2)
  })

  it('routes a memory one-shot (system + request inputs) to the auxiliary model without spawning the CLI', async () => {
    upstream.requests.length = 0
    const before = sessions.get('grp-1', claude.id)
    const chunks = await drain(
      adapter.stream({ provider: 'lulux-flow-claude-code', model: 'default', sessionId: 'grp-1', system: 'Summarize the memory.', messages: [{ role: 'user', content: [{ type: 'text', text: 'entries' }] }] } as unknown as GenerateOptions),
    )
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(auxiliaryCalls).toBe(1)
    expect(upstream.requests).toHaveLength(0)
    expect(sessions.get('grp-1', claude.id)).toEqual(before)
  })

  it('queues a second member past the per-CLI cap, shows one queued line, and runs it after the first', async () => {
    const started = Date.now()
    const [a, b] = await Promise.all([turn('mem-a', [SYSTEM, room('You: PAUSE400 first')]), turn('mem-b', [SYSTEM, room('You: second')])])
    expect(a.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(b.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(textOf(a, 'reasoning-delta')).not.toContain('Queued')
    const queued = textOf(b, 'reasoning-delta').split('\n').filter(line => line.includes('Queued'))
    expect(queued).toEqual(['⏳ Queued (#1): 1 Claude Code runs already active, limit 1. Claude Code starts when one finishes.'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    expect(kernels.limiter.stats()).toEqual({ active: 0, queued: 0, byKernel: {} })
  })

  it('stops a queued member without ever starting its CLI', async () => {
    upstream.requests.length = 0
    const controller = new AbortController()
    const running = turn('mem-c', [SYSTEM, room('You: PAUSE500 busy')])
    await new Promise(r => setTimeout(r, 50))
    const waiting = turn('mem-d', [SYSTEM, room('You: never runs')], controller.signal)
    await new Promise(r => setTimeout(r, 50))
    expect(kernels.limiter.stats().queued).toBe(1)
    controller.abort()
    const stopped = await waiting
    expect(stopped.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(kernels.limiter.stats().queued).toBe(0)
    await running
    expect(upstream.requests.map(r => r.request.turns.at(-1)?.text ?? '').some(text => text.includes('never runs'))).toBe(false)
    expect(sessions.get('mem-d', claude.id)).toBeUndefined()
  })

  it('stops a running member (abort reaches the CLI)', async () => {
    const controller = new AbortController()
    const running = turn('mem-e', [SYSTEM, room('You: PAUSE5000 long task')], controller.signal)
    await new Promise(r => setTimeout(r, 300))
    controller.abort()
    const chunks = await running
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  })

  it('puts the identity on top of a new session prompt for a CLI without a system prompt option', async () => {
    upstream.requests.length = 0
    const plain: KernelDefinition = { ...claude, id: 'plain-cli', name: 'Plain CLI', supportsResume: false, systemPromptVia: 'prompt' }
    // An unregistered kernel has no settings of its own: borrow Claude Code's.
    const plainDeps = { ...deps, kernels: Object.assign(Object.create(kernels) as KernelService, { settingsOf: () => kernels.settingsOf('claude-code') }) }
    const chunks = await drain(kernelChatStream(plain, { provider: 'x', model: 'default', sessionId: 'plain-1', messages: [SYSTEM, room('You: hi')] } as unknown as GenerateOptions, plainDeps))
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    const request = upstream.requests.at(-1)!.request
    expect(request.system ?? '').toBe('')
    expect(request.turns.at(-1)!.text).toMatch(/^Instructions for this conversation[\s\S]*You are Coder[\s\S]*## Running as Plain CLI[\s\S]*---\n\n\[Group chat "Team" · new message\]\nYou: hi$/)
  })
})
