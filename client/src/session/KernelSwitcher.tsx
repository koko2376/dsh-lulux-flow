/**
 * Session-header kernel picker (`conversation.session.header.actions`).
 * Selecting a kernel switches the session's model to that kernel's
 * `<providerPrefix>-<kernel>` chat route through DSH's own model directory, so the chat
 * itself talks to the CLI. "DSH agent" restores the last non-kernel model.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { kernelOfRoute, KERNEL_CHAT_MODEL } from '../brand.ts'
import type { KernelInfo } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import type { FlowState } from '../store/flow.ts'
import type { SelectorHook } from '../store/store.ts'
import { avatarFor, DSH_AGENT_AVATAR } from '../ui/avatars.ts'
import { Avatar, Popover, Spinner, cx } from '../ui/glass.tsx'
import { IconCheck, IconChevronDown } from '../ui/icons.tsx'

/** Structural subset of DSH's ModelDirectoryState that the switcher reads. */
export interface DirectoryView {
  current: { provider: string; model: string; reasoningEffort?: string } | null
  groups: ReadonlyArray<{ id: string; name: string; models: ReadonlyArray<{ id: string; name: string }> }>
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  pending: { provider: string; model: string } | null
  error: string | null
}

export interface KernelSwitcherInjected {
  available: boolean
  load: () => void
  /** Select a provider/model; resolves false when DSH refused the switch. */
  select: (selection: { provider: string; model: string; reasoningEffort?: string }) => Promise<boolean>
  /** Last non-kernel model this session used, if known. */
  previous: () => { provider: string; model: string; reasoningEffort?: string } | undefined
  remember: (selection: { provider: string; model: string; reasoningEffort?: string }) => void
  /** Called once on mount so the header shows the kernel's name and avatar before the popover opens. */
  prefetch?: () => void
}

export interface KernelSwitcherProps extends KernelSwitcherInjected {
  t: Translate
  useDirectory: SelectorHook<DirectoryView>
  useFlow: SelectorHook<FlowState>
}

interface Option {
  key: string
  kernel?: KernelInfo
  provider: string
  model: string
  name: string
  avatar: string
  detail: string
  disabled: boolean
}

export function KernelSwitcher({ t, useDirectory, useFlow, available, load, select, previous, remember, prefetch }: KernelSwitcherProps): ReactElement | null {
  const current = useDirectory(s => s.current)
  const groups = useDirectory(s => s.groups)
  const status = useDirectory(s => s.status)
  const error = useDirectory(s => s.error)
  const kernels = useFlow(s => s.kernels.items)
  const upstream = useFlow(s => s.meta?.upstream ?? null)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (available) prefetch?.()
  }, [available, prefetch])
  if (!available) return null

  const kernelId = current ? kernelOfRoute(current.provider) : undefined
  const activeKernel = kernelId ? kernels.find(k => k.id === kernelId) : undefined
  const routes = new Set(groups.map(g => g.id))
  // "DSH agent" goes back to: the model this session used before, else the gateway's real
  // model (what the CLIs already answer on), else the first non-CLI model DSH offers.
  const fallback = previous() ?? (() => {
    const offered = (provider: string, model: string): boolean => groups.some(g => g.id === provider && g.models.some(m => m.id === model))
    if (upstream && kernelOfRoute(upstream.provider) === undefined && offered(upstream.provider, upstream.model)) return { provider: upstream.provider, model: upstream.model }
    const g = groups.find(group => kernelOfRoute(group.id) === undefined && group.models.length > 0)
    return g ? { provider: g.id, model: g.models[0]!.id } : undefined
  })()

  const options: Option[] = [
    {
      key: 'dsh',
      provider: fallback?.provider ?? '',
      model: fallback?.model ?? '',
      name: t('switcher.dsh'),
      avatar: DSH_AGENT_AVATAR,
      detail: fallback ? `${fallback.provider}/${fallback.model}` : t('switcher.dshDetail'),
      disabled: fallback === undefined,
    },
    ...(kernels.length > 0 ? kernels : groups.filter(g => kernelOfRoute(g.id)).map(g => ({ id: kernelOfRoute(g.id)!, name: g.name, chatRoute: g.id, installed: true, settings: { enabled: true } }) as unknown as KernelInfo)).map(k => ({
      key: k.id,
      kernel: k,
      provider: k.chatRoute,
      model: KERNEL_CHAT_MODEL,
      name: k.name,
      avatar: avatarFor(k.avatar || k.id),
      detail: !k.installed ? t('kernels.notInstalled') : k.settings?.enabled === false ? t('switcher.disabled') : !routes.has(k.chatRoute) && status === 'ready' ? t('switcher.noRoute') : k.version ? `v${k.version}` : t('kernels.installed'),
      disabled: !k.installed || k.settings?.enabled === false || (!routes.has(k.chatRoute) && status === 'ready'),
    })),
  ]

  const choose = async (option: Option): Promise<void> => {
    if (option.disabled) return
    if (current && kernelOfRoute(current.provider) === undefined) remember(current)
    const ok = await select({ provider: option.provider, model: option.model })
    if (ok) setOpen(false)
  }

  const isActive = (option: Option): boolean => (option.kernel ? kernelId === option.kernel.id : current !== null && kernelId === undefined)
  const label = activeKernel?.name ?? (current && kernelId ? (groups.find(g => g.id === current.provider)?.name ?? kernelId) : t('switcher.dsh'))

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cx('lxf-root', 'lxf-switcher', kernelId && 'is-kernel')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('switcher.aria', { current: label })}
        title={t('switcher.title')}
        onClick={() => {
          setOpen(o => !o)
          load()
        }}
      >
        <Avatar src={kernelId ? avatarFor(activeKernel?.avatar ?? kernelId) : DSH_AGENT_AVATAR} alt="" size={20} />
        <span className="lxf-switcher__label">{label}</span>
        <IconChevronDown size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={t('switcher.title')} align="end" width={300}>
        <div className="lxf-switcher__pop">
          <div className="lxf-switcher__head">
            <span>{t('switcher.title')}</span>
            {(status === 'loading' || status === 'selecting') && <Spinner label={t('common.loading')} />}
          </div>
          <ul role="listbox" aria-label={t('switcher.title')} className="lxf-switcher__list">
            {options.map(option => (
              <li
                key={option.key}
                role="option"
                aria-selected={isActive(option)}
                aria-disabled={option.disabled}
                tabIndex={option.disabled ? -1 : 0}
                className={cx('lxf-switcher__opt', isActive(option) && 'is-active', option.disabled && 'is-disabled')}
                onClick={() => void choose(option)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    void choose(option)
                  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    const items = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=option]:not([aria-disabled=true])') ?? [])]
                    const i = items.indexOf(event.currentTarget)
                    items[(i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
                  }
                }}
              >
                <Avatar src={option.avatar} alt="" size={30} />
                <span className="lxf-switcher__text">
                  <span className="lxf-switcher__name">{option.name}</span>
                  <span className="lxf-switcher__detail">{option.detail}</span>
                </span>
                {isActive(option) && <IconCheck size={15} />}
              </li>
            ))}
          </ul>
          {error && <div className="lxf-callout is-error">{error}</div>}
          <div className="lxf-switcher__foot">{t('switcher.foot')}</div>
        </div>
      </Popover>
    </>
  )
}
