/**
 * ds-bot interoperability (ds-bot 0.2.x drives a CLI route as a Bot's model).
 * Message shapes below are the ones ds-bot builds in src/host/delivery.js,
 * groups.js, parts.js and time-context.js; none of its code is used here.
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildTurnPrompt, ChatSessionMap, conversationTurns, identityPrompt, isConversationMessage, kernelChatStream, MAX_IDENTITY_CHARS, type KernelChatDeps } from '../../src/dsh/kernel-chat.js'
import { isOneShotRequest, isSnapshotQuestion, LuluxFlowKernelAdapter } from '../../src/dsh/providers.js'
import { findKernel } from '../../src/kernels/catalog.js'
import { KernelLimiter, queuedLine, type KernelQueueStatus } from '../../src/kernels/limiter.js'
import { systemPromptPlacement, withSystemPrompt } from '../../src/kernels/runner.js'
import type { KernelService } from '../../src/kernels/service.js'
import { defaultKernelSettings } from '../../src/settings.js'
import { tempDir, TARGET } from '../helpers.js'

let seq = 0
const user = (text: string, source?: Record<string, unknown>) => ({ id: `m${++seq}`, role: 'user', content: [{ type: 'text', text }], source: source ?? { kind: 'user' } })
const assistant = (text: string) => ({ id: `m${++seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } })
const system = (text: string) => ({ id: `m${++seq}`, role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } })

// delivery.js deliver(): kind SOURCE_KIND ('bot'), form 'relay', role + exchange fields.
const relay = (role: string, extra: Record<string, unknown> = {}) => ({ kind: 'bot', form: 'relay', role, exchangeId: 'ex-1', senderName: 'Ada', senderSessionId: 'sess-ada', ...extra })
// groups.js kickoff / post, parts.js handoff and resume.
const kickoff = { kind: 'bot', form: 'relay', role: 'kickoff', exchangeId: 'ex-k', senderName: 'You', roomId: 'room-1' }
const post = { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'ex-p', senderName: 'Ada', senderSessionId: 'sess-ada', roomId: 'room-1' }
const handoff = { kind: 'bot', form: 'relay', role: 'handoff', senderName: 'DS Bot' }
const resumed = { kind: 'bot', form: 'relay', role: 'resume', exchangeId: 'ex-r', senderName: 'DS Bot' }
// time-context.js: the clock is a snapshot.
const clock = { kind: 'ds-bot-time-context', form: 'snapshot', sections: [{ name: 'ds-bot-time-context', text: 'Current time: …' }] }

describe('conversationTurns with ds-bot deliveries', () => {
  it('keeps every relay role ds-bot delivers, scheduled tasks and typed messages', () => {
    for (const source of [
      relay('room', { roomId: 'room-1', askedBy: 'Ada' }),
      relay('request'),
      relay('reply', { replyTo: 'ex-0' }),
      relay('report', { roomId: 'room-1' }),
      relay('stopped'),
      relay('request', { audience: 'user' }),
      relay('reply', { deferred: true, work: 'w-1' }),
      relay('room', { retried: true }),
      kickoff,
      post,
      handoff,
      resumed,
      { kind: 'schedule' },
      { kind: 'schedule', form: 'notice', summary: 'Daily report' },
      { kind: 'user' },
      { kind: 'user', rpcId: 'rpc-1' },
      undefined,
    ]) {
      expect(isConversationMessage(source), JSON.stringify(source)).toBe(true)
    }
  })

  it('skips injected context: snapshots (clocks), catalogs, instructions, recalls and unknown producers', () => {
    for (const source of [
      clock,
      { kind: 'time-context', form: 'snapshot', sections: [] },
      { kind: 'runtime-context', form: 'snapshot', sections: [] },
      { kind: 'bot', form: 'snapshot', sections: [] },
      { kind: 'schedule', form: 'catalog' },
      { kind: 'skill-invocation' },
      { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' },
      { kind: 'webhook', form: 'notice', summary: 'push' },
      { kind: 'ds-bot-something-new' },
    ]) {
      expect(isConversationMessage(source), JSON.stringify(source)).toBe(false)
    }
  })

  it('accepts relay messages from producers it has never seen (graceful for future source shapes)', () => {
    expect(isConversationMessage({ kind: 'some-future-team', form: 'relay', whatever: 1 })).toBe(true)
    expect(isConversationMessage({ form: 'relay' })).toBe(true)
    expect(isConversationMessage({ kind: 42 })).toBe(false)
    expect(isConversationMessage('weird')).toBe(true)
  })

  it('turns a ds-bot group session into user/assistant turns and drops the clock', () => {
    const messages = [
      system('# Your identity\nYou are Coder.'),
      user('[Bot team setup]\nWelcome', kickoff),
      user('Current time: 2026-10-23', clock),
      assistant('Hi team'),
      user('[Group chat "Team" · new message]\nAda: @Coder fix the bug', relay('room', { roomId: 'room-1' })),
    ]
    expect(conversationTurns({ messages } as unknown as GenerateOptions)).toEqual([
      { role: 'user', text: '[Bot team setup]\nWelcome' },
      { role: 'assistant', text: 'Hi team' },
      { role: 'user', text: '[Group chat "Team" · new message]\nAda: @Coder fix the bug' },
    ])
  })

  it('counts delivered turns with the same rule, so a skipped clock does not break native resume', () => {
    const kernel = findKernel('claude-code')!
    const turns = conversationTurns({
      messages: [user('one', relay('room')), assistant('a1'), user('tick', clock), user('two', relay('room'))],
    } as unknown as GenerateOptions)
    expect(buildTurnPrompt(turns, { kernelId: kernel.id, nativeSessionId: 'n1', deliveredTurns: 1, updatedAt: '' }, kernel)).toEqual({ prompt: 'two', resume: 'n1', userTurns: 2 })
  })

  it('sends messages that queued while the CLI was busy together on resume', () => {
    const kernel = findKernel('claude-code')!
    const turns = conversationTurns({
      messages: [user('one', relay('room')), assistant('a1'), user('two', relay('request')), user('three', relay('reply', { deferred: true }))],
    } as unknown as GenerateOptions)
    expect(buildTurnPrompt(turns, { kernelId: kernel.id, nativeSessionId: 'n1', deliveredTurns: 1, updatedAt: '' }, kernel)).toEqual({ prompt: 'two\n\nthree', resume: 'n1', userTurns: 3 })
    // A reply the CLI never wrote between them: replay as context instead.
    const gap = conversationTurns({ messages: [user('one'), assistant('a1'), user('two'), assistant('a2'), user('three')] } as unknown as GenerateOptions)
    const built = buildTurnPrompt(gap, { kernelId: kernel.id, nativeSessionId: 'n1', deliveredTurns: 1, updatedAt: '' }, kernel)
    expect(built.resume).toBeUndefined()
    expect(built.prompt).toContain('Current request:\nthree')
  })
})

// The section ds-bot's prompt.js renders (abridged), between DSH's own sections.
const IDENTITY = [
  '# Your identity',
  "You are Coder, a Bot on the user's team in DS Bot. Your role: Dev.",
  '',
  'Write small, tested changes.',
  '',
  '## How your Bot team works',
  '- message_bot sends a message to another Bot.',
  "- Reply in the user's language.",
].join('\n')
const DSH_SYSTEM = ['# DeepSeek Harness', 'You are DSH. Use bash, read_file and str_replace_editor.', '', IDENTITY, '', '# Environment', 'cwd: /work'].join('\n\n')

describe('identityPrompt', () => {
  it('takes only the ds-bot identity section and adds what the CLI cannot do', () => {
    const text = identityPrompt({ messages: [system(DSH_SYSTEM), user('hi')] } as unknown as GenerateOptions, 'Claude Code')!
    expect(text.startsWith('# Your identity\nYou are Coder')).toBe(true)
    expect(text).toContain('## How your Bot team works')
    expect(text).toContain("Reply in the user's language.")
    expect(text).toContain('## Running as Claude Code')
    expect(text).toContain('@Name')
    expect(text).not.toContain('DeepSeek Harness')
    expect(text).not.toContain('# Environment')
    expect(text).not.toContain('str_replace_editor')
  })

  it('is undefined for an ordinary DSH chat (no identity section) and for a group relay prompt', () => {
    expect(identityPrompt({ messages: [system('# DeepSeek Harness\nYou are DSH.'), user('hi')] } as unknown as GenerateOptions, 'Codex')).toBeUndefined()
    expect(identityPrompt({ messages: [system('# Group chat relay\nYou are only the relay.')] } as unknown as GenerateOptions, 'Codex')).toBeUndefined()
    expect(identityPrompt({ messages: [user('hi')] } as unknown as GenerateOptions, 'Codex')).toBeUndefined()
  })

  it('is bounded', () => {
    const long = `# Your identity\nYou are Coder.\n${'- a long instruction line\n'.repeat(2000)}`
    const text = identityPrompt({ messages: [system(long)] } as unknown as GenerateOptions, 'Codex')!
    expect(text.length).toBeLessThan(MAX_IDENTITY_CHARS + 1000)
    expect(text).toContain('…')
  })
})

describe('system prompt placement per CLI', () => {
  const claude = findKernel('claude-code')!
  const codex = findKernel('codex')!
  const gemini = findKernel('gemini-cli')!
  it('Claude Code: its own option on every run, resumed or not', () => {
    expect(systemPromptPlacement(claude, 'id', false)).toBe('flag')
    expect(systemPromptPlacement(claude, 'id', true)).toBe('flag')
    const launch = claude.launch({ mode: 'scoped', permission: 'read-only', home: '/h', gatewayUrl: 'http://g', token: 't', model: 'm', approvalBridge: false, appendSystemPrompt: 'You are Coder.' })
    expect(launch.args).toContain('--append-system-prompt-file')
    expect(launch.args[launch.args.indexOf('--append-system-prompt-file') + 1]).toBe('{home}/lulux-flow-system-prompt.md')
    expect(Object.values(launch.files ?? {})).toContain('You are Coder.')
    expect(launch.args.join(' ')).not.toContain('You are Coder.')
  })
  it('Codex: developer instructions when a session starts, never on resume', () => {
    expect(systemPromptPlacement(codex, 'id', false)).toBe('flag')
    expect(systemPromptPlacement(codex, 'id', true)).toBeUndefined()
    const fresh = codex.launch({ mode: 'scoped', permission: 'read-only', home: '/h', gatewayUrl: 'http://g', token: 't', model: 'm', approvalBridge: false, appendSystemPrompt: 'Line 1\n"Line 2"' })
    expect(fresh.args).toContain('developer_instructions="Line 1\\n\\"Line 2\\""')
    const resumedLaunch = codex.launch({ mode: 'scoped', permission: 'read-only', home: '/h', gatewayUrl: 'http://g', token: 't', model: 'm', approvalBridge: false, resumeSessionId: 's1', appendSystemPrompt: 'x' })
    expect(resumedLaunch.args.join(' ')).not.toContain('developer_instructions')
  })
  it('CLIs without such an option get it on top of a new session prompt', () => {
    expect(systemPromptPlacement(gemini, 'id', false)).toBe('prompt')
    expect(systemPromptPlacement(gemini, '  ', false)).toBeUndefined()
    expect(systemPromptPlacement(gemini, undefined, false)).toBeUndefined()
    expect(withSystemPrompt('You are Coder.', 'hello')).toMatch(/You are Coder\.\n\n---\n\nhello$/)
  })
})

type RunImpl = (req: Record<string, unknown> & { onEvent?: (e: unknown) => void; onQueued?: (s: KernelQueueStatus) => void }) => Promise<unknown>
const completed = (text: string) => ({ status: 'completed', text, usage: { inputTokens: 3, outputTokens: 2, requests: 1 }, nativeSessionId: 'native-1' })

function deps(run: RunImpl, auxiliary: KernelChatDeps['auxiliary'] = () => (async function* () {})()): KernelChatDeps & { sessions: ChatSessionMap } {
  const kernels = { settingsOf: (id: string) => defaultKernelSettings(id), run } as unknown as KernelService
  return { kernels, sessions: new ChatSessionMap(tempDir()), target: () => TARGET, cwdFor: () => process.cwd(), timeoutMs: 10_000, auxiliary }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('kernelChatStream for a ds-bot member', () => {
  const kernel = findKernel('claude-code')!

  it('answers a group relay turn and passes the identity as extra system instructions', async () => {
    const seen: Array<Record<string, unknown>> = []
    const d = deps(async req => {
      seen.push(req)
      return completed('[PASS]')
    })
    const options = { provider: 'lulux-flow-claude-code', model: 'default', sessionId: 'g-1', messages: [system(DSH_SYSTEM), user('[Group chat "Team" · new message]\nYou: hello', relay('room', { roomId: 'room-1' }))] } as unknown as GenerateOptions
    const chunks = await drain(kernelChatStream(kernel, options, d))
    expect(chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join('')).toBe('[PASS]')
    expect(seen[0]!.prompt).toBe('[Group chat "Team" · new message]\nYou: hello')
    expect(String(seen[0]!.appendSystemPrompt)).toContain('You are Coder')
    expect(d.sessions.get('g-1', kernel.id)?.deliveredTurns).toBe(1)
  })

  it('shows one queued line as reasoning while waiting for a slot', async () => {
    const d = deps(async req => {
      req.onQueued?.({ position: 2, reason: 'kernel', active: 3, limit: 3 })
      return completed('ok')
    })
    const options = { provider: 'lulux-flow-claude-code', model: 'default', sessionId: 'q-1', messages: [user('go')] } as unknown as GenerateOptions
    const chunks = await drain(kernelChatStream(kernel, options, d))
    const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => (c as { text: string }).text).join('')
    expect(reasoning).toBe(`${queuedLine('Claude Code', { position: 2, reason: 'kernel', active: 3, limit: 3 })}\n`)
    expect(reasoning.trim().split('\n')).toHaveLength(1)
  })
})

describe('one-shot requests (ds-bot memory oneShot, steward, compaction, titles)', () => {
  const kernel = findKernel('claude-code')!
  it('follows the dsh-llm contract: purpose, system, or request inputs only', () => {
    // memory.js oneShot: system + identity-free inputs + the Bot's sessionId, no purpose.
    expect(isOneShotRequest({ system: 'Summarize', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] } as unknown as GenerateOptions)).toBe(true)
    expect(isOneShotRequest({ purpose: 'compaction', messages: [user('x')] } as unknown as GenerateOptions)).toBe(true)
    expect(isOneShotRequest({ purpose: 'session-title', messages: [] } as unknown as GenerateOptions)).toBe(true)
    expect(isOneShotRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] } as unknown as GenerateOptions)).toBe(true)
    // A loop-built turn: durable messages, system prompt as a leading message, no `system`.
    expect(isOneShotRequest({ messages: [system('# Your identity\nYou are Coder.'), user('hi', relay('room'))] } as unknown as GenerateOptions)).toBe(false)
    expect(isOneShotRequest({ messages: [user('hi')] } as unknown as GenerateOptions)).toBe(false)
    expect(isOneShotRequest({ messages: [] } as unknown as GenerateOptions)).toBe(false)
  })

  it('goes to the auxiliary model and never runs the CLI or touches resume state', async () => {
    let runs = 0
    const auxCalls: GenerateOptions[] = []
    const d = deps(
      async () => {
        runs += 1
        return completed('cli')
      },
      options => {
        auxCalls.push(options)
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
          yield { type: 'text-delta', index: 0, text: 'summary' } as StreamChunk
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        })()
      },
    )
    d.sessions.set('bot-1', { kernelId: kernel.id, nativeSessionId: 'n-keep', deliveredTurns: 4, updatedAt: new Date().toISOString() })
    const adapter = new LuluxFlowKernelAdapter(() => kernel, d)
    const chunks = await drain(adapter.stream({ provider: 'lulux-flow-claude-code', model: 'default', sessionId: 'bot-1', system: 'You keep memory.', messages: [{ role: 'user', content: [{ type: 'text', text: 'entries…' }] }] } as unknown as GenerateOptions))
    expect(runs).toBe(0)
    expect(auxCalls).toHaveLength(1)
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
    expect(d.sessions.get('bot-1', kernel.id)).toMatchObject({ nativeSessionId: 'n-keep', deliveredTurns: 4 })
  })

  it('still runs the CLI for a normal agent-loop turn', async () => {
    let runs = 0
    const d = deps(async () => {
      runs += 1
      return completed('cli')
    })
    const adapter = new LuluxFlowKernelAdapter(() => kernel, d)
    await drain(adapter.stream({ provider: 'lulux-flow-claude-code', model: 'default', sessionId: 's', messages: [system('# DeepSeek Harness'), user('hi')] } as unknown as GenerateOptions))
    expect(runs).toBe(1)
  })
})

// btw.js (ds-bot 0.2.1): the Bot's derived Session messages, then one request input.
const btwRequest = (sessionId: string, history: unknown[]) => ({
  provider: 'lulux-flow-claude-code',
  model: 'default',
  sessionId,
  tools: [{ name: 'message_bot', description: 'x', parameters: {} }],
  toolHistory: { tools: [], updates: [] },
  messages: [...history, { role: 'user', content: [{ type: 'text', text: 'ds-bot/btw\nAnswer briefly from the conversation so far…\n\nQuestion: what are you doing?' }] }],
}) as unknown as GenerateOptions

describe('side questions on a snapshot of the chat (ds-bot 0.2.1 /btw)', () => {
  const kernel = findKernel('claude-code')!
  const history = () => [system(DSH_SYSTEM), user('[Bot team setup]', kickoff), user('tick', clock), assistant('Hi'), user('fix the parser'), assistant('Working on it.')]

  it('is recognised by shape: durable messages, then one trailing request input', () => {
    expect(isOneShotRequest(btwRequest('bot-1', history()))).toBe(true)
    expect(isSnapshotQuestion(btwRequest('bot-1', history()).messages as never)).toBe(true)
    // Loop-built turns end with a durable message, whatever its source.
    expect(isOneShotRequest({ messages: [...history(), user('next', relay('room'))] } as unknown as GenerateOptions)).toBe(false)
    expect(isOneShotRequest({ messages: [...history(), user('typed')] } as unknown as GenerateOptions)).toBe(false)
    // A trailing input that is not a user message, or one that has a source, is not a question.
    expect(isSnapshotQuestion([...history(), { role: 'assistant', content: [] }])).toBe(false)
    expect(isSnapshotQuestion([...history(), { role: 'user', source: { kind: 'user' } }])).toBe(false)
  })

  it('goes to the auxiliary model with the snapshot, never runs the CLI, and keeps native resume for the next turn', async () => {
    let runs = 0
    const prompts: Array<Record<string, unknown>> = []
    const auxCalls: GenerateOptions[] = []
    const d = deps(
      async req => {
        runs += 1
        prompts.push(req)
        return completed('cli')
      },
      options => {
        auxCalls.push(options)
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
          yield { type: 'text-delta', index: 0, text: 'Fixing the parser.' } as StreamChunk
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        })()
      },
    )
    const binding = { kernelId: kernel.id, nativeSessionId: 'n-keep', deliveredTurns: 2, updatedAt: new Date().toISOString() }
    d.sessions.set('bot-1', binding)
    const adapter = new LuluxFlowKernelAdapter(() => kernel, d)
    const request = btwRequest('bot-1', history())
    const chunks = await drain(adapter.stream(request))
    expect(runs).toBe(0)
    expect(auxCalls).toHaveLength(1)
    expect(auxCalls[0]!.messages).toBe(request.messages)
    expect(auxCalls[0]!.tools).toBe(request.tools)
    expect(chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join('')).toBe('Fixing the parser.')
    expect(d.sessions.get('bot-1', kernel.id)).toMatchObject({ nativeSessionId: 'n-keep', deliveredTurns: 2 })

    // The next real message resumes the same native session with only the new text.
    await drain(adapter.stream({ provider: 'lulux-flow-claude-code', model: 'default', sessionId: 'bot-1', messages: [...history(), user('and add a test')] } as unknown as GenerateOptions))
    expect(runs).toBe(1)
    expect(prompts[0]!.prompt).toBe('and add a test')
    expect(prompts[0]!.resumeSessionId).toBe('n-keep')
  })
})

describe('model info for ds-bot', () => {
  it('declares text-only input so images are read into text before they reach the CLI', async () => {
    const kernel = findKernel('claude-code')!
    const adapter = new LuluxFlowKernelAdapter(() => kernel, deps(async () => completed('')))
    const [model] = await adapter.listModels('lulux-flow-claude-code')
    expect(model!.inputModalities).toEqual(['text'])
    expect((await adapter.resolveModel('lulux-flow-claude-code', 'default')).inputModalities).toEqual(['text'])
  })
})

describe('KernelLimiter', () => {
  const gate = () => {
    let open!: () => void
    const promise = new Promise<void>(resolve => (open = resolve))
    return { promise, open }
  }

  it('caps runs per CLI and globally, FIFO, and reports the wait once', async () => {
    const limiter = new KernelLimiter(() => ({ global: 3, perKernel: 2 }))
    const order: string[] = []
    const gates = new Map<string, ReturnType<typeof gate>>()
    const queued: Array<[string, KernelQueueStatus]> = []
    const start = (name: string, kernel: string) => {
      const g = gate()
      gates.set(name, g)
      return limiter.run(
        kernel,
        async () => {
          order.push(name)
          await g.promise
          return name
        },
        { onQueued: status => queued.push([name, status]) },
      )
    }
    const runs = [start('c1', 'claude'), start('c2', 'claude'), start('c3', 'claude'), start('x1', 'codex'), start('x2', 'codex')]
    await Promise.resolve()
    expect(order).toEqual(['c1', 'c2', 'x1'])
    expect(queued).toEqual([
      ['c3', { position: 1, reason: 'kernel', active: 2, limit: 2 }],
      ['x2', { position: 2, reason: 'global', active: 3, limit: 3 }],
    ])
    gates.get('c1')!.open()
    await new Promise(r => setTimeout(r, 0))
    expect(order).toEqual(['c1', 'c2', 'x1', 'c3'])
    gates.get('x1')!.open()
    await new Promise(r => setTimeout(r, 0))
    expect(order).toEqual(['c1', 'c2', 'x1', 'c3', 'x2'])
    for (const g of gates.values()) g.open()
    expect(await Promise.all(runs)).toEqual(['c1', 'c2', 'c3', 'x1', 'x2'])
    expect(limiter.stats()).toEqual({ active: 0, queued: 0, byKernel: {} })
  })

  it('leaves the queue when aborted while waiting and never starts the task', async () => {
    const limiter = new KernelLimiter(() => ({ global: 1, perKernel: 1 }))
    const first = gate()
    const running = limiter.run('claude', () => first.promise)
    const controller = new AbortController()
    let started = false
    const waiting = limiter.run('claude', async () => void (started = true), { signal: controller.signal })
    expect(limiter.stats().queued).toBe(1)
    controller.abort()
    await expect(waiting).rejects.toThrow('aborted while queued')
    expect(limiter.stats().queued).toBe(0)
    first.open()
    await running
    expect(started).toBe(false)
    expect(limiter.stats().active).toBe(0)
  })

  it('rejects at once when already aborted, and frees the slot when a task throws', async () => {
    const limiter = new KernelLimiter(() => ({ global: 1, perKernel: 1 }))
    await expect(limiter.run('k', async () => 1, { signal: AbortSignal.abort() })).rejects.toThrow('aborted while queued')
    await expect(limiter.run('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await limiter.run('k', async () => 2)).toBe(2)
  })
})
