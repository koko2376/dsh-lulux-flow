/** Workflow page layout: collapsible, resizable list and inspector, remembered across visits. */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { WorkflowsView } from '../src/canvas/WorkflowsView.tsx'
import { clampWidth, DEFAULT_LAYOUT, fitLayout, LAYOUT_KEY, loadLayout, maxWidth, MIN_CANVAS, PANEL_BOUNDS, saveLayout } from '../src/canvas/layout.ts'
import { createFlowController } from '../src/store/flow.ts'
import { bind, fakeApi, kernel, t, tz, workflow } from './helpers.tsx'

const stored = (): Record<string, unknown> => JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Record<string, unknown>

async function openPage(lang: 'zh' | 'en' = 'zh') {
  const { api } = fakeApi((method, path, body) => {
    if (path === '/workflows' && method === 'GET') return { body: { workflows: [] } }
    if (path === '/workflows' && method === 'POST') return { status: 201, body: { workflow: { ...(body as object), id: 'wf9' }, issues: [], review: { status: 'approved', source: 'canvas', digest: 'd', runnable: true, problem: null } } }
    if (path.startsWith('/workflows/wf9')) return { body: { workflow: { ...workflow(), id: 'wf9' }, issues: [], review: { status: 'approved', source: 'canvas', digest: 'd', runnable: true, problem: null } } }
    if (path.startsWith('/runs')) return { body: { runs: [] } }
    if (path.startsWith('/kernels')) return { body: { kernels: [kernel()] } }
    return undefined
  })
  const { actions, store } = createFlowController(api, { pollMs: 5 })
  await act(async () => actions.newWorkflow('Flow', { input: 'Input', output: 'Output' }))
  const view = render(<WorkflowsView t={lang === 'zh' ? tz : t} locale={lang} useFlow={bind(store)} actions={actions} />)
  const root = view.container.querySelector('.lxf-workflows') as HTMLElement
  const panel = view.container.querySelector('.lxf-panel') as HTMLElement
  const sidebar = view.container.querySelector('.lxf-sidebar') as HTMLElement
  return { actions, root, panel, sidebar, toolbar: screen.getByRole('toolbar') }
}

beforeEach(() => localStorage.clear())

describe('layout helpers', () => {
  it('reads the saved layout and ignores anything malformed', () => {
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT)
    localStorage.setItem(LAYOUT_KEY, '{not json')
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT)
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ left: 9999, right: 'wide', leftOpen: false, rightOpen: 'no' }))
    expect(loadLayout()).toEqual({ left: PANEL_BOUNDS.left.max, right: null, leftOpen: false, rightOpen: true })
    saveLayout({ left: 300, right: 420, leftOpen: true, rightOpen: false })
    expect(loadLayout()).toEqual({ left: 300, right: 420, leftOpen: true, rightOpen: false })
  })

  it('keeps the canvas at least MIN_CANVAS wide', () => {
    expect(maxWidth('right', 0, 248)).toBe(PANEL_BOUNDS.right.max)
    expect(maxWidth('right', 1200, 248)).toBe(1200 - 248 - 24 - MIN_CANVAS)
    expect(clampWidth('left', 100)).toBe(PANEL_BOUNDS.left.min)
    expect(clampWidth('right', 640, 1000, 248)).toBe(368)
    expect(clampWidth('right', 640, 900, 248)).toBe(PANEL_BOUNDS.right.min)
    const fitted = fitLayout({ left: 420, right: 640, leftOpen: true, rightOpen: true }, 1300)
    expect(fitted.left! + fitted.right! + 24 + MIN_CANVAS).toBeLessThanOrEqual(1300)
  })
})

describe('collapsible panels', () => {
  it('collapses and reopens the inspector from the toolbar and its header', async () => {
    const { root, panel, toolbar } = await openPage()
    expect(panel.hidden).toBe(false)
    fireEvent.click(within(toolbar).getByRole('button', { name: '收起面板' }))
    expect(panel.hidden).toBe(true)
    expect(root.classList.contains('is-panel-hidden')).toBe(true)
    expect(screen.queryByRole('separator', { name: '调整检查面板宽度' })).toBeNull()
    expect(stored()).toMatchObject({ rightOpen: false })
    fireEvent.click(within(toolbar).getByRole('button', { name: '展开面板' }))
    expect(panel.hidden).toBe(false)
    fireEvent.click(within(panel).getByRole('button', { name: '收起面板' }))
    expect(panel.hidden).toBe(true)
  })

  it('collapses the workflow list from its header and the toolbar', async () => {
    const { root, sidebar, toolbar } = await openPage('en')
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Collapse list' }))
    expect(sidebar.hidden).toBe(true)
    expect(root.classList.contains('is-list-hidden')).toBe(true)
    const toggle = within(toolbar).getByRole('button', { name: 'Expand list' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(sidebar.hidden).toBe(false)
    expect(stored()).toMatchObject({ leftOpen: true })
  })

  it('does not force the collapsed inspector open on a selection, only marks the toggle', async () => {
    const { panel, toolbar } = await openPage()
    fireEvent.click(within(toolbar).getByRole('button', { name: '收起面板' }))
    fireEvent.click(screen.getByRole('button', { name: '添加智能体节点' }))
    expect(panel.hidden).toBe(true)
    const toggle = within(toolbar).getByRole('button', { name: '展开面板，查看刚选中的内容' })
    fireEvent.click(toggle)
    expect(panel.hidden).toBe(false)
    expect(within(toolbar).getByRole('button', { name: '收起面板' })).toBeTruthy()
  })

  it('opens the inspector when a node is double-clicked', async () => {
    const { panel, toolbar, root } = await openPage()
    fireEvent.click(within(toolbar).getByRole('button', { name: '收起面板' }))
    const node = root.querySelector('.react-flow__node') as HTMLElement
    expect(node).toBeTruthy()
    fireEvent.doubleClick(node)
    expect(panel.hidden).toBe(false)
  })
})

describe('resizable panels', () => {
  it('restores saved widths and collapsed state', async () => {
    saveLayout({ left: 320, right: 500, leftOpen: true, rightOpen: false })
    const { root, panel } = await openPage()
    expect(root.style.getPropertyValue('--lxf-left-w')).toBe('320px')
    expect(root.style.getPropertyValue('--lxf-right-w')).toBe('500px')
    expect(panel.hidden).toBe(true)
  })

  it('resizes with the keyboard within bounds, and Enter or double-click resets', async () => {
    const { root } = await openPage()
    const right = screen.getByRole('separator', { name: '调整检查面板宽度' })
    expect(right.getAttribute('aria-orientation')).toBe('vertical')
    expect(right.getAttribute('aria-valuenow')).toBe('380')
    expect(right.getAttribute('aria-valuemin')).toBe('300')
    expect(right.getAttribute('aria-valuemax')).toBe('640')
    fireEvent.keyDown(right, { key: 'ArrowLeft' })
    expect(right.getAttribute('aria-valuenow')).toBe('396')
    expect(root.style.getPropertyValue('--lxf-right-w')).toBe('396px')
    expect(stored()).toMatchObject({ right: 396 })
    fireEvent.keyDown(right, { key: 'ArrowRight', shiftKey: true })
    expect(right.getAttribute('aria-valuenow')).toBe('332')
    fireEvent.keyDown(right, { key: 'End' })
    expect(right.getAttribute('aria-valuenow')).toBe('640')
    fireEvent.keyDown(right, { key: 'Enter' })
    expect(root.style.getPropertyValue('--lxf-right-w')).toBe('')
    expect(stored()).toMatchObject({ right: null })

    const left = screen.getByRole('separator', { name: '调整工作流列表宽度' })
    fireEvent.keyDown(left, { key: 'ArrowRight' })
    expect(left.getAttribute('aria-valuenow')).toBe('264')
    fireEvent.keyDown(left, { key: 'Home' })
    expect(left.getAttribute('aria-valuenow')).toBe('200')
    fireEvent.doubleClick(left)
    expect(left.getAttribute('aria-valuenow')).toBe('248')
    expect(stored()).toMatchObject({ left: null })
  })

  it('drags the list wider with the pointer', async () => {
    const { root } = await openPage()
    const left = screen.getByRole('separator', { name: '调整工作流列表宽度' })
    fireEvent.pointerDown(left, { pointerId: 1, button: 0, clientX: 254 })
    expect(root.classList.contains('is-resizing')).toBe(true)
    fireEvent.pointerMove(left, { pointerId: 1, clientX: 354 })
    expect(root.style.getPropertyValue('--lxf-left-w')).toBe('348px')
    fireEvent.pointerMove(left, { pointerId: 1, clientX: 900 })
    expect(root.style.getPropertyValue('--lxf-left-w')).toBe('420px')
    fireEvent.pointerUp(left, { pointerId: 1, clientX: 900 })
    expect(root.classList.contains('is-resizing')).toBe(false)
    expect(stored()).toMatchObject({ left: 420 })
  })
})
