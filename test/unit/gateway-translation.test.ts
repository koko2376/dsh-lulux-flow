import { describe, expect, it } from 'vitest'
import { anthropicMessageFrom, AnthropicStreamEncoder, anthropicToCanonical } from '../../src/gateway/anthropic.js'
import { collect, flattenContent, normalizeSchema, parseImageDataUrl, type CanonicalEvent } from '../../src/gateway/canonical.js'
import { geminiResponseFrom, GeminiStreamEncoder, geminiToCanonical } from '../../src/gateway/gemini.js'
import { chatCompletionFrom, ChatStreamEncoder, chatToCanonical } from '../../src/gateway/openai-chat.js'
import { responsesFrom, ResponsesStreamEncoder, responsesToCanonical } from '../../src/gateway/responses.js'
import { fromArray, parseSse, textReply, toolReply } from '../helpers.js'

describe('canonical helpers', () => {
  it('flattens mixed content and marks omitted blocks', () => {
    expect(flattenContent([{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'url', url: 'x' } }, { type: 'document' }])).toContain('[image omitted')
    expect(flattenContent('plain')).toBe('plain')
  })
  it('normalizes OpenAPI-style schemas', () => {
    expect(normalizeSchema({ $schema: 'x', type: 'OBJECT', properties: { a: { type: 'STRING' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    expect(normalizeSchema(undefined)).toEqual({ type: 'object', properties: {} })
  })
  it('parses only allowed image data URLs', () => {
    expect(parseImageDataUrl('data:image/png;base64,AAAA')).toEqual({ mime: 'image/png', data: 'AAAA' })
    expect(parseImageDataUrl('data:text/html;base64,AAAA')).toBeNull()
  })
  it('collects tool calls and upgrades finish to tool_use', async () => {
    const result = await collect(fromArray(toolReply('t1', 'Read', { path: 'a' }).map(e => (e.type === 'finish' ? { ...e, reason: 'stop' as const } : e))))
    expect(result.toolCalls).toEqual([{ id: 't1', name: 'Read', arguments: '{"path":"a"}' }])
    expect(result.finish).toBe('tool_use')
  })
})

describe('anthropic', () => {
  const body = {
    model: 'claude-x',
    system: [{ type: 'text', text: 'sys' }],
    max_tokens: 100,
    stream: true,
    stop_sequences: ['END'],
    tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }, { type: 'web_search_20250305', name: 'web' }],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'calling' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { p: 'f' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'data' }], is_error: true }, { type: 'text', text: 'next' }] },
    ],
  }
  it('decodes messages, tools and tool results', () => {
    const req = anthropicToCanonical(body)
    expect(req.system).toBe('sys')
    expect(req.maxTokens).toBe(100)
    expect(req.stop).toEqual(['END'])
    expect(req.tools.map(t => t.name)).toEqual(['Read'])
    expect(req.turns).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'calling', toolCalls: [{ id: 'tu1', name: 'Read', arguments: '{"p":"f"}' }] },
      { role: 'tool', toolCallId: 'tu1', text: 'data', isError: true },
      { role: 'user', text: 'next' },
    ])
  })
  it('streams text and incremental tool arguments in valid SSE order', () => {
    const enc = new AnthropicStreamEncoder('m', 10)
    let out = enc.start()
    for (const e of [...textReply('hello'), ...toolReply('t1', 'Read', { p: 1 })].filter(e => e.type !== 'finish')) out += enc.push(e)
    out += enc.push({ type: 'finish', reason: 'tool_use' })
    const frames = parseSse(out)
    const types = frames.map(f => f.event)
    expect(types[0]).toBe('message_start')
    expect(types).toContain('content_block_start')
    const deltas = frames.filter(f => f.event === 'content_block_delta').map(f => (f.data as { delta: { type: string } }).delta.type)
    expect(deltas).toEqual(['text_delta', 'text_delta', 'input_json_delta', 'input_json_delta'])
    const stop = frames.find(f => f.event === 'message_delta')!.data as { delta: { stop_reason: string }; usage: { output_tokens: number } }
    expect(stop.delta.stop_reason).toBe('tool_use')
    expect(stop.usage.output_tokens).toBe(7)
    expect(types.at(-1)).toBe('message_stop')
    // every block start has a matching stop
    expect(types.filter(t => t === 'content_block_start').length).toBe(types.filter(t => t === 'content_block_stop').length)
  })
  it('encodes upstream errors as an error event', () => {
    const enc = new AnthropicStreamEncoder('m', 1)
    expect(parseSse(enc.push({ type: 'finish', reason: 'error', error: 'boom' }))[0]).toMatchObject({ event: 'error' })
  })
  it('builds non-streaming messages with real usage', async () => {
    const msg = anthropicMessageFrom('m', 5, await collect(fromArray(toolReply('t1', 'Read', { a: 1 }))))
    expect(msg.stop_reason).toBe('tool_use')
    expect(msg.content).toEqual([{ type: 'tool_use', id: 't1', name: 'Read', input: { a: 1 } }])
    expect(msg.usage).toMatchObject({ input_tokens: 20, output_tokens: 7 })
  })
})

describe('openai chat', () => {
  it('decodes system, tool calls and tool messages', () => {
    const req = chatToCanonical({
      model: 'gpt',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'out' },
      ],
      tools: [{ type: 'function', function: { name: 'ls', parameters: { type: 'object' } } }],
      max_completion_tokens: 50,
      stop: 'X',
    })
    expect(req.system).toBe('S')
    expect(req.turns[0]).toMatchObject({ role: 'user', text: 'q', images: [{ mime: 'image/png' }] })
    expect(req.turns[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'ls' }] })
    expect(req.turns[2]).toEqual({ role: 'tool', toolCallId: 'c1', text: 'out' })
    expect(req.maxTokens).toBe(50)
    expect(req.stop).toEqual(['X'])
  })
  it('streams chunks with indexed tool calls, usage and [DONE]', () => {
    const enc = new ChatStreamEncoder('m', true)
    let out = ''
    for (const e of toolReply('c9', 'ls', { a: 1 })) out += enc.push(e)
    const frames = parseSse(out)
    expect(frames.at(-1)!.data).toBe('[DONE]')
    const first = frames[0]!.data as { choices: Array<{ delta: { role?: string; tool_calls?: Array<{ index: number; id?: string }> } }> }
    expect(first.choices[0]!.delta.role).toBe('assistant')
    expect(first.choices[0]!.delta.tool_calls![0]).toMatchObject({ index: 0, id: 'c9' })
    const finish = frames.find(f => typeof f.data === 'object' && (f.data as { choices: Array<{ finish_reason: string | null }> }).choices?.[0]?.finish_reason)!
    expect((finish.data as { choices: Array<{ finish_reason: string }> }).choices[0]!.finish_reason).toBe('tool_calls')
    expect(frames.some(f => typeof f.data === 'object' && 'usage' in (f.data as object))).toBe(true)
  })
  it('maps max_tokens to length', async () => {
    const events: CanonicalEvent[] = [{ type: 'text', text: 'x' }, { type: 'finish', reason: 'max_tokens' }]
    const res = chatCompletionFrom('m', 1, await collect(fromArray(events))) as { choices: Array<{ finish_reason: string }> }
    expect(res.choices[0]!.finish_reason).toBe('length')
  })
})

describe('openai responses', () => {
  it('decodes input items and custom tools', () => {
    const req = responsesToCanonical({
      model: 'gpt-5',
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] },
        { type: 'function_call', call_id: 'fc1', name: 'shell', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'fc1', output: 'a.txt' },
        { type: 'custom_tool_call', call_id: 'ct1', name: 'apply_patch', input: '*** Begin' },
        { type: 'custom_tool_call_output', call_id: 'ct1', output: 'ok' },
      ],
      tools: [{ type: 'function', name: 'shell', parameters: {} }, { type: 'custom', name: 'apply_patch' }, { type: 'web_search' }],
      max_output_tokens: 99,
    })
    expect(req.system).toBe('be brief')
    expect(req.customTools.has('apply_patch')).toBe(true)
    expect(req.tools.map(t => t.name)).toEqual(['shell', 'apply_patch'])
    expect(req.turns[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'fc1', name: 'shell' }] })
    expect(req.turns[3]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'ct1', arguments: '{"input":"*** Begin"}' }] })
    expect(req.maxTokens).toBe(99)
  })
  it('streams the Responses event sequence with sequence numbers', () => {
    const enc = new ResponsesStreamEncoder('m', 4)
    let out = enc.start()
    for (const e of [...textReply('hi there').slice(0, 2), ...toolReply('fc2', 'shell', { cmd: 'ls' })]) out += enc.push(e)
    const frames = parseSse(out)
    const types = frames.map(f => f.event)
    expect(types[0]).toBe('response.created')
    expect(types).toContain('response.output_text.delta')
    expect(types).toContain('response.output_text.done')
    expect(types).toContain('response.function_call_arguments.delta')
    expect(types).toContain('response.function_call_arguments.done')
    expect(types.at(-1)).toBe('response.completed')
    const seq = frames.map(f => (f.data as { sequence_number: number }).sequence_number)
    expect(seq).toEqual([...seq].sort((a, b) => a - b))
    const completed = frames.at(-1)!.data as { response: { output: Array<{ type: string }>; usage: { output_tokens: number } } }
    expect(completed.response.output.map(o => o.type)).toEqual(['message', 'function_call'])
    expect(completed.response.usage.output_tokens).toBe(7)
  })
  it('answers custom tools as custom_tool_call with decoded input', async () => {
    const res = responsesFrom('m', 1, await collect(fromArray(toolReply('ct', 'apply_patch', { input: 'PATCH' }))), new Set(['apply_patch'])) as { output: Array<Record<string, unknown>> }
    expect(res.output[0]).toMatchObject({ type: 'custom_tool_call', input: 'PATCH', call_id: 'ct' })
  })
  it('reports incomplete on max_tokens', () => {
    const enc = new ResponsesStreamEncoder('m', 1)
    expect(enc.push({ type: 'finish', reason: 'max_tokens' })).toContain('response.incomplete')
  })
})

describe('gemini', () => {
  it('pairs function calls without ids by name', () => {
    const req = geminiToCanonical(
      {
        systemInstruction: { parts: [{ text: 'S' }] },
        contents: [
          { role: 'user', parts: [{ text: 'go' }] },
          { role: 'model', parts: [{ text: 'ok', thought: false }, { functionCall: { name: 'read', args: { f: 1 } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'read', response: { v: 2 } } }] },
        ],
        tools: [{ functionDeclarations: [{ name: 'read', parameters: { type: 'OBJECT' } }] }],
        generationConfig: { maxOutputTokens: 64 },
      },
      'gemini-x',
      true,
    )
    const call = req.turns[1] as { toolCalls: Array<{ id: string }> }
    const result = req.turns[2] as { toolCallId: string }
    expect(result.toolCallId).toBe(call.toolCalls[0]!.id)
    expect(req.tools[0]!.parameters.type).toBe('object')
    expect(req.maxTokens).toBe(64)
  })
  it('streams whole function calls and final usage', () => {
    const enc = new GeminiStreamEncoder('g', 3)
    let out = ''
    for (const e of toolReply('g1', 'read', { f: 1 })) out += enc.push(e)
    const frames = parseSse(out)
    expect(frames.some(f => JSON.stringify(f.data).includes('functionCall'))).toBe(true)
    expect(JSON.stringify(frames.at(-1)!.data)).toContain('"candidatesTokenCount":7')
  })
  it('builds non-streaming responses', async () => {
    const res = geminiResponseFrom('g', 1, await collect(fromArray(textReply('abc')))) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> }
    expect(res.candidates[0]!.content.parts[0]!.text).toBe('abc')
  })
})
