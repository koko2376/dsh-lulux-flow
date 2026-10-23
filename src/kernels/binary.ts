/**
 * Locate and version-check kernel executables: an explicit path from
 * settings, then the LULUX Flow-managed install directory, then PATH.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import type { KernelDefinition } from './types.js'
import { scopedBaseEnv } from './env.js'

export interface ResolvedBinary {
  /** Executable to spawn. */
  command: string
  /** Leading arguments (e.g. the JS entry when run through node). */
  prefixArgs: string[]
  source: 'settings' | 'managed' | 'path'
  file: string
  /** Windows `.cmd` shim without a resolvable JS entry: run through cmd.exe with verbatim, escaped arguments. */
  cmdShim?: boolean
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

export function isNodeScript(file: string): boolean {
  if (/\.(c|m)?js$/.test(file)) return true
  try {
    const head = readFileSync(file, { encoding: 'utf8', flag: 'r' }).slice(0, 128)
    return /^#!.*\bnode\b/.test(head)
  } catch {
    return false
  }
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
  // Run JS entries with the current Node (works inside DSH Desktop's bundled runtime too).
  if (isNodeScript(file)) return { command: process.execPath, prefixArgs: [file], source: 'managed', file }
  return { command: file, prefixArgs: [], source: 'managed', file }
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

/** Command and leading args for a shim entry: Node scripts run with the current runtime, native executables directly. */
export function entryCommand(entry: ShimEntry): { command: string; prefixArgs: string[] } {
  return entry.kind === 'node' ? { command: process.execPath, prefixArgs: [entry.file] } : { command: entry.file, prefixArgs: [] }
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
  classify: (f: string) => ShimEntry['kind'] = f => (isNodeScript(f) ? 'node' : 'native'),
): ShimEntry | undefined {
  const dir = dirname(file)
  try {
    const text = read(file)
    const match = /"%~?dp0%?\\?([^"%]+?\.(?:(?:c|m)?js|exe))"/i.exec(text)
    if (match) {
      const entry = resolvePath(dir, match[1]!.replace(/\\/g, '/'))
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

function fromPath(def: KernelDefinition, envPath: string | undefined, platform: NodeJS.Platform = process.platform): ResolvedBinary | undefined {
  const dirs = (envPath ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  const extra = platform === 'win32' ? [] : [join(homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
  const names = platform === 'win32' ? [`${def.bin}.exe`, `${def.bin}.cmd`, def.bin] : [def.bin]
  for (const dir of [...dirs, ...extra]) {
    for (const name of names) {
      const file = join(dir, name)
      if (isExecutable(file)) {
        if (/\.cmd$/i.test(file)) {
          const entry = resolveCmdShim(file, def)
          if (entry !== undefined) return { ...entryCommand(entry), source: 'path', file }
          return { command: process.env.ComSpec ?? 'cmd.exe', prefixArgs: [], source: 'path', file, cmdShim: true }
        }
        return { command: file, prefixArgs: [], source: 'path', file }
      }
    }
  }
  return undefined
}

/** argv and spawn options for a resolved binary (handles the cmd.exe fallback). */
export function spawnArgs(binary: ResolvedBinary, args: readonly string[]): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (binary.cmdShim === true) return { command: binary.command, args: cmdCommandLine(binary.file, args), windowsVerbatimArguments: true }
  return { command: binary.command, args: [...binary.prefixArgs, ...args], windowsVerbatimArguments: false }
}

export function resolveBinary(def: KernelDefinition, options: { installRoot: string; overridePath?: string; envPath?: string }): ResolvedBinary | undefined {
  if (options.overridePath) {
    if (!isExecutable(options.overridePath)) return undefined
    return isNodeScript(options.overridePath)
      ? { command: process.execPath, prefixArgs: [options.overridePath], source: 'settings', file: options.overridePath }
      : { command: options.overridePath, prefixArgs: [], source: 'settings', file: options.overridePath }
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
