/**
 * End a child process and everything it started. On Windows a process has
 * no group to signal, so `taskkill /T /F` ends the tree; it is called by its
 * full path, because a scoped environment's PATH may not include System32.
 * Elsewhere the child is expected to lead its own process group
 * (`detached: true`), and the group is signalled.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR
  return root ? join(root, 'System32', 'taskkill.exe') : 'taskkill'
}

export function killTree(pid: number | undefined, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  if (pid === undefined) return
  try {
    if (platform === 'win32') {
      const child = spawn(taskkillPath(), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      child.on('error', () => {
        try {
          process.kill(pid, signal)
        } catch {
          /* already gone */
        }
      })
    } else {
      process.kill(-pid, signal)
    }
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* already gone */
    }
  }
}
