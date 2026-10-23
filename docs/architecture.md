# Architecture

DSH-LULUX Flow is a DSH host plugin with a browser half.

## Host side (`src/`)

| Part | Files | Role |
|---|---|---|
| Gateway | `src/gateway/` | Loopback HTTP server speaking Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and Gemini; translates to DSH's model runtime (`ctx.llm`). Run-scoped tokens (`tokens.ts`), MCP approval bridge for Claude Code (`mcp.ts`). |
| Kernels | `src/kernels/` | CLI catalog and flag mapping (`catalog.ts`), permission policy (`policy.ts`), environment allowlist (`env.ts`), binary resolution (`binary.ts`), runner (`runner.ts`), installer and registry probe (`installer.ts`, `registry-probe.ts`). |
| DSH integration | `src/dsh/` | CLI chat routes (`kernel-chat.ts`, `providers.ts`), subagent providers, DSH agent runner for `agent` nodes, upstream model resolution. |
| Workflows | `src/workflow/` | Engine, validation (lint), review state (`review.ts`), expression language with a linear-time regex engine (`expr.ts`, `safe-regex.ts`), executors, script runtime, SSRF guard, cron, webhooks, file store. |
| HTTP API | `src/http/api.ts` | Canvas API and webhook endpoint on DSH's web server. |
| Model tools | `src/tools.ts` | `lulux_flow_*` tools for the chat model. |

## A CLI as the chat agent

The plugin registers one model route per CLI (`lulux-flow-<cli>/default`).
When a chat session uses that route, each turn is handed to the CLI: it gets
the user's message, runs its own tools in the session's working directory (on
DSH's real model through the gateway), and its answer streams back as the
assistant message. CLI tool activity is shown as reasoning lines; Claude
Code's permission prompts appear as DSH approvals.

Limits of this design: DSH's own tools are not offered to the CLI, and the
CLI's tool calls are not DSH tool calls (the CLI executes them itself, under
the permission level set for it).

What a turn sends to the CLI (`src/dsh/kernel-chat.ts`):

- **Messages.** User-role messages the user typed (`kind: 'user'` or no
  source), messages another agent addressed to the session (context form
  `relay`, whatever the producer: DS Bot's group turns, requests, replies,
  kickoffs and handoffs) and scheduled tasks (`kind: 'schedule'`). Injected
  context (forms `snapshot`, `catalog`, `instructions`, `recall`, and unknown
  producer kinds) is skipped. Delivered-turn counting for native resume uses
  the same rule, and user messages that arrived together are sent together.
- **System text.** Only an agent identity section (`# Your identity`, rendered
  by DS Bot) is forwarded, bounded, as extra system instructions. DSH's own
  system prompt is not: it describes DSH's tools and runtime, which the CLI
  does not have, and the CLI brings its own system prompt. Each kernel
  declares `systemPromptVia` (`flag`, `flag-new-session` or `prompt`).
- **One-shot calls.** A request with `purpose` or `system`, or made only of
  request inputs (no Session message ids or sources), is a hand-built
  one-shot by the dsh-llm contract; it goes to the gateway model and never
  starts the CLI or touches the session's resume state.

`KernelService.run` caps concurrent CLI runs (`kernelMaxConcurrent`,
`kernelMaxConcurrentPerCli`) with a FIFO queue (`src/kernels/limiter.ts`); a
queued run reports one status line and leaves the queue when aborted.

## Workflow runs

A run freezes a snapshot of the workflow, executes nodes when their inbound
edges resolve, and persists per-node evidence after every change. Before a run
starts, the workflow must lint clean and be approved (see
[SECURITY.md](../SECURITY.md#controls)). Kernel nodes run at the lower of the
node's requested permission and the Kernels page setting.
