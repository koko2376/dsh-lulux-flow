/**
 * Browser half (`./client`). Registers, through DSH's slot system:
 *
 * - `sidebar.panellist` + `main` (key = plugin id): the main page
 *   (workflows canvas, runs, kernels);
 * - `settings.section` (id = plugin id): gateway model, mirror, kernel defaults, script nodes;
 * - `conversation.session.header.actions` (id `<plugin id>.kernel`): the kernel
 *   switcher that moves a chat session onto a `<providerPrefix>-<kernel>` model route
 *   via DSH's own `modelDirectories` service;
 * - `shell.overlay` (id `<plugin id>.toasts`): operation toasts.
 *
 * Components receive data only through registration `inject` faces (plain
 * callbacks plus the `hooks` compartment) and the namespace-bound `t`.
 */
import { FlowApi } from './api/client.ts'
import { BRAND, NS, PANEL_ID } from './brand.ts'
import { FlowPage, FlowPanelIcon } from './FlowPage.tsx'
import { browserCache, createLanguageController, localeTag } from './i18n/language.ts'
import { KernelSwitcher, type DirectoryView } from './session/KernelSwitcher.tsx'
import { SettingsSection } from './settings/SettingsSection.tsx'
import { createFlowController } from './store/flow.ts'
import type { Observable } from './store/store.ts'
import { injectStyles } from './styles/inject.ts'
import { Toasts } from './Toasts.tsx'

/** Structural view of the Cordis client context this plugin touches. */
export interface ClientContext {
  effect(fn: () => () => void, label?: string): void
  inject(deps: string[], callback: (scope: ClientContext) => void): void
  get(name: string): unknown
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string, params?: Record<string, unknown>) => string
    getSnapshot(): { active: string }
  }
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  modelDirectories?: {
    directoryFor(sessionId: string): {
      store: Observable<DirectoryView>
      load(): Promise<unknown>
      select(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<{ ok: boolean }>
    }
  }
}

export const name = `${BRAND.id}/client`
export const inject = ['slots', 'locale']

// The `NS` namespace keys are `FlowKey` (client/src/i18n/zh.ts). DSH's
// `LocaleNamespaceMap` merge is omitted because the slots package is not a
// dependency of this standalone plugin; `t` is structurally the same function.

export function apply(ctx: ClientContext): void {
  ctx.effect(() => injectStyles(), `${BRAND.id}: styles`)
  // The plugin language is a plugin setting (default Chinese), not DSH's locale.
  const language = createLanguageController(dicts => ctx.locale.register(NS, dicts), browserCache())
  const t = ctx.locale.bind(NS)
  const flow = createFlowController(new FlowApi())
  ctx.effect(() => {
    language.start()
    const sync = (): void => {
      const chosen = flow.store.getSnapshot().settings.value?.language
      if (chosen !== undefined) language.set(chosen)
    }
    const unsubscribe = flow.store.subscribe(sync)
    void flow.actions.loadSettings()
    return () => {
      unsubscribe()
      language.dispose()
    }
  }, `${BRAND.id}: dictionaries`)
  const locale = (): string => localeTag(language.current)
  const face = () => ({ hooks: { flow: flow.store }, actions: flow.actions })

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('brand.name') }, FlowPanelIcon),
  )
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ ...face(), locale }) }, FlowPage))
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({ name: 'settings.section', id: PANEL_ID, order: 900, locale: NS, label: () => t('brand.short'), inject: face }, SettingsSection),
  )
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: `${PANEL_ID}.toasts`, locale: NS, inject: face }, Toasts))

  // The switcher needs DSH's model directory; it stays absent where model selection is not mounted.
  ctx.inject(['modelDirectories'], scope => {
    const directories = scope.modelDirectories ?? (scope.get('modelDirectories') as ClientContext['modelDirectories'])
    if (directories === undefined) return
    const previous = new Map<string, { provider: string; model: string; reasoningEffort?: string }>()
    const prefetch = (): void => {
      const snapshot = flow.store.getSnapshot()
      if (snapshot.kernels.status === 'idle') void flow.actions.refreshKernels()
      if (snapshot.meta === null) void flow.actions.refreshMeta()
    }
    scope.slots.inject('conversation.session.header.actions', () =>
      scope.slots.register(
        {
          name: 'conversation.session.header.actions',
          id: `${PANEL_ID}.kernel`,
          order: 40,
          locale: NS,
          inject: (sessionId: string) => {
            const directory = directories.directoryFor(sessionId)
            return {
              hooks: { directory: directory.store, flow: flow.store },
              available: true,
              load: () => {
                directory.load().catch(() => undefined)
                if (flow.store.getSnapshot().kernels.status === 'idle') void flow.actions.refreshKernels()
              },
              select: async (selection: { provider: string; model: string; reasoningEffort?: string }) => {
                const result = await directory.select(selection).catch(() => ({ ok: false }))
                return result.ok
              },
              prefetch,
              previous: () => previous.get(sessionId),
              remember: (selection: { provider: string; model: string; reasoningEffort?: string }) => previous.set(sessionId, selection),
            }
          },
        },
        KernelSwitcher,
      ),
    )
  })
}
