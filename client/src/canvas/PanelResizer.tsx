/** Thin drag handle between a side panel and the canvas (pointer, keyboard, double-click reset). */
import { useRef, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { cx } from '../ui/glass.tsx'
import { RESIZE_STEP, type PanelSide } from './layout.ts'

export interface PanelResizerProps {
  side: PanelSide
  label: string
  title: string
  /** Width currently shown, for aria-valuenow. */
  value: number
  bounds: () => { min: number; max: number }
  /** Width on screen when a drag or key press starts. */
  current: () => number
  /** Live preview while dragging; should not re-render the page. */
  onPreview: (width: number) => void
  onCommit: (width: number | null) => void
  onDragChange?: (dragging: boolean) => void
}

export function PanelResizer({ side, label, title, value, bounds, current, onPreview, onCommit, onDragChange }: PanelResizerProps): ReactElement {
  const drag = useRef<{ id: number; x: number; start: number; min: number; max: number; width: number } | null>(null)
  // The right panel grows when its handle moves left.
  const dir = side === 'left' ? 1 : -1
  const limits = bounds()

  const clamp = (w: number, min: number, max: number): number => Math.min(Math.max(Math.round(w), min), max)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const { min, max } = bounds()
    const start = current()
    drag.current = { id: event.pointerId, x: event.clientX, start, min, max, width: start }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    onDragChange?.(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    d.width = clamp(d.start + (event.clientX - d.x) * dir, d.min, d.max)
    onPreview(d.width)
  }

  const end = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onDragChange?.(false)
    if (d.width !== d.start) onCommit(d.width)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const { min, max } = bounds()
    const step = event.shiftKey ? RESIZE_STEP * 4 : RESIZE_STEP
    let next: number | null | undefined
    if (event.key === 'ArrowLeft') next = clamp(current() - step * dir, min, max)
    else if (event.key === 'ArrowRight') next = clamp(current() + step * dir, min, max)
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    else if (event.key === 'Enter') next = null
    if (next === undefined) return
    event.preventDefault()
    onCommit(next)
  }

  return (
    <div
      className={cx('lxf-resizer', `lxf-resizer--${side}`)}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={title}
      aria-valuenow={value}
      aria-valuemin={limits.min}
      aria-valuemax={Math.max(limits.max, limits.min)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onCommit(null)}
      onKeyDown={onKeyDown}
    />
  )
}
