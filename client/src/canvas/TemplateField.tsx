/**
 * Text field with `{{ variable }}` autocomplete. Typing `{{` (or Ctrl+Space)
 * opens a listbox of variables available to this node; after `|` inside a
 * tag it offers filters. Arrow keys move, Enter/Tab accept, Escape closes.
 */
import { useId, useMemo, useRef, useState, type ReactElement } from 'react'
import { TEMPLATE_FILTERS } from '../store/graph.ts'
import { cx } from '../ui/glass.tsx'

export interface TemplateFieldProps {
  id: string
  value: string
  onChange: (value: string) => void
  variables: readonly string[]
  multiline?: boolean
  rows?: number
  placeholder?: string
  describedBy?: string | undefined
  label: string
  listLabel: string
  mono?: boolean
}

interface Context {
  start: number
  query: string
  kind: 'var' | 'filter'
}

/** Find an open `{{ ... ` tag ending at the caret. */
export function openTag(text: string, caret: number): Context | undefined {
  const before = text.slice(0, caret)
  const open = before.lastIndexOf('{{')
  if (open < 0 || before.lastIndexOf('}}') > open) return undefined
  const inner = before.slice(open + 2)
  const pipe = inner.lastIndexOf('|')
  if (pipe >= 0) {
    const q = inner.slice(pipe + 1).trimStart()
    return { start: caret - q.length, query: q, kind: 'filter' }
  }
  const q = inner.trimStart()
  if (/\s/.test(q)) return undefined
  return { start: caret - q.length, query: q, kind: 'var' }
}

export function suggestions(ctx: Context, variables: readonly string[]): string[] {
  const pool = ctx.kind === 'filter' ? [...TEMPLATE_FILTERS] : [...variables]
  const q = ctx.query.toLowerCase()
  return pool.filter(v => v.toLowerCase().includes(q)).sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q))).slice(0, 8)
}

export function TemplateField(props: TemplateFieldProps): ReactElement {
  const { id, value, onChange, variables, multiline, rows = 4, placeholder, describedBy, label, listLabel, mono } = props
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const listId = useId()
  const [ctx, setCtx] = useState<Context | undefined>()
  const [active, setActive] = useState(0)
  const items = useMemo(() => (ctx ? suggestions(ctx, variables) : []), [ctx, variables])
  const open = ctx !== undefined && items.length > 0

  const refresh = (text: string, caret: number | null): void => {
    const next = caret === null ? undefined : openTag(text, caret)
    setCtx(next)
    setActive(0)
  }

  const accept = (item: string): void => {
    const el = ref.current
    if (!ctx || !el) return
    const caret = el.selectionStart ?? value.length
    const after = value.slice(caret)
    const closing = ctx.kind === 'var' && !/^\s*(\||}})/.test(after) ? ' }}' : ''
    const next = `${value.slice(0, ctx.start)}${item}${closing}${after}`
    onChange(next)
    setCtx(undefined)
    const pos = ctx.start + item.length + closing.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const common = {
    id,
    ref,
    value,
    placeholder,
    className: cx('lxf-input', multiline && 'lxf-input--area', mono && 'lxf-input--mono'),
    role: 'combobox' as const,
    'aria-label': label,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': open,
    'aria-controls': listId,
    ...(open ? { 'aria-activedescendant': `${listId}-${active}` } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    spellCheck: false,
    onChange: (event: { target: { value: string; selectionStart: number | null } }) => {
      onChange(event.target.value)
      refresh(event.target.value, event.target.selectionStart)
    },
    onBlur: () => setTimeout(() => setCtx(undefined), 120),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === ' ' && event.ctrlKey) {
        event.preventDefault()
        const el = ref.current
        const caret = el?.selectionStart ?? value.length
        setCtx(openTag(value, caret) ?? { start: caret, query: '', kind: 'var' })
        return
      }
      if (!open) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive(a => (a + 1) % items.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive(a => (a - 1 + items.length) % items.length)
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        accept(items[active]!)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setCtx(undefined)
      }
    },
  }

  return (
    <div className="lxf-template">
      {multiline ? <textarea {...common} rows={rows} /> : <input {...common} type="text" />}
      {open && (
        <ul id={listId} role="listbox" aria-label={listLabel} className="lxf-template__list">
          {items.map((item, i) => (
            <li
              key={item}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cx('lxf-template__item', i === active && 'is-active')}
              onMouseDown={event => {
                event.preventDefault()
                accept(item)
              }}
            >
              <code>{item}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
