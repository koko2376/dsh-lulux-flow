import { describe, expect, it } from 'vitest'
import { WorkflowEngine, type StepExecutor } from '../../src/workflow/engine.js'
import { WorkflowStore } from '../../src/workflow/store.js'
import type { EngineEvent, Workflow, WorkflowEdge, WorkflowNode } from '../../src/workflow/types.js'
import { normalizeWorkflow } from '../../src/workflow/validate.js'
import { tempDir } from '../helpers.js'

function wf(nodes: Array<Partial<WorkflowNode> & Pick<WorkflowNode, 'id' | 'type'>>, edges: Array<Partial<WorkflowEdge> & Pick<WorkflowEdge, 'source' | 'target'>>, extra: Partial<Workflow> = {}): Workflow {
  return normalizeWorkflow(
    {
      name: 'test',
      nodes: nodes.map(n => ({ name: n.id, config: {}, position: { x: 0, y: 0 }, ...n })),
      edges: edges.map((e, i) => ({ id: `e${i}`, ...e })),
      ...extra,
    },
    { id: 'wf_test' },
  )
}

function engine(executors: Partial<Record<'agent' | 'kernel' | 'script' | 'http' | 'notify', StepExecutor>>, store = new WorkflowStore(tempDir())) {
  return { engine: new WorkflowEngine({ store, executors, scriptsAllowed: true, knownKernels: () => ['claude-code'] }), store }
}

const echo: StepExecutor = async config => ({ output: config.prompt, usage: { inputTokens: 1, outputTokens: 1 } })

describe('workflow engine', () => {
  it('runs a linear DAG and passes templated values between nodes', async () => {
    const { engine: e } = engine({ agent: echo })
    const run = e.start(
      wf(
        [
          { id: 'in', type: 'input' },
          { id: 'a', type: 'agent', config: { prompt: 'topic={{ inputs.topic }}' } },
          { id: 'b', type: 'agent', config: { prompt: 'got {{ nodes.a.output }}' } },
          { id: 'out', type: 'output', config: { value: '{{ nodes.b.output }}' } },
        ],
        [{ source: 'in', target: 'a' }, { source: 'a', target: 'b' }, { source: 'b', target: 'out' }],
        { inputs: [{ name: 'topic', type: 'string', required: true }] },
      ),
      { topic: 'rivers' },
      { kind: 'api' },
    )
    const done = (await e.wait(run.id))!
    expect(done.status).toBe('succeeded')
    expect(done.output).toBe('got topic=rivers')
    expect(done.usage).toMatchObject({ inputTokens: 2, outputTokens: 2 })
    expect(done.snapshot.nodes).toHaveLength(4)
    expect(done.nodes.a!.input).toEqual({ prompt: 'topic=rivers' })
  })

  it('rejects missing required inputs and invalid graphs', () => {
    const { engine: e } = engine({ agent: echo })
    expect(() => e.start(wf([{ id: 'in', type: 'input' }], [], { inputs: [{ name: 'x', type: 'number', required: true }] }), {}, { kind: 'api' })).toThrow(/missing required input/)
    expect(() => e.start(wf([{ id: 'a', type: 'agent', config: { prompt: 'x' } }, { id: 'b', type: 'agent', config: { prompt: 'y' } }], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }]), {}, { kind: 'api' })).toThrow(/cycle/)
  })

  it('routes condition branches and skips the dead branch', async () => {
    const { engine: e } = engine({ agent: echo })
    const run = e.start(
      wf(
        [
          { id: 'in', type: 'input' },
          { id: 'c', type: 'condition', config: { expression: 'inputs.score >= 0.8' } },
          { id: 'yes', type: 'agent', config: { prompt: 'ship' } },
          { id: 'no', type: 'agent', config: { prompt: 'fix' } },
          { id: 'after_no', type: 'agent', config: { prompt: 'still dead' } },
          { id: 'out', type: 'output' },
        ],
        [
          { source: 'in', target: 'c' },
          { source: 'c', target: 'yes', route: 'true' },
          { source: 'c', target: 'no', route: 'false' },
          { source: 'no', target: 'after_no' },
          { source: 'yes', target: 'out' },
          { source: 'after_no', target: 'out' },
        ],
        { inputs: [{ name: 'score', type: 'number' }] },
      ),
      { score: '0.9' },
      { kind: 'api' },
    )
    const done = (await e.wait(run.id))!
    expect(done.status).toBe('succeeded')
    expect(done.nodes.yes!.status).toBe('succeeded')
    expect(done.nodes.no!.status).toBe('skipped')
    expect(done.nodes.after_no!.status).toBe('skipped')
    expect(done.output).toBe('ship')
  })

  it('retries with backoff, then routes to a failure edge', async () => {
    let calls = 0
    const flaky: StepExecutor = async () => {
      calls += 1
      throw new Error(`boom ${calls}`)
    }
    const { engine: e } = engine({ http: flaky, agent: echo })
    const run = e.start(
      wf(
        [
          { id: 'h', type: 'http', config: { url: 'https://example.com' }, retry: { max: 2, backoffMs: 5 } },
          { id: 'recover', type: 'agent', config: { prompt: 'recovered: {{ nodes.h.error }}' } },
          { id: 'ok', type: 'agent', config: { prompt: 'never' } },
        ],
        [{ source: 'h', target: 'recover', route: 'failure' }, { source: 'h', target: 'ok' }],
      ),
      {},
      { kind: 'api' },
    )
    const done = (await e.wait(run.id))!
    expect(calls).toBe(3)
    expect(done.nodes.h!.attempts).toHaveLength(3)
    expect(done.nodes.h!.status).toBe('failed')
    expect(done.nodes.h!.route).toBe('failure')
    expect(done.nodes.recover!.output).toBe('recovered: boom 3')
    expect(done.nodes.ok!.status).toBe('skipped')
    expect(done.status).toBe('succeeded')
  })

  it('continueOnFailure keeps going with an error output', async () => {
    const { engine: e } = engine({ http: async () => Promise.reject(new Error('down')), agent: echo })
    const run = e.start(
      wf([{ id: 'h', type: 'http', config: { url: 'https://x' }, continueOnFailure: true }, { id: 'a', type: 'agent', config: { prompt: '{{ nodes.h.output.error }}' } }], [{ source: 'h', target: 'a' }]),
      {},
      { kind: 'api' },
    )
    const done = (await e.wait(run.id))!
    expect(done.status).toBe('succeeded')
    expect(done.nodes.a!.output).toBe('down')
  })

  it('unhandled failure fails the run but lets independent branches finish, then resumes from the failed node', async () => {
    let fail = true
    const sometimes: StepExecutor = async config => {
      if (config.prompt === 'fragile' && fail) throw new Error('transient')
      return { output: `done:${String(config.prompt)}` }
    }
    const store = new WorkflowStore(tempDir())
    const { engine: e } = engine({ agent: sometimes }, store)
    const run = e.start(
      wf(
        [
          { id: 'root', type: 'agent', config: { prompt: 'root' } },
          { id: 'fragile', type: 'agent', config: { prompt: 'fragile' } },
          { id: 'side', type: 'agent', config: { prompt: 'side' } },
          { id: 'after', type: 'agent', config: { prompt: 'after {{ nodes.fragile.output }}' } },
        ],
        [{ source: 'root', target: 'fragile' }, { source: 'root', target: 'side' }, { source: 'fragile', target: 'after' }],
      ),
      {},
      { kind: 'api' },
    )
    const failed = (await e.wait(run.id))!
    expect(failed.status).toBe('failed')
    expect(failed.nodes.side!.status).toBe('succeeded')
    expect(failed.nodes.after!.status).toBe('pending')
    fail = false
    e.resume(run.id)
    const resumed = (await e.wait(run.id))!
    expect(resumed.status).toBe('succeeded')
    expect(resumed.resumes).toBe(1)
    expect(resumed.nodes.root!.attempts).toHaveLength(1) // not re-executed
    expect(resumed.nodes.after!.output).toBe('done:after done:fragile')
  })

  it('recovers runs interrupted by a crash and resumes them', async () => {
    const store = new WorkflowStore(tempDir())
    const { engine: first } = engine({ agent: async (_c, ctx) => new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('x')))) }, store)
    const run = first.start(wf([{ id: 'a', type: 'agent', config: { prompt: 'hang' } }], []), {}, { kind: 'api' })
    await new Promise(r => setTimeout(r, 30))
    // Simulate a crash: the engine object disappears without finishing; persisted state says "running".
    const crashed = store.getRun(run.id)!
    expect(crashed.status).toBe('running')
    const second = new WorkflowEngine({ store: new WorkflowStore(store.root), executors: { agent: echo }, scriptsAllowed: false })
    expect(second.recover()).toBe(1)
    expect(['queued', 'running']).toContain(second.resume(run.id).status)
    const done = (await second.wait(run.id))!
    expect(done.status).toBe('succeeded')
    await first.shutdown()
  })

  it('bounded loop over items and until-mode with previous output', async () => {
    const { engine: e } = engine({ agent: async config => ({ output: `${String(config.prompt)}!` }) })
    const run = e.start(
      wf(
        [
          { id: 'l', type: 'loop', config: { items: '{{ inputs.list }}', maxIterations: 2, body: { type: 'agent', config: { prompt: 'item {{ loop.item }} #{{ loop.index }}' } } } },
          { id: 'u', type: 'loop', config: { mode: 'until', until: 'loop.index >= 2', maxIterations: 10, body: { type: 'agent', config: { prompt: 'prev={{ loop.previous }}' } } } },
        ],
        [{ source: 'l', target: 'u' }],
        { inputs: [{ name: 'list', type: 'json' }] },
      ),
      { list: '["a","b","c"]' },
      { kind: 'api' },
    )
    const done = (await e.wait(run.id))!
    expect(done.status).toBe('succeeded')
    expect(done.nodes.l!.output).toEqual({ iterations: 2, results: ['item a #0!', 'item b #1!'], last: 'item b #1!' })
    const u = done.nodes.u!.output as { iterations: number; results: string[] }
    expect(u.iterations).toBe(3)
    expect(u.results[1]).toBe('prev=prev=!!')
  })

  it('approval gate waits, then approve continues and reject fails', async () => {
    const { engine: e } = engine({ agent: echo })
    const graph = wf(
      [
        { id: 'gate', type: 'approval', config: { message: 'Deploy {{ inputs.v }}?' } },
        { id: 'deploy', type: 'agent', config: { prompt: 'deploying' } },
      ],
      [{ source: 'gate', target: 'deploy' }],
      { inputs: [{ name: 'v', type: 'string' }] },
    )
    const events: EngineEvent[] = []
    e.onEvent(ev => events.push(ev))
    const run = e.start(graph, { v: '1.2' }, { kind: 'api' })
    await new Promise(r => setTimeout(r, 30))
    const waiting = e['deps'].store.getRun(run.id)!
    expect(waiting.status).toBe('waiting')
    expect(waiting.nodes.gate!.input).toEqual({ message: 'Deploy 1.2?' })
    expect(e.decide(run.id, 'gate', true, 'canvas')).toBe(true)
    const done = (await e.wait(run.id))!
    expect(done.status).toBe('succeeded')
    expect(done.nodes.gate!.decision).toMatchObject({ approved: true, by: 'canvas' })
    expect(events.some(ev => ev.type === 'run' && ev.run.waitingApprovals.includes('gate'))).toBe(true)

    const run2 = e.start(graph, { v: '2' }, { kind: 'api' })
    await new Promise(r => setTimeout(r, 30))
    e.decide(run2.id, 'gate', false, 'canvas')
    const rejected = (await e.wait(run2.id))!
    expect(rejected.status).toBe('failed')
    expect(rejected.nodes.deploy!.status).toBe('pending')
  })

  it('approval can be answered by an external channel', async () => {
    const { engine: e } = engine({ agent: echo })
    e.setExternalApproval({ ask: async () => ({ approved: true, by: 'dsh-approval' }) })
    const run = e.start(wf([{ id: 'gate', type: 'approval', config: {} }], []), {}, { kind: 'chat' })
    const done = (await e.wait(run.id))!
    expect(done.nodes.gate!.decision?.by).toBe('dsh-approval')
  })

  it('per-node timeout fails the attempt', async () => {
    const { engine: e } = engine({ agent: async (_c, ctx) => new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
    const run = e.start(wf([{ id: 'slow', type: 'agent', config: { prompt: 'x' }, timeoutMs: 50 }], []), {}, { kind: 'api' })
    const done = (await e.wait(run.id))!
    expect(done.status).toBe('failed')
    expect(done.nodes.slow!.error).toMatch(/timed out/)
  })

  it('enforces run budgets and deadlines', async () => {
    const { engine: e } = engine({ agent: async () => ({ output: 'x', usage: { inputTokens: 600, outputTokens: 600 } }) })
    const budget = e.start(
      wf([{ id: 'a', type: 'agent', config: { prompt: 'x' } }, { id: 'b', type: 'agent', config: { prompt: 'y' } }], [{ source: 'a', target: 'b' }], { budget: { maxTokens: 1000 } }),
      {},
      { kind: 'api' },
    )
    const b = (await e.wait(budget.id))!
    expect(b.status).toBe('failed')
    expect(b.error).toMatch(/budget exceeded/)

    const { engine: slow } = engine({ agent: async (_c, ctx) => new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('x')))) })
    const d = slow.start(wf([{ id: 'a', type: 'agent', config: { prompt: 'x' } }], [], { deadlineMs: 60 }), {}, { kind: 'api' })
    const dl = (await slow.wait(d.id))!
    expect(dl.status).toBe('failed')
    expect(dl.error).toMatch(/deadline/)
  })

  it('cancel stops a run and rerun starts from the frozen snapshot', async () => {
    const store = new WorkflowStore(tempDir())
    const { engine: e } = engine({ agent: async (_c, ctx) => new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('x')))) }, store)
    const run = e.start(wf([{ id: 'a', type: 'agent', config: { prompt: 'x' } }], []), {}, { kind: 'api' })
    await new Promise(r => setTimeout(r, 20))
    expect(e.cancel(run.id)).toBe(true)
    const cancelled = (await e.wait(run.id))!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.nodes.a!.status).toBe('cancelled')
    const again = e.rerun(run.id)
    expect(again.rerunOf).toBe(run.id)
    expect(again.trigger.kind).toBe('rerun')
    e.cancel(again.id)
    await e.wait(again.id)
  })

  it('respects concurrency limits', async () => {
    let active = 0
    let peak = 0
    const { engine: e } = engine({
      agent: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise(r => setTimeout(r, 20))
        active -= 1
        return { output: 1 }
      },
    })
    const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, type: 'agent' as const, config: { prompt: 'x' } }))
    const run = e.start(wf(nodes, [], { concurrency: 2 }), {}, { kind: 'api' })
    await e.wait(run.id)
    expect(peak).toBe(2)
  })

  it('refuses script nodes unless opted in', async () => {
    const store = new WorkflowStore(tempDir())
    const e = new WorkflowEngine({ store, executors: { script: async () => ({ output: 1 }) }, scriptsAllowed: false })
    const run = e.start(wf([{ id: 's', type: 'script', config: { code: 'return 1' } }], []), {}, { kind: 'api' })
    const done = (await e.wait(run.id))!
    expect(done.status).toBe('failed')
    expect(done.nodes.s!.error).toMatch(/disabled/)
  })
})
