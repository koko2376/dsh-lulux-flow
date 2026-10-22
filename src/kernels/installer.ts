/**
 * Installs kernels into a LULUX Flow-managed directory (`<dataDir>/kernels/<id>`),
 * never globally.
 *
 * Supply-chain design (every tarball is checked, no script runs before that):
 * 1. Resolve the full dependency tree against the canonical registry
 *    (registry.npmjs.org) with `npm install --package-lock-only
 *    --ignore-scripts`. Only metadata is fetched; the lockfile pins every
 *    package, including per-platform optional binary packages, to an
 *    integrity hash from npmjs.org.
 * 2. Point the lockfile's tarball URLs at the fastest mirror and run
 *    `npm ci --ignore-scripts`. npm checks every tarball against the
 *    lockfile integrity, so a mirror can make the install fail but cannot
 *    change what gets installed.
 * 3. Run lifecycle scripts for the kernel package only (`npm rebuild <pkg>`),
 *    after every file has been verified.
 *
 * When npmjs.org cannot be reached the install is refused, unless the user
 * turned on "trust mirror" in settings (then the mirror's own metadata is
 * used for the lockfile, and the log says so).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { redact } from '../util/redact.js'
import { readManagedPackage, resolveCmdShim } from './binary.js'
import { CANONICAL_REGISTRY, normalizeRegistry, type RankedRegistries, type RegistrySelector } from './registry-probe.js'
import type { KernelDefinition } from './types.js'
import { npmBaseEnv } from './env.js'

export type InstallStatus = 'idle' | 'probing' | 'installing' | 'installed' | 'error'

export interface InstallState {
  kernelId: string
  status: InstallStatus
  registry?: string
  version?: string
  log: string[]
  error?: string
  startedAt?: number
  finishedAt?: number
  probe?: RankedRegistries
}

const MAX_LOG_LINES = 200

export interface NpmCommand {
  command: string
  prefixArgs: string[]
  description: string
}

/**
 * npm's CLI entry, run with the current Node. On Windows `npm.cmd` cannot be
 * spawned without a shell (CVE-2024-27980), so its JS entry is resolved.
 */
export function resolveNpm(): NpmCommand | undefined {
  const nodeDir = dirname(process.execPath)
  const candidates = [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  for (const file of candidates) if (existsSync(file)) return { command: process.execPath, prefixArgs: [file], description: `npm bundled with ${process.execPath}` }
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH ?? '').split(';').filter(Boolean)) {
      const shim = join(dir, 'npm.cmd')
      if (!existsSync(shim)) continue
      const direct = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      const entry = existsSync(direct) ? direct : resolveCmdShim(shim, { npmPackage: 'npm', bin: 'npm' })
      if (entry !== undefined) return { command: process.execPath, prefixArgs: [entry], description: `npm from ${dir}` }
    }
    return undefined
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, 'npm'))) return { command: join(dir, 'npm'), prefixArgs: [], description: 'npm from PATH' }
  }
  return undefined
}

interface LockFile {
  packages?: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>
}

/** Every registry package in the lockfile must carry an integrity hash and come from `registry`. */
export function checkLockfile(lock: LockFile, registry: string): string | undefined {
  const prefix = `${registry.replace(/\/+$/, '')}/`
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === '' || entry.link === true) continue
    if (typeof entry.integrity !== 'string' || !/^sha512-/.test(entry.integrity)) return `${path} has no sha512 integrity in the lockfile`
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(prefix)) return `${path} does not resolve to ${registry}`
  }
  return undefined
}

/** Copy of the lockfile whose tarball URLs point at `mirror` (integrity hashes unchanged). */
export function retargetLockfile(lock: LockFile, from: string, mirror: string): LockFile {
  const src = `${from.replace(/\/+$/, '')}/`
  const dst = `${mirror.replace(/\/+$/, '')}/`
  const copy = structuredClone(lock)
  for (const entry of Object.values(copy.packages ?? {})) {
    if (typeof entry.resolved === 'string' && entry.resolved.startsWith(src)) entry.resolved = dst + entry.resolved.slice(src.length)
  }
  return copy
}

export class KernelInstaller {
  private readonly states = new Map<string, InstallState>()
  private readonly listeners = new Set<(state: InstallState) => void>()

  constructor(
    private readonly options: {
      installRoot: string
      selector: RegistrySelector
      timeoutMs: number
      proxy?: () => string | undefined
      /** User setting: install from a mirror when the canonical registry is unreachable. */
      trustMirror?: () => boolean
      /** Canonical registry for lockfile resolution (tests point this at a fake). */
      canonicalRegistry?: string
      /** npm to run (tests). */
      npm?: NpmCommand
      /** Environment the npm steps start from (tests; default process.env). Always reduced to an allowlist. */
      env?: NodeJS.ProcessEnv
      /** npm fetch retries per tarball (default 1; an integrity mismatch is not worth many retries). */
      fetchRetries?: number
    },
  ) {}

  private get canonical(): string {
    return normalizeRegistry(this.options.canonicalRegistry ?? CANONICAL_REGISTRY)
  }

  onChange(listener: (state: InstallState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  state(kernelId: string): InstallState {
    return this.states.get(kernelId) ?? { kernelId, status: 'idle', log: [] }
  }

  private update(kernelId: string, patch: Partial<InstallState>): InstallState {
    const next = { ...this.state(kernelId), ...patch }
    this.states.set(kernelId, next)
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch {
        /* ignore */
      }
    }
    return next
  }

  private append(kernelId: string, line: string): void {
    const state = this.state(kernelId)
    const log = [...state.log, redact(line)].slice(-MAX_LOG_LINES)
    this.update(kernelId, { log })
  }

  /** Start an install in the background; returns immediately. */
  install(def: KernelDefinition, opts: { forceProbe?: boolean } = {}): InstallState {
    const current = this.state(def.id)
    if (current.status === 'probing' || current.status === 'installing') return current
    const state = this.update(def.id, { status: 'probing', log: [], startedAt: Date.now() })
    void this.run(def, opts.forceProbe === true).catch((error: unknown) => {
      this.update(def.id, { status: 'error', error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() })
    })
    return state
  }

  uninstall(def: KernelDefinition): InstallState {
    rmSync(join(this.options.installRoot, def.id), { recursive: true, force: true, maxRetries: 3 })
    return this.update(def.id, { status: 'idle', log: [`removed ${def.npmPackage}`] })
  }

  private async run(def: KernelDefinition, forceProbe: boolean): Promise<void> {
    this.append(def.id, `probing registries for ${def.npmPackage} (${def.minVersion})`)
    const probe = await this.options.selector.select(def.npmPackage, def.minVersion, forceProbe)
    for (const r of probe.results) {
      this.append(def.id, r.ok ? `  ${r.registry}: ${r.latencyMs} ms, v${r.version ?? '?'}${r.satisfies ? '' : ' (version too old — skipped)'}` : `  ${r.registry}: unreachable (${r.error ?? 'error'})`)
    }
    this.update(def.id, { probe })
    const npm = this.options.npm ?? resolveNpm()
    if (npm === undefined) throw new Error('npm was not found; install Node.js 22+ (with npm)')

    const canonical = this.canonical
    const canonicalProbe = probe.results.find(r => r.registry === canonical && r.ok && r.satisfies && r.version !== undefined)
    const mirrors = this.mirrorOrder(probe)
    let lockRegistry = canonical
    let version = canonicalProbe?.version
    if (canonicalProbe === undefined) {
      if (this.options.trustMirror?.() !== true || mirrors.length === 0) {
        throw new Error(
          `${canonical} could not be reached, so the integrity of the packages cannot be checked. Check your network or proxy, or turn on "trust mirror" in DSH-LULUX Flow settings to install from a mirror without that check.`,
        )
      }
      lockRegistry = mirrors[0]!.registry
      version = mirrors[0]!.version
      this.append(def.id, `WARNING: ${canonical} is unreachable; "trust mirror" is on, so the lockfile is resolved from ${lockRegistry} without an independent integrity check`)
    }
    if (version === undefined) throw new Error('no registry offers a compatible version')

    const target = join(this.options.installRoot, def.id)
    rmSync(target, { recursive: true, force: true, maxRetries: 3 })
    mkdirSync(target, { recursive: true, mode: 0o700 })
    // Run npm on the real path. When the directory is reached through a
    // symlink (on macOS the temp dir lives under /var -> /private/var, and a
    // data dir can be symlinked anywhere), `npm install --package-lock-only`
    // reports "up to date" and writes a lockfile without any dependencies.
    const dir = realpathSync(target)
    // npm >= 12 blocks dependency install scripts unless allowed; only this package's scripts run, in step 3.
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: `lulux-flow-kernel-${def.id}`, private: true, dependencies: { [def.npmPackage]: version }, allowScripts: { [def.npmPackage]: true } }, null, 2)}\n`,
    )

    // 1. lockfile from the canonical registry (metadata only, no scripts)
    this.update(def.id, { status: 'installing', registry: lockRegistry })
    this.append(def.id, `resolving ${def.npmPackage}@${version} and its dependencies against ${lockRegistry}`)
    if (!(await this.npm(def, npm, dir, ['install', '--package-lock-only', '--ignore-scripts', '--registry', lockRegistry]))) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`could not resolve the dependency tree from ${lockRegistry}; see the log`)
    }
    const lockFile = join(dir, 'package-lock.json')
    const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as LockFile
    const problem = checkLockfile(lock, lockRegistry)
    if (problem !== undefined) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`refusing to install: ${problem}`)
    }
    const top = lock.packages?.[`node_modules/${def.npmPackage}`]
    if (lockRegistry === canonical && probe.referenceIntegrity !== undefined && probe.referenceVersion === version && top?.integrity !== probe.referenceIntegrity) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`refusing to install: ${def.npmPackage}@${version} integrity changed between probe and resolution`)
    }
    writeFileSync(join(dir, 'package-lock.canonical.json'), JSON.stringify(lock, null, 2))

    // 2. fetch every tarball from the fastest mirror, checked against the lockfile; no scripts
    const sources = [...mirrors.map(m => m.registry).filter(r => r !== lockRegistry), lockRegistry]
    let installedFrom: string | undefined
    for (const registry of sources) {
      this.update(def.id, { registry })
      this.append(def.id, `downloading from ${registry} (every package checked against the lockfile integrity)`)
      writeFileSync(lockFile, JSON.stringify(retargetLockfile(lock, lockRegistry, registry), null, 2))
      if (await this.npm(def, npm, dir, ['ci', '--ignore-scripts', '--replace-registry-host=never', '--registry', registry])) {
        installedFrom = registry
        break
      }
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
      this.append(def.id, `install from ${registry} failed (unreachable, missing version or integrity mismatch); trying the next source`)
    }
    writeFileSync(lockFile, JSON.stringify(lock, null, 2))
    if (installedFrom === undefined) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error('npm ci failed on every registry; see the log')
    }

    // 3. lifecycle scripts of the kernel package only, after verification
    this.append(def.id, `running install scripts of ${def.npmPackage} only`)
    if (!(await this.npm(def, npm, dir, ['rebuild', def.npmPackage, '--ignore-scripts=false', '--foreground-scripts']))) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`install scripts of ${def.npmPackage} failed; see the log`)
    }
    const installed = this.installedIntegrity(def)
    if (installed !== top?.integrity) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`integrity mismatch after install: expected ${top?.integrity ?? '?'}, got ${installed ?? 'none'}`)
    }
    const installedVersion = readManagedPackage(this.options.installRoot, def)?.version
    this.append(def.id, `installed ${def.npmPackage}@${installedVersion ?? '?'} from ${installedFrom} (all packages verified against ${lockRegistry === canonical ? 'npmjs.org' : 'the trusted mirror'})`)
    this.update(def.id, { status: 'installed', ...(installedVersion !== undefined ? { version: installedVersion } : {}), finishedAt: Date.now() })
  }

  /** Reachable registries that offer a compatible version, fastest first (mirrors whose metadata matches npmjs.org ahead). */
  private mirrorOrder(probe: RankedRegistries): Array<{ registry: string; version?: string }> {
    return probe.results.filter(r => r.ok && r.satisfies).map(r => ({ registry: r.registry, ...(r.version !== undefined ? { version: r.version } : {}) }))
  }

  private installedIntegrity(def: KernelDefinition): string | undefined {
    try {
      const lock = JSON.parse(readFileSync(join(this.options.installRoot, def.id, 'node_modules', '.package-lock.json'), 'utf8')) as LockFile
      return lock.packages?.[`node_modules/${def.npmPackage}`]?.integrity
    } catch {
      return undefined
    }
  }

  private npm(def: KernelDefinition, npm: NpmCommand, dir: string, command: string[]): Promise<boolean> {
    const retries = String(this.options.fetchRetries ?? 1)
    const args = [...npm.prefixArgs, ...command, '--prefix', dir, '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel', 'warn', '--fetch-retries', retries, '--fetch-retry-mintimeout', '2000', '--fetch-retry-maxtimeout', '5000']
    // Allowlisted environment only: step 3 runs the CLI package's own install scripts.
    const env: Record<string, string> = { ...npmBaseEnv(this.options.env ?? process.env), npm_config_update_notifier: 'false' }
    const proxy = this.options.proxy?.()
    if (proxy) env.npm_config_proxy = env.npm_config_https_proxy = proxy
    // A local registry or cache on loopback never goes through a proxy.
    const noProxy = [env.NO_PROXY ?? env.no_proxy ?? '', '127.0.0.1,localhost,::1'].filter(Boolean).join(',')
    env.NO_PROXY = env.no_proxy = env.npm_config_noproxy = noProxy
    return new Promise(resolve => {
      const child = spawn(npm.command, args, { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => child.kill('SIGTERM'), this.options.timeoutMs)
      const onData = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) this.append(def.id, line.trim())
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', error => {
        clearTimeout(timer)
        this.append(def.id, `failed to start npm (${npm.description}): ${error.message}`)
        resolve(false)
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    })
  }
}
