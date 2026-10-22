# Verification

This page records what was checked against a real DeepSeek Harness before the
0.1.0 release, and how to repeat it on your own machine. Automated tests
(`pnpm test`, `pnpm test:client`) cover the rest; they use a fake CLI
(`test/fixtures/fake-claude.mjs`) and need no network.

## Environment

| Component | Version |
|---|---|
| DeepSeek Harness (`@deepseek-ai/dsh`) | 0.2.1-rc.2, `web` profile |
| Node.js | 22.x |
| Claude Code (`@anthropic-ai/claude-code`) | 2.1.308 |
| Codex (`@openai/codex`) | 0.163.0 |
| OS | Linux (x64/arm64) |
| Upstream model | A local mock server that speaks OpenAI Chat Completions and Anthropic Messages, registered in DSH as two providers (`mockai/mock-1`, `mockanthropic/mock-claude`) |

A mock upstream makes the result deterministic (it echoes the last user
message as `MOCK<…>`) and lets us log exactly which credential reached the
provider. No real vendor account or API key was used.

## What was verified

| # | Check | Result |
|---|---|---|
| 1 | The plugin installs and loads with `dsh plugin --profile web add` (linked checkout, and a staged build of the host bundle) | Loaded; `GET /dsh-lulux-flow/api/meta` answers, gateway `listening: true`; the browser bundle is served inside DSH's client bundle (HTTP 200) |
| 2 | DSH's model picker accepts `lulux-flow-claude-code/default` | Accepted as a session model and as DSH's default model |
| 3 | Subagent providers register on DSH's subagent service | `lulux-flow-claude-code`, `lulux-flow-codex`, `lulux-flow-gemini-cli`, `lulux-flow-qwen-code`, `lulux-flow-grok` listed next to DSH's own providers |
| 4 | Real Claude Code 2.1.308 in **scoped** mode, no login | Run succeeded; one request reached the upstream on the Anthropic wire, with the **provider key configured in DSH**, not a key from the CLI |
| 5 | Real Codex 0.163.0 in **scoped** mode, no login | Run succeeded; Codex's Responses traffic was translated and reached the upstream as an OpenAI Chat request with DSH's provider key |
| 6 | A 3-node workflow (`input → kernel → output`) over the HTTP API | Created (201), started (202), finished `succeeded`; output, trace and token usage recorded |
| 7 | A CLI as the main agent of a DSH chat turn | A DSH agent on model `lulux-flow-claude-code/default` finished its turn; the answer came from the CLI via the gateway |
| 8 | Keys never reach the CLI environment | The test CLI dumps its environment check: `leaked=none`; the CLI's config directory is the per-run private one |
| 9 | Loop guard | `PUT /settings { gatewayModel: "lulux-flow-codex/default" }` is rejected with HTTP 400 |
| 10 | Gateway model fallback | With DSH's default set to a CLI route, the gateway used the last real model seen for the profile (`upstreamSource: "remembered"`) |

Not verified live in 0.1.0: Gemini CLI, Qwen Code and Grok CLI against their
real binaries (covered by adapter unit tests only), macOS and Windows hosts,
and real vendor endpoints.

## Reproduce it

You need DSH 0.2.1-rc.2, Node.js 22, pnpm, and optionally the real CLIs.

### 1. Start an upstream you control

Any OpenAI-compatible endpoint works. A local mock is best because you can log
the `Authorization` / `x-api-key` header it receives. A ~60-line Node
`http.createServer` that answers `POST /v1/chat/completions` (streaming SSE)
and `POST /v1/messages` (Anthropic SSE) with a fixed text is enough. Listen on
`127.0.0.1` only.

### 2. Register it as a DSH provider

In your DSH home (default `~/.dsh`), add to `profiles/web/cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      mockai:
        name: Mock AI
        apiKey: mock-key-123        # a throwaway value you can recognise in the mock's log
        api: openai-completions
        baseURL: http://127.0.0.1:18111/v1
        models:
          - id: mock-1
      mockanthropic:
        name: Mock Anthropic
        apiKey: mock-key-123
        api: anthropic-messages
        baseURL: http://127.0.0.1:18111
        models:
          - id: mock-claude
```

### 3. Install the plugin and start DSH

```bash
git clone https://github.com/koko2376/dsh-lulux-flow.git
cd dsh-lulux-flow && pnpm install && pnpm build
dsh plugin --profile web add "link:$PWD"
dsh --profile web          # starts DSH Web for that profile
```

Open DSH Web with the launch URL it prints, and select `mockai/mock-1` once as
your model so the plugin remembers a real model.

### 4. Call the API

The API uses DSH's browser session. From a script, open the launch URL
(`http://127.0.0.1:<port>/?token=…`) without following redirects and keep the
`set-cookie` value. Send it as `cookie` on every request. Mutating requests
also need `content-type: application/json` and `x-lulux-flow-request: 1`.

```bash
BASE=http://127.0.0.1:<port>
H=(-H "cookie: <session cookie>" -H "content-type: application/json" -H "x-lulux-flow-request: 1")

curl -s "${H[@]}" -X PUT $BASE/dsh-lulux-flow/api/settings \
  -d '{"gatewayModel":"mockanthropic/mock-claude","kernels":{"claude-code":{"mode":"scoped","permission":"read-only"}}}'

curl -s "${H[@]}" "$BASE/dsh-lulux-flow/api/kernels?refresh=1"   # check installed / version

curl -s "${H[@]}" -X POST $BASE/dsh-lulux-flow/api/workflows -d '{
  "name": "verify: input → Claude Code → output",
  "nodes": [
    {"id":"in","type":"input","name":"in","position":{"x":0,"y":0},"config":{}},
    {"id":"k","type":"kernel","name":"Claude Code","position":{"x":240,"y":0},
     "config":{"kernel":"claude-code","prompt":"Reply with one short sentence: what is a DAG?","parseJson":false}},
    {"id":"out","type":"output","name":"out","position":{"x":480,"y":0},"config":{}}
  ],
  "edges": [{"id":"a","source":"in","target":"k"},{"id":"b","source":"k","target":"out"}]
}'
# → 201 {"workflow":{"id":"wf_…",…}, "issues":[]}

curl -s "${H[@]}" -X POST $BASE/dsh-lulux-flow/api/workflows/<wf_id>/run -d '{"inputs":{}}'   # → 202 {"run":{"id":"run_…"}}
curl -s "${H[@]}" $BASE/dsh-lulux-flow/api/runs/<run_id>     # poll until "succeeded"
```

Expected:

- the run's `kernel` node is `succeeded`, its output is the mock's reply, and
  its trace reads `Claude Code completed in … ms (scoped, read-only); gateway requests: 1`;
- the mock's log shows exactly one request, carrying `mock-key-123` (the DSH
  provider key) and **no** credential from your shell or your own CLI login;
- repeating with `"kernel":"codex"` and `gatewayModel` `mockai/mock-1` gives
  the same picture on the OpenAI wire.

For the chat path, pick Claude Code in the session header's kernel picker (or
`lulux-flow-claude-code/default` in DSH's model picker) and send a message.

To check key isolation yourself, export a fake key before starting DSH
(`export OPENAI_API_KEY=sk-should-not-leak-000`) and point a kernel's binary
path at a script that prints its environment: the variable is absent in scoped
mode and present in global mode.

### 5. Clean up

```bash
dsh plugin --profile web remove dsh-lulux-flow
```

Remove the mock providers from `cordis.patch.yml`. Plugin data lives in
`~/.dsh/dsh-lulux-flow/` (workflows, runs, settings, installed CLIs).
