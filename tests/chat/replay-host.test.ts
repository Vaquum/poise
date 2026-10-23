// The replay host: re-derived emissions already in the transcript are
// suppressed by seq, requests re-attach to their persisted ids, and
// anything new flows through to the inner host.

import { describe, expect, it } from 'vitest'
import { createReplayHost, onWireOptionId, replayMatchKey, type ReplayPending } from '../../server/chat/replay'
import type { AdapterHost, PermissionRequest, QuestionRequest } from '../../server/chat/adapters/types'
import type { ChatEnvelope, ChatEvent } from '../../server/chat/protocol'

const TURN = 'turn-replay-1'

function envelope(seq: number, event: ChatEvent): ChatEnvelope {
  return { seq, sessionId: 'session-1', at: new Date().toISOString(), event }
}

function innerHost(): AdapterHost & { events: ChatEvent[], permissions: PermissionRequest[], questions: QuestionRequest[] } {
  const host = {
    sessionId: 'session-1',
    checkout: '/tmp/checkout',
    events: [] as ChatEvent[],
    permissions: [] as PermissionRequest[],
    questions: [] as QuestionRequest[],
    spawn: () => { throw new Error('no spawn in replay') },
    emit: (event: ChatEvent) => { host.events.push(event) },
    requestPermission: async (request: PermissionRequest) => {
      host.permissions.push(request)
      return 'inner-answer'
    },
    askQuestion: async (request: QuestionRequest) => {
      host.questions.push(request)
      return { q: 'inner' }
    },
    readTextFile: async () => 'file',
    writeTextFile: async () => {},
    log: () => {},
  }
  return host
}

const OPTIONS = [
  { id: 'allow', name: 'Allow', kind: 'allow_once' as const },
  { id: 'allow_session', name: 'Allow for this session', kind: 'allow_always' as const },
  { id: 'reject', name: 'Reject', kind: 'reject_once' as const },
]

describe('replay host', () => {
  it('maps a recorded always-choice to its once-only wire id', () => {
    expect(onWireOptionId(OPTIONS, 'allow_session')).toBe('allow')
    expect(onWireOptionId(OPTIONS, 'reject')).toBe('reject')
    expect(() => onWireOptionId(OPTIONS, 'nope')).toThrow('unknown option')
  })

  it('suppresses replayed emissions in persisted order and emits the new ones', () => {
    const inner = innerHost()
    const suppressed: ChatEvent[] = []
    const persisted = [
      envelope(2, { type: 'text.delta', turnId: TURN, messageId: `${TURN}:m1`, delta: 'hi' }),
      envelope(3, { type: 'status.changed', status: 'waiting' }),
      envelope(4, { type: 'tool.finished', turnId: TURN, id: 't1', status: 'completed', content: [{ type: 'text', text: 'ok' }], durationMs: 12 }),
    ]
    const host = createReplayHost({ inner, turnId: TURN, persisted, registerPending: () => {}, onSuppressed: (event) => suppressed.push(event) })
    host.emit({ type: 'text.delta', turnId: TURN, messageId: `${TURN}:m1`, delta: 'hi' })
    // A duration recomputed after the restart still matches its event.
    host.emit({ type: 'tool.finished', turnId: TURN, id: 't1', status: 'completed', content: [{ type: 'text', text: 'ok' }], durationMs: 9000 })
    // Bytes the previous Poise never parsed are new transcript material.
    host.emit({ type: 'text.delta', turnId: TURN, messageId: `${TURN}:m1`, delta: ' late' })
    expect(suppressed.map((event) => event.type)).toEqual(['text.delta', 'tool.finished'])
    expect(inner.events).toEqual([{ type: 'text.delta', turnId: TURN, messageId: `${TURN}:m1`, delta: ' late' }])
  })

  it('matches diffs by content, not by their minted ids', () => {
    expect(replayMatchKey({ type: 'diff', turnId: TURN, toolId: 't', diffId: 'a', path: 'f', oldText: 'o', newText: 'n', oldExists: true, newExists: true }))
      .toBe(replayMatchKey({ type: 'diff', turnId: TURN, toolId: 't', diffId: 'b', path: 'f', oldText: 'o', newText: 'n', oldExists: true, newExists: true }))
    expect(replayMatchKey({ type: 'turn.started', turnId: TURN, prompt: { text: '', attachments: [], mentions: [] } })).toBeNull()
  })

  it('returns recorded answers without asking again', async () => {
    const inner = innerHost()
    const requested = { type: 'permission.requested', id: 'req-1', turnId: TURN, toolId: 'tool-1', title: 'Run rm', options: OPTIONS } as const
    const persisted = [
      envelope(2, { ...requested }),
      envelope(3, { type: 'permission.resolved', id: 'req-1', optionId: 'allow_session', by: 'user' as const }),
    ]
    const host = createReplayHost({ inner, turnId: TURN, persisted, registerPending: () => { throw new Error('must not pend a recorded request') } })
    await expect(host.requestPermission({ toolId: 'tool-1', title: 'Run rm', options: [...OPTIONS] })).resolves.toBe('allow')
    expect(inner.permissions).toHaveLength(0)
  })

  it('rejects replayed requests the transcript shows cancelled', async () => {
    const inner = innerHost()
    const persisted = [
      envelope(2, { type: 'permission.requested', id: 'req-1', turnId: TURN, title: 'Run rm', options: OPTIONS }),
      envelope(3, { type: 'permission.resolved', id: 'req-1', optionId: '', by: 'cancelled' as const }),
    ]
    const host = createReplayHost({ inner, turnId: TURN, persisted, registerPending: () => {} })
    await expect(host.requestPermission({ title: 'Run rm', options: [...OPTIONS] })).rejects.toThrow('no longer pending')
  })

  it('re-attaches still-pending requests under their persisted ids', async () => {
    const inner = innerHost()
    const pending = new Map<string, ReplayPending>()
    const persisted = [
      envelope(2, { type: 'question.asked', id: 'q-1', turnId: TURN, questions: [{ id: '0', question: 'Which?', options: [], multiSelect: false, freeText: true }] }),
    ]
    const host = createReplayHost({ inner, turnId: TURN, persisted, registerPending: (id, entry) => { pending.set(id, entry) } })
    const answers = host.askQuestion({ questions: [{ id: '0', question: 'Which?', options: [], multiSelect: false, freeText: true }] })
    expect(inner.questions).toHaveLength(0)
    expect([...pending.keys()]).toEqual(['q-1'])
    pending.get('q-1')!.resolve({ '0': 'afterwards' })
    await expect(answers).resolves.toEqual({ '0': 'afterwards' })
  })

  it('sends requests with no persisted match through the inner host', async () => {
    const inner = innerHost()
    const host = createReplayHost({ inner, turnId: TURN, persisted: [], registerPending: () => {} })
    await expect(host.requestPermission({ title: 'New', options: [...OPTIONS] })).resolves.toBe('inner-answer')
    expect(inner.permissions).toHaveLength(1)
  })

  it('never reuses unused one-time answers after the adopted turn ends', async () => {
    const inner = innerHost()
    const questions = [{ id: '0', question: 'Which?', options: [], multiSelect: false, freeText: true }]
    const host = createReplayHost({ inner, turnId: TURN, persisted: [
      envelope(1, { type: 'permission.requested', id: 'p-old', turnId: TURN, title: 'Run rm', options: OPTIONS }),
      envelope(2, { type: 'permission.resolved', id: 'p-old', optionId: 'allow', by: 'user' }),
      envelope(3, { type: 'question.asked', id: 'q-old', turnId: TURN, questions }),
      envelope(4, { type: 'question.answered', id: 'q-old', answers: { '0': 'old answer' }, by: 'user' }),
    ], registerPending: () => { throw new Error('old request reattached') } })
    host.releaseHistory()
    await expect(host.requestPermission({ title: 'Run rm', options: [...OPTIONS] })).resolves.toBe('inner-answer')
    await expect(host.askQuestion({ questions })).resolves.toEqual({ q: 'inner' })
    expect(inner.permissions).toHaveLength(1)
    expect(inner.questions).toHaveLength(1)
  })
})
