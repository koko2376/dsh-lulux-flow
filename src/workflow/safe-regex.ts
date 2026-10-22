/**
 * Linear-time regular expressions for the `matches` operator.
 *
 * Patterns and subjects in conditions can come from untrusted data (webhook
 * inputs, HTTP responses, model output). JavaScript's backtracking RegExp can
 * take exponential time on patterns like `^(a+)+$` and would freeze the whole
 * DSH host. This engine compiles the pattern to an NFA and runs a Pike VM, so
 * matching time is O(pattern × subject) with no backtracking.
 *
 * Supported: literals, `.`, classes `[a-z]` / `[^…]`, `\d \D \w \W \s \S`,
 * `\t \n \r \f \v \0 \xHH \uHHHH`, escaped punctuation, groups `( )` `(?: )`
 * `(?<name> )`, alternation `|`, quantifiers `* + ? {n} {n,} {n,m}` (lazy `?`
 * accepted), anchors `^ $ \b \B`, and a leading `(?i)` for case-insensitive.
 * Not supported (rejected): backreferences and lookaround.
 *
 * Subjects longer than MAX_SUBJECT_LENGTH are matched on their first
 * MAX_SUBJECT_LENGTH characters only (so `$` anchors at the cut). Each
 * evaluation has a step budget (MAX_STEPS) and throws RegexBudgetError past it.
 */

export const MAX_PATTERN_LENGTH = 200
export const MAX_SUBJECT_LENGTH = 20_000
const MAX_PROGRAM = 4_000
const MAX_REPEAT = 100
/**
 * Work budget per evaluation (VM steps). Program size × subject length can
 * still be large; past this budget the match fails with an error instead of
 * blocking the DSH process (well under 100 ms on a typical machine).
 */
export const MAX_STEPS = 2_000_000

type Pred = (c: string) => boolean
type Node =
  | { t: 'char'; pred: Pred }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number }
  | { t: 'assert'; kind: '^' | '$' | 'b' | 'B' }
  | { t: 'empty' }

const isDigit: Pred = c => c >= '0' && c <= '9'
const isWord: Pred = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || isDigit(c) || c === '_'
const isSpace: Pred = c => /\s/.test(c)
const isLineTerminator = (c: string): boolean => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029'

export class RegexSyntaxError extends Error {}

/** Thrown when one evaluation exceeds {@link MAX_STEPS}. */
export class RegexBudgetError extends Error {}

class Parser {
  pos = 0
  constructor(
    private readonly src: string,
    private readonly ignoreCase: boolean,
  ) {}

  fail(message: string): never {
    throw new RegexSyntaxError(`invalid regex at ${this.pos}: ${message}`)
  }

  peek(): string | undefined {
    return this.src[this.pos]
  }

  parse(): Node {
    const node = this.alternation()
    if (this.pos < this.src.length) this.fail(`unexpected "${this.src[this.pos]}"`)
    return node
  }

  alternation(): Node {
    const items = [this.sequence()]
    while (this.peek() === '|') {
      this.pos += 1
      items.push(this.sequence())
    }
    return items.length === 1 ? items[0]! : { t: 'alt', items }
  }

  sequence(): Node {
    const items: Node[] = []
    while (this.pos < this.src.length && this.peek() !== '|' && this.peek() !== ')') items.push(this.quantified())
    return items.length === 0 ? { t: 'empty' } : items.length === 1 ? items[0]! : { t: 'cat', items }
  }

  quantified(): Node {
    const atom = this.atom()
    let node = atom
    for (;;) {
      const c = this.peek()
      let min: number
      let max: number
      if (c === '*') [min, max] = [0, Infinity]
      else if (c === '+') [min, max] = [1, Infinity]
      else if (c === '?') [min, max] = [0, 1]
      else if (c === '{') {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.pos))
        if (m === null) return node // literal "{", as in JS
        min = Number(m[1])
        max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3])
        if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) this.fail(`repeat count above ${MAX_REPEAT}`)
        if (max < min) this.fail('repeat range out of order')
        this.pos += m[0].length - 1
      } else return node
      if (node.t === 'assert') this.fail('nothing to repeat')
      this.pos += 1
      if (this.peek() === '?') this.pos += 1 // lazy: same match/no-match answer
      node = { t: 'rep', node, min, max }
    }
  }

  charNode(pred: Pred): Node {
    if (!this.ignoreCase) return { t: 'char', pred }
    return { t: 'char', pred: c => pred(c) || pred(c.toLowerCase()) || pred(c.toUpperCase()) }
  }

  atom(): Node {
    const c = this.peek()
    if (c === undefined) this.fail('unexpected end')
    this.pos += 1
    switch (c) {
      case '(': {
        if (this.src.startsWith('?:', this.pos)) this.pos += 2
        else if (this.src.startsWith('?<', this.pos) && !this.src.startsWith('?<=', this.pos) && !this.src.startsWith('?<!', this.pos)) {
          const end = this.src.indexOf('>', this.pos)
          if (end < 0) this.fail('unterminated group name')
          this.pos = end + 1
        } else if (this.peek() === '?') this.fail('lookaround and inline flags are not supported')
        const inner = this.alternation()
        if (this.peek() !== ')') this.fail('missing )')
        this.pos += 1
        return inner
      }
      case ')':
        this.fail('unmatched )')
        break
      case '[':
        return this.charClass()
      case '.':
        return { t: 'char', pred: ch => !isLineTerminator(ch) }
      case '^':
        return { t: 'assert', kind: '^' }
      case '$':
        return { t: 'assert', kind: '$' }
      case '\\':
        return this.escape(false) as Node
      case '*':
      case '+':
      case '?':
        this.fail('nothing to repeat')
        break
      default:
        break
    }
    const literal = c
    return this.charNode(ch => ch === literal)
  }

  /** Escape after a backslash. In a class, returns a predicate; otherwise a node. */
  escape(inClass: boolean): Node | Pred {
    const c = this.peek()
    if (c === undefined) this.fail('trailing backslash')
    this.pos += 1
    const pred = (p: Pred): Node | Pred => (inClass ? p : this.charNode(p))
    switch (c) {
      case 'd':
        return pred(isDigit)
      case 'D':
        return pred(ch => !isDigit(ch))
      case 'w':
        return pred(isWord)
      case 'W':
        return pred(ch => !isWord(ch))
      case 's':
        return pred(isSpace)
      case 'S':
        return pred(ch => !isSpace(ch))
      case 'b':
        if (inClass) return (ch: string) => ch === '\b'
        return { t: 'assert', kind: 'b' }
      case 'B':
        if (inClass) this.fail('\\B in a class')
        return { t: 'assert', kind: 'B' }
      default:
        break
    }
    if (/[1-9]/.test(c) || c === 'k') this.fail('backreferences are not supported')
    const single = this.escapedChar(c)
    return pred(ch => ch === single)
  }

  escapedChar(c: string): string {
    const simple: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f', v: '\v', '0': '\0' }
    if (simple[c] !== undefined) return simple[c]!
    if (c === 'x' || c === 'u') {
      const len = c === 'x' ? 2 : 4
      const hex = this.src.slice(this.pos, this.pos + len)
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) this.fail(`bad \\${c} escape`)
      this.pos += len
      return String.fromCharCode(parseInt(hex, 16))
    }
    if (/[A-Za-z]/.test(c)) this.fail(`unknown escape \\${c}`)
    return c
  }

  charClass(): Node {
    let negate = false
    if (this.peek() === '^') {
      negate = true
      this.pos += 1
    }
    const preds: Pred[] = []
    let first = true
    while (this.peek() !== ']' || first) {
      first = false
      const c = this.peek()
      if (c === undefined) this.fail('unterminated character class')
      if (c === ']') break
      this.pos += 1
      let lo: string | undefined
      if (c === '\\') {
        const e = this.peek()
        if (e === undefined) this.fail('trailing backslash')
        if (/[dDwWsS]/.test(e)) {
          preds.push(this.escape(true) as Pred)
          continue
        }
        this.pos += 1
        lo = e === 'b' ? '\b' : this.escapedChar(e)
      } else lo = c
      if (this.peek() === '-' && this.src[this.pos + 1] !== ']' && this.src[this.pos + 1] !== undefined) {
        this.pos += 1
        let hi = this.peek()!
        this.pos += 1
        if (hi === '\\') {
          const e = this.peek()
          if (e === undefined) this.fail('trailing backslash')
          this.pos += 1
          hi = this.escapedChar(e)
        }
        if (hi < lo) this.fail('class range out of order')
        const [a, b] = [lo, hi]
        preds.push(ch => ch >= a && ch <= b)
      } else {
        const single = lo
        preds.push(ch => ch === single)
      }
    }
    this.pos += 1
    const any: Pred = ch => preds.some(p => p(ch))
    const base: Pred = negate ? ch => !any(ch) : any
    if (!this.ignoreCase) return { t: 'char', pred: base }
    return { t: 'char', pred: negate ? ch => !any(ch) && !any(ch.toLowerCase()) && !any(ch.toUpperCase()) : ch => any(ch) || any(ch.toLowerCase()) || any(ch.toUpperCase()) }
  }
}

type Inst = { op: 'char'; pred: Pred } | { op: 'split'; a: number; b: number } | { op: 'jmp'; to: number } | { op: 'assert'; kind: '^' | '$' | 'b' | 'B' } | { op: 'match' }

function compile(node: Node, prog: Inst[]): void {
  if (prog.length > MAX_PROGRAM) throw new RegexSyntaxError('regex too complex')
  switch (node.t) {
    case 'empty':
      return
    case 'char':
      prog.push({ op: 'char', pred: node.pred })
      return
    case 'assert':
      prog.push({ op: 'assert', kind: node.kind })
      return
    case 'cat':
      for (const item of node.items) compile(item, prog)
      return
    case 'alt': {
      const jumps: Inst[] = []
      for (let i = 0; i < node.items.length; i += 1) {
        if (i < node.items.length - 1) {
          const split = { op: 'split' as const, a: prog.length + 1, b: -1 }
          prog.push(split)
          compile(node.items[i]!, prog)
          const jmp = { op: 'jmp' as const, to: -1 }
          prog.push(jmp)
          jumps.push(jmp)
          split.b = prog.length
        } else compile(node.items[i]!, prog)
      }
      for (const j of jumps) (j as { to: number }).to = prog.length
      return
    }
    case 'rep': {
      for (let i = 0; i < node.min; i += 1) compile(node.node, prog)
      if (node.max === Infinity) {
        const split = { op: 'split' as const, a: prog.length + 1, b: -1 }
        prog.push(split)
        compile(node.node, prog)
        prog.push({ op: 'jmp', to: prog.indexOf(split) })
        split.b = prog.length
      } else {
        const splits: Array<{ op: 'split'; a: number; b: number }> = []
        for (let i = node.min; i < node.max; i += 1) {
          const split = { op: 'split' as const, a: prog.length + 1, b: -1 }
          prog.push(split)
          splits.push(split)
          compile(node.node, prog)
        }
        for (const s of splits) s.b = prog.length
      }
      if (prog.length > MAX_PROGRAM) throw new RegexSyntaxError('regex too complex')
    }
  }
}

export interface SafeRegex {
  test(subject: string): boolean
}

const cache = new Map<string, SafeRegex>()

/** Compile a pattern (throws RegexSyntaxError for unsupported or invalid syntax). */
export function compileSafeRegex(pattern: string): SafeRegex {
  if (pattern.length > MAX_PATTERN_LENGTH) throw new RegexSyntaxError(`regex too long (max ${MAX_PATTERN_LENGTH} characters)`)
  const hit = cache.get(pattern)
  if (hit !== undefined) return hit
  const ignoreCase = pattern.startsWith('(?i)')
  const ast = new Parser(ignoreCase ? pattern.slice(4) : pattern, ignoreCase).parse()
  const prog: Inst[] = []
  compile(ast, prog)
  prog.push({ op: 'match' })
  const regex: SafeRegex = { test: subject => run(prog, subject.slice(0, MAX_SUBJECT_LENGTH)) }
  if (cache.size > 500) cache.clear()
  cache.set(pattern, regex)
  return regex
}

function assertHolds(kind: '^' | '$' | 'b' | 'B', s: string, i: number): boolean {
  if (kind === '^') return i === 0
  if (kind === '$') return i === s.length
  const before = i > 0 && isWord(s[i - 1]!)
  const after = i < s.length && isWord(s[i]!)
  return kind === 'b' ? before !== after : before === after
}

/** Pike VM: unanchored search, one pass over the subject, each pc at most once per position. */
function run(prog: Inst[], s: string, maxSteps: number = MAX_STEPS): boolean {
  let steps = 0
  const spend = (): void => {
    steps += 1
    if (steps > maxSteps) throw new RegexBudgetError(`regex too expensive for this subject (more than ${maxSteps} steps); simplify the pattern or shorten the input`)
  }
  let current: number[] = []
  let next: number[] = []
  const mark = new Int32Array(prog.length).fill(-1)
  let generation = 0
  const add = (list: number[], pc: number, i: number): boolean => {
    const stack = [pc]
    while (stack.length > 0) {
      const p = stack.pop()!
      spend()
      if (mark[p] === generation) continue
      mark[p] = generation
      const inst = prog[p]!
      switch (inst.op) {
        case 'jmp':
          stack.push(inst.to)
          break
        case 'split':
          stack.push(inst.b, inst.a)
          break
        case 'assert':
          if (assertHolds(inst.kind, s, i)) stack.push(p + 1)
          break
        case 'match':
          return true
        default:
          list.push(p)
      }
    }
    return false
  }
  for (let i = 0; i <= s.length; i += 1) {
    // Seed a new thread at every position (unanchored search); shares this generation's marks.
    if (add(current, 0, i)) return true
    if (i === s.length) break
    generation += 1
    next = []
    const ch = s[i]!
    for (const pc of current) {
      spend()
      const inst = prog[pc] as { op: 'char'; pred: Pred }
      if (inst.pred(ch) && add(next, pc + 1, i + 1)) return true
    }
    current = next
  }
  return false
}
