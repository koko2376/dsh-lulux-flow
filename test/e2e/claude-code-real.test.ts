/**
 * End-to-end with the real Claude Code CLI (opt-in, skipped in CI):
 *
 *   npm i --prefix /tmp/cc @anthropic-ai/claude-code
 *   LULUX_E2E_CLAUDE_BIN=/tmp/cc/node_modules/.bin/claude pnpm vitest run test/e2e
 *
 * The CLI runs in scoped mode against the gateway; DSH's model runtime is a
 * fake that streams like a thinking-mode DeepSeek model (reasoning before
 * text, cache usage, adapter replay state).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DshLlmUpstream } from '../../src/dsh/llm-upstream.js'
import { KernelGateway } from '../../src/gateway/server.js'
import { TokenStore } from '../../src/gateway/tokens.js'
import { findKernel } from '../../src/kernels/catalog.js'
import { KernelRunner } from '../../src/kernels/runner.js'
import { SessionStateStore } from '../../src/kernels/session-state.js'
import { tempDir } from '../helpers.js'

const BIN = process.env.LULUX_E2E_CLAUDE_BIN
const TARGET = { provider: 'deepseek', model: 'deepseek-v4.1-flash' }

type Part = { kind: 'reasoning' | 'text'; text: string } | { kind: 'tool'; id: string; name: string; args: string }

function reply(n: number, parts: Part[]): StreamChunk[] {
  const out: unknown[] = []
  const meta: unknown[] = []
  parts.forEach((part, index) => {
    if (part.kind === 'tool') {
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
      out.push({ type: 'tool-call-delta', index, id: part.id, name: part.name, argumentsDelta: part.args })
      out.push({ type: 'block-end', index, block: { type: 'tool-call', id: part.id, name: part.name, arguments: part.args } })
      meta.push({ type: 'tool-call' })
    } else {
      out.push({ type: 'block-start', index, blockType: part.kind })
      out.push({ type: `${part.kind}-delta`, index, text: part.text })
      out.push({ type: 'block-end', index, block: { type: part.kind, text: part.text } })
      meta.push(part.kind === 'reasoning' ? { type: 'reasoning', signature: `sig-${n}-${index}` } : { type: 'text' })
    }
  })
  out.push({ type: 'usage', usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 1000, reasoningTokens: 10 } })
  const tool = parts.some(part => part.kind === 'tool')
  out.push({ type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' }, replayState: { response: { kind: 'native', version: 1, model: TARGET.model }, blocks: meta } })
  return out as StreamChunk[]
}

describe.skipIf(!BIN)('real Claude Code CLI through the scoped gateway', () => {
  let script: (n: number, options: GenerateOptions) => StreamChunk[] = () => []
  const calls: GenerateOptions[] = []
  const llm = {
    async *stream(options: GenerateOptions) {
      calls.push(options)
      for (const chunk of script(calls.length, options)) yield chunk
    },
  }
  const tokens = new TokenStore()
  const gateway = new KernelGateway({ upstream: new DshLlmUpstream(() => llm), tokens, logger: { info: () => undefined, warn: () => undefined }, maxBodyBytes: 8 << 20, requestTimeoutMs: 60_000 })
  const runner = new KernelRunner({
    tokens,
    gatewayUrl: () => gateway.baseUrl,
    runsRoot: tempDir('lulux-e2e-runs-'),
    installRoot: tempDir(),
    binaryOverride: () => BIN,
    approvalBridge: false,
    sessionState: new SessionStateStore(tempDir('lulux-e2e-sessions-')),
  })
  const kernel = findKernel('claude-code')!
  const cwd = tempDir('lulux-e2e-cwd-')
  writeFileSync(join(cwd, 'a.txt'), 'hello from file\n')
  const run = (prompt: string, resume?: string) =>
    runner.run({ kernel, prompt, cwd, mode: 'scoped', permission: 'edit', target: TARGET, runId: `e2e-${Date.now()}`, timeoutMs: 90_000, ...(resume !== undefined ? { resumeSessionId: resume } : {}) })
  beforeAll(() => gateway.start())
  afterAll(() => gateway.stop())

  it('answers, then resumes the same native session with reasoning and replay state intact', async () => {
    script = n =>
      n === 1
        ? reply(n, [{ kind: 'reasoning', text: 'Read a.txt first.' }, { kind: 'tool', id: 'call_00_e2e', name: 'Read', args: JSON.stringify({ file_path: join(cwd, 'a.txt') }) }])
        : reply(n, [{ kind: 'reasoning', text: `Answer ${n}.` }, { kind: 'text', text: `你好！(${n})` }])
    const first = await run('你好')
    expect(first).toMatchObject({ status: 'completed', text: '你好！(2)' })
    expect(first.usage.cacheReadTokens).toBe(2000)
    const second = await run('你是什么内核', first.nativeSessionId)
    expect(second).toMatchObject({ status: 'completed', text: '你好！(3)', nativeSessionId: first.nativeSessionId })
    const history = calls.at(-1)!.messages as Array<{ role: string; content: Array<{ type: string }>; source?: { replayState?: unknown } }>
    const assistants = history.filter(m => m.role === 'assistant')
    expect(assistants.map(m => m.content.map(b => b.type))).toEqual([['reasoning', 'tool-call'], ['reasoning', 'text']])
    expect(assistants.every(m => m.source?.replayState !== undefined)).toBe(true)
  }, 120_000)

  it('names a reasoning-only reply instead of failing silently', async () => {
    script = n => reply(n, [{ kind: 'reasoning', text: 'Just thinking.' }])
    const result = await run('你好')
    expect(result.status).toBe('error')
    expect(result.diagnostic).toContain(`${TARGET.model} returned only its reasoning and no reply text`)
  }, 120_000)
})
