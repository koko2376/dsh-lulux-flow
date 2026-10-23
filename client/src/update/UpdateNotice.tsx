/**
 * Update notice: a small chip in the page header when a newer release exists,
 * opening a popover with the versions, a plain-text notes summary and three
 * actions. Notify only: the link goes to the GitHub release page, nothing is
 * downloaded or installed. The link is re-checked here against the same
 * allowlist the Host uses, and notes render as text (never as HTML).
 */
import { useRef, useState, type ReactElement } from 'react'
import { BRAND } from '../brand.ts'
import { safeReleaseUrl } from '../../../src/update/release.ts'
import type { Translate } from '../i18n/translate.ts'
import type { FlowActions, FlowState } from '../store/flow.ts'
import type { SelectorHook } from '../store/store.ts'
import { Button, Popover } from '../ui/glass.tsx'

export function UpdateNotice({ t, useFlow, actions }: { t: Translate; useFlow: SelectorHook<FlowState>; actions: Pick<FlowActions, 'skipUpdate' | 'remindUpdateLater'> }): ReactElement | null {
  const status = useFlow(s => s.update.status)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  if (status === null || !status.notice || status.latest === null) return null
  const latest = status.latest
  const url = safeReleaseUrl(status.url, BRAND.repository)
  const close = (): void => setOpen(false)
  return (
    <>
      <button ref={anchor} type="button" className="lxf-update-chip" aria-haspopup="dialog" aria-expanded={open} aria-label={t('update.badgeAria', { version: latest })} onClick={() => setOpen(o => !o)}>
        <span className="lxf-update-chip__dot" aria-hidden="true" />
        {t('update.badge', { version: latest })}
      </button>
      <Popover open={open} onClose={close} anchor={anchor} label={t('update.title')} align="end" width={340}>
        <div className="lxf-update">
          <div className="lxf-update__head">
            <strong className="lxf-update__title">{t('update.title')}</strong>
            <span className="lxf-update__versions">{t('update.versions', { current: status.current, latest })}</span>
          </div>
          {status.notes.length > 0 ? (
            <>
              <div className="lxf-update__label">{t('update.notes')}</div>
              <ul className="lxf-update__notes">
                {status.notes.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="lxf-update__empty">{t('update.notesOnGithub')}</p>
          )}
          <p className="lxf-update__hint">{t('update.manual')}</p>
          <div className="lxf-update__actions">
            <a className="lxf-btn lxf-btn--primary lxf-btn--sm" href={url} target="_blank" rel="noopener noreferrer" onClick={close}>
              <span className="lxf-btn__label">{t('update.view')}</span>
            </a>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                close()
                void actions.remindUpdateLater()
              }}
            >
              {t('update.later')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                close()
                void actions.skipUpdate(latest)
              }}
            >
              {t('update.skip')}
            </Button>
          </div>
        </div>
      </Popover>
    </>
  )
}
