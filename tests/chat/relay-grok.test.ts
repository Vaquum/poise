// Grok relay acceptance: a turn that restarts mid-stream — with a decision
// pending — replays without repeating or losing a single transcript event,
// answers the pending decision afterwards, and reaches its scripted outcome.

import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createGrokAdapter } from '../../server/chat/adapters/grok'
import type { AgentProcess } from '../../server/chat/adapters/types'
import { createFakeHost, FIXTURES } from './adapter-harness'
import { answerPermission, answerQuestion, assertSameTranscript, prompt, runBaselineTurn, runReplayedTurn, waitForEvent, type RelayTranscript } from './relay-harness'

const MODEL = { modelId: 'grok-4.6', effort: 'high' }
const replayArgv = (trace: string): string[] => ['--replay', join(FIXTURES, trace)]

async function answerRejectOnce(transcript: RelayTranscript): Promise<void> {
  await transcript.waitForGate('permission', 0)
  const id = transcript.permissionGates[0].request.options.find((o) => o.kind === 'reject_once')!.id
  await answerPermission(transcript, 0, id)
}

describe('Grok relay replay', () => {
  it.each([
    ['LIVE rejection', true], ['RPC close', true],
    ['LIVE rejection', false], ['RPC close', false],
  ] as const)('requires verified termination after %s (cancelled=%s)', async (failure, cancelled) => {
    const host = createFakeHost('unused.mjs')
    const events = new EventEmitter()
    const peer = Object.assign(events, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      killed: false, exitCode: null, signalCode: null,
      // A signal request is not proof that the adopted native worker exited.
      kill() { return true },
    })
    let goLive!: () => void
    let rejectLive!: (error: Error) => void
    const live = new Promise<void>((resolve, reject) => { goLive = resolve; rejectLive = reject })
    const controller = new AbortController()
    if (cancelled) controller.abort()
    const adapter = createGrokAdapter(host)
    const running = adapter.replayTurn!({
      turnId: 'failed-recovery', signal: controller.signal, peer: peer as AgentProcess, live,
      outbound: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: 'native-grok', prompt: [] } })}\n`),
      outboundTruncated: false,
      session: { nativeSessionId: 'native-grok', ...MODEL, safeMode: false }, recalledDiffs: new Map(),
    })
    try {
      if (failure === 'LIVE rejection') rejectLive(new Error('replay could not reach LIVE'))
      else {
        goLive()
        await live
        peer.stdout.end()
      }
      const result = await running
      expect(result).toMatchObject({ stopReason: cancelled ? 'cancelled' : 'error', terminate: true })
      if (!cancelled) expect(result.error).toMatch(/Grok Build: .*?(LIVE|stdout)/)
      expect(adapter.alive).toBe(true)
      expect(host.spawns).toEqual([])
    } finally {
      goLive()
      events.emit('exit', 0, null)
      peer.stdout.end()
      peer.stderr.end()
      await new Promise<void>(resolve => setImmediate(resolve))
      await adapter.close()
      peer.stdin.destroy(); peer.stdout.destroy(); peer.stderr.destroy()
      host.dispose()
      rmSync(host.checkout, { recursive: true, force: true })
    }
  })

  it.each(['before replay', 'during replay'] as const)('waits for native cancellation when stopped %s', async timing => {
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
    let goLive!: () => void
    const live = new Promise<void>(resolve => { goLive = resolve })
    let cancelled!: () => void
    const cancellation = new Promise<void>(resolve => { cancelled = resolve })
    const notifications: string[] = []
    let input = ''
    peer.stdin.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8')
      let newline: number
      while ((newline = input.indexOf('\n')) !== -1) {
        const frame = JSON.parse(input.slice(0, newline))
        input = input.slice(newline + 1)
        notifications.push(frame.method)
        if (frame.method === 'session/cancel') {
          expect(frame.params).toEqual({ sessionId: 'native-grok' })
          cancelled()
        }
      }
    })
    const controller = new AbortController()
    if (timing === 'before replay') controller.abort()
    const adapter = createGrokAdapter(host)
    let settled = false
    const running = adapter.replayTurn!({
      turnId: 'recovered-turn', signal: controller.signal, peer: peer as AgentProcess, live,
      outbound: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: { sessionId: 'native-grok', prompt: [] } })}\n`),
      outboundTruncated: false,
      session: { nativeSessionId: 'native-grok', ...MODEL, safeMode: false }, recalledDiffs: new Map(),
    })
    void running.then(() => { settled = true }, () => { settled = true })
    if (timing === 'during replay') controller.abort()
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(notifications).toEqual([])
      goLive()
      await cancellation
      // Cancel is a notification, not an acknowledgement: the native prompt
      // remains able to write until its correlated result arrives.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(notifications).toEqual(['session/cancel'])
      expect(adapter.alive).toBe(true)
      expect(settled).toBe(false)
      peer.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 8, result: { stopReason: 'cancelled' } })}\n`)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      peer.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, result: { stopReason: 'cancelled' } })}\n`)
      await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
      expect(host.spawns).toEqual([])
    } finally {
      goLive()
      peer.kill()
      await new Promise<void>(resolve => setImmediate(resolve))
      await adapter.close()
      peer.stdin.destroy(); peer.stdout.destroy(); peer.stderr.destroy()
      host.dispose()
      rmSync(host.checkout, { recursive: true, force: true })
    }
  })

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
