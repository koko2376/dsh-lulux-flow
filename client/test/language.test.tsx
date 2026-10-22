/** Plugin language: default Chinese, independent of DSH's locale; switching re-registers the dictionaries. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NS } from '../src/brand.ts'
import { apply, type ClientContext } from '../src/index.ts'
import { en } from '../src/i18n/en.ts'
import { createLanguageController, DEFAULT_LANGUAGE, localeTag, type Dictionary } from '../src/i18n/language.ts'
import { zh } from '../src/i18n/zh.ts'
import { SettingsSection } from '../src/settings/SettingsSection.tsx'
import { createFlowController } from '../src/store/flow.ts'
import { bind, fakeApi, t } from './helpers.tsx'

function memoryCache(initial: string | null = null) {
  let value = initial
  return { read: () => value, write: (v: string) => void (value = v), get value() { return value } }
}

describe('language controller', () => {
  it('defaults to Chinese and registers it for every DSH locale', () => {
    const registered: Array<{ zh: Dictionary; en: Dictionary }> = []
    const c = createLanguageController(d => (registered.push(d), () => undefined), memoryCache())
    c.start()
    expect(DEFAULT_LANGUAGE).toBe('zh-CN')
    expect(c.current).toBe('zh-CN')
    expect(registered[0]!.zh).toBe(zh)
    expect(registered[0]!.en).toBe(zh)
    expect(localeTag(c.current)).toBe('zh-CN')
  })

  it('switches by disposing and re-registering; repeated or invalid values change nothing', () => {
    const disposed: number[] = []
    const registered: Array<{ zh: Dictionary; en: Dictionary }> = []
    const cache = memoryCache()
    const c = createLanguageController(d => {
      const n = registered.push(d)
      return () => disposed.push(n)
    }, cache)
    c.start()
    c.set('en')
    expect(disposed).toEqual([1])
    expect(registered[1]!.zh).toBe(en)
    expect(registered[1]!.en).toBe(en)
    expect(cache.value).toBe('en')
    c.set('en')
    c.set('fr' as never)
    expect(registered).toHaveLength(2)
    c.dispose()
    expect(disposed).toEqual([1, 2])
  })

  it('starts in the cached language after a reload', () => {
    const registered: Array<{ zh: Dictionary }> = []
    const c = createLanguageController(d => (registered.push(d), () => undefined), memoryCache('en'))
    c.start()
    expect(c.current).toBe('en')
    expect(registered[0]!.zh).toBe(en)
  })
})

describe('Settings → Language', () => {
  it('shows the select with Chinese preselected and saves English', async () => {
    let settings: Record<string, unknown> = { kernels: {}, registryOverride: '', gatewayModel: '', allowScriptNodes: false, registryTrustMirror: false, language: 'zh-CN' }
    const { api, calls } = fakeApi((method, path, body) => {
      if (path === '/settings' && method === 'GET') return { body: { settings } }
      if (path === '/settings' && method === 'PUT') return { body: { settings: (settings = { ...settings, ...(body as object) }) } }
      if (path === '/kernels') return { body: { kernels: [] } }
      if (path === '/meta') return { body: { scriptsAllowed: false } }
      return undefined
    })
    const flow = createFlowController(api)
    render(<SettingsSection t={t} useFlow={bind(flow.store)} actions={flow.actions} />)
    const select = (await screen.findByLabelText('Language / 语言')) as HTMLSelectElement
    await waitFor(() => expect(select.disabled).toBe(false))
    expect(select.value).toBe('zh-CN')
    expect([...select.options].map(o => o.textContent)).toEqual(['中文', 'English'])
    fireEvent.change(select, { target: { value: 'en' } })
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && (c.body as { language?: string }).language === 'en')).toBe(true))
    await waitFor(() => expect(flow.store.getSnapshot().settings.value?.language).toBe('en'))
  })
})

describe('client entry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('renders Chinese even when DSH is in English, and follows the saved setting without a reload', async () => {
    let language = 'zh-CN'
    vi.stubGlobal('fetch', async (input: string) => {
      const body = input.endsWith('/settings') ? { settings: { kernels: {}, registryOverride: '', gatewayModel: '', allowScriptNodes: false, registryTrustMirror: false, language } } : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    // A minimal DSH locale registry: active DSH locale is English; one occupant per (ns, locale).
    const dicts = new Map<string, Record<string, string>>()
    let revision = 0
    const effects: Array<() => () => void> = []
    const ctx = {
      effect: (fn: () => () => void) => void effects.push(fn),
      inject: () => undefined,
      get: () => undefined,
      locale: {
        register(ns: string, d: Record<string, Record<string, string>>) {
          for (const id of Object.keys(d)) {
            if (dicts.has(`${ns}:${id}`)) throw new Error('duplicate')
            dicts.set(`${ns}:${id}`, d[id]!)
          }
          revision += 1
          return () => {
            for (const id of Object.keys(d)) dicts.delete(`${ns}:${id}`)
            revision += 1
          }
        },
        bind: (ns: string) => (key: string) => dicts.get(`${ns}:en`)?.[key] ?? key,
        getSnapshot: () => ({ active: 'en' }),
      },
      slots: { inject: () => undefined, register: () => undefined },
    } as unknown as ClientContext
    language = 'en' // saved earlier, e.g. in another browser
    apply(ctx)
    const disposers = effects.map(fn => fn())
    const bound = ctx.locale.bind(NS)
    // before the settings arrive: Chinese, although DSH's active locale is English
    expect(bound('page.workflows')).toBe(zh['page.workflows'])
    // the saved setting arrives and switches the registered dictionaries in place
    await waitFor(() => expect(bound('page.workflows')).toBe(en['page.workflows']))
    expect(revision).toBeGreaterThanOrEqual(3)
    expect(localStorage.getItem('dsh-lulux-flow.language')).toBe('en')
    for (const d of disposers) d()
    expect([...dicts.keys()].filter(k => k.startsWith(`${NS}:`))).toEqual([])
  })
})
