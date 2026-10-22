import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ChatSessionMap, kernelChatStream, workspaceRelative, type KernelChatDeps } from '../../src/dsh/kernel-chat.js'
import { findKernel } from '../../src/kernels/catalog.js'
import type { KernelService } from '../../src/kernels/service.js'
import { defaultKernelSettings } from '../../src/settings.js'
import { tempDir, TARGET } from '../helpers.js'

type RunImpl = (req: { onEvent?: (e: unknown) => void; prompt: string; resumeSessionId?: string }) => Promise<unknown>

function deps(run: RunImpl): KernelChatDeps {
  const kernels = { settingsOf: (id: string) => defaultKernelSettings(id), run } as unknown as KernelService
  return {
    kernels,
    sessions: new ChatSessionMap(tempDir()),
    target: () => TARGET,
    cwdFor: () => process.cwd(),
    timeoutMs: 10_000,
    auxiliary: () => (async function* () {})(),
  }
}

const options = (text: string, sessionId = 'sess-1'): GenerateOptions =>
  ({ provider: 'lulux-flow-claude-code', model: 'default', sessionId, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }) as unknown as GenerateOptions

async function drain(stream: AsyncIterable<StreamChunk>, ms = 3000): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream hung')), ms))
  await Promise.race([
    (async () => {
      for await (const c of stream) out.push(c)
    })(),
    timeout,
  ])
  return out
}

const completed = (text: string) => ({ status: 'completed', text, usage: { inputTokens: 3, outputTokens: 2, requests: 1 }, nativeSessionId: 'native-1' })

describe('kernelChatStream', () => {
  const kernel = findKernel('claude-code')!

  it('finishes when the run settles without emitting any event (regression: consumer parked forever)', async () => {
    const chunks = await drain(kernelChatStream(kernel, options('hi'), deps(async () => completed('final answer'))))
    const text = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join('')
    expect(text).toBe('final answer')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('streams CLI text and tool activity as text and reasoning blocks', async () => {
    const chunks = await drain(
      kernelChatStream(
        kernel,
        options('hi'),
        deps(async req => {
          req.onEvent?.({ type: 'tool', name: 'Bash', detail: 'ls' })
          await new Promise(r => setTimeout(r, 5))
          req.onEvent?.({ type: 'text', text: 'done', final: true })
          return completed('done')
        }),
      ),
    )
    const kinds = chunks.map(c => c.type)
    expect(kinds).toContain('reasoning-delta')
    expect(chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join('')).toBe('done')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('shows tool-step paths relative to the session workspace', async () => {
    const cwd = process.cwd()
    const chunks = await drain(
      kernelChatStream(
        kernel,
        options('hi'),
        deps(async req => {
          req.onEvent?.({ type: 'tool', name: 'Read', detail: `${cwd}/src/parser.ts` })
          return completed('done')
        }),
      ),
    )
    const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => (c as { text: string }).text).join('')
    expect(reasoning).toBe('▸ Read · src/parser.ts\n')
    expect(reasoning).not.toContain(cwd)
  })

  it('turns a rejected run into an error finish instead of throwing or hanging', async () => {
    const chunks = await drain(kernelChatStream(kernel, options('hi'), deps(() => Promise.reject(new Error('spawn ENOENT')))))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { message: 'spawn ENOENT' } } })
  })

  it('resumes the native CLI session on the next turn', async () => {
    const seen: Array<string | undefined> = []
    const d = deps(async req => {
      seen.push(req.resumeSessionId)
      return completed('ok')
    })
    await drain(kernelChatStream(kernel, options('first'), d))
    const second = {
      ...options('second'),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ],
    } as unknown as GenerateOptions
    await drain(kernelChatStream(kernel, second, d))
    expect(seen).toEqual([undefined, 'native-1'])
  })
})

describe('workspaceRelative', () => {
  it('relativizes paths under the workspace and leaves everything else alone', () => {
    expect(workspaceRelative('/w/repo/src/a.ts', '/w/repo')).toBe('src/a.ts')
    expect(workspaceRelative('cd /w/repo/ && ls', '/w/repo/')).toBe('cd . && ls')
    expect(workspaceRelative('/w/repo', '/w/repo')).toBe('.')
    expect(workspaceRelative('grep -n x /w/repo/test "/w/repo/b c.ts"', '/w/repo')).toBe('grep -n x test "b c.ts"')
    expect(workspaceRelative('/w/repository/a.ts', '/w/repo')).toBe('/w/repository/a.ts')
    expect(workspaceRelative('/other/w/repo/a.ts', '/w/repo')).toBe('/other/w/repo/a.ts')
    expect(workspaceRelative('C:\\w\\repo\\a.ts', 'C:\\w\\repo')).toBe('a.ts')
    expect(workspaceRelative('ls', '')).toBe('ls')
  })
})

describe('kernelChatStream without a real upstream model', () => {
  it('reports GATEWAY_MODEL_UNSET as an error finish and never spawns the CLI', async () => {
    let spawned = 0
    const d = deps(async () => {
      spawned += 1
      return completed('x')
    })
    d.target = () => {
      throw new Error('no real model')
    }
    const chunks = await drain(kernelChatStream(findKernel('claude-code')!, options('hi'), d))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'GATEWAY_MODEL_UNSET' } } })
    expect(spawned).toBe(0)
  })
})
