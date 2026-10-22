import type { ReactElement } from 'react'
import { routesFor, type EdgeRoute, type Workflow, type WorkflowEdge } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import { Field, IconButton } from '../ui/glass.tsx'
import { IconTrash } from '../ui/icons.tsx'

export function EdgeInspector({ workflow, edge, t, onChange, onDelete }: { workflow: Workflow; edge: WorkflowEdge; t: Translate; onChange: (edge: WorkflowEdge) => void; onDelete: () => void }): ReactElement {
  const source = workflow.nodes.find(n => n.id === edge.source)
  const target = workflow.nodes.find(n => n.id === edge.target)
  const routes = source ? routesFor(source.type) : []
  return (
    <div className="lxf-inspector">
      <header className="lxf-inspector__head">
        <div className="lxf-inspector__titles">
          <div className="lxf-inspector__type">{t('edge.title')}</div>
          <div className="lxf-inspector__id">
            {source?.name ?? edge.source} → {target?.name ?? edge.target}
          </div>
        </div>
        <IconButton label={t('edge.delete')} icon={<IconTrash />} onClick={onDelete} variant="danger" />
      </header>
      <section className="lxf-section">
        <Field label={t('edge.route')} hint={t('edge.route.hint')}>
          {(id, hint) => (
            <select id={id} aria-describedby={hint} className="lxf-input lxf-select" value={edge.route ?? routes[0] ?? 'success'} onChange={e => onChange({ ...edge, route: e.target.value as EdgeRoute })}>
              {routes.map(r => (
                <option key={r} value={r}>
                  {t(`route.${r}` as never)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </section>
    </div>
  )
}
