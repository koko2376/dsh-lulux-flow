/** All runs across workflows: history list, read-only live canvas, run inspector. */
import { ReactFlowProvider } from '@xyflow/react'
import { useState, type ReactElement } from 'react'
import type { RunStatus } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import type { FlowActions, FlowState } from '../store/flow.ts'
import type { SelectorHook } from '../store/store.ts'
import { Canvas } from '../canvas/Canvas.tsx'
import { Empty, IconButton, Spinner } from '../ui/glass.tsx'
import { IconRefresh } from '../ui/icons.tsx'
import { RunHistory } from './RunHistory.tsx'
import { RunInspector } from './RunInspector.tsx'

type Filter = 'all' | 'active' | 'failed'
const ACTIVE: readonly RunStatus[] = ['queued', 'running', 'waiting']

export function RunsView({ t, locale, useFlow, actions }: { t: Translate; locale: string; useFlow: SelectorHook<FlowState>; actions: FlowActions }): ReactElement {
  const runs = useFlow(s => s.runs)
  const [filter, setFilter] = useState<Filter>('all')
  const items = runs.items.filter(r => (filter === 'all' ? true : filter === 'active' ? ACTIVE.includes(r.status) : r.status === 'failed' || r.status === 'interrupted'))
  const active = runs.active
  return (
    <div className="lxf-runsview">
      <aside className="lxf-glass lxf-sidebar" aria-label={t('runs.history')}>
        <div className="lxf-sidebar__head">
          <h2 className="lxf-sidebar__title">{t('runs.title')}</h2>
          <IconButton label={t('common.refresh')} icon={<IconRefresh />} variant="glass" onClick={() => void actions.refreshRuns()} />
        </div>
        <div className="lxf-filter" role="group" aria-label={t('runs.filter')}>
          {(['all', 'active', 'failed'] as const).map(f => (
            <button key={f} type="button" className="lxf-chip lxf-chip--button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {t(`runs.filter.${f}` as never)}
            </button>
          ))}
        </div>
        <div className="lxf-sidebar__list">
          {runs.status === 'loading' ? <div className="lxf-center"><Spinner label={t('common.loading')} /></div> : <RunHistory runs={items} activeId={active?.id ?? null} t={t} locale={locale} onOpen={id => void actions.openRun(id)} showWorkflow />}
        </div>
      </aside>
      <section className="lxf-stage" aria-label={t('runs.canvas')}>
        {active ? (
          <ReactFlowProvider>
            <Canvas workflow={active.snapshot} issues={[]} selection={runs.focusNode ? { kind: 'node', id: runs.focusNode } : null} run={active} readOnly t={t} onSelect={sel => actions.focusRunNode(sel?.kind === 'node' ? sel.id : null)} />
          </ReactFlowProvider>
        ) : (
          <Empty title={t('runs.pick')} detail={t('runs.pickDetail')} />
        )}
      </section>
      {active && (
        <aside className="lxf-glass lxf-panel" aria-label={t('run.inspector')}>
          <div className="lxf-panel__body">
            <RunInspector
              run={active}
              focusNode={runs.focusNode}
              t={t}
              onFocusNode={actions.focusRunNode}
              onCancel={() => void actions.cancelRun(active.id)}
              onResume={() => void actions.resumeRun(active.id)}
              onRerun={() => void actions.rerun(active.id)}
              onDecide={(nodeId, approved, note) => void actions.decide(active.id, nodeId, approved, note)}
            />
          </div>
        </aside>
      )}
    </div>
  )
}
