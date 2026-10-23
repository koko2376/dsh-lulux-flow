/**
 * Hardening tests: linear-time regex, scoped env allowlist, redirect
 * credentials, Windows .cmd shims, secret redaction, Grok permission mapping,
 * scrubbed --version probes, script-node isolation, and the http/notify
 * executors.
 */
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cmdCommandLine, entryCommand, nodeSpawnEnv, probeVersion, quoteCmdArg, resolveCmdShim, spawnArgs } from '../../src/kernels/binary.js'
import { claudeAbsoluteRule, claudeDenyRules, findKernel } from '../../src/kernels/catalog.js'
import { hasUserinfo, npmBaseEnv, scopedBaseEnv } from '../../src/kernels/env.js'
import { SettingsStore } from '../../src/settings.js'
import { isSecretName, redactDeep } from '../../src/util/redact.js'
import { evaluate } from '../../src/workflow/expr.js'
import { createExecutors } from '../../src/workflow/executors.js'
import { compileSafeRegex, RegexBudgetError } from '../../src/workflow/safe-regex.js'
import { runScript } from '../../src/workflow/script.js'
import { outboundRequest, stripSecretHeaders } from '../../src/workflow/ssrf.js'
import { tempDir } from '../helpers.js'

const scope = (inputs: Record<string, unknown>) => ({ inputs, nodes: {}, run: { id: '', workflowId: '', trigger: '' } })

describe('matches is linear-time', () => {
  it('a catastrophic-backtracking input finishes immediately on the host thread', () => {
    const started = Date.now()
    expect(evaluate('inputs.s matches inputs.re', scope({ s: `${'a'.repeat(30)}!`, re: '^(a+)+$' }))).toBe(false)
    expect(evaluate('inputs.s matches inputs.re', scope({ s: 'a'.repeat(20_000), re: '^(a|aa)+$' }))).toBe(true)
    expect(evaluate('inputs.s matches inputs.re', scope({ s: `${'a'.repeat(5000)}b`, re: '(a*)*c' }))).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
  })
  it('agrees with JavaScript on common patterns and rejects unsupported syntax', () => {
    const cases: Array<[string, string, boolean]> = [
      ['^LGTM\\b', 'LGTM, ship it', true],
      ['(?i)^error:', 'ERROR: boom', true],
      ['\\d{3}-\\d{4}', 'call 555-1234', true],
      ['^[A-Z][a-z]+$', 'Hello', true],
      ['^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$', 'a@b.io', true],
      ['colou?r', 'color', true],
      ['^(?:ab|cd){2}$', 'abcd', true],
      ['^(?:ab|cd){2}$', 'abc', false],
      ['a.c', 'a\nc', false],
      ['\\bcat\\b', 'concatenate', false],
      ['x{', 'x{', true],
    ]
    for (const [pattern, subject, expected] of cases) {
      expect(compileSafeRegex(pattern).test(subject), pattern).toBe(expected)
      if (!pattern.startsWith('(?i)')) expect(new RegExp(pattern).test(subject), `js ${pattern}`).toBe(expected)
    }
    // a large program on a long subject hits the step budget quickly instead of blocking
    const started = performance.now()
    expect(() => compileSafeRegex('(?:.{100}|.{99}){15}x').test('a'.repeat(20_000))).toThrow(RegexBudgetError)
    expect(performance.now() - started).toBeLessThan(1000)
    for (const bad of ['(a)\\1', '(?=a)', '(?<!a)b', '[a', '(a', 'a)', '*a', 'a{2,1}', 'a{1000}', 'x'.repeat(201)]) expect(() => compileSafeRegex(bad), bad).toThrow()
  })
})

describe('scoped env is an allowlist', () => {
  it('drops credential-shaped and unknown variables, keeps what a CLI needs', () => {
    const src = {
      MISTRAL_KEY: 'x',
      GROQ_KEY: 'x',
      PRIVATE_KEY: 'x',
      DATABASE_URL: 'postgres://u:pw@h/db',
      HTTPS_PROXY: 'http://u:pw@proxy:8080',
      'npm_config_//registry.npmjs.org/:_authToken': 'npm_x',
      GITLAB_PAT: 'glpat',
      CARGO_REGISTRY_TOKEN: 'x',
      OPENAI_API_KEY: 'x',
      SILICONFLOW_APIKEY: 'x',
      ZHIPUAI_API_KEY: 'x',
      SSH_AUTH_SOCK: '/s',
      KUBECONFIG: '/k',
      DOCKER_AUTH_CONFIG: 'x',
      AZURE_CLIENT_SECRET: 'x',
      ARK_API_KEY: 'x',
      MINIMAX_GROUP_ID: 'x',
      BAIDU_SK: 'x',
      HUNYUAN_SECRET_ID: 'x',
      DSH_HOME: '/d',
      PATH: '/bin',
      HOME: '/h',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      TMPDIR: '/tmp',
      SystemRoot: 'C:\\Windows',
      HTTP_PROXY: 'http://proxy:3128',
      NO_PROXY: 'corp',
    }
    const out = scopedBaseEnv(src)
    const passed = Object.keys(src).filter(k => k in out)
    expect(passed.sort()).toEqual(['HOME', 'HTTP_PROXY', 'LANG', 'LC_ALL', 'NO_PROXY', 'PATH', 'SystemRoot', 'TMPDIR'].sort())
    expect(out.NO_PROXY).toBe('corp,127.0.0.1,localhost,::1')
    // explicit operator passthrough
    expect(scopedBaseEnv(src, ['SSH_AUTH_SOCK']).SSH_AUTH_SOCK).toBe('/s')
    expect(hasUserinfo('http://u:p@h:1')).toBe(true)
    expect(hasUserinfo('proxy.corp:3128')).toBe(false)
  })

  it('npm steps get the allowlist plus proxies and non-secret npm_config_* only', () => {
    const env = npmBaseEnv({
      PATH: '/bin',
      HOME: '/h',
      OPENAI_API_KEY: 'sk-x',
      ANTHROPIC_AUTH_TOKEN: 't',
      DSH_SECRET: 'd',
      HTTPS_PROXY: 'http://u:p@proxy:3128',
      npm_config_cache: '/c',
      npm_config_cafile: '/ca.pem',
      npm_config__authToken: 'npm_x',
      'npm_config_//registry.npmjs.org/:_authToken': 'npm_y',
      NPM_CONFIG_PASSWORD: 'pw',
      AWS_SECRET_ACCESS_KEY: 'aws',
    })
    expect(Object.keys(env).filter(k => !['NO_PROXY', 'no_proxy', 'NO_COLOR', 'FORCE_COLOR'].includes(k)).sort()).toEqual(['HOME', 'HTTPS_PROXY', 'PATH', 'npm_config_cache', 'npm_config_cafile'].sort())
  })
})

describe('--version probes get the scrubbed env', () => {
  it('does not pass provider keys to the binary', async () => {
    const dir = tempDir()
    const script = join(dir, 'probe.mjs')
    writeFileSync(script, "console.log(process.env.DEEPSEEK_API_KEY ? '9.9.9 leaked' : '1.2.3')\n")
    process.env.DEEPSEEK_API_KEY = 'sk-test-leak-check'
    try {
      expect(await probeVersion({ command: process.execPath, prefixArgs: [script], source: 'settings', file: script })).toBe('1.2.3')
    } finally {
      delete process.env.DEEPSEEK_API_KEY
    }
  })
})

describe('Windows .cmd shims', () => {
  it('resolves the JavaScript entry of an npm cmd shim (run with node, not cmd.exe)', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
    const entry = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    writeFileSync(entry, '')
    const shim = join(dir, 'codex.cmd')
    writeFileSync(shim, '@ECHO off\r\nGOTO start\r\n:start\r\nSET "_prog=node"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n')
    expect(resolveCmdShim(shim, { npmPackage: '@openai/codex', bin: 'codex' })).toEqual({ file: entry, kind: 'node' })
    // no path in the shim: fall back to node_modules/<pkg>/package.json
    writeFileSync(shim, '@echo off\r\n')
    writeFileSync(join(dir, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ bin: { codex: 'bin/codex.js' } }))
    expect(resolveCmdShim(shim, { npmPackage: '@openai/codex', bin: 'codex' })).toEqual({ file: entry, kind: 'node' })
    expect(resolveCmdShim(join(dir, 'missing.cmd'), { npmPackage: '@x/y', bin: 'y' })).toBeUndefined()
  })
  it('treats a shim that points at a native exe (Claude Code >= 2.1 claude.exe) as native, never as a Node script', () => {
    const dir = tempDir()
    const binDir = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin')
    mkdirSync(binDir, { recursive: true })
    const exe = join(binDir, 'claude.exe')
    writeFileSync(exe, Buffer.from([0x4d, 0x5a, 0x90, 0x00]))
    const shim = join(dir, 'claude.cmd')
    writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n')
    const entry = resolveCmdShim(shim, { npmPackage: '@anthropic-ai/claude-code', bin: 'claude' })
    expect(entry).toEqual({ file: exe, kind: 'native' })
    expect(entryCommand(entry!)).toEqual({ command: exe, prefixArgs: [] })
    // same answer through the package.json bin fallback
    writeFileSync(shim, '@echo off\r\n')
    writeFileSync(join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude.exe' } }))
    expect(resolveCmdShim(shim, { npmPackage: '@anthropic-ai/claude-code', bin: 'claude' })).toEqual({ file: exe, kind: 'native' })
    // an extensionless native bin is classified by content
    writeFileSync(join(binDir, 'claude'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    writeFileSync(join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude' } }))
    expect(resolveCmdShim(shim, { npmPackage: '@anthropic-ai/claude-code', bin: 'claude' })?.kind).toBe('native')
    expect(entryCommand({ file: '/x/cli.js', kind: 'node' })).toEqual({ command: process.execPath, prefixArgs: ['/x/cli.js'] })
  })
  it('runs the host executable as Node inside Electron (ELECTRON_RUN_AS_NODE=1), and only then', () => {
    const versions = process.versions as Record<string, string | undefined>
    const had = versions.electron
    try {
      versions.electron = '38.0.0'
      expect(nodeSpawnEnv(process.execPath, { PATH: '/bin' })).toEqual({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' })
      expect(nodeSpawnEnv('/usr/local/bin/claude', { PATH: '/bin' })).toEqual({ PATH: '/bin' })
      delete versions.electron
      expect(nodeSpawnEnv(process.execPath, { PATH: '/bin' })).toEqual({ PATH: '/bin' })
    } finally {
      if (had === undefined) delete versions.electron
      else versions.electron = had
    }
  })
  it('quotes arguments for cmd.exe so quotes, spaces and metacharacters stay literal', () => {
    expect(quoteCmdArg('plain')).toBe('^"plain^"')
    expect(quoteCmdArg('model_provider="luluxflow"')).toBe('^"model_provider=\\^"luluxflow\\^"^"')
    expect(quoteCmdArg('a & b | c ^ %PATH% !x!')).toBe('^"a ^& b ^| c ^^ ^%PATH^% ^!x^!^"')
    expect(quoteCmdArg('C:\\Program Files\\x\\')).toBe('^"C:\\Program Files\\x\\\\^"')
    expect(quoteCmdArg('<in >out (x)')).toBe('^"^<in ^>out ^(x^)^"')
    const line = cmdCommandLine('C:\\npm prefix\\codex.cmd', ['-c', 'model="m"'])
    expect(line.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    // the file is escaped once, arguments twice (the batch file re-parses %*)
    expect(line[3]).toBe('"^"C:\\npm prefix\\codex.cmd^" ^^^"-c^^^" ^^^"model=\\^^^"m\\^^^"^^^""')
    const injected = cmdCommandLine('C:\\npm\\claude.cmd', ['--model', 'm"&calc&"'])[3]!
    expect(injected).toContain('^^^&calc^^^&')
    expect(injected).not.toMatch(/[^^]&/)
    expect(() => cmdCommandLine('C:\\x.cmd', ['a\r\nb'])).toThrow(/line break/)
    expect(spawnArgs({ command: 'cmd.exe', prefixArgs: [], source: 'path', file: 'C:\\x.cmd', cmdShim: true }, ['a']).windowsVerbatimArguments).toBe(true)
    expect(spawnArgs({ command: '/bin/x', prefixArgs: ['p'], source: 'path', file: '/bin/x' }, ['a'])).toEqual({ command: '/bin/x', args: ['p', 'a'], windowsVerbatimArguments: false })
  })
})

describe('redaction of secret-named fields', () => {
  it('catches common secret header names and leaves ordinary fields alone', () => {
    for (const name of ['Authorization', 'X-Auth-Token', 'Private-Token', 'x-goog-api-key', 'Cookie', 'api-token', 'set-cookie', 'client_secret', 'accessToken', 'X-API-Key', 'proxy-authorization']) expect(isSecretName(name), name).toBe(true)
    for (const name of ['inputTokens', 'outputTokens', 'keyword', 'monkey', 'content-type', 'prompt', 'url', 'status']) expect(isSecretName(name), name).toBe(false)
    const out = redactDeep({ headers: { 'X-Auth-Token': 'abc123', 'Private-Token': 'glpat-x', Cookie: 'sid=1', Accept: 'json' }, usage: { inputTokens: 5 } })
    expect(out).toEqual({ headers: { 'X-Auth-Token': '[REDACTED]', 'Private-Token': '[REDACTED]', Cookie: '[REDACTED]', Accept: 'json' }, usage: { inputTokens: 5 } })
  })
})

describe('Grok permission mapping', () => {
  it('never maps edit to unrestricted tools, and the settings refuse edit for Grok', () => {
    const grok = findKernel('grok')!
    for (const permission of ['read-only', 'ask', 'edit'] as const) {
      expect(grok.launch({ mode: 'scoped', permission, home: '/h', gatewayUrl: 'http://g', token: 't', model: 'm', approvalBridge: false }).args).toEqual(expect.arrayContaining(['--tools', 'read_file,list_dir,grep']))
    }
    expect(grok.launch({ mode: 'scoped', permission: 'full', home: '/h', gatewayUrl: 'http://g', token: 't', model: 'm', approvalBridge: false }).args).not.toContain('--tools')
    const settings = new SettingsStore(tempDir())
    expect(() => settings.update({ kernels: { grok: { permission: 'edit' } } })).toThrow(/cannot enforce "edit"/)
    expect(settings.update({ kernels: { grok: { permission: 'full' } } }).kernels.grok!.permission).toBe('full')
  })
})

describe('file-access mitigations in the launch flags', () => {
  it('Claude Code gets deny rules for DSH home, the data dir and /proc', () => {
    const launch = findKernel('claude-code')!.launch({ mode: 'scoped', permission: 'read-only', home: '/h', gatewayUrl: 'http://g', token: 't', model: 'm', approvalBridge: false, protectedPaths: ['/home/u/.dsh', '/home/u/.dsh/dsh-lulux-flow'] })
    expect(launch.args).toEqual(expect.arrayContaining(['--settings', '{home}/lulux-flow-settings.json']))
    const deny = (JSON.parse(launch.files!['lulux-flow-settings.json']!) as { permissions: { deny: string[] } }).permissions.deny
    expect(deny).toEqual(expect.arrayContaining(['Read(//home/u/.dsh/**)', 'Read(//home/u/.dsh/dsh-lulux-flow/**)', 'Read(~/.dsh/**)']))
    if (process.platform !== 'win32') expect(deny).toContain('Read(//proc/**)')
    expect(claudeAbsoluteRule('C:\\Users\\u\\.dsh\\')).toBe('//c/Users/u/.dsh/**')
    expect(claudeDenyRules([])).toContain('Edit(~/.dsh/**)')
    // a protected dir reached through a symlink is denied under its real path too
    const real = tempDir()
    const link = `${real}-link`
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    const linked = claudeDenyRules([link])
    expect(linked).toEqual(expect.arrayContaining([`Read(${claudeAbsoluteRule(link)})`, `Read(${claudeAbsoluteRule(realpathSync(real))})`]))
    // global mode too
    expect(findKernel('claude-code')!.launch({ mode: 'global', permission: 'edit', home: '/h', gatewayUrl: '', token: '', model: 'm', approvalBridge: false }).args).toContain('--settings')
  })
  it('Codex keeps tool shells away from the token and the network below full', () => {
    const at = (permission: 'read-only' | 'edit' | 'full') => findKernel('codex')!.launch({ mode: 'scoped', permission, home: '/h', gatewayUrl: 'http://g', token: 't', model: 'm', approvalBridge: false }).args.join(' ')
    expect(at('read-only')).toContain('shell_environment_policy.inherit="core"')
    expect(at('edit')).toContain('sandbox_workspace_write.network_access=false')
    expect(at('edit')).toContain('--sandbox workspace-write')
    expect(at('full')).toContain('--sandbox danger-full-access')
  })
})

describe('script nodes', () => {
  const opts = { timeoutMs: 3000, maxHeapMb: 64 }
  it('still run ordinary code', async () => {
    expect(await runScript('console.log("n", input.n); return { double: input.n * 2 }', { n: 21 }, opts)).toEqual({ value: { double: 42 }, logs: ['n 21'] })
  })
  it('block the host-realm escape (console.log.constructor → process) and input-realm escapes', async () => {
    const escape = "const F = console.log.constructor; const p = F('return process')(); return p.getBuiltinModule('child_process').execSync('id -un').toString()"
    await expect(runScript(escape, null, opts)).rejects.toThrow(/Code generation from strings disallowed/)
    await expect(runScript("return input.constructor.constructor('return process')().pid", { a: 1 }, opts)).rejects.toThrow(/Code generation/)
  })
  it('run in a process without file system or child process access', async () => {
    // Even code that reaches a host object finds the permission model in force.
    const { value } = await runScript('return typeof process === "undefined" ? "no process" : "process"', null, opts)
    expect(value).toBe('no process')
  })
  it('time out and are killed', async () => {
    await expect(runScript('while (true) {}', null, { timeoutMs: 300, maxHeapMb: 32 })).rejects.toThrow(/timed out/)
  })
})

describe('http/notify executors and redirect credentials', () => {
  let server: Server
  let base = ''
  const seen: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = []
  let otherBase = ''
  let other: Server
  beforeAll(async () => {
    other = createServer((req, res) => {
      seen.push({ url: `other${req.url ?? ''}`, headers: req.headers, body: '' })
      res.end('{"ok":true}')
    })
    await new Promise<void>(r => other.listen(0, '127.0.0.1', r))
    otherBase = `http://localhost:${(other.address() as AddressInfo).port}`
    server = createServer((req, res) => {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        seen.push({ url: req.url ?? '', headers: req.headers, body })
        if (req.url === '/same') return res.writeHead(302, { location: '/final' }).end()
        if (req.url === '/cross') return res.writeHead(307, { location: `${otherBase}/landing` }).end()
        if (req.url === '/fail') return res.writeHead(500).end('{"error":"x","token":"sk-abcdefghijklmnopqrstuvwxyz"}')
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=secret-session' }).end(JSON.stringify({ hello: 'world', method: req.method }))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server.close()
    other.close()
  })
  const policy = { allowPrivateHosts: ['127.0.0.1', 'localhost'], maxResponseBytes: 10_000, timeoutMs: 3000 }
  const secretHeaders = { Authorization: 'Bearer s3cret', 'X-Auth-Token': 'tok', Cookie: 'sid=1', 'X-Trace': 'keep-me' }

  it('keeps credentials on same-origin redirects and drops them across origins', async () => {
    seen.length = 0
    await outboundRequest(`${base}/same`, { headers: secretHeaders }, policy)
    expect(seen.at(-1)!.url).toBe('/final')
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer s3cret')
    await outboundRequest(`${base}/cross`, { method: 'POST', headers: secretHeaders, body: '{}' }, policy)
    const landing = seen.at(-1)!
    expect(landing.url).toBe('other/landing')
    expect(landing.headers.authorization).toBeUndefined()
    expect(landing.headers['x-auth-token']).toBeUndefined()
    expect(landing.headers.cookie).toBeUndefined()
    expect(landing.headers['x-trace']).toBe('keep-me')
    expect(stripSecretHeaders({ 'Proxy-Authorization': 'x', Accept: 'y' })).toEqual({ Accept: 'y' })
    expect(stripSecretHeaders({ 'Api-Token-V2': 'v', 'X-Secret-Id': 's', 'Session-Key-1': 'k', Accept: 'y', 'X-Monkey': 'm', 'Content-Type': 'c' })).toEqual({ Accept: 'y', 'X-Monkey': 'm', 'Content-Type': 'c' })
    // the deprecated IPv4-compatible form is blocked too
    await expect(outboundRequest('http://[::127.0.0.1]:1/', {}, { ...policy, allowPrivateHosts: [] })).rejects.toThrow(/private or reserved/)
  })

  it('http executor: JSON body, status check, secret response headers redacted', async () => {
    const ex = createExecutors({ kernelTarget: () => ({ provider: 'p', model: 'm' }), defaultCwd: () => '/', outbound: policy, script: { timeoutMs: 1000, maxHeapMb: 32 }, kernelTimeoutMs: 1000 })
    const traces: string[] = []
    const ctx = { run: { id: 'r', workflowName: 'w' }, node: { id: 'n', name: 'n' }, scope: scope({}), signal: new AbortController().signal, trace: (l: string) => traces.push(l) } as never
    const result = (await ex.http({ method: 'post', url: `${base}/ok`, body: { a: 1 }, headers: { 'X-Api-Key': 'abc' } }, ctx)) as { output: { status: number; body: unknown; headers: Record<string, string> } }
    expect(result.output.status).toBe(200)
    expect(result.output.body).toEqual({ hello: 'world', method: 'POST' })
    expect(result.output.headers['set-cookie']).toBe('[REDACTED]')
    expect(seen.at(-1)!.headers['content-type']).toBe('application/json')
    await expect(ex.http({ url: `${base}/fail` }, ctx)).rejects.toThrow(/HTTP 500/)
    await expect(ex.http({ url: `${base}/fail` }, ctx)).rejects.not.toThrow(/sk-abcdefghij/)
    expect((await ex.http({ url: `${base}/fail`, expectStatus: 500 }, ctx)) as { output: { status: number } }).toMatchObject({ output: { status: 500 } })
    await expect(ex.http({ url: 'http://169.254.169.254/latest' }, { ...(ctx as object), signal: new AbortController().signal } as never)).rejects.toThrow()
  })

  it('notify executor formats payloads for chat webhooks', async () => {
    const ex = createExecutors({ kernelTarget: () => ({ provider: 'p', model: 'm' }), defaultCwd: () => '/', outbound: policy, script: { timeoutMs: 1000, maxHeapMb: 32 }, kernelTimeoutMs: 1000 })
    const ctx = { run: { id: 'r', workflowName: 'w' }, node: { id: 'n', name: 'n' }, scope: scope({}), signal: new AbortController().signal, trace: () => undefined } as never
    for (const [format, expected] of [
      ['slack', { text: 'hi' }],
      ['discord', { content: 'hi' }],
      ['feishu', { msg_type: 'text', content: { text: 'hi' } }],
      ['wecom', { msgtype: 'text', text: { content: 'hi' } }],
    ] as const) {
      expect(await ex.notify({ url: `${base}/ok`, format, message: 'hi' }, ctx)).toEqual({ output: { delivered: true, status: 200 } })
      expect(JSON.parse(seen.at(-1)!.body)).toEqual(expected)
    }
    await ex.notify({ url: `${base}/ok` }, ctx)
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ event: 'lulux-flow.notify', workflow: 'w', runId: 'r' })
    await expect(ex.notify({ url: `${base}/fail` }, ctx)).rejects.toThrow(/notification failed/)
  })

  it('kernel and agent executors refuse when the service is missing or the CLI is disabled', async () => {
    const ex = createExecutors({ kernelTarget: () => ({ provider: 'p', model: 'm' }), defaultCwd: () => '/', outbound: policy, script: { timeoutMs: 1000, maxHeapMb: 32 }, kernelTimeoutMs: 1000 })
    const ctx = { run: { id: 'r', workflowName: 'w' }, node: { id: 'n', name: 'n' }, scope: scope({}), signal: new AbortController().signal, trace: () => undefined } as never
    await expect(ex.kernel({ kernel: 'codex', prompt: 'p' }, ctx)).rejects.toThrow(/kernel service unavailable/)
    await expect(ex.agent({ prompt: 'p' }, ctx)).rejects.toThrow(/agents are not available/)
    const disabled = createExecutors({
      kernels: { require: () => findKernel('codex')!, settingsOf: () => ({ enabled: false, mode: 'scoped', permission: 'read-only', binaryPath: '' }) } as never,
      kernelTarget: () => ({ provider: 'p', model: 'm' }),
      defaultCwd: () => '/',
      outbound: policy,
      script: { timeoutMs: 1000, maxHeapMb: 32 },
      kernelTimeoutMs: 1000,
    })
    await expect(disabled.kernel({ kernel: 'codex', prompt: 'p' }, ctx)).rejects.toThrow(/disabled/)
  })
})

describe('kernel adapters cannot write outside their home', () => {
  it('uses a separator-aware join', async () => {
    const { KernelRunner } = await import('../../src/kernels/runner.js')
    const { TokenStore } = await import('../../src/gateway/tokens.js')
    const dir = tempDir()
    const fake = join(dir, 'cli.mjs')
    writeFileSync(fake, '#!/usr/bin/env node\n')
    chmodSync(fake, 0o755)
    const runner = new KernelRunner({ tokens: new TokenStore(), gatewayUrl: () => 'http://127.0.0.1:1', runsRoot: join(dir, 'tmp'), installRoot: dir, approvalBridge: false, resolve: () => ({ command: process.execPath, prefixArgs: [fake], source: 'settings', file: fake }) })
    const evil = { ...findKernel('qwen-code')!, launch: () => ({ args: [], env: {}, files: { '../escape.txt': 'x' }, promptVia: 'stdin' as const }) }
    await expect(runner.run({ kernel: evil, prompt: 'p', cwd: dir, mode: 'scoped', permission: 'read-only', target: { provider: 'p', model: 'm' }, runId: 'r', timeoutMs: 5000 })).rejects.toThrow(/outside its home/)
  })
})
