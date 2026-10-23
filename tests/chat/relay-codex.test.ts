// Codex relay acceptance: a turn that restarts mid-stream — with a decision
// pending — replays without repeating or losing a single transcript event,
// answers the pending decision afterwards, and completes normally.

import { describe, expect, it } from 'vitest'
import { createCodexAdapter } from '../../server/chat/adapters/codex'
import { answerPermission, answerQuestion, assertSameTranscript, prompt, runBaselineTurn, runReplayedTurn, waitForEvent, type RelayTranscript } from './relay-harness'

const MODEL = { modelId: 'gpt-6-astra', effort: 'high' }

/** The default scripted turn asks a command approval, a file-change
 *  approval, a grant, and one question. Session-scoped grants keep their
 *  scope; everything else is answered once. */
async function answerAll(transcript: RelayTranscript, permissions = 3, questions = 1): Promise<void> {
  for (let index = 0; index < permissions; index++) {
    await transcript.waitForGate('permission', index)
    const gate = transcript.permissionGates[index]
    const session = gate.request.title.startsWith('Grant')
    const id = gate.request.options.find((o) => o.kind === (session ? 'allow_always' : 'allow_once'))!.id
    await answerPermission(transcript, index, id)
  }
  for (let index = 0; index < questions; index++) {
    await answerQuestion(transcript, index, { letter: 'B' })
  }
}

describe('Codex relay replay', () => {
  it('keeps a turn running through a restart with a permission pending', async () => {
    const baseline = await runBaselineTurn({
      script: 'fake-codex.mjs', createAdapter: (host) => createCodexAdapter(host),
      start: MODEL, input: prompt('hello'), answer: (transcript) => answerAll(transcript),
    })
    expect(baseline.result.stopReason).toBe('end_turn')

    const replayed = await runReplayedTurn({
      script: 'fake-codex.mjs', createAdapter: (host) => createCodexAdapter(host),
      start: MODEL, input: prompt('hello'),
      interrupt: async (transcript) => {
        await waitForEvent(transcript, (event) => event.type === 'permission.requested')
      },
      answer: (transcript) => answerAll(transcript),
    })
    expect(replayed.result).toEqual(baseline.result)
    expect(replayed.suppressed).toBeGreaterThan(0)
    assertSameTranscript(replayed.events, baseline.events)
  })

  it('keeps a turn running through a restart with a question pending', async () => {
    const baseline = await runBaselineTurn({
      script: 'fake-codex.mjs', createAdapter: (host) => createCodexAdapter(host),
      start: MODEL, input: prompt('hello'), answer: (transcript) => answerAll(transcript),
    })
    const replayed = await runReplayedTurn({
      script: 'fake-codex.mjs', createAdapter: (host) => createCodexAdapter(host),
      start: MODEL, input: prompt('hello'),
      interrupt: async (transcript) => {
        // Answer the approvals first so the restart lands on the question.
        await answerAll(transcript, 3, 0)
        await waitForEvent(transcript, (event) => event.type === 'question.asked')
      },
      // The approvals are recorded; only the question still needs an answer.
      answer: (transcript) => answerAll(transcript, 0, 1),
    })
    expect(replayed.result).toEqual(baseline.result)
    expect(replayed.suppressed).toBeGreaterThan(0)
    assertSameTranscript(replayed.events, baseline.events)
  })
})
