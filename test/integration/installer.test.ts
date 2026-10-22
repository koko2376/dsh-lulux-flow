/**
 * Kernel installer against fake npm registries.
 *
 * Two local HTTP registries: a "canonical" one (stands in for
 * registry.npmjs.org) serving the real package, and a hostile "mirror" that
 * advertises the same metadata and integrity but serves a tampered tarball
 * whose install script would write a marker file. The tampered tarball must
 * be rejected before any script runs, the install must fall back to the
 * canonical tarball, only the kernel package's own script may run, and the
 * installer must refuse when the canonical registry is down.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findKernel } from '../../src/kernels/catalog.js'
import { checkLockfile, KernelInstaller, resolveNpm, retargetLockfile, type InstallState } from '../../src/kernels/installer.js'
import { RegistrySelector } from '../../src/kernels/registry-probe.js'
import type { KernelDefinition } from '../../src/kernels/types.js'
import { tempDir } from '../helpers.js'

const npm = resolveNpm()
const root = tempDir('lf-registry-')
const markers = join(root, 'markers')
mkdirSync(markers, { recursive: true })

interface Tarball {
  data: Buffer
  integrity: string
  shasum: string
}

function pack(name: string, files: Record<string, string>, pkg: Record<string, unknown>): Tarball {
  const dir = join(root, 'src', `${name}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }))
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content)
  const out = execFileSync(npm!.command, [...npm!.prefixArgs, 'pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: dir, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(root, 'pack-cache') } })
  const filename = (JSON.parse(out) as Array<{ filename: string }>)[0]!.filename
  const data = readFileSync(join(dir, filename))
  return { data, integrity: `sha512-${createHash('sha512').update(data).digest('base64')}`, shasum: createHash('sha1').update(data).digest('hex') }
}

const writeMarker = (file: string) => `require('fs').writeFileSync(${JSON.stringify(join(markers, file))}, 'x')\n`

let good: Tarball
let tampered: Tarball
let dep: Tarball

function registry(serve: (name: string) => Tarball, base: () => string): Server {
  return createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '/')
    const tarball = /^\/(lf-fake-(?:cli|dep))\/-\/.+\.tgz$/.exec(url)
    if (tarball) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(serve(tarball[1]!).data)
      return
    }
    const meta = /^\/(lf-fake-(?:cli|dep))(\/latest)?$/.exec(url)
    if (!meta) return res.writeHead(404).end('{}')
    const name = meta[1]!
    // Metadata always advertises the genuine integrity (a hostile mirror would too, to pass the probe).
    const real = name === 'lf-fake-cli' ? good : dep
    const version = {
      name,
      version: '1.0.0',
      ...(name === 'lf-fake-cli' ? { bin: { 'lf-fake-cli': 'cli.js' }, dependencies: { 'lf-fake-dep': '1.0.0' }, scripts: { postinstall: 'node post.js' } } : { scripts: { postinstall: 'node post.js' } }),
      dist: { tarball: `${base()}/${name}/-/${name}-1.0.0.tgz`, integrity: real.integrity, shasum: real.shasum },
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(meta[2] ? version : { name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } }))
  })
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const def: KernelDefinition = { ...findKernel('qwen-code')!, id: 'fake-cli', name: 'Fake CLI', npmPackage: 'lf-fake-cli', bin: 'lf-fake-cli', minVersion: '>=1.0.0' }

async function install(options: { canonical: string; mirrors: string[]; trustMirror?: boolean; viaSymlink?: boolean }): Promise<InstallState & { dir: string }> {
  let dir = tempDir('lf-install-')
  if (options.viaSymlink === true) {
    // the data dir reached through a link, like /var -> /private/var on macOS
    const link = `${dir}-link`
    symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
    dir = link
  }
  process.env.npm_config_cache = join(dir, 'cache') // fresh cache: nothing can be served from an earlier test
  const selector = new RegistrySelector({ candidates: () => options.mirrors, override: () => undefined, ttlMs: 1000, timeoutMs: 3000, canonical: options.canonical })
  const installer = new KernelInstaller({ installRoot: join(dir, 'kernels'), selector, timeoutMs: 120_000, canonicalRegistry: options.canonical, fetchRetries: 0, trustMirror: () => options.trustMirror === true })
  installer.install(def)
  for (;;) {
    const state = installer.state(def.id)
    if (state.status === 'installed' || state.status === 'error') return { ...state, dir: join(dir, 'kernels', def.id) }
    await new Promise(r => setTimeout(r, 100))
  }
}

describe.skipIf(npm === undefined)('kernel installer (fake registries)', () => {
  const servers: Server[] = []
  let canonical = ''
  let hostileMirror = ''
  let honestMirror = ''
  beforeAll(async () => {
    dep = pack('lf-fake-dep', { 'post.js': writeMarker('dep-ran') }, { scripts: { postinstall: 'node post.js' } })
    good = pack('lf-fake-cli', { 'cli.js': '#!/usr/bin/env node\nconsole.log("1.0.0")\n', 'post.js': "require('fs').writeFileSync(require('path').join(__dirname, 'postinstall-ran'), String(process.env.OPENAI_API_KEY) + ' ' + String(process.env.LF_TEST_SECRET_TOKEN))\n" }, { bin: { 'lf-fake-cli': 'cli.js' }, dependencies: { 'lf-fake-dep': '1.0.0' }, scripts: { postinstall: 'node post.js' } })
    tampered = pack('lf-fake-cli', { 'cli.js': '#!/usr/bin/env node\nconsole.log("evil")\n', 'post.js': writeMarker('pwned') }, { bin: { 'lf-fake-cli': 'cli.js' }, dependencies: { 'lf-fake-dep': '1.0.0' }, scripts: { preinstall: 'node post.js', postinstall: 'node post.js' } })
    const c = registry(name => (name === 'lf-fake-cli' ? good : dep), () => canonical)
    const h = registry(name => (name === 'lf-fake-cli' ? tampered : dep), () => hostileMirror)
    const o = registry(name => (name === 'lf-fake-cli' ? good : dep), () => honestMirror)
    servers.push(c, h, o)
    canonical = await listen(c)
    hostileMirror = await listen(h)
    honestMirror = await listen(o)
  }, 60_000)
  afterAll(() => {
    for (const s of servers) s.close()
    delete process.env.npm_config_cache
  })

  it('rejects a tampered tarball from a mirror before any script runs, then installs the verified package', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-leak'
    process.env.LF_TEST_SECRET_TOKEN = 'also-not'
    let state: Awaited<ReturnType<typeof install>>
    try {
      state = await install({ canonical, mirrors: [hostileMirror] })
    } finally {
      delete process.env.OPENAI_API_KEY
      delete process.env.LF_TEST_SECRET_TOKEN
    }
    const log = state.log.join('\n')
    expect(state.status, log).toBe('installed')
    expect(log).toMatch(new RegExp(`install from ${hostileMirror.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed`))
    expect(log).toMatch(/EINTEGRITY|integrity/i)
    expect(existsSync(join(markers, 'pwned'))).toBe(false)
    // only the kernel package's own install script ran; the dependency's did not
    expect(existsSync(join(state.dir, 'node_modules', 'lf-fake-cli', 'postinstall-ran'))).toBe(true)
    // the package's install script ran with the allowlisted environment: no provider keys
    expect(readFileSync(join(state.dir, 'node_modules', 'lf-fake-cli', 'postinstall-ran'), 'utf8')).toBe('undefined undefined')
    expect(existsSync(join(markers, 'dep-ran'))).toBe(false)
    expect(readFileSync(join(state.dir, 'node_modules', 'lf-fake-cli', 'cli.js'), 'utf8')).toContain('"1.0.0"')
    const lock = JSON.parse(readFileSync(join(state.dir, 'package-lock.json'), 'utf8')) as { packages: Record<string, { integrity: string; resolved: string }> }
    expect(lock.packages['node_modules/lf-fake-cli']!.integrity).toBe(good.integrity)
    expect(lock.packages['node_modules/lf-fake-dep']!.resolved.startsWith(canonical)).toBe(true)
  }, 120_000)

  it('installs from an honest mirror when it is first in line', async () => {
    const state = await install({ canonical, mirrors: [honestMirror] })
    expect(state.status, state.log.join('\n')).toBe('installed')
    expect(state.log.join('\n')).toContain(`installed lf-fake-cli@1.0.0 from ${honestMirror}`)
  }, 120_000)

  it('installs when the install root is reached through a symlink', async () => {
    const state = await install({ canonical, mirrors: [honestMirror], viaSymlink: true })
    expect(state.status, state.log.join('\n')).toBe('installed')
    expect(existsSync(join(state.dir, 'node_modules', 'lf-fake-cli', 'cli.js'))).toBe(true)
  }, 120_000)

  it('refuses when the canonical registry is unreachable, unless "trust mirror" is on', async () => {
    const down = 'http://127.0.0.1:9'
    const refused = await install({ canonical: down, mirrors: [honestMirror] })
    expect(refused.status).toBe('error')
    expect(refused.error).toMatch(/could not be reached.*trust mirror/)
    const trusted = await install({ canonical: down, mirrors: [honestMirror], trustMirror: true })
    expect(trusted.status, trusted.log.join('\n')).toBe('installed')
    expect(trusted.log.join('\n')).toMatch(/WARNING: .* "trust mirror" is on/)
  }, 120_000)
})

describe('lockfile helpers', () => {
  it('requires sha512 integrity from the expected registry, and retargets only the host', () => {
    const lock = { packages: { '': {}, 'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.tgz', integrity: 'sha512-x' } } }
    expect(checkLockfile(lock, 'https://registry.npmjs.org')).toBeUndefined()
    expect(checkLockfile({ packages: { 'node_modules/a': { resolved: 'https://evil/a.tgz', integrity: 'sha512-x' } } }, 'https://registry.npmjs.org')).toMatch(/does not resolve/)
    expect(checkLockfile({ packages: { 'node_modules/a': { resolved: 'https://registry.npmjs.org/a.tgz', integrity: 'sha1-x' } } }, 'https://registry.npmjs.org')).toMatch(/sha512/)
    const moved = retargetLockfile(lock, 'https://registry.npmjs.org', 'https://mirrors.cloud.tencent.com/npm')
    expect(moved.packages!['node_modules/a']).toEqual({ resolved: 'https://mirrors.cloud.tencent.com/npm/a/-/a-1.tgz', integrity: 'sha512-x' })
    expect(lock.packages['node_modules/a'].resolved).toBe('https://registry.npmjs.org/a/-/a-1.tgz')
  })
  it('refuses http registries except loopback', async () => {
    const { normalizeRegistry } = await import('../../src/kernels/registry-probe.js')
    expect(() => normalizeRegistry('http://registry.example.com')).toThrow(/https/)
    expect(normalizeRegistry('http://127.0.0.1:4873/')).toBe('http://127.0.0.1:4873')
    expect(() => normalizeRegistry('https://u:p@r.example.com')).toThrow(/credentials/)
  })
})
