import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodexAdapter } from '../../server/chat/adapters/codex'
import { createGrokAdapter } from '../../server/chat/adapters/grok'
import { createMuseAdapter } from '../../server/chat/adapters/muse'
import type { Adapter, AdapterHost, AgentProcess, ReplayInit } from '../../server/chat/adapters/types'
import { createReplayHost, type ReplayPending } from '../../server/chat/replay'
import type { ChatEnvelope } from '../../server/chat/protocol'
import { createFakeHost } from './adapter-harness'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function replay(agent: 'grok' | 'codex' | 'muse', extraOutbound = '', wrap: (host: AdapterHost) => AdapterHost = host => host) {
  const host = createFakeHost('unused.mjs')
  const events = new EventEmitter()
  const peer = Object.assign(events, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false, exitCode: null as number | null,
    kill() {
      if (this.killed) return true
      this.killed = true
      this.exitCode = 0
      events.emit('exit', 0, null)
      this.stdout.end()
      return true
    },
  })
  const adapterHost = wrap(host)
  const adapter: Adapter = agent === 'grok' ? createGrokAdapter(adapterHost) : agent === 'codex' ? createCodexAdapter(adapterHost) : createMuseAdapter(adapterHost)
  let goLive!: () => void
  const live = new Promise<void>(resolve => { goLive = resolve })
  const method = agent === 'grok' ? 'session/prompt' : 'turn/start'
  const init: ReplayInit = {
    turnId: 'turn-test', signal: new AbortController().signal, peer: peer as unknown as AgentProcess,
    live, outbound: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: {} }) + '\n' + extraOutbound), outboundTruncated: false,
    session: { nativeSessionId: 'native-test', modelId: agent === 'muse' ? 'muse-spark-1.3-contributor' : 'test-model', effort: 'low', safeMode: false },
    recalledDiffs: new Map(),
  }
  const receive = (message: unknown) => peer.stdout.write(JSON.stringify(message) + '\n')
  cleanups.push(() => {
    peer.kill()
    peer.stdin.destroy(); peer.stdout.destroy(); peer.stderr.destroy()
    host.dispose()
    rmSync(host.checkout, { recursive: true, force: true })
  })
  return { adapter, init, peer, receive, goLive, host }
}

describe('relay initiation failures', () => {
  it('re-attaches the second identical Grok question instead of reusing the first answer', async () => {
    const questions = [{ id: '0', question: 'Which?', options: [{ label: 'first' }, { label: 'second' }], multiSelect: false, freeText: false }]
    const persisted: ChatEnvelope[] = [
      { seq: 1, sessionId: 'session-test', at: '', event: { type: 'question.asked', id: 'question-first', turnId: 'turn-test', questions } },
      { seq: 2, sessionId: 'session-test', at: '', event: { type: 'question.answered', id: 'question-first', answers: { '0': 'first' }, by: 'user' } },
      { seq: 3, sessionId: 'session-test', at: '', event: { type: 'question.asked', id: 'question-second', turnId: 'turn-test', questions } },
    ]
    const pending = new Map<string, ReplayPending>()
    let entered!: () => void
    const attached = new Promise<void>(resolve => { entered = resolve })
    const f = replay('grok', JSON.stringify({ jsonrpc: '2.0', id: 101, result: { outcome: 'accepted', answers: { 'Which?': 'first' } } }) + '\n',
      inner => createReplayHost({ inner, turnId: 'turn-test', persisted, registerPending: (id, request) => { pending.set(id, request); entered() } }))
    const result = f.adapter.replayTurn!(f.init)
    const params = { sessionId: 'native-test', questions: [{ question: 'Which?', options: [{ label: 'first' }, { label: 'second' }] }] }
    f.receive({ jsonrpc: '2.0', id: 101, method: '_x.ai/ask_user_question', params })
    f.receive({ jsonrpc: '2.0', id: 102, method: '_x.ai/ask_user_question', params })
    await attached
    expect([...pending.keys()]).toEqual(['question-second'])
    expect(f.peer.stdin.read()).toBeNull()
    f.goLive()
    pending.get('question-second')!.resolve({ '0': 'second' })
    await new Promise(resolve => setImmediate(resolve))
    const sent = f.peer.stdin.read().toString().trim().split('\n').map((line: string) => JSON.parse(line))
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 102, result: { outcome: 'accepted', answers: { 'Which?': 'second' } } }])
    f.receive({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } })
    await expect(result).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it.each(['grok', 'codex', 'muse'] as const)('settles %s when its recorded initiation response is an error', async agent => {
    const f = replay(agent)
    const result = f.adapter.replayTurn!(f.init)
    f.receive({ jsonrpc: '2.0', id: 6, error: { code: -32000, message: 'unrelated request failed' } })
    f.receive({ jsonrpc: '2.0', id: 7, error: { code: -32001, message: 'recorded turn was denied' } })
    await expect(result).resolves.toMatchObject({ stopReason: 'error', error: expect.stringContaining('recorded turn was denied') })
    expect(f.host.spawns).toEqual([])
  })

  it('settles Grok when the live relay closes before the prompt result', async () => {
    const f = replay('grok')
    const result = f.adapter.replayTurn!(f.init)
    f.goLive()
    await Promise.resolve()
    f.peer.stdout.end()
    await expect(result).resolves.toMatchObject({ stopReason: 'error', error: expect.stringMatching(/closed|exited/) })
  })

  it('does not use a nonterminal Muse receipt for a later unsent approval stage', async () => {
    const prior = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'approval/decide', params: {
      approvalId: 'approval-test', requirementId: { approvalId: 'approval-test', sourceIndex: 0 },
    } }) + '\n'
    const f = replay('muse', prior)
    let decided!: (sourceIndex: number) => void
    const stage = new Promise<number>(resolve => { decided = resolve })
    f.peer.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const command = JSON.parse(line) as { id: number, method: string, params: { requirementId?: { sourceIndex: number } } }
        if (command.method === 'approval/decide') {
          decided(command.params.requirementId?.sourceIndex ?? -1)
          queueMicrotask(() => f.receive({ jsonrpc: '2.0', id: command.id, result: { approvalId: 'approval-test', status: 'accepted', terminal: true } }))
        } else if (command.method === 'approval/listPending') queueMicrotask(() => f.receive({ jsonrpc: '2.0', id: command.id, result: { approvals: [] } }))
      }
    })
    const result = f.adapter.replayTurn!(f.init)
    f.receive({ jsonrpc: '2.0', id: 7, result: { turnId: 'native-turn', disposition: 'started' } })
    f.receive({ jsonrpc: '2.0', id: 8, result: { approvalId: 'approval-test', status: 'accepted', terminal: false } })
    f.receive({ jsonrpc: '2.0', method: 'approval/requested', params: {
      sessionId: 'native-test', approvalId: 'approval-test', turnId: 'native-turn', itemId: 'item-test', toolName: 'bash', rawArgs: '{}',
      subject: { kind: 'shell', command: 'echo stage two' }, currentRequirementId: { approvalId: 'approval-test', sourceIndex: 1 },
      availableChoices: [{ choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' }],
    } })
    await new Promise(resolve => setImmediate(resolve))
    expect(f.host.permissions).toHaveLength(1)
    f.goLive()
    await expect(stage).resolves.toBe(1)
    f.receive({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'end fixture' } })
    await expect(result).resolves.toMatchObject({ stopReason: 'error' })
  })

  it('settles Muse when a recorded approval decision failed', async () => {
    const prior = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'approval/decide', params: {
      approvalId: 'approval-test', requirementId: { approvalId: 'approval-test', sourceIndex: 0 },
    } }) + '\n'
    const f = replay('muse', prior)
    const result = f.adapter.replayTurn!(f.init)
    f.receive({ jsonrpc: '2.0', id: 7, result: { turnId: 'native-turn', disposition: 'started' } })
    f.receive({ jsonrpc: '2.0', id: 8, error: { code: -32000, message: 'decision command was rejected' } })
    await expect(result).resolves.toMatchObject({ stopReason: 'error', error: expect.stringContaining('decision command was rejected') })
    expect(f.host.events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('approval/decide') }))
  })
})
