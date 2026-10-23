#!/usr/bin/env node
// Test double for the Claude Code CLI in headless stream-json mode.
// It talks to the LULUX Flow gateway exactly like the real CLI would
// (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN) and prints stream-json lines.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.argv.includes('--version')) {
  console.log('2.1.0 (Claude Code)')
  process.exit(0)
}

const prompt = readFileSync(0, 'utf8')
const base = process.env.ANTHROPIC_BASE_URL
const token = process.env.ANTHROPIC_AUTH_TOKEN
const out = obj => process.stdout.write(`${JSON.stringify(obj)}\n`)
const args = process.argv.slice(2)
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : undefined
const mcpIndex = args.indexOf('--mcp-config')
const systemFile = args.includes('--append-system-prompt-file') ? args[args.indexOf('--append-system-prompt-file') + 1] : undefined
const appendedSystem = systemFile !== undefined ? readFileSync(systemFile, 'utf8') : undefined

const sessionId = resume ?? 'native-session-1'
// Like the real CLI, transcripts live under the config dir, per working directory,
// and `--resume` of an id with no transcript there fails before any model call.
const configDir = process.env.CLAUDE_CONFIG_DIR
const transcript = configDir ? join(configDir, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`) : undefined
if (resume !== undefined && transcript !== undefined && !existsSync(transcript)) {
  const message = `No conversation found with session ID: ${resume}`
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [message], session_id: resume })
  process.exit(1)
}
const history = transcript !== undefined && existsSync(transcript) ? readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const record = message => {
  if (transcript === undefined) return
  mkdirSync(join(transcript, '..'), { recursive: true })
  appendFileSync(transcript, `${JSON.stringify(message)}\n`)
}

out({ type: 'system', subtype: 'init', session_id: sessionId })

if (prompt.includes('SLEEP')) await new Promise(r => setTimeout(r, 30_000))
const pause = /PAUSE(\d+)/.exec(prompt)
if (pause) await new Promise(r => setTimeout(r, Number(pause[1])))
if (prompt.includes('CRASH')) {
  process.stderr.write('fatal: something broke\n')
  process.exit(3)
}

// Report environment facts the tests assert on (never secrets themselves).
const leaked = Object.keys(process.env).filter(k => /SECRET|OPENAI_API_KEY|DEEPSEEK/.test(k))
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'EnvCheck', input: { description: `leaked=${leaked.join(',') || 'none'} configDir=${existsSync(process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent')} mcp=${mcpIndex >= 0}` } }] } })

if (prompt.includes('APPROVAL') && mcpIndex >= 0) {
  const config = JSON.parse(readFileSync(args[mcpIndex + 1], 'utf8'))
  const server = config.mcpServers.lulux_flow
  const call = async body => (await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const res = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'rm -rf build' } } } })
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `approval:${res.result.content[0].text}` }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'native-session-1' })
  process.exit(0)
}

const response = await fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL, max_tokens: 256, stream: true, ...(appendedSystem !== undefined ? { system: appendedSystem } : {}), messages: [...history, { role: 'user', content: prompt }] }),
})
if (!response.ok) {
  out({ type: 'result', subtype: 'error', is_error: true, result: `gateway ${response.status}: ${await response.text()}` })
  process.exit(1)
}
const body = await response.text()
let text = ''
let thinking = ''
for (const block of body.split('\n\n')) {
  const data = /^data: (.+)$/m.exec(block)?.[1]
  if (!data) continue
  const event = JSON.parse(data)
  out({ type: 'stream_event', event })
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') text += event.delta.text
  if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') thinking += event.delta.thinking
}
const content = [...(thinking ? [{ type: 'thinking', thinking, signature: '' }] : []), ...(text ? [{ type: 'text', text }] : [])]
out({ type: 'assistant', message: { content } })
record({ role: 'user', content: prompt })
record({ role: 'assistant', content })
out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 } })
