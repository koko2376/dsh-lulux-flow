/**
 * Script node runtime (operator opt-in: plugin Config `allowScriptNodes: true`).
 *
 * NOT A SANDBOX. Treat a script node like running a program as your OS user,
 * and only run scripts you wrote or reviewed (see SECURITY.md).
 *
 * What the runtime does to limit damage and accidents:
 * - each script runs in a separate, short-lived Node process started with
 *   the permission model (`--permission`, no `--allow-*` grants): no file
 *   system reads or writes, no child processes, no worker threads, no native
 *   addons. Network access is NOT restricted;
 * - the process gets an empty environment (no keys), a V8 heap limit and a
 *   wall-clock timeout (it is killed);
 * - inside it, the code runs in a `node:vm` context whose `console` and
 *   `input` are created inside that context, so they do not hand out the
 *   host realm's `Function` constructor.
 *
 * The script receives `input` (JSON) and returns a JSON-serializable value.
 */
import { spawn } from 'node:child_process'

const CHILD_SOURCE = `
'use strict';
const vm = require('node:vm');
let raw = '';
const send = o => process.stdout.write(JSON.stringify(o), () => process.exit(0));
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let job;
  try { job = JSON.parse(raw); } catch { return send({ ok: false, error: 'bad job', logs: [] }); }
  const p = process.permission;
  if (!p || p.has('fs.read') || p.has('fs.write') || p.has('child') || p.has('worker')) return send({ ok: false, error: 'the Node.js permission model is not available; script nodes need Node.js 22.13 or later', logs: [] });
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  context.__input = job.input;
  const prelude = 'const __logs = [];'
    + 'const __log = (...a) => { if (__logs.length < 200) __logs.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ").slice(0, 2000)); };'
    + 'const console = Object.freeze({ log: __log, info: __log, warn: __log, error: __log });'
    + 'const input = JSON.parse(__input);'
    + 'Object.freeze(Promise.prototype); Object.freeze(Promise);';
  const source = '"use strict";' + prelude + '\\n(async function () { const value = await (function main(input) {\\n' + job.code
    + '\\n})(input); return JSON.stringify({ ok: true, value: JSON.stringify(value === undefined ? null : value), logs: __logs }); })()'
    + '.catch(e => JSON.stringify({ ok: false, error: String(e && e.message || e), logs: __logs }))';
  let pending;
  try {
    pending = vm.runInContext(source, context, { timeout: job.timeoutMs, filename: 'lulux-flow-script.js' });
  } catch (error) {
    return send({ ok: false, error: String(error && error.message || error), logs: [] });
  }
  // The callback receives a primitive string only.
  pending.then(text => { process.stdout.write(typeof text === 'string' ? text : '{"ok":false,"error":"bad result","logs":[]}', () => process.exit(0)); });
});
`

export interface ScriptResult {
  value: unknown
  logs: string[]
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  if (process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

export function runScript(code: string, input: unknown, options: { timeoutMs: number; maxHeapMb: number; signal?: AbortSignal }): Promise<ScriptResult> {
  if (code.length > 100_000) return Promise.reject(new Error('script too long (max 100000 characters)'))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--permission', `--max-old-space-size=${Math.max(8, Math.trunc(options.maxHeapMb))}`, '--disallow-code-generation-from-strings', '-e', CHILD_SOURCE], {
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(hard)
      options.signal?.removeEventListener('abort', onAbort)
      if (child.exitCode === null) child.kill('SIGKILL')
      fn()
    }
    // vm's timeout covers synchronous code; the wall clock covers everything else.
    const hard = setTimeout(() => done(() => reject(new Error(`script timed out after ${options.timeoutMs} ms`))), options.timeoutMs + 500)
    const onAbort = (): void => done(() => reject(new Error('script cancelled')))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > 16 * 1024 * 1024) done(() => reject(new Error('script output too large')))
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000)
    })
    child.on('error', error => done(() => reject(new Error(`script process failed to start: ${error.message}`))))
    child.on('close', exitCode =>
      done(() => {
        let message: { ok: boolean; value?: string; error?: string; logs: string[] }
        try {
          message = JSON.parse(stdout) as typeof message
        } catch {
          const detail = /heap|memory/i.test(stderr) ? 'out of memory' : stderr.trim().split('\n').pop() || `exit code ${exitCode ?? 'unknown'}`
          reject(new Error(`script crashed: ${detail}`))
          return
        }
        if (message.ok) resolve({ value: JSON.parse(message.value ?? 'null') as unknown, logs: message.logs })
        else reject(Object.assign(new Error(`script error: ${message.error ?? 'unknown'}`), { logs: message.logs }))
      }),
    )
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify({ code, input: JSON.stringify(input ?? null), timeoutMs: options.timeoutMs }))
  })
}
