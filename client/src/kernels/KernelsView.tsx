/** Kernels: installed CLIs, install/update with progress, mirror ranking, mode, permission, test. */
import { useState, type ReactElement } from 'react'
import { permissionsFor, type KernelInfo, type KernelPermission, type ProbeResult } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import type { FlowActions, FlowState, KernelTest } from '../store/flow.ts'
import type { SelectorHook } from '../store/store.ts'
import { avatarFor } from '../ui/avatars.ts'
import { Avatar, Badge, Button, Empty, IconButton, Segmented, Spinner, Switch, cx } from '../ui/glass.tsx'
import { IconBeaker, IconDownload, IconGauge, IconRefresh, IconShield } from '../ui/icons.tsx'

export function KernelsView({ t, useFlow, actions }: { t: Translate; useFlow: SelectorHook<FlowState>; actions: FlowActions }): ReactElement {
  const kernels = useFlow(s => s.kernels)
  const override = useFlow(s => s.settings.value?.registryOverride ?? '')
  const ranked = kernels.registries
  const results = [...(ranked?.results ?? [])].sort((a, b) => Number(b.ok) - Number(a.ok) || b.score - a.score)
  const chosen = override || results.find(r => r.ok && r.trusted && r.satisfies)?.registry
  return (
    <div className="lxf-kernels">
      <header className="lxf-kernels__head">
        <div>
          <h2 className="lxf-h2">{t('kernels.title')}</h2>
          <p className="lxf-muted">{t('kernels.detail')}</p>
        </div>
        <Button icon={<IconRefresh />} onClick={() => void actions.refreshKernels(true)}>
          {t('kernels.rescan')}
        </Button>
      </header>
      <div className="lxf-kernels__layout">
        <div className="lxf-kernels__grid">
          {kernels.status === 'loading' && <div className="lxf-center"><Spinner label={t('common.loading')} /></div>}
          {kernels.status === 'error' && <Empty title={t('kernels.loadError')} action={<Button onClick={() => void actions.refreshKernels()}>{t('common.retry')}</Button>} />}
          {kernels.items.map(kernel => (
            <KernelCard key={kernel.id} kernel={kernel} t={t} test={kernels.tests[kernel.id]} actions={actions} />
          ))}
        </div>
        <aside className="lxf-glass lxf-mirrors" aria-labelledby="lxf-mirrors-title">
          <div className="lxf-mirrors__head">
            <IconGauge />
            <h3 id="lxf-mirrors-title" className="lxf-section__title">
              {t('mirrors.title')}
            </h3>
            <IconButton label={t('mirrors.probe')} icon={<IconRefresh />} onClick={() => void actions.probeRegistries(true)} disabled={kernels.probing} />
          </div>
          <p className="lxf-muted">{override ? t('mirrors.override', { url: override }) : t('mirrors.detail')}</p>
          {kernels.probing && results.length === 0 && <div className="lxf-center"><Spinner label={t('mirrors.probing')} /></div>}
          <ol className="lxf-mirrors__list" aria-busy={kernels.probing}>
            {results.map((r, i) => (
              <MirrorRow key={r.registry} r={r} rank={i + 1} chosen={chosen === r.registry} best={results[0]?.latencyMs ?? 1} t={t} />
            ))}
          </ol>
          {ranked?.referenceVersion && <p className="lxf-field__hint">{t('mirrors.reference', { version: ranked.referenceVersion, pkg: ranked.packageName })}</p>}
        </aside>
      </div>
    </div>
  )
}

function MirrorRow({ r, rank, chosen, best, t }: { r: ProbeResult; rank: number; chosen: boolean; best: number; t: Translate }): ReactElement {
  const host = (() => {
    try {
      return new URL(r.registry).host
    } catch {
      return r.registry
    }
  })()
  const width = r.ok ? Math.max(8, Math.min(100, (best / Math.max(1, r.latencyMs)) * 100)) : 0
  return (
    <li className={cx('lxf-mirror', chosen && 'is-chosen', !r.ok && 'is-down')}>
      <span className="lxf-mirror__rank">{rank}</span>
      <span className="lxf-mirror__main">
        <span className="lxf-mirror__host">
          <span className="lxf-mirror__name">{host}</span>
          {chosen && <Badge tone="accent">{t('mirrors.chosen')}</Badge>}
          {r.ok && !r.trusted && <Badge tone="warn">{t('mirrors.untrusted')}</Badge>}
        </span>
        <span className="lxf-mirror__bar" aria-hidden="true">
          <span style={{ width: `${width}%` }} />
        </span>
      </span>
      <span className="lxf-mirror__ms">{r.ok ? t('mirrors.ms', { ms: r.latencyMs }) : t('mirrors.down')}</span>
    </li>
  )
}

function KernelCard({ kernel, t, test, actions }: { kernel: KernelInfo; t: Translate; test: KernelTest | undefined; actions: FlowActions }): ReactElement {
  const install = kernel.install
  const busy = install.status === 'installing' || install.status === 'probing'
  const [showLog, setShowLog] = useState(false)
  const outdated = kernel.installed && !kernel.versionOk
  return (
    <article className={cx('lxf-glass', 'lxf-kcard', busy && 'is-busy')} style={{ ['--lxf-kernel' as string]: kernel.color }} aria-labelledby={`k-${kernel.id}`}>
      <header className="lxf-kcard__head">
        <Avatar src={avatarFor(kernel.avatar || kernel.id)} alt="" size={48} />
        <div className="lxf-kcard__titles">
          <div className="lxf-kcard__row">
            <h3 id={`k-${kernel.id}`} className="lxf-kcard__name">
              {kernel.name}
            </h3>
            {kernel.installed ? (
              <Badge tone={outdated ? 'warn' : 'success'} title={outdated ? t('kernels.needs', { min: kernel.minVersion }) : undefined}>
                {kernel.version ? `v${kernel.version}` : t('kernels.installed')}
              </Badge>
            ) : (
              <Badge>{t('kernels.notInstalled')}</Badge>
            )}
          </div>
          <div className="lxf-kcard__vendor">{kernel.vendor}</div>
          <code className="lxf-kcard__pkg" title={kernel.npmPackage}>
            {kernel.npmPackage}
          </code>
        </div>
      </header>

      {busy && (
        <div className="lxf-kcard__install" aria-live="polite">
          <div className="lxf-progress" role="progressbar" aria-label={t(`install.${install.status}` as never)} aria-valuetext={t(`install.${install.status}` as never)}>
            <span className="lxf-progress__bar is-indeterminate" />
          </div>
          <div className="lxf-field__hint">
            {t(`install.${install.status}` as never)}
            {install.registry ? ` · ${new URL(install.registry).host}` : ''}
            {install.version ? ` · v${install.version}` : ''}
          </div>
          {install.log.length > 0 && <div className="lxf-kcard__logline" title={install.log.at(-1)}>{install.log.at(-1)}</div>}
        </div>
      )}
      {install.status === 'error' && (
        <div className="lxf-callout is-error">
          {t('install.error', { message: install.error ?? '' })}
          {install.log.length > 0 && (
            <button type="button" className="lxf-link" onClick={() => setShowLog(v => !v)} aria-expanded={showLog}>
              {t('install.log')}
            </button>
          )}
          {showLog && <pre className="lxf-code lxf-code--log">{install.log.join('\n')}</pre>}
        </div>
      )}

      <dl className="lxf-kcard__facts">
        <dt>{t('kernels.source')}</dt>
        <dd>{kernel.source ? t(`source.${kernel.source}` as never) : '—'}</dd>
        <dt>{t('kernels.login')}</dt>
        <dd>{kernel.nativeLogin ? t('kernels.loginFound') : t('kernels.loginNone')}</dd>
        <dt>{t('kernels.route')}</dt>
        <dd>
          <code>{kernel.chatRoute}</code>
        </dd>
      </dl>

      <div className="lxf-kcard__controls">
        <div className="lxf-kcard__control">
          <span className="lxf-kcard__label">{t('kernels.mode')}</span>
          <Segmented
            label={t('kernels.mode')}
            className="lxf-seg--sm"
            value={kernel.settings.mode}
            onChange={mode => void actions.updateKernel(kernel.id, { mode })}
            options={[
              { value: 'scoped', label: t('mode.scoped') },
              { value: 'global', label: t('mode.global') },
            ]}
          />
        </div>
        {kernel.settings.mode === 'global' && !kernel.nativeLogin && <div className="lxf-field__hint is-warn">{t('kernels.globalNoLogin')}</div>}
        <div className="lxf-kcard__control">
          <label className="lxf-kcard__label" htmlFor={`perm-${kernel.id}`}>
            <IconShield size={14} /> {t('kernels.permission')}
          </label>
          <select id={`perm-${kernel.id}`} className="lxf-input lxf-select lxf-select--sm" value={kernel.settings.permission} onChange={e => void actions.updateKernel(kernel.id, { permission: e.target.value as KernelPermission })}>
            {permissionsFor(kernel).map(p => (
              <option key={p} value={p}>
                {t(`permission.${p}` as never)}
              </option>
            ))}
          </select>
        </div>
        {kernel.settings.permission === 'full' && <div className="lxf-field__hint is-warn">{t('permission.fullWarning')}</div>}
        <div className="lxf-kcard__control">
          <span className="lxf-kcard__label" id={`sub-${kernel.id}`}>
            {t('kernels.subagent')}
          </span>
          <Switch checked={kernel.settings.enabled} onChange={enabled => void actions.updateKernel(kernel.id, { enabled })} label={t('kernels.subagentFor', { name: kernel.name })} />
        </div>
      </div>

      <footer className="lxf-kcard__foot">
        <Button
          size="sm"
          variant={kernel.installed && !outdated ? 'glass' : 'primary'}
          icon={busy ? <Spinner label={t('install.installing')} /> : <IconDownload />}
          disabled={busy || kernel.source === 'path' || kernel.source === 'settings'}
          title={kernel.source === 'path' ? t('kernels.pathManaged') : undefined}
          onClick={() => void actions.installKernel(kernel.id)}
        >
          {kernel.installed ? t('kernels.update') : t('kernels.install')}
        </Button>
        <Button size="sm" icon={<IconBeaker />} disabled={!kernel.installed || test?.status === 'running'} onClick={() => void actions.testKernel(kernel.id)}>
          {test?.status === 'running' ? t('kernels.testing') : t('kernels.test')}
        </Button>
        {test && test.status !== 'running' && (
          <span className={cx('lxf-test', `is-${test.status}`)} role="status">
            {test.status === 'ok' ? t('kernels.testOk', { ms: test.latencyMs ?? 0 }) : t('kernels.testFailed', { detail: test.detail === 'missing' ? t('kernels.notInstalled') : test.detail === 'version' ? t('kernels.needs', { min: kernel.minVersion }) : (test.detail ?? '') })}
          </span>
        )}
      </footer>
    </article>
  )
}
