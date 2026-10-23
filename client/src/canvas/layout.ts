/**
 * Workflow page layout: the widths of the workflow list and the inspector
 * panel, and whether each one is collapsed. Kept in localStorage so the
 * page opens the way it was left.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export type PanelSide = 'left' | 'right'

export interface PanelBounds {
  /** Width used until the user drags the panel (desktop layout). */
  def: number
  min: number
  max: number
}

export const PANEL_BOUNDS: Record<PanelSide, PanelBounds> = {
  left: { def: 248, min: 200, max: 420 },
  right: { def: 380, min: 300, max: 640 },
}

/** The canvas never gets narrower than this while a panel is resized. */
export const MIN_CANVAS = 360
/** Grid gap between the three columns (matches .lxf-workflows). */
export const LAYOUT_GAP = 12
/** Keyboard resize step; Shift moves four steps at a time. */
export const RESIZE_STEP = 16

export const LAYOUT_KEY = 'dsh-lulux-flow:layout'

export interface PanelLayout {
  /** Width chosen by dragging, or null for the responsive default. */
  left: number | null
  right: number | null
  leftOpen: boolean
  rightOpen: boolean
}

export const DEFAULT_LAYOUT: PanelLayout = { left: null, right: null, leftOpen: true, rightOpen: true }

const clampTo = (value: number, min: number, max: number): number => Math.min(Math.max(Math.round(value), min), max)

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

const readWidth = (value: unknown, side: PanelSide): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const b = PANEL_BOUNDS[side]
  return clampTo(value, b.min, b.max)
}

/** Reads the saved layout; anything missing or malformed falls back to the default. */
export function loadLayout(store: Storage | null = storage()): PanelLayout {
  try {
    const raw = store?.getItem(LAYOUT_KEY)
    if (!raw) return { ...DEFAULT_LAYOUT }
    const data = JSON.parse(raw) as Partial<Record<keyof PanelLayout, unknown>>
    return {
      left: readWidth(data.left, 'left'),
      right: readWidth(data.right, 'right'),
      leftOpen: typeof data.leftOpen === 'boolean' ? data.leftOpen : true,
      rightOpen: typeof data.rightOpen === 'boolean' ? data.rightOpen : true,
    }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

export function saveLayout(layout: PanelLayout, store: Storage | null = storage()): void {
  try {
    store?.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    // Private mode or a full quota: the layout simply is not remembered.
  }
}

/**
 * Largest width a panel may take: its own maximum, reduced so the canvas
 * keeps MIN_CANVAS next to the other panel. `container` 0 means unknown
 * (not laid out yet, or tests) and skips the canvas rule.
 */
export function maxWidth(side: PanelSide, container: number, other: number): number {
  const b = PANEL_BOUNDS[side]
  if (container <= 0) return b.max
  const gaps = LAYOUT_GAP * (other > 0 ? 2 : 1)
  return Math.max(b.min, Math.min(b.max, container - other - gaps - MIN_CANVAS))
}

export function clampWidth(side: PanelSide, width: number, container = 0, other = 0): number {
  return clampTo(width, PANEL_BOUNDS[side].min, maxWidth(side, container, other))
}

/**
 * Widths to render: the preferred ones, shrunk when the window is too narrow
 * to keep MIN_CANVAS (the inspector gives way first). Preferences are kept, so
 * a wider window brings them back.
 */
export function fitLayout(layout: PanelLayout, container: number): { left: number | null; right: number | null } {
  let { left, right } = layout
  if (container <= 0) return { left, right }
  const lw = (): number => (layout.leftOpen ? (left ?? PANEL_BOUNDS.left.def) : 0)
  const rw = (): number => (layout.rightOpen ? (right ?? PANEL_BOUNDS.right.def) : 0)
  if (right !== null && layout.rightOpen) right = clampWidth('right', right, container, lw())
  if (left !== null && layout.leftOpen) left = clampWidth('left', left, container, rw())
  return { left, right }
}

export interface PanelLayoutApi {
  layout: PanelLayout
  /** Rendered widths after fitting into the container. */
  widths: { left: number | null; right: number | null }
  setOpen: (side: PanelSide, open: boolean) => void
  toggle: (side: PanelSide) => void
  setWidth: (side: PanelSide, width: number | null) => void
  /** Current rendered width of a panel (measured, else preferred, else default). */
  widthOf: (side: PanelSide) => number
  /** Bounds for a panel right now, given the container and the other panel. */
  boundsOf: (side: PanelSide) => { min: number; max: number }
}

/**
 * Layout state for the workflow page. `container` is the grid element;
 * `panels` resolves a side to its rendered element so drags start from the
 * width actually on screen (the responsive default can differ from `def`).
 */
export function usePanelLayout(container: RefObject<HTMLElement | null>, panels: (side: PanelSide) => HTMLElement | null): PanelLayoutApi {
  const [layout, setLayout] = useState<PanelLayout>(() => loadLayout())
  const [box, setBox] = useState(0)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    saveLayout(layout)
  }, [layout])

  useEffect(() => {
    const el = container.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => setBox(Math.round(entries[0]?.contentRect.width ?? el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [container])

  const widths = fitLayout(layout, box)

  const widthOf = useCallback(
    (side: PanelSide): number => {
      const measured = panels(side)?.getBoundingClientRect().width ?? 0
      if (measured > 0) return Math.round(measured)
      return widths[side] ?? PANEL_BOUNDS[side].def
    },
    [panels, widths],
  )

  const boundsOf = useCallback(
    (side: PanelSide) => {
      const other: PanelSide = side === 'left' ? 'right' : 'left'
      const otherOpen = other === 'left' ? layout.leftOpen : layout.rightOpen
      const otherWidth = otherOpen && panels(other) ? widthOf(other) : 0
      const width = container.current?.clientWidth ?? 0
      return { min: PANEL_BOUNDS[side].min, max: maxWidth(side, width, otherWidth) }
    },
    [container, layout.leftOpen, layout.rightOpen, panels, widthOf],
  )

  const setOpen = useCallback((side: PanelSide, open: boolean) => setLayout(l => ({ ...l, [side === 'left' ? 'leftOpen' : 'rightOpen']: open })), [])
  const toggle = useCallback((side: PanelSide) => setLayout(l => (side === 'left' ? { ...l, leftOpen: !l.leftOpen } : { ...l, rightOpen: !l.rightOpen })), [])
  const setWidth = useCallback((side: PanelSide, width: number | null) => setLayout(l => ({ ...l, [side]: width })), [])

  return { layout, widths, setOpen, toggle, setWidth, widthOf, boundsOf }
}
