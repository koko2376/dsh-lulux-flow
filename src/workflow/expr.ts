/**
 * A tiny, safe boolean expression language for condition and loop nodes.
 * No code execution: a hand-written tokenizer and recursive-descent parser
 * over literals, variable paths and a fixed operator set.
 *
 *   nodes.review.output.score >= 0.8 && !(inputs.dryRun)
 *   nodes.check.output contains "LGTM" || loop.index >= 3
 *   {{ nodes.a.output.status }} == "ok"           (template braces are accepted)
 *
 * Operators: || && ! == != > >= < <= contains startsWith endsWith matches, ( ).
 */
import { lookup, type TemplateScope } from './template.js'
import { compileSafeRegex } from './safe-regex.js'

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'lit'; value: boolean | null }
  | { kind: 'path'; value: string }
  | { kind: 'op'; value: string }

const WORD_OPS = new Set(['contains', 'startsWith', 'endsWith', 'matches', 'and', 'or', 'not'])

export function tokenize(source: string): Token[] {
  const text = source.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, ' $1 ')
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]!
    if (/\s/.test(char)) {
      i += 1
      continue
    }
    const two = text.slice(i, i + 2)
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      tokens.push({ kind: 'op', value: two })
      i += 2
      continue
    }
    if ('><!()'.includes(char)) {
      tokens.push({ kind: 'op', value: char })
      i += 1
      continue
    }
    if (char === '"' || char === "'") {
      let j = i + 1
      let value = ''
      while (j < text.length && text[j] !== char) {
        if (text[j] === '\\' && j + 1 < text.length) {
          value += text[j + 1]
          j += 2
          continue
        }
        value += text[j]
        j += 1
      }
      if (j >= text.length) throw new Error('unterminated string in expression')
      tokens.push({ kind: 'str', value })
      i = j + 1
      continue
    }
    const num = /^-?\d+(\.\d+)?/.exec(text.slice(i))
    if (num !== null && (tokens.length === 0 || tokens.at(-1)!.kind === 'op')) {
      tokens.push({ kind: 'num', value: Number(num[0]) })
      i += num[0].length
      continue
    }
    const path = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\])*/.exec(text.slice(i))
    if (path !== null) {
      const word = path[0]
      if (word === 'true' || word === 'false') tokens.push({ kind: 'lit', value: word === 'true' })
      else if (word === 'null') tokens.push({ kind: 'lit', value: null })
      else if (WORD_OPS.has(word)) tokens.push({ kind: 'op', value: word === 'and' ? '&&' : word === 'or' ? '||' : word === 'not' ? '!' : word })
      else tokens.push({ kind: 'path', value: word })
      i += word.length
      continue
    }
    throw new Error(`unexpected character in expression: ${char}`)
  }
  return tokens
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0
  return Boolean(value)
}

function loose(value: unknown): unknown {
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return value
}

function equals(a: unknown, b: unknown): boolean {
  const x = loose(a)
  const y = loose(b)
  if (typeof x === 'object' || typeof y === 'object') return JSON.stringify(x) === JSON.stringify(y)
  return x === y
}

export function evaluate(source: string, scope: TemplateScope): boolean {
  const tokens = tokenize(source)
  let pos = 0
  const peek = (): Token | undefined => tokens[pos]
  const isOp = (value: string): boolean => {
    const token = peek()
    return token?.kind === 'op' && token.value === value
  }

  const primary = (): unknown => {
    const token = tokens[pos++]
    if (token === undefined) throw new Error('unexpected end of expression')
    if (token.kind === 'op' && token.value === '(') {
      const value = or()
      if (!isOp(')')) throw new Error('missing ) in expression')
      pos += 1
      return value
    }
    if (token.kind === 'op' && token.value === '!') return !truthy(primary())
    if (token.kind === 'num' || token.kind === 'str' || token.kind === 'lit') return token.value
    if (token.kind === 'path') return lookup(scope, token.value)
    throw new Error(`unexpected operator ${token.value}`)
  }

  const comparison = (): unknown => {
    const left = primary()
    const token = peek()
    if (token?.kind !== 'op' || !['==', '!=', '>', '>=', '<', '<=', 'contains', 'startsWith', 'endsWith', 'matches'].includes(token.value)) return left
    pos += 1
    const right = primary()
    switch (token.value) {
      case '==':
        return equals(left, right)
      case '!=':
        return !equals(left, right)
      case '>':
        return Number(loose(left)) > Number(loose(right))
      case '>=':
        return Number(loose(left)) >= Number(loose(right))
      case '<':
        return Number(loose(left)) < Number(loose(right))
      case '<=':
        return Number(loose(left)) <= Number(loose(right))
      case 'contains':
        if (Array.isArray(left)) return left.some(item => equals(item, right))
        return typeof left === 'string' ? left.includes(String(right)) : left !== null && typeof left === 'object' ? Object.prototype.hasOwnProperty.call(left, String(right)) : false
      case 'startsWith':
        return typeof left === 'string' && left.startsWith(String(right))
      case 'endsWith':
        return typeof left === 'string' && left.endsWith(String(right))
      case 'matches':
        // Linear-time engine: patterns and subjects may be untrusted (no ReDoS on the host thread).
        return typeof left === 'string' && compileSafeRegex(String(right)).test(left)
      default:
        return false
    }
  }

  const and = (): unknown => {
    let value = comparison()
    while (isOp('&&')) {
      pos += 1
      const right = comparison()
      value = truthy(value) && truthy(right)
    }
    return value
  }

  const or = (): unknown => {
    let value = and()
    while (isOp('||')) {
      pos += 1
      const right = and()
      value = truthy(value) || truthy(right)
    }
    return value
  }

  if (tokens.length === 0) throw new Error('empty expression')
  const result = or()
  if (pos !== tokens.length) throw new Error('unexpected trailing tokens in expression')
  return truthy(result)
}

/** Validate syntax without evaluating against real data. */
export function checkExpression(source: string): string | undefined {
  try {
    evaluate(source, { inputs: {}, nodes: {}, run: { id: '', workflowId: '', trigger: '' } })
    return undefined
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}
