/**
 * The simplified workflow page: grouped palette with plain-language hints,
 * essential fields first, advanced settings collapsed, variables inserted
 * from a picker, readable fit-to-view, the "More" toolbar menu and the
 * getting-started empty state.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { readableViewport, READABLE_ZOOM } from '../src/canvas/Canvas.tsx'
import { Inspector } from '../src/canvas/Inspector.tsx'
import { ADVANCED_NODE_TYPES, COMMON_NODE_TYPES, Palette } from '../src/canvas/Palette.tsx'
import { insertVariable, TemplateField } from '../src/canvas/TemplateField.tsx'
import { WorkflowsView } from '../src/canvas/WorkflowsView.tsx'
import { NODE_TYPES } from '../src/api/types.ts'
import { createFlowController } from '../src/store/flow.ts'
import { variableOptions } from '../src/store/graph.ts'
import { bind, fakeApi, kernel, t, tz, workflow } from './helpers.tsx'

describe('palette', () => {
  it('shows the everyday steps with a hint each, and the rest under a collapsed group', () => {
    const onAdd = vi.fn()
    render(<Palette t={tz} scriptsAllowed={false} onAdd={onAdd} />)
    const nav = screen.getByRole('navigation', { name: '节点面板' })
    expect(within(nav).getAllByRole('button', { name: /^添加/ }).map(b => b.getAttribute('aria-label'))).toEqual(['添加输入节点', '添加智能体节点', '添加内核节点', '添加输出节点'])
    expect(within(nav).getByText('用 DSH 当前模型完成一步')).toBeTruthy()
    expect(within(nav).getByText('调用 Claude Code / Codex 等编程 CLI，同样用你的 DSH 模型')).toBeTruthy()
    const more = within(nav).getByRole('button', { name: '更多步骤' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(within(nav).getByRole('button', { name: '添加条件节点' })).toBeTruthy()
    fireEvent.click(within(nav).getByRole('button', { name: '添加审批节点' }))
    expect(onAdd).toHaveBeenCalledWith('approval')
  })
  it('still offers every node type', () => {
    expect([...COMMON_NODE_TYPES, ...ADVANCED_NODE_TYPES].sort()).toEqual([...NODE_TYPES].sort())
  })
})

describe('inspector', () => {
  const render1 = (node: Parameters<typeof Inspector>[0]['node']) => {
    const onChange = vi.fn()
    const wf = workflow({ nodes: [...workflow().nodes.filter(n => n.id !== node.id), node] })
    render(<Inspector workflow={wf} node={node} issues={[]} kernels={[kernel()]} scriptsAllowed={false} t={t} onChange={onChange} onWorkflowChange={vi.fn()} onConnect={vi.fn()} onDelete={vi.fn()} />)
    return { onChange }
  }
  it('explains the step in plain words and keeps the advanced fields closed', () => {
    render1({ id: 'a', type: 'agent', name: 'Draft', position: { x: 0, y: 0 }, config: { prompt: 'x' } })
    expect(screen.getByText('One step done by your current DSH model')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Prompt' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'System prompt (optional)' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Advanced settings/ }))
    expect(screen.getByRole('combobox', { name: 'System prompt (optional)' })).toBeTruthy()
  })
  it('opens the advanced fields when one of them is already set', () => {
    render1({ id: 'a', type: 'agent', name: 'Draft', position: { x: 0, y: 0 }, config: { prompt: 'x', model: 'deepseek/deepseek-chat' }, retry: { max: 2, backoffMs: 1000 } })
    expect(screen.getByRole('button', { name: /Advanced settings/ }).getAttribute('aria-expanded')).toBe('true')
  })
  it('inserts a variable picked by name, without typing {{ }}', () => {
    const { onChange } = render1({ id: 'a', type: 'agent', name: 'Draft', position: { x: 0, y: 0 }, config: { prompt: 'Summarize' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Insert variable' })[0]!)
    const picker = screen.getByRole('group', { name: 'Insert variable' })
    expect(within(picker).getByText('Run inputs')).toBeTruthy()
    fireEvent.click(within(picker).getByRole('button', { name: /Result of “Review”/ }))
    expect(onChange.mock.calls.at(-1)![0].config.prompt).toBe('Summarize {{ nodes.review.output }}')
  })
})

describe('variables', () => {
  it('are named for people, not by template path', () => {
    const options = variableOptions(workflow(), 'gate', (key, params) => `${key}${params?.name ? `:${params.name}` : ''}`)
    expect(options.filter(o => o.group === 'inputs')).toEqual([{ value: 'inputs.topic', label: 'inspector.var.input:topic', group: 'inputs' }])
    expect(options.find(o => o.value === 'nodes.review.output')?.label).toBe('inspector.var.output:Review')
    // the step itself and the output step are not offered
    expect(options.some(o => o.value.startsWith('nodes.gate.') || o.value.startsWith('nodes.output.'))).toBe(false)
  })
  it('are inserted at the caret with spacing', () => {
    expect(insertVariable('Hi', 2, 'inputs.topic')).toEqual({ text: 'Hi {{ inputs.topic }}', caret: 21 })
    expect(insertVariable('ab', 1, 'x')).toEqual({ text: 'a {{ x }} b', caret: 10 })
    expect(insertVariable('', 0, 'x').text).toBe('{{ x }}')
  })
  it('the picker inserts where the caret was', () => {
    function Host() {
      const [v, setV] = useState('About  today')
      return <TemplateField id="p" label="Prompt" listLabel="Variables" value={v} onChange={setV} variables={[]} options={[{ value: 'inputs.topic', label: 'Input topic', group: 'inputs' }]} pickerText={{ insert: 'Insert variable', none: 'None', groups: { inputs: 'Inputs', nodes: 'Nodes', loop: 'Loop', run: 'Run' } }} />
    }
    render(<Host />)
    const box = screen.getByRole('combobox', { name: 'Prompt' }) as HTMLInputElement
    box.focus()
    box.setSelectionRange(6, 6)
    fireEvent.blur(box)
    fireEvent.click(screen.getByRole('button', { name: 'Insert variable' }))
    fireEvent.click(screen.getByRole('button', { name: /Input topic/ }))
    expect(box.value).toBe('About {{ inputs.topic }} today')
  })
})

describe('fit to view', () => {
  it('never goes below a readable zoom; a wide graph starts at its first step', () => {
    const small = readableViewport({ x: 0, y: 0, width: 600, height: 200 }, 1600, 900)
    expect(small.zoom).toBe(1)
    const wide = readableViewport({ x: 80, y: 0, width: 6000, height: 300 }, 1400, 800)
    expect(wide.zoom).toBe(READABLE_ZOOM)
    // first node sits right after the palette
    expect(wide.x + 80 * wide.zoom).toBeCloseTo(244)
  })
})

describe('workflow page', () => {
  const setup = () => {
    const { api, calls } = fakeApi((method, path, body) => {
      if (path === '/workflows' && method === 'GET') return { body: { workflows: [] } }
      if (path === '/workflows' && method === 'POST') return { status: 201, body: { workflow: { ...(body as object), id: 'wf9' }, issues: [], review: { status: 'approved', source: 'canvas', digest: 'd', runnable: true, problem: null } } }
      if (path.startsWith('/workflows/wf9')) return { body: { workflow: { ...workflow(), id: 'wf9' }, issues: [], review: { status: 'approved', source: 'canvas', digest: 'd', runnable: true, problem: null } } }
      if (path.startsWith('/runs')) return { body: { runs: [] } }
      if (path.startsWith('/kernels')) return { body: { kernels: [kernel()] } }
      return undefined
    })
    const controller = createFlowController(api, { pollMs: 5 })
    return { actions: controller.actions, useFlow: bind(controller.store), calls }
  }
  it('greets a first-time user with three steps and creates a workflow with named steps', async () => {
    const { actions, useFlow, calls } = setup()
    await act(async () => actions.refreshWorkflows())
    render(<WorkflowsView t={tz} locale="zh" useFlow={useFlow} actions={actions} />)
    expect(screen.getByText('从这里开始搭一个工作流')).toBeTruthy()
    expect(screen.getByText('点右上角的「运行」')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '新建工作流' }).at(-1)!)
    })
    const created = calls.find(c => c.method === 'POST' && c.path === '/workflows')?.body as { nodes: Array<{ name: string }> }
    expect(created.nodes.map(n => n.name)).toEqual(['输入', '输出'])
  })
  it('keeps rarely used actions in a labelled More menu', async () => {
    const { actions, useFlow } = setup()
    await act(async () => actions.newWorkflow('Flow', { input: 'Input', output: 'Output' }))
    render(<WorkflowsView t={t} locale="en" useFlow={useFlow} actions={actions} />)
    const toolbar = screen.getByRole('toolbar')
    expect(within(toolbar).queryByRole('button', { name: 'Auto layout' })).toBeNull()
    fireEvent.click(within(toolbar).getByRole('button', { name: /More/ }))
    const menu = screen.getByRole('menu', { name: 'More' })
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual([
      'Auto layoutTidy up the node positions',
      'TriggersRun on a schedule or from a webhook',
      'Run historyPast runs of this workflow',
      'Export JSONDownload as a JSON file to share or back up',
      'Check for updatesSee whether a newer release is on GitHub',
    ])
  })
})
