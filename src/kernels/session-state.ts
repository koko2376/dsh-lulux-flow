/**
 * Native CLI session state kept between runs.
 *
 * Scoped runs point a CLI's config directory at an isolated home that is
 * deleted when the run ends. Resumable CLIs (Claude Code, Codex) keep their
 * session transcripts inside that directory, so without help a follow-up
 * turn's `--resume <id>` finds no conversation and fails. The runner saves
 * the transcript directories after each run, keyed by the native session id
 * the CLI reported, and copies them into the next run's home before it
 * resumes that id.
 *
 * Only the directories a kernel declares are kept (never config files, the
 * gateway token or MCP settings). Snapshots are pruned by age and count.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { safeJoin } from '../util/fs.js'
import type { KernelDefinition } from './types.js'

/** Native session ids are UUIDs or similar; anything else is not stored. */
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface SessionStateOptions {
  /** Snapshots older than this are removed (default 30 days). */
  maxAgeMs?: number
  /** Snapshots kept per kernel (default 200). */
  maxPerKernel?: number
}

export class SessionStateStore {
  private readonly maxAgeMs: number
  private readonly maxPerKernel: number

  constructor(
    private readonly root: string,
    options: SessionStateOptions = {},
  ) {
    this.maxAgeMs = options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000
    this.maxPerKernel = options.maxPerKernel ?? 200
  }

  private dirFor(kernel: KernelDefinition, nativeId: string): string | undefined {
    if (!NATIVE_ID.test(nativeId) || nativeId.includes('..')) return undefined
    return safeJoin(this.root, kernel.id, nativeId)
  }

  /** Copy a saved session into a fresh run home. Returns false when nothing was saved for that id. */
  restore(kernel: KernelDefinition, nativeId: string, home: string): boolean {
    const dirs = kernel.sessionStateDirs ?? []
    const saved = this.dirFor(kernel, nativeId)
    if (dirs.length === 0 || saved === undefined || !existsSync(saved)) return false
    let restored = false
    for (const rel of dirs) {
      const from = safeJoin(saved, rel)
      if (!existsSync(from)) continue
      cpSync(from, safeJoin(home, rel), { recursive: true, force: true })
      restored = true
    }
    return restored
  }

  /** Save a run home's session directories under the native id the CLI reported. */
  save(kernel: KernelDefinition, nativeId: string, home: string): boolean {
    const dirs = (kernel.sessionStateDirs ?? []).filter(rel => existsSync(safeJoin(home, rel)))
    const target = this.dirFor(kernel, nativeId)
    if (dirs.length === 0 || target === undefined) return false
    const staging = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    try {
      for (const rel of dirs) cpSync(safeJoin(home, rel), safeJoin(staging, rel), { recursive: true })
      rmSync(target, { recursive: true, force: true, maxRetries: 3 })
      renameSync(staging, target)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true, maxRetries: 3 })
      throw error
    }
    this.prune(kernel)
    return true
  }

  private prune(kernel: KernelDefinition): void {
    const dir = join(this.root, kernel.id)
    let entries: Array<{ path: string; mtime: number }>
    try {
      entries = readdirSync(dir)
        .filter(name => !name.endsWith('.tmp'))
        .map(name => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    } catch {
      return
    }
    entries.sort((a, b) => b.mtime - a.mtime)
    const now = Date.now()
    entries.forEach((entry, index) => {
      if (index >= this.maxPerKernel || now - entry.mtime > this.maxAgeMs) rmSync(entry.path, { recursive: true, force: true, maxRetries: 3 })
    })
  }
}
