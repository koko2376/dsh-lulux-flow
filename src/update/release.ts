/**
 * Release links and release-note summaries for update notices.
 *
 * Dependency-free on purpose: the client imports this module too, so the
 * browser applies the same link allowlist before it renders a link.
 */
import { cleanVersion } from './semver.js'

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const TAG = /^[A-Za-z0-9._+-]{1,128}$/

/** The repository's Releases page. */
export function releasesPage(repository: string): string {
  if (!REPO.test(repository)) throw new Error(`invalid repository: ${repository}`)
  return `https://github.com/${repository}/releases`
}

/** Release page for a version, built locally (never taken from a mirror). */
export function releaseUrlFor(version: string, repository: string): string {
  const clean = cleanVersion(version)
  if (clean === undefined) return releasesPage(repository)
  return `${releasesPage(repository)}/tag/v${clean}`
}

/**
 * True only for `https://github.com/<repository>/releases` and
 * `https://github.com/<repository>/releases/tag/<tag>`: no other host, no
 * port, credentials, query or fragment. Everything shown as a link passes
 * through here.
 */
export function isAllowedReleaseUrl(value: unknown, repository: string): value is string {
  if (typeof value !== 'string' || value.length > 512 || !REPO.test(repository)) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false
  const base = `/${repository}/releases`.toLowerCase()
  const path = url.pathname.replace(/\/+$/, '')
  if (path.toLowerCase() === base) return true
  if (!path.toLowerCase().startsWith(`${base}/tag/`)) return false
  let tag: string
  try {
    tag = decodeURIComponent(path.slice(base.length + 5))
  } catch {
    return false
  }
  return TAG.test(tag)
}

/** The url when it is allowed, otherwise the repository's Releases page. */
export function safeReleaseUrl(value: unknown, repository: string): string {
  return isAllowedReleaseUrl(value, repository) ? value : releasesPage(repository)
}

const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/
const HEADING = /^\s{0,3}#{1,6}\s/
const RULE = /^\s{0,3}([-*_=])(\s*\1){2,}\s*$/

function cleanInline(text: string): string {
  // Inline code keeps its text verbatim (it may contain `<tag>`-looking words); everything else loses markup.
  return text
    .split(/(`[^`]*`)/)
    .map(part =>
      part.startsWith('`') && part.endsWith('`') && part.length >= 2
        ? part.slice(1, -1)
        : part
            .replace(HTML_TAG, '')
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
            .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
            .replace(/https?:\/\/\S+/g, '') // bare urls
            .replace(/(\*\*|__|~~|\*|`)/g, ''),
    )
    .join('')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Plain-text summary of a release body (GitHub-flavoured Markdown, possibly
 * with HTML): the first paragraphs and list items as at most `maxLines`
 * short lines, headings dropped, no markup, no links, no control
 * characters. The client renders the lines as text nodes.
 */
export function summarizeNotes(body: unknown, maxLines = 5, maxChars = 600): string[] {
  if (typeof body !== 'string' || body.trim() === '') return []
  const text = body
    .slice(0, 20_000)
    .replace(/\r\n?/g, '\n')
    .replace(/(^|\n)\s*(```|~~~)[\s\S]*?(\n\s*\2|$)/g, '\n\n') // fenced code blocks
    .replace(/<!--[\s\S]*?(-->|$)/g, '') // HTML comments
    .replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h[1-6]|ul|ol)\s*>/gi, '\n\n')
  const blocks: string[] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join(' '))
    current = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s{0,3}>+\s?/, '') // quotes
    if (line.trim() === '' || RULE.test(line)) {
      flush()
      continue
    }
    if (HEADING.test(line) || /^\s*\[[^\]]+\]:\s*\S+/.test(line)) {
      flush() // headings and link reference definitions are structure, not content
      continue
    }
    if (LIST_ITEM.test(line)) {
      flush()
      current.push(line.replace(LIST_ITEM, ''))
      continue
    }
    current.push(line)
  }
  flush()
  const lines: string[] = []
  let total = 0
  for (const block of blocks) {
    let line = cleanInline(block)
    if (line === '') continue
    if (line.length > 160) line = `${line.slice(0, 157).trimEnd()}…`
    if (total + line.length > maxChars) break
    lines.push(line)
    total += line.length
    if (lines.length >= maxLines) break
  }
  return lines
}
