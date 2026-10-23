/** Settings → plugin section (`settings.section`). */
import { useEffect, useId, useState, type ReactElement } from 'react'
import { permissionsFor, type KernelPermission, type UpdateSourceMode } from '../api/types.ts'
import { DEFAULT_LANGUAGE, isPluginLanguage, PLUGIN_LANGUAGES } from '../i18n/language.ts'
import type { Translate } from '../i18n/translate.ts'
import type { FlowActions, FlowState } from '../store/flow.ts'
import type { SelectorHook } from '../store/store.ts'
import { avatarFor } from '../ui/avatars.ts'
import { Avatar, Button, Field, Spinner, Switch } from '../ui/glass.tsx'
import { IconWarning } from '../ui/icons.tsx'

/** Kernels enabled by default; mirrors DEFAULT_ENABLED_KERNELS in src/settings.ts. */
export const DEFAULT_SUBAGENT_ON: readonly string[] = ['claude-code', 'codex']
export const DEFAULT_PERMISSION: KernelPermission = 'ask'
const UPDATE_SOURCES: readonly UpdateSourceMode[] = ['auto', 'official', 'mirror']

export function SettingsSection({ t, useFlow, actions }: { t: Translate; useFlow: SelectorHook<FlowState>; actions: FlowActions }): ReactElement {
  const settings = useFlow(s => s.settings)
  const kernels = useFlow(s => s.kernels.items)
  const meta = useFlow(s => s.meta)
  const update = useFlow(s => s.update)
  const [gateway, setGateway] = useState('')
  const [mirror, setMirror] = useState('')
  const warnId = useId()
  const trustId = useId()
  const autoUpdateId = useId()
  useEffect(() => {
    void actions.loadSettings()
    void actions.refreshUpdate()
    void actions.refreshKernels()
    void actions.refreshMeta()
  }, [actions])
  useEffect(() => {
    if (settings.value) {
      setGateway(settings.value.gatewayModel)
      setMirror(settings.value.registryOverride)
    }
  }, [settings.value])

  if (settings.status === 'loading' && !settings.value) return <div className="lxf-root lxf-center"><Spinner label={t('common.loading')} /></div>
  const value = settings.value
  // Script nodes are switched by the plugin config only; this row just reports the effective state.
  const scriptsOn = meta?.scriptsAllowed ?? false
  const gatewayBad = gateway.trim() !== '' && !/^[^/\s]+\/\S+$/.test(gateway.trim())
  const mirrorBad = mirror.trim() !== '' && !isRegistryUrl(mirror.trim())
  const autoCheck = value?.updateAutoCheck ?? update.status?.autoCheck ?? true
  const sourceMode = value?.updateSource ?? update.status?.sourceMode ?? 'auto'
  const saveUpdate = (change: { updateAutoCheck?: boolean; updateSource?: UpdateSourceMode }): void => void actions.saveSettings(change).then(ok => (ok ? actions.refreshUpdate() : undefined))
  const changed = value !== null && (gateway.trim() !== value.gatewayModel || mirror.trim() !== value.registryOverride)

  return (
    <div className="lxf-root lxf-settings">
      <header className="lxf-settings__head">
        <h2 className="lxf-h2">{t('settings.title')}</h2>
        <p className="lxf-muted">{t('settings.detail')}</p>
      </header>
      {settings.status === 'error' && <div className="lxf-callout is-error">{t('settings.loadError')}</div>}
      {settings.error !== null && (
        <div className="lxf-callout is-error" role="alert">
          {settings.error}
        </div>
      )}

      <section className="lxf-card">
        <Field label={t('settings.language')} hint={t('settings.language.hint')}>
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              className="lxf-input lxf-select lxf-select--sm"
              value={value?.language ?? DEFAULT_LANGUAGE}
              disabled={value === null || settings.saving}
              onChange={e => {
                if (isPluginLanguage(e.target.value)) void actions.saveSettings({ language: e.target.value })
              }}
            >
              {PLUGIN_LANGUAGES.map(lang => (
                <option key={lang} value={lang} lang={lang}>
                  {t(`settings.language.${lang}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </section>

      <section className="lxf-card">
        <div className="lxf-settings__sechead">
          <h3 className="lxf-section__title">{t('settings.updates')}</h3>
          <Button size="sm" variant="ghost" disabled={update.checking} aria-busy={update.checking} onClick={() => void actions.checkForUpdates()}>
            {t('toolbar.checkUpdate')}
          </Button>
        </div>
        {update.status !== null && <p className="lxf-field__hint">{t('settings.updateCurrent', { version: update.status.current })}</p>}
        <div className="lxf-togglerow">
          <div>
            <div className="lxf-togglerow__label">{t('settings.updateAuto')}</div>
            <div id={autoUpdateId} className="lxf-field__hint">
              {t('settings.updateAuto.hint')}
            </div>
          </div>
          <Switch checked={autoCheck} disabled={value === null || settings.saving} describedBy={autoUpdateId} label={t('settings.updateAuto')} onChange={on => saveUpdate({ updateAutoCheck: on })} />
        </div>
        <Field label={t('settings.updateSource')} hint={t('settings.updateSource.hint')}>
          {(id, hint) => (
            <select
              id={id}
              aria-describedby={hint}
              className="lxf-input lxf-select lxf-select--sm"
              value={sourceMode}
              disabled={value === null || settings.saving}
              onChange={e => {
                const next = UPDATE_SOURCES.find(m => m === e.target.value)
                if (next !== undefined) saveUpdate({ updateSource: next })
              }}
            >
              {UPDATE_SOURCES.map(mode => (
                <option key={mode} value={mode}>
                  {t(`settings.updateSource.${mode}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </section>

      <section className="lxf-card">
        <div className="lxf-settings__sechead">
          <h3 className="lxf-section__title">{t('settings.gateway')}</h3>
          <Button variant="primary" size="sm" disabled={!changed || gatewayBad || mirrorBad || settings.saving} onClick={() => void actions.saveSettings({ gatewayModel: gateway.trim(), registryOverride: mirror.trim() }).then(ok => ok && actions.toast('success', 'toast.settingsSaved'))}>
            {t('common.save')}
          </Button>
        </div>
        <div className="lxf-settings__pair">
          <Field label={t('settings.gatewayModel')} hint={t('settings.gatewayModel.hint', { current: meta?.upstream ? `${meta.upstream.provider}/${meta.upstream.model}` : '—' })} {...(gatewayBad ? { error: t('settings.gatewayModel.invalid') } : {})}>
            {(id, hint) => <input id={id} aria-describedby={hint} aria-invalid={gatewayBad} className="lxf-input lxf-input--mono" placeholder="deepseek/deepseek-chat" value={gateway} onChange={e => setGateway(e.target.value)} />}
          </Field>
          <Field label={t('settings.mirror')} hint={t('settings.mirror.hint')} {...(mirrorBad ? { error: t('settings.mirror.invalid') } : {})}>
            {(id, hint) => <input id={id} aria-describedby={hint} aria-invalid={mirrorBad} className="lxf-input lxf-input--mono" placeholder="https://registry.npmmirror.com" value={mirror} onChange={e => setMirror(e.target.value)} />}
          </Field>
        </div>
        <div className="lxf-togglerow">
          <div>
            <div className="lxf-togglerow__label">{t('settings.trustMirror')}</div>
            <div id={trustId} className="lxf-field__hint">
              {t('settings.trustMirror.hint')}
            </div>
          </div>
          <Switch
            checked={value?.registryTrustMirror ?? false}
            disabled={value === null || settings.saving}
            describedBy={trustId}
            label={t('settings.trustMirror')}
            onChange={on => void actions.saveSettings({ registryTrustMirror: on })}
          />
        </div>
      </section>

      <section className="lxf-card">
        <div className="lxf-settings__sechead">
          <h3 className="lxf-section__title">{t('settings.defaults')}</h3>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void actions.saveSettings({
                kernels: Object.fromEntries(kernels.map(k => [k.id, { enabled: DEFAULT_SUBAGENT_ON.includes(k.id), permission: permissionsFor(k).includes(DEFAULT_PERMISSION) ? DEFAULT_PERMISSION : 'read-only' }])),
              })
            }
          >
            {t('settings.resetDefaults')}
          </Button>
        </div>
        <p className="lxf-field__hint">{t('settings.defaults.detail')}</p>
        <ul className="lxf-setlist">
          {kernels.map(k => (
            <li key={k.id} className="lxf-setrow">
              <Avatar src={avatarFor(k.avatar || k.id)} alt="" size={28} />
              <span className="lxf-setrow__name">{k.name}</span>
              <select aria-label={t('settings.permissionFor', { name: k.name })} className="lxf-input lxf-select lxf-select--sm" value={k.settings.permission} onChange={e => void actions.updateKernel(k.id, { permission: e.target.value as KernelPermission })}>
                {permissionsFor(k).map(p => (
                  <option key={p} value={p}>
                    {t(`permission.${p}` as never)}
                  </option>
                ))}
              </select>
              <Switch checked={k.settings.enabled} onChange={enabled => void actions.updateKernel(k.id, { enabled })} label={t('kernels.subagentFor', { name: k.name })} />
            </li>
          ))}
        </ul>
      </section>

      <section className="lxf-card">
        <h3 className="lxf-section__title">{t('settings.scripts')}</h3>
        <div className="lxf-togglerow">
          <div>
            <div className="lxf-togglerow__label">{t('settings.scripts.toggle')}</div>
            <div id={warnId} className="lxf-field__hint is-warn">
              <IconWarning size={13} /> {t('settings.scripts.warning')}
            </div>
            <div className="lxf-field__hint">{scriptsOn ? t('settings.scripts.config') : t('settings.scripts.off')}</div>
          </div>
          <Switch checked={scriptsOn} disabled describedBy={warnId} label={t('settings.scripts.toggle')} onChange={() => undefined} />
        </div>
      </section>
    </div>
  )
}

/** Same rule as the Host: https, or http on loopback only; no credentials. */
export function isRegistryUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
}
