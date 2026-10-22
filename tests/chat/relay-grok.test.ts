// Grok relay acceptance: a turn that restarts mid-stream — with a decision
// pending — replays without repeating or losing a single transcript event,
// answers the pending decision afterwards, and reaches its scripted outcome.

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createGrokAdapter } from '../../server/chat/adapters/grok'
import { FIXTURES } from './adapter-harness'
import { answerPermission, answerQuestion, assertSameTranscript, prompt, runBaselineTurn, runReplayedTurn, waitForEvent, type RelayTranscript } from './relay-harness'

const MODEL = { modelId: 'grok-4.6', effort: 'high' }
const replayArgv = (trace: string): string[] => ['--replay', join(FIXTURES, trace)]

async function answerRejectOnce(transcript: RelayTranscript): Promise<void> {
  await transcript.waitForGate('permission', 0)
  const id = transcript.permissionGates[0].request.options.find((o) => o.kind === 'reject_once')!.id
  await answerPermission(transcript, 0, id)
}

describe('Grok relay replay', () => {
  it('keeps a turn running through a restart with a permission pending', async () => {
    const input = prompt('Run the shell command `rm -f probe-dir/marker.txt` and report whether it succeeded.')
    const baseline = await runBaselineTurn({
      script: 'fake-grok.mjs', argv: replayArgv('grok-permission.trace.json'),
      createAdapter: (host) => createGrokAdapter(host),
      start: MODEL, input,
      answer: (transcript) => answerRejectOnce(transcript),
    })

    const replayed = await runReplayedTurn({
      script: 'fake-grok.mjs', argv: replayArgv('grok-permission.trace.json'),
      createAdapter: (host) => createGrokAdapter(host),
      start: MODEL, input,
      interrupt: async (transcript) => {
        await waitForEvent(transcript, (event) => event.type === 'permission.requested')
      },
      answer: (transcript) => answerRejectOnce(transcript),
    })
    expect(replayed.result).toEqual(baseline.result)
    expect(replayed.suppressed).toBeGreaterThan(0)
    assertSameTranscript(replayed.events, baseline.events)
  })

  it('keeps a turn running through a restart with a question pending', async () => {
    const input = prompt('Use your ask_user_question tool…')
    const answer = async (transcript: RelayTranscript): Promise<void> => {
      await transcript.waitForGate('question', 0)
      const id = transcript.questionGates[0].request.questions[0].id
      await answerQuestion(transcript, 0, { [id]: ['A', 'B'] })
    }
    const baseline = await runBaselineTurn({
      script: 'fake-grok.mjs', argv: replayArgv('grok-question-steer-fork.trace.json'),
      createAdapter: (host) => createGrokAdapter(host),
      start: MODEL, input, answer,
    })
    expect(baseline.result.stopReason).toBe('end_turn')

    const replayed = await runReplayedTurn({
      script: 'fake-grok.mjs', argv: replayArgv('grok-question-steer-fork.trace.json'),
      createAdapter: (host) => createGrokAdapter(host),
      start: MODEL, input,
      interrupt: async (transcript) => {
        await waitForEvent(transcript, (event) => event.type === 'question.asked')
      },
      answer,
    })
    expect(replayed.result).toEqual(baseline.result)
    expect(replayed.suppressed).toBeGreaterThan(0)
    assertSameTranscript(replayed.events, baseline.events)
  })
})
