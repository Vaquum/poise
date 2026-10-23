// Muse relay acceptance: a turn that restarts mid-stream — with a decision
// pending — replays without repeating or losing a single transcript event,
// answers the pending decision afterwards, and completes normally.

import { describe, expect, it } from 'vitest'
import { createMuseAdapter } from '../../server/chat/adapters/muse'
import { answerPermission, answerQuestion, assertSameTranscript, prompt, runBaselineTurn, runReplayedTurn, waitForEvent } from './relay-harness'

const MODEL = { modelId: 'muse-spark-1.3-contributor', effort: 'low' }
const ARGS = ['--require-dialogs']

/** The default scripted turn asks four approvals, then one question. */
async function answerAll(transcript: Parameters<typeof answerPermission>[0], permissions = 4, questions = 1): Promise<void> {
  for (let index = 0; index < permissions; index++) {
    await answerPermission(transcript, index, 'allow')
  }
  for (let index = 0; index < questions; index++) {
    await answerQuestion(transcript, index, { letter: 'A', toppings: ['cheese'] })
  }
}

describe('Muse relay replay', () => {
  it('keeps a turn running through a restart with a permission pending', async () => {
    const baseline = await runBaselineTurn({
      script: 'fake-muse.mjs', argv: ARGS, createAdapter: (host) => createMuseAdapter(host),
      start: MODEL, input: prompt('hello'), answer: (transcript) => answerAll(transcript),
    })
    expect(baseline.result.stopReason).toBe('end_turn')

    const replayed = await runReplayedTurn({
      script: 'fake-muse.mjs', argv: ARGS, createAdapter: (host) => createMuseAdapter(host),
      start: MODEL, input: prompt('hello'),
      interrupt: async (transcript) => {
        await waitForEvent(transcript, (event) => event.type === 'permission.requested')
      },
      answer: (transcript) => answerAll(transcript),
    })
    expect(replayed.result).toEqual(baseline.result)
    // The replay re-derived persisted events (suppressed) and emitted only
    // what the previous Poise never saw.
    expect(replayed.suppressed).toBeGreaterThan(0)
    assertSameTranscript(replayed.events, baseline.events)
  })

  it('keeps a turn running through a restart with a question pending', async () => {
    const baseline = await runBaselineTurn({
      script: 'fake-muse.mjs', argv: ARGS, createAdapter: (host) => createMuseAdapter(host),
      start: MODEL, input: prompt('hello'), answer: (transcript) => answerAll(transcript),
    })
    const replayed = await runReplayedTurn({
      script: 'fake-muse.mjs', argv: ARGS, createAdapter: (host) => createMuseAdapter(host),
      start: MODEL, input: prompt('hello'),
      interrupt: async (transcript) => {
        // Answer the approvals first so the restart lands on the question.
        for (let index = 0; index < 4; index++) {
          await answerPermission(transcript, index, 'allow')
        }
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
