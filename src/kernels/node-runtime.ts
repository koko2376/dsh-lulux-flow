/**
 * Which executable runs a JavaScript entry (a CLI's `bin/*.js`, npm, script
 * nodes).
 *
 * Under plain Node that is the current process (`process.execPath`). Inside
 * DSH Desktop, `process.execPath` is the Electron app itself: spawning it
 * without ELECTRON_RUN_AS_NODE=1 opens a second app window, and when the app
 * was built with the `RunAsNode` fuse turned off, the variable is ignored and
 * a window opens anyway. So inside Electron:
 *
 * 1. a real Node.js (>= 20) on PATH is preferred: CLIs and their native
 *    addons are built and tested against it;
 * 2. otherwise the app is run as Node (ELECTRON_RUN_AS_NODE=1), but only when
 *    its `RunAsNode` fuse is not disabled;
 * 3. otherwise there is no runtime, and callers report why instead of
 *    spawning anything.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { scopedBaseEnv } from './env.js'

export interface NodeRuntime {
  /** Executable to spawn with the script path as its first argument. */
  command: string
  /** `self`: plain Node host; `path`: Node.js found on PATH; `electron`: the Electron app run as Node. */
  via: 'self' | 'path' | 'electron'
  /** `x.y.z`, when known. */
  version?: string
}

export type NodeRuntimeResult = { ok: true; runtime: NodeRuntime } | { ok: false; problem: string }

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
const FUSE_DISABLED = 0x30
const MIN_PATH_NODE_MAJOR = 20

/** The file that carries Electron's fuse wire: the executable, or on macOS the framework binary. */
export function electronFuseFile(execPath: string): string {
  if (/\.app[\\/]Contents[\\/]MacOS[\\/]/.test(execPath)) return resolve(execPath, '..', '..', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')
  return execPath
}

/**
 * State of Electron's `RunAsNode` fuse: `enabled`, `disabled`, or `unknown`
 * (no fuse wire found, e.g. Electron < 12, or the file is unreadable). Scans
 * the binary in chunks; it is never read whole.
 */
export function readRunAsNodeFuse(file: string): 'enabled' | 'disabled' | 'unknown' {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const size = statSync(file).size
    const chunk = 4 * 1024 * 1024
    const overlap = FUSE_SENTINEL.length + 3
    const buf = Buffer.allocUnsafe(chunk + overlap)
    for (let start = 0; start < size; start += chunk) {
      const read = readSync(fd, buf, 0, Math.min(chunk + overlap, size - start), start)
      const at = buf.subarray(0, read).indexOf(FUSE_SENTINEL)
      if (at < 0) continue
      const wire = Buffer.alloc(3)
      readSync(fd, wire, 0, 3, start + at + FUSE_SENTINEL.length)
      // [wire version][wire length][fuse 0 = RunAsNode]...
      if (wire[1] === undefined || wire[1] < 1) return 'unknown'
      return wire[2] === FUSE_DISABLED ? 'disabled' : 'enabled'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Directories searched for a real `node` besides PATH. */
function extraNodeDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return [env.ProgramFiles ?? env.PROGRAMFILES, env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]
      .filter((dir): dir is string => Boolean(dir))
      .map(dir => join(dir, 'nodejs'))
  }
  return ['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.volta', 'bin')]
}

/** Split PATH the way the platform does, dropping empty entries and surrounding quotes. */
export function splitPath(value: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  return (value ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

/** Every `node` executable on PATH (then the usual install locations), in order. */
export function findNodeOnPath(envPath: string | undefined, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string[] {
  const name = platform === 'win32' ? 'node.exe' : 'node'
  const out: string[] = []
  for (const dir of [...splitPath(envPath, platform), ...extraNodeDirs(platform, env)]) {
    const file = join(dir, name)
    if (!out.includes(file) && exists(file)) out.push(file)
  }
  return out
}

function probeNodeVersion(file: string): string | undefined {
  try {
    const out = execFileSync(file, ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8', env: scopedBaseEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
    return /v?(\d+\.\d+\.\d+)/.exec(out)?.[1]
  } catch {
    return undefined
  }
}

export interface NodeRuntimeProbe {
  electron?: string | undefined
  execPath: string
  nodeVersion: string
  envPath?: string | undefined
  platform?: NodeJS.Platform
  /** Set when the host itself already runs as Node inside Electron. */
  runAsNodeEnv?: string | undefined
  findNode?: () => string[]
  nodeVersionOf?: (file: string) => string | undefined
  fuse?: (file: string) => 'enabled' | 'disabled' | 'unknown'
}

/** Pure decision (all inputs injectable for tests). */
export function detectNodeRuntime(probe: NodeRuntimeProbe): NodeRuntimeResult {
  if (probe.electron === undefined) return { ok: true, runtime: { command: probe.execPath, via: 'self', version: probe.nodeVersion } }
  const platform = probe.platform ?? process.platform
  const candidates = probe.findNode?.() ?? findNodeOnPath(probe.envPath, platform)
  const versionOf = probe.nodeVersionOf ?? probeNodeVersion
  for (const file of candidates) {
    if (resolve(file) === resolve(probe.execPath)) continue
    const version = versionOf(file)
    if (version !== undefined && Number(version.split('.')[0]) >= MIN_PATH_NODE_MAJOR) return { ok: true, runtime: { command: file, via: 'path', version } }
  }
  const fuse = probe.runAsNodeEnv === '1' ? 'enabled' : (probe.fuse ?? readRunAsNodeFuse)(electronFuseFile(probe.execPath))
  if (fuse !== 'disabled') return { ok: true, runtime: { command: probe.execPath, via: 'electron', version: probe.nodeVersion } }
  return {
    ok: false,
    problem: `DSH Desktop cannot run Node.js programs itself (its RunAsNode fuse is off) and no Node.js ${MIN_PATH_NODE_MAJOR}+ was found on PATH. Install Node.js 22 or later from nodejs.org, then restart DSH.`,
  }
}

let cached: { key: string; result: NodeRuntimeResult } | undefined

/** The runtime for JavaScript entries in this process (cached; PATH changes are picked up). */
export function nodeRuntime(): NodeRuntimeResult {
  const key = `${process.execPath}\0${process.env.PATH ?? ''}`
  if (cached?.key === key) return cached.result
  const result = detectNodeRuntime({
    electron: process.versions.electron,
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    envPath: process.env.PATH,
    runAsNodeEnv: process.env.ELECTRON_RUN_AS_NODE,
  })
  cached = { key, result }
  return result
}

/** Forget the cached runtime (tests; after the user installs Node.js). */
export function resetNodeRuntime(): void {
  cached = undefined
}

/** Directory of the runtime's own executable (where a bundled npm lives). */
export function runtimeDir(runtime: NodeRuntime): string {
  return dirname(runtime.command)
}
