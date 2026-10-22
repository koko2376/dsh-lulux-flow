/** The plugin's main page (`main` slot): a floating segmented control over Workflows / Runs / Kernels. */
import { useEffect, type ReactElement } from 'react'
import type { Translate } from './i18n/translate.ts'
import type { FlowActions, FlowState, View } from './store/flow.ts'
import type { SelectorHook } from './store/store.ts'
import { WorkflowsView } from './canvas/WorkflowsView.tsx'
import { RunsView } from './runs/RunsView.tsx'
import { KernelsView } from './kernels/KernelsView.tsx'
import { BRAND_AVATAR } from './ui/avatars.ts'
import { Segmented, cx } from './ui/glass.tsx'
import { IconHistory, IconWarning, NodeIcons } from './ui/icons.tsx'

export interface FlowPageInjected {
  actions: FlowActions
  locale: () => string
}

export interface FlowPageProps extends FlowPageInjected {
  t: Translate
  useFlow: SelectorHook<FlowState>
}

export function FlowPage({ t, useFlow, actions, locale }: FlowPageProps): ReactElement {
  const view = useFlow(s => s.view)
  const connected = useFlow(s => s.connected)
  const meta = useFlow(s => s.meta)
  // The page mounts the live event stream for as long as it is shown.
  useEffect(() => actions.start(), [actions])
  const lang = locale()
  const KernelIcon = NodeIcons.kernel
  const FlowIcon = NodeIcons.condition
  return (
    <div className="lxf-root lxf-page" lang={lang === 'zh' ? 'zh-CN' : 'en'}>
      <header className="lxf-page__head">
        <div className="lxf-brand">
          <img src={BRAND_AVATAR} alt="" width={30} height={30} />
          <div>
            <h1 className="lxf-brand__name">{t('brand.name')}</h1>
            <div className="lxf-brand__sub">
              <span className={cx('lxf-dot', connected ? 'is-succeeded' : 'is-pending')} aria-hidden="true" />
              {connected ? t('brand.live') : t('brand.offline')}
              {meta?.upstream ? ` · ${t('brand.upstream', { model: `${meta.upstream.provider}/${meta.upstream.model}` })}` : ''}
            </div>
          </div>
        </div>
        <Segmented<View>
          label={t('page.views')}
          value={view}
          onChange={actions.setView}
          className="lxf-page__nav"
          options={[
            { value: 'workflows', label: t('page.workflows'), icon: <FlowIcon size={14} /> },
            { value: 'runs', label: t('page.runs'), icon: <IconHistory size={14} /> },
            { value: 'kernels', label: t('page.kernels'), icon: <KernelIcon size={14} /> },
          ]}
        />
        <div className="lxf-page__spacer" />
      </header>
      {meta?.upstreamError && (
        <div className="lxf-banner" role="alert">
          <IconWarning size={15} />
          <span>{t('banner.upstreamError', { message: meta.upstreamError })}</span>
        </div>
      )}
      <div className="lxf-page__body">
        {view === 'workflows' && <WorkflowsView t={t} locale={lang} useFlow={useFlow} actions={actions} />}
        {view === 'runs' && <RunsView t={t} locale={lang} useFlow={useFlow} actions={actions} />}
        {view === 'kernels' && <KernelsView t={t} useFlow={useFlow} actions={actions} />}
      </div>
    </div>
  )
}

/** Sidebar panel-list icon (`sidebar.panellist`). */
export function FlowPanelIcon({ size, active }: { size: number; active: boolean }): ReactElement {
  return <img src={BRAND_AVATAR} alt="" width={size} height={size} className={cx('lxf-panelicon', active && 'is-active')} style={{ borderRadius: size / 3 }} />
}
