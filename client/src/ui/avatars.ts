/**
 * Kernel and brand avatars. claude-code, codex and grok are the author's own
 * artwork and ship unmodified, as does the LULUX mark (lulux-flow.png); the
 * others are this project's SVGs.
 */
import { BRAND } from '../brand.ts'
import claudeCode from '../../assets/avatars/claude-code.png'
import codex from '../../assets/avatars/codex.png'
import grok from '../../assets/avatars/grok.png'
import gemini from '../../assets/avatars/gemini-cli.svg'
import qwen from '../../assets/avatars/qwen-code.svg'
import brandMark from '../../assets/avatars/lulux-flow.png'
import dshAgent from '../../assets/avatars/dsh-agent.svg'

const BY_ID: Record<string, string> = {
  'claude-code': claudeCode,
  codex,
  grok,
  'gemini-cli': gemini,
  'qwen-code': qwen,
  'lulux-flow': brandMark,
  [BRAND.id]: brandMark,
  'dsh-agent': dshAgent,
}

/** Avatar URL for a kernel id or an avatar file name from the Host catalog. */
export function avatarFor(idOrFile: string | undefined): string {
  if (idOrFile === undefined) return brandMark
  const key = idOrFile.replace(/\.(png|svg)$/, '')
  return BY_ID[key] ?? brandMark
}

export const BRAND_AVATAR = brandMark
export const DSH_AGENT_AVATAR = dshAgent
