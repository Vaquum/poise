// Drives a real adapter against a scripted agent binary under a real relay,
// with a simulated Poise restart in the middle: the first half runs on one
// adapter, the peer detaches (relay and agent keep running), and a fresh
// adapter replays the turn and continues it live. The transcript of a
// replayed turn must equal the transcript of the same turn run straight
// through, modulo volatile fields.

import { expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import type { Adapter, AdapterHost, PermissionRequest, QuestionAnswers, QuestionRequest, TurnResult } from '../../server/chat/adapters/types'
import type { ChatEnvelope, ChatEvent } from '../../server/chat/protocol'
import { attachRelay, livePromise, spawnRelay, type RelayConnection } from '../../server/chat/relay'
import { createReplayHost, recalledDiffs } from '../../server/chat/replay'
import { FIXTURES, prompt as makePrompt, sleep } from './adapter-harness'

export const prompt = makePrompt

export interface Gate<TRequest, TAnswer> {
  /** The persisted id for a replayed request, minted for a new one. */
  id: string
  request: TRequest
  resolve: (answer: TAnswer) => void
  reject: (error: Error) => void
}

/** One transcript shared by the pre- and post-restart hosts. Answering a
 *  gate publishes the resolution the runtime would publish, so replayed and
 *  uninterrupted transcripts compare end to end. */
export class RelayTranscript {
  events: ChatEvent[] = []
  suppressed = 0
  turnId = 'turn-1'
  permissionGates: Array<Gate<PermissionRequest, string>> = []
  questionGates: Array<Gate<QuestionRequest, QuestionAnswers>> = []
  private gateWaiters: Array<() => void> = []

  /** Resolve when gate `index` of the kind exists; answers land in stream
   *  order instead of behind a poll delay that replay would run past. */
  waitForGate(kind: 'permission' | 'question', index: number, timeoutMs = 5_000): Promise<void> {
    const gates = kind === 'permission' ? this.permissionGates : this.questionGates
    if (gates.length > index) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.gateWaiters.splice(this.gateWaiters.indexOf(check), 1)
        reject(new Error(`${kind} gate ${index} never opened`))
      }, timeoutMs)
      const check = () => {
        if (gates.length > index) {
          clearTimeout(timer)
          this.gateWaiters.splice(this.gateWaiters.indexOf(check), 1)
          resolve()
        }
      }
      this.gateWaiters.push(check)
    })
  }

  private gateOpened(): void {
    for (const check of [...this.gateWaiters]) check()
  }

  /** The transcript from `index` on: replay matches only what the spool
   *  could have produced, like the runtime's turn slice. Pre-turn
   *  handshake events stay out of the match pool. */
  persistedFrom(index: number): ChatEnvelope[] {
    const at = new Date().toISOString()
    return this.events.slice(index).map((event, order) => ({ seq: order + 2, sessionId: 'relay-session', at, event }))
  }

  askPermission(request: PermissionRequest, id: string = randomUUID(), publish = true): Promise<string> {
    // Mirrors the runtime: the request is published synchronously, the
    // resolution when the answer arrives. Replayed requests are already
    // published, so only their answers are recorded.
    if (publish) this.events.push({ type: 'permission.requested', id, turnId: this.turnId, toolId: request.toolId, title: request.title, description: request.description, input: request.input, options: request.options })
    return new Promise<string>((resolve, reject) => {
      this.permissionGates.push({
        id,
        request,
        resolve: (optionId) => {
          this.events.push({ type: 'permission.resolved', id, optionId, by: 'user' })
          resolve(optionId)
        },
        reject,
      })
      this.gateOpened()
    })
  }

  askQuestion(request: QuestionRequest, id: string = randomUUID(), publish = true): Promise<QuestionAnswers> {
    if (publish) this.events.push({ type: 'question.asked', id, turnId: this.turnId, toolId: request.toolId, questions: request.questions })
    return new Promise<QuestionAnswers>((resolve, reject) => {
      this.questionGates.push({
        id,
        request,
        resolve: (answers) => {
          this.events.push({ type: 'question.answered', id, answers, by: 'user' })
          resolve(answers)
        },
        reject,
      })
      this.gateOpened()
    })
  }

  /** The restart orphans the old adapter's gates like the old adapter. */
  clearGates(): void {
    this.permissionGates.splice(0)
    this.questionGates.splice(0)
  }
}

export interface RelayTurn {
  events: ChatEvent[]
  suppressed: number
  result: TurnResult
}

let sessionCounter = 0

export type RelayInput = Parameters<Adapter['prompt']>[1] | ((checkout: string) => Parameters<Adapter['prompt']>[1])

/** Run one uninterrupted turn for the baseline: no restart, same gates. */
export async function runBaselineTurn(options: {
  script: string
  argv?: string[]
  createAdapter: (host: AdapterHost) => Adapter
  start: Parameters<Adapter['start']>[0]
  input: RelayInput
  turnId?: string
  answer: (transcript: RelayTranscript) => Promise<void>
}): Promise<RelayTurn> {
  const turnId = options.turnId ?? 'turn-1'
  const checkout = mkdtempSync(join(tmpdir(), 'poise-relay-checkout-'))
  seedCheckout(checkout)
  const input = typeof options.input === 'function' ? options.input(checkout) : options.input
  const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
  const transcript = new RelayTranscript()
  sessionCounter += 1
  const peer = await spawnRelay({
    sessionId: `relay-baseline-${sessionCounter}`, dir,
    command: process.execPath, args: [join(FIXTURES, options.script), ...(options.argv ?? [])],
    env: { ...process.env }, cwd: checkout,
  })
  try {
    await peer.go()
    const host = relayHost(transcript, checkout, peer)
    const adapter = options.createAdapter(host)
    await adapter.start(options.start)
    peer.turnStart(turnId)
    const result = adapter.prompt(turnId, input, new AbortController().signal)
    await options.answer(transcript)
    const outcome = await result
    peer.turnFinish()
    return { events: [...transcript.events], suppressed: 0, result: outcome }
  } finally {
    await peer.shutdown().catch(() => {})
    peer.detach()
  }
}

/** Run a turn that restarts mid-stream: `interrupt` runs while the turn is
 *  open (typically after a gate fills), then a fresh adapter replays and
 *  continues the same turn. */
export async function runReplayedTurn(options: {
  script: string
  argv?: string[]
  createAdapter: (host: AdapterHost) => Adapter
  start: Parameters<Adapter['start']>[0]
  input: RelayInput
  turnId?: string
  interrupt: (transcript: RelayTranscript) => Promise<void>
  answer: (transcript: RelayTranscript) => Promise<void>
}): Promise<RelayTurn> {
  const turnId = options.turnId ?? 'turn-1'
  const checkout = mkdtempSync(join(tmpdir(), 'poise-relay-checkout-'))
  seedCheckout(checkout)
  const input = typeof options.input === 'function' ? options.input(checkout) : options.input
  const dir = mkdtempSync(join(tmpdir(), 'poise-relay-'))
  const socketPath = join(dir, 'r.sock')
  const transcript = new RelayTranscript()
  sessionCounter += 1
  const sessionId = `relay-replay-${sessionCounter}`
  const first = await spawnRelay({
    sessionId, dir, socketPath,
    command: process.execPath, args: [join(FIXTURES, options.script), ...(options.argv ?? [])],
    env: { ...process.env }, cwd: checkout,
  })
  try {
    await first.go()
    const adapter = options.createAdapter(relayHost(transcript, checkout, first))
    const startResult = await adapter.start(options.start)
    first.turnStart(turnId)
    const persistedFrom = transcript.events.length
    const controller = new AbortController()
    const running = adapter.prompt(turnId, input, controller.signal)
    void running.catch(() => {})
    await options.interrupt(transcript)
    // The restart: this Poise drops everything; the relay and agent run on.
    transcript.clearGates()
    first.detach()
    await sleep(50)

    const { connection: second } = await attachRelay({ sessionId, dir, socketPath, relayPid: first.relayPid, relayIdent: first.ident })
    try {
      const outbound = await second.getOutbound()
      const live = livePromise(second)
      const inner = relayHost(transcript, checkout)
      const replay = createReplayHost({
        inner,
        turnId,
        persisted: transcript.persistedFrom(persistedFrom),
        registerPending: (requestId, pending) => {
          if (pending.kind === 'permission') void transcript.askPermission({ title: pending.title, toolId: pending.toolId, options: pending.options ?? [] }, requestId, false).then(pending.resolve, pending.reject)
          else void transcript.askQuestion({ toolId: pending.toolId, questions: pending.questions ?? [] }, requestId, false).then(pending.resolve, pending.reject)
        },
        onSuppressed: () => { transcript.suppressed += 1 },
      })
      const resumed = options.createAdapter(replay)
      const result = resumed.replayTurn!({
        turnId,
        signal: controller.signal,
        peer: second,
        live,
        outbound: outbound.bytes,
        outboundTruncated: outbound.truncated,
        session: {
          nativeSessionId: startResult.nativeSessionId,
          modelId: startResult.modelId,
          effort: startResult.effort,
          mode: startResult.mode,
          safeMode: options.start.safeMode === true,
          efforts: startResult.efforts,
          commands: startResult.commands,
        },
        recalledDiffs: recalledDiffs(transcript.events, turnId),
      })
      await options.answer(transcript)
      const outcome = await result
      second.turnFinish()
      return { events: [...transcript.events], suppressed: transcript.suppressed, result: outcome }
    } finally {
      await second.shutdown().catch(() => {})
      second.detach()
    }
  } finally {
    // The second handle owns the relay now; never shut down after a detach.
    first.detach()
  }
}

function relayHost(transcript: RelayTranscript, checkout: string, peer?: RelayConnection): AdapterHost {
  let spawned = false
  return {
    sessionId: 'relay-session',
    checkout,
    spawn: async () => {
      if (!peer || spawned) throw new Error('relay tests spawn once, through the harness')
      spawned = true
      return peer
    },
    emit: (event) => { transcript.events.push(event) },
    requestPermission: (request) => transcript.askPermission(request),
    askQuestion: (request) => transcript.askQuestion(request),
    readTextFile: async (path) => {
      const absolute = isAbsolute(path) ? path : join(checkout, path)
      if (absolute !== checkout && !absolute.startsWith(checkout + sep)) throw new Error(`path outside the checkout: ${path}`)
      return readFile(absolute, 'utf8')
    },
    writeTextFile: async () => {},
    log: () => {},
  }
}

/** The files the scripted turns edit, so snapshots and diffs are genuine. */
function seedCheckout(checkout: string): void {
  writeFileSync(join(checkout, 'README.md'), 'old\n')
  writeFileSync(join(checkout, 'GONE.md'), 'bye\n')
  writeFileSync(join(checkout, 'BIG.md'), 'big\n')
  writeFileSync(join(checkout, 'WEIRD.md'), 'weird\n')
}

/** Wait for a gate, then answer it. */
export async function answerPermission(transcript: RelayTranscript, index: number, optionId: string, timeoutMs = 5_000): Promise<void> {
  await transcript.waitForGate('permission', index, timeoutMs)
  transcript.permissionGates[index].resolve(optionId)
}

export async function answerQuestion(transcript: RelayTranscript, index: number, answers: QuestionAnswers, timeoutMs = 5_000): Promise<void> {
  await transcript.waitForGate('question', index, timeoutMs)
  transcript.questionGates[index].resolve(answers)
}

export async function waitForEvent(transcript: RelayTranscript, predicate: (event: ChatEvent) => boolean, timeoutMs = 5_000): Promise<ChatEvent> {
  const started = Date.now()
  for (;;) {
    const found = transcript.events.find(predicate)
    if (found) return found
    if (Date.now() - started > timeoutMs) throw new Error(`no matching event within ${timeoutMs}ms; saw ${transcript.events.map((event) => event.type).join(', ')}`)
    await sleep(10)
  }
}

/** A replayed turn carries the same transcript as the uninterrupted one:
 *  the same multiset of events (every event exactly once), and the
 *  synchronous agent stream in the same order. Four kinds already
 *  interleave freely between two uninterrupted runs, so their order is
 *  not compared: async completions (tool finishes and diffs, which await
 *  file snapshots), request cards (RPC dispatch floats them across chunk
 *  boundaries), and resolutions (the person's own actions, which a
 *  restart legitimately moves later in the stream). */
export function assertSameTranscript(replayed: ChatEvent[], baseline: ChatEvent[]): void {
  const left = normalize(replayed)
  const right = normalize(baseline)
  const byJson = (x: unknown, y: unknown): number => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)
  expect([...left].sort(byJson)).toEqual([...right].sort(byJson))
  const sync = (event: unknown): boolean => {
    const type = (event as { type?: string }).type
    return type !== 'tool.finished' && type !== 'diff'
      && type !== 'permission.requested' && type !== 'question.asked'
      && type !== 'permission.resolved' && type !== 'question.answered'
  }
  expect(left.filter(sync)).toEqual(right.filter(sync))
}

/** The transcript with volatile fields normalized for replay comparison:
 *  durations, minted diff ids, the per-run checkout directory, and request
 *  ids (minted per run, but stable within a run — which is exactly what
 *  replay must preserve). */
export function normalize(events: ChatEvent[]): unknown[] {
  const ids = new Map<string, string>()
  const at = (id: string): string => {
    let mapped = ids.get(id)
    if (!mapped) {
      mapped = `req-${ids.size + 1}`
      ids.set(id, mapped)
    }
    return mapped
  }
  return events.map((event) => {
    const copy = JSON.parse(JSON.stringify(event).replace(/[^"'\s]*poise-relay-checkout-[^/"'\s]+\//g, '<checkout>/')) as Record<string, unknown>
    if (typeof copy.durationMs === 'number') copy.durationMs = 0
    if (typeof copy.diffId === 'string') copy.diffId = '*'
    if ((copy.type === 'permission.requested' || copy.type === 'question.asked'
      || copy.type === 'permission.resolved' || copy.type === 'question.answered') && typeof copy.id === 'string') {
      copy.id = at(copy.id)
    }
    return copy
  })
}
