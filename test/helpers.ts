import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanonicalEvent, CanonicalRequest, Upstream, UpstreamTarget } from '../src/gateway/canonical.js'

export function tempDir(prefix = 'lulux-flow-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Scripted upstream: records requests and replays canned events. */
export class FakeUpstream implements Upstream {
  readonly requests: Array<{ request: CanonicalRequest; target: UpstreamTarget }> = []
  constructor(public script: (request: CanonicalRequest) => CanonicalEvent[] | Promise<CanonicalEvent[]> = () => textReply('hello')) {}

  async *stream(request: CanonicalRequest, target: UpstreamTarget, signal: AbortSignal): AsyncIterable<CanonicalEvent> {
    this.requests.push({ request, target })
    const events = await this.script(request)
    for (const event of events) {
      if (signal.aborted) throw new Error('aborted')
      await new Promise(resolve => setTimeout(resolve, 1))
      yield event
    }
  }
}

export function textReply(text: string, usage = { inputTokens: 12, outputTokens: 3 }): CanonicalEvent[] {
  return [{ type: 'text', text: text.slice(0, 2) }, { type: 'text', text: text.slice(2) }, { type: 'usage', usage }, { type: 'finish', reason: 'stop' }]
}

export function toolReply(id: string, name: string, args: Record<string, unknown>): CanonicalEvent[] {
  const raw = JSON.stringify(args)
  return [
    { type: 'tool-call-start', id, name },
    { type: 'tool-call-delta', id, argumentsDelta: raw.slice(0, 5) },
    { type: 'tool-call-delta', id, argumentsDelta: raw.slice(5) },
    { type: 'tool-call-end', id, name, arguments: raw },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 7 } },
    { type: 'finish', reason: 'tool_use' },
  ]
}

export async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

export function parseSse(body: string): Array<{ event?: string; data: unknown }> {
  return body
    .split(/\r?\n\r?\n/)
    .map(block => block.trim())
    .filter(block => block && !block.startsWith(':'))
    .map(block => {
      const event = /^event: (.+)$/m.exec(block)?.[1]
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? ''
      return { ...(event !== undefined ? { event } : {}), data: data === '[DONE]' ? '[DONE]' : (JSON.parse(data) as unknown) }
    })
}

export const TARGET: UpstreamTarget = { provider: 'deepseek', model: 'deepseek-chat' }
