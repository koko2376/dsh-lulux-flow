import type { NodeStatus, RunStatus, WorkflowRun } from '../api/types.ts'

export function duration(startIso?: string, endIso?: string, now = Date.now()): string {
  if (!startIso) return '—'
  const ms = (endIso ? Date.parse(endIso) : now) - Date.parse(startIso)
  if (!(ms >= 0)) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function shortTime(iso: string | undefined, locale: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export const DONE: readonly NodeStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled']

export function progress(run: WorkflowRun): { done: number; total: number } {
  const total = run.snapshot?.nodes.length ?? Object.keys(run.nodes).length
  const done = Object.values(run.nodes).filter(n => DONE.includes(n.status)).length
  return { done, total }
}

export function runTone(status: RunStatus | NodeStatus): 'success' | 'error' | 'warn' | 'info' | 'neutral' | 'accent' {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'failed':
      return 'error'
    case 'waiting':
    case 'interrupted':
      return 'warn'
    case 'running':
    case 'queued':
      return 'accent'
    default:
      return 'neutral'
  }
}

export function pretty(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
