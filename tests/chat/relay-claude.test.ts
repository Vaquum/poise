// Claude relay acceptance: a turn that restarts mid-stream — with a Write
// approval pending, or answered just before the restart — replays without
// repeating or losing a single transcript event and completes normally.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClaudeAdapter } from '../../server/chat/adapters/claude'
import { answerPermission, assertSameTranscript, prompt, runBaselineTurn, runReplayedTurn, waitForEvent, type RelayTranscript } from './relay-harness'

const MODEL = { modelId: 'claude-opus-5', effort: 'high' }

/** The scripted turn writes one file behind one approval. */
const writeInput = (checkout: string) => {
  const path = join(checkout, 'notes.txt')
  writeFileSync(path, 'old content\n')
  return prompt(`write ${path}`)
}

async function answerAllow(transcript: RelayTranscript): Promise<void> {
  await transcript.waitForGate('permission', 0)
  const id = transcript.permissionGates[0].request.options.find((o) => o.kind === 'allow_once')!.id
  await answerPermission(transcript, 0, id)
}

describe('Claude relay replay', () => {
  it('keeps a turn running through a restart with a permission pending', async () => {
    const baseline = await runBaselineTurn({
      script: 'fake-claude.mjs', createAdapter: (host) => createClaudeAdapter(host),
      start: MODEL, input: writeInput, answer: (transcript) => answerAllow(transcript),
    })
    expect(baseline.result.stopReason).toBe('end_turn')

    const replayed = await runReplayedTurn({
      script: 'fake-claude.mjs', createAdapter: (host) => createClaudeAdapter(host),
      start: MODEL, input: writeInput,
      interrupt: async (transcript) => {
        await waitForEvent(transcript, (event) => event.type === 'permission.requested')
      },
      answer: (transcript) => answerAllow(transcript),
    })
    expect(replayed.result).toEqual(baseline.result)
    // The approval is the turn's first event, so there is nothing to
    // suppress; the replayed adapter re-attaches the pending request
    // instead, which the completed turn proves.
    assertSameTranscript(replayed.events, baseline.events)
  })

  it('keeps a turn running through a restart right after the answer', async () => {
    const baseline = await runBaselineTurn({
      script: 'fake-claude.mjs', createAdapter: (host) => createClaudeAdapter(host),
      start: MODEL, input: writeInput, answer: (transcript) => answerAllow(transcript),
    })
    const replayed = await runReplayedTurn({
      script: 'fake-claude.mjs', createAdapter: (host) => createClaudeAdapter(host),
      start: MODEL, input: writeInput,
      interrupt: async (transcript) => {
        await answerAllow(transcript)
        await waitForEvent(transcript, (event) => event.type === 'tool.started')
      },
      answer: async () => {},
    })
    expect(replayed.result).toEqual(baseline.result)
    expect(replayed.suppressed).toBeGreaterThan(0)
    assertSameTranscript(replayed.events, baseline.events)
  })
})
