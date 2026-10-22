/** Live run inspector: status, controls, approval gates, and per-node evidence. */
import { useState, type ReactElement } from 'react'
import type { WorkflowRun } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import { ACTIVE_RUN } from '../store/flow.ts'
import { Badge, Button, Segmented, cx } from '../ui/glass.tsx'
import { IconCheck, IconRerun, IconResume, IconStop, IconX, NodeIcons } from '../ui/icons.tsx'
import { duration, pretty, progress, runTone } from './format.ts'

export interface RunInspectorProps {
  run: WorkflowRun
  focusNode: string | null
  t: Translate
  onFocusNode: (id: string | null) => void
  onCancel: () => void
  onResume: () => void
  onRerun: () => void
  onDecide: (nodeId: string, approved: boolean, note?: string) => void
}

type EvidenceTab = 'output' | 'input' | 'trace' | 'artifacts' | 'attempts'

export function RunInspector({ run, focusNode, t, onFocusNode, onCancel, onResume, onRerun, onDecide }: RunInspectorProps): ReactElement {
  const [tab, setTab] = useState<EvidenceTab>('output')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const active = ACTIVE_RUN.includes(run.status)
  const resumable = run.status === 'failed' || run.status === 'interrupted' || run.status === 'cancelled'
  const { done, total } = progress(run)
  const nodes = run.snapshot?.nodes ?? []
  const waiting = nodes.filter(n => run.nodes[n.id]?.status === 'waiting' && n.type === 'approval')
  const focused = focusNode ? nodes.find(n => n.id === focusNode) : undefined
  const evidence = focusNode ? run.nodes[focusNode] : undefined
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)

  return (
    <div className="lxf-run" aria-live="polite">
      <header className="lxf-run__head">
        <div className="lxf-run__titles">
          <div className="lxf-run__name">{run.workflowName}</div>
          <div className="lxf-run__meta">
            <code>{run.id.slice(0, 8)}</code> · {t(`trigger.${run.trigger.kind}` as never)} · {duration(run.startedAt ?? run.createdAt, run.endedAt)}
          </div>
        </div>
        <Badge tone={runTone(run.status)}>{t(`status.${run.status}` as never)}</Badge>
      </header>

      <div className="lxf-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={t('run.progress', { done, total })}>
        <span className={cx('lxf-progress__bar', active && 'is-live')} style={{ width: `${pct}%` }} />
      </div>
      <div className="lxf-run__stats">
        <span>{t('run.progress', { done, total })}</span>
        <span>{t('run.tokens', { count: (run.usage.inputTokens + run.usage.outputTokens).toLocaleString() })}</span>
        <span>{t('run.nodeRuns', { count: run.usage.nodeRuns })}</span>
      </div>

      <div className="lxf-run__controls">
        {active && (
          <Button variant="danger" size="sm" icon={<IconStop />} onClick={onCancel}>
            {t('run.stop')}
          </Button>
        )}
        {resumable && (
          <Button size="sm" icon={<IconResume />} onClick={onResume}>
            {t('run.resume')}
          </Button>
        )}
        {!active && (
          <Button size="sm" icon={<IconRerun />} onClick={onRerun}>
            {t('run.rerun')}
          </Button>
        )}
      </div>

      {run.error && <div className="lxf-callout is-error">{run.error}</div>}

      {waiting.map(node => (
        <div key={node.id} className="lxf-approval" role="group" aria-label={t('run.approvalFor', { name: node.name })}>
          <div className="lxf-approval__title">{t('run.approvalNeeded', { name: node.name })}</div>
          <div className="lxf-approval__msg">{pretty(run.nodes[node.id]?.input) || String(node.config.message ?? '')}</div>
          <input
            className="lxf-input"
            aria-label={t('run.approvalNote')}
            placeholder={t('run.approvalNote')}
            value={notes[node.id] ?? ''}
            maxLength={500}
            onChange={e => setNotes(n => ({ ...n, [node.id]: e.target.value }))}
          />
          <div className="lxf-approval__actions">
            <Button variant="primary" size="sm" icon={<IconCheck />} onClick={() => onDecide(node.id, true, notes[node.id])}>
              {t('run.approve')}
            </Button>
            <Button variant="danger" size="sm" icon={<IconX />} onClick={() => onDecide(node.id, false, notes[node.id])}>
              {t('run.reject')}
            </Button>
          </div>
        </div>
      ))}

      <h3 className="lxf-section__title">{t('run.nodes')}</h3>
      <ul className="lxf-runnodes" aria-label={t('run.nodes')}>
        {nodes.map(node => {
          const ev = run.nodes[node.id]
          const status = ev?.status ?? 'pending'
          const Icon = NodeIcons[node.type]
          return (
            <li key={node.id}>
              <button type="button" className={cx('lxf-runnode', focusNode === node.id && 'is-active')} aria-pressed={focusNode === node.id} onClick={() => onFocusNode(focusNode === node.id ? null : node.id)}>
                <span className={cx('lxf-dot', `is-${status}`)} aria-hidden="true" />
                <Icon size={14} />
                <span className="lxf-runnode__name">{node.name}</span>
                <span className="lxf-runnode__status">{t(`status.${status}` as never)}</span>
                <span className="lxf-runnode__time">{duration(ev?.startedAt, ev?.endedAt)}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {focused && evidence && (
        <section className="lxf-evidence" aria-label={t('run.evidenceFor', { name: focused.name })}>
          <div className="lxf-evidence__head">
            <span className="lxf-evidence__title">{focused.name}</span>
            {evidence.route && <Badge tone={evidence.route === 'failure' || evidence.route === 'false' ? 'error' : 'success'}>{t(`route.${evidence.route}` as never)}</Badge>}
            {evidence.usage && <span className="lxf-evidence__usage">{t('run.tokens', { count: (evidence.usage.inputTokens + evidence.usage.outputTokens).toLocaleString() })}</span>}
          </div>
          <Segmented<EvidenceTab>
            label={t('run.evidence')}
            className="lxf-seg--sm"
            value={tab}
            onChange={setTab}
            options={(['output', 'input', 'trace', 'artifacts', 'attempts'] as const).map(v => ({ value: v, label: t(`evidence.${v}` as never) }))}
          />
          {evidence.error && <div className="lxf-callout is-error">{evidence.error}</div>}
          {tab === 'output' && <pre className="lxf-code">{pretty(evidence.output) || t('evidence.none')}</pre>}
          {tab === 'input' && <pre className="lxf-code">{pretty(evidence.input) || t('evidence.none')}</pre>}
          {tab === 'trace' && (evidence.trace.length ? <ol className="lxf-trace">{evidence.trace.map((line, i) => <li key={i}>{line}</li>)}</ol> : <p className="lxf-muted">{t('evidence.none')}</p>)}
          {tab === 'artifacts' &&
            (evidence.artifacts.length ? (
              <ul className="lxf-artifacts">
                {evidence.artifacts.map((a, i) => (
                  <li key={i}>
                    <div className="lxf-artifacts__name">
                      <Badge>{a.kind}</Badge> {a.name}
                    </div>
                    <pre className="lxf-code">{a.value}</pre>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="lxf-muted">{t('evidence.none')}</p>
            ))}
          {tab === 'attempts' &&
            (evidence.attempts.length ? (
              <ol className="lxf-attempts">
                {evidence.attempts.map(a => (
                  <li key={a.attempt}>
                    <Badge tone={runTone(a.status)}>{t(`status.${a.status}` as never)}</Badge> #{a.attempt} · {duration(a.startedAt, a.endedAt)}
                    {a.error && <div className="lxf-muted">{a.error}</div>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="lxf-muted">{t('evidence.none')}</p>
            ))}
          {evidence.decision && (
            <p className="lxf-muted">
              {t(evidence.decision.approved ? 'run.decision.approved' : 'run.decision.rejected', { by: evidence.decision.by })}
              {evidence.decision.note ? ` — ${evidence.decision.note}` : ''}
            </p>
          )}
        </section>
      )}
    </div>
  )
}
