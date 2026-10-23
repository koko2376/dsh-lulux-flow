/**
 * Node palette: a floating glass rail. The everyday steps are always shown;
 * the rest sit under a collapsed "more" group. Every item carries a one-line,
 * plain-language hint. Drag onto the canvas, or press an item to add it at
 * the viewport centre.
 */
import { useState, type ReactElement } from 'react'
import type { NodeType } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import { cx } from '../ui/glass.tsx'
import { IconChevronDown, NodeIcons } from '../ui/icons.tsx'
import { DRAG_MIME } from './Canvas.tsx'

/** Shown first: enough for most workflows. */
export const COMMON_NODE_TYPES: readonly NodeType[] = ['input', 'agent', 'kernel', 'output']
/** Behind "more steps". */
export const ADVANCED_NODE_TYPES: readonly NodeType[] = ['condition', 'approval', 'loop', 'http', 'notify', 'script']

export function Palette({ t, onAdd, scriptsAllowed, disabled }: { t: Translate; onAdd: (type: NodeType) => void; scriptsAllowed: boolean; disabled?: boolean }): ReactElement {
  const [more, setMore] = useState(false)
  const item = (type: NodeType): ReactElement => {
    const Icon = NodeIcons[type]
    const off = type === 'script' && !scriptsAllowed
    const name = t(`node.type.${type}` as never)
    const hint = t(`node.desc.${type}` as never)
    return (
      <li key={type}>
        <button
          type="button"
          className={cx('lxf-palette__item', `lxf-node--${type}`, off && 'is-muted')}
          draggable={!disabled}
          disabled={disabled}
          title={`${name}: ${hint}${off ? ` (${t('palette.scriptOff')})` : ''}`}
          aria-label={t('palette.add', { type: name })}
          aria-describedby={`lxf-palette-hint-${type}`}
          onDragStart={event => {
            event.dataTransfer.setData(DRAG_MIME, type)
            event.dataTransfer.effectAllowed = 'copy'
          }}
          onClick={() => onAdd(type)}
        >
          <span className="lxf-palette__icon">
            <Icon size={16} />
          </span>
          <span className="lxf-palette__text">
            <span className="lxf-palette__label">{name}</span>
            <span className="lxf-palette__hint" id={`lxf-palette-hint-${type}`}>
              {hint}
            </span>
          </span>
        </button>
      </li>
    )
  }
  return (
    <nav className="lxf-palette" aria-label={t('palette.aria')}>
      <div className="lxf-palette__title">{t('palette.title')}</div>
      <div className="lxf-palette__group" aria-hidden="true">
        {t('palette.common')}
      </div>
      <ul className="lxf-palette__list" aria-label={t('palette.common')}>
        {COMMON_NODE_TYPES.map(item)}
      </ul>
      <button type="button" className={cx('lxf-palette__more', more && 'is-open')} aria-expanded={more} aria-controls="lxf-palette-more" onClick={() => setMore(v => !v)}>
        <span>{t('palette.advanced')}</span>
        <IconChevronDown size={14} />
      </button>
      {more && (
        <ul className="lxf-palette__list" id="lxf-palette-more" aria-label={t('palette.advanced')}>
          {ADVANCED_NODE_TYPES.map(item)}
        </ul>
      )}
      <p className="lxf-palette__tip">{t('palette.tip')}</p>
    </nav>
  )
}
