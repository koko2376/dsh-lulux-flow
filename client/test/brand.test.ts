import { describe, expect, it } from 'vitest'
import { BRAND as HOST } from '../../src/brand.ts'
import { API_ROOT, BRAND, NS, chatRouteOf, headerLabel, kernelOfRoute } from '../src/brand.ts'
import { createTranslate } from '../src/i18n/translate.ts'

describe('brand', () => {
  it('derives every client name from the Host brand', () => {
    expect(BRAND.displayName).toBe(HOST.displayName)
    expect(API_ROOT).toBe(`/${HOST.id}/api`)
    expect(chatRouteOf('claude-code')).toBe(`${HOST.providerPrefix}-claude-code`)
    expect(kernelOfRoute(`${HOST.providerPrefix}-codex`)).toBe('codex')
    expect(kernelOfRoute('deepseek')).toBeUndefined()
    expect(NS).toMatch(/^[a-z][A-Za-z0-9]*$/)
    expect(headerLabel('x-lulux-flow-signature')).toBe('X-Lulux-Flow-Signature')
  })

  it('shows the Host display names in both languages', () => {
    expect(createTranslate('en')('brand.name')).toBe(HOST.displayName)
    expect(createTranslate('zh')('brand.name')).toBe(HOST.displayNameZh)
  })
})
