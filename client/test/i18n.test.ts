import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '../src/i18n/en.ts'
import { createTranslate, format } from '../src/i18n/translate.ts'
import { zh } from '../src/i18n/zh.ts'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('i18n', () => {
  it('zh-CN and en cover the same keys with non-empty text', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) expect(value.trim(), key).not.toBe('')
  })

  it('keeps the same placeholders in both languages', () => {
    const names = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort()
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) expect(names(en[key]), key).toEqual(names(zh[key]))
  })

  it('every literal key the UI asks for exists', () => {
    const missing: string[] = []
    const keys = new Set(Object.keys(zh))
    for (const file of sources(join(import.meta.dirname, '../src'))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) if (!keys.has(m[1]!)) missing.push(`${file}: ${m[1]}`)
      for (const m of text.matchAll(/'((?:toast|issue|run\.decision)\.[a-zA-Z.]+)'/g)) if (!keys.has(m[1]!)) missing.push(`${file}: ${m[1]}`)
    }
    expect(missing).toEqual([])
  })

  it('covers every dynamic key family', () => {
    const families: Record<string, readonly string[]> = {
      'node.type': ['input', 'output', 'agent', 'kernel', 'script', 'http', 'condition', 'loop', 'approval', 'notify'],
      'node.desc': ['input', 'output', 'agent', 'kernel', 'script', 'http', 'condition', 'loop', 'approval', 'notify'],
      status: ['pending', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled', 'interrupted'],
      route: ['success', 'failure', 'true', 'false'],
      'route.short': ['success', 'failure', 'true', 'false'],
      permission: ['read-only', 'ask', 'edit', 'full'],
      trigger: ['canvas', 'chat', 'cron', 'webhook', 'api', 'rerun'],
      install: ['idle', 'probing', 'installing', 'installed'],
      evidence: ['output', 'input', 'trace', 'artifacts', 'attempts'],
      source: ['settings', 'managed', 'path'],
      notify: ['json', 'slack', 'feishu', 'dingtalk', 'wecom', 'discord'],
      inputType: ['string', 'number', 'boolean', 'json'],
      'runs.filter': ['all', 'active', 'failed'],
      'inspector.loop': ['items', 'count', 'until'],
      mode: ['scoped', 'global'],
    }
    for (const [prefix, values] of Object.entries(families)) for (const v of values) expect(zh, `${prefix}.${v}`).toHaveProperty([`${prefix}.${v}`])
  })

  it('interpolates named placeholders', () => {
    expect(format('{a} of {b} {c}', { a: 1, b: 'two' })).toBe('1 of two {c}')
    expect(createTranslate('zh')('workflows.nodes', { count: 3 })).toBe('3 个节点')
    expect(createTranslate('en')('run.progress', { done: 2, total: 5 })).toBe('2/5 nodes done')
  })
})
