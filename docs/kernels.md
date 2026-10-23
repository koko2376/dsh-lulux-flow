# Kernels (external CLIs)

DSH-LULUX Flow runs five coding CLIs. Each has a provider-neutral permission
level (`read-only`, `ask`, `edit`, `full`) that is mapped to the CLI's own
flags, and a mode (`scoped` through the plugin's gateway, or `global` with the
CLI's own login).

The level set on the **Kernels** page is used for chat and subagent runs, and
is the **ceiling** for workflow runs: a `kernel` node can ask for a lower level
but never a higher one, and can use `global` mode only when the CLI is set to
`global`. Workflow runs are unattended, so `ask` runs as `read-only` there.

## Permission mapping

| CLI | `read-only` | `ask` | `edit` | `full` |
|---|---|---|---|---|
| Claude Code | `--permission-mode default`, allowed tools `Read,Grep,Glob,LS`, Bash/Edit/Write/WebFetch disallowed | `--permission-mode default`; prompts go to DSH's approval dialog (scoped mode) | `--permission-mode acceptEdits`; other prompts go to DSH's approval dialog (scoped mode) | `--permission-mode bypassPermissions` |
| Codex | `--sandbox read-only` | `--sandbox read-only` | `--sandbox workspace-write`, no network | `--sandbox danger-full-access` |
| Gemini CLI | `--approval-mode plan` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| Qwen Code | `--approval-mode plan` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| Grok CLI | `--tools read_file,list_dir,grep` | same as `read-only` | **not offered** | all tools |

Grok CLI has no "edit files but no shell" mode, so `edit` cannot be selected
for it; an older setting that says `edit` runs with the read-only tool set.

## File access

Provider keys are never passed to a CLI (not in its environment, arguments or
config files). A CLI still runs as your OS user and can read what your user can
read. Extra restrictions applied by the plugin:

| CLI | Restriction |
|---|---|
| Claude Code | `--settings` file with `permissions.deny` rules: `Read`/`Edit` of the DSH home, the plugin data directory, `~/.dsh` and `/proc` (Read rules also apply to Grep and Glob; they do not apply to Bash) |
| Codex | below `full`: `shell_environment_policy.inherit="core"` (commands Codex runs get only a core environment, without the gateway token); `edit` also sets `sandbox_workspace_write.network_access=false` |
| Gemini CLI, Qwen Code, Grok CLI | none beyond their permission flags |

For repositories you do not trust, run DSH in an OS sandbox or as a separate
OS user. See [SECURITY.md](../SECURITY.md).

## Environment (scoped mode)

The environment is an allowlist: `PATH`, `HOME`, `USER`/`USERNAME`/`LOGNAME`,
`SHELL`, `LANG`, `LANGUAGE`, `LC_*`, `TERM`, `COLORTERM`, `TZ`,
`TMPDIR`/`TEMP`/`TMP`, `XDG_*_HOME`, `XDG_RUNTIME_DIR`, `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`/`SSL_CERT_DIR`, the Windows system variables (`SystemRoot`,
`ComSpec`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, …), proxy
variables without credentials, and the names in the `kernelEnvPassthrough`
plugin option. The adapter then adds the gateway URL, the run token and a
private config directory for the CLI.

## Binaries

A CLI is found in this order: the binary path from settings, the plugin's own
install directory, then `PATH`. JavaScript entry points run with the current
Node.js. On Windows, npm `.cmd` shims are resolved to their JavaScript entry
and run with Node.js; only when that fails is the shim run through `cmd.exe`,
with every argument quoted and cmd metacharacters escaped twice (the batch
file re-parses its arguments), as cross-spawn does. Arguments with line
breaks are refused on that path.

## Adding a CLI

Implement `KernelDefinition` (`src/kernels/types.ts`) and call
`registerKernel()`. Set `permissions` when the CLI cannot enforce every level;
missing levels are replaced by the next lower supported one, never a higher
one. Set `systemPromptVia` to say how extra system instructions (an agent
identity) reach the CLI: `flag` (its own option on every run, read from
`ctx.appendSystemPrompt`), `flag-new-session` (its own option only when a
native session starts) or `prompt` (the default: on top of a new session's
prompt, never on resume).
