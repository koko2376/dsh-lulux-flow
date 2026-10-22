import { describe, expect, it } from 'vitest'
import { autoLayout, connect, createNode, hasCycle, localLint, mergeIssues, templateVariables, uniqueId } from '../src/store/graph.ts'
import { workflow } from './helpers.tsx'

describe('graph helpers', () => {
  it('mints unique, safe ids', () => {
    expect(uniqueId('agent', ['agent', 'agent_2'])).toBe('agent_3')
    expect(uniqueId('my node!', [])).toBe('my_node_')
  })

  it('creates nodes with per-type defaults', () => {
    const node = createNode('kernel', { x: 10.4, y: 20.6 }, workflow().nodes, 'Kernel', ['codex'])
    expect(node).toMatchObject({ id: 'kernel', type: 'kernel', position: { x: 10, y: 21 }, config: { kernel: 'codex', permission: 'ask' } })
  })

  it('connects with the route the source allows and ignores duplicates and self-loops', () => {
    const wf = workflow({ nodes: [...workflow().nodes, { id: 'c', type: 'condition', name: 'C', position: { x: 0, y: 0 }, config: { expression: 'true' } }] })
    const a = connect(wf, 'c', 'output', 'false')
    expect(a.edges.at(-1)).toMatchObject({ source: 'c', target: 'output', route: 'false' })
    const b = connect(wf, 'c', 'output', 'success')
    expect(b.edges.at(-1)?.route).toBe('true')
    expect(connect(a, 'c', 'output', 'false').edges).toHaveLength(a.edges.length)
    expect(connect(wf, 'review', 'review')).toBe(wf)
    expect(connect(wf, 'output', 'review')).toBe(wf)
  })

  it('lints locally: prompts, urls, routes, cycles, disabled scripts', () => {
    const wf = workflow()
    expect(localLint(wf, { scriptsAllowed: false })).toEqual([])
    const broken = {
      ...wf,
      nodes: [...wf.nodes.map(n => (n.id === 'review' ? { ...n, config: { kernel: 'claude-code', prompt: ' ' } } : n)), { id: 's', type: 'script' as const, name: 'S', position: { x: 0, y: 0 }, config: { code: 'return 1' } }, { id: 'h', type: 'http' as const, name: 'H', position: { x: 0, y: 0 }, config: {} }],
      edges: [...wf.edges, { id: 'back', source: 'output', target: 'input' }, { id: 'bad', source: 'review', target: 'gate', route: 'true' as const }],
    }
    const codes = localLint(broken, { scriptsAllowed: false }).map(i => `${i.level}:${i.code}:${i.nodeId ?? i.edgeId ?? ''}`)
    expect(codes).toContain('error:issue.prompt:review')
    expect(codes).toContain('warning:issue.scriptDisabled:s')
    expect(codes).toContain('error:issue.url:h')
    expect(codes).toContain('error:issue.route:bad')
    expect(codes).toContain('error:issue.route:back')
    expect(hasCycle(broken)).toBe(true)
  })

  it('prefers Host issues over local duplicates on the same target', () => {
    const merged = mergeIssues([{ level: 'error', message: 'agent node needs a prompt', nodeId: 'a' }], [{ level: 'error', code: 'issue.prompt', message: 'issue.prompt', nodeId: 'a' }, { level: 'error', code: 'issue.cycle', message: 'issue.cycle' }])
    expect(merged.map(i => i.message)).toEqual(['agent node needs a prompt', 'issue.cycle'])
  })

  it('lays out by topological depth', () => {
    const laid = autoLayout(workflow())
    const x = Object.fromEntries(laid.nodes.map(n => [n.id, n.position.x]))
    expect(x.input).toBeLessThan(x.review!)
    expect(x.review).toBeLessThan(x.gate!)
    expect(x.gate).toBeLessThan(x.output!)
  })

  it('offers template variables from inputs and other nodes', () => {
    const vars = templateVariables(workflow(), 'review')
    expect(vars).toContain('inputs.topic')
    expect(vars).toContain('nodes.gate.output')
    expect(vars).not.toContain('nodes.review.output')
    expect(vars).not.toContain('loop.item')
  })
})
