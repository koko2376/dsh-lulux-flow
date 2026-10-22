import { describe, expect, it } from 'vitest'
import { matches, nextRun, parseCron } from '../../src/workflow/cron.js'
import { checkExpression, evaluate } from '../../src/workflow/expr.js'
import { autoLayout, extractJson, generateWorkflow } from '../../src/workflow/generate.js'
import { runScript } from '../../src/workflow/script.js'
import { WorkflowStore } from '../../src/workflow/store.js'
import { lookup, parsePath, referencesIn, renderDeep, renderString, type TemplateScope } from '../../src/workflow/template.js'
import { lintWorkflow, normalizeWorkflow } from '../../src/workflow/validate.js'
import { ReplayCache, signWebhook, verifyWebhook } from '../../src/workflow/webhook.js'
import { tempDir } from '../helpers.js'

const scope: TemplateScope = {
  inputs: { topic: 'river', n: 3, flags: { dry: true } },
  nodes: { a: { output: { score: 0.91, tags: ['x', 'y'], text: 'LGTM ship it' } }, b: { output: '{"nested":{"v":42}}' } },
  run: { id: 'run_1', workflowId: 'wf', trigger: 'api' },
  loop: { item: 'it', index: 1 },
}

describe('templates', () => {
  it('parses paths with brackets and quotes', () => {
    expect(parsePath('nodes.a.output["tag list"][0]')).toEqual(['nodes', 'a', 'output', 'tag list', '0'])
    expect(() => parsePath('nodes..a')).not.toThrow()
    expect(() => parsePath('nodes.a!')).toThrow()
  })
  it('looks up values, drills into JSON text and blocks prototype access', () => {
    expect(lookup(scope, 'nodes.a.output.tags[1]')).toBe('y')
    expect(lookup(scope, 'nodes.b.output.nested.v')).toBe(42)
    expect(lookup(scope, 'nodes.a.output.tags.length')).toBe(2)
    expect(lookup(scope, 'inputs.__proto__')).toBeUndefined()
    expect(lookup(scope, 'inputs.constructor')).toBeUndefined()
  })
  it('keeps raw types for whole-tag strings and interpolates otherwise', () => {
    expect(renderString('{{ nodes.a.output }}', scope)).toEqual(scope.nodes.a!.output)
    expect(renderString('n={{ inputs.n }} {{ inputs.flags | json }}', scope)).toBe('n=3 {"dry":true}')
    expect(renderString('{{ inputs.missing | default("fallback") }}', scope)).toBe('fallback')
    expect(renderString('{{ inputs.topic | upper }}', scope)).toBe('RIVER')
    expect(renderDeep({ a: ['{{ loop.item }}', '#{{ loop.index }}'] }, scope)).toEqual({ a: ['it', '#1'] })
    expect(referencesIn({ x: '{{ nodes.a.output | json }} and {{inputs.n}}' })).toEqual(['nodes.a.output', 'inputs.n'])
  })
})

describe('expressions', () => {
  it('evaluates comparisons, logic and string operators', () => {
    expect(evaluate('nodes.a.output.score >= 0.9 && inputs.flags.dry', scope)).toBe(true)
    expect(evaluate('nodes.a.output.text contains "LGTM" and not inputs.flags.dry', scope)).toBe(false)
    expect(evaluate('{{ inputs.topic }} == "river" || false', scope)).toBe(true)
    expect(evaluate('nodes.a.output.tags contains "y"', scope)).toBe(true)
    expect(evaluate('inputs.topic startsWith "ri"', scope)).toBe(true)
    expect(evaluate('inputs.topic matches "^r.v"', scope)).toBe(true)
    expect(evaluate('(inputs.n > 5) || (loop.index == 1)', scope)).toBe(true)
    expect(evaluate('inputs.n == "3"', scope)).toBe(true)
  })
  it('reports syntax errors without executing code', () => {
    expect(checkExpression('a ==')).toBeDefined()
    expect(checkExpression('process.exit()')).toBeDefined()
    expect(checkExpression('"unterminated')).toBeDefined()
    expect(checkExpression('inputs.x > 1')).toBeUndefined()
  })
})

describe('lint & normalize', () => {
  const ok = normalizeWorkflow({ name: 'w', nodes: [{ id: 'in', type: 'input' }, { id: 'c', type: 'condition', config: { expression: 'inputs.a == 1' } }, { id: 'o', type: 'output' }], edges: [{ source: 'in', target: 'c' }, { source: 'c', target: 'o', route: 'true' }] }, { id: 'wf_ok' })
  it('accepts a valid graph', () => {
    expect(lintWorkflow(ok).filter(i => i.level === 'error')).toEqual([])
  })
  it('catches structural errors', () => {
    const bad = normalizeWorkflow(
      {
        name: 'w',
        nodes: [
          { id: 'a', type: 'agent', config: {} },
          { id: 'a', type: 'nope' },
          { id: 'k', type: 'kernel', config: { kernel: 'unknown', prompt: 'x {{ nodes.ghost.output }}' } },
          { id: 'c', type: 'condition', config: { expression: '((' } },
          { id: 'l', type: 'loop', config: { maxIterations: 1000, body: { type: 'output' } } },
        ],
        edges: [{ source: 'a', target: 'a' }, { source: 'c', target: 'k', route: 'success' }, { source: 'k', target: 'missing' }],
      },
      { id: 'wf_bad' },
    )
    const messages = lintWorkflow(bad, { scriptsAllowed: false, knownKernels: ['claude-code'] }).map(i => i.message).join('\n')
    for (const fragment of ['needs a prompt', 'duplicate node id', 'unknown node type', 'unknown kernel', 'unknown node "ghost"', 'condition:', 'maxIterations', 'loop body', 'self-loop', 'not valid for a condition', 'missing node']) {
      expect(messages).toContain(fragment)
    }
  })
  it('drops unknown keys and clamps values on import', () => {
    const wf = normalizeWorkflow({ name: 'x'.repeat(500), evil: true, concurrency: 99, nodes: [{ id: 'n', type: 'agent', config: { prompt: 'p' }, retry: { max: '2' } }] }, { id: 'wf_x' })
    expect(wf.name).toHaveLength(120)
    expect((wf as unknown as Record<string, unknown>).evil).toBeUndefined()
    expect(wf.concurrency).toBe(16)
    expect(wf.nodes[0]!.retry).toEqual({ max: 2, backoffMs: 1000 })
  })
})

describe('store', () => {
  it('persists workflows/runs atomically and refuses traversal ids', () => {
    const store = new WorkflowStore(tempDir(), 2)
    const wf = store.saveWorkflow(normalizeWorkflow({ name: 'w', nodes: [] }, { id: 'wf_1' }))
    expect(store.getWorkflow('wf_1')?.name).toBe(wf.name)
    expect(() => store.getWorkflow('../../etc/passwd')).toThrow(/invalid/)
    const base = { schemaVersion: 1 as const, workflowId: 'wf_1', workflowName: 'w', status: 'succeeded' as const, trigger: { kind: 'api' as const }, inputs: {}, snapshot: wf, nodes: {}, resumes: 0, usage: { inputTokens: 0, outputTokens: 0, nodeRuns: 0 } }
    for (let i = 0; i < 4; i += 1) store.saveRun({ ...base, id: `run_${i}`, createdAt: new Date(2026, 0, 1, 0, i).toISOString() })
    expect(store.listRuns({ workflowId: 'wf_1' }).map(r => r.id)).toEqual(['run_3', 'run_2'])
    const secret = store.rotateWebhookSecret('wf_1')
    expect(secret).toMatch(/^whsec_/)
    expect(store.webhookFingerprint('wf_1')).toHaveLength(12)
    expect(store.deleteWorkflow('wf_1')).toBe(true)
    expect(store.webhookSecret('wf_1')).toBeUndefined()
  })
})

describe('cron', () => {
  it('parses fields, steps, lists and aliases', () => {
    const spec = parseCron('*/15 9-17 * * 1-5')
    expect(matches(spec, new Date(2026, 9, 21, 9, 30))).toBe(true) // Wednesday
    expect(matches(spec, new Date(2026, 9, 25, 9, 30))).toBe(false) // Sunday
    expect(matches(parseCron('@daily'), new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(() => parseCron('61 * * * *')).toThrow()
    expect(() => parseCron('* * *')).toThrow()
  })
  it('computes the next run', () => {
    const next = nextRun('0 12 * * *', new Date(2026, 0, 1, 12, 0, 30))!
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([2, 12, 0])
  })
})

describe('webhook HMAC', () => {
  it('verifies signature, window and replay', () => {
    const secret = 'whsec_test'
    const body = Buffer.from('{"inputs":{"a":1}}')
    const now = 1_800_000_000
    const sig = signWebhook(secret, now, body)
    const cache = new ReplayCache()
    expect(verifyWebhook(secret, { timestamp: String(now), signature: sig }, body, cache, now)).toEqual({ ok: true })
    expect(verifyWebhook(secret, { timestamp: String(now), signature: sig }, body, cache, now)).toMatchObject({ ok: false, status: 409 })
    expect(verifyWebhook(secret, { timestamp: String(now), signature: signWebhook('other', now, body) }, body, cache, now)).toMatchObject({ ok: false, status: 401 })
    expect(verifyWebhook(secret, { timestamp: String(now - 1000), signature: signWebhook(secret, now - 1000, body) }, body, cache, now)).toMatchObject({ reason: expect.stringContaining('window') })
    expect(verifyWebhook(undefined, { timestamp: String(now), signature: sig }, body, cache, now)).toMatchObject({ ok: false })
  })
})

describe('script sandbox', () => {
  it('returns JSON values and console logs', async () => {
    const result = await runScript('console.log("hi", input.n); return { doubled: input.n * 2 }', { n: 21 }, { timeoutMs: 1000, maxHeapMb: 32 })
    expect(result).toEqual({ value: { doubled: 42 }, logs: ['hi 21'] })
  })
  it('has no require/process and blocks string code generation', async () => {
    await expect(runScript('return typeof require + typeof process + typeof fetch', {}, { timeoutMs: 1000, maxHeapMb: 32 })).resolves.toMatchObject({ value: 'undefinedundefinedundefined' })
    await expect(runScript('return eval("1+1")', {}, { timeoutMs: 1000, maxHeapMb: 32 })).rejects.toThrow(/script error/)
    await expect(runScript('return (function(){}).constructor("return 1")()', {}, { timeoutMs: 1000, maxHeapMb: 32 })).rejects.toThrow(/script error/)
  })
  it('enforces the CPU timeout', async () => {
    await expect(runScript('for(;;){}', {}, { timeoutMs: 200, maxHeapMb: 32 })).rejects.toThrow(/timed out|script error/)
  })
})

describe('AI generation', () => {
  it('extracts fenced JSON, lays out and repairs once', async () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    let round = 0
    const result = await generateWorkflow('summarize a repo', {
      complete: async () => {
        round += 1
        return round === 1
          ? '{"name":"bad","nodes":[{"id":"a","type":"agent","config":{}}],"edges":[]}'
          : 'Sure: {"name":"Summarize","nodes":[{"id":"in","type":"input"},{"id":"a","type":"kernel","config":{"kernel":"claude-code","prompt":"Summarize {{ inputs.repo }}"}},{"id":"out","type":"output","config":{"value":"{{ nodes.a.output }}"}}],"edges":[{"id":"e1","source":"in","target":"a"},{"id":"e2","source":"a","target":"out"}]}'
      },
      lint: wf => lintWorkflow(wf, { scriptsAllowed: false, knownKernels: ['claude-code'] }),
      kernels: ['claude-code'],
      scriptsAllowed: false,
      newId: () => 'wf_gen',
      signal: new AbortController().signal,
    })
    expect(round).toBe(2)
    expect(result.issues.filter(i => i.level === 'error')).toEqual([])
    expect(result.workflow.nodes.map(n => n.position.x)).toEqual([80, 380, 680])
    expect(autoLayout(result.workflow).id).toBe('wf_gen')
  })
})
