import { describe, expect, it } from 'vitest'
import { BRAND } from '../src/brand.ts'
import { ApiError } from '../src/api/client.ts'
import { fakeApi, workflow } from './helpers.tsx'

describe('FlowApi', () => {
  it('sends the CSRF header and JSON only on mutating requests', async () => {
    const { api, calls } = fakeApi((method, path) => (path === '/workflows' && method === 'GET' ? { body: { workflows: [] } } : { body: { workflow: workflow(), issues: [] } }))
    await api.listWorkflows()
    await api.saveWorkflow(workflow())
    await api.deleteWebhook('wf1')
    expect(calls[0]!.headers[BRAND.headers.csrf]).toBeUndefined()
    expect(calls[1]).toMatchObject({ method: 'PUT', path: '/workflows/wf1' })
    expect(calls[1]!.headers[BRAND.headers.csrf]).toBe('1')
    expect(calls[1]!.headers['content-type']).toBe('application/json')
    expect(calls[2]!.method).toBe('DELETE')
    expect(calls[2]!.headers[BRAND.headers.csrf]).toBe('1')
  })

  it('raises ApiError with the Host message', async () => {
    const { api } = fakeApi(() => ({ status: 409, body: { error: 'workflow has active runs; cancel them first' } }))
    await expect(api.deleteWorkflow('wf1')).rejects.toEqual(new ApiError(409, 'workflow has active runs; cancel them first'))
  })

  it('carries the Host error code and posts the approval digest', async () => {
    const { api, calls } = fakeApi(method => (method === 'POST' ? { status: 409, body: { error: 'changed', code: 'stale_review' } } : undefined))
    const error = await api.approveWorkflow('wf 1', 'sha256-x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('stale_review')
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/workflows/wf%201/approve', body: { digest: 'sha256-x' } })
  })

  it('encodes ids and query strings', async () => {
    const { api, calls } = fakeApi(() => ({ body: { runs: [] } }))
    await api.listRuns('a b', 5)
    expect(calls[0]!.path).toBe('/runs?workflowId=a+b&limit=5')
  })

  it('parses SSE frames and reconnects with backoff', async () => {
    const listeners: Record<string, (e: MessageEvent) => void> = {}
    let opened = 0
    const source = { addEventListener: (type: string, fn: (e: MessageEvent) => void) => void (listeners[type] = fn), close() {}, onerror: null as null | ((e: Event) => void) }
    const { FlowApi } = await import('../src/api/client.ts')
    const api = new FlowApi('/x', {
      eventSource: () => {
        opened += 1
        return source
      },
    })
    const events: unknown[] = []
    const status: boolean[] = []
    const stop = api.subscribe(e => events.push(e), s => status.push(s))
    listeners.hello!({ data: '{}' } as MessageEvent)
    listeners.node!({ data: JSON.stringify({ type: 'node', runId: 'r', nodeId: 'n', evidence: {} }) } as MessageEvent)
    listeners.trace!({ data: 'not json' } as MessageEvent)
    expect(events).toEqual([{ type: 'node', runId: 'r', nodeId: 'n', evidence: {} }])
    expect(status).toEqual([true])
    source.onerror?.(new Event('error'))
    expect(status).toEqual([true, false])
    stop()
    expect(opened).toBe(1)
  })
})
