/**
 * Screenshot the client inside a real `dsh web` with the plugin linked,
 * serving the plugin API from deterministic fixtures.
 *
 *   DSH_WEB_URL='http://127.0.0.1:13090/?token=…' \
 *   PLAYWRIGHT_CORE=/path/to/playwright-core CHROME_PATH=/path/to/chrome \
 *   node client/preview/shoot.mjs [outDir] [--only=name,name]
 *
 * The session-kernel shot needs a real chat: a workspace named `parser-kit`
 * and a DSH default model on the lulux-flow-claude-code route (the CLI talks to
 * whatever upstream the profile configures).
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import * as fx from './fixtures.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const out = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'docs/images')
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7)
const url = process.env.DSH_WEB_URL
if (!url) throw new Error('set DSH_WEB_URL to the dsh web launch URL (with ?token=)')
mkdirSync(out, { recursive: true })

function api(lang) {
  const wfs = fx.workflows(lang)
  const runs = fx.runs(lang)
  return (method, path, body) => {
    if (path === '/meta') return fx.meta
    if (path === '/workflows' && method === 'GET') return { workflows: wfs.map(w => ({ id: w.id, name: w.name, description: w.description ?? '', nodes: w.nodes.length, updatedAt: w.updatedAt, lastRun: runs.find(r => r.workflowId === w.id) ?? null })) }
    let m = /^\/workflows\/([\w-]+)$/.exec(path)
    if (m && method === 'GET') {
      const wf = wfs.find(w => w.id === m[1])
      const issues = wf.id === 'daily_digest' ? [{ level: 'error', message: 'http node needs a url', nodeId: 'fetch' }, { level: 'error', message: 'agent node needs a prompt', nodeId: 'agent' }] : []
      return { workflow: wf, issues, webhook: { configured: wf.id === 'pr_fix', fingerprint: wf.id === 'pr_fix' ? '9c1e·44fa' : null, path: `/dsh-lulux-flow/hooks/${wf.id}` } }
    }
    if ((m = /^\/workflows\/([\w-]+)\/lint$/.exec(path))) return { issues: m[1] === 'daily_digest' ? [{ level: 'error', message: 'http node needs a url', nodeId: 'fetch' }] : [] }
    if (path.startsWith('/runs?')) {
      const id = new URLSearchParams(path.split('?')[1]).get('workflowId')
      return { runs: id ? runs.filter(r => r.workflowId === id) : runs }
    }
    if ((m = /^\/runs\/([\w-]+)$/.exec(path))) return { run: runs.find(r => r.id === m[1]) }
    if (path.startsWith('/kernels')) return { kernels: fx.kernels() }
    if (path.startsWith('/registries')) return { registries: fx.registries }
    if (path === '/settings') {
      // The plugin language is a plugin setting (default zh-CN); shots use the language being captured.
      const base = { ...fx.settings, language: lang === 'zh' ? 'zh-CN' : 'en' }
      return { settings: method === 'PUT' ? { ...base, ...body } : base }
    }
    if (path === '/cron/preview') return { next: ['2026-10-23T01:00:00Z', '2026-10-26T01:00:00Z', '2026-10-27T01:00:00Z'] }
    if (/\/webhook$/.test(path) && method === 'POST') return { secret: 'whsec_fake_preview_only', path: '/dsh-lulux-flow/hooks/pr_fix', note: '' }
    return { ok: true }
  }
}

/** Keep the plugin's event stream open (and silent) instead of letting it reconnect. */
const fakeEventSource = () => {
  const Real = window.EventSource
  window.EventSource = class extends EventTarget {
    constructor(u, o) {
      if (!/\/api\/events$/.test(String(u))) return new Real(u, o)
      super()
      this.onerror = null
      setTimeout(() => this.dispatchEvent(Object.assign(new Event('hello'), { data: '{}' })), 50)
    }
    close() {}
  }
}

/** Per-shot viewports. The session shot is wider so the kernel popover sits beside the chat column instead of over it. */
const VIEWPORTS = {
  default: { width: 1680, height: 1050, scale: 1.5 },
  'session-kernel': { width: 2080, height: 1040, scale: 1.25 },
  canvas: { width: 2080, height: 1040, scale: 1.25 },
  'run-inspector': { width: 2080, height: 1040, scale: 1.25 },
}

async function session(browser, { lang, theme, shot }) {
  const vp = VIEWPORTS[shot] ?? VIEWPORTS.default
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.scale, locale: lang === 'zh' ? 'zh-CN' : 'en-US', colorScheme: theme })
  await ctx.addInitScript(fakeEventSource)
  await ctx.addInitScript(l => localStorage.setItem('dsh-lulux-flow.language', l), lang === 'zh' ? 'zh-CN' : 'en')
  const handler = api(lang)
  await ctx.route(/\/dsh-lulux-flow\/api\//, async route => {
    const req = route.request()
    const path = new URL(req.url()).pathname.replace(/^\/[^/]+\/api/, '') + (new URL(req.url()).search || '')
    const body = req.postData() ? JSON.parse(req.postData()) : undefined
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(handler(req.method(), path, body)) })
  })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  pageerror', e.message))
  await page.goto(url)
  await page.waitForTimeout(3500)
  // Dismiss the preview notice if present.
  const notice = page.getByRole('dialog').getByRole('button').last()
  if (await notice.count()) await notice.click({ timeout: 3000 }).catch(() => undefined)
  await page.waitForTimeout(300)
  return { ctx, page }
}

const CHAT_PROMPT = 'Why are the parser tests failing?'
const CHAT_TITLE = 'Failing parser tests'

const brand = lang => (lang === 'zh' ? 'DSH工作流（LULUX Flow）' : 'DSH-LULUX Flow')
const T = (lang, zh, en) => (lang === 'zh' ? zh : en)

/** Leave DSH's unsaved "New Session" draft (the landing view), so it is not listed in the sidebar. */
async function leaveDraft(page) {
  const chat = page.getByText(CHAT_TITLE, { exact: true }).first()
  if (await chat.count()) {
    await chat.click()
    await page.waitForTimeout(600)
  }
}

async function openPage(page, lang) {
  await leaveDraft(page)
  await page.getByRole('button', { name: brand(lang) }).first().click()
  await page.waitForSelector('.lxf-page')
  await page.waitForTimeout(600)
}

/** Product shots of the plugin page: give the canvas the room (DSH sidebar + workflow list collapsed). */
async function focusCanvas(page, lang) {
  await page.getByRole('button', { name: T(lang, '收起侧边栏', 'Collapse sidebar') }).first().click().catch(() => undefined)
  await page.waitForTimeout(300)
  const hide = page.getByRole('button', { name: T(lang, '隐藏工作流列表', 'Hide workflow list') })
  if (await hide.count()) await hide.click()
  await page.waitForTimeout(500)
}

/** Remove empty "Untitled" / "New Session" sessions left by earlier runs so the sidebar looks lived-in, not littered. */
async function tidySessions(page) {
  let archived = 0
  for (let i = 0; i < 6; i += 1) {
    const clicked = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button')]
      const at = all.findIndex(b => ['Session actions for Untitled', 'Session actions for New Session'].includes(b.getAttribute('aria-label') ?? ''))
      if (at < 0) return false
      const archive = all.slice(at).find(b => b.getAttribute('aria-label') === 'Archive session')
      archive?.click()
      return archive !== undefined
    })
    if (!clicked) break
    archived += 1
    await page.waitForTimeout(500)
    const confirm = page.getByRole('dialog').getByRole('button', { name: /Archive|Confirm/ }).last()
    if (await confirm.count()) await confirm.click().catch(() => undefined)
    await page.waitForTimeout(400)
  }
  if (archived > 0) await page.waitForTimeout(6000) // let the "Session archived" toast go
}

async function openWorkflow(page, name) {
  await page.locator('.lxf-wflist__open', { hasText: name }).click()
  await page.waitForSelector('.react-flow__node')
  await page.waitForTimeout(900)
}


const SHOTS = {
  /** A real chat turn answered by the lulux-flow-claude-code route (real CLI, mock upstream), switcher open. */
  async 'session-kernel'(page) {
    await tidySessions(page)
    const existing = page.getByText(CHAT_TITLE, { exact: true }).first()
    if (await existing.count()) {
      await existing.click()
    } else {
      await page.getByText('parser-kit', { exact: true }).first().click()
      await page.waitForTimeout(1200)
      const box = page.locator('[contenteditable=true], textarea').first()
      await box.click()
      await box.fill(CHAT_PROMPT)
      await page.keyboard.press('Enter')
    }
    await page.getByText('Want me to apply', { exact: false }).first().waitFor({ timeout: 90000 })
    await page.waitForSelector('.lxf-switcher', { timeout: 20000 })
    // Unfold the turn's process so the CLI's tool step is visible.
    await page.getByText(/^Completed in/).first().click().catch(() => undefined)
    await page.waitForTimeout(500)
    await page.getByText(/^Analysis completed/).first().click().catch(() => undefined)
    await page.waitForTimeout(1500)
    await page.locator('.lxf-switcher').click()
    await page.waitForTimeout(900)
  },
  async canvas(page, lang) {
    await tidySessions(page)
    await openPage(page, lang)
    await openWorkflow(page, T(lang, '计划 → 实现 → 上线', 'Plan → implement → ship'))
    await focusCanvas(page, lang)
    await page.locator('.react-flow__node', { hasText: T(lang, 'Codex 实现', 'Codex · implement') }).click()
    await page.waitForTimeout(400)
    await page.locator('.react-flow__controls-fitview').click()
    await page.waitForTimeout(600)
  },
  async 'run-inspector'(page, lang) {
    await openPage(page, lang)
    await openWorkflow(page, T(lang, '计划 → 实现 → 上线', 'Plan → implement → ship'))
    await focusCanvas(page, lang)
    await page.getByRole('radio', { name: T(lang, '历史', 'History') }).click()
    await page.locator('.lxf-history__row').first().click()
    await page.waitForTimeout(700)
    await page.locator('.lxf-runnode', { hasText: T(lang, 'Codex 实现', 'Codex · implement') }).first().click()
    await page.locator('.react-flow__controls-fitview').click()
    await page.waitForTimeout(600)
  },
  async kernels(page, lang) {
    await tidySessions(page)
    await openPage(page, lang)
    await page.getByRole('radio', { name: T(lang, '内核', 'Kernels') }).click()
    await page.waitForTimeout(900)
  },
  async generate(page, lang) {
    await openPage(page, lang)
    await page.getByRole('button', { name: T(lang, 'AI 生成', 'Generate with AI') }).first().click()
    await page.locator('.lxf-dialog textarea').fill(T(lang, '每天早上读取 GitHub 新 issue，让 Claude Code 分类，需要时等我审批再发到飞书', 'Every morning, read new GitHub issues, let Claude Code triage them, wait for my approval when needed, then post a summary to Slack'))
    await page.waitForTimeout(400)
  },
  async settings(page, lang) {
    await page.setViewportSize({ width: 1680, height: 1240 })
    await leaveDraft(page)
    await page.getByText(T(lang, '更多', 'More'), { exact: true }).click()
    await page.waitForTimeout(400)
    await page.getByText(T(lang, '设置', 'Settings'), { exact: true }).last().click()
    await page.waitForTimeout(800)
    await page.getByText('LULUX Flow', { exact: true }).last().click()
    await page.waitForTimeout(900)
    // The section is taller than DSH's settings dialog: scroll so the install trust toggle and the script nodes row are in view.
    await page.evaluate(() => {
      let el = document.querySelector('.lxf-settings')
      while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement
      if (el) el.scrollTop = el.scrollHeight
    })
    await page.waitForTimeout(400)
  },
}

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
const lang = process.env.SHOT_LANG ?? 'en'
for (const theme of (process.env.SHOT_THEMES ?? 'light,dark').split(',')) {
  for (const [name, run] of Object.entries(SHOTS)) {
    if (only && !only.split(',').includes(name)) continue
    const { ctx, page } = await session(browser, { lang, theme, shot: name })
    try {
      await run(page, lang)
      const file = `${out}/ui-${name}${theme === 'dark' ? '-dark' : ''}${lang === 'en' ? '' : `-${lang}`}.png`
      if (process.env.SHOT_DEBUG) console.log(await page.evaluate(new Function(process.env.SHOT_DEBUG)))
      await page.screenshot({ path: file })
      console.log('saved', file)
    } catch (error) {
      console.log(`  ${name}/${theme} failed: ${error.message.split('\n')[0]}`)
      await page.screenshot({ path: `${out}/_failed-${name}-${theme}.png` }).catch(() => undefined)
    }
    await ctx.close()
  }
}
await browser.close()
