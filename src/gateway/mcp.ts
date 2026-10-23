/**
 * A minimal MCP (streamable HTTP, JSON responses) server exposing one tool,
 * `approve`, which Claude Code calls through `--permission-prompt-tool` when
 * it needs permission. The call is bridged to DSH's approval UI, so a CLI
 * running as the chat's main agent asks the user through DSH itself.
 */
import { asRecord, asString } from './canonical.js'
import type { TokenRecord } from './tokens.js'

export interface ApprovalDecision {
  allow: boolean
  message?: string
}

export interface ApprovalBridge {
  /** Ask the user. Must fail closed (allow=false) when no one can answer. */
  request(record: TokenRecord, ask: { toolName: string; input: unknown }): Promise<ApprovalDecision>
}

export const MCP_SERVER_NAME = 'lulux_flow'
export const MCP_APPROVAL_TOOL = 'approve'
/** The fully-qualified name Claude Code uses for the tool. */
export const CLAUDE_PERMISSION_TOOL = `mcp__${MCP_SERVER_NAME}__${MCP_APPROVAL_TOOL}`

const PROTOCOL_VERSION = '2025-06-18'

type JsonRpcReply = Record<string, unknown>

export class McpEndpoint {
  constructor(private readonly approvals: ApprovalBridge | undefined) {}

  /** Handle one JSON-RPC message or batch. Returns undefined for notification-only input. */
  async handle(body: unknown, record: TokenRecord): Promise<JsonRpcReply | JsonRpcReply[] | undefined> {
    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map(item => this.one(item, record)))).filter((r): r is JsonRpcReply => r !== undefined)
      return replies.length > 0 ? replies : undefined
    }
    return this.one(body, record)
  }

  private async one(raw: unknown, record: TokenRecord): Promise<JsonRpcReply | undefined> {
    const message = asRecord(raw)
    const method = asString(message.method)
    const id = message.id
    if (id === undefined || id === null) return undefined // notification
    const ok = (result: unknown): JsonRpcReply => ({ jsonrpc: '2.0', id, result })
    const err = (code: number, text: string): JsonRpcReply => ({ jsonrpc: '2.0', id, error: { code, message: text } })
    switch (method) {
      case 'initialize': {
        const requested = asString(asRecord(message.params).protocolVersion)
        return ok({
          protocolVersion: requested || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh-lulux-flow', version: '0.1.1' },
        })
      }
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({
          tools: [
            {
              name: MCP_APPROVAL_TOOL,
              description: 'Ask the DSH user to approve a tool call requested by the external CLI agent.',
              inputSchema: {
                type: 'object',
                properties: {
                  tool_name: { type: 'string' },
                  input: { type: 'object' },
                  tool_use_id: { type: 'string' },
                },
                required: ['tool_name'],
              },
            },
          ],
        })
      case 'tools/call': {
        const params = asRecord(message.params)
        if (asString(params.name) !== MCP_APPROVAL_TOOL) return err(-32602, 'unknown tool')
        const args = asRecord(params.arguments)
        const toolName = asString(args.tool_name) || 'unknown'
        const input = args.input ?? {}
        let decision: ApprovalDecision
        try {
          decision = this.approvals === undefined ? { allow: false, message: 'No approval channel is available.' } : await this.approvals.request(record, { toolName, input })
        } catch (error: unknown) {
          decision = { allow: false, message: error instanceof Error ? error.message : 'approval failed' }
        }
        const payload = decision.allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: decision.message ?? 'The user denied this action in DSH.' }
        return ok({ content: [{ type: 'text', text: JSON.stringify(payload) }] })
      }
      default:
        return err(-32601, `method not found: ${method}`)
    }
  }
}
