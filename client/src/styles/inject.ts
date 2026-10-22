import xyflowCss from '@xyflow/react/dist/base.css?raw'
import { BRAND } from '../brand.ts'
import flowCss from './flow.css?raw'

const ID = `${BRAND.id}/styles`

/** Install the plugin's style sheet once; the disposer removes it when the plugin unloads. */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${ID}"]`)
  if (existing) return () => undefined
  const tag = document.createElement('style')
  tag.dataset.plugin = BRAND.id
  tag.dataset.pluginCss = ID
  tag.textContent = `${xyflowCss}\n${flowCss}`
  document.head.appendChild(tag)
  return () => tag.remove()
}
