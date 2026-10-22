/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) in the
 * host's local time zone, plus @hourly/@daily/@weekly/@monthly. Supports
 * `*`, numbers, ranges `a-b`, lists `a,b`, steps `*\/n` and `a-b/n`.
 */
const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
}

export interface CronSpec {
  sets: Set<number>[]
  domStar: boolean
  dowStar: boolean
}

export function parseCron(expression: string): CronSpec {
  const source = ALIASES[expression.trim()] ?? expression.trim()
  const parts = source.split(/\s+/)
  if (parts.length !== 5) throw new Error('cron expression must have 5 fields')
  const sets = parts.map((part, index) => {
    const { min, max } = FIELDS[index]!
    const set = new Set<number>()
    for (const item of part.split(',')) {
      const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item)
      if (!match) throw new Error(`invalid cron field "${item}"`)
      const step = match[4] !== undefined ? Number(match[4]) : 1
      if (step < 1) throw new Error('cron step must be >= 1')
      let from: number = min
      let to: number = max
      if (match[1] !== '*') {
        from = Number(match[2])
        to = match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? max : from
      }
      if (from < min || to > max || from > to) throw new Error(`cron field "${item}" out of range ${min}-${max}`)
      for (let v = from; v <= to; v += step) set.add(index === 4 && v === 7 ? 0 : v)
    }
    return set
  })
  return { sets, domStar: parts[2] === '*', dowStar: parts[4] === '*' }
}

export function matches(spec: CronSpec, date: Date): boolean {
  const [minute, hour, dom, month, dow] = spec.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  if (!minute.has(date.getMinutes()) || !hour.has(date.getHours()) || !month.has(date.getMonth() + 1)) return false
  const domOk = dom.has(date.getDate())
  const dowOk = dow.has(date.getDay())
  // Standard cron: when both day fields are restricted, either may match.
  if (!spec.domStar && !spec.dowStar) return domOk || dowOk
  return domOk && dowOk
}

/** Next matching minute strictly after `from` (searches up to ~366 days). */
export function nextRun(expression: string, from: Date = new Date()): Date | undefined {
  const spec = parseCron(expression)
  const date = new Date(from.getTime())
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() + 1)
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (matches(spec, date)) return date
    date.setMinutes(date.getMinutes() + 1)
  }
  return undefined
}

/** Fires `tick(date)` at the start of every minute until stopped. */
export function startMinuteTicker(tick: (date: Date) => void): () => void {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const schedule = (): void => {
    if (stopped) return
    const now = Date.now()
    const wait = 60_000 - (now % 60_000) + 50
    timer = setTimeout(() => {
      try {
        tick(new Date())
      } finally {
        schedule()
      }
    }, wait)
    timer.unref()
  }
  schedule()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}
