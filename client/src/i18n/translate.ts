/**
 * Standalone translate for tests and the preview shell. Inside DSH the
 * renderer provides `t` from the registered plugin namespace (`NS`) instead;
 * both use the same `{name}` placeholder syntax.
 */
import { en } from './en.ts'
import { zh, type FlowKey } from './zh.ts'

export type Translate = (key: FlowKey, params?: Record<string, string | number>) => string
export type { FlowKey }

export const dictionaries = { zh, en } as const
export type LocaleId = keyof typeof dictionaries

export function format(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

export function createTranslate(locale: LocaleId): Translate {
  const dict = dictionaries[locale] as Record<string, string>
  return (key, params) => format(dict[key] ?? (en as Record<string, string>)[key] ?? key, params)
}

/** Translate a key that is only known at runtime (issue codes, statuses); unknown keys fall back to `fallback`. */
export function tx(t: Translate, key: string, fallback: string, params?: Record<string, string | number>): string {
  const out = t(key as FlowKey, params)
  return out === key ? fallback : out
}
