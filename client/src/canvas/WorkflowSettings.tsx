/** Workflow-level settings shown when nothing is selected on the canvas. */
import type { ReactElement } from 'react'
import type { Workflow } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import { Disclosure, Field } from '../ui/glass.tsx'

export function WorkflowSettings({ workflow, t, onChange }: { workflow: Workflow; t: Translate; onChange: (update: (wf: Workflow) => Workflow) => void }): ReactElement {
  const num = (v: string): number | undefined => (v === '' ? undefined : Number(v))
  return (
    <div className="lxf-inspector">
      <header className="lxf-inspector__head">
        <div className="lxf-inspector__titles">
          <div className="lxf-inspector__type">{t('workflow.settings')}</div>
          <div className="lxf-inspector__id">
            <code>{workflow.id}</code>
          </div>
        </div>
      </header>
      <section className="lxf-section">
        <Field label={t('workflow.name')}>{id => <input id={id} className="lxf-input" maxLength={120} value={workflow.name} onChange={e => onChange(wf => ({ ...wf, name: e.target.value }))} />}</Field>
        <Field label={t('workflow.description')}>
          {id => <textarea id={id} rows={3} className="lxf-input lxf-input--area" value={workflow.description ?? ''} onChange={e => onChange(wf => ({ ...wf, description: e.target.value }))} />}
        </Field>
      </section>
      <p className="lxf-field__hint lxf-inspector__tip">{t('panel.selectHint')}</p>
      <Disclosure title={t('inspector.advanced')} hint={t('workflow.advanced.hint')} defaultOpen={workflow.concurrency !== undefined || workflow.deadlineMs !== undefined || workflow.budget?.maxNodeRuns !== undefined || workflow.budget?.maxTokens !== undefined}>
        <div className="lxf-grid2">
          <Field label={t('workflow.concurrency')}>
            {id => <input id={id} type="number" min={1} max={16} className="lxf-input" value={workflow.concurrency ?? ''} placeholder="4" onChange={e => onChange(wf => ({ ...wf, concurrency: num(e.target.value) }) as Workflow)} />}
          </Field>
          <Field label={t('workflow.deadline')}>
            {id => (
              <input id={id} type="number" min={1} className="lxf-input" value={workflow.deadlineMs ? workflow.deadlineMs / 60000 : ''} onChange={e => onChange(wf => ({ ...wf, deadlineMs: num(e.target.value) === undefined ? undefined : Math.round(Number(e.target.value) * 60000) }) as Workflow)} />
            )}
          </Field>
          <Field label={t('workflow.maxNodeRuns')}>
            {id => <input id={id} type="number" min={1} className="lxf-input" value={workflow.budget?.maxNodeRuns ?? ''} onChange={e => onChange(wf => ({ ...wf, budget: { ...wf.budget, maxNodeRuns: num(e.target.value) } }) as Workflow)} />}
          </Field>
          <Field label={t('workflow.maxTokens')}>
            {id => <input id={id} type="number" min={1} className="lxf-input" value={workflow.budget?.maxTokens ?? ''} onChange={e => onChange(wf => ({ ...wf, budget: { ...wf.budget, maxTokens: num(e.target.value) } }) as Workflow)} />}
          </Field>
        </div>
        <div className="lxf-field__hint">{t('workflow.keyboardHelp')}</div>
      </Disclosure>
    </div>
  )
}
