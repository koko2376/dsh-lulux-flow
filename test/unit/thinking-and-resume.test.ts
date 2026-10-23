import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { DshLlmUpstream, fromDshChunks, ReplayCache, toGenerateOptions } from '../../src/dsh/llm-upstream.js'
import { AnthropicStreamEncoder, anthropicToCanonical } from '../../src/gateway/anthropic.js'
import type { CanonicalEvent, CanonicalRequest } from '../../src/gateway/canonical.js'
import { chatToCanonical } from '../../src/gateway/openai-chat.js'
import { findKernel } from '../../src/kernels/catalog.js'
import { SessionStateStore } from '../../src/kernels/session-state.js'
import { fromArray, parseSse, TARGET, tempDir } from '../helpers.js'

async function events(chunks: unknown[], onResponse?: Parameters<typeof fromDshChunks>[1]): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const e of fromDshChunks(fromArray(chunks as StreamChunk[]), onResponse)) out.push(e)
  return out
}

/** A DeepSeek-style thinking reply as DSH's runtime streams it, with adapter replay metadata. */
const thinkingReply = (reasoning: string, text: string): unknown[] => [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: reasoning },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text },
  { type: 'block-end', index: 1, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 900 } },
  { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: 'native', model: TARGET.model }, blocks: [{ type: 'reasoning', signature: 'sig-1' }, { type: 'text' }] } },
]

describe('Claude Code history on the way upstream', () => {
  it('keeps assistant thinking as reasoning and mid-conversation system entries as context', () => {
    // shape captured from Claude Code 2.1.309 on a resumed turn
    const request = anthropicToCanonical({
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '<system-reminder>attribution</system-reminder>\n' }, { type: 'text', text: '你好' }] },
        { role: 'system', content: [{ type: 'text', text: "Today's date is 2026-10-23." }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'The user greets.', signature: '' }, { type: 'text', text: '你好！' }] },
        { role: 'user', content: [{ type: 'text', text: '你是什么内核' }] },
      ],
    })
    expect(request.turns).toEqual([
      { role: 'user', text: '<system-reminder>attribution</system-reminder>\n\n你好' },
      { role: 'user', text: "<system-reminder>\nToday's date is 2026-10-23.\n</system-reminder>" },
      { role: 'assistant', text: '你好！', reasoning: 'The user greets.' },
      { role: 'user', text: '你是什么内核' },
    ])
  })

  it('keeps reasoning_content from OpenAI-style history', () => {
    const request = chatToCanonical({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', reasoning_content: 'r' }, { role: 'user', content: 'q2' }] })
    expect(request.turns[1]).toEqual({ role: 'assistant', text: 'a', reasoning: 'r' })
  })

  it('sends earlier reasoning to DSH ahead of the text and tool calls', () => {
    const request: CanonicalRequest = {
      model: '',
      system: '',
      stream: true,
      tools: [],
      turns: [
        { role: 'user', text: 'read a' },
        { role: 'assistant', text: '', reasoning: 'need the file', toolCalls: [{ id: 'c1', name: 'Read', arguments: '{"p":"a"}' }] },
        { role: 'tool', toolCallId: 'c1', text: 'data' },
      ],
    }
    const options = toGenerateOptions(request, TARGET, new AbortController().signal)
    expect((options.messages[1] as { content: unknown[] }).content).toEqual([
      { type: 'reasoning', text: 'need the file' },
      { type: 'tool-call', id: 'c1', name: 'Read', arguments: '{"p":"a"}' },
    ])
  })
})

describe('replay of DSH responses', () => {
  it('replays a response exactly as DSH produced it, with its replay state, when the client sends it back', async () => {
    const cache = new ReplayCache()
    await events(thinkingReply('Think  about\nit.', 'Hello there'), (blocks, replayState) => cache.remember({ ...TARGET, blocks, replayState }))
    expect(cache.size).toBe(1)
    // Claude Code re-joins and re-spaces blocks; the match ignores whitespace
    const turn = { role: 'assistant' as const, text: 'Hello there', reasoning: 'Think about it.' }
    const options = toGenerateOptions({ model: '', system: '', stream: true, tools: [], turns: [{ role: 'user', text: 'hi' }, turn, { role: 'user', text: 'and?' }] }, TARGET, new AbortController().signal, cache)
    const message = options.messages[1] as { content: unknown[]; source: Record<string, unknown> }
    expect(message.content).toEqual([
      { type: 'reasoning', text: 'Think  about\nit.' },
      { type: 'text', text: 'Hello there' },
    ])
    expect(message.source).toMatchObject({ kind: 'model', ...TARGET, replayState: { blocks: [{ type: 'reasoning', signature: 'sig-1' }, { type: 'text' }] } })
    // another model does not get this model's replay state
    expect(cache.find(turn, { provider: TARGET.provider, model: 'other' })).toBeUndefined()
    // an edited turn is not matched
    expect(cache.find({ ...turn, text: 'Hello you' }, TARGET)).toBeUndefined()
  })

  it('records nothing for failed responses or blocks that never ended', async () => {
    const seen: unknown[] = []
    await events([{ type: 'reasoning-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }], blocks => seen.push(blocks))
    await events([...thinkingReply('a', 'b').slice(0, -1), { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E' } } }], blocks => seen.push(blocks))
    expect(seen).toEqual([])
  })

  it('DshLlmUpstream remembers what it streamed and replays it on the next request', async () => {
    const requests: unknown[] = []
    const llm = {
      async *stream(options: unknown) {
        requests.push(options)
        for (const chunk of thinkingReply('plan', 'answer')) yield chunk as StreamChunk
      },
    }
    const upstream = new DshLlmUpstream(() => llm)
    const drain = async (request: CanonicalRequest) => {
      for await (const _ of upstream.stream(request, TARGET, new AbortController().signal)) void _
    }
    await drain({ model: '', system: '', stream: true, tools: [], turns: [{ role: 'user', text: 'q' }] })
    await drain({ model: '', system: '', stream: true, tools: [], turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'answer', reasoning: 'plan' }, { role: 'user', text: 'q2' }] })
    const replayed = (requests[1] as { messages: Array<{ source?: { replayState?: unknown } }> }).messages[1]!
    expect(replayed.source?.replayState).toBeDefined()
  })

  it('emits block text an adapter delivered only in block-end', async () => {
    const out = await events([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'whole' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(out.filter(e => e.type === 'text' || e.type === 'reasoning')).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'reasoning', text: 'whole' },
    ])
  })
})

describe('Anthropic stream for Claude Code', () => {
  it('opens thinking blocks with a signature field and reports cache usage', () => {
    const enc = new AnthropicStreamEncoder('m', 10)
    let out = enc.start()
    for (const e of [
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'hi' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 900, cacheWriteTokens: 50 } },
      { type: 'finish', reason: 'stop' },
    ] as CanonicalEvent[])
      out += enc.push(e)
    const frames = parseSse(out).map(f => f.data as Record<string, unknown>)
    expect(frames[0]).toMatchObject({ type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } })
    expect(frames.find(f => f.type === 'content_block_start')).toMatchObject({ content_block: { type: 'thinking', thinking: '', signature: '' } })
    expect(frames.find(f => f.type === 'message_delta')).toMatchObject({
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
    })
  })
})

describe('native session state between runs', () => {
  const claude = findKernel('claude-code')!

  it('saves the transcript directories and restores them into a fresh home', () => {
    const store = new SessionStateStore(tempDir())
    const home = tempDir()
    mkdirSync(join(home, 'projects', '-work'), { recursive: true })
    writeFileSync(join(home, 'projects', '-work', 'abc-1.jsonl'), '{"turn":1}\n')
    writeFileSync(join(home, 'lulux-flow-mcp.json'), '{"token":"secret"}')
    expect(store.save(claude, 'abc-1', home)).toBe(true)
    const next = tempDir()
    expect(store.restore(claude, 'abc-1', next)).toBe(true)
    expect(readFileSync(join(next, 'projects', '-work', 'abc-1.jsonl'), 'utf8')).toBe('{"turn":1}\n')
    expect(existsSync(join(next, 'lulux-flow-mcp.json'))).toBe(false) // only session dirs are kept
    expect(store.restore(claude, 'unknown', tempDir())).toBe(false)
  })

  it('refuses ids that are not plain native session ids', () => {
    const store = new SessionStateStore(tempDir())
    const home = tempDir()
    mkdirSync(join(home, 'projects'))
    for (const id of ['../escape', 'a/b', '', '..']) {
      expect(store.save(claude, id, home)).toBe(false)
      expect(store.restore(claude, id, home)).toBe(false)
    }
  })

  it('prunes old snapshots and keeps at most the configured number', () => {
    const root = tempDir()
    const store = new SessionStateStore(root, { maxPerKernel: 2, maxAgeMs: 60_000 })
    const home = tempDir()
    mkdirSync(join(home, 'projects'))
    store.save(claude, 'old', home)
    const old = new Date(Date.now() - 120_000)
    utimesSync(join(root, 'claude-code', 'old'), old, old)
    store.save(claude, 's1', home)
    store.save(claude, 's2', home)
    store.save(claude, 's3', home)
    expect(['old', 's1', 's2', 's3'].filter(id => existsSync(join(root, 'claude-code', id)))).toHaveLength(2)
    expect(existsSync(join(root, 'claude-code', 'old'))).toBe(false)
  })

  it('kernels without session directories keep nothing', () => {
    const store = new SessionStateStore(tempDir())
    expect(store.save(findKernel('gemini-cli')!, 'x', tempDir())).toBe(false)
  })
})
