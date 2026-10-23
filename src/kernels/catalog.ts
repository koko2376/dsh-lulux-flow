/**
 * Built-in kernel adapters. Each adapter knows how to point one CLI at the
 * LULUX Flow gateway (scoped mode) or leave it on its native login (global mode),
 * and how to parse its machine-readable output.
 *
 * Package names, bins and headless flags were checked against each CLI's
 * published package and `--help` output; the per-CLI permission mapping is
 * documented in docs/kernels.md. To add a CLI, implement
 * {@link KernelDefinition} and call `registerKernel()`.
 */
import { realpathSync } from 'node:fs'
import { CLAUDE_PERMISSION_TOOL, MCP_SERVER_NAME } from '../gateway/mcp.js'
import { asArray, asRecord, asString } from '../gateway/canonical.js'
import type { KernelDefinition, KernelEvent, KernelLaunchContext, KernelParser } from './types.js'

export const GATEWAY_KEY_ENV = 'LULUX_FLOW_GATEWAY_KEY'
export const MCP_CONFIG_FILE = 'lulux-flow-mcp.json'

const toml = (value: string): string => JSON.stringify(value)

function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function describeInput(input: unknown): string {
  const record = asRecord(input)
  const key = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'].find(k => typeof record[k] === 'string')
  return key !== undefined ? truncate(String(record[key])) : truncate(JSON.stringify(input ?? {}))
}

// ── Claude Code ─────────────────────────────────────────────────────────────

/** The most specific reason a failed Claude Code `result` event carries. */
export function claudeResultError(event: Record<string, unknown>): string {
  const errors = asArray(event.errors).map(e => (typeof e === 'string' ? e : asString(asRecord(e).message))).filter(Boolean)
  const detail = asString(asRecord(event.error).message) || errors.join('; ') || asString(event.result)
  const subtype = asString(event.subtype)
  const reason =
    subtype === 'error_max_turns' ? 'reached its turn limit'
    : subtype === 'error_max_budget_usd' ? 'reached its budget limit'
    : subtype === 'error_during_execution' ? 'failed while running'
    : ''
  if (detail && reason) return `Claude Code ${reason}: ${detail}`
  if (detail) return detail
  return reason ? `Claude Code ${reason}` : `Claude Code reported an error${subtype && subtype !== 'success' ? ` (${subtype})` : ''}`
}

function claudeParser(): KernelParser {
  let partial = false
  return {
    line(event) {
      const type = asString(event.type)
      const out: KernelEvent[] = []
      if (type === 'system' && asString(event.subtype) === 'init' && asString(event.session_id)) {
        out.push({ type: 'session', id: asString(event.session_id) })
      } else if (type === 'stream_event') {
        const inner = asRecord(event.event)
        const delta = asRecord(inner.delta)
        if (inner.type === 'content_block_delta' && delta.type === 'text_delta' && asString(delta.text)) {
          partial = true
          out.push({ type: 'text', text: asString(delta.text) })
        } else if (inner.type === 'content_block_delta' && delta.type === 'thinking_delta' && asString(delta.thinking)) {
          out.push({ type: 'reasoning', text: asString(delta.thinking) })
        }
      } else if (type === 'assistant') {
        const message = asRecord(event.message)
        const blocks = asArray(message.content).map(asRecord)
        const text = blocks.filter(b => b.type === 'text').map(b => asString(b.text)).join('')
        for (const block of blocks) if (block.type === 'tool_use') out.push({ type: 'tool', name: asString(block.name), detail: describeInput(block.input) })
        if (event.error !== undefined) out.push({ type: 'error', message: `${String(event.error)}${text ? `: ${text}` : ''}`, fatal: true })
        else if (text && !partial) out.push({ type: 'text', text })
        partial = false
      } else if (type === 'result') {
        if (event.is_error === true) out.push({ type: 'error', message: claudeResultError(event), fatal: true })
        const usage = asRecord(event.usage)
        if (typeof usage.input_tokens === 'number') out.push({ type: 'usage', inputTokens: usage.input_tokens, outputTokens: Number(usage.output_tokens ?? 0) })
        if (asString(event.session_id)) out.push({ type: 'session', id: asString(event.session_id) })
        out.push({ type: 'done', text: asString(event.result) })
      }
      return out
    },
  }
}

export const CLAUDE_SETTINGS_FILE = 'lulux-flow-settings.json'
/** Extra system instructions for Claude Code, read through `--append-system-prompt-file` (no command-line length limits). */
export const CLAUDE_SYSTEM_PROMPT_FILE = 'lulux-flow-system-prompt.md'

/**
 * Claude Code permission-rule path for an absolute path: `//` marks an
 * absolute path; Windows drives become `//c/...`.
 */
function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function claudeAbsoluteRule(path: string): string {
  let p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const drive = /^([A-Za-z]):\//.exec(p)
  if (drive) p = `/${drive[1]!.toLowerCase()}${p.slice(2)}`
  if (!p.startsWith('/')) p = `/${p}`
  return `/${p}/**`
}

/**
 * Deny rules for Claude Code: DSH's home (credential store, profiles with
 * provider keys), the plugin data directory and /proc (other processes'
 * environments). Read rules also cover Grep and Glob. Bash is not covered by
 * path rules; it is disabled at read-only and asks (or is denied) at
 * edit, and unrestricted at full.
 */
export function claudeDenyRules(protectedPaths: readonly string[]): string[] {
  // Claude Code may see a path by its real location (on macOS /var is a link to
  // /private/var), so a protected path reached through a symlink is denied under both names.
  const withReal = protectedPaths.filter(Boolean).flatMap(path => [path, realPathOrSelf(path)])
  const paths = [...new Set([...withReal, ...(process.platform === 'win32' ? [] : ['/proc'])])]
  const rules: string[] = []
  for (const path of paths) {
    const rule = claudeAbsoluteRule(path)
    rules.push(`Read(${rule})`, `Edit(${rule})`)
  }
  rules.push('Read(~/.dsh/**)', 'Edit(~/.dsh/**)')
  return [...new Set(rules)]
}

function claudeLaunch(ctx: KernelLaunchContext): ReturnType<KernelDefinition['launch']> {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
  const files: Record<string, string> = {}
  files[CLAUDE_SETTINGS_FILE] = JSON.stringify({ permissions: { deny: claudeDenyRules(ctx.protectedPaths ?? []) } }, null, 2)
  args.push('--settings', `{home}/${CLAUDE_SETTINGS_FILE}`)
  const env: Record<string, string> = {}
  if (ctx.mode === 'scoped') {
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: ctx.home,
      ANTHROPIC_BASE_URL: `${ctx.gatewayUrl}/anthropic`,
      ANTHROPIC_AUTH_TOKEN: ctx.token,
      ANTHROPIC_MODEL: ctx.model,
      ANTHROPIC_SMALL_FAST_MODEL: ctx.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: ctx.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: ctx.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ctx.model,
      CLAUDE_CODE_SUBAGENT_MODEL: ctx.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_MAX_RETRIES: '2',
    })
    args.push('--model', ctx.model)
  }
  const modes = { 'read-only': 'default', ask: 'default', edit: 'acceptEdits', full: 'bypassPermissions' } as const
  args.push('--permission-mode', modes[ctx.permission])
  if (ctx.permission === 'read-only') args.push('--allowedTools', 'Read,Grep,Glob,LS', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch')
  if (ctx.approvalBridge && ctx.permission !== 'full' && ctx.token) {
    files[MCP_CONFIG_FILE] = JSON.stringify(
      { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: `${ctx.gatewayUrl}/mcp`, headers: { Authorization: `Bearer ${ctx.token}` } } } },
      null,
      2,
    )
    args.push('--mcp-config', `{home}/${MCP_CONFIG_FILE}`, '--permission-prompt-tool', CLAUDE_PERMISSION_TOOL)
  }
  if (ctx.appendSystemPrompt !== undefined) {
    files[CLAUDE_SYSTEM_PROMPT_FILE] = ctx.appendSystemPrompt
    args.push('--append-system-prompt-file', `{home}/${CLAUDE_SYSTEM_PROMPT_FILE}`)
  }
  if (ctx.resumeSessionId !== undefined) args.push('--resume', ctx.resumeSessionId)
  return { args, env, files, promptVia: 'stdin' }
}

// ── Codex ───────────────────────────────────────────────────────────────────

function codexParser(): KernelParser {
  let lastError = ''
  return {
    line(event) {
      const type = asString(event.type)
      const out: KernelEvent[] = []
      if (type === 'thread.started' && asString(event.thread_id)) out.push({ type: 'session', id: asString(event.thread_id) })
      else if (type === 'item.completed' || type === 'item.started') {
        const item = asRecord(event.item)
        const kind = asString(item.type)
        if (type === 'item.completed' && kind === 'agent_message' && asString(item.text)) out.push({ type: 'text', text: asString(item.text), final: true })
        else if (type === 'item.completed' && kind === 'reasoning' && asString(item.text)) out.push({ type: 'reasoning', text: `${asString(item.text)}\n` })
        else if (type === 'item.started' && kind === 'command_execution') out.push({ type: 'tool', name: 'shell', detail: truncate(asString(item.command)) })
        else if (type === 'item.completed' && kind === 'file_change') out.push({ type: 'tool', name: 'apply_patch', detail: truncate(asArray(item.changes).map(c => asString(asRecord(c).path)).join(', ')) })
        else if (type === 'item.started' && kind === 'mcp_tool_call') out.push({ type: 'tool', name: `${asString(item.server)}.${asString(item.tool)}`, detail: '' })
        else if (type === 'item.completed' && kind === 'error' && asString(item.message)) lastError = asString(item.message)
      } else if (type === 'turn.completed') {
        const usage = asRecord(event.usage)
        out.push({ type: 'usage', inputTokens: Number(usage.input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0) })
        out.push({ type: 'done' })
      } else if (type === 'turn.failed') {
        out.push({ type: 'error', message: asString(asRecord(event.error).message) || lastError || 'Codex turn failed', fatal: true })
      } else if (type === 'error' && asString(event.message)) {
        lastError = asString(event.message)
      }
      return out
    },
  }
}

function codexLaunch(ctx: KernelLaunchContext): ReturnType<KernelDefinition['launch']> {
  const sandbox = { 'read-only': 'read-only', ask: 'read-only', edit: 'workspace-write', full: 'danger-full-access' } as const
  const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '--sandbox', sandbox[ctx.permission]]
  if (ctx.permission !== 'full') {
    // Strongest settings that still work at this level: commands Codex runs get only the core
    // environment (no gateway token, nothing credential-shaped) and no network.
    args.push('-c', 'shell_environment_policy.inherit="core"', '-c', 'shell_environment_policy.ignore_default_excludes=false')
    if (ctx.permission === 'edit') args.push('-c', 'sandbox_workspace_write.network_access=false')
  }
  const env: Record<string, string> = {}
  if (ctx.mode === 'scoped') {
    env.CODEX_HOME = ctx.home
    env[GATEWAY_KEY_ENV] = ctx.token
    args.push(
      '-c', 'model_provider="luluxflow"',
      '-c', 'model_providers.luluxflow.name="DSH-LULUX Flow"',
      '-c', `model_providers.luluxflow.base_url=${toml(`${ctx.gatewayUrl}/openai/v1`)}`,
      '-c', 'model_providers.luluxflow.wire_api="responses"',
      '-c', `model_providers.luluxflow.env_key="${GATEWAY_KEY_ENV}"`,
      '-c', 'model_providers.luluxflow.request_max_retries=1',
      '-c', 'model_providers.luluxflow.stream_max_retries=1',
      '-c', `model=${toml(ctx.model)}`,
    )
  }
  // Developer instructions are recorded in the new session; a resumed one already has them.
  if (ctx.appendSystemPrompt !== undefined && ctx.resumeSessionId === undefined) args.push('-c', `developer_instructions=${toml(ctx.appendSystemPrompt)}`)
  if (ctx.resumeSessionId !== undefined) args.push('resume', ctx.resumeSessionId)
  args.push('-')
  return { args, env, promptVia: 'stdin' }
}

// ── Gemini CLI ──────────────────────────────────────────────────────────────

function geminiParser(): KernelParser {
  let lastError = ''
  return {
    line(event) {
      const type = asString(event.type)
      const out: KernelEvent[] = []
      if (type === 'init' && asString(event.session_id)) out.push({ type: 'session', id: asString(event.session_id) })
      else if (type === 'message' && event.role === 'assistant' && typeof event.content === 'string') out.push({ type: 'text', text: event.content })
      else if (type === 'tool_use') out.push({ type: 'tool', name: asString(event.tool_name), detail: describeInput(event.parameters) })
      else if (type === 'error') lastError = asString(event.message) || JSON.stringify(event).slice(0, 300)
      else if (type === 'result') {
        if (event.status === 'error') out.push({ type: 'error', message: asString(asRecord(event.error).message) || lastError || 'Gemini CLI reported an error', fatal: true })
        const stats = asRecord(event.stats)
        if (typeof stats.input_tokens === 'number') out.push({ type: 'usage', inputTokens: stats.input_tokens, outputTokens: Number(stats.output_tokens ?? 0) })
        out.push({ type: 'done' })
      }
      return out
    },
  }
}

const approvalModes = { 'read-only': 'plan', ask: 'default', edit: 'auto_edit', full: 'yolo' } as const

function settingsJson(extra: Record<string, unknown>): string {
  return JSON.stringify({ privacy: { usageStatisticsEnabled: false }, general: { disableAutoUpdate: true, disableUpdateNag: true }, ...extra }, null, 2)
}

function geminiLaunch(ctx: KernelLaunchContext): ReturnType<KernelDefinition['launch']> {
  const args = ['--output-format', 'stream-json', '--approval-mode', approvalModes[ctx.permission], '--skip-trust', '-p', ' ']
  const env: Record<string, string> = {}
  const files: Record<string, string> = {}
  if (ctx.mode === 'scoped') {
    files['.gemini/settings.json'] = settingsJson({ security: { auth: { selectedType: 'gemini-api-key' } } })
    Object.assign(env, { GEMINI_CLI_HOME: ctx.home, GOOGLE_GEMINI_BASE_URL: `${ctx.gatewayUrl}/gemini`, GEMINI_API_KEY: ctx.token })
    args.push('--model', ctx.model)
  }
  return { args, env, files, promptVia: 'stdin' }
}

// ── Qwen Code ───────────────────────────────────────────────────────────────

function qwenLaunch(ctx: KernelLaunchContext): ReturnType<KernelDefinition['launch']> {
  const args = ['--output-format', 'stream-json', '--include-partial-messages', '--approval-mode', approvalModes[ctx.permission]]
  const env: Record<string, string> = {}
  const files: Record<string, string> = {}
  if (ctx.mode === 'scoped') {
    files['settings.json'] = settingsJson({ security: { auth: { selectedType: 'openai' } } })
    Object.assign(env, { QWEN_HOME: ctx.home, OPENAI_BASE_URL: `${ctx.gatewayUrl}/openai/v1`, OPENAI_API_KEY: ctx.token, OPENAI_MODEL: ctx.model })
    args.push('--auth-type', 'openai', '--model', ctx.model)
  }
  return { args, env, files, promptVia: 'stdin' }
}

// ── Grok CLI ────────────────────────────────────────────────────────────────

function grokParser(): KernelParser {
  return {
    line(event) {
      const type = asString(event.type)
      if (type === 'text' && typeof event.data === 'string' && event.data) return [{ type: 'text', text: event.data }]
      if (type === 'thinking' && typeof event.data === 'string' && event.data) return [{ type: 'reasoning', text: event.data }]
      if (type === 'tool' || type === 'tool_call') return [{ type: 'tool', name: asString(event.name) || asString(asRecord(event.data).name) || 'tool', detail: describeInput(asRecord(event.data).arguments ?? event.arguments) }]
      if (type === 'error') return [{ type: 'error', message: String(event.message ?? 'Grok reported an error').replace(/^Internal error:\s*/, ''), fatal: true }]
      if (type === 'end') {
        const stop = asString(event.stopReason)
        return /error|refus/i.test(stop) ? [{ type: 'error', message: `stopReason=${stop}`, fatal: true }, { type: 'done' }] : [{ type: 'done' }]
      }
      return []
    },
  }
}

function grokLaunch(ctx: KernelLaunchContext): ReturnType<KernelDefinition['launch']> {
  const args = ['--prompt-file', '{promptFile}', '--output-format', 'streaming-json', '--no-alt-screen', '--no-auto-update', '--no-subagents', '--disable-web-search', '--always-approve']
  // Grok CLI has no "edits but no shell" mode: anything below full gets the read-only tool set.
  // (The Kernels page refuses "edit" for Grok; this keeps old settings from meaning "full".)
  if (ctx.permission !== 'full') args.push('--tools', 'read_file,list_dir,grep')
  const env: Record<string, string> = {}
  const files: Record<string, string> = {}
  if (ctx.mode === 'scoped') {
    files['config.toml'] = [
      '# Managed by DSH-LULUX Flow for one run; rewritten every time.',
      '[cli]',
      'auto_update = false',
      '',
      '[models]',
      'default = "luluxflow"',
      'session_summary = "luluxflow"',
      'web_search = "luluxflow"',
      'image_description = "luluxflow"',
      '',
      '[model.luluxflow]',
      `model = ${toml(ctx.model)}`,
      `base_url = ${toml(`${ctx.gatewayUrl}/openai/v1`)}`,
      'name = "DSH-LULUX Flow"',
      `env_key = "${GATEWAY_KEY_ENV}"`,
      'api_backend = "chat_completions"',
      'supports_backend_search = false',
      'max_retries = 1',
      '',
      '[compat.claude]',
      'skills = false',
      'rules = false',
      'agents = false',
      'mcps = false',
      'hooks = false',
      '',
    ].join('\n')
    Object.assign(env, { GROK_HOME: ctx.home, [GATEWAY_KEY_ENV]: ctx.token, GROK_DISABLE_AUTOUPDATER: '1', GROK_MEMORY: '0', GROK_SUBAGENTS: '0' })
    args.push('-m', 'luluxflow')
  }
  return { args, env, files, promptVia: 'file' }
}

export const BUILTIN_KERNELS: KernelDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    npmPackage: '@anthropic-ai/claude-code',
    bin: 'claude',
    minVersion: '>=2.0.34',
    protocols: ['anthropic', 'mcp'],
    avatar: 'claude-code.png',
    color: '#d97757',
    loginHint: 'Run `claude` once and complete /login, or set ANTHROPIC_API_KEY, then restart DSH.',
    supportsResume: true,
    sessionStateDirs: ['projects'],
    // Claude Code rebuilds its system prompt on every launch, so the option goes on every run.
    systemPromptVia: 'flag',
    supportsApprovalBridge: true,
    launch: claudeLaunch,
    parser: claudeParser,
    loginEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    loginFiles: [['.claude', '.credentials.json']],
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    npmPackage: '@openai/codex',
    bin: 'codex',
    minVersion: '>=0.100.0',
    protocols: ['openai-responses'],
    avatar: 'codex.png',
    color: '#5b5bd6',
    loginHint: 'Run `codex login`, or set OPENAI_API_KEY, then restart DSH.',
    supportsResume: true,
    sessionStateDirs: ['sessions'],
    systemPromptVia: 'flag-new-session',
    supportsApprovalBridge: false,
    launch: codexLaunch,
    parser: codexParser,
    loginEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    loginFiles: [['.codex', 'auth.json']],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google',
    npmPackage: '@google/gemini-cli',
    bin: 'gemini',
    minVersion: '>=0.30.0',
    protocols: ['gemini'],
    avatar: 'gemini-cli.png',
    color: '#3b7bf6',
    loginHint: 'Run `gemini` and sign in with Google, or set GEMINI_API_KEY, then restart DSH.',
    supportsResume: false,
    supportsApprovalBridge: false,
    launch: geminiLaunch,
    parser: geminiParser,
    loginEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA'],
    loginFiles: [['.gemini', 'oauth_creds.json']],
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    vendor: 'Alibaba Qwen',
    npmPackage: '@qwen-code/qwen-code',
    bin: 'qwen',
    minVersion: '>=0.10.0',
    protocols: ['openai-chat'],
    avatar: 'qwen-code.png',
    color: '#6a4cf5',
    loginHint: 'Run `qwen` and complete sign-in (Qwen OAuth or an OpenAI-compatible key), then restart DSH.',
    supportsResume: false,
    supportsApprovalBridge: false,
    launch: qwenLaunch,
    parser: claudeParser,
    loginEnv: ['DASHSCOPE_API_KEY'],
    loginFiles: [['.qwen', 'oauth_creds.json']],
  },
  {
    id: 'grok',
    name: 'Grok CLI',
    vendor: 'xAI',
    npmPackage: '@xai-official/grok',
    bin: 'grok',
    minVersion: '>=1.0.0',
    protocols: ['openai-chat'],
    avatar: 'grok.png',
    color: '#262626',
    loginHint: 'Run `grok login`, or set XAI_API_KEY, then restart DSH.',
    supportsResume: false,
    supportsApprovalBridge: false,
    permissions: ['read-only', 'ask', 'full'],
    launch: grokLaunch,
    parser: grokParser,
    loginEnv: ['XAI_API_KEY'],
    loginFiles: [['.grok', 'auth.json']],
  },
]

const registry = new Map<string, KernelDefinition>(BUILTIN_KERNELS.map(def => [def.id, def]))

/** Register an additional kernel adapter (third-party extension point). Returns a disposer. */
export function registerKernel(def: KernelDefinition): () => void {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(def.id)) throw new Error(`invalid kernel id: ${def.id}`)
  if (registry.has(def.id)) throw new Error(`kernel already registered: ${def.id}`)
  registry.set(def.id, def)
  return () => {
    if (registry.get(def.id) === def) registry.delete(def.id)
  }
}

export function findKernel(id: string): KernelDefinition | undefined {
  return registry.get(id)
}

export function listKernels(): KernelDefinition[] {
  return [...registry.values()]
}
