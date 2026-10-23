/**
 * Concurrency cap for CLI runs: at most `global` runs at once across all
 * kernels and at most `perKernel` runs of one kernel. Runs beyond either cap
 * wait in one FIFO queue; a waiter starts as soon as both caps have room for
 * it, and waiters of the same kernel always start in arrival order. A waiter
 * whose signal aborts leaves the queue at once.
 *
 * Why: one ds-bot group round, a DSH chat with several sessions and a
 * workflow fan-out can each start several CLIs, and every CLI is a heavy
 * process tree with its own model traffic.
 */

export interface KernelLimits {
  /** Runs at once across all kernels (>= 1). */
  global: number
  /** Runs at once of one kernel (>= 1). */
  perKernel: number
}

export interface KernelQueueStatus {
  /** 1-based position in the queue when the run started waiting. */
  position: number
  /** Which cap is full: all kernels, or this kernel. */
  reason: 'global' | 'kernel'
  /** Active runs counted against that cap, and the cap itself. */
  active: number
  limit: number
}

interface Waiter {
  kernelId: string
  start: () => void
}

/** The one-line status a chat shows while a run waits for a slot. */
export function queuedLine(kernelName: string, status: KernelQueueStatus): string {
  const what = status.reason === 'kernel' ? `${status.active} ${kernelName} runs` : `${status.active} CLI runs`
  return `⏳ Queued (#${status.position}): ${what} already active, limit ${status.limit}. ${kernelName} starts when one finishes.`
}

export class AbortedWhileQueued extends Error {
  constructor() {
    super('aborted while queued')
    this.name = 'AbortedWhileQueued'
  }
}

export class KernelLimiter {
  private active = 0
  private readonly byKernel = new Map<string, number>()
  private readonly queue: Waiter[] = []

  constructor(private readonly limits: () => KernelLimits) {}

  private caps(): KernelLimits {
    const { global, perKernel } = this.limits()
    const clamp = (n: number): number => (Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1)
    return { global: clamp(global), perKernel: clamp(perKernel) }
  }

  private fits(kernelId: string): boolean {
    const caps = this.caps()
    return this.active < caps.global && (this.byKernel.get(kernelId) ?? 0) < caps.perKernel
  }

  /** Counts for diagnostics and tests. */
  stats(): { active: number; queued: number; byKernel: Record<string, number> } {
    return { active: this.active, queued: this.queue.length, byKernel: Object.fromEntries(this.byKernel) }
  }

  /**
   * Wait for a slot, run `task`, release the slot. `onQueued` is called once,
   * synchronously, when the run has to wait. Rejects with
   * {@link AbortedWhileQueued} when `signal` aborts before the slot is free.
   */
  async run<T>(kernelId: string, task: () => Promise<T>, options: { signal?: AbortSignal; onQueued?: (status: KernelQueueStatus) => void } = {}): Promise<T> {
    await this.acquire(kernelId, options)
    try {
      return await task()
    } finally {
      this.release(kernelId)
    }
  }

  private acquire(kernelId: string, options: { signal?: AbortSignal; onQueued?: (status: KernelQueueStatus) => void }): Promise<void> {
    const { signal } = options
    if (signal?.aborted) return Promise.reject(new AbortedWhileQueued())
    // Nobody of this kernel may be overtaken; other kernels may pass a waiter blocked only by its own kernel cap.
    const blockedAhead = this.queue.some(w => w.kernelId === kernelId) || (this.queue.length > 0 && this.active >= this.caps().global)
    if (!blockedAhead && this.fits(kernelId)) {
      this.take(kernelId)
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter)
        if (index >= 0) this.queue.splice(index, 1)
        reject(new AbortedWhileQueued())
        this.drain()
      }
      const waiter: Waiter = {
        kernelId,
        start: () => {
          signal?.removeEventListener('abort', onAbort)
          this.take(kernelId)
          resolve()
        },
      }
      this.queue.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      const caps = this.caps()
      const kernelFull = (this.byKernel.get(kernelId) ?? 0) >= caps.perKernel
      const status: KernelQueueStatus = kernelFull
        ? { position: this.queue.length, reason: 'kernel', active: this.byKernel.get(kernelId) ?? 0, limit: caps.perKernel }
        : { position: this.queue.length, reason: 'global', active: this.active, limit: caps.global }
      try {
        options.onQueued?.(status)
      } catch {
        /* observer failures never break the queue */
      }
    })
  }

  private take(kernelId: string): void {
    this.active += 1
    this.byKernel.set(kernelId, (this.byKernel.get(kernelId) ?? 0) + 1)
  }

  private release(kernelId: string): void {
    this.active = Math.max(0, this.active - 1)
    const left = (this.byKernel.get(kernelId) ?? 1) - 1
    if (left > 0) this.byKernel.set(kernelId, left)
    else this.byKernel.delete(kernelId)
    this.drain()
  }

  /** Start every waiter that fits, in queue order, never letting one pass an earlier waiter of its kernel. */
  private drain(): void {
    const passed = new Set<string>()
    for (let i = 0; i < this.queue.length; ) {
      const waiter = this.queue[i]!
      if (!passed.has(waiter.kernelId) && this.fits(waiter.kernelId)) {
        this.queue.splice(i, 1)
        waiter.start()
        continue
      }
      passed.add(waiter.kernelId)
      if (this.active >= this.caps().global) return
      i += 1
    }
  }
}
