// The replay host: an AdapterHost wrapper that feeds a reconnecting adapter
// the transcript it already wrote. Replay replays the spooled agent bytes
// through a fresh adapter, which re-derives the same events and requests;
// this wrapper suppresses every emission that is already persisted
// (deduplicated by seq: each replayed emission consumes the first
// unmatched persisted seq with the same match key) and re-attaches
// requests to their persisted ids:
//
// - a request answered before the restart resolves with the recorded
//   answer, so the adapter asks nothing twice;
// - a request still pending is registered under its persisted id, so an
//   answer given afterwards reaches the fresh adapter;
// - an emission or request with no persisted match is new (bytes the
//   previous Poise spooled but never parsed) and flows through normally.
//
// Anything this wrapper cannot match — unknown event types, changed option
// sets — passes through or fails in the open, never silently.

import { canonicalJson, type ChatEnvelope, type ChatEvent, type PermissionOption, type Question } from './protocol'
import type { AdapterHost, PermissionRequest, QuestionAnswers, QuestionRequest } from './adapters/types'

export interface ReplayPending {
  kind: 'permission' | 'question'
  turnId: string
  title: string
  toolId?: string
  options?: PermissionOption[]
  questions?: Question[]
  grantKey?: string
  resolve: (value: any) => void
  reject: (error: Error) => void
}

export interface ReplayHostOptions {
  inner: AdapterHost
  turnId: string
  /** The turn's persisted events after turn.started, in seq order. */
  persisted: ChatEnvelope[]
  /** Register a re-attached request under its persisted id. */
  registerPending: (requestId: string, pending: ReplayPending) => void
  onSuppressed?: (event: ChatEvent) => void
}

/** The id the agent hears for a chosen option: "always" is Poise's memory,
 *  the agent is always told "once". Shared with the runtime's resolver so a
 *  recorded answer maps exactly as it did originally. */
export function onWireOptionId(options: PermissionOption[], chosenId: string): string {
  const option = options.find((o) => o.id === chosenId)
  if (!option) throw new Error(`unknown option ${chosenId}`)
  if (option.kind === 'allow_always' || option.kind === 'reject_always') {
    const once = options.find((o) => o.kind === (option.kind === 'allow_always' ? 'allow_once' : 'reject_once'))
    if (once) return once.id
  }
  return chosenId
}

/** Stable match key for an adapter-originated event, or null when the event
 *  is runtime-originated or unmatchable. Volatile fields (durations, minted
 *  diff ids) are excluded: a replayed emission matches the persisted event
 *  it re-derives. */
export function replayMatchKey(event: ChatEvent): string | null {
  switch (event.type) {
    case 'text.delta':
    case 'thought.delta':
      return canonicalJson({ type: event.type, turnId: event.turnId, messageId: event.messageId, delta: event.delta })
    case 'tool.started':
      return canonicalJson({ type: event.type, turnId: event.turnId, id: event.id, kind: event.kind, title: event.title, locations: event.locations, input: event.input })
    case 'tool.updated':
      return canonicalJson({ type: event.type, turnId: event.turnId, id: event.id, kind: event.kind, title: event.title, status: event.status, content: event.content, locations: event.locations })
    case 'tool.finished':
      return canonicalJson({ type: event.type, turnId: event.turnId, id: event.id, status: event.status, content: event.content })
    case 'diff':
      return canonicalJson({ type: event.type, turnId: event.turnId, toolId: event.toolId, path: event.path, oldText: event.oldText, newText: event.newText, oldExists: event.oldExists, newExists: event.newExists })
    case 'plan.updated':
      return canonicalJson({ type: event.type, turnId: event.turnId, entries: event.entries, explanation: event.explanation })
    case 'model.updated':
      return canonicalJson({ type: event.type, model: event.model, modelId: event.modelId, effort: event.effort, efforts: event.efforts })
    case 'commands.updated':
      return canonicalJson({ type: event.type, commands: event.commands })
    case 'mode.updated':
      return canonicalJson({ type: event.type, mode: event.mode, modes: event.modes })
    case 'error':
      return canonicalJson({ type: event.type, message: event.message, recoverable: event.recoverable })
    default:
      return null
  }
}

function requestKey(turnId: string, event: Extract<ChatEvent, { type: 'permission.requested' | 'question.asked' }>): string {
  return event.type === 'permission.requested'
    ? canonicalJson({ type: event.type, turnId, toolId: event.toolId, title: event.title, description: event.description, input: event.input, options: event.options })
    : canonicalJson({ type: event.type, turnId, toolId: event.toolId, questions: event.questions })
}

/** The turn's persisted diffs by `${toolId}\0${path}`: replay replays them
 *  verbatim instead of re-reading a disk the agent kept writing. */
export function recalledDiffs(events: ChatEvent[], turnId: string): Map<string, { oldText: string, newText: string, oldExists: boolean, newExists: boolean }> {
  const recalled = new Map<string, { oldText: string, newText: string, oldExists: boolean, newExists: boolean }>()
  for (const event of events) {
    if (event.type !== 'diff' || event.turnId !== turnId) continue
    recalled.set(`${event.toolId}\0${event.path}`, { oldText: event.oldText, newText: event.newText, oldExists: event.oldExists, newExists: event.newExists })
  }
  return recalled
}

export function createReplayHost(options: ReplayHostOptions): AdapterHost {
  const { inner, turnId, persisted } = options
  // Multiset over the persisted turn events: each replayed emission consumes
  // the first unmatched persisted seq with the same key. Order-free on
  // purpose — async emissions (completions awaiting snapshots) interleave
  // differently on every run, so a cursor would strand events behind it.
  // Anything unmatched is new (bytes the previous Poise never parsed) and
  // flows through.
  const matched = new Array<boolean>(persisted.length).fill(false)
  const matchedKeys = persisted.map((envelope) => replayMatchKey(envelope.event))
  const matchedRequests = new Set<string>()

  const emit = (event: ChatEvent): void => {
    const key = replayMatchKey(event)
    if (key !== null) {
      for (let index = 0; index < persisted.length; index++) {
        if (!matched[index] && matchedKeys[index] === key) {
          matched[index] = true
          options.onSuppressed?.(event)
          return
        }
      }
    }
    inner.emit(event)
  }

  const findRequested = (key: string): Extract<ChatEvent, { type: 'permission.requested' | 'question.asked' }> | null => {
    for (const envelope of persisted) {
      const event = envelope.event
      if ((event.type === 'permission.requested' || event.type === 'question.asked')
        && !matchedRequests.has(event.id) && requestKey(turnId, event) === key) {
        return event
      }
    }
    return null
  }

  const findResolution = (requestId: string): Extract<ChatEvent, { type: 'permission.resolved' | 'question.answered' }> | null => {
    for (const envelope of persisted) {
      const event = envelope.event
      if ((event.type === 'permission.resolved' || event.type === 'question.answered') && event.id === requestId) return event
    }
    return null
  }

  const requestPermission = (request: PermissionRequest): Promise<string> => {
    const key = canonicalJson({ type: 'permission.requested', turnId, toolId: request.toolId, title: request.title, description: request.description, input: request.input, options: request.options })
    const requested = findRequested(key)
    if (!requested || requested.type !== 'permission.requested') return inner.requestPermission(request)
    matchedRequests.add(requested.id)
    const resolved = findResolution(requested.id)
    if (resolved?.type === 'permission.resolved' && resolved.optionId) {
      return Promise.resolve(onWireOptionId(request.options, resolved.optionId))
    }
    if (resolved) return Promise.reject(new Error('permission is no longer pending'))
    const grantKey = `${request.title}\0${canonicalJson(request.input)}`
    return new Promise<string>((resolve, reject) => {
      options.registerPending(requested.id, { kind: 'permission', turnId, title: request.title, toolId: request.toolId, options: request.options, grantKey, resolve, reject })
    })
  }

  const askQuestion = (request: QuestionRequest): Promise<QuestionAnswers> => {
    const key = canonicalJson({ type: 'question.asked', turnId, toolId: request.toolId, questions: request.questions })
    const asked = findRequested(key)
    if (!asked || asked.type !== 'question.asked') return inner.askQuestion(request)
    matchedRequests.add(asked.id)
    const answered = findResolution(asked.id)
    if (answered?.type === 'question.answered' && answered.by !== 'cancelled') {
      return Promise.resolve({ ...answered.answers })
    }
    if (answered) return Promise.reject(new Error('this question is no longer pending'))
    return new Promise<QuestionAnswers>((resolve, reject) => {
      options.registerPending(asked.id, { kind: 'question', turnId, title: '', toolId: request.toolId, questions: request.questions, resolve, reject })
    })
  }

  return {
    sessionId: inner.sessionId,
    checkout: inner.checkout,
    spawn: inner.spawn,
    emit,
    requestPermission,
    askQuestion,
    readTextFile: inner.readTextFile,
    writeTextFile: inner.writeTextFile,
    log: inner.log,
  }
}
