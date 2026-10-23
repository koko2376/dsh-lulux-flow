/**
 * Windows and Electron (DSH Desktop) process launching: npm shims, native
 * CLI binaries and their placeholders, the Node runtime used for JavaScript
 * entries, PATH/PATHEXT handling, install-script launchers and tree kill.
 * Shim texts are exactly what npm's cmd-shim writes (with CRLF line ends).
 */
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanOverridePath, fromPath, isNodeScript, nativeProblem, resolveBinary, resolveCmdShim, windowsExtensions } from '../../src/kernels/binary.js'
import { findKernel } from '../../src/kernels/catalog.js'
import { prependPath, resolveNpm, writeNodeLauncher } from '../../src/kernels/installer.js'
import { taskkillPath } from '../../src/kernels/kill.js'
import { detectNodeRuntime, electronFuseFile, findNodeOnPath, readRunAsNodeFuse, splitPath } from '../../src/kernels/node-runtime.js'
import { KernelRunner } from '../../src/kernels/runner.js'
import { TokenStore } from '../../src/gateway/tokens.js'
import { renameWithRetry } from '../../src/util/fs.js'
import { runScript } from '../../src/workflow/script.js'
import { tempDir } from '../helpers.js'

const crlf = (lines: string[]): string => `${lines.join('\r\n')}\r\n`

/** npm cmd-shim output for a bin that is a Node script. */
const NODE_SCRIPT_SHIM = crlf([
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
])

/** npm cmd-shim output for a bin that is a native executable. */
const NATIVE_SHIM = crlf(['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*'])

/** The shape of the placeholder `bin/claude.exe` Claude Code ships until its postinstall copies the real binary over it. */
const PLACEHOLDER = 'echo "Error: native binary not installed." >&2\nexit 1\n'

const PE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])

describe('npm .cmd shims (real cmd-shim output)', () => {
  it('a Node-script shim resolves to the script, not to the node.exe it tests for (nvm-windows, Volta, prefix = Node dir)', () => {
    const dir = tempDir()
    const entry = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    mkdirSync(join(entry, '..'), { recursive: true })
    writeFileSync(entry, '#!/usr/bin/env node\n')
    writeFileSync(join(dir, 'node.exe'), PE)
    writeFileSync(join(dir, 'codex.cmd'), NODE_SCRIPT_SHIM)
    expect(resolveCmdShim(join(dir, 'codex.cmd'), { npmPackage: '@openai/codex', bin: 'codex' })).toEqual({ file: entry, kind: 'node' })
  })
  it('a native shim resolves to the exe', () => {
    const dir = tempDir()
    const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    mkdirSync(join(exe, '..'), { recursive: true })
    writeFileSync(exe, PE)
    writeFileSync(join(dir, 'claude.cmd'), NATIVE_SHIM)
    expect(resolveCmdShim(join(dir, 'claude.cmd'), { npmPackage: '@anthropic-ai/claude-code', bin: 'claude' })).toEqual({ file: exe, kind: 'native' })
  })
})

describe('native entries and placeholders', () => {
  it('flags the uninstalled placeholder and accepts real images and scripts', () => {
    const dir = tempDir()
    const stub = join(dir, 'claude.exe')
    writeFileSync(stub, PLACEHOLDER)
    expect(nativeProblem(stub, 'win32')).toMatch(/placeholder/)
    expect(nativeProblem(stub, 'linux')).toMatch(/placeholder/)
    writeFileSync(stub, PE)
    expect(nativeProblem(stub, 'win32')).toBeUndefined()
    writeFileSync(stub, ELF)
    expect(nativeProblem(stub, 'linux')).toBeUndefined()
    writeFileSync(stub, '#!/bin/sh\nexec x\n')
    expect(nativeProblem(stub, 'linux')).toBeUndefined()
    expect(nativeProblem(stub, 'darwin', Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))).toBeUndefined()
  })
  it('a managed install whose postinstall did not run reports why instead of spawning the placeholder', () => {
    const root = tempDir()
    const def = findKernel('claude-code')!
    const pkg = join(root, def.id, 'node_modules', '@anthropic-ai', 'claude-code')
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '2.1.309', bin: { claude: 'bin/claude.exe' } }))
    writeFileSync(join(pkg, 'bin', 'claude.exe'), PLACEHOLDER)
    const resolved = resolveBinary(def, { installRoot: root, envPath: '' })
    expect(resolved?.source).toBe('managed')
    expect(resolved?.problem).toMatch(/placeholder/)
  })
  it('classifies by the first bytes only (multi-hundred-MB binaries are never read whole)', () => {
    const dir = tempDir()
    const big = join(dir, 'grok')
    writeFileSync(big, Buffer.concat([ELF, Buffer.alloc(8 * 1024 * 1024)]))
    expect(isNodeScript(big)).toBe(false)
    writeFileSync(big, '#!/usr/bin/env node\nrequire("./x")\n')
    expect(isNodeScript(big)).toBe(true)
  })
})

describe('Node runtime for JavaScript entries', () => {
  const base = { execPath: '/apps/DSH Desktop/DSH Desktop', nodeVersion: '22.20.0', platform: 'linux' as const }
  it('plain Node runs scripts itself', () => {
    expect(detectNodeRuntime({ ...base, electron: undefined, execPath: '/usr/bin/node' })).toEqual({ ok: true, runtime: { command: '/usr/bin/node', via: 'self', version: '22.20.0' } })
  })
  it('inside Electron a real Node.js >= 20 on PATH wins; older ones are skipped', () => {
    const result = detectNodeRuntime({ ...base, electron: '38.2.0', findNode: () => ['/old/node', '/usr/local/bin/node'], nodeVersionOf: f => (f === '/old/node' ? '18.20.0' : '22.21.0'), fuse: () => 'enabled' })
    expect(result).toEqual({ ok: true, runtime: { command: '/usr/local/bin/node', via: 'path', version: '22.21.0' } })
  })
  it('without Node.js on PATH the app runs as Node, unless its RunAsNode fuse is off', () => {
    const none = { ...base, electron: '38.2.0', findNode: () => [], nodeVersionOf: () => undefined }
    expect(detectNodeRuntime({ ...none, fuse: () => 'enabled' })).toMatchObject({ ok: true, runtime: { command: base.execPath, via: 'electron' } })
    expect(detectNodeRuntime({ ...none, fuse: () => 'unknown' })).toMatchObject({ ok: true, runtime: { via: 'electron' } })
    const off = detectNodeRuntime({ ...none, fuse: () => 'disabled' })
    expect(off.ok).toBe(false)
    expect(off.ok ? '' : off.problem).toMatch(/Install Node\.js 22/)
    // a host that itself runs with ELECTRON_RUN_AS_NODE=1 proves the fuse is on
    expect(detectNodeRuntime({ ...none, fuse: () => 'disabled', runAsNodeEnv: '1' })).toMatchObject({ ok: true, runtime: { via: 'electron' } })
  })
  it('reads the RunAsNode fuse from the binary, including a sentinel across a chunk boundary', () => {
    const dir = tempDir()
    const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
    const file = join(dir, 'app.exe')
    const wire = (runAsNode: string): Buffer => Buffer.concat([Buffer.from([1, 9]), Buffer.from(`${runAsNode}10100000`)])
    writeFileSync(file, Buffer.concat([Buffer.alloc(1000), sentinel, wire('0')]))
    expect(readRunAsNodeFuse(file)).toBe('disabled')
    writeFileSync(file, Buffer.concat([Buffer.alloc(4 * 1024 * 1024 - 10), sentinel, wire('1')]))
    expect(readRunAsNodeFuse(file)).toBe('enabled')
    writeFileSync(file, Buffer.alloc(2048))
    expect(readRunAsNodeFuse(file)).toBe('unknown')
    expect(readRunAsNodeFuse(join(dir, 'missing'))).toBe('unknown')
    if (process.platform !== 'win32') expect(electronFuseFile('/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop')).toBe('/Applications/DSH Desktop.app/Contents/Frameworks/Electron Framework.framework/Electron Framework')
    expect(electronFuseFile('C:\\Users\\1\\AppData\\Local\\Programs\\DSH Desktop\\DSH Desktop.exe')).toBe('C:\\Users\\1\\AppData\\Local\\Programs\\DSH Desktop\\DSH Desktop.exe')
  })
  it('finds node on PATH entries with quotes, spaces and non-ASCII characters', () => {
    const dir = join(tempDir(), '用户 1', 'nodejs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'node.exe'), PE)
    expect(splitPath(`"${dir}";;C:\\Windows`, 'win32')).toEqual([dir, 'C:\\Windows'])
    expect(findNodeOnPath(`"${dir}"`, 'win32', {})).toEqual([join(dir, 'node.exe')])
  })
  it('script nodes never spawn the app when there is no runtime', async () => {
    await expect(runScript('return 1', null, { timeoutMs: 1000, maxHeapMb: 32, runtime: { ok: false, problem: 'no Node.js' } })).rejects.toThrow(/script nodes need Node\.js: no Node\.js/)
  })
})

describe('PATH lookup on Windows', () => {
  it('follows PATHEXT, skips the extensionless sh shim, and prefers the .cmd entry', () => {
    const root = tempDir()
    const first = join(root, 'Git', 'usr', 'bin')
    const npmDir = join(root, 'Roaming', 'npm')
    mkdirSync(first, { recursive: true })
    const exe = join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    mkdirSync(join(exe, '..'), { recursive: true })
    writeFileSync(exe, PE)
    for (const file of [join(first, 'claude'), join(npmDir, 'claude'), join(npmDir, 'claude.cmd')]) {
      writeFileSync(file, file.endsWith('.cmd') ? NATIVE_SHIM : '#!/bin/sh\nexec x "$@"\n')
      chmodSync(file, 0o755)
    }
    const found = fromPath({ npmPackage: '@anthropic-ai/claude-code', bin: 'claude' }, `${first};${npmDir}`, 'win32', { PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' })
    expect(found).toMatchObject({ command: exe, prefixArgs: [], file: join(npmDir, 'claude.cmd'), source: 'path' })
    expect(found?.problem).toBeUndefined()
  })
  it('keeps only startable PATHEXT kinds, in order', () => {
    expect(windowsExtensions('.EXE;.CMD;.VBS;.PS1')).toEqual(['.exe', '.cmd'])
    expect(windowsExtensions(undefined)).toEqual(['.com', '.exe', '.bat', '.cmd'])
  })
  it('accepts a settings path pasted with quotes ("Copy as path")', () => {
    expect(cleanOverridePath('  "C:\\Program Files\\Claude\\claude.exe" ')).toBe('C:\\Program Files\\Claude\\claude.exe')
    const dir = tempDir()
    const script = join(dir, 'my cli.mjs')
    writeFileSync(script, 'console.log("1.0.0")\n')
    chmodSync(script, 0o755)
    expect(resolveBinary(findKernel('codex')!, { installRoot: dir, overridePath: `"${script}"` })).toMatchObject({ file: script, prefixArgs: [script], source: 'settings' })
  })
  it('taskkill is called by its full path', () => {
    expect(taskkillPath({ SystemRoot: 'C:\\Windows' })).toBe(join('C:\\Windows', 'System32', 'taskkill.exe'))
    expect(taskkillPath({})).toBe('taskkill')
  })
})

describe('npm and install scripts', () => {
  // POSIX layout with a symlinked `npm`; Windows needs extra privileges to create symlinks
  it.skipIf(process.platform === 'win32')('runs npm through its JS entry with the Node runtime', () => {
    const dir = realpathSync(tempDir())
    const cli = join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    mkdirSync(join(cli, '..'), { recursive: true })
    writeFileSync(cli, '#!/usr/bin/env node\n')
    mkdirSync(join(dir, 'bin'))
    symlinkSync(cli, join(dir, 'bin', 'npm'))
    const runtime = { ok: true as const, runtime: { command: '/opt/node/bin/node', via: 'path' as const } }
    expect(resolveNpm(runtime, join(dir, 'bin'), 'linux')).toMatchObject({ command: '/opt/node/bin/node', prefixArgs: [cli] })
    expect(resolveNpm({ ok: false, problem: 'x' }, join(dir, 'bin'), 'linux')).toBeUndefined()
  })
  it('gives install scripts a `node` when the runtime is the app run as Node', () => {
    const dir = tempDir()
    writeNodeLauncher(dir, 'win32')
    expect(readFileSync(join(dir, 'node.cmd'), 'utf8')).toBe('@SET ELECTRON_RUN_AS_NODE=1\r\n@"%npm_node_execpath%" %*\r\n')
    writeNodeLauncher(dir, 'linux')
    expect(readFileSync(join(dir, 'node'), 'utf8')).toContain('exec "$npm_node_execpath" "$@"')
    expect(prependPath({ Path: 'C:\\Windows' }, 'D:\\l', 'win32')).toEqual({ Path: 'D:\\l;C:\\Windows' })
    expect(prependPath({}, '/l', 'linux')).toEqual({ PATH: '/l' })
  })
})

describe('kernel runner preflight', () => {
  const runner = (problem?: string) =>
    new KernelRunner({
      tokens: new TokenStore(),
      gatewayUrl: () => 'http://127.0.0.1:1',
      runsRoot: join(tempDir(), 'runs'),
      installRoot: tempDir(),
      approvalBridge: false,
      resolve: () => ({ command: '/bin/false', prefixArgs: [], source: 'path', file: '/bin/false', ...(problem !== undefined ? { problem } : {}) }),
    })
  const request = { kernel: findKernel('codex')!, prompt: 'x', mode: 'global' as const, permission: 'read-only' as const, target: { provider: 'native', model: 'default' }, runId: 'r', timeoutMs: 5000 }
  it('reports a binary that cannot be started without spawning it', async () => {
    const result = await runner('no Node.js').run({ ...request, cwd: tempDir() })
    expect(result).toMatchObject({ status: 'error', diagnostic: 'Codex cannot be started: no Node.js' })
  })
  it('reports a missing working directory as such, not as a missing CLI', async () => {
    const result = await runner().run({ ...request, cwd: join(tempDir(), 'gone') })
    expect(result.diagnostic).toMatch(/working directory does not exist/)
  })
})

describe('atomic writes on Windows', () => {
  it('retry a rename that another process briefly blocks', () => {
    let calls = 0
    renameWithRetry('a', 'b', () => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' })
    })
    expect(calls).toBe(3)
    expect(() => renameWithRetry('a', 'b', () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) })).toThrow('gone')
  })
})
