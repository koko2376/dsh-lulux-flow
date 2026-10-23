/** Component tests for KernelSwitcher, KernelsView and SettingsSection against a fake plugin API. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { KernelInfo, Meta, UpdateStatus } from '../src/api/types.ts'
import { KernelsView } from '../src/kernels/KernelsView.tsx'
import { KernelSwitcher, type DirectoryView } from '../src/session/KernelSwitcher.tsx'
import { SettingsSection } from '../src/settings/SettingsSection.tsx'
import { createFlowController } from '../src/store/flow.ts'
import { createStore } from '../src/store/store.ts'
import { bind, fakeApi, kernel, t, tz, type Route } from './helpers.tsx'
import { UpdateNotice } from '../src/update/UpdateNotice.tsx'
import { Toasts } from '../src/Toasts.tsx'

const meta = (partial: Partial<Meta> = {}): Meta => ({
  brand: { id: 'dsh-lulux-flow', displayName: 'DSH-LULUX Flow' },
  version: 'test',
  scriptsAllowed: false,
  scriptsSource: null,
  gateway: { listening: true },
  upstream: { provider: 'deepseek', model: 'deepseek-chat' },
  upstreamSource: 'dsh-default',
  upstreamError: null,
  ...partial,
})

const KERNELS = (): KernelInfo[] => [
  kernel(),
  kernel({ id: 'codex', name: 'Codex', vendor: 'OpenAI', npmPackage: '@openai/codex', avatar: 'codex.png', chatRoute: 'lulux-flow-codex', provider: 'lulux-flow-codex', version: '0.48.0' }),
  kernel({ id: 'gemini-cli', name: 'Gemini CLI', vendor: 'Google', avatar: 'gemini-cli.png', chatRoute: 'lulux-flow-gemini-cli', provider: 'lulux-flow-gemini-cli', settings: { enabled: false, mode: 'scoped', permission: 'ask', binaryPath: '' } }),
  kernel({ id: 'grok', name: 'Grok CLI', vendor: 'xAI', avatar: 'grok.png', chatRoute: 'lulux-flow-grok', provider: 'lulux-flow-grok', permissions: ['read-only', 'ask', 'full'], installed: false, version: undefined, settings: { enabled: false, mode: 'scoped', permission: 'ask', binaryPath: '' } }),
]

function setup(extra: Route = () => undefined, opts: { meta?: Meta; settings?: Record<string, unknown> } = {}) {
  let settings: Record<string, unknown> = { kernels: {}, registryOverride: '', gatewayModel: '', allowScriptNodes: false, registryTrustMirror: false, ...opts.settings }
  let currentMeta = opts.meta ?? meta()
  const { api, calls } = fakeApi((method, path, body) => {
    const x = extra(method, path, body)
    if (x) return x
    if (method === 'GET' && path === '/meta') return { body: currentMeta }
    if (method === 'GET' && path.startsWith('/kernels')) return { body: { kernels: KERNELS() } }
    if (method === 'GET' && path.startsWith('/registries')) return { body: { registries: { packageName: '@openai/codex', referenceVersion: '0.48.0', results: [] } } }
    if (method === 'GET' && path === '/settings') return { body: { settings } }
    if (method === 'PUT' && path === '/settings') {
      const patch = body as Record<string, unknown>
      settings = { ...settings, ...patch, kernels: { ...(settings.kernels as object), ...((patch.kernels as object | undefined) ?? {}) } }
      if (typeof patch.allowScriptNodes === 'boolean') currentMeta = { ...currentMeta, scriptsAllowed: patch.allowScriptNodes, scriptsSource: patch.allowScriptNodes ? 'settings' : null }
      return { body: { settings } }
    }
    return undefined
  })
  const controller = createFlowController(api, { pollMs: 5 })
  return { ...controller, calls, useFlow: bind(controller.store) }
}

describe('KernelsView', () => {
  it('renders one card per kernel with version, defaults and route', async () => {
    const { actions, useFlow } = setup()
    await act(() => actions.refreshKernels())
    render(<KernelsView t={t} useFlow={useFlow} actions={actions} />)
    expect(screen.getAllByRole('article')).toHaveLength(4)
    const claude = screen.getByRole('article', { name: 'Claude Code' })
    expect(within(claude).getByText('v2.1.4')).toBeTruthy()
    expect(within(claude).getByText('lulux-flow-claude-code')).toBeTruthy()
    expect(within(claude).getByRole('switch', { name: /Claude Code/ }).getAttribute('aria-checked')).toBe('true')
    const gemini = screen.getByRole('article', { name: 'Gemini CLI' })
    expect(within(gemini).getByRole('switch', { name: /Gemini CLI/ }).getAttribute('aria-checked')).toBe('false')
    const grok = screen.getByRole('article', { name: 'Grok CLI' })
    expect(within(grok).getByText('Not installed')).toBeTruthy()
    expect((within(grok).getByRole('button', { name: /Test/ }) as HTMLButtonElement).disabled).toBe(true)
    const grokPermission = within(grok).getByLabelText(/Permission/) as HTMLSelectElement
    expect([...grokPermission.options].map(o => o.value)).not.toContain('edit')
  })

  it('runs the connection test through POST /kernels/:id/test and shows latency', async () => {
    const { actions, useFlow, calls } = setup((method, path) => (method === 'POST' && path === '/kernels/claude-code/test' ? { body: { ok: true, latencyMs: 812, output: 'OK' } } : undefined))
    await act(() => actions.refreshKernels())
    render(<KernelsView t={t} useFlow={useFlow} actions={actions} />)
    const claude = screen.getByRole('article', { name: 'Claude Code' })
    fireEvent.click(within(claude).getByRole('button', { name: /Test/ }))
    await waitFor(() => expect(within(claude).getByRole('status').textContent).toMatch(/812/))
    expect(calls.find(c => c.path === '/kernels/claude-code/test')?.headers['x-lulux-flow-request']).toBe('1')
  })

  it('shows the error of a failed test', async () => {
    const { actions, useFlow } = setup((method, path) => (method === 'POST' && path === '/kernels/codex/test' ? { body: { ok: false, latencyMs: 40, error: 'no real model is configured' } } : undefined))
    await act(() => actions.refreshKernels())
    render(<KernelsView t={t} useFlow={useFlow} actions={actions} />)
    const codex = screen.getByRole('article', { name: 'Codex' })
    fireEvent.click(within(codex).getByRole('button', { name: /Test/ }))
    await waitFor(() => expect(within(codex).getByRole('status').textContent).toMatch(/no real model is configured/))
  })

  it('saves permission and enabled changes to settings', async () => {
    const { actions, useFlow, calls } = setup()
    await act(() => actions.refreshKernels())
    render(<KernelsView t={t} useFlow={useFlow} actions={actions} />)
    const gemini = screen.getByRole('article', { name: 'Gemini CLI' })
    fireEvent.click(within(gemini).getByRole('switch', { name: /Gemini CLI/ }))
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && JSON.stringify(c.body) === JSON.stringify({ kernels: { 'gemini-cli': { enabled: true } } }))).toBe(true))
    fireEvent.change(within(gemini).getByLabelText(/Permission/), { target: { value: 'edit' } })
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && JSON.stringify(c.body) === JSON.stringify({ kernels: { 'gemini-cli': { permission: 'edit' } } }))).toBe(true))
  })
})

describe('SettingsSection', () => {
  it('loads settings, validates the gateway model and saves', async () => {
    const { actions, useFlow, calls } = setup()
    render(<SettingsSection t={t} useFlow={useFlow} actions={actions} />)
    const input = (await screen.findByPlaceholderText('deepseek/deepseek-chat')) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'not a model' } })
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'deepseek/deepseek-reasoner' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && (c.body as { gatewayModel?: string }).gatewayModel === 'deepseek/deepseek-reasoner')).toBe(true))
  })

  it('shows script nodes read-only: off, with how to enable them in the plugin config', async () => {
    const { actions, useFlow, calls } = setup()
    render(<SettingsSection t={t} useFlow={useFlow} actions={actions} />)
    const toggle = (await screen.findByRole('switch', { name: 'Allow script nodes' })) as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/allowScriptNodes: true in the plugin config/)).toBeTruthy()
    fireEvent.click(toggle)
    await new Promise(r => setTimeout(r, 10))
    expect(calls.some(c => c.method === 'PUT' && 'allowScriptNodes' in (c.body as object))).toBe(false)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('reflects script nodes enabled by the plugin config', async () => {
    const { actions, useFlow, store } = setup(undefined, { meta: meta({ scriptsAllowed: true, scriptsSource: 'config' }) })
    store.set(s => ({ ...s, meta: meta({ scriptsAllowed: true, scriptsSource: 'config' }) }))
    render(<SettingsSection t={t} useFlow={useFlow} actions={actions} />)
    const toggle = (await screen.findByRole('switch', { name: 'Allow script nodes' })) as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/Set by allowScriptNodes in the plugin config/)).toBeTruthy()
  })

  it('saves the trust-mirror toggle', async () => {
    const { actions, useFlow, calls } = setup(undefined, { settings: { registryTrustMirror: false } })
    render(<SettingsSection t={t} useFlow={useFlow} actions={actions} />)
    const toggle = await screen.findByRole('switch', { name: 'Trust mirror when registry.npmjs.org is unreachable' })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && JSON.stringify(c.body) === JSON.stringify({ registryTrustMirror: true }))).toBe(true))
    await waitFor(() => expect(screen.getByRole('switch', { name: /Trust mirror/ }).getAttribute('aria-checked')).toBe('true'))
  })

  it('accepts only https registry overrides (http on loopback) and shows the Host message on 400', async () => {
    const { actions, useFlow } = setup((method, path, body) =>
      method === 'PUT' && path === '/settings' && (body as { registryOverride?: string }).registryOverride === 'https://bad.example'
        ? { status: 400, body: { error: 'registry must be an https:// URL (http:// only for 127.0.0.1/localhost)' } }
        : undefined,
    )
    render(<SettingsSection t={t} useFlow={useFlow} actions={actions} />)
    const input = (await screen.findByPlaceholderText('https://registry.npmmirror.com')) as HTMLInputElement
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    fireEvent.change(input, { target: { value: 'http://mirror.example.com' } })
    expect(save.disabled).toBe(true)
    expect(screen.getByText(/http:\/\/ only for localhost/)).toBeTruthy()
    fireEvent.change(input, { target: { value: 'https://user:pw@mirror.example.com' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'http://127.0.0.1:4873' } })
    expect(save.disabled).toBe(false)
    fireEvent.change(input, { target: { value: 'https://bad.example' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/registry must be an https:\/\/ URL/))
  })

  it('offers Grok CLI only the permission levels it can enforce', async () => {
    const { actions, useFlow } = setup()
    render(<SettingsSection t={t} useFlow={useFlow} actions={actions} />)
    const grok = (await screen.findByRole('combobox', { name: 'Permission for Grok CLI' })) as HTMLSelectElement
    expect([...grok.options].map(o => o.value)).toEqual(['read-only', 'ask', 'full'])
    const claude = screen.getByRole('combobox', { name: 'Permission for Claude Code' }) as HTMLSelectElement
    expect([...claude.options].map(o => o.value)).toEqual(['read-only', 'ask', 'edit', 'full'])
  })

  it('resets kernel defaults to Claude Code + Codex on, permission ask', async () => {
    const { actions, useFlow, calls } = setup()
    render(<SettingsSection t={t} useFlow={useFlow} actions={actions} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore defaults' }))
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && (c.body as { kernels?: object }).kernels !== undefined)).toBe(true))
    const body = calls.find(c => c.method === 'PUT' && (c.body as { kernels?: object }).kernels !== undefined)!.body as { kernels: Record<string, { enabled: boolean; permission: string }> }
    expect(body.kernels['claude-code']).toEqual({ enabled: true, permission: 'ask' })
    expect(body.kernels.codex).toEqual({ enabled: true, permission: 'ask' })
    expect(body.kernels['gemini-cli']).toEqual({ enabled: false, permission: 'ask' })
  })
})

describe('KernelSwitcher', () => {
  const directory = (current: DirectoryView['current']) =>
    createStore<DirectoryView>({
      current,
      status: 'ready',
      pending: null,
      error: null,
      groups: [
        { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
        { id: 'lulux-flow-claude-code', name: 'Claude Code', models: [{ id: 'default', name: 'default' }] },
        { id: 'lulux-flow-codex', name: 'Codex', models: [{ id: 'default', name: 'default' }] },
        { id: 'lulux-flow-gemini-cli', name: 'Gemini CLI', models: [{ id: 'default', name: 'default' }] },
      ],
    })

  async function mount(current: DirectoryView['current'], select = vi.fn(async () => true)) {
    const { actions, useFlow } = setup()
    await act(() => actions.refreshKernels())
    const remember = vi.fn()
    const load = vi.fn()
    render(<KernelSwitcher t={t} useDirectory={bind(directory(current))} useFlow={useFlow} available load={load} select={select} previous={() => undefined} remember={remember} />)
    return { select, remember, load }
  }

  it('shows the current model (DSH agent) and lists kernels with their state', async () => {
    const { load } = await mount({ provider: 'deepseek', model: 'deepseek-chat' })
    const button = screen.getByRole('button', { name: /current DSH agent/ })
    fireEvent.click(button)
    expect(load).toHaveBeenCalled()
    const list = screen.getByRole('listbox')
    const options = within(list).getAllByRole('option')
    expect(options.map(o => o.querySelector('.lxf-switcher__name')?.textContent)).toEqual(['DSH agent', 'Claude Code', 'Codex', 'Gemini CLI', 'Grok CLI'])
    expect(options[0]!.getAttribute('aria-selected')).toBe('true')
    expect(within(options[3]!).getByText('turned off in Kernels')).toBeTruthy()
    expect(options[3]!.getAttribute('aria-disabled')).toBe('true')
    expect(options[4]!.getAttribute('aria-disabled')).toBe('true')
    expect(list.querySelectorAll('img').length).toBe(5)
  })

  it('switches to a kernel chat route and remembers the previous model', async () => {
    const { select, remember } = await mount({ provider: 'deepseek', model: 'deepseek-chat' })
    fireEvent.click(screen.getByRole('button', { name: /current DSH agent/ }))
    fireEvent.click(screen.getByRole('option', { name: /Claude Code/ }))
    await waitFor(() => expect(select).toHaveBeenCalledWith({ provider: 'lulux-flow-claude-code', model: 'default' }))
    expect(remember).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-chat' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  })

  it('offers the gateway model for "DSH agent" when the session has no earlier model', async () => {
    const { actions, useFlow } = setup()
    await act(async () => {
      await actions.refreshKernels()
      await actions.refreshMeta()
    })
    const dir = directory({ provider: 'lulux-flow-claude-code', model: 'default' })
    dir.set(d => ({ ...d, groups: [{ id: 'openrouter', name: 'OpenRouter', models: [{ id: 'some-model', name: 'Some' }] }, ...d.groups] }))
    const select = vi.fn(async () => true)
    render(<KernelSwitcher t={t} useDirectory={bind(dir)} useFlow={useFlow} available load={vi.fn()} select={select} previous={() => undefined} remember={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /current Claude Code/ }))
    const dsh = screen.getByRole('option', { name: /DSH agent/ })
    expect(within(dsh).getByText('deepseek/deepseek-chat')).toBeTruthy()
    fireEvent.click(dsh)
    await waitFor(() => expect(select).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-chat' }))
  })

  it('ignores disabled kernels', async () => {
    const { select } = await mount({ provider: 'lulux-flow-codex', model: 'default' })
    expect(screen.getByRole('button', { name: /current Codex/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /current Codex/ }))
    fireEvent.click(screen.getByRole('option', { name: /Gemini CLI/ }))
    await new Promise(r => setTimeout(r, 10))
    expect(select).not.toHaveBeenCalled()
  })
})

// ── update notice (notify only) ──

const updateStatus = (partial: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: '0.1.1',
  latest: '0.2.0',
  updateAvailable: true,
  notice: true,
  url: 'https://github.com/koko2376/dsh-lulux-flow/releases/tag/v0.2.0',
  notes: ['Faster kernels', '<img src=x onerror=alert(1)> stays text'],
  publishedAt: '2026-10-30T00:00:00.000Z',
  source: 'github-api',
  checkedAt: '2026-10-30T01:00:00.000Z',
  lastError: null,
  skippedVersion: null,
  remindUntil: null,
  checking: false,
  autoCheck: true,
  sourceMode: 'auto',
  ...partial,
})

function updateSetup(initial: UpdateStatus, check?: () => { status?: number; body: unknown }) {
  let status = initial
  return setup((method, path, body) => {
    if (method === 'GET' && path === '/update') return { body: { update: status } }
    if (method === 'POST' && path === '/update/remind') {
      status = { ...status, notice: false, remindUntil: '2026-10-31T01:00:00.000Z' }
      return { body: { update: status } }
    }
    if (method === 'POST' && path === '/update/skip') {
      status = { ...status, notice: false, skippedVersion: (body as { version: string }).version }
      return { body: { update: status } }
    }
    if (method === 'POST' && path === '/update/check') return check?.() ?? { body: { outcome: 'latest', update: status } }
    return undefined
  })
}

describe('UpdateNotice', () => {
  it('shows a chip with versions, text-only notes and an allowlisted release link', async () => {
    const { actions, useFlow } = updateSetup(updateStatus())
    await act(() => actions.refreshUpdate())
    const { container } = render(<UpdateNotice t={t} useFlow={useFlow} actions={actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Version 0.2.0 is available; show details' }))
    const dialog = screen.getByRole('dialog', { name: 'Update available' })
    expect(within(dialog).getByText('Current 0.1.1 → latest 0.2.0')).toBeTruthy()
    expect(within(dialog).getByText('<img src=x onerror=alert(1)> stays text')).toBeTruthy()
    expect(document.querySelector('.lxf-update img')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    const link = within(dialog).getByRole('link', { name: 'View release' }) as HTMLAnchorElement
    expect(link.href).toBe('https://github.com/koko2376/dsh-lulux-flow/releases/tag/v0.2.0')
    expect(link.rel).toContain('noopener')
    expect(link.target).toBe('_blank')
  })

  it('never links anywhere but the GitHub releases of this repository', async () => {
    const { actions, useFlow } = updateSetup(updateStatus({ url: 'https://evil.example/releases/tag/v0.2.0', notes: [] }))
    await act(() => actions.refreshUpdate())
    render(<UpdateNotice t={t} useFlow={useFlow} actions={actions} />)
    fireEvent.click(screen.getByRole('button', { name: /0\.2\.0/ }))
    expect((screen.getByRole('link', { name: 'View release' }) as HTMLAnchorElement).href).toBe('https://github.com/koko2376/dsh-lulux-flow/releases')
    expect(screen.getByText('Release notes are on the GitHub release page.')).toBeTruthy()
  })

  it('stays hidden without a notice', async () => {
    const { actions, useFlow } = updateSetup(updateStatus({ notice: false }))
    await act(() => actions.refreshUpdate())
    const { container } = render(<UpdateNotice t={t} useFlow={useFlow} actions={actions} />)
    expect(container.innerHTML).toBe('')
  })

  it('remind later and skip this version go to the Host and hide the chip', async () => {
    const first = updateSetup(updateStatus())
    await act(() => first.actions.refreshUpdate())
    const view = render(<UpdateNotice t={t} useFlow={first.useFlow} actions={first.actions} />)
    fireEvent.click(screen.getByRole('button', { name: /0\.2\.0/ }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remind later' })))
    expect(first.calls.some(c => c.method === 'POST' && c.path === '/update/remind')).toBe(true)
    await waitFor(() => expect(screen.queryByRole('button', { name: /0\.2\.0/ })).toBeNull())
    view.unmount()

    const second = updateSetup(updateStatus())
    await act(() => second.actions.refreshUpdate())
    render(<UpdateNotice t={tz} useFlow={second.useFlow} actions={second.actions} />)
    fireEvent.click(screen.getByRole('button', { name: '有新版本 0.2.0，查看详情' }))
    expect(screen.getByRole('link', { name: '查看更新' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '稍后提醒' })).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '忽略此版本' })))
    expect(second.calls.find(c => c.method === 'POST' && c.path === '/update/skip')?.body).toEqual({ version: '0.2.0' })
    await waitFor(() => expect(screen.queryByRole('button', { name: /0\.2\.0/ })).toBeNull())
  })

  it('manual check toasts up to date / new version / failed', async () => {
    let answer: { status?: number; body: unknown } = { body: { outcome: 'latest', update: updateStatus({ latest: '0.1.1', updateAvailable: false, notice: false }) } }
    const { actions, useFlow, store } = updateSetup(updateStatus({ notice: false }), () => answer)
    render(<Toasts t={tz} useFlow={useFlow} actions={actions} />)
    await act(() => actions.checkForUpdates())
    expect(screen.getByText('已是最新版本（0.1.1）')).toBeTruthy()
    answer = { body: { outcome: 'available', update: updateStatus() } }
    await act(() => actions.checkForUpdates())
    expect(screen.getByText('有新版本：0.2.0')).toBeTruthy()
    expect(store.getSnapshot().update.status?.notice).toBe(true)
    answer = { body: { outcome: 'failed', update: updateStatus() } }
    await act(() => actions.checkForUpdates())
    answer = { status: 500, body: { error: 'boom' } }
    await act(() => actions.checkForUpdates())
    expect(screen.getAllByText('检查更新失败，请稍后再试').length).toBeGreaterThanOrEqual(1)
    expect(store.getSnapshot().update.checking).toBe(false)
  })

  it('a Host without update checks shows nothing and raises no error', async () => {
    const { actions, store } = setup()
    await act(() => actions.refreshUpdate())
    expect(store.getSnapshot().update.status).toBeNull()
    expect(store.getSnapshot().toasts).toEqual([])
  })

  it('settings switch auto-check and the update source', async () => {
    const { actions, useFlow, calls } = updateSetup(updateStatus({ notice: false }))
    render(<SettingsSection t={t} useFlow={useFlow} actions={actions} />)
    const toggle = await screen.findByRole('switch', { name: 'Check for updates automatically' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => fireEvent.click(toggle))
    expect(calls.find(c => c.method === 'PUT' && c.path === '/settings' && 'updateAutoCheck' in (c.body as object))?.body).toEqual({ updateAutoCheck: false })
    await act(async () => fireEvent.change(screen.getByLabelText('Update source'), { target: { value: 'mirror' } }))
    expect(calls.find(c => c.method === 'PUT' && c.path === '/settings' && 'updateSource' in (c.body as object))?.body).toEqual({ updateSource: 'mirror' })
    expect(within(screen.getByLabelText('Update source')).getAllByRole('option').map(o => o.textContent)).toEqual(['Auto (fastest)', 'GitHub (official)', 'Mirror (jsDelivr)'])
  })
})
