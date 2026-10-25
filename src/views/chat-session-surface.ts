// One subject's Chat session: the shared transcript and composer factories,
// folded with the shared applyEvent, on the shared chatClient. The Chat view
// keeps its own session state; this surface keeps one record and one model.
//
// Opening resolves the subject's session but never creates it. The first
// send or attach creates it with the subject, then sends.
import { chatClient, ChatHttpError, type AgentsResponse } from '../chat-client'
import { consoleModelLabel } from '../chat-catalog'
import { commandDraftText } from '../chat-command-draft'
import { recoverDraft } from '../chat-draft-recovery'
import type {
  AgentId,
  ChatEnvelope,
  ChatSubject,
  EditDecision,
  NewSessionRequest,
  SessionRecord,
} from '../../server/chat/protocol'
import type { EditProposal } from '../edit-proposals'
import { parseChatCommandChain } from '../../server/chat/commands'
import { createComposer, emptyDraft, type Composer, type ComposerDraft } from './chat-composer'
import { createModel, applyEvent, addOptimisticTurn, dropOptimisticTurns, createTranscriptView, renderImportedHtml, type TranscriptModel } from './chat-transcript'
import { createQueuePanel } from './chat-queue'

export interface SurfaceOptions {
  subject: ChatSubject
  prefill?: string
  draft?: ComposerDraft
  /** Runs before an Editor surface sends, so the saved body the agent reads
   *  is what the person sees. A throw aborts the send with the draft kept. */
  beforeSend?: () => Promise<void>
  /** Edit-card wiring for Editor surfaces: hover highlights the target,
   *  accept applies the edit and saves before the decision is recorded. */
  edits?: {
    hover(edit: EditProposal): void
    leave(): void
    accept(edit: EditProposal): Promise<'applied' | 'conflict' | 'failed'>
  }
}

export interface SessionSurface {
  session(): string | null
  focus(): void
  takeDraft(): ComposerDraft | null
  destroy(): void
  setHighlight(text: string | null): void
  /** Highest event seq applied, for resubscribing without a replay. */
  lastSeq(): number
  pendingRequests(): string[]
}

interface EditRetry {
  turnId: string
  messageId: string
  index: number
  decision: EditDecision
  edit?: EditProposal
  error: string
}

interface SavedEdit {
  turnId: string
  messageId: string
  index: number
  afterSeq: number
  operationId: string
}

interface EditState {
  deciding: Set<string>
  applied: Set<string>
  confirmed: Set<string>
  baselines: Map<string, number>
  saved: Map<string, SavedEdit>
  storagePrefix: string | null
  persisted: Map<string, SavedEdit>
  storageError: string | null
  retries: Map<string, EditRetry>
  listeners: Set<(key?: string, decision?: EditDecision) => void>
  revision: number
}

// A saved edit awaiting its decision acknowledgement must survive surface
// teardown. Session + turn/message/index identify it until the server records it.
const pendingEdits = new Map<string, EditState>()

function newEditState(): EditState {
  return { deciding: new Set(), applied: new Set(), confirmed: new Set(), baselines: new Map(), saved: new Map(),
    storagePrefix: null, persisted: new Map(), storageError: null, retries: new Map(), listeners: new Set(), revision: 0 }
}

// localStorage is origin-scoped; the instance and session namespace prevents
// another workspace from consuming the marker. Only card identity/cursor is
// retained, never document text or the proposed edit.
function restoreEditState(session: SessionRecord, state: EditState = pendingEdits.get(session.id) ?? newEditState()): EditState {
  state.storagePrefix = `poise:editor-applied:v2:${encodeURIComponent(session.instance)}:${encodeURIComponent(session.id)}:`
  for (const storageKey of Object.keys(localStorage)) {
    if (!storageKey.startsWith(state.storagePrefix)) continue
    const raw = localStorage.getItem(storageKey)
    if (raw === null) continue // Another tab acknowledged this marker.
    const identity: unknown = JSON.parse(decodeURIComponent(storageKey.slice(state.storagePrefix.length)))
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(identity) || identity.length !== 3 || typeof identity[0] !== 'string' || typeof identity[1] !== 'string'
      || typeof identity[2] !== 'number' || !Number.isSafeInteger(identity[2]) || identity[2] < 0
      || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved edit recovery identity is invalid')
    const item = value as Record<string, unknown>
    if (typeof item.afterSeq !== 'number' || !Number.isSafeInteger(item.afterSeq) || item.afterSeq < 0
      || typeof item.operationId !== 'string' || !item.operationId) throw new Error('Saved edit recovery cursor is invalid')
    const marker: SavedEdit = { turnId: identity[0], messageId: identity[1], index: identity[2], afterSeq: item.afterSeq, operationId: item.operationId }
    const key = `${marker.turnId}:${marker.messageId}:${marker.index}`
    if (state.deciding.has(key) || state.saved.has(key)) continue
    state.applied.add(key)
    state.baselines.set(key, marker.afterSeq)
    state.saved.set(key, marker)
    state.persisted.set(key, marker)
    state.retries.set(key, { ...marker, decision: 'applied', error: 'The saved edit decision has not been acknowledged' })
  }
  return state
}

function persistEditState(state: EditState): void {
  if (!state.storagePrefix) return
  const storageKey = (marker: SavedEdit) => `${state.storagePrefix}${encodeURIComponent(JSON.stringify([marker.turnId, marker.messageId, marker.index]))}`
  const value = (marker: SavedEdit) => JSON.stringify({ afterSeq: marker.afterSeq, operationId: marker.operationId })
  try {
    for (const [key, marker] of state.saved) {
      if (state.persisted.get(key)?.operationId === marker.operationId) continue
      const raw = value(marker)
      localStorage.setItem(storageKey(marker), raw)
      if (localStorage.getItem(storageKey(marker)) !== raw) throw new Error('Recovery marker write was not retained')
      state.persisted.set(key, marker)
    }
    for (const [key, marker] of state.persisted) {
      if (state.saved.has(key)) continue
      // Never remove another tab's newer operation or a different card.
      if (localStorage.getItem(storageKey(marker)) === value(marker)) localStorage.removeItem(storageKey(marker))
      state.persisted.delete(key)
    }
    state.storageError = null
  } catch (error) {
    state.storageError = `Edit recovery could not be saved — ${(error as Error).message}. Keep this page open until the decision is recorded.`
  }
}

interface ModelPlaceAnswer {
  places: Array<{ key: string, model?: string }>
  catalog: { models: Array<{ identity: string, provider: string }> }
}

function isRunning(status: string): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping' || status === 'queued'
}

/** Commands the surface does not run, with the note it shows for each. */
function refusedCommand(text: string): string | null {
  const chain = parseChatCommandChain(text)
  if (chain.create) return 'create'
  const head = /^\/(queue\s+)?(create|mode|fork|poise)(?:\s|$)/i.exec(chain.text)
  return head ? head[2].toLowerCase() : null
}

export function mountSessionSurface(container: HTMLElement, options: SurfaceOptions): SessionSurface {
  const subject = options.subject
  let record: SessionRecord | null = null
  let model: TranscriptModel = createModel()
  let creating: Promise<SessionRecord> | null = null
  let destroyed = false
  let pendingModel: string | null = null
  let agents: AgentsResponse | null = null
  /** Text highlighted in the document, sent as a quote with the next message. */
  let highlight: string | null = null
  let editState = newEditState()

  container.classList.add('chat-surface')
  container.innerHTML = '<div class="chat-surface-notice" hidden></div>'
    + '<div class="chat-surface-earlier" hidden></div>'
    + '<div class="chat-surface-transcript"></div>'
    + '<div class="chat-surface-queue"></div>'
    + '<div class="chat-surface-highlight" hidden></div>'
    + '<div class="chat-surface-composer"></div>'
  const noticeEl = container.querySelector<HTMLElement>('.chat-surface-notice')!
  const earlierEl = container.querySelector<HTMLElement>('.chat-surface-earlier')!
  const transcriptEl = container.querySelector<HTMLElement>('.chat-surface-transcript')!
  const queueEl = container.querySelector<HTMLElement>('.chat-surface-queue')!
  const highlightEl = container.querySelector<HTMLElement>('.chat-surface-highlight')!
  const composerEl = container.querySelector<HTMLElement>('.chat-surface-composer')!

  const transcript = createTranscriptView(transcriptEl, {
    onPermission: (id, optionId) => { if (record) void chatClient.send({ type: 'permission.respond', sessionId: record.id, id, optionId }).catch((err) => setNotice(`Permission failed — ${(err as Error).message}`)) },
    onQuestion: (id, answers) => { if (record) void chatClient.send({ type: 'question.answer', sessionId: record.id, id, answers }).catch((err) => setNotice(`Answer failed — ${(err as Error).message}`)) },
    onRevert: () => { setNotice('Open in Chat to revert this diff.') },
    onFile: () => { setNotice('Open in Chat to preview files.') },
    onEditDecide: (turnId, messageId, index, decision, edit) => { void decideEdit(turnId, messageId, index, decision, edit) },
    onEditHover: (edit) => { options.edits?.hover(edit) },
    onEditLeave: () => { options.edits?.leave() },
    onSuggestedReply: (text) => {
      container.dispatchEvent(new CustomEvent('chat:use-suggested-reply', { bubbles: true, detail: { subject, text } }))
    },
  })
  transcriptEl.addEventListener('chat:rerender', render)

  const composer: Composer = createComposer({
    history: () => ({ entries: [], loading: false }),
    loadModels: async () => (await loadAgents()).agents,
    onModelSelect: (identity) => {
      if (record) void setSessionModel(identity)
      else { pendingModel = identity; composerState() }
    },
    onSend: (draft) => { void sendPrompt(draft) },
    onQueue: (draft) => { void queuePrompt(draft) },
    onSteer: (draft) => { void steer(draft) },
    onStop: () => { void stop() },
    onResume: () => { void resume() },
    onCommand: (name, arg) => { void runCommand(name, arg) },
    prepareUpload: async () => (await ensureSession()).id,
    upload: async (file, sessionId) => chatClient.uploadAttachment(sessionId, file),
    searchFiles: async () => [],
  }, { idPrefix: 'pane-' })
  composer.setCommands([], { model: true, modes: false, fork: false, poise: false, create: false })
  composerEl.append(composer.el)

  const queuePanel = createQueuePanel({
    onModel: (id, itemId, model) => { void changeQueueItem(id, itemId, model) },
    onRemove: (id, itemId) => { void changeQueueItem(id, itemId) },
  })
  queueEl.append(queuePanel.el)

  const tickTimer = setInterval(() => { transcript.tick() }, 1000)

  if (options.draft && (options.draft.text || options.draft.attachments.length)) composer.setDraft(options.draft)
  else if (options.prefill) composer.setDraft({ ...emptyDraft(), text: options.prefill })
  composerState()
  void resolve()

  function setNotice(text: string | null, actions?: Array<{ label: string, run: () => void }>): void {
    if (!text) { noticeEl.hidden = true; noticeEl.innerHTML = ''; return }
    noticeEl.hidden = false
    noticeEl.innerHTML = ''
    noticeEl.append(document.createTextNode(text))
    for (const action of actions || []) {
      noticeEl.append(document.createTextNode(' '))
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'st-clear'
      button.textContent = action.label
      button.addEventListener('click', () => action.run())
      noticeEl.append(button)
    }
  }

  function state(): void {
    container.dispatchEvent(new CustomEvent('chat:surface-state', { bubbles: true, detail: { sessionId: record?.id ?? null, status: record?.status ?? null } }))
  }

  function renderHighlight(): void {
    if (!highlight) { highlightEl.hidden = true; highlightEl.innerHTML = ''; return }
    highlightEl.hidden = false
    highlightEl.innerHTML = ''
    const flat = highlight.replace(/\s+/g, ' ').trim()
    const excerpt = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
    const label = document.createElement('span')
    label.textContent = `Highlighted · “${excerpt}”`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'chat-surface-highlight-remove'
    remove.setAttribute('aria-label', 'Remove highlight')
    remove.textContent = '×'
    remove.addEventListener('click', () => setHighlight(null))
    highlightEl.append(label, remove)
  }

  function setHighlight(text: string | null): void {
    highlight = text
    renderHighlight()
  }

  /** The highlight travels as a quote at the start of the message text, so
   *  prompts, steers and queued messages carry it unchanged, it shows in the
   *  person's bubble in every surface, and it survives a reload. */
  function withHighlight(text: string): string {
    if (!highlight) return text
    const quote = highlight.split('\n').map((line) => `> ${line}`).join('\n')
    // The runtime only parses a command at the very start of the prompt,
    // so a command keeps the head and the quote follows it.
    if (text.startsWith('/')) return `${text}\n\n${quote}`
    return `${quote}\n\n${text}`
  }

  function showEditRetry(): void {
    const pending = [...editState.retries].find(([key]) => !editState.deciding.has(key))
    if (pending) {
      const [key, retry] = pending
      setNotice(`Decision failed — ${retry.error}${editState.storageError ? `. ${editState.storageError}` : ''}`, [{ label: 'Retry', run: () => {
        if (editState.retries.get(key) !== retry) return
        void decideEdit(retry.turnId, retry.messageId, retry.index, retry.decision, retry.edit)
      } }])
    } else if (editState.storageError) setNotice(editState.storageError)
  }

  function editStateChanged(key?: string, decision?: EditDecision): void {
    if (key && decision) { model.decisions.set(key, decision); setNotice(null) }
    render()
    showEditRetry()
  }

  function notifyEditState(state: EditState, sessionId: string, key?: string, decision?: EditDecision): void {
    persistEditState(state)
    state.revision++
    for (const listener of state.listeners) listener(key, decision)
    if (!state.deciding.size && !state.applied.size && !state.retries.size) pendingEdits.delete(sessionId)
  }

  async function decideEdit(turnId: string, messageId: string, index: number, decision: EditDecision, edit?: EditProposal): Promise<void> {
    if (!record || !options.edits) return
    const sessionId = record.id
    const key = `${turnId}:${messageId}:${index}`
    const state = editState
    if (state.deciding.has(key)) return
    try {
      // Another tab can save after this surface mounts, before its decision.
      restoreEditState(record, state)
    } catch (error) {
      setNotice(`Saved edit recovery could not be read — ${(error as Error).message}`)
      return
    }
    state.deciding.add(key)
    if (!state.applied.has(key)) state.baselines.set(key, seenSeq)
    pendingEdits.set(sessionId, state)
    notifyEditState(state, sessionId)
    try {
      // Saving and recording the decision are separate operations. Once the
      // document was saved, a retry only records it, even for pure insertions.
      if (state.applied.has(key)) decision = 'applied'
      else if (decision === 'applied') {
        if (!edit) { setNotice('The edit proposal is unavailable. Reopen this chat before accepting it.'); return }
        let outcome: 'applied' | 'conflict' | 'failed'
        try {
          outcome = await options.edits.accept(edit)
        } catch (err) {
          setNotice(`Accept failed — ${(err as Error).message}`)
          return
        }
        // A failed save records nothing; the Editor showed the save error.
        if (outcome === 'failed') return
        decision = outcome
        if (outcome === 'applied') {
          state.applied.add(key)
          state.saved.set(key, { turnId, messageId, index, afterSeq: state.baselines.get(key)!, operationId: crypto.randomUUID() })
          state.retries.set(key, { turnId, messageId, index, decision, edit, error: 'The saved edit decision has not been acknowledged' })
          notifyEditState(state, sessionId)
        }
      }
      try {
        await chatClient.send({ type: 'edit.decide', sessionId, turnId, messageId, index, decision })
        state.applied.delete(key)
        state.saved.delete(key)
        state.baselines.delete(key)
        state.retries.delete(key)
        notifyEditState(state, sessionId, key, decision)
        setNotice(null)
      } catch (err) {
        // The decision event can arrive before a lost acknowledgement fails.
        // Authoritative live or replayed history wins over that uncertainty.
        if (!state.confirmed.has(key)) state.retries.set(key, { turnId, messageId, index, decision, edit, error: (err as Error).message })
      }
    } finally {
      state.deciding.delete(key)
      state.confirmed.delete(key)
      notifyEditState(state, sessionId)
    }
  }

  function composerState(): void {
    const status = record?.status
    const closed = status === 'closed'
    const failed = status === 'error' || status === 'interrupted'
    composer.setState({
      running: !!record && isRunning(record.status),
      disabled: !!creating || closed || failed,
      placeholder: creating ? 'Starting the session…' : closed ? 'This session is closed' : failed ? 'Resume to continue, or /reset to start fresh' : undefined,
      resume: closed || failed,
      sessionId: record?.id ?? null,
      ...(pendingModel && !record ? { modelIdentity: pendingModel, modelLabel: consoleModelLabel(pendingModel) } : {}),
    })
  }

  function render(): void {
    if (destroyed) return
    transcript.render(model, {
      running: !!record && isRunning(record.status),
      sessionId: record?.id,
      ...(subject.surface === 'current' ? {} : { edits: { surface: subject.surface, readOnly: false, deciding: editState.deciding, applied: editState.applied, revision: editState.revision } }),
    })
    composer.setCommands(record?.commands || [], { model: true, modes: false, fork: false, poise: false, create: false })
    queuePanel.render(record?.id ?? null, record?.queue, agents?.agents || [], !!record && isRunning(record.status), new Set())
    composerState()
    transcriptEl.scrollTop = transcriptEl.scrollHeight
  }

  async function loadAgents(): Promise<AgentsResponse> {
    if (!agents) agents = await chatClient.agents()
    return agents
  }

  async function placeDefault(): Promise<{ agent: AgentId, model: string }> {
    const answer = await (await fetch('/api/models', { cache: 'no-store' })).json() as ModelPlaceAnswer
    const place = subject.surface === 'current' ? 'chat' : 'editor'
    const identity = answer.places.find((row) => row.key === place)?.model
    if (!identity) throw new Error(`${place === 'chat' ? 'Chat' : 'Editor chat'} has no default model. Choose one in the console.`)
    const provider = answer.catalog.models.find((row) => row.identity === identity)?.provider
    return { agent: (provider || 'grok') as AgentId, model: identity }
  }

  function agentForIdentity(identity: string): AgentId {
    const found = agents?.agents.find((agent) => agent.models.some((row) => row.identity === identity))
    return (found?.id || 'grok') as AgentId
  }

  async function resolve(): Promise<void> {
    try {
      const found = await chatClient.sessionForSubject(subject)
      if (destroyed) return
      if (found) { await adopt(found); return }
      try {
        const place = await placeDefault()
        if (!destroyed && !record) { pendingModel = place.model; composerState() }
      } catch (err) {
        if (!destroyed) setNotice(`Could not load the default model — ${(err as Error).message}`)
      }
      const conversation = await chatClient.legacyConversation(subject).catch(() => null)
      if (destroyed) return
      if (conversation && conversation.turns.length) {
        earlierEl.hidden = false
        earlierEl.innerHTML = renderImportedHtml(conversation.turns, conversation.omitted, true)
      }
      state()
    } catch (err) {
      if (!destroyed) setNotice(`Could not open this chat — ${(err as Error).message}`)
    }
  }

  let seenSeq = 0
  let adopting: ChatEnvelope[] | null = null
  let subscribed: string | null = null
  async function adopt(session: SessionRecord): Promise<void> {
    if (subscribed) { chatClient.unsubscribe(subscribed); subscribed = null }
    const pending: ChatEnvelope[] = []
    adopting = pending
    record = session
    editState.listeners.delete(editStateChanged)
    editState = restoreEditState(session)
    editState.listeners.add(editStateChanged)
    earlierEl.hidden = true
    earlierEl.innerHTML = ''
    transcript.clear()
    model = createModel()
    seenSeq = 0
    // Owners must retain the session even if they close while history loads.
    state()
    try {
      for (let guard = 0; guard < 100; guard++) {
        const page = await chatClient.fetchSession(session.id, seenSeq)
        if (destroyed || adopting !== pending) return
        record = page.session
        for (const envelope of page.events) applyEnvelope(envelope)
        if (!page.truncated || !page.events.length) break
      }
      // Another surface may still subscribe while history loads. Fold those
      // live events after history so they cannot move its paging cursor.
      for (const envelope of pending.sort((a, b) => a.seq - b.seq)) applyEnvelope(envelope)
      chatClient.subscribe(session.id, seenSeq)
      subscribed = session.id
      setNotice(null)
      state()
      render()
      showEditRetry()
    } finally {
      if (adopting === pending) adopting = null
    }
  }

  async function ensureSession(draft?: ComposerDraft, skipLegacy = false): Promise<SessionRecord> {
    if (record) return record
    if (!creating) {
      creating = (async () => {
        const chosen = draft?.model || pendingModel
        let request: NewSessionRequest
        if (chosen) {
          await loadAgents()
          request = { agent: agentForIdentity(chosen), model: chosen, subject }
        } else {
          request = { ...(await placeDefault()), subject }
        }
        if (skipLegacy) request.skipLegacy = true
        if (draft?.text) request.title = draft.text.slice(0, 200)
        composerState()
        try {
          const created = await chatClient.createSession(request)
          await adopt(created.session)
          pendingModel = null
          return created.session
        } finally {
          creating = null
          if (!destroyed) composerState()
        }
      })()
    }
    return creating
  }

  function keepDraft(draft: ComposerDraft): void {
    // The composer clears itself after onSend returns; restore once it has.
    queueMicrotask(() => { if (!destroyed) composer.setDraft(draft) })
  }

  async function sendPrompt(draft: ComposerDraft): Promise<void> {
    const text = commandDraftText({ ...draft, text: draft.text })
    const refused = refusedCommand(text)
    if (refused) { keepDraft(draft); setNotice(`Open in Chat to use /${refused}.`); return }
    if (options.beforeSend) {
      try {
        await options.beforeSend()
      } catch (err) { keepDraft(draft); setNotice((err as Error).message); return }
    }
    const chain = parseChatCommandChain(text)
    if (chain.context === 'reset' && !chain.queue) { await resetThenSend(draft); return }
    if (!record) {
      if (chain.review) { keepDraft(draft); setNotice('There is no reply to review yet.'); return }
      if (chain.context === 'compact' && !chain.text && !draft.attachments.length) { keepDraft(draft); setNotice('No conversation history to compact yet.'); return }
    }
    const first = { ...draft, text, model: draft.model || chain.model }
    try {
      await ensureSession(first)
    } catch (err) { creationFailed(err, draft, () => sendPrompt(draft)); return }
    const session = record!
    const prompt = { text: withHighlight(text), attachments: draft.attachments, mentions: draft.mentions }
    dropOptimisticTurns(model)
    addOptimisticTurn(model, prompt)
    record = { ...session, ...(!session.title ? { title: text.slice(0, 200) } : {}), status: 'running' }
    setNotice(null)
    render()
    try {
      await chatClient.send({ type: 'prompt', sessionId: session.id, ...prompt })
      setHighlight(null)
    } catch (err) {
      dropOptimisticTurns(model)
      if (record?.status === 'running' && !model.running) record = { ...record, status: 'idle' }
      keepDraft(draft)
      setNotice(`Send failed — ${(err as Error).message}`)
      render()
    }
  }

  function creationFailed(err: unknown, draft: ComposerDraft, retry: () => void): void {
    keepDraft(draft)
    if (err instanceof ChatHttpError && err.code === 'legacy_unreadable') {
      setNotice(`The earlier conversation could not be read — ${err.message}.`, [
        { label: 'Retry', run: () => { setNotice(null); retry() } },
        { label: 'Continue without it', run: () => { setNotice(null); void sendWithoutLegacy(draft, retry) } },
      ])
      return
    }
    setNotice(`Could not start the session — ${(err as Error).message}`)
  }

  async function sendWithoutLegacy(draft: ComposerDraft, retry: () => void): Promise<void> {
    try {
      await ensureSession(draft, true)
      retry()
    } catch (err) {
      keepDraft(draft)
      setNotice(`Could not start the session — ${(err as Error).message}`)
    }
  }

  async function resetThenSend(draft: ComposerDraft): Promise<void> {
    const chain = parseChatCommandChain(commandDraftText(draft))
    if (chain.review) { keepDraft(draft); setNotice('A reset removes the reply to review. Review first or start a new task after resetting.'); return }
    let session: SessionRecord
    try {
      session = await ensureSession(draft)
    } catch (err) { creationFailed(err, draft, () => resetThenSend(draft)); return }
    try {
      const result = await chatClient.send({ type: 'context.reset', sessionId: session.id }) as { session?: SessionRecord }
      if (result?.session?.id !== session.id || !result.session.contextResetSeq) throw new Error('The server did not confirm the reset; check this chat before repeating it.')
      record = result.session
      applyEvent(model, { sessionId: session.id, seq: result.session.contextResetSeq, at: result.session.updatedAt, event: { type: 'session.reset', session: result.session } })
      setNotice('Chat reset. Previous conversation context cleared.')
      const remaining = [...(chain.switches || []).map((name) => `/${name}`), chain.text].filter(Boolean).join(' ')
      if (remaining || draft.attachments.length) await sendPrompt({ ...draft, text: remaining, model: draft.model || chain.model })
      else render()
    } catch (err) {
      keepDraft(draft)
      setNotice(`Reset failed — ${(err as Error).message}`)
      render()
    }
  }

  async function queuePrompt(draft: ComposerDraft): Promise<void> {
    const chain = parseChatCommandChain(commandDraftText(draft))
    if (options.beforeSend) {
      try {
        await options.beforeSend()
      } catch (err) { keepDraft(draft); setNotice((err as Error).message); return }
    }
    const first = { ...draft, model: draft.model || chain.model }
    try {
      await ensureSession(first)
    } catch (err) { creationFailed(err, draft, () => queuePrompt(draft)); return }
    const session = record!
    try {
      const queue = await chatClient.queueCommand({ type: 'queue.add', sessionId: session.id, itemId: crypto.randomUUID(),
        text: withHighlight(chain.text), attachments: draft.attachments, mentions: draft.mentions, model: first.model || session.model })
      record = { ...session, queue }
      setNotice(null)
      setHighlight(null)
      render()
    } catch (err) {
      keepDraft(draft)
      setNotice(`Queue failed — ${(err as Error).message}`)
      render()
    }
  }

  async function changeQueueItem(sessionId: string, itemId: string, model?: string): Promise<void> {
    try {
      const queue = await chatClient.queueCommand(model
        ? { type: 'queue.update', sessionId, itemId, model }
        : { type: 'queue.remove', sessionId, itemId })
      if (record?.id === sessionId) { record = { ...record, queue }; render() }
    } catch (err) {
      setNotice(`Queue update failed — ${(err as Error).message}`)
    }
  }

  async function steer(draft: ComposerDraft): Promise<void> {
    if (!record) return
    try {
      await chatClient.send({ type: 'steer', sessionId: record.id, text: withHighlight(draft.text),
        ...(draft.attachments.length ? { attachments: draft.attachments } : {}), ...(draft.mentions.length ? { mentions: draft.mentions } : {}) })
      setHighlight(null)
    } catch (err) {
      keepDraft(draft)
      setNotice(`Steer failed — ${(err as Error).message}`)
      render()
    }
  }

  async function stop(): Promise<void> {
    if (!record) return
    try {
      await chatClient.send({ type: 'cancel', sessionId: record.id })
    } catch (err) {
      setNotice(`Stop failed — ${(err as Error).message}`)
    }
  }

  async function resume(): Promise<void> {
    if (!record) return
    try {
      const resumed = await chatClient.resumeSession(record.id)
      record = resumed.session
      setNotice(null)
      render()
    } catch (err) {
      setNotice(`Resume failed — ${(err as Error).message}`)
    }
  }

  async function setSessionModel(identity: string): Promise<void> {
    if (!record) { pendingModel = identity; composerState(); return }
    try {
      const result = await chatClient.send({ type: 'set_model', sessionId: record.id, model: identity }) as { session?: SessionRecord } | undefined
      if (result?.session?.id !== record.id) throw new Error('The server did not confirm the selected model')
      record = result.session
      render()
    } catch (err) {
      setNotice(`Model change failed — ${(err as Error).message}`)
    }
  }

  async function runCommand(name: string, arg: string): Promise<void> {
    if (name === 'model') { await setSessionModel(arg); return }
    if (name !== 'content' && name !== 'consensus') return
    const submitted = composer.getDraft()
    let session: SessionRecord
    try {
      session = await ensureSession()
    } catch (err) { creationFailed(err, submitted, () => runCommand(name, arg)); return }
    const topic = arg.trim() || subject.label
    // Clear at send: the submitted command must not linger for the next
    // Enter, and nothing typed while a debate runs may be erased by it.
    composer.setDraft({ ...emptyDraft(), model: submitted.model })
    try {
      if (name === 'content') await chatClient.runContent(session.id, topic)
      else await chatClient.runConsensus(session.id, topic)
      setNotice(null)
    } catch (err) {
      keepDraft(recoverDraft(submitted, composer.getDraft()))
      setNotice(`/${name} failed — ${(err as Error).message}`)
    }
  }

  function applyEnvelope(envelope: ChatEnvelope): void {
    if (!record || envelope.seq <= seenSeq) return
    seenSeq = envelope.seq
    if (envelope.event.type === 'session.updated') record = envelope.event.session
    else if (envelope.event.type === 'session.closed') record = { ...record, status: 'closed' }
    else if (envelope.event.type === 'edit.decided') {
      const event = envelope.event
      const key = `${event.turnId}:${event.messageId}:${event.index}`
      const baseline = editState.baselines.get(key)
      if (baseline !== undefined && envelope.seq > baseline && (!editState.applied.has(key) || event.decision === 'applied')) {
        if (editState.deciding.has(key)) editState.confirmed.add(key)
        editState.applied.delete(key)
        editState.saved.delete(key)
        editState.retries.delete(key)
        if (!editState.deciding.has(key)) editState.baselines.delete(key)
        notifyEditState(editState, record.id, key, event.decision)
      }
    }
    applyEvent(model, envelope)
  }

  function onEvent(envelope: ChatEnvelope): void {
    if (destroyed || !record || envelope.sessionId !== record.id) return
    if (adopting) { adopting.push(envelope); return }
    applyEnvelope(envelope)
    state()
    render()
  }

  const offEvent = chatClient.on('event', onEvent)
  chatClient.start()

  return {
    session: () => record?.id ?? null,
    lastSeq: () => seenSeq,
    pendingRequests: () => {
      const pending = new Set(record?.pendingRequests)
      for (const [id, item] of model.permissions) {
        if (item.resolved) pending.delete(id)
        else pending.add(id)
      }
      for (const [id, item] of model.questions) {
        if (item.answered) pending.delete(id)
        else pending.add(id)
      }
      // A surface can close while history is loading and live requests are
      // buffered for adoption. Those requests still need a margin marker.
      for (const envelope of adopting || []) {
        const event = envelope.event
        if (event.type === 'permission.requested' || event.type === 'question.asked') pending.add(event.id)
        else if (event.type === 'permission.resolved' || event.type === 'question.answered') pending.delete(event.id)
        else if (event.type === 'session.reset') pending.clear()
      }
      return [...pending]
    },
    focus: () => composer.focus(),
    takeDraft: () => {
      const draft = composer.getDraft()
      return draft.text || draft.attachments.length ? draft : null
    },
    setHighlight,
    destroy: () => {
      if (destroyed) return
      destroyed = true
      editState.listeners.delete(editStateChanged)
      clearInterval(tickTimer)
      offEvent()
      if (subscribed) chatClient.unsubscribe(subscribed)
      transcriptEl.removeEventListener('chat:rerender', render)
      queuePanel.el.remove()
      composer.destroy()
      transcript.destroy()
    },
  }
}
