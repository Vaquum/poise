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
  NewSessionRequest,
  SessionRecord,
} from '../../server/chat/protocol'
import { parseChatCommandChain } from '../../server/chat/commands'
import { createComposer, emptyDraft, type Composer, type ComposerDraft } from './chat-composer'
import { createModel, applyEvent, addOptimisticTurn, dropOptimisticTurns, createTranscriptView, renderImportedHtml, type TranscriptModel } from './chat-transcript'
import { createQueuePanel } from './chat-queue'

export interface SurfaceOptions {
  subject: ChatSubject
  prefill?: string
  draft?: ComposerDraft
}

export interface SessionSurface {
  session(): string | null
  focus(): void
  takeDraft(): ComposerDraft | null
  destroy(): void
}

interface ModelPlaceAnswer {
  places: Array<{ key: string, default?: string }>
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

  container.classList.add('chat-surface')
  container.innerHTML = '<div class="chat-surface-notice" hidden></div>'
    + '<div class="chat-surface-earlier" hidden></div>'
    + '<div class="chat-surface-transcript"></div>'
    + '<div class="chat-surface-queue"></div>'
    + '<div class="chat-surface-composer"></div>'
  const noticeEl = container.querySelector<HTMLElement>('.chat-surface-notice')!
  const earlierEl = container.querySelector<HTMLElement>('.chat-surface-earlier')!
  const transcriptEl = container.querySelector<HTMLElement>('.chat-surface-transcript')!
  const queueEl = container.querySelector<HTMLElement>('.chat-surface-queue')!
  const composerEl = container.querySelector<HTMLElement>('.chat-surface-composer')!

  const transcript = createTranscriptView(transcriptEl, {
    onPermission: (id, optionId) => { if (record) void chatClient.send({ type: 'permission.respond', sessionId: record.id, id, optionId }).catch((err) => setNotice(`Permission failed — ${(err as Error).message}`)) },
    onQuestion: (id, answers) => { if (record) void chatClient.send({ type: 'question.answer', sessionId: record.id, id, answers }).catch((err) => setNotice(`Answer failed — ${(err as Error).message}`)) },
    onRevert: () => { setNotice('Open in Chat to revert this diff.') },
    onFile: () => { setNotice('Open in Chat to preview files.') },
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
    transcript.render(model, { running: !!record && isRunning(record.status), sessionId: record?.id })
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
    const identity = answer.places.find((place) => place.key === 'chat')?.default
    if (!identity) throw new Error('Chat has no default model. Choose one in the console.')
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

  async function adopt(session: SessionRecord): Promise<void> {
    record = session
    earlierEl.hidden = true
    earlierEl.innerHTML = ''
    transcript.clear()
    model = createModel()
    let after = 0
    for (let guard = 0; guard < 100; guard++) {
      const page = await chatClient.fetchSession(session.id, after)
      record = page.session
      for (const envelope of page.events) {
        if (envelope.seq > after) { applyEvent(model, envelope); after = envelope.seq }
      }
      if (!page.truncated || !page.events.length) break
    }
    chatClient.subscribe(session.id, after)
    setNotice(null)
    state()
    render()
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
    const prompt = { text, attachments: draft.attachments, mentions: draft.mentions }
    dropOptimisticTurns(model)
    addOptimisticTurn(model, prompt)
    record = { ...session, ...(!session.title ? { title: text.slice(0, 200) } : {}), status: 'running' }
    setNotice(null)
    render()
    try {
      await chatClient.send({ type: 'prompt', sessionId: session.id, ...prompt })
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
    const first = { ...draft, model: draft.model || chain.model }
    try {
      await ensureSession(first)
    } catch (err) { creationFailed(err, draft, () => queuePrompt(draft)); return }
    const session = record!
    try {
      const queue = await chatClient.queueCommand({ type: 'queue.add', sessionId: session.id, itemId: crypto.randomUUID(),
        text: chain.text, attachments: draft.attachments, mentions: draft.mentions, model: first.model || session.model })
      record = { ...session, queue }
      setNotice(null)
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
      await chatClient.send({ type: 'steer', sessionId: record.id, text: draft.text,
        ...(draft.attachments.length ? { attachments: draft.attachments } : {}), ...(draft.mentions.length ? { mentions: draft.mentions } : {}) })
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

  function onEvent(envelope: ChatEnvelope): void {
    if (destroyed || !record || envelope.sessionId !== record.id) return
    if (envelope.event.type === 'session.updated') record = envelope.event.session
    else if (envelope.event.type === 'session.closed') record = { ...record, status: 'closed' }
    applyEvent(model, envelope)
    state()
    render()
  }

  const offEvent = chatClient.on('event', onEvent)
  chatClient.start()

  return {
    session: () => record?.id ?? null,
    focus: () => composer.focus(),
    takeDraft: () => {
      const draft = composer.getDraft()
      return draft.text || draft.attachments.length ? draft : null
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      clearInterval(tickTimer)
      offEvent()
      if (record) chatClient.unsubscribe(record.id)
      transcriptEl.removeEventListener('chat:rerender', render)
      queuePanel.el.remove()
      composer.destroy()
      transcript.destroy()
    },
  }
}
