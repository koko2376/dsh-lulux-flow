/**
 * Test harness: binds a store to `use<Name>` hooks the way DSH's renderer
 * binds the registration `hooks` compartment, plus a fake plugin API.
 */
import { useSyncExternalStore } from 'react'
import { FlowApi, type ApiTransport } from '../src/api/client.ts'
import { API_ROOT } from '../src/brand.ts'
import type { KernelInfo, Workflow, WorkflowRun } from '../src/api/types.ts'
import { createTranslate } from '../src/i18n/translate.ts'
import type { Observable, SelectorHook } from '../src/store/store.ts'

export const t = createTranslate('en')
export const tz = createTranslate('zh')

export function bind<T>(source: Observable<T>): SelectorHook<T> {
  return selector => useSyncExternalStore(source.subscribe, () => selector(source.getSnapshot()))
}

export type Route = (method: string, path: string, body: unknown) => { status?: number; body: unknown } | undefined

export function fakeApi(route: Route): { api: FlowApi; calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> } {
  const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = []
  const transport: Partial<ApiTransport> = {
    fetch: async (input, init) => {
      const method = init?.method ?? 'GET'
      const path = input.replace(API_ROOT, '')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, path, body, headers: (init?.headers ?? {}) as Record<string, string> })
      const answer = route(method, path, body) ?? { status: 404, body: { error: 'not found' } }
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
    },
    eventSource: () => ({ addEventListener() {}, close() {}, onerror: null }),
  }
  return { api: new FlowApi(API_ROOT, transport), calls }
}

export const now = '2026-10-22T08:00:00.000Z'

export function workflow(partial: Partial<Workflow> = {}): Workflow {
  return {
    schemaVersion: 1,
    id: 'wf1',
    name: 'Triage',
    nodes: [
      { id: 'input', type: 'input', name: 'Input', position: { x: 0, y: 0 }, config: {} },
      { id: 'review', type: 'kernel', name: 'Review', position: { x: 260, y: 0 }, config: { kernel: 'claude-code', prompt: 'Review {{ inputs.topic }}' } },
      { id: 'gate', type: 'approval', name: 'Gate', position: { x: 520, y: 0 }, config: { message: 'Ship it?' } },
      { id: 'output', type: 'output', name: 'Output', position: { x: 780, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'review', route: 'success' },
      { id: 'e2', source: 'review', target: 'gate', route: 'success' },
      { id: 'e3', source: 'gate', target: 'output', route: 'success' },
    ],
    inputs: [{ name: 'topic', type: 'string', required: true }],
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

export function run(partial: Partial<WorkflowRun> = {}): WorkflowRun {
  const wf = workflow()
  return {
    schemaVersion: 1,
    id: 'run-12345678',
    workflowId: wf.id,
    workflowName: wf.name,
    status: 'waiting',
    trigger: { kind: 'canvas' },
    inputs: { topic: 'x' },
    snapshot: wf,
    nodes: {
      input: { status: 'succeeded', route: 'success', attempts: [], trace: [], artifacts: [], output: { topic: 'x' }, startedAt: now, endedAt: now },
      review: { status: 'succeeded', route: 'success', attempts: [{ attempt: 1, startedAt: now, endedAt: now, status: 'succeeded' }], trace: ['tool Read src/a.ts'], artifacts: [], output: { verdict: 'ok' }, startedAt: now, endedAt: now },
      gate: { status: 'waiting', attempts: [], trace: [], artifacts: [], input: 'Ship it?', startedAt: now },
    },
    createdAt: now,
    startedAt: now,
    resumes: 0,
    usage: { inputTokens: 1200, outputTokens: 300, nodeRuns: 3 },
    ...partial,
  }
}

export function kernel(partial: Partial<KernelInfo> = {}): KernelInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    npmPackage: '@anthropic-ai/claude-code',
    avatar: 'claude-code.png',
    color: '#d97757',
    minVersion: '>=2.0.0',
    supportsResume: true,
    supportsApprovalBridge: true,
    permissions: ['read-only', 'ask', 'edit', 'full'],
    installed: true,
    source: 'managed',
    version: '2.1.4',
    versionOk: true,
    nativeLogin: false,
    settings: { enabled: true, mode: 'scoped', permission: 'ask', binaryPath: '' },
    install: { kernelId: 'claude-code', status: 'idle', log: [] },
    provider: 'lulux-flow-claude-code',
    chatRoute: 'lulux-flow-claude-code',
    ...partial,
  }
}
