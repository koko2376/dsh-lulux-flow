# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-23

### Fixed

- **DSH Desktop (Windows): a second DSH window opened and the kernel failed
  to start.** Claude Code 2.1 and later ship a native `claude.exe` behind
  their npm `.cmd` shim; the plugin ran it as a Node.js script with DSH
  Desktop's executable. Native executables now run directly.
- JavaScript entries (Codex's launcher, Gemini CLI, Qwen Code, Grok CLI on
  Windows), script nodes and npm no longer assume the host executable is
  Node.js. Inside DSH Desktop a Node.js 20+ on `PATH` (or in its usual install
  location) is used; otherwise DSH Desktop runs as Node.js
  (`ELECTRON_RUN_AS_NODE=1`) only when the app allows it, and the Kernels page
  explains what is missing instead of starting anything.
- npm `.cmd` shims for Node.js scripts resolved to the `node.exe` they test
  for when Node.js lives in the same folder (nvm-windows, Volta, an npm prefix
  in the Node.js folder), so the CLI started as bare `node.exe`.
- An install whose package scripts did not run left Claude Code's
  placeholder `bin/claude.exe`; it is now reported on the Kernels page instead
  of being started.
- Binaries are identified from their first bytes; resolving a CLI no longer
  reads the whole (hundreds of MB) executable.
- `PATH` lookup follows `PATHEXT`, ignores quoted entries' quotes, skips npm's
  extensionless shell shim on Windows, and also checks `~/.local/bin` and
  `%APPDATA%\npm`. A binary path in settings may be quoted ("Copy as path")
  or point at a `.cmd` / `.bat` file.
- When npm runs on DSH Desktop's runtime, package install scripts that call
  `node` find one. An install that times out ends npm's whole process tree.
- `taskkill` is called by its full path; a run whose working directory is
  missing says so instead of reporting the CLI as missing; settings and
  workflow files are written with a retry when Windows briefly locks them.
- Installing into a DSH profile no longer prints "Issues with peer
  dependencies found": the DSH packages, which come from the DSH runtime, are
  optional peers. A GitHub install no longer resolves the optional subagent
  peer to a newer prerelease than the other DSH packages.

### Changed

- **Simpler workflow page.** The palette shows the common steps (Input,
  Agent, Kernel, Output) with a one-line description each, and the rest under
  "More steps". Rarely used toolbar actions (auto layout, triggers, run
  history, export) are in a labelled "More" menu. Workflows open at a readable
  zoom. The inspector shows a step's essential fields first, with the rest
  under "Advanced settings" and "Connections", and an "Insert variable" picker
  replaces typing `{{ … }}` by hand. A first-time empty state explains the
  three steps to a first run.
- The npm package includes the TypeScript sources (`src/`, `client/src/`).

## [0.1.0] - 2026-10-23

First public release. Requires DSH `>=0.2.1-rc.2 <0.3.0` and Node.js `>=22.15.0`.

### Added

- **Scoped gateway.** A loopback-only gateway inside DSH that speaks the
  Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and Gemini
  wire formats and forwards every call to the model you configured in DSH.
  Claude Code, Codex, Gemini CLI, Qwen Code and Grok CLI run on it without
  their own login, using a run-scoped token and a scrubbed environment.
- **Five CLI kernels** with per-CLI settings: enabled, mode (`scoped` /
  `global`), permission (`read-only` / `ask` / `edit` / `full`) and an
  optional binary path. Install, uninstall and version detection from the
  Kernels page; npm registry mirror probing with integrity cross-checks.
- **CLI as the chat agent.** Model routes `lulux-flow-<kernel>/default` in
  DSH's model picker, plus a session-header kernel picker, so a chat turn runs
  on a CLI. Claude Code and Codex resume their native sessions; the other
  CLIs replay the conversation.
- **Subagent providers** `lulux-flow-<kernel>` registered on DSH's subagent
  service, with optional `lulux_flow_subagent_*` tool rows (off by default) in
  `cordis.patch.yml`.
- **Claude Code approval bridge**: permission prompts surface as DSH approvals.
- **Gateway model** setting to pin the real model CLI traffic goes to, or
  follow DSH's default model (remembering the last real model when the default
  is a CLI route).
- **Workflow engine** for DAGs of `input`, `output`, `agent`, `kernel`,
  `script`, `http`, `condition`, `loop`, `approval` and `notify` nodes, with
  retries, timeouts, continue-on-failure, budgets, concurrency limits,
  approvals, run evidence and traces, resume after restart and re-run.
- **Triggers**: canvas, chat tools, cron schedules and HMAC-signed webhooks.
- **Workflow canvas** in DSH Web: editor, AI generation from a sentence, run
  inspector, run history, kernels and settings pages.
- **Language setting** (Settings → Language / 语言): 中文 (`zh-CN`, the
  default) or English for the whole plugin UI and for the text it shows in
  DSH's approval dialog, independent of DSH's own language. Switching applies
  at once, without a reload.
- **HTTP API** under `/dsh-lulux-flow/api/` and model tools
  `lulux_flow_workflow_{list,get,create,update,run}`, `lulux_flow_run_status`,
  `lulux_flow_run_control` and `lulux_flow_kernel_list`.
- Docs: [docs/kernels.md](docs/kernels.md) (per-CLI permission mapping) and
  [docs/architecture.md](docs/architecture.md).

### Security

See [SECURITY.md](SECURITY.md) for the full model.

- **Workflow privileges.** The permission and mode on the Kernels page are a
  ceiling: a `kernel` node can only ask for a lower permission, and `global`
  mode only when the CLI is set to `global`. Privilege fields (`kernel`,
  `mode`, `permission`, `cwd`; agent `preset`, `cwd`) cannot be templated.
- **Review before run.** Workflows created or changed by the model tools,
  generated with AI, or imported are unreviewed and do not run from any trigger
  until approved in the canvas (`POST /api/workflows/:id/approve` with the
  reviewed digest) or, for one run, in DSH's approval dialog. Model-started
  runs, resumes and re-runs with `edit`/`full`/`global` CLIs, script, HTTP or
  notify nodes, or agent presets ask in DSH's approval dialog first.
- **Approval dialog.** The dialog names each raised CLI with its permission and
  mode first, then counts scripts, HTTP/notify requests and agent presets,
  then the review state; node names are capped at 120 characters. A run
  approved there is bound to the digest of what was shown: if the workflow
  changes while the dialog is open, nothing runs.
- **Approvals.** `lulux_flow_run_control` has no `approve`/`reject`; approval
  nodes are decided only from the canvas, DSH's approval dialog or a timeout.
- **Kernel installs.** The dependency tree is resolved against
  registry.npmjs.org (`npm install --package-lock-only --ignore-scripts`),
  tarballs are installed from a mirror with `npm ci --ignore-scripts` against
  that lockfile, and only then the kernel package's own scripts run. Installs
  are refused when npmjs.org is unreachable unless **Trust mirror** is on.
  Registry URLs must be `https://` (`http://` only on loopback). npm runs with
  the same environment allowlist as a scoped CLI (plus proxy and non-secret
  `npm_config_*` variables), so provider keys do not reach install scripts.
- **Scoped environment** is an allowlist; credential-shaped variables, npm auth
  settings and proxy URLs with credentials are dropped. `kernelEnvPassthrough`
  adds explicit extras (e.g. `SSH_AUTH_SOCK`). `--version` probes run with the
  same scrubbed environment. Gateway tokens are run-scoped and stored hashed.
- **File access.** Claude Code runs with deny rules for the DSH home, the
  plugin data directory and `/proc`; Codex tool commands get only a core
  environment (and no network at `edit`). Remaining risk, documented: a CLI
  runs as your OS user and can read files your user can read.
- **Script nodes** can only be enabled with the plugin config option
  `allowScriptNodes`. Scripts run in a separate Node.js process with the
  permission model (no file system, no child processes), an empty environment
  and no code generation from strings. They still have network access and are
  documented as not being a sandbox.
- **Conditions.** `matches` uses a linear-time regex engine with a step budget
  per evaluation, so a hostile pattern or subject fails the condition instead
  of blocking DSH.
- **HTTP/notify nodes** go through an SSRF guard and drop `Authorization`,
  `Cookie` and other secret headers on cross-origin redirects.
- **Redaction** of secret header and field names in run records, the event
  stream and tool output; response `Set-Cookie` headers are not kept.
- **Windows.** npm `.cmd` shims are run through their JavaScript entry with
  Node.js; the `cmd.exe` fallback escapes arguments twice (batch files
  re-parse them) and refuses line breaks. npm itself is resolved the same way.
- **Grok CLI** offers no `edit` level (it has no edit-without-shell mode).
- Host/Origin checks and a CSRF header on the HTTP API; HMAC-signed webhooks
  with a ±5 minute window and a replay cache persisted across restarts.
- Gateway: request bodies must arrive within 60 s; at most 8 concurrent
  upstream calls per run token. CLI output is capped at 16 MB per run.
- Run limits: `defaultRunDeadlineMs` (6 h) and `maxActiveRuns` (16).
- Left-over per-run CLI homes are removed at startup; cron does not fire twice
  in a daylight-saving fall-back hour.

[Unreleased]: https://github.com/koko2376/dsh-lulux-flow/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/koko2376/dsh-lulux-flow/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/koko2376/dsh-lulux-flow/releases/tag/v0.1.0
