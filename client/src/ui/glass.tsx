/**
 * Liquid-glass control set used across DSH-LULUX Flow surfaces. Pure presentation:
 * every visible string arrives as a prop (already localized by the caller).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ')

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'glass' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: ReactNode
}

export function Button({ variant = 'glass', size = 'md', icon, className, children, type = 'button', ...rest }: ButtonProps): ReactElement {
  return (
    <button type={type} className={cx('lxf-btn', `lxf-btn--${variant}`, `lxf-btn--${size}`, className)} {...rest}>
      {icon}
      {children !== undefined && <span className="lxf-btn__label">{children}</span>}
    </button>
  )
}

/** Icon-only button; `label` is the accessible name and tooltip. */
export function IconButton({ label, icon, className, variant = 'ghost', ...rest }: Omit<ButtonProps, 'children'> & { label: string; icon: ReactNode }): ReactElement {
  return (
    <button type="button" aria-label={label} title={label} className={cx('lxf-iconbtn', `lxf-iconbtn--${variant}`, className)} {...rest}>
      {icon}
    </button>
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

/** Floating pill segmented control (radiogroup semantics, arrow-key navigation). */
export function Segmented<T extends string>({ options, value, onChange, label, className }: { options: readonly SegmentOption<T>[]; value: T; onChange: (value: T) => void; label: string; className?: string }): ReactElement {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const index = Math.max(0, options.findIndex(o => o.value === value))
  const move = (delta: number): void => {
    const next = (index + delta + options.length) % options.length
    const option = options[next]
    if (option !== undefined) {
      onChange(option.value)
      refs.current[next]?.focus()
    }
  }
  return (
    <div role="radiogroup" aria-label={label} className={cx('lxf-seg', className)} style={{ ['--lxf-seg-count' as string]: options.length, ['--lxf-seg-index' as string]: index }}>
      <span className="lxf-seg__thumb" aria-hidden="true" />
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={el => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className={cx('lxf-seg__item', option.value === value && 'is-active')}
          onClick={() => onChange(option.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              event.preventDefault()
              move(1)
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              event.preventDefault()
              move(-1)
            }
          }}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Switch({ checked, onChange, label, disabled, describedBy }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean; describedBy?: string }): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      disabled={disabled}
      className={cx('lxf-switch', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="lxf-switch__thumb" aria-hidden="true" />
    </button>
  )
}

/** Labelled form row. The control receives the generated id through the render prop. */
export function Field({ label, hint, error, children, inline }: { label: string; hint?: ReactNode; error?: string; inline?: boolean; children: (id: string, describedBy: string | undefined) => ReactNode }): ReactElement {
  const id = useId()
  const hintId = hint !== undefined || error !== undefined ? `${id}-hint` : undefined
  return (
    <div className={cx('lxf-field', inline && 'lxf-field--inline', error && 'has-error')}>
      <label className="lxf-field__label" htmlFor={id}>
        {label}
      </label>
      {children(id, hintId)}
      {(hint !== undefined || error !== undefined) && (
        <div id={hintId} className={cx('lxf-field__hint', error && 'is-error')}>
          {error ?? hint}
        </div>
      )}
    </div>
  )
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'success' | 'error' | 'warn' | 'info' | 'accent'; children: ReactNode; title?: string }): ReactElement {
  return (
    <span className={cx('lxf-badge', `lxf-badge--${tone}`)} {...(title ? { title } : {})}>
      {children}
    </span>
  )
}

export function Spinner({ label }: { label: string }): ReactElement {
  return <span className="lxf-spinner" role="status" aria-label={label} />
}

export function Avatar({ src, alt, size = 28, ring }: { src: string; alt: string; size?: number; ring?: string }): ReactElement {
  return (
    <span className="lxf-avatar" style={{ width: size, height: size, ...(ring ? { ['--lxf-ring' as string]: ring } : {}) }}>
      <img src={src} alt={alt} width={size} height={size} draggable={false} />
    </span>
  )
}

export function Empty({ title, detail, action, art }: { title: string; detail?: string; action?: ReactNode; art?: ReactNode }): ReactElement {
  return (
    <div className="lxf-empty">
      {art}
      <div className="lxf-empty__title">{title}</div>
      {detail && <div className="lxf-empty__detail">{detail}</div>}
      {action}
    </div>
  )
}

/** Close on outside pointer-down and Escape. */
function useDismiss(open: boolean, onClose: () => void, refs: Array<React.RefObject<HTMLElement | null>>): void {
  useEffect(() => {
    if (!open) return
    const down = (event: PointerEvent): void => {
      const target = event.target as Node
      if (refs.some(r => r.current?.contains(target))) return
      onClose()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [open, onClose, refs])
}

const EDGE = 8

/**
 * Popover anchored to a trigger, portalled to body so it escapes overflow
 * and stacking ancestors; flips above/below and slides horizontally to stay
 * inside the viewport with an edge margin.
 */
export function Popover({ open, onClose, anchor, children, label, align = 'start', width }: { open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement | null>; children: ReactNode; label: string; align?: 'start' | 'end'; width?: number }): ReactElement | null {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'below' | 'above' } | null>(null)
  const refs = useRef([ref, anchor as React.RefObject<HTMLElement | null>]).current
  useDismiss(open, onClose, refs)
  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect()
    const p = ref.current?.getBoundingClientRect()
    if (a === undefined || p === undefined) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const below = a.bottom + 8
    const above = a.top - 8 - p.height
    const fitsBelow = below + p.height <= vh - EDGE
    const fitsAbove = above >= EDGE
    const placement = fitsBelow || !fitsAbove ? 'below' : 'above'
    let left = align === 'end' ? a.right - p.width : a.left
    left = Math.min(Math.max(EDGE, left), vw - EDGE - p.width)
    const top = placement === 'below' ? Math.min(below, Math.max(EDGE, vh - EDGE - p.height)) : above
    setPos({ top, left, placement })
  }, [anchor, align])
  // Positioning needs the rendered popover box; CSS anchor positioning is not available in every supported engine.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={cx('lxf-root', 'lxf-popover', pos && `is-${pos.placement}`, pos && 'is-placed')}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, ...(width ? { width } : {}) }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** Modal dialog with focus trap, Escape to close and focus return. */
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }): ReactElement | null {
  const ref = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select, button')
    first?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      } else if (event.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')]
        if (items.length === 0) return
        const firstItem = items[0]!
        const lastItem = items[items.length - 1]!
        if (event.shiftKey && document.activeElement === firstItem) {
          event.preventDefault()
          lastItem.focus()
        } else if (!event.shiftKey && document.activeElement === lastItem) {
          event.preventDefault()
          firstItem.focus()
        }
      }
    }
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('keydown', key, true)
      previous?.focus?.()
    }
  }, [open, onClose])
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div className="lxf-root lxf-modal" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx('lxf-dialog', wide && 'lxf-dialog--wide')}>
        <div className="lxf-dialog__head">
          <h2 id={titleId} className="lxf-dialog__title">
            {title}
          </h2>
        </div>
        <div className="lxf-dialog__body">{children}</div>
        {footer && <div className="lxf-dialog__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
