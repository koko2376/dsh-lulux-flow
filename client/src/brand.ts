/**
 * Client view of the plugin's names. Everything derives from the Host's
 * single source of truth (`src/brand.ts`, a dependency-free module that the
 * client build inlines), so a rename there carries through the UI, the API
 * root, the model routes and the locale namespace.
 */
import { BRAND as HOST } from '../../src/brand.ts'

export const BRAND = {
  displayName: HOST.displayName,
  displayNameZh: HOST.displayNameZh,
  id: HOST.id,
  providerPrefix: HOST.providerPrefix,
  repository: HOST.repository,
  headers: {
    csrf: HOST.headers.csrf,
    signature: HOST.headers.signature,
    timestamp: HOST.headers.timestamp,
  },
} as const

/** `x-foo-bar` → `X-Foo-Bar`, for display in help text. */
export const headerLabel = (name: string): string => name.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => `${dash}${c.toUpperCase()}`)

/** Plugin route root on the DSH web server. */
export const ROUTE_ROOT = `/${BRAND.id}`
/** Canvas API root on the DSH web server. */
export const API_ROOT = `${ROUTE_ROOT}/api`
/** Model id every kernel chat route publishes. */
export const KERNEL_CHAT_MODEL = 'default'
/** Locale namespace of every client string (the plugin id in camelCase). */
export const NS = BRAND.id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
/** Sidebar panel / main page key, slot ids and style tag ids derive from the plugin id. */
export const PANEL_ID = BRAND.id

export const chatRouteOf = (kernelId: string): string => `${BRAND.providerPrefix}-${kernelId}`
export const kernelOfRoute = (provider: string): string | undefined =>
  provider.startsWith(`${BRAND.providerPrefix}-`) ? provider.slice(BRAND.providerPrefix.length + 1) : undefined
