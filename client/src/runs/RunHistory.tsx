import type { ReactElement } from 'react'
import type { WorkflowRun } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import { Badge, Empty, cx } from '../ui/glass.tsx'
import { duration, shortTime, runTone } from './format.ts'

export function RunHistory({ runs, activeId, t, locale, onOpen, showWorkflow }: { runs: readonly WorkflowRun[]; activeId: string | null; t: Translate; locale: string; onOpen: (id: string) => void; showWorkflow?: boolean }): ReactElement {
  if (runs.length === 0) return <Empty title={t('runs.empty')} detail={t('runs.emptyDetail')} />
  return (
    <ul className="lxf-history" aria-label={t('runs.history')}>
      {runs.map(run => (
        <li key={run.id}>
          <button type="button" className={cx('lxf-history__row', activeId === run.id && 'is-active')} aria-current={activeId === run.id ? 'true' : undefined} onClick={() => onOpen(run.id)}>
            <span className={cx('lxf-dot', `is-${run.status}`)} aria-hidden="true" />
            <span className="lxf-history__main">
              <span className="lxf-history__name">{showWorkflow ? run.workflowName : shortTime(run.createdAt, locale)}</span>
              <span className="lxf-history__meta">
                {showWorkflow ? `${shortTime(run.createdAt, locale)} · ` : ''}
                {t(`trigger.${run.trigger.kind}` as never)} · {duration(run.startedAt ?? run.createdAt, run.endedAt)}
              </span>
            </span>
            <Badge tone={runTone(run.status)}>{t(`status.${run.status}` as never)}</Badge>
          </button>
        </li>
      ))}
    </ul>
  )
}
