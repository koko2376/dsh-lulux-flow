/**
 * The plugin's own UI language. It is a plugin setting (`language` in the
 * Host settings), independent of DSH's locale and the browser's: Chinese
 * unless the person picks English. The chosen dictionary is registered for
 * every DSH locale, so the namespace-bound `t` that DSH hands to components
 * always returns the plugin language; switching re-registers, which bumps
 * DSH's locale revision and re-renders mounted outlets without a reload.
 */
import { en } from './en.ts'
import { zh } from './zh.ts'

export type PluginLanguage = 'zh-CN' | 'en'
export const PLUGIN_LANGUAGES: readonly PluginLanguage[] = ['zh-CN', 'en']
export const DEFAULT_LANGUAGE: PluginLanguage = 'zh-CN'

export function isPluginLanguage(value: unknown): value is PluginLanguage {
  return typeof value === 'string' && (PLUGIN_LANGUAGES as readonly string[]).includes(value)
}

export type Dictionary = Record<string, string>

export function dictionaryFor(language: PluginLanguage): Dictionary {
  return language === 'en' ? en : zh
}

/** BCP 47 tag for dates and numbers. */
export function localeTag(language: PluginLanguage): string {
  return language === 'en' ? 'en' : 'zh-CN'
}

/** Last language seen, so a reload starts in it before the settings arrive. */
export interface LanguageCache {
  read(): string | null
  write(value: string): void
}

const CACHE_KEY = 'dsh-lulux-flow.language'

export function browserCache(): LanguageCache | undefined {
  try {
    const storage = globalThis.localStorage
    if (storage === undefined) return undefined
    return { read: () => storage.getItem(CACHE_KEY), write: value => storage.setItem(CACHE_KEY, value) }
  } catch {
    return undefined
  }
}

export interface LanguageController {
  readonly current: PluginLanguage
  /** Register the dictionaries for the cached (or default) language. */
  start(): void
  /** Switch language; re-registers only when it changes. */
  set(language: PluginLanguage): void
  dispose(): void
}

/**
 * @param register registers one dictionary per DSH locale id and returns a disposer
 *   (DSH's `locale.register(NS, { zh, en })`; a namespace has one occupant per locale,
 *   so the previous registration is disposed first).
 */
export function createLanguageController(register: (dicts: { zh: Dictionary; en: Dictionary }) => () => void, cache?: LanguageCache): LanguageController {
  const cached = cache?.read()
  let current: PluginLanguage = isPluginLanguage(cached) ? cached : DEFAULT_LANGUAGE
  let dispose: (() => void) | undefined
  const apply = (): void => {
    dispose?.()
    const dict = dictionaryFor(current)
    dispose = register({ zh: dict, en: dict })
  }
  return {
    get current() {
      return current
    },
    start() {
      apply()
    },
    set(language) {
      if (!isPluginLanguage(language)) return
      try {
        cache?.write(language)
      } catch {
        /* storage full or blocked */
      }
      if (language === current && dispose !== undefined) return
      current = language
      apply()
    },
    dispose() {
      dispose?.()
      dispose = undefined
    },
  }
}
