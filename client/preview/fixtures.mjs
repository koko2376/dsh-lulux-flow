/**
 * Deterministic API fixtures for screenshots: served by Playwright in place of
 * the plugin HTTP API so pages show a realistic, repeatable state.
 */
const now = Date.now()
const iso = ms => new Date(now - ms).toISOString()

export function workflows(lang) {
  const zh = lang === 'zh'
  const L = (a, b) => (zh ? a : b)
  const ship = {
    schemaVersion: 1,
    id: 'ship_feature',
    name: L('计划 → 实现 → 上线', 'Plan → implement → ship'),
    description: L('Claude Code 写计划，Codex 实现并跑测试，测试通过后人工审批', 'Claude Code plans, Codex implements and runs the tests, a human approves when they pass'),
    inputs: [
      { name: 'repo', type: 'string', required: true },
      { name: 'request', type: 'string', required: true },
    ],
    nodes: [
      { id: 'input', type: 'input', name: L('需求', 'Feature request'), position: { x: 0, y: 150 }, config: {} },
      { id: 'plan', type: 'kernel', name: L('Claude Code 计划', 'Claude Code · plan'), position: { x: 270, y: 150 }, config: { kernel: 'claude-code', prompt: L('为 {{ inputs.repo }} 写实现计划：{{ inputs.request }}', 'Write an implementation plan for {{ inputs.repo }}: {{ inputs.request }}'), permission: 'read-only' }, timeoutMs: 600000 },
      { id: 'implement', type: 'kernel', name: L('Codex 实现', 'Codex · implement'), position: { x: 540, y: 150 }, config: { kernel: 'codex', prompt: L('按计划实现并运行测试：{{ nodes.plan.output }}', 'Implement the plan and run the tests: {{ nodes.plan.output }}'), permission: 'edit' }, retry: { max: 1, backoffMs: 2000 } },
      { id: 'tests', type: 'condition', name: L('测试通过？', 'Tests pass?'), position: { x: 810, y: 150 }, config: { expression: 'nodes.implement.output.tests.failed == 0' } },
      { id: 'approve', type: 'approval', name: L('人工审批', 'Review & approve'), position: { x: 1080, y: -30 }, config: { message: L('测试全部通过，合并这个 PR？', 'All tests pass. Merge this PR?') } },
      { id: 'notify', type: 'notify', name: L('通知 #eng', 'Notify #eng'), position: { x: 1080, y: 320 }, config: { url: 'https://hooks.slack.com/services/…', format: 'slack', message: '{{ run.workflowId }}: {{ nodes.implement.output.summary }}' }, continueOnFailure: true },
      { id: 'output', type: 'output', name: L('可合并的 PR', 'Merge-ready PR'), position: { x: 1350, y: 150 }, config: {} },
    ],
    edges: [
      { id: 's1', source: 'input', target: 'plan', route: 'success' },
      { id: 's2', source: 'plan', target: 'implement', route: 'success' },
      { id: 's3', source: 'implement', target: 'tests', route: 'success' },
      { id: 's4', source: 'implement', target: 'notify', route: 'failure' },
      { id: 's5', source: 'tests', target: 'approve', route: 'true' },
      { id: 's6', source: 'tests', target: 'notify', route: 'false' },
      { id: 's7', source: 'approve', target: 'output', route: 'success' },
      { id: 's8', source: 'notify', target: 'output', route: 'success' },
    ],
    triggers: { cron: [], webhook: { enabled: true } },
    createdAt: iso(86400000 * 2),
    updatedAt: iso(1800000),
  }
  const pr = {
    schemaVersion: 1,
    id: 'pr_fix',
    name: L('PR 修复流水线', 'PR fix pipeline'),
    description: L('Codex 修复失败的测试，Claude Code 复查，人工确认后开 PR', 'Codex fixes failing tests, Claude Code reviews, a human approves, then a PR opens'),
    inputs: [
      { name: 'repo', type: 'string', required: true },
      { name: 'issue', type: 'string', required: true },
    ],
    nodes: [
      { id: 'input', type: 'input', name: L('需求输入', 'Request'), position: { x: 0, y: 170 }, config: {} },
      { id: 'fix', type: 'kernel', name: L('Codex 修复', 'Codex fix'), position: { x: 250, y: 170 }, config: { kernel: 'codex', prompt: L('根据 {{ inputs.issue }} 修复 {{ inputs.repo }} 中失败的测试', 'Fix the failing tests in {{ inputs.repo }} for {{ inputs.issue }}'), permission: 'edit' }, retry: { max: 1, backoffMs: 2000 } },
      { id: 'review', type: 'kernel', name: L('Claude Code 复查', 'Claude Code review'), position: { x: 500, y: 90 }, config: { kernel: 'claude-code', prompt: L('审查这次修改并给出 0–1 的评分：{{ nodes.fix.output }}', 'Review this change and score it 0–1: {{ nodes.fix.output }}'), permission: 'read-only' }, retry: { max: 2, backoffMs: 1000 }, timeoutMs: 600000 },
      { id: 'gate', type: 'condition', name: L('复查通过？', 'Review passed?'), position: { x: 750, y: 90 }, config: { expression: 'nodes.review.output.score >= 0.8' } },
      { id: 'approve', type: 'approval', name: L('人工确认', 'Human sign-off'), position: { x: 1000, y: 0 }, config: { message: L('Claude Code 评分 ≥ 0.8，确认开 PR？', 'Claude Code scored ≥ 0.8. Open the PR?') } },
      { id: 'summary', type: 'agent', name: L('DSH 总结问题', 'DSH summarize'), position: { x: 1000, y: 250 }, config: { prompt: L('总结复查意见：{{ nodes.review.output }}', 'Summarize the review: {{ nodes.review.output }}') } },
      { id: 'pr', type: 'http', name: L('创建 PR', 'Open PR'), position: { x: 1250, y: 0 }, config: { method: 'POST', url: 'https://api.github.com/repos/{{ inputs.repo }}/pulls' } },
      { id: 'notify', type: 'notify', name: L('飞书通知', 'Notify team'), position: { x: 1250, y: 250 }, config: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/…', format: 'feishu', message: '{{ run.workflowId }}: {{ nodes.summary.output }}' }, continueOnFailure: true },
      { id: 'output', type: 'output', name: L('结果', 'Result'), position: { x: 1500, y: 120 }, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'fix', route: 'success' },
      { id: 'e2', source: 'fix', target: 'review', route: 'success' },
      { id: 'e3', source: 'fix', target: 'notify', route: 'failure' },
      { id: 'e4', source: 'review', target: 'gate', route: 'success' },
      { id: 'e5', source: 'gate', target: 'approve', route: 'true' },
      { id: 'e6', source: 'gate', target: 'summary', route: 'false' },
      { id: 'e7', source: 'approve', target: 'pr', route: 'success' },
      { id: 'e8', source: 'approve', target: 'notify', route: 'failure' },
      { id: 'e9', source: 'summary', target: 'notify', route: 'success' },
      { id: 'e10', source: 'pr', target: 'output', route: 'success' },
      { id: 'e11', source: 'notify', target: 'output', route: 'success' },
    ],
    triggers: { cron: [{ id: 'cron', expression: '0 9 * * 1-5', enabled: true }], webhook: { enabled: true } },
    createdAt: iso(86400000 * 3),
    updatedAt: iso(3600000),
  }
  const digest = {
    schemaVersion: 1,
    id: 'daily_digest',
    name: L('每日 Issue 摘要', 'Daily issue digest'),
    description: '',
    nodes: [
      { id: 'input', type: 'input', name: L('输入', 'Input'), position: { x: 0, y: 120 }, config: {} },
      { id: 'fetch', type: 'http', name: L('拉取 Issue', 'Fetch issues'), position: { x: 250, y: 120 }, config: { method: 'GET', url: '' } },
      { id: 'each', type: 'loop', name: L('逐条分类', 'Triage each'), position: { x: 500, y: 120 }, config: { mode: 'items', items: '{{ nodes.fetch.output.body }}', maxIterations: 20, body: { type: 'kernel', config: { kernel: 'gemini-cli', prompt: '{{ loop.item.title }}' } } } },
      { id: 'agent', type: 'agent', name: L('写摘要', 'Write digest'), position: { x: 750, y: 120 }, config: { prompt: '' } },
      { id: 'output', type: 'output', name: L('输出', 'Output'), position: { x: 1000, y: 120 }, config: {} },
    ],
    edges: [
      { id: 'a', source: 'input', target: 'fetch' },
      { id: 'b', source: 'fetch', target: 'each' },
      { id: 'c', source: 'each', target: 'agent' },
      { id: 'd', source: 'agent', target: 'output' },
    ],
    createdAt: iso(86400000 * 6),
    updatedAt: iso(86400000),
  }
  const release = { ...digest, id: 'release_notes', name: L('发布说明生成', 'Release notes'), nodes: digest.nodes.slice(0, 2), edges: [] }
  return [ship, pr, digest, release]
}

const ev = (status, extra = {}) => ({ status, attempts: [], trace: [], artifacts: [], ...extra })

export function runs(lang) {
  const [ship, pr, digest] = workflows(lang)
  const zh = lang === 'zh'
  const shipRun = {
    schemaVersion: 1,
    id: 'run-a83f20c5',
    workflowId: ship.id,
    workflowName: ship.name,
    status: 'succeeded',
    trigger: { kind: 'canvas' },
    inputs: { repo: 'acme/parser-kit', request: zh ? '空输入返回空文档而不是 null' : 'Return an empty document for empty input instead of null' },
    snapshot: ship,
    nodes: {
      input: ev('succeeded', { route: 'success', output: { repo: 'acme/parser-kit' }, startedAt: iso(412000), endedAt: iso(411900) }),
      plan: ev('succeeded', {
        route: 'success', startedAt: iso(411000), endedAt: iso(352000), usage: { inputTokens: 14210, outputTokens: 1180 },
        attempts: [{ attempt: 1, startedAt: iso(411000), endedAt: iso(352000), status: 'succeeded' }],
        input: { kernel: 'claude-code', permission: 'read-only' },
        output: zh ? '1. parse() 在空 token 流时返回 emptyDoc()\n2. 为纯空白输入补测试\n3. 更新 README 的空文档说明' : '1. Return emptyDoc() from parse() when the token stream is empty\n2. Add a whitespace-only test\n3. Note empty documents in the README',
        trace: ['Grep "export function parse"', 'Read src/parser.ts', 'Read test/parser.spec.ts', zh ? '计划 3 步' : 'plan: 3 steps'],
      }),
      implement: ev('succeeded', {
        route: 'success', startedAt: iso(351000), endedAt: iso(198000), usage: { inputTokens: 22840, outputTokens: 2960 },
        attempts: [
          { attempt: 1, startedAt: iso(351000), endedAt: iso(301000), status: 'failed', error: zh ? '1 个测试失败：trims whitespace-only input' : '1 test failed: trims whitespace-only input' },
          { attempt: 2, startedAt: iso(299000), endedAt: iso(198000), status: 'succeeded' },
        ],
        input: { kernel: 'codex', permission: 'edit' },
        output: { summary: zh ? '空输入与纯空白输入都返回空文档' : 'Empty and whitespace-only input now return an empty document', files: ['src/parser.ts', 'test/parser.spec.ts', 'README.md'], tests: { passed: 43, failed: 0 } },
        trace: ['shell: pnpm test parser → 2 failed', 'apply_patch: src/parser.ts', 'apply_patch: test/parser.spec.ts, README.md', 'shell: pnpm test → 43 passed'],
        artifacts: [{ name: 'diff.patch', kind: 'text', value: "--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ export function parse(input: string) {\n+  if (input.trim() === '') return emptyDoc()\n   const tokens = input.split(/\\n+/)" }],
      }),
      tests: ev('succeeded', { route: 'true', output: true, input: { expression: 'nodes.implement.output.tests.failed == 0' }, trace: ['nodes.implement.output.tests.failed == 0 → true'], startedAt: iso(197000), endedAt: iso(196950) }),
      approve: ev('succeeded', { route: 'success', input: zh ? '测试全部通过，合并这个 PR？' : 'All tests pass. Merge this PR?', output: { approved: true, by: 'canvas' }, trace: [zh ? '已批准' : 'approved in canvas'], startedAt: iso(196000), endedAt: iso(61000) }),
      notify: ev('skipped', {}),
      output: ev('succeeded', { route: 'success', output: { pr: 'acme/parser-kit#214' }, startedAt: iso(60000), endedAt: iso(59900) }),
    },
    createdAt: iso(412000),
    startedAt: iso(412000),
    endedAt: iso(59900),
    resumes: 1,
    usage: { inputTokens: 37050, outputTokens: 4140, nodeRuns: 7 },
  }
  const active = {
    schemaVersion: 1,
    id: 'run-7f3a9c21',
    workflowId: pr.id,
    workflowName: pr.name,
    status: 'waiting',
    trigger: { kind: 'canvas' },
    inputs: { repo: 'acme/parser-kit', issue: '#128' },
    snapshot: pr,
    nodes: {
      input: ev('succeeded', { route: 'success', output: { repo: 'acme/parser-kit', issue: '#128' }, startedAt: iso(250000), endedAt: iso(249800) }),
      fix: ev('succeeded', {
        route: 'success',
        startedAt: iso(249000),
        endedAt: iso(160000),
        usage: { inputTokens: 18240, outputTokens: 2310 },
        attempts: [{ attempt: 1, startedAt: iso(249000), endedAt: iso(160000), status: 'succeeded' }],
        input: { kernel: 'codex', prompt: zh ? '根据 #128 修复 acme/parser-kit 中失败的测试' : 'Fix the failing tests in acme/parser-kit for #128', permission: 'edit' },
        output: { summary: zh ? '修复了 parser.spec.ts 中 2 个断言，补充空输入分支' : 'Fixed 2 assertions in parser.spec.ts and added the empty-input branch', files: ['src/parser.ts', 'test/parser.spec.ts'] },
        trace: ['shell: pnpm test parser', 'apply_patch: src/parser.ts, test/parser.spec.ts', 'shell: pnpm test parser → 42 passed'],
      }),
      review: ev('succeeded', {
        route: 'success',
        startedAt: iso(159000),
        endedAt: iso(70000),
        usage: { inputTokens: 9120, outputTokens: 860 },
        attempts: [
          { attempt: 1, startedAt: iso(159000), endedAt: iso(140000), status: 'failed', error: 'gateway timeout' },
          { attempt: 2, startedAt: iso(138000), endedAt: iso(70000), status: 'succeeded' },
        ],
        input: { kernel: 'claude-code', permission: 'read-only' },
        output: { score: 0.92, verdict: zh ? '修改正确，建议补一条边界用例' : 'Correct; suggest one more edge-case test' },
        trace: ['Read src/parser.ts', 'Read test/parser.spec.ts', 'Grep "parseEmpty"', zh ? '评分 0.92' : 'score 0.92'],
        artifacts: [{ name: 'review.md', kind: 'text', value: zh ? '## 复查\n- 修改正确\n- 建议补充 "  " 输入用例' : '## Review\n- Correct change\n- Add a whitespace-only input case' }],
      }),
      gate: ev('succeeded', { route: 'true', output: true, input: { expression: 'nodes.review.output.score >= 0.8' }, trace: ['nodes.review.output.score >= 0.8 → true'], startedAt: iso(69000), endedAt: iso(68900) }),
      approve: ev('waiting', { input: zh ? 'Claude Code 评分 ≥ 0.8，确认开 PR？' : 'Claude Code scored ≥ 0.8. Open the PR?', startedAt: iso(68000) }),
    },
    createdAt: iso(250000),
    startedAt: iso(250000),
    resumes: 0,
    usage: { inputTokens: 27360, outputTokens: 3170, nodeRuns: 6 },
  }
  const done = { ...active, id: 'run-51c0de88', status: 'succeeded', trigger: { kind: 'cron', detail: 'cron' }, createdAt: iso(86400000), startedAt: iso(86400000), endedAt: iso(86000000), nodes: Object.fromEntries(pr.nodes.map(n => [n.id, ev(n.id === 'summary' ? 'skipped' : 'succeeded', { route: 'success' })])) }
  const failed = { ...active, id: 'run-0b9e4417', status: 'failed', error: zh ? 'Codex 修复：重试 1 次后仍失败' : 'Codex fix: failed after 1 retry', trigger: { kind: 'webhook' }, createdAt: iso(172800000), startedAt: iso(172800000), endedAt: iso(172000000), nodes: { input: ev('succeeded'), fix: ev('failed', { error: 'exit 1' }) } }
  const running = { ...active, id: 'run-c41d2e90', workflowId: digest.id, workflowName: digest.name, snapshot: digest, status: 'running', trigger: { kind: 'chat' }, createdAt: iso(40000), startedAt: iso(40000), nodes: { input: ev('succeeded'), fetch: ev('succeeded'), each: ev('running') } }
  return [shipRun, running, active, done, failed]
}

const installState = (id, status = 'idle', extra = {}) => ({ kernelId: id, status, log: [], ...extra })

export function kernels() {
  const base = (id, name, vendor, pkg, avatar, color, extra) => ({
    id, name, vendor, npmPackage: pkg, avatar, color, minVersion: '>=0.1.0', supportsResume: true, supportsApprovalBridge: id === 'claude-code',
    permissions: id === 'grok' ? ['read-only', 'ask', 'full'] : ['read-only', 'ask', 'edit', 'full'],
    installed: true, source: 'managed', versionOk: true, nativeLogin: false,
    settings: { enabled: false, mode: 'scoped', permission: 'ask', binaryPath: '' },
    install: installState(id), provider: `lulux-flow-${id}`, chatRoute: `lulux-flow-${id}`, ...extra,
  })
  return [
    base('claude-code', 'Claude Code', 'Anthropic', '@anthropic-ai/claude-code', 'claude-code.png', '#d97757', { version: '2.1.308', settings: { enabled: true, mode: 'scoped', permission: 'ask', binaryPath: '' } }),
    base('codex', 'Codex', 'OpenAI', '@openai/codex', 'codex.png', '#5b5bd6', { version: '0.163.0', settings: { enabled: true, mode: 'scoped', permission: 'edit', binaryPath: '' } }),
    base('gemini-cli', 'Gemini CLI', 'Google', '@google/gemini-cli', 'gemini-cli.png', '#3b7bf6', { installed: false, versionOk: false, source: undefined, install: installState('gemini-cli', 'installing', { registry: 'https://registry.npmmirror.com', version: '0.9.2', log: ['resolving @google/gemini-cli@0.9.2', 'fetched 214 packages (npmmirror)', 'added 198 packages in 21s'] }) }),
    base('qwen-code', 'Qwen Code', 'Alibaba Qwen', '@qwen-code/qwen-code', 'qwen-code.png', '#6a4cf5', { installed: false, versionOk: false, source: undefined }),
    base('grok', 'Grok CLI', 'xAI', '@xai-official/grok', 'grok.png', '#262626', { version: '0.0.9', source: 'path', nativeLogin: true, settings: { enabled: false, mode: 'global', permission: 'read-only', binaryPath: '' } }),
  ]
}

export const registries = {
  packageName: '@openai/codex',
  probedAt: now,
  referenceVersion: '0.163.0',
  results: [
    { registry: 'https://registry.npmmirror.com', ok: true, latencyMs: 86, throughput: 0, satisfies: true, trusted: true, score: 0.95 },
    { registry: 'https://mirrors.cloud.tencent.com/npm', ok: true, latencyMs: 142, throughput: 0, satisfies: true, trusted: true, score: 0.8 },
    { registry: 'https://repo.huaweicloud.com/repository/npm', ok: true, latencyMs: 211, throughput: 0, satisfies: true, trusted: true, score: 0.66 },
    { registry: 'https://registry.npmjs.org', ok: true, latencyMs: 384, throughput: 0, satisfies: true, trusted: true, score: 0.5 },
    { registry: 'https://npm.example-mirror.cn', ok: false, latencyMs: 4000, throughput: 0, satisfies: false, trusted: false, score: 0, error: 'timeout' },
  ],
}

export const settings = {
  kernels: { 'claude-code': { enabled: true, permission: 'ask' }, codex: { enabled: true, permission: 'edit' } },
  registryOverride: '',
  gatewayModel: '',
  allowScriptNodes: false,
  registryTrustMirror: false,
}

export const meta = { brand: { id: 'dsh-lulux-flow', displayName: 'DSH-LULUX Flow' }, version: '0.1.0', scriptsAllowed: false, scriptsSource: null, gateway: { listening: true }, upstream: { provider: 'deepseek', model: 'deepseek-chat' }, upstreamSource: 'dsh-default', upstreamError: null }
