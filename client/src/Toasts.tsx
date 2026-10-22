/** Toast host (`shell.overlay`): outlives the page so outcomes survive navigation. */
import type { ReactElement } from 'react'
import type { Translate } from './i18n/translate.ts'
import { tx } from './i18n/translate.ts'
import type { FlowActions, FlowState } from './store/flow.ts'
import type { SelectorHook } from './store/store.ts'
import { cx } from './ui/glass.tsx'
import { IconCheck, IconWarning, IconX } from './ui/icons.tsx'

export function Toasts({ t, useFlow, actions }: { t: Translate; useFlow: SelectorHook<FlowState>; actions: Pick<FlowActions, 'dismissToast'> }): ReactElement | null {
  const toasts = useFlow(s => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="lxf-root lxf-toasts" role="region" aria-label={t('toast.region')}>
      {toasts.map(toast => (
        <div key={toast.id} className={cx('lxf-toast', `is-${toast.tone}`)} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.tone === 'error' ? <IconWarning size={15} /> : <IconCheck size={15} />}
          <span className="lxf-toast__text">{toast.raw ? toast.text : tx(t, toast.text, toast.text, toast.params)}</span>
          <button type="button" className="lxf-toast__close" aria-label={t('common.dismiss')} onClick={() => actions.dismissToast(toast.id)}>
            <IconX size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
