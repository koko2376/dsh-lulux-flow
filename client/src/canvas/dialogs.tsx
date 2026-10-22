/** Workflow dialogs: AI generate, import, run inputs, triggers. */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { CronTrigger, WebhookInfo, WebhookSecret, Workflow } from '../api/types.ts'
import { ROUTE_ROOT } from '../brand.ts'
import type { Translate } from '../i18n/translate.ts'
import { uniqueId } from '../store/graph.ts'
import { Badge, Button, Dialog, Field, IconButton, Switch } from '../ui/glass.tsx'
import { IconCopy, IconPlay, IconPlus, IconSparkles, IconTrash, IconUpload } from '../ui/icons.tsx'

export function GenerateDialog({ open, onClose, t, onGenerate }: { open: boolean; onClose: () => void; t: Translate; onGenerate: (description: string) => Promise<boolean> }): ReactElement {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const examples = [t('generate.example1'), t('generate.example2'), t('generate.example3')]
  const submit = async (): Promise<void> => {
    if (!text.trim() || busy) return
    setBusy(true)
    const ok = await onGenerate(text.trim())
    setBusy(false)
    if (ok) {
      setText('')
      onClose()
    }
  }
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={t('generate.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={<IconSparkles />} onClick={() => void submit()} disabled={!text.trim() || busy} aria-busy={busy}>
            {busy ? t('generate.working') : t('generate.submit')}
          </Button>
        </>
      }
    >
      <p className="lxf-muted">{t('generate.detail')}</p>
      <Field label={t('generate.label')}>
        {id => (
          <textarea
            id={id}
            data-autofocus
            rows={5}
            className="lxf-input lxf-input--area"
            value={text}
            placeholder={t('generate.placeholder')}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
        )}
      </Field>
      <div className="lxf-chips" role="list" aria-label={t('generate.examples')}>
        {examples.map(example => (
          <button key={example} role="listitem" type="button" className="lxf-chip lxf-chip--button" onClick={() => setText(example)}>
            {example}
          </button>
        ))}
      </div>
      {busy && <div className="lxf-shimmer" aria-hidden="true" />}
    </Dialog>
  )
}

export function ImportDialog({ open, onClose, t, onImport }: { open: boolean; onClose: () => void; t: Translate; onImport: (json: string) => Promise<boolean> }): ReactElement {
  const [text, setText] = useState('')
  const file = useRef<HTMLInputElement | null>(null)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('import.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<IconUpload />}
            disabled={!text.trim()}
            onClick={() =>
              void onImport(text).then(ok => {
                if (ok) {
                  setText('')
                  onClose()
                }
              })
            }
          >
            {t('import.submit')}
          </Button>
        </>
      }
    >
      <p className="lxf-muted">{t('import.detail')}</p>
      <div className="lxf-row">
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          className="lxf-visually-hidden"
          aria-label={t('import.file')}
          onChange={async e => {
            const f = e.target.files?.[0]
            if (f) setText(await f.text())
          }}
        />
        <Button size="sm" onClick={() => file.current?.click()}>
          {t('import.file')}
        </Button>
      </div>
      <Field label={t('import.paste')}>{id => <textarea id={id} rows={10} className="lxf-input lxf-input--area lxf-input--mono" value={text} onChange={e => setText(e.target.value)} placeholder='{ "workflow": { … } }' />}</Field>
    </Dialog>
  )
}

export function RunDialog({ open, onClose, t, workflow, onRun }: { open: boolean; onClose: () => void; t: Translate; workflow: Workflow; onRun: (inputs: Record<string, unknown>) => void }): ReactElement {
  const specs = workflow.inputs ?? []
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    if (open) setValues(Object.fromEntries(specs.map(s => [s.name, s.default === undefined ? '' : typeof s.default === 'string' ? s.default : JSON.stringify(s.default)])))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (): void => {
    const inputs: Record<string, unknown> = {}
    for (const spec of specs) {
      const raw = values[spec.name] ?? ''
      if (!raw && spec.required) return setError(t('runDialog.required', { name: spec.name }))
      if (!raw) continue
      try {
        inputs[spec.name] = spec.type === 'number' ? Number(raw) : spec.type === 'boolean' ? raw === 'true' : spec.type === 'json' ? JSON.parse(raw) : raw
      } catch {
        return setError(t('runDialog.badJson', { name: spec.name }))
      }
    }
    onRun(inputs)
    onClose()
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('runDialog.title', { name: workflow.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={<IconPlay />} onClick={submit}>
            {t('runDialog.submit')}
          </Button>
        </>
      }
    >
      {specs.length === 0 && <p className="lxf-muted">{t('runDialog.noInputs')}</p>}
      {specs.map(spec => (
        <Field key={spec.name} label={`${spec.name}${spec.required ? ' *' : ''}`} {...(spec.description ? { hint: spec.description } : {})}>
          {(id, hint) =>
            spec.type === 'boolean' ? (
              <select id={id} aria-describedby={hint} className="lxf-input lxf-select" value={values[spec.name] ?? ''} onChange={e => setValues(v => ({ ...v, [spec.name]: e.target.value }))}>
                <option value="" />
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : spec.type === 'json' ? (
              <textarea id={id} aria-describedby={hint} rows={4} className="lxf-input lxf-input--area lxf-input--mono" value={values[spec.name] ?? ''} onChange={e => setValues(v => ({ ...v, [spec.name]: e.target.value }))} />
            ) : (
              <input id={id} aria-describedby={hint} type={spec.type === 'number' ? 'number' : 'text'} className="lxf-input" value={values[spec.name] ?? ''} onChange={e => setValues(v => ({ ...v, [spec.name]: e.target.value }))} />
            )
          }
        </Field>
      ))}
      {error && <div className="lxf-callout is-error">{error}</div>}
    </Dialog>
  )
}

export interface TriggersDialogProps {
  open: boolean
  onClose: () => void
  t: Translate
  workflow: Workflow
  webhook: WebhookInfo | null
  locale: string
  onChange: (update: (wf: Workflow) => Workflow) => void
  onRotate: () => Promise<WebhookSecret | undefined>
  onRevoke: () => Promise<void>
  onPreview: (expression: string) => Promise<string[]>
  onRunNow: () => void
}

function CronRow({ trigger, t, locale, onPreview, onChange, onRemove }: { trigger: CronTrigger; t: Translate; locale: string; onPreview: (e: string) => Promise<string[]>; onChange: (c: CronTrigger) => void; onRemove: () => void }): ReactElement {
  const [next, setNext] = useState<string[] | null>(null)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => void onPreview(trigger.expression).then(n => live && setNext(n)), 350)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [trigger.expression, onPreview])
  return (
    <div className="lxf-cron">
      <div className="lxf-cron__row">
        <input aria-label={t('triggers.cron.expression')} className="lxf-input lxf-input--mono" value={trigger.expression} placeholder="0 9 * * 1-5" onChange={e => onChange({ ...trigger, expression: e.target.value })} />
        <Switch checked={trigger.enabled} onChange={enabled => onChange({ ...trigger, enabled })} label={t('triggers.cron.enabled')} />
        <IconButton label={t('triggers.cron.remove')} icon={<IconTrash />} onClick={onRemove} />
      </div>
      <div className="lxf-field__hint" aria-live="polite">
        {next === null ? '…' : next.length === 0 ? <span className="is-error">{t('triggers.cron.invalid')}</span> : t('triggers.cron.next', { times: next.map(n => new Date(n).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })).join(' · ') })}
      </div>
    </div>
  )
}

export function TriggersDialog(props: TriggersDialogProps): ReactElement {
  const { open, onClose, t, workflow, webhook, locale, onChange } = props
  const [secret, setSecret] = useState<WebhookSecret | null>(null)
  const [copied, setCopied] = useState(false)
  const cron = workflow.triggers?.cron ?? []
  const hookOn = workflow.triggers?.webhook?.enabled === true
  const setCron = (list: CronTrigger[]): void => onChange(wf => ({ ...wf, triggers: { ...wf.triggers, cron: list } }))
  const url = typeof location !== 'undefined' ? `${location.origin}${webhook?.path ?? `${ROUTE_ROOT}/hooks/${workflow.id}`}` : webhook?.path ?? ''
  return (
    <Dialog
      open={open}
      onClose={() => {
        setSecret(null)
        onClose()
      }}
      wide
      title={t('triggers.title')}
      footer={
        <Button
          variant="primary"
          onClick={() => {
            setSecret(null)
            onClose()
          }}
        >
          {t('common.done')}
        </Button>
      }
    >
      <section className="lxf-trigger">
        <div className="lxf-trigger__head">
          <IconPlay />
          <div>
            <div className="lxf-trigger__title">{t('triggers.manual')}</div>
            <div className="lxf-muted">{t('triggers.manual.detail')}</div>
          </div>
          <Button size="sm" icon={<IconPlay />} onClick={props.onRunNow}>
            {t('toolbar.run')}
          </Button>
        </div>
      </section>

      <section className="lxf-trigger">
        <div className="lxf-trigger__head">
          <div>
            <div className="lxf-trigger__title">{t('triggers.cron')}</div>
            <div className="lxf-muted">{t('triggers.cron.detail')}</div>
          </div>
          <Button size="sm" icon={<IconPlus />} onClick={() => setCron([...cron, { id: uniqueId('cron', cron.map(c => c.id)), expression: '0 9 * * 1-5', enabled: true }])}>
            {t('triggers.cron.add')}
          </Button>
        </div>
        {cron.map((trigger, i) => (
          <CronRow
            key={trigger.id}
            trigger={trigger}
            t={t}
            locale={locale}
            onPreview={props.onPreview}
            onChange={c => setCron(cron.map((x, j) => (j === i ? c : x)))}
            onRemove={() => setCron(cron.filter((_, j) => j !== i))}
          />
        ))}
        {cron.length > 0 && <div className="lxf-field__hint">{t('triggers.cron.saveHint')}</div>}
      </section>

      <section className="lxf-trigger">
        <div className="lxf-trigger__head">
          <div>
            <div className="lxf-trigger__title">{t('triggers.webhook')}</div>
            <div className="lxf-muted">{t('triggers.webhook.detail')}</div>
          </div>
          <Switch checked={hookOn} onChange={enabled => onChange(wf => ({ ...wf, triggers: { ...wf.triggers, webhook: { enabled } } }))} label={t('triggers.webhook.enabled')} />
        </div>
        <div className="lxf-kv">
          <span>{t('triggers.webhook.url')}</span>
          <code className="lxf-select-all">{url}</code>
          <span>{t('triggers.webhook.secret')}</span>
          <span>{webhook?.configured ? <Badge tone="success">{t('triggers.webhook.fingerprint', { fp: webhook.fingerprint ?? '' })}</Badge> : <Badge>{t('triggers.webhook.none')}</Badge>}</span>
        </div>
        {secret && (
          <div className="lxf-secret" role="alert">
            <div className="lxf-secret__title">{t('triggers.webhook.once')}</div>
            <div className="lxf-secret__row">
              <code className="lxf-select-all">{secret.secret}</code>
              <IconButton
                label={copied ? t('common.copied') : t('common.copy')}
                icon={<IconCopy />}
                onClick={() => {
                  void navigator.clipboard?.writeText(secret.secret).then(() => setCopied(true))
                }}
              />
            </div>
            <div className="lxf-field__hint">{t('triggers.webhook.sign')}</div>
          </div>
        )}
        <div className="lxf-row">
          <Button
            size="sm"
            onClick={() =>
              void props.onRotate().then(s => {
                setCopied(false)
                setSecret(s ?? null)
              })
            }
          >
            {webhook?.configured ? t('triggers.webhook.rotate') : t('triggers.webhook.create')}
          </Button>
          {webhook?.configured && (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                void props.onRevoke().then(() => {
                  setSecret(null)
                })
              }
            >
              {t('triggers.webhook.revoke')}
            </Button>
          )}
        </div>
      </section>
    </Dialog>
  )
}
