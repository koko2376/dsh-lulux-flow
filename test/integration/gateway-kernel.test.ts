import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KernelGateway } from '../../src/gateway/server.js'
import { TokenStore } from '../../src/gateway/tokens.js'
import { findKernel } from '../../src/kernels/catalog.js'
import { KernelRunner } from '../../src/kernels/runner.js'
import { FakeUpstream, TARGET, tempDir, textReply, parseSse } from '../helpers.js'

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs')

describe('gateway HTTP surface', () => {
  const upstream = new FakeUpstream()
  const tokens = new TokenStore()
  const approvals = { decisions: [] as string[], allow: true }
  const gateway = new KernelGateway({
    upstream,
    tokens,
    logger: { info: () => undefined, warn: () => undefined },
    maxBodyBytes: 64 * 1024,
    requestTimeoutMs: 5_000,
    approvals: {
      request: async (_record, ask) => {
        approvals.decisions.push(ask.toolName)
        return approvals.allow ? { allow: true } : { allow: false, message: 'nope' }
      },
    },
  })
  beforeAll(() => gateway.start())
  afterAll(() => gateway.stop())

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${gateway.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  it('binds to loopback on a random port', () => {
    expect(gateway.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('rejects missing, unknown and wrong-protocol tokens', async () => {
    expect((await post('/anthropic/v1/messages', { messages: [] })).status).toBe(401)
    expect((await post('/anthropic/v1/messages', { messages: [] }, { authorization: 'Bearer dshlf_nope' })).status).toBe(401)
    const issued = tokens.issue({ runId: 'r1', kernelId: 'codex', target: TARGET, protocols: ['openai-responses'] }, 60_000)
    expect((await post('/anthropic/v1/messages', { messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': issued.token })).status).toBe(401)
    issued.revoke()
  })

  it('refuses browser origins and foreign Host headers', async () => {
    const issued = tokens.issue({ runId: 'r2', kernelId: 'claude-code', target: TARGET, protocols: ['anthropic'] }, 60_000)
    const res = await post('/anthropic/v1/messages', { messages: [{ role: 'user', content: 'x' }] }, { authorization: `Bearer ${issued.token}`, origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    issued.revoke()
  })

  it('enforces the body size limit', async () => {
    const issued = tokens.issue({ runId: 'r3', kernelId: 'claude-code', target: TARGET, protocols: ['anthropic'] }, 60_000)
    const res = await post('/anthropic/v1/messages', { messages: [{ role: 'user', content: 'x'.repeat(100_000) }] }, { authorization: `Bearer ${issued.token}` })
    expect(res.status).toBe(413)
    issued.revoke()
  })

  it('forwards streaming Anthropic requests to the bound target and counts usage', async () => {
    upstream.script = () => textReply('pong')
    const issued = tokens.issue({ runId: 'r4', kernelId: 'claude-code', target: TARGET, protocols: ['anthropic'] }, 60_000)
    const res = await post('/anthropic/v1/messages', { model: 'claude-sonnet-x', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] }, { authorization: `Bearer ${issued.token}` })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const frames = parseSse(await res.text())
    expect(frames[0]!.event).toBe('message_start')
    expect(upstream.requests.at(-1)!.target).toEqual(TARGET) // client model name does not change routing
    expect(issued.record.stats).toMatchObject({ requests: 1, inputTokens: 12, outputTokens: 3 })
    issued.revoke()
  })

  it('serves OpenAI chat, Responses and Gemini non-streaming', async () => {
    upstream.script = () => textReply('ok!')
    const t = tokens.issue({ runId: 'r5', kernelId: 'x', target: TARGET, protocols: ['openai-chat', 'openai-responses', 'gemini'] }, 60_000)
    const chat = (await (await post('/openai/v1/chat/completions', { messages: [{ role: 'user', content: 'a' }] }, { authorization: `Bearer ${t.token}` })).json()) as { choices: Array<{ message: { content: string } }> }
    expect(chat.choices[0]!.message.content).toBe('ok!')
    const resp = (await (await post('/openai/v1/responses', { input: 'a' }, { authorization: `Bearer ${t.token}` })).json()) as { output: Array<{ content: Array<{ text: string }> }> }
    expect(resp.output[0]!.content[0]!.text).toBe('ok!')
    const gem = (await (await post('/gemini/v1beta/models/g-1:generateContent', { contents: [{ role: 'user', parts: [{ text: 'a' }] }] }, { 'x-goog-api-key': t.token })).json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> }
    expect(gem.candidates[0]!.content.parts[0]!.text).toBe('ok!')
    const models = (await (await fetch(`${gateway.baseUrl}/openai/v1/models`, { headers: { authorization: `Bearer ${t.token}` } })).json()) as { data: Array<{ id: string }> }
    expect(models.data[0]!.id).toBe(TARGET.model)
    t.revoke()
  })

  it('revocation aborts in-flight upstream requests', async () => {
    upstream.script = async () => {
      await new Promise(r => setTimeout(r, 300))
      return textReply('late')
    }
    const t = tokens.issue({ runId: 'r6', kernelId: 'x', target: TARGET, protocols: ['openai-chat'] }, 60_000)
    const pending = post('/openai/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'a' }] }, { authorization: `Bearer ${t.token}` })
    await new Promise(r => setTimeout(r, 50))
    t.revoke()
    const res = await pending
    const text = await res.text()
    expect(res.status === 502 || text.includes('error')).toBe(true)
    expect((await post('/openai/v1/chat/completions', { messages: [{ role: 'user', content: 'a' }] }, { authorization: `Bearer ${t.token}` })).status).toBe(401)
  })

  it('MCP approval endpoint bridges permission prompts', async () => {
    const t = tokens.issue({ runId: 'r7', kernelId: 'claude-code', target: TARGET, protocols: ['anthropic', 'mcp'], sessionId: 's1' }, 60_000)
    const call = async (body: unknown) => (await post('/mcp', body, { authorization: `Bearer ${t.token}` })).json() as Promise<{ result: { content: Array<{ text: string }>; tools?: unknown[] } }>
    expect((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools).toHaveLength(1)
    approvals.allow = false
    const denied = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } } })
    expect(JSON.parse(denied.result.content[0]!.text)).toMatchObject({ behavior: 'deny' })
    approvals.allow = true
    const allowed = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Edit', input: { file: 'a' } } } })
    expect(JSON.parse(allowed.result.content[0]!.text)).toEqual({ behavior: 'allow', updatedInput: { file: 'a' } })
    expect(approvals.decisions).toEqual(['Bash', 'Edit'])
    t.revoke()
  })
})

describe('kernel runner with a fake Claude Code CLI', () => {
  const upstream = new FakeUpstream(() => textReply('answer from DSH model'))
  const tokens = new TokenStore()
  const gateway = new KernelGateway({ upstream, tokens, logger: { info: () => undefined, warn: () => undefined }, maxBodyBytes: 1 << 20, requestTimeoutMs: 5000, approvals: { request: async () => ({ allow: true }) } })
  const root = tempDir()
  chmodSync(FAKE, 0o755)
  const runner = new KernelRunner({
    tokens,
    gatewayUrl: () => gateway.baseUrl,
    runsRoot: join(root, 'tmp'),
    installRoot: join(root, 'kernels'),
    approvalBridge: true,
    resolve: () => ({ command: process.execPath, prefixArgs: [FAKE], source: 'settings', file: FAKE }),
    graceMs: 200,
  })
  const kernel = findKernel('claude-code')!
  const base = { kernel, cwd: root, mode: 'scoped' as const, permission: 'ask' as const, target: TARGET, timeoutMs: 15_000 }
  beforeAll(() => gateway.start())
  afterAll(() => gateway.stop())

  it('runs scoped: answer via gateway, usage, token revoked, no secrets in child env', async () => {
    process.env.SUPER_SECRET = 'should-not-leak'
    process.env.OPENAI_API_KEY = 'sk-should-not-leak-000000000000'
    const tools: string[] = []
    const result = await runner.run({ ...base, prompt: 'hello', runId: 'run-a', sessionId: 's1', onEvent: e => void (e.type === 'tool' && tools.push(e.detail)) })
    delete process.env.SUPER_SECRET
    delete process.env.OPENAI_API_KEY
    expect(result.status).toBe('completed')
    expect(result.text).toBe('answer from DSH model')
    expect(result.nativeSessionId).toBe('native-session-1')
    expect(result.usage).toMatchObject({ requests: 1, inputTokens: 12, outputTokens: 3 })
    expect(tools[0]).toContain('leaked=none')
    expect(tools[0]).toContain('configDir=true')
    expect(tools[0]).toContain('mcp=true')
    expect(tokens.size).toBe(0)
  })

  it('bridges approvals through the MCP endpoint', async () => {
    const result = await runner.run({ ...base, prompt: 'APPROVAL please', runId: 'run-b', sessionId: 's1' })
    expect(result.text).toContain('"behavior":"allow"')
  })

  it('reports crashes with exit code and stderr tail', async () => {
    const result = await runner.run({ ...base, prompt: 'CRASH', runId: 'run-c' })
    expect(result.status).toBe('error')
    expect(result.diagnostic).toMatch(/exited with code 3.*something broke/)
    expect(tokens.size).toBe(0)
  })

  it('times out and kills the child', async () => {
    const result = await runner.run({ ...base, prompt: 'SLEEP', runId: 'run-d', timeoutMs: 500 })
    expect(result.status).toBe('timeout')
    expect(tokens.size).toBe(0)
  })

  it('cancels on abort', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const result = await runner.run({ ...base, prompt: 'SLEEP', runId: 'run-e', signal: controller.signal })
    expect(result.status).toBe('aborted')
  })

  it('passes --resume for native session continuity', async () => {
    const result = await runner.run({ ...base, prompt: 'again', runId: 'run-f', resumeSessionId: 'native-xyz' })
    expect(result.nativeSessionId).toBe('native-xyz')
  })

  it('reports a missing binary clearly', async () => {
    const missing = new KernelRunner({ tokens, gatewayUrl: () => gateway.baseUrl, runsRoot: join(root, 'tmp'), installRoot: join(root, 'none'), approvalBridge: false, resolve: () => undefined })
    const result = await missing.run({ ...base, prompt: 'x', runId: 'run-g' })
    expect(result.status).toBe('error')
    expect(result.diagnostic).toContain('not installed')
  })
})
