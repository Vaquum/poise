import { EventEmitter } from 'node:events'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { createClaudeAdapter } from '../../server/chat/adapters/claude'
import type { AgentProcess, ReplayInit } from '../../server/chat/adapters/types'
import { createFakeHost } from './adapter-harness'

it.each([
  { kind: 'permission', occurrences: 1 }, { kind: 'permission', occurrences: 2 },
  { kind: 'hook', occurrences: 1 }, { kind: 'hook', occurrences: 2 },
] as const)('suppresses $occurrences recorded Claude $kind responses after LIVE and delivers fresh requests', async ({ kind, occurrences }) => {
  const host = createFakeHost('unused.mjs')
  const events = new EventEmitter()
  const peer = Object.assign(events, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false, exitCode: null as number | null, signalCode: null,
    kill() {
      if (this.killed) return true
      this.killed = true
      this.exitCode = 0
      events.emit('exit', 0, null)
      this.stdout.end()
      this.stderr.end()
      return true
    },
  })
  const receive = (frame: unknown) => peer.stdout.write(`${JSON.stringify(frame)}\n`)
  const responses: string[] = []
  const waiting = new Map<string, () => void>()
  let input = ''
  peer.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    let newline: number
    while ((newline = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      if (!line.trim()) continue
      const frame = JSON.parse(line)
      if (frame.type === 'control_response') {
        const id = frame.response.request_id as string
        responses.push(id)
        waiting.get(id)?.()
        waiting.delete(id)
      } else if (frame.type === 'control_request') {
        queueMicrotask(() => receive({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } }))
      }
    }
  })
  const waitForResponse = (id: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Claude never answered ${id}`)) }, 5_000)
    waiting.set(id, () => { clearTimeout(timer); resolve() })
  })
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const callback = async () => {
    if (++calls === 1) { enter(); await held }
  }
  host.answerPermission = async () => { await callback(); return 'allow' }
  host.readTextFile = async () => { await callback(); return 'original content\n' }
  let goLive!: () => void
  const live = new Promise<void>(resolve => { goLive = resolve })
  const adapter = createClaudeAdapter(host)
  const init: ReplayInit = {
    turnId: 'turn-test', signal: new AbortController().signal, peer: peer as AgentProcess, live,
    outbound: Buffer.from([
      JSON.stringify({ type: 'user', uuid: 'user-test', message: { role: 'user', content: 'continue' } }),
      ...Array.from({ length: occurrences }, () => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'recorded-request', response: kind === 'permission' ? { behavior: 'allow', updatedInput: { command: 'true' }, toolUseID: 'tool-recorded-request' } : {} } })),
      '',
    ].join('\n')),
    outboundTruncated: false,
    session: { nativeSessionId: 'a1b2c3d4-0000-4000-8000-000000000001', modelId: 'claude-opus-5', effort: 'high', efforts: ['high'], safeMode: true },
    recalledDiffs: new Map(),
  }
  const ask = (id: string) => receive({
    type: 'control_request', request_id: id,
    request: kind === 'permission'
      ? { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'true' }, tool_use_id: `tool-${id}` }
      // The pinned SDK registers the adapter's first PreToolUse callback as hook_0.
      : { subtype: 'hook_callback', callback_id: 'hook_0', input: { hook_event_name: 'PreToolUse', session_id: init.session.nativeSessionId, transcript_path: '', cwd: host.checkout, permission_mode: 'default', tool_name: 'Write', tool_input: { file_path: join(host.checkout, `${id}.txt`) } }, tool_use_id: `tool-${id}` },
  })
  const result = adapter.replayTurn!(init)
  void result.catch(() => {})
  try {
    ask('recorded-request')
    await entered
    goLive()
    await live
    // A new response proves LIVE is active while the recorded callback is held.
    const fresh = waitForResponse('fresh-request')
    ask('fresh-request')
    await fresh
    expect(responses).toEqual(['fresh-request'])
    release()
    // The held callback and SDK response writer have only promise continuations
    // left. Drain those before inspecting the absent historical response.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(responses).toEqual(['fresh-request'])
    // A spool can contain multiple completed requests with one id. Each
    // historical callback must settle before that id is reused again.
    for (let occurrence = 1; occurrence < occurrences; occurrence++) {
      ask('recorded-request')
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(calls).toBe(occurrence + 2)
      expect(responses).toEqual(['fresh-request'])
    }
    // The SDK removes settled request ids from its in-flight map. Reusing one
    // for a new request must not inherit the consumed suppression obligation.
    const reused = waitForResponse('recorded-request')
    ask('recorded-request')
    await reused
    expect(calls).toBe(occurrences + 2)
    expect(responses).toEqual(['fresh-request', 'recorded-request'])
    receive({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 4, num_turns: 1, result: 'done', stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], errors: [], session_id: init.session.nativeSessionId, uuid: 'result-test', user_message_uuids: ['user-test'], queued_turn_count: 0 })
    await expect(result).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(host.spawns).toEqual([])
  } finally {
    release()
    peer.kill()
    await adapter.close()
    peer.stdin.destroy(); peer.stdout.destroy(); peer.stderr.destroy()
    host.dispose()
    rmSync(host.checkout, { recursive: true, force: true })
  }
})

it('captures a replayed Write pre-image before its pending permission can start the write', async () => {
  const host = createFakeHost('unused.mjs')
  const path = join(host.checkout, 'notes.txt')
  writeFileSync(path, 'old content\n')
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const read = host.readTextFile.bind(host)
  let reads = 0
  host.readTextFile = async file => { reads++; enter(); await held; return read(file) }
  const events = new EventEmitter()
  const peer = Object.assign(events, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false, exitCode: null as number | null, signalCode: null,
    kill() {
      if (this.killed) return true
      this.killed = true; this.exitCode = 0
      events.emit('exit', 0, null)
      this.stdout.end(); this.stderr.end()
      return true
    },
  })
  const receive = (frame: unknown) => peer.stdout.write(JSON.stringify(frame) + '\n')
  const waiting = new Map<string, () => void>()
  const responses: string[] = []
  let input = ''
  peer.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    let newline: number
    while ((newline = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, newline); input = input.slice(newline + 1)
      if (!line.trim()) continue
      const frame = JSON.parse(line)
      if (frame.type === 'control_response') {
        const id = frame.response.request_id as string
        responses.push(id)
        // Native Write may truncate as soon as its permission arrives.
        if (id === 'write-permission') writeFileSync(path, '')
        waiting.get(id)?.(); waiting.delete(id)
      } else if (frame.type === 'control_request') {
        queueMicrotask(() => receive({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } }))
      }
    }
  })
  const waitForResponse = (id: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Claude never answered ${id}`)) }, 5_000)
    waiting.set(id, () => { clearTimeout(timer); resolve() })
  })
  let goLive!: () => void
  const live = new Promise<void>(resolve => { goLive = resolve })
  const adapter = createClaudeAdapter(host)
  const session = { nativeSessionId: 'a1b2c3d4-0000-4000-8000-000000000001', modelId: 'claude-opus-5', effort: 'high', efforts: ['high'], safeMode: true }
  const init: ReplayInit = {
    turnId: 'turn-test', signal: new AbortController().signal, peer: peer as AgentProcess, live,
    outbound: Buffer.from([
      JSON.stringify({ type: 'user', uuid: 'user-test', message: { role: 'user', content: 'continue' } }),
      JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'completed-hook', response: {} } }), '',
    ].join('\n')),
    outboundTruncated: false, session, recalledDiffs: new Map(),
  }
  const result = adapter.replayTurn!(init)
  void result.catch(() => {})
  try {
    receive({ type: 'control_request', request_id: 'completed-hook', request: { subtype: 'hook_callback', callback_id: 'hook_0',
      input: { hook_event_name: 'PreToolUse', session_id: session.nativeSessionId, transcript_path: '', cwd: host.checkout,
        permission_mode: 'default', tool_name: 'Write', tool_input: { file_path: path, content: 'new content\n' }, tool_use_id: 'tool-write' }, tool_use_id: 'tool-write' } })
    await entered
    goLive()
    await live
    const writeAllowed = waitForResponse('write-permission')
    void writeAllowed.catch(() => {})
    receive({ type: 'control_request', request_id: 'write-permission', request: { subtype: 'can_use_tool', tool_name: 'Write',
      input: { file_path: path, content: 'new content\n' }, tool_use_id: 'tool-write' } })
    const independent = waitForResponse('independent-permission')
    receive({ type: 'control_request', request_id: 'independent-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash',
      input: { command: 'true' }, tool_use_id: 'tool-independent' } })
    // A later independent response proves the SDK processed this input while
    // the historical hook's file read remains held; no timing sleep is used.
    await independent
    expect(responses).toEqual(['independent-permission'])
    expect(readFileSync(path, 'utf8')).toBe('old content\n')
    release()
    await writeAllowed
    expect(reads).toBe(1)
    writeFileSync(path, 'new content\n')
    receive({ type: 'assistant', message: { id: 'message-tool', role: 'assistant', model: session.modelId,
      content: [{ type: 'tool_use', id: 'tool-write', name: 'Write', input: { file_path: path, content: 'new content\n' } }], stop_reason: 'tool_use' },
      session_id: session.nativeSessionId, parent_tool_use_id: null, uuid: 'assistant-test' })
    receive({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-write', content: 'File written' }] },
      tool_use_result: { type: 'update', filePath: path, content: 'new content\n', structuredPatch: [] }, session_id: session.nativeSessionId,
      parent_tool_use_id: null, uuid: 'tool-result-test' })
    receive({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 4, num_turns: 1, result: 'done', stop_reason: 'end_turn',
      total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], errors: [],
      session_id: session.nativeSessionId, uuid: 'result-test', user_message_uuids: ['user-test'], queued_turn_count: 0 })
    await expect(result).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(host.ofType('diff')).toEqual([expect.objectContaining({ oldText: 'old content\n', newText: 'new content\n', oldExists: true, newExists: true })])
    expect(host.spawns).toEqual([])
  } finally {
    release(); peer.kill()
    await adapter.close()
    peer.stdin.destroy(); peer.stdout.destroy(); peer.stderr.destroy()
    host.dispose()
    rmSync(host.checkout, { recursive: true, force: true })
  }
})
