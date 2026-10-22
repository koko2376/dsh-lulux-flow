/** Node palette: a floating glass rail. Drag onto the canvas, or press a tile to add at the viewport centre. */
import type { ReactElement } from 'react'
import { NODE_TYPES, type NodeType } from '../api/types.ts'
import type { Translate } from '../i18n/translate.ts'
import { cx } from '../ui/glass.tsx'
import { NodeIcons } from '../ui/icons.tsx'
import { DRAG_MIME } from './Canvas.tsx'

export function Palette({ t, onAdd, scriptsAllowed, disabled }: { t: Translate; onAdd: (type: NodeType) => void; scriptsAllowed: boolean; disabled?: boolean }): ReactElement {
  return (
    <nav className="lxf-palette" aria-label={t('palette.aria')}>
      <div className="lxf-palette__title" aria-hidden="true">
        {t('palette.title')}
      </div>
      <ul className="lxf-palette__list">
        {NODE_TYPES.map(type => {
          const Icon = NodeIcons[type]
          const off = type === 'script' && !scriptsAllowed
          return (
            <li key={type}>
              <button
                type="button"
                className={cx('lxf-palette__item', `lxf-node--${type}`, off && 'is-muted')}
                draggable={!disabled}
                disabled={disabled}
                title={`${t(`node.type.${type}` as never)} — ${t(`node.desc.${type}` as never)}${off ? ` (${t('palette.scriptOff')})` : ''}`}
                aria-label={t('palette.add', { type: t(`node.type.${type}` as never) })}
                onDragStart={event => {
                  event.dataTransfer.setData(DRAG_MIME, type)
                  event.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => onAdd(type)}
              >
                <span className="lxf-palette__icon">
                  <Icon size={16} />
                </span>
                <span className="lxf-palette__label">{t(`node.type.${type}` as never)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
