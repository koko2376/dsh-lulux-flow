import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TokenStore } from '../../src/gateway/tokens.js'
import { BUILTIN_KERNELS, findKernel, registerKernel } from '../../src/kernels/catalog.js'
import { parseVersion, satisfiesMinVersion } from '../../src/kernels/binary.js'
import { globalBaseEnv, scopedBaseEnv } from '../../src/kernels/env.js'
import { normalizeRegistry, rank, RegistrySelector, scoreOf, type Fetcher, type ProbeResult } from '../../src/kernels/registry-probe.js'
import { SettingsStore } from '../../src/settings.js'
import { redact, redactDeep } from '../../src/util/redact.js'

const FAKE_HOME = join(tmpdir(), 'lulux-flow-fake-home')
import { hostAllowed, isBlockedAddress, outboundRequest } from '../../src/workflow/ssrf.js'
import { assertSafeId, safeJoin } from '../../src/util/fs.js'
import { buildTurnPrompt, conversationTurns } from '../../src/dsh/kernel-chat.js'
import { fromDshChunks, toGenerateOptions } from '../../src/dsh/llm-upstream.js'
import { TARGET, fromArray, tempDir } from '../helpers.js'

describe('token store', () => {
  it('mints prefixed tokens, stores only digests, expires and revokes', () => {
    let now = 1000
    const store = new TokenStore(() => now)
    const issued = store.issue({ runId: 'r', kernelId: 'k', target: TARGET, protocols: ['anthropic'] }, 500)
    expect(issued.token).toMatch(/^dshlf_[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(issued.record)).not.toContain(issued.token)
    expect(store.resolve(issued.token, 'anthropic')).toBe(issued.record)
    expect(store.resolve(issued.token, 'gemini')).toBeUndefined()
    expect(store.resolve(`${issued.token}x`, 'anthropic')).toBeUndefined()
    expect(store.resolve('x'.repeat(10_000), 'anthropic')).toBeUndefined()
    now = 1600
    expect(store.resolve(issued.token, 'anthropic')).toBeUndefined()
    const second = store.issue({ runId: 'r2', kernelId: 'k', target: TARGET, protocols: ['anthropic'] }, 500)
    const controller = new AbortController()
    second.record.inflight.add(controller)
    expect(store.revokeRun('r2')).toBe(1)
    expect(controller.signal.aborted).toBe(true)
    expect(store.size).toBe(0)
  })
})

describe('child environment', () => {
  const source = { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'x', OPENAI_BASE_URL: 'y', MY_SERVICE_TOKEN: 'z', DEEPSEEK_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 's', DSH_HOME: '/d', LANG: 'C', NO_PROXY: 'corp' }
  it('scoped mode strips every credential-shaped variable and keeps loopback off proxies', () => {
    const env = scopedBaseEnv(source)
    expect(Object.keys(env).sort()).toEqual(['FORCE_COLOR', 'HOME', 'LANG', 'NO_COLOR', 'NO_PROXY', 'PATH', 'no_proxy'])
    expect(env.NO_PROXY).toBe('corp,127.0.0.1,localhost,::1')
  })
  it('global mode keeps the native login env but drops DSH internals', () => {
    const env = globalBaseEnv(source)
    expect(env.ANTHROPIC_API_KEY).toBe('x')
    expect(env.DSH_HOME).toBeUndefined()
  })
})

describe('kernel catalog', () => {
  it('has unique ids and never puts the token in argv', () => {
    expect(new Set(BUILTIN_KERNELS.map(k => k.id)).size).toBe(BUILTIN_KERNELS.length)
    for (const kernel of BUILTIN_KERNELS) {
      for (const permission of ['read-only', 'ask', 'edit', 'full'] as const) {
        const launch = kernel.launch({ mode: 'scoped', permission, home: FAKE_HOME, gatewayUrl: 'http://127.0.0.1:1', token: 'dshlf_SECRET', model: 'm', approvalBridge: true })
        expect(launch.args.join(' ')).not.toContain('dshlf_SECRET')
        expect(JSON.stringify(launch.env) + JSON.stringify(launch.files ?? {})).toContain('dshlf_SECRET')
      }
      const global = kernel.launch({ mode: 'global', permission: 'ask', home: FAKE_HOME, gatewayUrl: '', token: '', model: 'm', approvalBridge: false })
      expect(JSON.stringify(global.env)).not.toContain('127.0.0.1')
    }
  })
  it('maps permissions to each CLI', () => {
    const claude = findKernel('claude-code')!.launch({ mode: 'scoped', permission: 'edit', home: '/h', gatewayUrl: 'http://127.0.0.1:1', token: 't', model: 'm', approvalBridge: true })
    expect(claude.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--permission-prompt-tool', 'mcp__lulux_flow__approve']))
    expect(claude.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1/anthropic')
    const codex = findKernel('codex')!.launch({ mode: 'scoped', permission: 'read-only', home: '/h', gatewayUrl: 'http://127.0.0.1:1', token: 't', model: 'm', approvalBridge: false, resumeSessionId: 'th1' })
    expect(codex.args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(codex.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', 'resume', 'th1']))
    expect(codex.args.at(-1)).toBe('-')
    const gemini = findKernel('gemini-cli')!.launch({ mode: 'scoped', permission: 'full', home: '/h', gatewayUrl: 'http://127.0.0.1:1', token: 't', model: 'm', approvalBridge: false })
    expect(gemini.args).toEqual(expect.arrayContaining(['--approval-mode', 'yolo']))
    expect(gemini.files?.['.gemini/settings.json']).toContain('gemini-api-key')
  })
  it('parses each CLI output format', () => {
    const claude = findKernel('claude-code')!.parser()
    expect(claude.line({ type: 'system', subtype: 'init', session_id: 's' })).toEqual([{ type: 'session', id: 's' }])
    expect(claude.line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } })).toEqual([{ type: 'text', text: 'hi' }])
    expect(claude.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } })).toEqual([{ type: 'tool', name: 'Bash', detail: 'ls' }])
    const codex = findKernel('codex')!.parser()
    expect(codex.line({ type: 'thread.started', thread_id: 't' })).toEqual([{ type: 'session', id: 't' }])
    expect(codex.line({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })).toEqual([{ type: 'text', text: 'done', final: true }])
    expect(codex.line({ type: 'turn.failed', error: { message: 'x' } })[0]).toMatchObject({ type: 'error', fatal: true })
    const gemini = findKernel('gemini-cli')!.parser()
    expect(gemini.line({ type: 'message', role: 'assistant', content: 'g' })).toEqual([{ type: 'text', text: 'g' }])
    const grok = findKernel('grok')!.parser()
    expect(grok.line({ type: 'text', data: 'k' })).toEqual([{ type: 'text', text: 'k' }])
  })
  it('lets third parties register kernels', () => {
    const dispose = registerKernel({ ...findKernel('qwen-code')!, id: 'my-cli', name: 'My CLI' })
    expect(findKernel('my-cli')?.name).toBe('My CLI')
    expect(() => registerKernel({ ...findKernel('qwen-code')!, id: 'my-cli' })).toThrow()
    dispose()
    expect(findKernel('my-cli')).toBeUndefined()
  })
  it('compares versions', () => {
    expect(parseVersion('codex-cli 0.163.0')).toBe('0.163.0')
    expect(satisfiesMinVersion('2.1.304', '>=2.0.0')).toBe(true)
    expect(satisfiesMinVersion('0.1.9', '>=1.0.0')).toBe(false)
  })
})

describe('registry selection', () => {
  const result = (registry: string, version: string, integrity: string, latencyMs: number): ProbeResult => ({ registry, ok: true, latencyMs, throughput: 100_000, version, integrity, satisfies: true, trusted: false, score: 0 })
  it('ranks by latency and trusts only integrity matching the canonical registry', () => {
    const ranked = rank('pkg', [
      result('https://registry.npmjs.org', '1.0.0', 'sha512-good', 300),
      result('https://fast.mirror', '1.0.0', 'sha512-good', 50),
      result('https://evil.mirror', '1.0.0', 'sha512-evil', 10),
      { registry: 'https://down', ok: false, latencyMs: 4000, throughput: 0, satisfies: false, trusted: false, score: Infinity, error: 'timeout' },
    ])
    expect(RegistrySelector.usable(ranked).map(r => r.registry)).toEqual(['https://fast.mirror', 'https://registry.npmjs.org'])
    expect(ranked.referenceIntegrity).toBe('sha512-good')
  })
  it('falls back to majority vote when the canonical registry is unreachable', () => {
    const ranked = rank('pkg', [result('https://a', '1.0.0', 'sha512-x', 100), result('https://b', '1.0.0', 'sha512-x', 200), result('https://c', '1.0.0', 'sha512-y', 5)])
    expect(ranked.referenceIntegrity).toBe('sha512-x')
    expect(RegistrySelector.usable(ranked).map(r => r.registry)).toEqual(['https://a', 'https://b'])
  })
  it('probes in parallel with timeouts, caches, and honours a trusted override', async () => {
    let calls = 0
    const fetcher: Fetcher = async (url, init) => {
      calls += 1
      if (url.startsWith('https://slow')) {
        await new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
      }
      const old = url.startsWith('https://old')
      return new Response(JSON.stringify({ version: old ? '0.0.1' : '1.2.3', dist: { integrity: 'sha512-ok' } }), { status: 200 })
    }
    const selector = new RegistrySelector({ candidates: () => ['https://registry.npmjs.org', 'https://slow.example', 'https://old.example', 'https://mirror.example'], override: () => 'https://mirror.example', ttlMs: 60_000, timeoutMs: 200, fetcher })
    const ranked = await selector.select('@scope/pkg', '>=1.0.0')
    expect(ranked.results[0]!.registry).toBe('https://mirror.example')
    expect(ranked.results.find(r => r.registry === 'https://slow.example')!.error).toMatch(/timeout/)
    expect(ranked.results.find(r => r.registry === 'https://old.example')!.satisfies).toBe(false)
    const before = calls
    await selector.select('@scope/pkg', '>=1.0.0')
    expect(calls).toBe(before)
    expect(scoreOf({ ok: false, latencyMs: 1, throughput: 1 })).toBe(Infinity)
    expect(() => normalizeRegistry('https://user:pw@x.example')).toThrow()
  })
})

describe('redaction & paths', () => {
  it('redacts tokens and secret-shaped fields', () => {
    expect(redact('token dshlf_abcdefghijklmnopqrstuvwxyz0123 and sk-ant-0123456789abcdefghij')).not.toMatch(/dshlf_abc|sk-ant-0123/)
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [REDACTED]')
    expect(redactDeep({ headers: { Authorization: 'x', ok: 'y' }, api_key: 'k' })).toEqual({ headers: { Authorization: '[REDACTED]', ok: 'y' }, api_key: '[REDACTED]' })
  })
  it('refuses unsafe ids and traversal', () => {
    expect(() => assertSafeId('a/b')).toThrow()
    expect(() => safeJoin('/data', '../etc')).toThrow()
    expect(safeJoin('/data', 'runs', 'a.json')).toBe('/data/runs/a.json')
  })
})

describe('SSRF guard', () => {
  it('classifies private and reserved addresses', () => {
    for (const addr of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) expect(isBlockedAddress(addr)).toBe(true)
    for (const addr of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isBlockedAddress(addr)).toBe(false)
    expect(hostAllowed('api.internal.example', ['*.internal.example'])).toBe(true)
    expect(hostAllowed('internal.example.evil', ['*.internal.example'])).toBe(false)
  })
  it('blocks loopback targets, including via DNS names and redirects, unless allowlisted', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/secret' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(5000))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const policy = { allowPrivateHosts: [] as string[], maxResponseBytes: 1000, timeoutMs: 2000 }
    await expect(outboundRequest(`http://127.0.0.1:${port}/`, {}, policy)).rejects.toThrow(/blocked/)
    await expect(outboundRequest(`http://localhost:${port}/`, {}, policy)).rejects.toThrow(/blocked/)
    await expect(outboundRequest('file:///etc/passwd', {}, policy)).rejects.toThrow(/unsupported protocol/)
    const allowed = await outboundRequest(`http://localhost:${port}/`, {}, { ...policy, allowPrivateHosts: ['localhost'] })
    expect(allowed.status).toBe(200)
    expect(allowed.truncated).toBe(true)
    expect(allowed.body).toHaveLength(1000)
    await expect(outboundRequest(`http://localhost:${port}/redirect`, {}, { ...policy, allowPrivateHosts: ['localhost'] })).rejects.toThrow(/blocked/)
    server.close()
  })
})

describe('settings', () => {
  it('validates and persists kernel settings', () => {
    const dir = tempDir()
    const store = new SettingsStore(dir)
    store.update({ kernels: { codex: { mode: 'global', permission: 'edit', enabled: false, bogus: 1 }, 'bad id!': { mode: 'global' } }, registryOverride: 'https://registry.npmmirror.com' })
    expect(new SettingsStore(dir).kernel('codex')).toEqual({ enabled: false, mode: 'global', permission: 'edit', binaryPath: '' })
    expect(() => store.update({ registryOverride: 'ftp://x' })).toThrow()
    expect(() => store.update({ gatewayModel: 'nope' })).toThrow()
    expect(store.get().kernels['bad id!']).toBeUndefined()
  })
})

describe('DSH model bridge', () => {
  it('converts canonical requests into DSH GenerateOptions', () => {
    const options = toGenerateOptions(
      {
        model: 'x',
        system: 'S',
        stream: true,
        tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
        turns: [
          { role: 'user', text: 'q', images: [{ mime: 'image/png', data: 'AA' }] },
          { role: 'assistant', text: 'a', toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }] },
          { role: 'tool', toolCallId: 'c1', text: 'r', isError: true },
        ],
        maxTokens: 9,
      },
      TARGET,
      new AbortController().signal,
    )
    expect(options).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', system: 'S', maxTokens: 9 })
    expect(options.messages[0]).toMatchObject({ role: 'user' })
    expect(JSON.stringify(options.messages[0])).toContain('image(s) omitted')
    expect(options.messages[1]).toMatchObject({ role: 'assistant', source: { kind: 'model', provider: 'deepseek' } })
    expect(options.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', isError: true })
  })
  it('translates DSH stream chunks into canonical events', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'c1', name: 'ls', argumentsDelta: '{"a"' },
      { type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: ':1}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'ls', arguments: '{"a":1}' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const events = []
    for await (const e of fromDshChunks(fromArray(chunks as never[]))) events.push(e)
    expect(events.map(e => e.type)).toEqual(['text', 'tool-call-start', 'tool-call-delta', 'tool-call-delta', 'tool-call-end', 'usage', 'finish'])
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_use' })
    const failed = []
    for await (const e of fromDshChunks(fromArray([{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota', code: 'Q' } } }] as never[]))) failed.push(e)
    expect(failed).toEqual([{ type: 'finish', reason: 'error', error: 'quota' }])
  })
})

describe('kernel chat prompts', () => {
  const claude = findKernel('claude-code')!
  const gemini = findKernel('gemini-cli')!
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } },
    { role: 'assistant', content: [{ type: 'text', text: 'answer one' }] },
    { role: 'user', content: [{ type: 'text', text: '<runtime context>' }], source: { kind: 'runtime-context' } },
    { role: 'user', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } },
  ]
  const turns = conversationTurns({ messages } as never)
  it('extracts user-typed turns only', () => {
    expect(turns).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'answer one' },
      { role: 'user', text: 'second' },
    ])
  })
  it('resumes a native session when the CLI supports it and is in sync', () => {
    expect(buildTurnPrompt(turns, { kernelId: 'claude-code', nativeSessionId: 'n1', deliveredTurns: 1, updatedAt: '' }, claude)).toEqual({ prompt: 'second', resume: 'n1', userTurns: 2 })
  })
  it('replays earlier context otherwise', () => {
    const built = buildTurnPrompt(turns, undefined, gemini)
    expect(built.resume).toBeUndefined()
    expect(built.prompt).toContain('User: first')
    expect(built.prompt).toContain('Assistant: answer one')
    expect(built.prompt.endsWith('second')).toBe(true)
  })
})
