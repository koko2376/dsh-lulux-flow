import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Inspector } from '../src/canvas/Inspector.tsx'
import { openTag, suggestions, TemplateField } from '../src/canvas/TemplateField.tsx'
import { RunInspector } from '../src/runs/RunInspector.tsx'
import { Segmented, Switch } from '../src/ui/glass.tsx'
import { useState } from 'react'
import { kernel, run, t, tz, workflow } from './helpers.tsx'

describe('TemplateField', () => {
  it('detects an open tag and filters variables or filters', () => {
    expect(openTag('Hi {{ inp', 9)).toEqual({ start: 6, query: 'inp', kind: 'var' })
    expect(openTag('Hi {{ x }} more', 15)).toBeUndefined()
    expect(openTag('{{ x | up', 9)?.kind).toBe('filter')
    expect(suggestions({ start: 0, query: 'top', kind: 'var' }, ['nodes.a.output', 'inputs.topic'])).toEqual(['inputs.topic'])
  })

  it('opens a listbox on {{ and completes with Enter', () => {
    function Host() {
      const [v, setV] = useState('')
      return <TemplateField id="p" label="Prompt" listLabel="Variables" value={v} onChange={setV} variables={['inputs.topic', 'nodes.review.output']} />
    }
    render(<Host />)
    const box = screen.getByRole('combobox', { name: 'Prompt' }) as HTMLInputElement
    fireEvent.change(box, { target: { value: 'About {{ rev', selectionStart: 12 } })
    const list = screen.getByRole('listbox', { name: 'Variables' })
    expect(within(list).getAllByRole('option').map(o => o.textContent)).toEqual(['nodes.review.output'])
    expect(box.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('About {{ nodes.review.output }}')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('Inspector', () => {
  const base = () => {
    const wf = workflow()
    const onChange = vi.fn()
    const onConnect = vi.fn()
    const node = wf.nodes.find(n => n.id === 'review')!
    render(<Inspector workflow={wf} node={node} issues={[{ level: 'error', code: 'issue.prompt', message: 'issue.prompt', nodeId: 'review' }]} kernels={[kernel(), kernel({ id: 'codex', name: 'Codex', chatRoute: 'lulux-flow-codex' })]} scriptsAllowed={false} t={t} onChange={onChange} onWorkflowChange={vi.fn()} onConnect={onConnect} onDelete={vi.fn()} />)
    return { onChange, onConnect, node }
  }

  it('renders the kernel form with issues and switches kernel', () => {
    const { onChange } = base()
    expect(screen.getByText('A prompt is required')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }))
    expect(onChange.mock.calls.at(-1)![0].config.kernel).toBe('codex')
  })

  it('edits retry policy and continue-on-failure (under Advanced settings)', () => {
    const { onChange } = base()
    const toggle = screen.getByRole('button', { name: /Advanced settings/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('switch', { name: 'Continue on failure' })).toBeNull()
    fireEvent.click(toggle)
    fireEvent.change(screen.getByLabelText('Retries on failure'), { target: { value: '3' } })
    expect(onChange.mock.calls.at(-1)![0].retry).toEqual({ max: 3, backoffMs: 1000 })
    fireEvent.click(screen.getByRole('switch', { name: 'Continue on failure' }))
    expect(onChange.mock.calls.at(-1)![0].continueOnFailure).toBe(true)
  })

  it('connects routes from the keyboard-accessible form', () => {
    const { onConnect } = base()
    fireEvent.click(screen.getByRole('button', { name: /^Connections/ }))
    fireEvent.change(screen.getByLabelText('Connect the Failure route to'), { target: { value: 'output' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add edge' })[1]!)
    expect(onConnect).toHaveBeenCalledWith('review', 'output', 'failure')
  })

  const one = (node: Parameters<typeof Inspector>[0]['node'], kernels = [kernel()]) => {
    const onChange = vi.fn()
    render(<Inspector workflow={workflow({ nodes: [...workflow().nodes.filter(n => n.id !== node.id), node] })} node={node} issues={[]} kernels={kernels} scriptsAllowed={false} t={t} onChange={onChange} onWorkflowChange={vi.fn()} onConnect={vi.fn()} onDelete={vi.fn()} />)
    return { onChange }
  }

  it('states the Kernels page ceiling and flags a node asking for more', () => {
    const node = { id: 'k', type: 'kernel' as const, name: 'K', position: { x: 0, y: 0 }, config: { kernel: 'claude-code', prompt: 'x', permission: 'full', mode: 'global' } }
    one(node)
    const hint = screen.getByText(/Can’t go above the Kernels page setting for Claude Code \(Ask, /)
    expect(hint.className).toMatch(/is-warn/)
    expect(screen.getByText(/templates there are lint errors/)).toBeTruthy()
  })

  it('offers only the levels the chosen CLI enforces', () => {
    const grok = kernel({ id: 'grok', name: 'Grok CLI', permissions: ['read-only', 'ask', 'full'] })
    one({ id: 'k', type: 'kernel', name: 'K', position: { x: 0, y: 0 }, config: { kernel: 'grok', prompt: 'x' } }, [grok])
    const select = screen.getByLabelText('Permission') as HTMLSelectElement
    expect([...select.options].map(o => o.value)).toEqual(['read-only', 'ask', 'full'])
    expect(screen.getByText(/Can’t go above the Kernels page setting for Grok CLI/).className).not.toMatch(/is-warn/)
  })

  it('keeps working directory and preset as fixed text', () => {
    const { onChange } = one({ id: 'a', type: 'agent', name: 'A', position: { x: 0, y: 0 }, config: { prompt: 'x' } })
    const cwd = screen.getByLabelText('Working directory (optional)')
    expect(cwd.getAttribute('role')).not.toBe('combobox')
    fireEvent.change(cwd, { target: { value: '{{ ' } })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange.mock.calls.at(-1)![0].config.cwd).toBe('{{ ')
    expect(screen.getAllByText(/Fixed value only/).length).toBe(2)
  })

  it('explains who can decide an approval node', () => {
    one({ id: 'g', type: 'approval', name: 'G', position: { x: 0, y: 0 }, config: {} })
    expect(screen.getByText(/in the run panel of this canvas or in the DSH approval dialog/)).toBeTruthy()
  })
})

describe('RunInspector', () => {
  it('shows approval gates and evidence; decisions and controls call back', () => {
    const onDecide = vi.fn()
    const onFocus = vi.fn()
    const onCancel = vi.fn()
    const r = run()
    const { rerender } = render(<RunInspector run={r} focusNode={null} t={t} onFocusNode={onFocus} onCancel={onCancel} onResume={vi.fn()} onRerun={vi.fn()} onDecide={onDecide} />)
    expect(screen.getByText('“Gate” is waiting for your decision')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'lgtm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith('gate', true, 'lgtm')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onCancel).toHaveBeenCalled()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2')
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(onFocus).toHaveBeenCalledWith('review')
    rerender(<RunInspector run={r} focusNode="review" t={t} onFocusNode={onFocus} onCancel={onCancel} onResume={vi.fn()} onRerun={vi.fn()} onDecide={onDecide} />)
    expect(screen.getByText(/"verdict": "ok"/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Trace' }))
    expect(screen.getByText('tool Read src/a.ts')).toBeTruthy()
  })

  it('offers resume and rerun for failed runs, in Chinese too', () => {
    render(<RunInspector run={run({ status: 'failed', error: 'boom' })} focusNode={null} t={tz} onFocusNode={vi.fn()} onCancel={vi.fn()} onResume={vi.fn()} onRerun={vi.fn()} onDecide={vi.fn()} />)
    expect(screen.getByRole('button', { name: '继续' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新运行' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull()
  })
})

describe('glass controls', () => {
  it('segmented control is a radiogroup with arrow-key navigation', () => {
    const onChange = vi.fn()
    render(<Segmented label="Views" value="a" onChange={onChange} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    const a = screen.getByRole('radio', { name: 'A' })
    expect(a.getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('switch exposes its state', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} onChange={onChange} label="Allow" />)
    fireEvent.click(screen.getByRole('switch', { name: 'Allow' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
