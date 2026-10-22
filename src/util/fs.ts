import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Ids used in file names: letters, digits, `-` and `_`, 1–64 chars. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export function assertSafeId(id: string, what = 'id'): string {
  if (!SAFE_ID.test(id)) throw new Error(`invalid ${what}: ${JSON.stringify(id).slice(0, 80)}`)
  return id
}

/**
 * Resolve `parts` under `root` with the platform's own path rules (so the
 * result is native: `D:\data\runs` on Windows), refusing anything that
 * escapes it: `..` segments, an absolute part, or another drive.
 */
export function safeJoin(root: string, ...parts: string[]): string {
  const base = resolve(root)
  const target = resolve(base, ...parts)
  const rel = relative(base, target)
  if (rel === '') return target
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path escapes the data directory')
  return target
}

/** Write JSON atomically (temp file + rename) with private permissions. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

export function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}
