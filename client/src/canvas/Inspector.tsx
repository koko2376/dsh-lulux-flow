/**
 * Node / edge inspector: a typed form per node type plus the shared
 * execution policy (retry, timeout, continue-on-failure), workflow inputs on
 * the input node, keyboard-accessible connections, and this node's issues.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { exceeds, permissionsFor, routesFor, type KernelPermission, type EdgeRoute, type KernelInfo, type LintIssue, type Workflow, type WorkflowInputSpec, type WorkflowNode } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import { templateVariables } from '../store/graph.ts'
import { avatarFor } from '../ui/avatars.ts'
import { Avatar, Badge, Button, Field, IconButton, Switch, cx } from '../ui/glass.tsx'
import { IconPlus, IconTrash, IconWarning, NodeIcons } from '../ui/icons.tsx'
import { issueText } from './Canvas.tsx'
import { TemplateField } from './TemplateField.tsx'

export interface InspectorProps {
  workflow: Workflow
  node: WorkflowNode
  issues: readonly (LintIssue & { code?: string })[]
  kernels: readonly KernelInfo[]
  scriptsAllowed: boolean
  t: Translate
  onChange: (node: WorkflowNode) => void
  onWorkflowChange: (update: (wf: Workflow) => Workflow) => void
  onConnect: (source: string, target: string, route: EdgeRoute) => void
  onDelete: () => void
}

const s = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v))

function JsonField({ id, value, onChange, t, describedBy, label }: { id: string; value: unknown; onChange: (v: unknown) => void; t: Translate; describedBy?: string | undefined; label: string }): ReactElement {
  const [text, setText] = useState(() => (value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)))
  const [bad, setBad] = useState(false)
  return (
    <>
      <textarea
        id={id}
        aria-label={label}
        className={cx('lxf-input lxf-input--area lxf-input--mono', bad && 'is-invalid')}
        rows={4}
        value={text}
        spellCheck={false}
        aria-invalid={bad}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        onChange={event => {
          const next = event.target.value
          setText(next)
          if (!next.trim()) {
            setBad(false)
            onChange(undefined)
            return
          }
          try {
            onChange(JSON.parse(next))
            setBad(false)
          } catch {
            setBad(true)
          }
        }}
      />
      {bad && <div className="lxf-field__hint is-error">{t('inspector.jsonInvalid')}</div>}
    </>
  )
}

function Select<T extends string>({ id, value, options, onChange, describedBy }: { id: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void; describedBy?: string | undefined }): ReactElement {
  return (
    <select id={id} className="lxf-input lxf-select" value={value} onChange={event => onChange(event.target.value as T)} {...(describedBy ? { 'aria-describedby': describedBy } : {})}>
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function NumberInput({ id, value, onChange, min, max, step, describedBy }: { id: string; value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; describedBy?: string | undefined }): ReactElement {
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      className="lxf-input"
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
    />
  )
}

export function Inspector(props: InspectorProps): ReactElement {
  const { workflow, node, issues, kernels, scriptsAllowed, t } = props
  const vars = useMemo(() => templateVariables(workflow, node.id), [workflow, node.id])
  const c = node.config
  const set = (key: string, value: unknown): void => {
    const config = { ...node.config }
    if (value === undefined || value === '') delete config[key]
    else config[key] = value
    props.onChange({ ...node, config })
  }
  const template = (key: string, label: string, opts: { multiline?: boolean; rows?: number; placeholder?: string; hint?: string; mono?: boolean } = {}): ReactElement => (
    <Field label={label} {...(opts.hint ? { hint: opts.hint } : {})}>
      {(id, hint) => (
        <TemplateField
          id={id}
          label={label}
          listLabel={t('inspector.variables')}
          value={s(c[key])}
          onChange={v => set(key, v)}
          variables={vars}
          {...(opts.multiline ? { multiline: true } : {})}
          {...(opts.rows ? { rows: opts.rows } : {})}
          {...(opts.placeholder ? { placeholder: opts.placeholder } : {})}
          {...(opts.mono ? { mono: true } : {})}
          describedBy={hint}
        />
      )}
    </Field>
  )
  /** Privilege fields (working directory, preset) take fixed text only: no variable completion. */
  const literal = (key: string, label: string, placeholder?: string): ReactElement => (
    <Field label={label} hint={t('inspector.literal')}>
      {(id, hint) => <input id={id} aria-describedby={hint} className="lxf-input lxf-input--mono" value={s(c[key])} {...(placeholder ? { placeholder } : {})} onChange={e => set(key, e.target.value)} />}
    </Field>
  )
  const kernelInfo = node.type === 'kernel' ? kernels.find(k => k.id === c.kernel) : undefined
  const kernelPermissions = permissionsFor(kernelInfo)
  const permissionValue = (s(c.permission) || 'ask') as KernelPermission
  const permissionOptions = (kernelPermissions.includes(permissionValue) ? kernelPermissions : [...kernelPermissions, permissionValue]).map(p => ({
    value: p,
    label: kernelPermissions.includes(p) ? t(`permission.${p}` as never) : t('inspector.permission.unsupported', { label: t(`permission.${p}` as never) }),
  }))
  const overCeiling =
    kernelInfo !== undefined && ((c.permission !== undefined && exceeds(permissionValue, kernelInfo.settings.permission)) || (c.mode === 'global' && kernelInfo.settings.mode !== 'global'))
  const Icon = NodeIcons[node.type]
  const executable = !['input', 'output'].includes(node.type)
  const routes = routesFor(node.type)
  const targets = workflow.nodes.filter(n => n.id !== node.id && n.type !== 'input')
  const [connectTo, setConnectTo] = useState<Record<string, string>>({})

  return (
    <div className="lxf-inspector" aria-label={t('inspector.aria', { name: node.name })}>
      <header className="lxf-inspector__head">
        <span className={cx('lxf-node__icon', `lxf-node--${node.type}`)}>
          <Icon size={16} />
        </span>
        <div className="lxf-inspector__titles">
          <div className="lxf-inspector__type">{t(`node.type.${node.type}` as never)}</div>
          <div className="lxf-inspector__id">
            <code>{node.id}</code>
          </div>
        </div>
        <IconButton label={t('inspector.deleteNode')} icon={<IconTrash />} onClick={props.onDelete} variant="danger" />
      </header>

      {issues.length > 0 && (
        <ul className="lxf-issues lxf-issues--inline" aria-label={t('issues.title')}>
          {issues.map((issue, i) => (
            <li key={i} className={cx('lxf-issue', `is-${issue.level}`)}>
              <IconWarning size={13} />
              <span>{issueText(t, issue)}</span>
            </li>
          ))}
        </ul>
      )}

      <section className="lxf-section" aria-label={t('inspector.general')}>
        <Field label={t('inspector.name')}>{id => <input id={id} className="lxf-input" maxLength={120} value={node.name} onChange={e => props.onChange({ ...node, name: e.target.value })} />}</Field>

        {node.type === 'input' && <InputsEditor t={t} inputs={workflow.inputs ?? []} onChange={inputs => props.onWorkflowChange(wf => ({ ...wf, inputs }))} />}

        {node.type === 'output' && template('value', t('inspector.output.value'), { multiline: true, rows: 3, placeholder: '{{ nodes.agent.output }}', hint: t('inspector.output.hint') })}

        {node.type === 'agent' && (
          <>
            {template('prompt', t('inspector.prompt'), { multiline: true, rows: 6, placeholder: t('inspector.prompt.placeholder') })}
            {template('system', t('inspector.system'), { multiline: true, rows: 3 })}
            <div className="lxf-grid2">
              {template('model', t('inspector.model'), { placeholder: 'provider/model' })}
              {literal('preset', t('inspector.preset'))}
            </div>
            {literal('cwd', t('inspector.cwd'))}
            <ToggleRow label={t('inspector.parseJson')} checked={c.parseJson !== false} onChange={v => set('parseJson', v ? undefined : false)} />
          </>
        )}

        {node.type === 'kernel' && (
          <>
            <fieldset className="lxf-kernelpick">
              <legend className="lxf-field__label">{t('inspector.kernel')}</legend>
              <div className="lxf-kernelpick__row" role="radiogroup" aria-label={t('inspector.kernel')}>
                {(kernels.length > 0 ? kernels.map(k => ({ id: k.id, name: k.name, installed: k.installed })) : ['claude-code', 'codex', 'gemini-cli', 'qwen-code', 'grok'].map(id => ({ id, name: id, installed: true }))).map(k => (
                  <button
                    key={k.id}
                    type="button"
                    role="radio"
                    aria-checked={c.kernel === k.id}
                    className={cx('lxf-kernelpick__item', c.kernel === k.id && 'is-active', !k.installed && 'is-missing')}
                    onClick={() => set('kernel', k.id)}
                    title={k.installed ? k.name : `${k.name} · ${t('kernels.notInstalled')}`}
                  >
                    <Avatar src={avatarFor(k.id)} alt="" size={30} />
                    <span>{k.name}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            {template('prompt', t('inspector.prompt'), { multiline: true, rows: 6, placeholder: t('inspector.prompt.placeholder') })}
            <div className="lxf-grid2">
              <Field label={t('inspector.permission')}>
                {id => <Select id={id} value={permissionValue} options={permissionOptions} onChange={v => set('permission', v)} />}
              </Field>
              <Field label={t('inspector.mode')}>
                {id => (
                  <Select
                    id={id}
                    value={s(c.mode) || 'default'}
                    options={[
                      { value: 'default', label: t('inspector.mode.default') },
                      { value: 'scoped', label: t('mode.scoped') },
                      { value: 'global', label: t('mode.global') },
                    ]}
                    onChange={v => set('mode', v === 'default' ? undefined : v)}
                  />
                )}
              </Field>
            </div>
            <p className={cx('lxf-field__hint', overCeiling && 'is-warn')} role={overCeiling ? 'status' : undefined}>
              {overCeiling && <IconWarning size={13} />}{' '}
              {kernelInfo
                ? t('inspector.kernel.ceiling', { name: kernelInfo.name, permission: t(`permission.${kernelInfo.settings.permission}` as never), mode: t(`mode.${kernelInfo.settings.mode}` as never) })
                : t('inspector.kernel.ceilingAny')}
            </p>
            {c.permission === 'full' && <div className="lxf-callout is-warn">{t('permission.fullWarning')}</div>}
            <div className="lxf-grid2">
              {template('model', t('inspector.model'), { placeholder: 'provider/model' })}
              {literal('cwd', t('inspector.cwd'))}
            </div>
            <p className="lxf-field__hint">{t('inspector.kernel.literal')}</p>
            <ToggleRow label={t('inspector.parseJson')} checked={c.parseJson !== false} onChange={v => set('parseJson', v ? undefined : false)} />
          </>
        )}

        {node.type === 'script' && (
          <>
            {!scriptsAllowed && <div className="lxf-callout is-warn">{t('inspector.script.disabled')}</div>}
            {template('code', t('inspector.code'), { multiline: true, rows: 9, mono: true, hint: t('inspector.code.hint') })}
          </>
        )}

        {node.type === 'http' && (
          <>
            <div className="lxf-grid-method">
              <Field label={t('inspector.method')}>
                {id => <Select id={id} value={s(c.method) || 'GET'} options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(m => ({ value: m, label: m }))} onChange={v => set('method', v)} />}
              </Field>
              {template('url', t('inspector.url'), { placeholder: 'https://' })}
            </div>
            <Field label={t('inspector.headers')} hint={t('inspector.json.hint')}>
              {(id, hint) => <JsonField id={id} label={t('inspector.headers')} value={c.headers} onChange={v => set('headers', v)} t={t} describedBy={hint} />}
            </Field>
            {template('body', t('inspector.body'), { multiline: true, rows: 4, mono: true })}
            <Field label={t('inspector.expectStatus')}>{id => <NumberInput id={id} value={c.expectStatus as number | undefined} min={100} max={599} onChange={v => set('expectStatus', v)} />}</Field>
          </>
        )}

        {node.type === 'condition' && template('expression', t('inspector.expression'), { mono: true, placeholder: 'nodes.review.output.score >= 0.8', hint: t('inspector.expression.hint') })}

        {node.type === 'loop' && (
          <>
            <Field label={t('inspector.loop.mode')}>
              {id => (
                <Select
                  id={id}
                  value={(s(c.mode) || 'items') as 'items' | 'count' | 'until'}
                  options={(['items', 'count', 'until'] as const).map(m => ({ value: m, label: t(`inspector.loop.${m}` as never) }))}
                  onChange={v => set('mode', v)}
                />
              )}
            </Field>
            {(s(c.mode) || 'items') === 'items' && template('items', t('inspector.loop.itemsField'), { placeholder: '{{ nodes.list.output.items }}' })}
            {s(c.mode) === 'count' && template('count', t('inspector.loop.countField'))}
            {s(c.mode) === 'until' && template('until', t('inspector.loop.untilField'), { mono: true, placeholder: 'loop.previous.done == true' })}
            <Field label={t('inspector.loop.max')}>{id => <NumberInput id={id} value={Number(c.maxIterations ?? 10)} min={1} max={100} onChange={v => set('maxIterations', v)} />}</Field>
            <LoopBody t={t} body={(c.body ?? { type: 'agent', config: {} }) as { type: string; config?: Record<string, unknown> }} vars={vars} kernels={kernels} onChange={body => set('body', body)} />
          </>
        )}

        {node.type === 'approval' && (
          <>
            <p className="lxf-field__hint">{t('inspector.approval.hint')}</p>
            {template('message', t('inspector.approval.message'), { multiline: true, rows: 3 })}
            <div className="lxf-grid2">
              <Field label={t('inspector.approval.timeout')}>{id => <NumberInput id={id} value={c.timeoutMs ? Number(c.timeoutMs) / 60000 : undefined} min={0} onChange={v => set('timeoutMs', v ? Math.round(v * 60000) : undefined)} />}</Field>
              <Field label={t('inspector.approval.onTimeout')}>
                {id => (
                  <Select
                    id={id}
                    value={(s(c.onTimeout) || 'reject') as 'reject' | 'approve'}
                    options={[
                      { value: 'reject', label: t('inspector.approval.reject') },
                      { value: 'approve', label: t('inspector.approval.approve') },
                    ]}
                    onChange={v => set('onTimeout', v)}
                  />
                )}
              </Field>
            </div>
          </>
        )}

        {node.type === 'notify' && (
          <>
            {template('url', t('inspector.notify.url'), { placeholder: 'https://hooks.example.com/…' })}
            <Field label={t('inspector.notify.format')}>
              {id => <Select id={id} value={s(c.format) || 'json'} options={['json', 'slack', 'feishu', 'dingtalk', 'wecom', 'discord'].map(f => ({ value: f, label: t(`notify.${f}` as never) }))} onChange={v => set('format', v)} />}
            </Field>
            {template('message', t('inspector.notify.message'), { multiline: true, rows: 3 })}
            <Field label={t('inspector.headers')} hint={t('inspector.json.hint')}>
              {(id, hint) => <JsonField id={id} label={t('inspector.headers')} value={c.headers} onChange={v => set('headers', v)} t={t} describedBy={hint} />}
            </Field>
          </>
        )}
      </section>

      {executable && (
        <section className="lxf-section" aria-labelledby={`${node.id}-policy`}>
          <h3 id={`${node.id}-policy`} className="lxf-section__title">
            {t('inspector.policy')}
          </h3>
          <div className="lxf-grid2">
            <Field label={t('inspector.retry')} hint={t('inspector.retry.hint')}>
              {(id, hint) => (
                <NumberInput
                  id={id}
                  describedBy={hint}
                  value={node.retry?.max ?? 0}
                  min={0}
                  max={10}
                  onChange={v => {
                    const { retry: _drop, ...rest } = node
                    props.onChange(v ? { ...rest, retry: { max: v, backoffMs: node.retry?.backoffMs ?? 1000 } } : rest)
                  }}
                />
              )}
            </Field>
            <Field label={t('inspector.backoff')}>
              {id => (
                <NumberInput
                  id={id}
                  value={node.retry ? node.retry.backoffMs / 1000 : undefined}
                  min={0}
                  step={0.5}
                  onChange={v => node.retry && props.onChange({ ...node, retry: { ...node.retry, backoffMs: Math.round((v ?? 1) * 1000) } })}
                />
              )}
            </Field>
          </div>
          <Field label={t('inspector.timeout')} hint={t('inspector.timeout.hint')}>
            {(id, hint) => (
              <NumberInput
                id={id}
                describedBy={hint}
                value={node.timeoutMs ? node.timeoutMs / 1000 : undefined}
                min={1}
                onChange={v => {
                  const { timeoutMs: _drop, ...rest } = node
                  props.onChange(v ? { ...rest, timeoutMs: Math.round(v * 1000) } : rest)
                }}
              />
            )}
          </Field>
          <ToggleRow
            label={t('inspector.continueOnFailure')}
            hint={t('inspector.continueOnFailure.hint')}
            checked={node.continueOnFailure === true}
            onChange={v => {
              const { continueOnFailure: _drop, ...rest } = node
              props.onChange(v ? { ...rest, continueOnFailure: true } : rest)
            }}
          />
        </section>
      )}

      {routes.length > 0 && targets.length > 0 && (
        <section className="lxf-section" aria-labelledby={`${node.id}-connect`}>
          <h3 id={`${node.id}-connect`} className="lxf-section__title">
            {t('inspector.connections')}
          </h3>
          {routes.map(route => {
            const existing = workflow.edges.filter(e => e.source === node.id && (e.route ?? (node.type === 'condition' ? 'true' : 'success')) === route)
            return (
              <div key={route} className="lxf-connect">
                <Badge tone={route === 'success' || route === 'true' ? 'success' : 'error'}>{t(`route.${route}` as never)}</Badge>
                <span className="lxf-connect__targets">{existing.length > 0 ? existing.map(e => workflow.nodes.find(n => n.id === e.target)?.name ?? e.target).join(', ') : t('inspector.noTargets')}</span>
                <select
                  aria-label={t('inspector.connectRoute', { route: t(`route.${route}` as never) })}
                  className="lxf-input lxf-select lxf-select--sm"
                  value={connectTo[route] ?? ''}
                  onChange={event => setConnectTo(m => ({ ...m, [route]: event.target.value }))}
                >
                  <option value="">{t('inspector.pickTarget')}</option>
                  {targets.map(n => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>
                <IconButton
                  label={t('inspector.connect')}
                  icon={<IconPlus />}
                  disabled={!connectTo[route]}
                  onClick={() => {
                    const target = connectTo[route]
                    if (target) props.onConnect(node.id, target, route)
                    setConnectTo(m => ({ ...m, [route]: '' }))
                  }}
                />
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }): ReactElement {
  return (
    <div className="lxf-togglerow">
      <div>
        <div className="lxf-togglerow__label">{label}</div>
        {hint && <div className="lxf-field__hint">{hint}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  )
}

function LoopBody({ t, body, vars, kernels, onChange }: { t: Translate; body: { type: string; config?: Record<string, unknown> }; vars: readonly string[]; kernels: readonly KernelInfo[]; onChange: (b: { type: string; config: Record<string, unknown> }) => void }): ReactElement {
  const config = body.config ?? {}
  const setCfg = (key: string, value: unknown): void => onChange({ type: body.type, config: { ...config, [key]: value } })
  return (
    <fieldset className="lxf-subform">
      <legend className="lxf-section__title">{t('inspector.loop.body')}</legend>
      <Field label={t('inspector.loop.bodyType')}>
        {id => <Select id={id} value={body.type} options={['agent', 'kernel', 'script', 'http'].map(v => ({ value: v, label: t(`node.type.${v}` as never) }))} onChange={v => onChange({ type: v, config: v === 'http' ? { method: 'GET', url: '' } : v === 'script' ? { code: '' } : v === 'kernel' ? { kernel: kernels[0]?.id ?? 'claude-code', prompt: '{{ loop.item }}' } : { prompt: '{{ loop.item }}' } })} />}
      </Field>
      {body.type === 'kernel' && (
        <Field label={t('inspector.kernel')}>
          {id => <Select id={id} value={s(config.kernel) || 'claude-code'} options={(kernels.length ? kernels.map(k => ({ value: k.id, label: k.name })) : [{ value: 'claude-code', label: 'Claude Code' }])} onChange={v => setCfg('kernel', v)} />}
        </Field>
      )}
      {(body.type === 'agent' || body.type === 'kernel') && (
        <Field label={t('inspector.prompt')}>
          {id => <TemplateField id={id} label={t('inspector.prompt')} listLabel={t('inspector.variables')} value={s(config.prompt)} onChange={v => setCfg('prompt', v)} variables={vars} multiline rows={4} />}
        </Field>
      )}
      {body.type === 'script' && (
        <Field label={t('inspector.code')}>
          {id => <TemplateField id={id} label={t('inspector.code')} listLabel={t('inspector.variables')} value={s(config.code)} onChange={v => setCfg('code', v)} variables={vars} multiline rows={5} mono />}
        </Field>
      )}
      {body.type === 'http' && (
        <Field label={t('inspector.url')}>
          {id => <TemplateField id={id} label={t('inspector.url')} listLabel={t('inspector.variables')} value={s(config.url)} onChange={v => setCfg('url', v)} variables={vars} />}
        </Field>
      )}
    </fieldset>
  )
}

function InputsEditor({ t, inputs, onChange }: { t: Translate; inputs: readonly WorkflowInputSpec[]; onChange: (inputs: WorkflowInputSpec[]) => void }): ReactElement {
  const update = (i: number, next: Partial<WorkflowInputSpec>): void => onChange(inputs.map((input, j) => (j === i ? { ...input, ...next } : input)))
  return (
    <fieldset className="lxf-subform">
      <legend className="lxf-section__title">{t('inspector.inputs')}</legend>
      {inputs.length === 0 && <div className="lxf-field__hint">{t('inspector.inputs.empty')}</div>}
      {inputs.map((input, i) => (
        <div key={i} className="lxf-inputrow">
          <input aria-label={t('inspector.inputs.name')} className="lxf-input lxf-input--mono" value={input.name} placeholder="topic" onChange={e => update(i, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} />
          <select aria-label={t('inspector.inputs.type')} className="lxf-input lxf-select" value={input.type} onChange={e => update(i, { type: e.target.value as WorkflowInputSpec['type'] })}>
            {(['string', 'number', 'boolean', 'json'] as const).map(type => (
              <option key={type} value={type}>
                {t(`inputType.${type}` as never)}
              </option>
            ))}
          </select>
          <label className="lxf-check">
            <input type="checkbox" checked={input.required === true} onChange={e => update(i, { required: e.target.checked })} />
            <span>{t('inspector.inputs.required')}</span>
          </label>
          <IconButton label={t('inspector.inputs.remove', { name: input.name || String(i + 1) })} icon={<IconTrash />} onClick={() => onChange(inputs.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="sm" icon={<IconPlus />} onClick={() => onChange([...inputs, { name: `input${inputs.length + 1}`, type: 'string' }])}>
        {t('inspector.inputs.add')}
      </Button>
    </fieldset>
  )
}
