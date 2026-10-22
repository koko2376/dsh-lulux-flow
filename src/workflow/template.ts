/**
 * Variable templates between nodes: `{{ inputs.topic }}`,
 * `{{ nodes.review.output.score }}`, `{{ loop.item }}`, `{{ run.id }}`,
 * with filters `| json`, `| default("x")`, `| trim`, `| upper`, `| lower`,
 * `| length`. A string that is exactly one `{{ ... }}` keeps the raw value
 * type (object, number, ...); any other string is interpolated as text.
 *
 * Templates are data lookups only — there is no code execution here.
 */

export interface TemplateScope {
  inputs: Record<string, unknown>
  nodes: Record<string, { output?: unknown; status?: string; error?: string }>
  run: { id: string; workflowId: string; trigger: string }
  loop?: { item: unknown; index: number; previous?: unknown }
}

const TAG = /\{\{\s*([\s\S]*?)\s*\}\}/g
const WHOLE = /^\{\{\s*([\s\S]*?)\s*\}\}$/

/** Parse `a.b[0]["c d"]` into segments. */
export function parsePath(path: string): string[] {
  const segments: string[] = []
  const re = /([A-Za-z_$][\w$-]*)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\['((?:[^'\\]|\\.)*)'\]|(\.)/gy
  let match: RegExpExecArray | null
  let last = 0
  while ((match = re.exec(path)) !== null) {
    if (match[0] === '') break
    last = re.lastIndex
    if (match[5] !== undefined) continue
    segments.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '')
  }
  if (last !== path.length) throw new Error(`invalid variable path: ${path}`)
  return segments
}

const BLOCKED = new Set(['__proto__', 'prototype', 'constructor'])

export function lookup(scope: TemplateScope, path: string): unknown {
  const segments = parsePath(path.trim())
  let value: unknown = scope as unknown
  for (const segment of segments) {
    if (BLOCKED.has(segment)) return undefined
    if (typeof value === 'string') {
      if (segment === 'length') {
        value = value.length
        continue
      }
      // Allow drilling into JSON text outputs transparently.
      try {
        value = JSON.parse(value) as unknown
      } catch {
        return undefined
      }
    }
    if (value === null || typeof value !== 'object') return undefined
    if (Array.isArray(value) && segment === 'length') {
      value = value.length
      continue
    }
    value = Object.prototype.hasOwnProperty.call(value, segment) ? (value as Record<string, unknown>)[segment] : undefined
  }
  return value
}

function parseLiteral(raw: string): unknown {
  const text = raw.trim()
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) return JSON.parse(text) as unknown
  if (/^'(?:[^'\\]|\\.)*'$/.test(text)) return text.slice(1, -1).replace(/\\'/g, "'")
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null') return null
  return text
}

function applyFilter(value: unknown, filter: string): unknown {
  const match = /^([a-z]+)(?:\((.*)\))?$/i.exec(filter.trim())
  if (!match) throw new Error(`invalid filter: ${filter}`)
  const name = match[1]!.toLowerCase()
  const arg = match[2]
  switch (name) {
    case 'json':
      return JSON.stringify(value ?? null)
    case 'default':
      return value === undefined || value === null || value === '' ? parseLiteral(arg ?? '""') : value
    case 'trim':
      return typeof value === 'string' ? value.trim() : value
    case 'upper':
      return typeof value === 'string' ? value.toUpperCase() : value
    case 'lower':
      return typeof value === 'string' ? value.toLowerCase() : value
    case 'length':
      return typeof value === 'string' || Array.isArray(value) ? value.length : value !== null && typeof value === 'object' ? Object.keys(value).length : 0
    default:
      throw new Error(`unknown filter: ${name}`)
  }
}

function splitFilters(expression: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  let depth = 0
  for (const char of expression) {
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (char === '|' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

export function evaluateTag(scope: TemplateScope, expression: string): unknown {
  const [path, ...filters] = splitFilters(expression)
  let value = lookup(scope, path ?? '')
  for (const filter of filters) value = applyFilter(value, filter)
  return value
}

export function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** Render one string template. */
export function renderString(template: string, scope: TemplateScope): unknown {
  const whole = WHOLE.exec(template)
  if (whole !== null && !whole[1]!.includes('}}')) return evaluateTag(scope, whole[1]!)
  return template.replace(TAG, (_match, expression: string) => stringify(evaluateTag(scope, expression)))
}

/** Render every string inside a JSON-like value. */
export function renderDeep(value: unknown, scope: TemplateScope, depth = 0): unknown {
  if (depth > 32) return value
  if (typeof value === 'string') return renderString(value, scope)
  if (Array.isArray(value)) return value.map(item => renderDeep(item, scope, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) out[key] = renderDeep(inner, scope, depth + 1)
    return out
  }
  return value
}

/** Every `{{ }}` reference in a value (for validation and the variable picker). */
export function referencesIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32) return out
  if (typeof value === 'string') {
    for (const match of value.matchAll(TAG)) out.push(splitFilters(match[1]!)[0]!.trim())
  } else if (Array.isArray(value)) value.forEach(item => referencesIn(item, out, depth + 1))
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(inner => referencesIn(inner, out, depth + 1))
  return out
}
