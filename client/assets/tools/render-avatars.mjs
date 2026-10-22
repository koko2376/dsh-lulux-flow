/**
 * Render the generated avatar SVGs to 256px PNGs (and a contact sheet) with
 * headless Chromium. Needs playwright-core: set PLAYWRIGHT_CORE to its path
 * if it is not resolvable from here, and CHROME_PATH to a Chromium binary when
 * the installed browser revision does not match.
 *   node client/assets/tools/render-avatars.mjs [sheet.png]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const dir = resolve(import.meta.dirname, '../avatars')
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const generated = ['gemini-cli', 'qwen-code', 'dsh-agent', 'lulux-flow']
const all = ['grok', 'claude-code', 'codex', ...generated]

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 })
for (const name of generated) {
  const svg = readFileSync(join(dir, `${name}.svg`), 'utf8')
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`)
  writeFileSync(join(dir, `${name}.png`), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 256, height: 256 } }))
}
const sheet = process.argv[2]
if (sheet) {
  const imgs = all.map(n => `<img src="data:image/png;base64,${readFileSync(join(dir, `${n}.png`)).toString('base64')}" width="256" height="256">`).join('')
  await page.setViewportSize({ width: 256 * all.length, height: 512 })
  await page.setContent(`<html><body style="margin:0;display:flex;flex-wrap:wrap;width:${256 * all.length}px"><div style="display:flex;background:#f4f4f6">${imgs}</div><div style="display:flex;background:#1b1d22">${imgs}</div></body></html>`)
  writeFileSync(sheet, await page.screenshot())
}
await browser.close()
