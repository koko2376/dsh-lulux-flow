/**
 * Locate and version-check kernel executables: an explicit path from
 * settings, then the LULUX Flow-managed install directory, then PATH.
 */
import { execFile } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import type { KernelDefinition } from './types.js'
import { scopedBaseEnv } from './env.js'
import { nodeRuntime, splitPath, type NodeRuntimeResult } from './node-runtime.js'

export interface ResolvedBinary {
  /** Executable to spawn. */
  command: string
  /** Leading arguments (e.g. the JS entry when run through node). */
  prefixArgs: string[]
  source: 'settings' | 'managed' | 'path'
  file: string
  /** Windows `.cmd` shim without a resolvable JS entry: run through cmd.exe with verbatim, escaped arguments. */
  cmdShim?: boolean
  /** Found, but cannot be started (no Node.js runtime, an uninstalled native placeholder, ...). Nothing is spawned. */
  problem?: string
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform === 'win32') return true
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First bytes of a file (never the whole file: CLI binaries are hundreds of MB). */
export function readHead(file: string, bytes = 256): Buffer {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, read)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function isNodeScript(file: string): boolean {
  if (/\.(c|m)?js$/i.test(file)) return true
  return /^#!.*\bnode\b/.test(readHead(file, 128).toString('utf8').split('\n')[0] ?? '')
}

/**
 * Why a native entry cannot be executed, if it obviously cannot: on Windows
 * an `.exe` must be a PE image (`MZ`); elsewhere an ELF / Mach-O image or a
 * `#!` script. Catches placeholder files such as Claude Code's `bin/claude.exe`
 * stub, which stays a shell snippet when its postinstall did not run.
 */
export function nativeProblem(file: string, platform: NodeJS.Platform = process.platform, head: Buffer = readHead(file, 8)): string | undefined {
  if (head.length === 0) return undefined
  const magic = head.length >= 4 ? head.readUInt32BE(0) : -1
  if (platform === 'win32') {
    if (/\.exe$/i.test(file) && !(head[0] === 0x4d && head[1] === 0x5a)) return `${basename(file)} is a placeholder, not a Windows program: the package's install script did not run or its platform package is missing. Reinstall it.`
    return undefined
  }
  if (head[0] === 0x23 && head[1] === 0x21) return undefined // #!
  const known = [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]
  if (known.includes(magic)) return undefined
  return `${basename(file)} is not an executable program (a placeholder left by an install whose scripts did not run). Reinstall it.`
}

export function managedPackageDir(installRoot: string, def: KernelDefinition): string {
  return join(installRoot, def.id, 'node_modules', ...def.npmPackage.split('/'))
}

export function readManagedPackage(installRoot: string, def: KernelDefinition): { version?: string; bin?: string | Record<string, string> } | undefined {
  try {
    return JSON.parse(readFileSync(join(managedPackageDir(installRoot, def), 'package.json'), 'utf8')) as { version?: string; bin?: string | Record<string, string> }
  } catch {
    return undefined
  }
}

function fromManaged(installRoot: string, def: KernelDefinition): ResolvedBinary | undefined {
  const pkg = readManagedPackage(installRoot, def)
  if (pkg === undefined) return undefined
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[def.bin]
  if (rel === undefined) return undefined
  const file = join(managedPackageDir(installRoot, def), rel)
  if (!existsSync(file)) return undefined
  return fromEntry({ file, kind: classifyEntry(file) }, 'managed', file)
}

/** `node` for Node scripts (by extension, then shebang), `native` for everything else. */
export function classifyEntry(file: string): ShimEntry['kind'] {
  return isNodeScript(file) ? 'node' : 'native'
}

/** A ResolvedBinary for an entry, carrying the reason when it cannot be started. */
function fromEntry(entry: ShimEntry, source: ResolvedBinary['source'], file: string, platform: NodeJS.Platform = process.platform, runtime: NodeRuntimeResult = nodeRuntime()): ResolvedBinary {
  if (entry.kind === 'node' && !runtime.ok) return { command: '', prefixArgs: [], source, file, problem: runtime.problem }
  const resolved: ResolvedBinary = { ...entryCommand(entry, runtime), source, file }
  const problem = entry.kind === 'native' ? nativeProblem(entry.file, platform) : undefined
  return problem !== undefined ? { ...resolved, problem } : resolved
}

/** What an npm `.cmd` shim launches: a Node script, or a native executable (e.g. Claude Code's bun-compiled `claude.exe`). */
export interface ShimEntry {
  file: string
  kind: 'node' | 'native'
}

/**
 * Environment for spawning `command`. When the command is the current
 * process's own executable inside Electron (DSH Desktop), it must run as
 * plain Node: without ELECTRON_RUN_AS_NODE=1 Electron starts a second GUI
 * instance instead of running the script. Applied after any allowlist
 * filtering so it cannot be stripped.
 */
export function nodeSpawnEnv<T extends Record<string, string | undefined>>(command: string, env: T): T {
  if (process.versions.electron !== undefined && command === process.execPath) return { ...env, ELECTRON_RUN_AS_NODE: '1' }
  return env
}

/**
 * Command and leading args for a shim entry: native executables run directly,
 * Node scripts with the Node runtime (see node-runtime.ts; inside DSH Desktop
 * that is a real Node.js on PATH, or the app run as Node).
 */
export function entryCommand(entry: ShimEntry, runtime: NodeRuntimeResult = nodeRuntime()): { command: string; prefixArgs: string[] } {
  if (entry.kind === 'native') return { command: entry.file, prefixArgs: [] }
  return { command: runtime.ok ? runtime.runtime.command : process.execPath, prefixArgs: [entry.file] }
}

/**
 * Find the entry behind an npm `.cmd` shim, so the CLI can be run
 * with `node <entry>` instead of through cmd.exe (whose quoting mangles
 * arguments and interprets `& | ^ %`). Looks at the `"%dp0%\…\x.js"` path
 * the shim points to, then at `node_modules/<pkg>` next to the shim.
 */
export function resolveCmdShim(
  file: string,
  def: Pick<KernelDefinition, 'npmPackage' | 'bin'>,
  read: (f: string) => string = f => readFileSync(f, 'utf8'),
  exists: (f: string) => boolean = existsSync,
  classify: (f: string) => ShimEntry['kind'] = classifyEntry,
): ShimEntry | undefined {
  const dir = dirname(file)
  try {
    const text = read(file)
    // npm's shim for a Node script first tests `"%dp0%\node.exe"` (the interpreter it may use), then
    // names the script; only the program it launches counts, never node.exe itself.
    const targets = [...text.matchAll(/"%~?dp0%?\\?([^"%]+?\.(?:(?:c|m)?js|exe))"/gi)].map(m => m[1]!).filter(rel => !/(^|[\\/])node\.exe$/i.test(rel))
    for (const rel of targets.reverse()) {
      const entry = resolvePath(dir, rel.replace(/\\/g, '/'))
      if (exists(entry)) return { file: entry, kind: /\.exe$/i.test(entry) ? 'native' : 'node' }
    }
  } catch {
    /* unreadable shim */
  }
  const pkgDir = join(dir, 'node_modules', ...def.npmPackage.split('/'))
  try {
    const pkg = JSON.parse(read(join(pkgDir, 'package.json'))) as { bin?: string | Record<string, string> }
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[def.bin]
    if (rel !== undefined && exists(join(pkgDir, rel))) {
      const entry = join(pkgDir, rel)
      return { file: entry, kind: /\.(c|m)?js$/i.test(entry) ? 'node' : /\.exe$/i.test(entry) ? 'native' : classify(entry) }
    }
  } catch {
    /* not an npm global prefix */
  }
  return undefined
}

/**
 * Quote one argument for `cmd.exe /d /s /c "…"` (MSVCRT rules, then caret-escape
 * cmd metacharacters), as cross-spawn does. Used only when a `.cmd` shim has
 * no resolvable JavaScript entry; spawn with `windowsVerbatimArguments: true`.
 * With `doubleEscape`, metacharacters are escaped twice: a batch file re-parses
 * `%*`, so arguments passed through a `.cmd` file need a second level.
 */
export function quoteCmdArg(arg: string, doubleEscape = false): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  quoted = `"${quoted}"`
  quoted = quoted.replace(/[()%!^"<>&|]/g, '^$&')
  return doubleEscape ? quoted.replace(/[()%!^"<>&|]/g, '^$&') : quoted
}

/**
 * Build the full verbatim command line for a `.cmd` file and its arguments.
 * The file name is escaped once and each argument twice (the batch file
 * re-parses them). Line breaks and NUL cannot be passed through cmd.exe and
 * are refused.
 */
export function cmdCommandLine(file: string, args: readonly string[]): string[] {
  for (const arg of [file, ...args]) {
    if (/[\r\n\0]/.test(arg)) throw new Error('an argument contains a line break or NUL, which cannot be passed safely through cmd.exe')
  }
  return ['/d', '/s', '/c', `"${[quoteCmdArg(file), ...args.map(arg => quoteCmdArg(arg, true))].join(' ')}"`]
}

/** Windows program extensions to try, in PATHEXT order (only kinds that can be started without a shell, plus batch files). */
export function windowsExtensions(pathext: string | undefined): string[] {
  const allowed = ['.com', '.exe', '.bat', '.cmd']
  const listed = (pathext ?? '').split(';').map(ext => ext.trim().toLowerCase()).filter(ext => allowed.includes(ext))
  const ordered = listed.length > 0 ? listed : ['.com', '.exe', '.bat', '.cmd']
  return [...new Set(ordered)]
}

/** Directories searched after PATH: where the CLIs' own installers put them (DSH may have been started before PATH was updated). */
function extraBinDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const profile = env.USERPROFILE ?? homedir()
    return [join(profile, '.local', 'bin'), ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : [])]
  }
  return [join(homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
}

/** Resolve one candidate file found on PATH or given in settings. */
function fromFile(file: string, def: Pick<KernelDefinition, 'npmPackage' | 'bin'>, source: ResolvedBinary['source'], platform: NodeJS.Platform): ResolvedBinary | undefined {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const entry = resolveCmdShim(file, def)
    if (entry !== undefined) return fromEntry(entry, source, file, platform)
    return { command: process.env.ComSpec ?? 'cmd.exe', prefixArgs: [], source, file, cmdShim: true }
  }
  if (platform === 'win32' && /\.ps1$/i.test(file)) {
    return { command: '', prefixArgs: [], source, file, problem: `${basename(file)} is a PowerShell script, which cannot be started directly; choose the .cmd or .exe next to it` }
  }
  const kind = classifyEntry(file)
  // npm also writes an extensionless /bin/sh shim on Windows (for Git Bash); Windows cannot start it.
  if (platform === 'win32' && kind === 'native' && !/\.(exe|com)$/i.test(file)) return undefined
  return fromEntry({ file, kind }, source, file, platform)
}

export function fromPath(def: Pick<KernelDefinition, 'npmPackage' | 'bin'>, envPath: string | undefined, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ResolvedBinary | undefined {
  const dirs = [...splitPath(envPath, platform), ...extraBinDirs(platform, env)]
  const names = platform === 'win32' ? [...windowsExtensions(env.PATHEXT).map(ext => `${def.bin}${ext}`), def.bin] : [def.bin]
  for (const dir of [...new Set(dirs)]) {
    for (const name of names) {
      const file = join(dir, name)
      if (!isExecutable(file)) continue
      const resolved = fromFile(file, def, 'path', platform)
      if (resolved !== undefined) return resolved
    }
  }
  return undefined
}

/** A path pasted into settings: trimmed, without the quotes Explorer's "Copy as path" adds. */
export function cleanOverridePath(path: string): string {
  return path.trim().replace(/^"(.*)"$/, '$1').trim()
}

/** argv and spawn options for a resolved binary (handles the cmd.exe fallback). */
export function spawnArgs(binary: ResolvedBinary, args: readonly string[]): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (binary.cmdShim === true) return { command: binary.command, args: cmdCommandLine(binary.file, args), windowsVerbatimArguments: true }
  return { command: binary.command, args: [...binary.prefixArgs, ...args], windowsVerbatimArguments: false }
}

export function resolveBinary(def: KernelDefinition, options: { installRoot: string; overridePath?: string; envPath?: string }): ResolvedBinary | undefined {
  const override = options.overridePath !== undefined ? cleanOverridePath(options.overridePath) : ''
  if (override) {
    if (!isExecutable(override)) return undefined
    return fromFile(override, def, 'settings', process.platform) ?? { command: '', prefixArgs: [], source: 'settings', file: override, problem: `${basename(override)} cannot be started on Windows; choose the .exe or .cmd file` }
  }
  return fromManaged(options.installRoot, def) ?? fromPath(def, options.envPath ?? process.env.PATH)
}

/** Parse "x.y.z" out of arbitrary `--version` output. */
export function parseVersion(text: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?/.exec(text)?.[0]
}

/** Compare against a ">=x.y.z" requirement. */
export function satisfiesMinVersion(version: string, range: string): boolean {
  const min = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(range)
  if (!min) return true
  const got = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!got) return false
  for (let i = 1; i <= 3; i += 1) {
    const a = Number(got[i])
    const b = Number(min[i])
    if (a !== b) return a > b
  }
  return true
}

/** `--version` probe. Runs with the scrubbed scoped environment: no provider keys reach the binary. */
export function probeVersion(binary: ResolvedBinary, timeoutMs = 10_000, env: Record<string, string> = scopedBaseEnv()): Promise<string | undefined> {
  if (binary.problem !== undefined) return Promise.resolve(undefined)
  const spawnSpec = spawnArgs(binary, ['--version'])
  return new Promise(resolve => {
    execFile(spawnSpec.command, spawnSpec.args, { timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments, env: nodeSpawnEnv(spawnSpec.command, env) }, (error, stdout, stderr) => {
      if (error && !stdout) {
        resolve(undefined)
        return
      }
      resolve(parseVersion(`${stdout}\n${stderr}`))
    })
  })
}

export function hasNativeLogin(def: KernelDefinition, env: NodeJS.ProcessEnv = process.env): boolean {
  if (def.loginEnv.some(key => Boolean(env[key]?.trim()))) return true
  return def.loginFiles.some(parts => existsSync(join(homedir(), ...parts)))
}
