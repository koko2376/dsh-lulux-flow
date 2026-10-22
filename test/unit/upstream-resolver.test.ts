import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DshLlmUpstream } from '../../src/dsh/llm-upstream.js'
import type { ModelSelection } from '../../src/dsh/host-types.js'
import { ModelMemory, parseModelRef, UpstreamLoopError, UpstreamResolver } from '../../src/dsh/upstream-resolver.js'
import { collect } from '../../src/gateway/canonical.js'
import { SettingsStore } from '../../src/settings.js'
import { tempDir } from '../helpers.js'

const KERNEL_ROUTES = new Set(['lulux-flow-claude-code', 'lulux-flow-codex'])

function setup(initial: ModelSelection | undefined, opts: { pinned?: string; profile?: string; providers?: string[] } = {}) {
  const dir = tempDir()
  let current = initial
  let pinned = opts.pinned ?? ''
  let profile = opts.profile ?? 'web'
  const memory = new ModelMemory(dir)
  const resolver = new UpstreamResolver({
    isKernelRoute: p => KERNEL_ROUTES.has(p),
    dshDefault: () => current,
    pinned: () => pinned,
    profile: () => profile,
    memory,
    ...(opts.providers !== undefined ? { providerExists: (p: string) => opts.providers!.includes(p) } : {}),
  })
  return {
    dir,
    resolver,
    memory,
    select: (s: ModelSelection | undefined) => (current = s),
    pin: (v: string) => (pinned = v),
    useProfile: (v: string) => (profile = v),
  }
}

describe('UpstreamResolver', () => {
  it('follows the DSH default model while it is a real model', () => {
    const t = setup({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
    expect(t.resolver.resolve()).toEqual({ target: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }, source: 'dsh-default' })
  })

  it('falls back to the last real model after the user picks a CLI route (DSH persists it as the default)', () => {
    const t = setup({ provider: 'deepseek', model: 'deepseek-chat' })
    t.resolver.observe()
    t.select({ provider: 'lulux-flow-claude-code', model: 'default' })
    expect(t.resolver.resolve()).toEqual({ target: { provider: 'deepseek', model: 'deepseek-chat' }, source: 'remembered' })
  })

  it('persists the memory per profile across restarts', () => {
    const t = setup({ provider: 'mockai', model: 'mock-1' }, { profile: 'web' })
    t.resolver.observe()
    const file = JSON.parse(readFileSync(join(t.dir, 'model-memory.json'), 'utf8')) as { profiles: Record<string, { provider: string }> }
    expect(file.profiles.web?.provider).toBe('mockai')
    const again = new ModelMemory(t.dir)
    expect(again.get('web')).toEqual({ provider: 'mockai', model: 'mock-1' })
    expect(again.get('tui')).toBeUndefined()
  })

  it('keeps profiles apart', () => {
    const t = setup({ provider: 'a', model: 'one' }, { profile: 'web' })
    t.resolver.observe()
    t.useProfile('tui')
    t.select({ provider: 'lulux-flow-codex', model: 'default' })
    expect(() => t.resolver.resolve()).toThrow(UpstreamLoopError)
    t.useProfile('web')
    expect(t.resolver.resolve().target).toEqual({ provider: 'a', model: 'one' })
  })

  it('never remembers or returns a CLI route (loop guard)', () => {
    const t = setup({ provider: 'lulux-flow-claude-code', model: 'default' })
    t.resolver.observe()
    expect(t.memory.get('web')).toBeUndefined()
    expect(() => t.resolver.resolve()).toThrow(/Gateway model/)
  })

  it('the pinned Gateway model wins over the DSH default', () => {
    const t = setup({ provider: 'deepseek', model: 'deepseek-chat' }, { pinned: 'openrouter/qwen/qwen3-coder' })
    expect(t.resolver.resolve()).toEqual({ target: { provider: 'openrouter', model: 'qwen/qwen3-coder' }, source: 'setting' })
  })

  it('ignores a pinned value that names a CLI route', () => {
    const t = setup({ provider: 'deepseek', model: 'deepseek-chat' }, { pinned: 'lulux-flow-codex/default' })
    expect(t.resolver.resolve().source).toBe('dsh-default')
  })

  it('an explicit node model wins, but an explicit CLI route falls through to a real model', () => {
    const t = setup({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(t.resolver.resolve('anthropic/claude-sonnet-4-5')).toEqual({ target: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, source: 'node' })
    expect(t.resolver.resolve('lulux-flow-claude-code/default')).toEqual({ target: { provider: 'deepseek', model: 'deepseek-chat' }, source: 'dsh-default' })
    expect(() => t.resolver.resolve('no-slash')).toThrow(/provider\/model/)
  })

  it('skips a remembered model whose provider was removed from DSH', () => {
    const t = setup({ provider: 'gone', model: 'm' }, { providers: ['deepseek'] })
    t.resolver.observe()
    t.select({ provider: 'lulux-flow-claude-code', model: 'default' })
    expect(() => t.resolver.resolve()).toThrow(UpstreamLoopError)
  })

  it('does not remember a default whose provider is not registered in DSH', () => {
    const t = setup({ provider: 'unknown-route', model: 'x' }, { providers: ['deepseek'] })
    t.resolver.observe()
    expect(t.memory.get('web')).toBeUndefined()
  })

  it('parses provider/model with slashes in the model id', () => {
    expect(parseModelRef('openrouter/meta/llama-3')).toEqual({ provider: 'openrouter', model: 'meta/llama-3' })
    expect(parseModelRef('/x')).toBeUndefined()
    expect(parseModelRef('x/')).toBeUndefined()
    expect(parseModelRef('a b/c')).toBeUndefined()
  })
})

describe('loop guard at the edges', () => {
  it('the settings store refuses a CLI route as the Gateway model', () => {
    const store = new SettingsStore(tempDir())
    expect(() => store.update({ gatewayModel: 'lulux-flow-claude-code/default' })).toThrow(/CLI route/)
    expect(store.update({ gatewayModel: 'deepseek/deepseek-chat' }).gatewayModel).toBe('deepseek/deepseek-chat')
    expect(store.update({ gatewayModel: '' }).gatewayModel).toBe('')
  })

  it('DshLlmUpstream refuses to stream to a CLI route and never calls ctx.llm', async () => {
    let called = 0
    const upstream = new DshLlmUpstream(
      () => ({
        stream: () => {
          called += 1
          return (async function* () {})()
        },
      }),
      p => KERNEL_ROUTES.has(p),
    )
    const result = await collect(upstream.stream({ model: '', turns: [{ role: 'user', text: 'hi' }], tools: [], stream: true }, { provider: 'lulux-flow-codex', model: 'default' }, new AbortController().signal))
    expect(result.finish).toBe('error')
    expect(result.error).toMatch(/loop guard/)
    expect(called).toBe(0)
  })
})
