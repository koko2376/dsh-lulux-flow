# Security policy

DSH-LULUX Flow runs third-party coding CLIs on your machine and forwards their
model traffic to the providers you configured in DeepSeek Harness (DSH). This
page describes what the plugin protects against, what it deliberately does
not, and how to report a problem.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

The plugin targets DSH `>=0.2.1-rc.2 <0.3.0` on Node.js `>=22.15.0`.

## Reporting a vulnerability

Please email **kokozenshii0308@gmail.com** with the subject line
`[security] dsh-lulux-flow`. Do not open a public issue for an unfixed
vulnerability.

Include the plugin version, DSH version, OS, which CLI was involved, and the
smallest reproduction you can share. Redact real API keys and tokens; gateway
tokens start with `dshlf_` and are safe to share only after they have expired.

You can expect an acknowledgement within 7 days. Fixes are released as a patch
version, and reporters are credited in the changelog unless they prefer not
to be.

## Threat model

### Assets

1. The API keys and credentials of the model providers configured in DSH.
2. Your files and shell, which a CLI can touch with the permission you grant.
3. Workflows, run history and webhook secrets stored in the plugin's data
   directory (default `~/.dsh/dsh-lulux-flow`).

### Trust boundaries

| Party | Trusted? |
|---|---|
| The DSH host process and the user signed in to DSH Web | Trusted |
| A CLI launched by the plugin (Claude Code, Codex, Gemini CLI, Qwen Code, Grok CLI) | Partly: it receives your prompt, a workspace and a run-scoped gateway token. Provider keys are never passed to it, but it runs as your OS user (see *Residual risks*) |
| The chat model (and anything it reads: web pages, issues, READMEs) | Untrusted for privileged actions: it can draft workflows, but cannot raise permissions, run unreviewed workflows or decide approvals on its own |
| Other local processes and other users on the same machine | Untrusted |
| Web pages open in your browser | Untrusted |
| Senders of webhook requests | Untrusted until the HMAC signature is verified |
| Hosts reached by HTTP / notify nodes | Untrusted |

### Controls

**Scoped gateway (loopback only).** In scoped mode a CLI talks to a small
HTTP gateway inside the DSH process instead of to a vendor API. The gateway
speaks the Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and
Gemini wire formats and forwards every call to DSH's own model runtime. It
binds `127.0.0.1` on a random port and refuses any other bind address.

**Host and Origin checks.** The gateway only accepts a `Host` header that is a
loopback name on its own port, which blocks DNS-rebinding. Any request that
carries an `Origin` header is refused, and there is no CORS, so a web page
cannot call the gateway even when it guesses the port.

**Run-scoped, hashed tokens.** Each CLI run gets a fresh random 256-bit bearer
token (prefix `dshlf_`). The token is bound to one run, one upstream model and
the wire protocols that CLI needs, and is reusable for the length of that run
(TTL = run timeout + 60 s). The gateway stores only its SHA-256 digest; lookup
compares digests in constant time. The plaintext is given to the CLI in its
environment and, for Claude Code's approval bridge, in a 0600 file inside the
per-run home, which is deleted after the run (left-over run homes are removed
at startup). Tokens expire, are revoked when the run ends, and revoking a
token aborts its in-flight upstream requests. At most 8 concurrent upstream
calls per token are allowed, and request bodies must arrive within 60 s.
Request bodies and tokens are never logged.

**Keys are not passed to the CLI.** Scoped mode builds each CLI's environment
from an allowlist: `PATH`, `HOME`, user and shell names, locale (`LANG`,
`LC_*`), terminal, `TZ`, temp directories, XDG directories, CA bundle
variables, the Windows system variables, and `HTTP(S)_PROXY`/`ALL_PROXY` only
when the URL has no user:password. Everything else, including any
credential-shaped name (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PAT`, `*_SK`, npm
auth settings, …), is dropped. Operators can add names with
`kernelEnvPassthrough` (for example `SSH_AUTH_SOCK`); those are visible to the
CLI. The CLI also gets a private, per-run config directory, so it does not use
your own CLI login files. `--version` probes run with the same scrubbed
environment. Global mode, which you opt into per CLI, keeps your environment
and native login instead, and still strips DSH-internal variables.

**Workflow privileges.** The permission and mode on the Kernels page are a
ceiling for workflow runs: a `kernel` node can ask for a lower permission but
never a higher one, and can use `global` mode only when that CLI is set to
`global`. The `kernel`, `mode`, `permission` and `cwd` fields of kernel nodes
and the `preset` and `cwd` fields of agent nodes must be literal values;
templates there are a lint error, so run inputs (webhook bodies, chat inputs)
cannot choose privileges. Unattended runs treat `ask` as `read-only`.

**Review before run.** Workflows created or changed through the model tools,
drafted by "Generate with AI", or imported are marked *unreviewed* and refuse to
start from any trigger (canvas, chat, cron, webhook) until a person approves
them. Approval happens through the canvas API (DSH login plus CSRF header) and
is bound to a digest of the workflow's executable content: the approve call
must echo the digest the user reviewed, and any later change that does not
come from the canvas makes the workflow unreviewed again. A model-started run
of an unreviewed workflow can instead be approved once in DSH's approval
dialog. A model-started run (or resume / re-run) of a workflow that contains
`edit`/`full` or `global` CLIs, script, HTTP or notify nodes, or agent nodes
with a preset, also asks in DSH's approval dialog first. Approval nodes can
only be decided from the canvas, DSH's approval dialog or their timeout; the
model tools have no approve/reject action. What DSH's approval dialog does is
governed by your DSH approval settings.

**Approvals.** Permission levels are `read-only`, `ask`, `edit` and `full`,
mapped to each CLI's own flags. For Claude Code at `read-only`, `ask` and
`edit`, permission prompts are bridged back to DSH's approval dialog over a
token-protected MCP endpoint on the gateway. Other CLIs rely on their own
sandbox and approval flags.

**HTTP API and CSRF.** The canvas API under `/dsh-lulux-flow/api/` requires
DSH's own browser authentication. Mutating requests also require the header
`X-Lulux-Flow-Request: 1` and a JSON content type, which a cross-site form or
"simple" request cannot produce.

**Run limits.** Runs without their own deadline stop after
`defaultRunDeadlineMs` (6 h by default), and at most `maxActiveRuns` (16) run
at once; CLI output per run is capped at 16 MB.

**Webhooks.** `POST /dsh-lulux-flow/hooks/<workflowId>` is authenticated by
`X-Lulux-Flow-Signature: sha256=<hex>`, an HMAC-SHA256 over
`<timestamp>.<raw body>` with a per-workflow secret, and
`X-Lulux-Flow-Timestamp` (Unix seconds). The timestamp must be within ±5
minutes, comparison is constant-time, and a seen signature is rejected as a
replay (the replay cache is persisted, so a restart does not reopen the window). The webhook trigger must also be enabled on the workflow.

**SSRF guard.** HTTP and notify nodes allow only `http`/`https`. The
destination IP is checked at connect time through a custom DNS lookup, so DNS
rebinding cannot swap in a private address after the check. Loopback, private,
link-local, CGNAT, multicast, documentation and unspecified ranges (IPv4 and
IPv6) are refused unless the host is listed in `allowPrivateHosts`. Redirects
are followed manually (at most 5) and every hop is re-checked; when a redirect
changes origin, `Authorization`, `Cookie`, `Proxy-Authorization` and other
secret-named headers are dropped. Response size and time are capped.

**Redaction.** Run records, the live event stream and the output of the model
tools redact header and field values whose names look secret (`Authorization`,
`Cookie`, `X-Auth-Token`, `Private-Token`, `x-goog-api-key`, `*_secret`,
`accessToken`, …) and strings that look like known key formats. Response
headers such as `Set-Cookie` are not kept. Node outputs are otherwise stored
as returned so later nodes can use them; the copy sent to the model is
redacted.

**Conditions.** The `matches` operator uses a linear-time regular-expression
engine (no backreferences or lookaround). Matching time grows with pattern
size × subject length, not exponentially, and each evaluation has a fixed step
budget (about 100 ms at most on a typical machine); past it the condition fails
with an error instead of blocking DSH. Subjects are matched on their first
20,000 characters.

**Kernel installs.** CLIs are installed into the plugin's data directory in
three steps. (1) The whole dependency tree, including per-platform optional
binary packages, is resolved against registry.npmjs.org with
`npm install --package-lock-only --ignore-scripts`; every lockfile entry must
carry a sha512 integrity hash and resolve to that registry. (2) The tarball
URLs are pointed at the fastest mirror and `npm ci --ignore-scripts` installs
from it; npm checks every tarball against the lockfile, so a mirror can make
the install fail but cannot change what is installed. (3) Only then are the
kernel package's own install scripts run (`npm rebuild <package>`);
dependencies' scripts are not run. Every npm step runs with the same
environment allowlist as a scoped CLI, plus proxy variables and non-secret
`npm_config_*` settings, so provider keys in DSH's environment do not reach
the package's install scripts. If registry.npmjs.org cannot be reached the
install is refused, unless you turn on **Trust mirror** in settings, in which
case the mirror's metadata is trusted for the whole tree. Registry URLs must be
`https://` (`http://` only on 127.0.0.1/localhost) and must not embed
credentials.

**Loop guard.** The gateway never forwards to one of the plugin's own
`lulux-flow-*` model routes, so a CLI cannot be routed to itself.

### Script nodes are not a sandbox

Script nodes are **off by default** and can only be enabled by the operator
with `allowScriptNodes: true` in the plugin config; the browser settings cannot
switch them on. Treat a script node like running a program as your OS user and
only run scripts you wrote or reviewed.

To limit accidents, each script runs in a separate short-lived Node.js process
started with the permission model (`--permission`, no grants): no file system
access, no child processes, no worker threads, no native addons, an empty
environment, a heap limit and a wall-clock timeout. Inside it, the code runs in
a `node:vm` context with string code generation disabled. **Network access is
not restricted**, so a script can send its input anywhere, and a flaw in the
Node.js permission model would give it your user's rights.

### Residual risks

- **A CLI runs as your OS user.** Provider keys are not passed to it, but it can
  read any file your user can read, including DSH's configuration and
  credential files under the DSH home, the plugin's data directory, and on
  Linux other processes' `/proc/<pid>/environ` (which includes the DSH
  process). It could put what it reads into its answer, which is stored in run
  records and shown to the model.
  - Claude Code gets `Read`/`Edit` deny rules (which also apply to Grep and
    Glob) for the DSH home, the plugin data directory, `~/.dsh` and `/proc`.
    Path rules do not cover Bash: Bash is disabled at `read-only`, asks (or is
    denied) at `ask` and `edit`, and is unrestricted at `full`.
  - Codex has no read restrictions; below `full` its tool commands get only a
    core environment (no gateway token) and no network.
  - Gemini CLI, Qwen Code and Grok CLI have no path rules.
  - **For untrusted repositories, run DSH in an OS sandbox (bubblewrap,
    firejail, sandbox-exec, a container or VM) or as a separate OS user** that
    cannot read your real DSH home.
- **The run token** is reachable by any program running as your user during
  the run (environment, the per-run MCP config file). It only works against
  the loopback gateway, only for that run's model, and dies with the run.
- **Global mode** passes your full environment (including provider keys you
  exported) to the CLI by design.
- **Settings are trusted input.** Anyone signed in to DSH Web can change a CLI's
  binary path (which is executed, including for `--version`), its permission
  and mode, and the registry used for installs.
- **Resume re-executes interrupted nodes.** A node that was running when DSH
  stopped runs again on resume, so HTTP requests, notifications and CLI edits
  can happen twice.
- **Per-CLI permission mapping** differs; see [docs/kernels.md](docs/kernels.md).
  Grok CLI has no `edit` level.

### Out of scope

- What a CLI does inside the workspace and with the permission you granted
  (for example `full` / bypass modes). Choose the lowest permission that works.
- Prompt injection that makes a model misuse tools it was legitimately given
  within the permissions you set (the plugin prevents it from raising them).
- An attacker who already runs code as your user, or who can read the DSH
  process memory or your data directory.
- Global mode, where the CLI uses its own login and network access by design.
- Vulnerabilities in DSH itself or in the CLIs; please report those upstream.
