import { reveal, resizeContent } from '../motion'
import { patchContent } from '../dom-patch'
// Chat transcript — folds the session's event stream into a model of turns
// and renders it as keyed DOM. Every item carries a revision counter; the
// renderer only rewrites an element whose revision moved, so a streaming
// text delta re-renders one message and a ticking tool card touches one
// element, while the rest of the transcript (and its expanded/collapsed
// state) stays exactly as it was.
//
// Tool cards are keyed by turnId + tool id: native tool ids recur across
// turns. Diffs carry their own diffId so Revert always undoes one recorded
// change. Permission and question cards are rendered from the events alone —
// a request with no resolved/answered event is still pending after a reload.

import type {
  ChatActor,
  ChatEnvelope,
  AgentId,
  ContentBlock,
  EditDecision,
  LegacyConversation,
  PermissionOption,
  PersonActor,
  PlanEntry,
  PoiseActor,
  PromptInput,
  Question,
  StopReason,
  TimerSummary,
  ToolKind,
  ToolLocation,
  ToolStatus,
  TurnSource,
  TurnUsage,
} from '../../server/chat/protocol'
import { AGENT_LABELS } from '../../server/chat/protocol'
import { editFromCard, renderEditCards, tryParseStructuredReply, type EditProposal } from '../edit-proposals'
import { consoleModelLabel } from '../chat-catalog'
import { turnTime } from '../chat-turn-time'
import { clockDay } from '../clock'
import { effectiveTimezone } from '../config'
import { renderMarkdown, escapeHtml } from '../markdown'

// ── Model ──────────────────────────────────────────────────────────────────

interface Keyed { key: string, rev: number }

export interface TextItem extends Keyed { kind: 'text', messageId: string, text: string }
export interface ThoughtItem extends Keyed { kind: 'thought', messageId: string, text: string }
export interface DiffModel {
  diffId: string
  path: string
  oldText: string
  newText: string
  oldExists: boolean
  newExists: boolean
  unified: boolean
  previewOnly?: boolean
  loadingFull?: boolean
  loadError?: string
  revert?: { state: 'reverting' } | { state: 'reverted' } | { state: 'error', error: string }
}
export interface ToolItem extends Keyed {
  kind: 'tool'
  id: string
  turnId: string
  toolKind: ToolKind
  title: string
  status: ToolStatus
  input?: unknown
  content: ContentBlock[]
  locations?: ToolLocation[]
  diffs: DiffModel[]
  startedAt: number
  finishedAt?: number
  durationMs?: number
}
export interface PlanItem extends Keyed { kind: 'plan', entries: PlanEntry[], explanation?: string }
export interface PermissionItem extends Keyed {
  kind: 'permission'
  id: string
  title: string
  description?: string
  input?: unknown
  options: PermissionOption[]
  resolved?: { optionId: string, by: 'user' | 'session' | 'auto_merge' | 'unrestricted' | 'cancelled' }
}
export interface QuestionItem extends Keyed {
  kind: 'question'
  id: string
  questions: Question[]
  answered?: { answers: Record<string, string | string[]>, by: 'user' | 'chat' | 'cancelled', fromSession?: string, source?: ChatActor }
}
export interface SteerItem extends Keyed { kind: 'steer', text: string, attachments?: PromptInput['attachments'], mentions?: PromptInput['mentions'], source?: ChatActor | PoiseActor }
export interface ErrorItem extends Keyed { kind: 'error', message: string }

export type TurnItem = TextItem | ThoughtItem | ToolItem | PlanItem | PermissionItem | QuestionItem | SteerItem | ErrorItem

export interface TurnModel extends Keyed {
  turnId: string
  prompt: PromptInput
  queueItemId?: string
  agent?: AgentId
  model?: string
  /** Set when another chat or Poise started the turn; absent for the person's turns. */
  source?: TurnSource
  startedAt: string
  items: TurnItem[]
  /** Set locally the moment a prompt is sent, cleared when turn.started lands. */
  optimistic?: boolean
  /** `at` is the server's time on the turn.finished envelope: when the turn ended. */
  finished?: { stopReason: StopReason, error?: string, usage?: TurnUsage, durationMs?: number, stoppedBy?: ChatActor | PersonActor, at: string }
}

export type Block =
  | { kind: 'turn', key: string, turn: TurnModel }
  | { kind: 'error', key: string, rev: number, message: string }
  | { kind: 'note', key: string, rev: number, text: string }
  | { kind: 'imported', key: string, rev: number, legacyId: string, turns: LegacyConversation['turns'], omitted: number }
  | { kind: 'content', key: string, rev: number, topic: string, launchId: string, callId?: string }
  | { kind: 'consensus', key: string, rev: number, id: string, topic: string, synthesis?: string, truncated?: boolean, error?: string, finished: boolean }

export interface TranscriptModel {
  /** Buffered history cannot cross a reset barrier. */
  resetSeq?: number
  blocks: Block[]
  turns: Map<string, TurnModel>
  tools: Map<string, ToolItem>
  diffs: Map<string, { tool: ToolItem, diff: DiffModel }>
  permissions: Map<string, PermissionItem>
  questions: Map<string, QuestionItem>
  /** Recorded edit decisions by `${turnId}:${messageId}:${index}`; the last one wins. */
  decisions: Map<string, EditDecision>
  /** The turn that has started and not finished, if any. */
  running: TurnModel | null
  /** Whether any text has streamed for the running turn. */
  rev: number
}

export function createModel(): TranscriptModel {
  return {
    blocks: [], turns: new Map(), tools: new Map(), diffs: new Map(),
    permissions: new Map(), questions: new Map(), decisions: new Map(), running: null, rev: 0,
  }
}

function toolKey(turnId: string, id: string): string { return `tool:${turnId}:${id}` }

function bump(model: TranscriptModel, ...items: Keyed[]): void {
  model.rev++
  for (const it of items) it.rev = model.rev
}

function lastPending(items: Iterable<PermissionItem | QuestionItem>): PermissionItem | QuestionItem | null {
  let found: PermissionItem | QuestionItem | null = null
  for (const it of items) {
    if (it.kind === 'permission' && !it.resolved) found = it
    if (it.kind === 'question' && !it.answered) found = it
  }
  return found
}

/** The request the keyboard answers: the most recent one still unanswered. */
export function focusedPending(model: TranscriptModel): PermissionItem | QuestionItem | null {
  const all: (PermissionItem | QuestionItem)[] = []
  for (const b of model.blocks) {
    if (b.kind !== 'turn') continue
    for (const it of b.turn.items) if (it.kind === 'permission' || it.kind === 'question') all.push(it)
  }
  return lastPending(all)
}

/** Add a turn locally before the server has acknowledged the prompt, so the
 *  message is on screen the instant it is sent. */
export function addOptimisticTurn(model: TranscriptModel, prompt: PromptInput): TurnModel {
  const turnId = `local-${Date.now().toString(36)}`
  const turn: TurnModel = { key: `turn:${turnId}`, rev: 0, turnId, prompt, startedAt: new Date().toISOString(), items: [], optimistic: true }
  model.turns.set(turnId, turn)
  model.blocks.push({ kind: 'turn', key: turn.key, turn })
  model.running = turn
  bump(model, turn)
  return turn
}

export function dropOptimisticTurns(model: TranscriptModel): void {
  const stale = model.blocks.filter((b) => b.kind === 'turn' && b.turn.optimistic)
  if (!stale.length) return
  for (const b of stale) if (b.kind === 'turn') model.turns.delete(b.turn.turnId)
  model.blocks = model.blocks.filter((b) => !(b.kind === 'turn' && b.turn.optimistic))
  if (model.running?.optimistic) model.running = null
  model.rev++
}

/** Actor titles show at most 60 characters; the full title stays in `title`. */
export function shortActorTitle(title: string): string {
  return title.length > 60 ? `${title.slice(0, 60)}…` : title
}

/** Plain-text name of a chat or Poise actor for transcript labels. Pure, so
 *  unit tests prove the same mapping the transcript renders. A timer source
 *  names the chat or person that set it. */
export function actorName(actor: ChatActor | PoiseActor | PersonActor | TurnSource | undefined): string {
  if (!actor) return 'another chat'
  if (actor.kind === 'poise') return actor.name
  if (actor.kind === 'person') return 'you'
  if (actor.kind === 'timer') return timerSetterName(actor.setBy)
  if (actor.role === 'manager') return 'Manager'
  return actor.title ? `chat "${shortActorTitle(actor.title)}"` : 'another chat'
}

/** Who set a timer, in transcript and pane words. */
export function timerSetterName(setBy: ChatActor | PersonActor): string {
  if (setBy.kind === 'person') return 'you'
  if (setBy.role === 'manager') return 'Manager'
  return actorName(setBy)
}

/** One timer change as a transcript note. Pure; the note renderer escapes it. */
export function timerChangedText(timer: TimerSummary, change: 'created' | 'cancelled' | 'held' | 'released' | 'tripped' | 'rearmed' | 'ended', error?: string): string {
  const name = `Timer "${timer.label}"`
  const schedule = timer.schedule.kind === 'every' ? `every ${timer.schedule.minutes} min` : `once in ${timer.schedule.delayMinutes} min`
  switch (change) {
    case 'created': return `${name} set by ${timerSetterName(timer.setBy)} · ${schedule}`
    case 'cancelled': return `${name} cancelled`
    case 'held': return `${name} put on hold`
    case 'released': return `${name} resumed`
    case 'tripped': return `${name} stopped after 3 failed turns: ${error || 'unknown error'}. Re-arm it from Timers.`
    case 'rearmed': return `${name} re-armed`
    case 'ended': return `${name} ended`
  }
}

/** Tooltip for an actor label: the full frozen title and the short chat ID,
 *  so two chats with one title can be told apart. */
export function actorTitleAttr(actor: Pick<ChatActor, 'title' | 'sessionId'>): string {
  return `${actor.title} (chat ${actor.sessionId.slice(0, 8)})`
}

function ensureTurn(model: TranscriptModel, turnId: string, at: string): TurnModel {
  let turn = model.turns.get(turnId)
  if (turn) return turn
  // An event for a turn whose start was never seen (history bounded, or a
  // gap): a turn shell keeps its items rather than dropping them.
  turn = { key: `turn:${turnId}`, rev: 0, turnId, prompt: { text: '', attachments: [], mentions: [] }, startedAt: at, items: [] }
  model.turns.set(turnId, turn)
  model.blocks.push({ kind: 'turn', key: turn.key, turn })
  bump(model, turn)
  return turn
}

export function applyEvent(model: TranscriptModel, env: ChatEnvelope): void {
  if (env.seq <= (model.resetSeq ?? 0)) return
  const e = env.event
  const at = env.at
  switch (e.type) {
    case 'session.reset': {
      Object.assign(model, createModel(), { rev: model.rev + 1, resetSeq: env.seq })
      model.blocks.push({ kind: 'note', key: `reset:${env.seq}`, rev: model.rev, text: 'Chat reset. Previous conversation context cleared.' })
      return
    }
    case 'context.compacted': {
      model.blocks.push({ kind: 'note', key: `compact:${env.seq}`, rev: ++model.rev, text: e.detail })
      return
    }
    case 'turn.started': {
      // The optimistic turn for this prompt becomes the real one.
      dropOptimisticTurns(model)
      const turn: TurnModel = { key: `turn:${e.turnId}`, rev: 0, turnId: e.turnId, prompt: e.prompt, startedAt: at, items: [], queueItemId: e.queueItemId, agent: e.agent, model: e.model, ...(e.source ? { source: e.source } : {}) }
      const existing = model.turns.get(e.turnId)
      if (existing) {
        existing.queueItemId = e.queueItemId
        existing.agent = e.agent
        existing.model = e.model
        existing.source = e.source
        existing.prompt = e.prompt
        existing.startedAt = at
        model.running = existing
        bump(model, existing)
        return
      }
      model.turns.set(e.turnId, turn)
      model.blocks.push({ kind: 'turn', key: turn.key, turn })
      model.running = turn
      bump(model, turn)
      return
    }
    case 'turn.finished': {
      const turn = ensureTurn(model, e.turnId, at)
      turn.finished = { stopReason: e.stopReason, error: e.error, usage: e.usage, durationMs: e.durationMs, ...(e.stoppedBy ? { stoppedBy: e.stoppedBy } : {}), at }
      if (model.running?.turnId === e.turnId) model.running = null
      // Tools still marked running when the turn ends were cut with it.
      for (const it of turn.items) {
        if (it.kind === 'tool' && (it.status === 'running' || it.status === 'pending')) {
          it.status = e.stopReason === 'end_turn' ? 'completed' : 'cancelled'
          it.finishedAt = Date.parse(at)
          bump(model, it)
        }
      }
      bump(model, turn)
      return
    }
    case 'steer.sent': {
      const turn = ensureTurn(model, e.turnId, at)
      const item: SteerItem = { kind: 'steer', key: `steer:${env.seq}`, rev: 0, text: e.text, ...(e.attachments ? { attachments: e.attachments } : {}), ...(e.mentions ? { mentions: e.mentions } : {}), ...(e.source ? { source: e.source } : {}) }
      turn.items.push(item)
      bump(model, item, turn)
      return
    }
    case 'text.delta':
    case 'thought.delta': {
      const turn = ensureTurn(model, e.turnId, at)
      const kind = e.type === 'text.delta' ? 'text' : 'thought'
      const key = `${kind}:${e.turnId}:${e.messageId}`
      let item = turn.items.find((it) => it.key === key) as TextItem | ThoughtItem | undefined
      if (!item) {
        item = { kind, key, rev: 0, messageId: e.messageId, text: '' } as TextItem | ThoughtItem
        turn.items.push(item)
      }
      item.text += e.delta
      bump(model, item, turn)
      return
    }
    case 'tool.started': {
      const turn = ensureTurn(model, e.turnId, at)
      const key = toolKey(e.turnId, e.id)
      let item = model.tools.get(key)
      if (!item) {
        item = {
          kind: 'tool', key, rev: 0, id: e.id, turnId: e.turnId, toolKind: e.kind, title: e.title,
          status: 'running', input: e.input, content: [], locations: e.locations, diffs: [], startedAt: Date.parse(at),
        }
        model.tools.set(key, item)
        turn.items.push(item)
      } else {
        item.toolKind = e.kind
        item.title = e.title
        item.input = e.input
        item.locations = e.locations
      }
      bump(model, item, turn)
      return
    }
    case 'tool.updated':
    case 'tool.finished': {
      const turn = ensureTurn(model, e.turnId, at)
      const key = toolKey(e.turnId, e.id)
      let item = model.tools.get(key)
      if (!item) {
        item = {
          kind: 'tool', key, rev: 0, id: e.id, turnId: e.turnId, toolKind: 'other', title: 'Tool',
          status: 'running', content: [], diffs: [], startedAt: Date.parse(at),
        }
        model.tools.set(key, item)
        turn.items.push(item)
      }
      if (e.type === 'tool.updated') {
        if (e.kind) item.toolKind = e.kind
        if (e.title) item.title = e.title
        if (e.status) item.status = e.status
        if (e.locations) item.locations = e.locations
        if (e.content) item.content = item.content.concat(e.content)
      } else {
        item.status = e.status
        if (e.content) item.content = item.content.concat(e.content)
        item.finishedAt = Date.parse(at)
        item.durationMs = e.durationMs
      }
      bump(model, item, turn)
      return
    }
    case 'diff': {
      const turn = ensureTurn(model, e.turnId, at)
      const key = toolKey(e.turnId, e.toolId)
      let tool = model.tools.get(key)
      if (!tool) {
        tool = {
          kind: 'tool', key, rev: 0, id: e.toolId, turnId: e.turnId, toolKind: 'edit', title: e.path,
          status: 'completed', content: [], diffs: [], startedAt: Date.parse(at), finishedAt: Date.parse(at),
        }
        model.tools.set(key, tool)
        turn.items.push(tool)
      }
      const diff: DiffModel = {
        diffId: e.diffId, path: e.path, oldText: e.oldText, newText: e.newText,
        oldExists: e.oldExists, newExists: e.newExists, unified: !!e.unified, previewOnly: e.previewOnly,
      }
      tool.diffs.push(diff)
      model.diffs.set(e.diffId, { tool, diff })
      bump(model, tool, turn)
      return
    }
    case 'diff.reverted': {
      const found = model.diffs.get(e.diffId)
      if (!found) return
      found.diff.revert = e.ok ? { state: 'reverted' } : { state: 'error', error: e.error || 'Revert failed' }
      bump(model, found.tool)
      return
    }
    case 'plan.updated': {
      const turn = ensureTurn(model, e.turnId, at)
      // One plan card per turn, updated in place.
      let item = turn.items.find((it) => it.kind === 'plan') as PlanItem | undefined
      if (!item) {
        item = { kind: 'plan', key: `plan:${e.turnId}`, rev: 0, entries: [], explanation: undefined }
        turn.items.push(item)
      }
      item.entries = e.entries
      item.explanation = e.explanation
      bump(model, item, turn)
      return
    }
    case 'permission.requested': {
      const turn = ensureTurn(model, e.turnId, at)
      let item = model.permissions.get(e.id)
      if (!item) {
        item = { kind: 'permission', key: `perm:${e.id}`, rev: 0, id: e.id, title: e.title, description: e.description, input: e.input, options: e.options }
        model.permissions.set(e.id, item)
        turn.items.push(item)
      }
      bump(model, item, turn)
      return
    }
    case 'permission.resolved': {
      const item = model.permissions.get(e.id)
      if (!item) return
      item.resolved = { optionId: e.optionId, by: e.by }
      bump(model, item)
      return
    }
    case 'question.asked': {
      const turn = ensureTurn(model, e.turnId, at)
      let item = model.questions.get(e.id)
      if (!item) {
        item = { kind: 'question', key: `q:${e.id}`, rev: 0, id: e.id, questions: e.questions }
        model.questions.set(e.id, item)
        turn.items.push(item)
      }
      bump(model, item, turn)
      return
    }
    case 'question.answered': {
      const item = model.questions.get(e.id)
      if (!item) return
      item.answered = { answers: e.answers, by: e.by, ...(e.fromSession ? { fromSession: e.fromSession } : {}), ...(e.source ? { source: e.source } : {}) }
      bump(model, item)
      return
    }
    case 'error': {
      // Inside a turn the line belongs to the turn; between turns it stands
      // on its own.
      if (model.running) {
        const item: ErrorItem = { kind: 'error', key: `err:${env.seq}`, rev: 0, message: e.message }
        model.running.items.push(item)
        bump(model, item, model.running)
      } else {
        const block: Block = { kind: 'error', key: `err:${env.seq}`, rev: 0, message: e.message }
        model.blocks.push(block)
        bump(model, block)
      }
      return
    }
    case 'session.closed': {
      const block: Block = { kind: 'note', key: `note:${env.seq}`, rev: 0, text: `Session closed${e.reason ? ` — ${e.reason}` : ''}` }
      model.blocks.push(block)
      bump(model, block)
      return
    }
    case 'timer.changed': {
      const block: Block = { kind: 'note', key: `timer:${env.seq}`, rev: 0, text: timerChangedText(e.timer, e.change, e.error) }
      model.blocks.push(block)
      bump(model, block)
      return
    }
    case 'history.imported': {
      const block: Block = { kind: 'imported', key: `imported:${env.seq}`, rev: 0, legacyId: e.legacyId, turns: e.turns, omitted: e.omitted }
      model.blocks.push(block)
      bump(model, block)
      return
    }
    case 'edit.decided': {
      const turn = model.turns.get(e.turnId)
      if (!turn) return
      model.decisions.set(`${e.turnId}:${e.messageId}:${e.index}`, e.decision)
      const item = turn.items.find((it): it is TextItem => it.kind === 'text' && it.messageId === e.messageId)
      bump(model, turn, ...(item ? [item] : []))
      return
    }
    case 'content.started': {
      const block: Block = { kind: 'content', key: `content:${e.launchId}`, rev: 0, topic: e.topic, launchId: e.launchId, ...(e.callId ? { callId: e.callId } : {}) }
      model.blocks.push(block)
      bump(model, block)
      return
    }
    case 'consensus.started': {
      const block: Block = { kind: 'consensus', key: `consensus:${e.id}`, rev: 0, id: e.id, topic: e.topic, finished: false }
      model.blocks.push(block)
      bump(model, block)
      return
    }
    case 'consensus.finished': {
      const block = model.blocks.find((b): b is Extract<Block, { kind: 'consensus' }> => b.kind === 'consensus' && b.id === e.id)
      if (block) {
        block.synthesis = e.synthesis
        block.truncated = e.truncated
        block.error = e.error
        block.finished = true
        bump(model, block)
      } else {
        // A result that lands after a reset has no start to complete.
        const orphan: Block = { kind: 'consensus', key: `consensus:${e.id}`, rev: 0, id: e.id, topic: '', synthesis: e.synthesis, truncated: e.truncated, error: e.error, finished: true }
        model.blocks.push(orphan)
        bump(model, orphan)
      }
      return
    }
    default:
      return
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────

/** The read-only Earlier conversation block, shared by the transcript's
 *  import card and the surface's pre-session block. */
export function renderImportedHtml(turns: LegacyConversation['turns'], omitted: number, open: boolean): string {
  const count = `${turns.length} turn${turns.length === 1 ? '' : 's'}${omitted ? ` · ${omitted} earlier left out` : ''}`
  const body = turns.map((turn) => `<div class="chat-imported-turn"><div class="chat-imported-person">${escapeHtml(turn.prompt)}</div>`
    + `<div class="chat-imported-agent">${escapeHtml(turn.reply)}</div></div>`).join('')
  return `<details class="chat-imported"${open ? ' open' : ''}><summary>Earlier conversation · ${escapeHtml(count)}</summary>${body}</details>`
}

export interface ContentCardState { status: string, slug?: string, error?: string }

function contentCardHtml(block: Extract<Block, { kind: 'content' }>, state?: ContentCardState): string {
  const head = `<div class="chat-content-head"><span class="chat-msg-mode-tag">/content</span> <span>${escapeHtml(block.topic)}</span></div>`
  if (!state || (state.status !== 'completed' && state.status !== 'failed')) return `<div class="chat-content-card">${head}<div class="chat-content-status">${ICON_SPIN} Authoring…</div></div>`
  if (state.status === 'failed' || !state.slug) {
    return `<div class="chat-content-card">${head}<div class="chat-msg chat-msg-agent chat-msg-error"><div class="chat-msg-body">${escapeHtml(state.error || 'The article finished without a slug.')}</div></div></div>`
  }
  return `<div class="chat-content-card">${head}<div class="chat-content-done"><button type="button" class="chat-content-open" data-slug="${escapeHtml(state.slug)}">Open in Editor</button></div></div>`
}

function consensusCardHtml(block: Extract<Block, { kind: 'consensus' }>): string {
  const head = block.topic ? `<div class="chat-consensus-head"><span class="chat-msg-mode-tag">/consensus</span> <span>${escapeHtml(block.topic)}</span></div>` : ''
  if (!block.finished) return `<div class="chat-consensus-card">${head}<div class="chat-consensus-status">${ICON_SPIN} Debating…</div></div>`
  if (block.error) return `<div class="chat-consensus-card">${head}<div class="chat-msg chat-msg-agent chat-msg-error"><div class="chat-msg-body">${escapeHtml(block.error)}</div></div></div>`
  return `<div class="chat-consensus-card">${head}<div class="chat-msg-body">${renderMarkdown(block.synthesis || '')}</div>`
    + (block.truncated ? '<div class="chat-consensus-cut">Cut to 64 KiB.</div>' : '') + '</div>'
}

export interface TranscriptHandlers {
  onPermission(id: string, optionId: string): void
  onQuestion(id: string, answers: Record<string, string | string[]>): void
  onRevert(diffId: string): void
  onLoadDiff?(diffId: string): void
  onFile?(reference: string): void
  onSelectSession?(id: string): void
  onEditDecide?(turnId: string, messageId: string, index: number, decision: EditDecision, edit: EditProposal): void
  onEditHover?(edit: EditProposal): void
  onEditLeave?(): void
  onOpenInEditor?(): void
  onSuggestedReply?(text: string): void
}

export interface RenderContext {
  showReasoning?: boolean
  showActivity?: boolean
  /** The tools toggle: false hides tool cards, keeping text, errors and requests. */
  showTools?: boolean
  agent?: string
  /** A turn the runtime marked as cut by a crash or restart. */
  interruptedTurnId?: string
  /** Whether the session is running a turn right now (drives the dots). */
  running: boolean
  /** The rendered session; question drafts are kept per session. */
  sessionId?: string
  /** Render a finished turn's last text message as edit cards when it parses
   *  as the contract. Read-only cards show badges instead of buttons. */
  edits?: {
    surface: 'editor-document' | 'editor-passage' | 'editor-review'
    readOnly: boolean
    deciding?: ReadonlySet<string>
    applied?: ReadonlySet<string>
    revision?: number
  }
  /** Live chats for actor labels: a listed source is a select button, a
   *  missing one renders with a deleted marker. */
  chats?: Array<{ id: string, title: string, role?: 'manager' | 'worker' }>
}

const ICONS: Record<ToolKind, string> = {
  read:    '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3 1.5h5.5L11 4v8.5H3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 7h4M5 9.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  edit:    '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 12l.8-3.2L9.6 2l2.4 2.4-6.8 6.8z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  execute: '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2.5 3.5l3.5 3.5-3.5 3.5M7.5 10.5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search:  '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="3.8" stroke="currentColor" stroke-width="1.2"/><path d="M9 9l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  fetch:   '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.2"/><path d="M2 7h10M7 2c2 2 2 8 0 10M7 2c-2 2-2 8 0 10" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>',
  think:   '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M4 9.5a3.5 3.5 0 1 1 6 0v1.5H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.5 12.5h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  other:   '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
}
const ICON_CHECK = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ICON_CROSS = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const ICON_SPIN = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none" class="spin"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="8 6" stroke-linecap="round"/></svg>'
const ICON_COPY = '<svg class="chat-copy-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="3" y="3" width="7" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 3V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
const ICON_COPIED = '<svg class="chat-copy-done" width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ICON_CHEV = '<svg class="chev" width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** Terminal output taller than this is capped until "Show all". */
const TERMINAL_CAP_LINES = 24

const STOP_LABEL: Record<StopReason, string> = {
  end_turn: '',
  cancelled: 'Stopped',
  max_tokens: 'Hit the output limit',
  refusal: 'Refused',
  error: 'Error',
  interrupted: 'Interrupted',
}

function fmtSeconds(ms: number): string {
  const s = Math.max(0, ms) / 1000
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

export function fmtDuration(ms: number): string {
  // Round the whole duration before splitting it, so seconds can never
  // carry past 59: 12m 59.6s is 13m 0s, never 12m 60s.
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return fmtSeconds(ms)
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}

function preview(value: unknown, max = 1200): string {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
  }
  if (text.length > max) text = text.slice(0, max) + '…'
  return escapeHtml(text)
}

// One render list per turn: consecutive completed reads fold into a group so a
// burst of file reads is one line instead of a column of cards.
type RenderItem = TurnItem | { kind: 'readgroup', key: string, rev: number, tools: ToolItem[] }

function renderList(turn: TurnModel): RenderItem[] {
  const out: RenderItem[] = []
  let i = 0
  const isFoldableRead = (it: TurnItem): it is ToolItem =>
    it.kind === 'tool' && it.toolKind === 'read' && it.status === 'completed' && it.diffs.length === 0
  while (i < turn.items.length) {
    const it = turn.items[i]
    if (isFoldableRead(it)) {
      const run: ToolItem[] = [it]
      let j = i + 1
      while (j < turn.items.length && isFoldableRead(turn.items[j])) { run.push(turn.items[j] as ToolItem); j++ }
      if (run.length >= 2) {
        out.push({ kind: 'readgroup', key: `group:${run[0].key}`, rev: run.reduce((a, t) => a + t.rev, run.length), tools: run })
        i = j
        continue
      }
    }
    out.push(it)
    i++
  }
  return out
}

interface UiState { expanded?: boolean, showAll?: boolean, answers?: Array<{ name: string, type: string, value: string, checked: boolean }> }

/** The time zone and instant turn times are labelled against. */
interface Clock { zone: string, now: number }

function lastText(turn: TurnModel): TextItem | undefined {
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const it = turn.items[i]
    if (it.kind === 'text') return it
  }
  return undefined
}

export interface TranscriptView {
  render(model: TranscriptModel, ctx: RenderContext): void
  clear(): void
  /** Advance elapsed counters on running tool cards. */
  tick(): void
  /** Text of a rendered message, for the copy button. */
  textFor(key: string): string
  destroy(): void
}

type DraftRow = [string, Array<{ name: string, type: string, value: string, checked: boolean }>]

export function createTranscriptView(container: HTMLElement, handlers: TranscriptHandlers): TranscriptView {
  const nodes = new Map<string, { el: HTMLElement, rev: number }>()
  const ui = new Map<string, UiState>()
  const disclosures = new Set<string>()
  const questionDraftKey = 'poise-chat-question-drafts'
  /** Saved drafts by session; two transcripts never clobber each other. */
  const draftStore = new Map<string, DraftRow[]>()
  /** The session whose drafts `ui` currently holds, if any render has run. */
  let draftSession: string | null = null
  function validDraftRow(row: unknown): row is DraftRow {
    return Array.isArray(row) && typeof row[0] === 'string' && Array.isArray(row[1])
      && (row[1] as unknown[]).every((answer: any) => answer && typeof answer.name === 'string' && typeof answer.type === 'string'
        && typeof answer.value === 'string' && typeof answer.checked === 'boolean')
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(questionDraftKey) || '[]')
    if (Array.isArray(saved)) {
      const rows = (saved as unknown[]).filter(validDraftRow)
      if (rows.length) draftStore.set('', rows)
    } else if (saved && typeof saved === 'object') {
      for (const [session, rows] of Object.entries(saved as Record<string, unknown>)) {
        if (typeof session !== 'string' || !Array.isArray(rows)) continue
        const valid = (rows as unknown[]).filter(validDraftRow)
        if (valid.length) draftStore.set(session, valid)
      }
    }
  } catch { /* malformed or unavailable draft storage does not affect rendering */ }
  function stashDrafts(): void {
    if (draftSession === null) return
    const drafts = [...ui].filter(([, state]) => state.answers?.some(answer => answer.type === 'text' ? !!answer.value : answer.checked))
      .map(([key, state]) => [key, state.answers!] as DraftRow)
    if (drafts.length) draftStore.set(draftSession, drafts)
    else draftStore.delete(draftSession)
  }
  /** Article-card job states, and their pollers while non-terminal. */
  const contentState = new Map<string, ContentCardState>()
  const contentPolls = new Map<string, { stopped: boolean }>()
  let destroyed = false
  function stopContentPolls(): void {
    for (const poll of contentPolls.values()) poll.stopped = true
    contentPolls.clear()
  }
  function pollContent(block: Extract<Block, { kind: 'content' }>, model: TranscriptModel): void {
    if (destroyed || contentPolls.has(block.key)) return
    const known = contentState.get(block.key)?.status
    if (known === 'completed' || known === 'failed') return
    const poll = { stopped: false }
    contentPolls.set(block.key, poll)
    const terminal = () => {
      const status = contentState.get(block.key)?.status
      return status === 'completed' || status === 'failed'
    }
    void (async () => {
      while (!poll.stopped && !destroyed && contentPolls.get(block.key) === poll && model.blocks.some((b) => b.key === block.key) && !terminal()) {
        try {
          const url = block.callId
            ? `/api/chat-content/status?call_id=${encodeURIComponent(block.callId)}`
            : `/api/chat-content/status?launch_id=${encodeURIComponent(block.launchId)}`
          const res = await fetch(url)
          if (res.ok) {
            const body = await res.json() as { status?: unknown, slug?: unknown, error?: unknown, call_id?: unknown }
            const status = typeof body.status === 'string' ? body.status : 'pending'
            contentState.set(block.key, { status,
              ...(typeof body.slug === 'string' ? { slug: body.slug } : {}),
              ...(typeof body.error === 'string' ? { error: body.error } : {}) })
            if (!block.callId && typeof body.call_id === 'string') block.callId = body.call_id
            if (model.blocks.some((b) => b.key === block.key)) {
              bump(model, block)
              container.dispatchEvent(new CustomEvent('chat:rerender'))
            }
          }
        } catch { /* a network blip retries on the next poll */ }
        if (!terminal() && !poll.stopped) await new Promise((done) => setTimeout(done, 2000))
      }
      if (contentPolls.get(block.key) === poll) contentPolls.delete(block.key)
    })()
  }
  function swapDrafts(session: string): void {
    if (session === draftSession) return
    if (draftSession !== null) stashDrafts()
    for (const state of ui.values()) delete state.answers
    for (const [key, answers] of draftStore.get(session) || []) ui.set(key, { ...ui.get(key), answers })
    draftSession = session
  }
  const texts = new Map<string, string>()
  /** Rendered edit cards by opaque card key, for the delegated handlers. */
  const cards = new Map<string, { turnId: string, messageId: string, index: number, edit: EditProposal }>()
  let lastCtxKey = ''
  let lastChatsKey = ''
  let renderedDay = ''

  function ensure(parent: HTMLElement, key: string, before: HTMLElement | null, cls: string): { el: HTMLElement, fresh: boolean } {
    let entry = nodes.get(key)
    let fresh = false
    if (!entry) {
      const el = document.createElement('div')
      el.className = cls
      el.dataset.key = key
      entry = { el, rev: -1 }
      nodes.set(key, entry)
      fresh = true
    }
    const el = entry.el
    // Already in place when it is `before` itself or sits right before it.
    if (el !== before && (el.parentElement !== parent || el.nextSibling !== before)) parent.insertBefore(el, before)
    return { el, fresh }
  }

  function prune(parent: HTMLElement, keep: Set<string>): void {
    for (const child of Array.from(parent.children) as HTMLElement[]) {
      const key = child.dataset.key
      if (key && !keep.has(key)) {
        child.remove()
        nodes.delete(key)
        // Everything nested under it is gone too.
        for (const k of Array.from(nodes.keys())) if (!nodes.get(k)!.el.isConnected) nodes.delete(k)
      }
    }
  }

  function setRev(key: string, rev: number): boolean {
    const entry = nodes.get(key)!
    if (entry.rev === rev) return false
    entry.rev = rev
    return true
  }

  // ── Item markup ──────────────────────────────────────────────────────

  function contextExtras(p: Partial<Pick<PromptInput, 'attachments' | 'mentions'>>): string {
    const extras: string[] = []
    for (const a of p.attachments || []) extras.push(`<span class="chat-turn-extra" title="${escapeHtml(a.path)}">${escapeHtml(a.name)}</span>`)
    for (const m of p.mentions || []) extras.push(`<span class="chat-turn-extra chat-turn-mention">@${escapeHtml(m.path)}</span>`)
    return extras.length ? `<div class="chat-turn-extras">${extras.join('')}</div>` : ''
  }

  /** An actor's name in a label: a button selecting its chat while the chat
   *  exists, plain text with a deleted marker once it is gone. */
  function actorHtml(actor: ChatActor | PoiseActor | PersonActor | undefined, ctx: RenderContext): string {
    if (!actor || actor.kind === 'poise' || actor.kind === 'person' || !actor.title) return `<span>${escapeHtml(actorName(actor))}</span>`
    const label = escapeHtml(actorName(actor))
    const tip = escapeHtml(actorTitleAttr(actor))
    if ((ctx.chats || []).some((c) => c.id === actor.sessionId)) {
      return `<button type="button" class="chat-actor-btn" data-chat-session="${escapeHtml(actor.sessionId)}" title="${tip}">${label}</button>`
    }
    return `<span title="${tip}">${label} (deleted)</span>`
  }

  function userPill(turn: TurnModel, ctx: RenderContext): string {
    const p = turn.prompt
    const extrasHtml = contextExtras(p)
    const queued = turn.queueItemId ? `<div class="chat-turn-queued">From queue${turn.agent ? ` · ${escapeHtml(AGENT_LABELS[turn.agent])}` : ''}${turn.model ? ` · ${escapeHtml(consoleModelLabel(turn.model))}` : ''}</div>` : ''
    if (turn.source) {
      if (turn.source.kind === 'timer') {
        const collapsed = turn.source.missed ? ` · ${turn.source.missed} earlier firing${turn.source.missed === 1 ? '' : 's'} collapsed` : ''
        const from = `Timer "${escapeHtml(turn.source.label)}" · set by ${escapeHtml(timerSetterName(turn.source.setBy))}${collapsed}`
        return `${queued}<div class="chat-msg chat-msg-chat"><div class="chat-msg-body"><div class="chat-msg-source">${from}</div>${escapeHtml(p.text)}${extrasHtml}</div></div>`
      }
      const from = turn.source.kind === 'poise'
        ? `From ${escapeHtml(turn.source.name)}`
        : `Message from ${actorHtml(turn.source, ctx)}`
      return `${queued}<div class="chat-msg chat-msg-chat"><div class="chat-msg-body"><div class="chat-msg-source">${from}</div>${escapeHtml(p.text)}${extrasHtml}</div></div>`
    }
    return `${queued}<div class="chat-msg chat-msg-user"><div class="chat-msg-body">${escapeHtml(p.text)}${extrasHtml}</div></div>`
  }

  function copyButton(key: string): string {
    return `<button type="button" class="chat-copy-btn" data-copy="${escapeHtml(key)}" aria-label="Copy message">${ICON_COPY}${ICON_COPIED}</button>`
  }

  // A finished turn's last message has its copy button in the turn's meta row.
  // In an Editor session, a finished turn's last text message renders as edit
  // cards when it parses as the contract; earlier messages render as prose.
  // While the last message streams and starts with `{"chat"`, it shows
  // "Drafting edits…" instead of the partial JSON.
  function textHtml(turn: TurnModel, item: TextItem, final: boolean, ctx: RenderContext, decisions: TranscriptModel['decisions']): string {
    texts.set(item.key, item.text)
    if (ctx.edits && item === lastText(turn)) {
      if (!turn.finished && item.text.trim().startsWith('{"chat"')) {
        return `<div class="chat-msg chat-msg-agent"><div class="chat-msg-body">Drafting edits…</div>${copyButton(item.key)}</div>`
      }
      if (turn.finished) {
        const parsed = tryParseStructuredReply(item.text)
        const review = ctx.edits.surface === 'editor-review'
        if (parsed && (parsed.edits || (review && parsed.reply))) {
          const states = new Map<number, EditDecision>()
          const deciding = new Set<number>()
          const prefix = `${turn.turnId}:${item.messageId}:`
          for (const [at, decision] of decisions) {
            if (!at.startsWith(prefix)) continue
            const index = Number(at.slice(prefix.length))
            if (Number.isSafeInteger(index)) states.set(index, decision)
          }
          for (const [index, edit] of (parsed.edits || []).entries()) {
            if (ctx.edits.applied?.has(`${prefix}${index}`)) states.set(index, 'applied')
            if (ctx.edits.deciding?.has(`${prefix}${index}`)) deciding.add(index)
            cards.set(`${item.key}:${index}`, { turnId: turn.turnId, messageId: item.messageId, index, edit })
          }
          const prose = parsed.chat ? `<div class="chat-msg-body chat-msg-md">${renderMarkdown(parsed.chat, { localFileLinks: !!handlers.onFile })}</div>` : ''
          return `<div class="chat-msg chat-msg-agent chat-msg-final">${prose}`
            + renderEditCards(parsed, item.key, states, { readOnly: ctx.edits.readOnly, review, deciding }) + '</div>'
        }
      }
    }
    return `<div class="chat-msg chat-msg-agent${final ? ' chat-msg-final' : ''}"><div class="chat-msg-body chat-msg-md">${renderMarkdown(item.text, { localFileLinks: !!handlers.onFile })}</div>`
      + `${final ? '' : copyButton(item.key)}</div>`
  }

  function thoughtHtml(item: ThoughtItem, key: string): string {
    const open = ui.get(key)?.expanded
    return `<button type="button" class="chat-thought-toggle" data-toggle="${escapeHtml(key)}" aria-expanded="${open ? 'true' : 'false'}">${ICON_CHEV} Thinking…</button>`
      + `<div class="chat-thought-body"${open ? '' : ' hidden'}>${escapeHtml(item.text)}</div>`
  }

  function statusIcon(status: ToolStatus): string {
    if (status === 'completed') return `<span class="chat-tool-status ok">${ICON_CHECK}</span>`
    if (status === 'failed' || status === 'cancelled') return `<span class="chat-tool-status bad">${ICON_CROSS}</span>`
    return `<span class="chat-tool-status run">${ICON_SPIN}</span>`
  }

  function elapsedText(tool: ToolItem): string {
    if (tool.status === 'running' || tool.status === 'pending') return fmtSeconds(Date.now() - tool.startedAt)
    const ms = tool.durationMs ?? ((tool.finishedAt ?? Date.now()) - tool.startedAt)
    return fmtSeconds(ms)
  }

  function terminalHtml(block: { text: string, exitCode?: number | null, truncated?: boolean }, key: string, idx: number): string {
    const lines = block.text.split('\n').length
    const showAll = ui.get(`${key}#${idx}`)?.showAll
    const capped = lines > TERMINAL_CAP_LINES && !showAll
    const exit = block.exitCode !== undefined && block.exitCode !== null ? `<span class="chat-tool-exit${block.exitCode ? ' bad' : ''}">exit ${block.exitCode}</span>` : ''
    const trunc = block.truncated ? '<span class="chat-tool-exit">truncated</span>' : ''
    return `<div class="chat-tool-term-wrap"><pre class="chat-tool-term${capped ? ' capped' : ''}">${escapeHtml(block.text)}</pre>`
      + `<div class="chat-tool-term-foot">${exit}${trunc}${capped ? `<button type="button" class="chat-tool-showall" data-showall="${escapeHtml(key)}#${idx}">Show all (${lines} lines)</button>` : ''}</div></div>`
  }

  function unifiedHtml(text: string): string {
    return `<pre class="chat-diff-unified">${text.split('\n').map((line) => {
      const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''
      return `<span class="chat-diff-line${cls ? ' ' + cls : ''}">${escapeHtml(line)}</span>`
    }).join('\n')}</pre>`
  }

  // A diff is a record of what the agent did, not a proposal: the only action
  // is Revert, and only for diffs the runtime recorded with a diffId.
  function diffHtml(d: DiffModel, revertable = true): string {
    const marker = !d.oldExists ? '<span class="chat-diff-marker">new file</span>'
      : !d.newExists ? '<span class="chat-diff-marker del">deleted</span>' : ''
    let body: string
    if (d.unified) body = unifiedHtml(d.newText || d.oldText)
    else {
      const oldRow = d.oldText ? `<div class="chat-edit-card-old"><span class="chat-edit-card-mark" aria-hidden="true">−</span><span class="chat-edit-card-text">${escapeHtml(d.oldText)}</span></div>` : ''
      const newRow = d.newText ? `<div class="chat-edit-card-new"><span class="chat-edit-card-mark" aria-hidden="true">+</span><span class="chat-edit-card-text">${escapeHtml(d.newText)}</span></div>` : ''
      body = oldRow + newRow
    }
    if (d.previewOnly) {
      const load = d.diffId && handlers.onLoadDiff
        ? `<button type="button" class="chat-edit-card-btn" data-load-diff="${escapeHtml(d.diffId)}"${d.loadingFull ? ' disabled' : ''}>${d.loadingFull ? 'Loading complete diff…' : 'Load complete diff'}</button>` : ''
      body += `<div class="chat-tool-label">Large diff preview. Load the complete record before reverting.</div>${load}${d.loadError ? `<div class="chat-tool-label">${escapeHtml(d.loadError)}</div>` : ''}`
    }
    let actions = ''
    if (revertable) {
      let action: string
      const r = d.revert
      if (!r) action = `<button type="button" class="chat-edit-card-btn chat-revert-btn" data-revert="${escapeHtml(d.diffId)}"${d.previewOnly ? ' disabled title="Load the complete diff before reverting"' : ''}>Revert</button>`
      else if (r.state === 'reverting') action = '<span class="chat-edit-card-badge chat-edit-card-badge-declined">Reverting…</span>'
      else if (r.state === 'reverted') action = '<span class="chat-edit-card-badge chat-edit-card-badge-applied">Reverted</span>'
      else action = `<span class="chat-edit-card-badge chat-edit-card-badge-conflict">${escapeHtml(r.error)}</span>`
      actions = `<div class="chat-edit-card-actions">${action}</div>`
    }
    return `<div class="chat-edit-card chat-diff" data-diff="${escapeHtml(d.diffId)}">`
      + `<div class="chat-edit-card-desc chat-diff-path"><code>${escapeHtml(d.path)}</code>${marker}</div>${body}${actions}</div>`
  }

  function toolHtml(tool: ToolItem): string {
    const open = ui.get(tool.key)?.expanded
    const running = tool.status === 'running' || tool.status === 'pending'
    const head = `<button type="button" class="chat-tool-head" data-toggle="${escapeHtml(tool.key)}" aria-expanded="${open ? 'true' : 'false'}">`
      + `<span class="chat-tool-icon" data-kind="${tool.toolKind}">${ICONS[tool.toolKind] || ICONS.other}</span>`
      + `<span class="chat-tool-title">${escapeHtml(tool.title)}</span>`
      + `<span class="chat-tool-elapsed" data-started="${tool.startedAt}">${elapsedText(tool)}</span>`
      + statusIcon(tool.status) + '</button>'
    let body = ''
    if (open) {
      const parts: string[] = []
      if (tool.input !== undefined) parts.push(`<div class="chat-tool-section"><div class="chat-tool-label">Input</div><pre class="chat-tool-pre">${preview(tool.input)}</pre></div>`)
      const blocks = tool.content.map((b, idx) => {
        if (b.type === 'terminal') return terminalHtml(b, tool.key, idx)
        if (b.type === 'diff') return diffHtml({ diffId: '', path: b.path, oldText: b.oldText, newText: b.newText, oldExists: true, newExists: true, unified: false, previewOnly: b.previewOnly }, false)
        return `<div class="chat-tool-text">${renderMarkdown(b.text, { localFileLinks: !!handlers.onFile })}</div>`
      })
      if (blocks.length) parts.push(`<div class="chat-tool-section"><div class="chat-tool-label">Output</div>${blocks.join('')}</div>`)
      if (tool.diffs.length) parts.push(`<div class="chat-tool-section"><div class="chat-edit-cards">${tool.diffs.map((d) => diffHtml(d)).join('')}</div></div>`)
      if (tool.locations?.length) parts.push(`<div class="chat-tool-section chat-tool-locs">${tool.locations.map((l) => `<code>${escapeHtml(l.path)}${l.line ? ':' + l.line : ''}</code>`).join(' ')}</div>`)
      body = `<div class="chat-tool-body">${parts.join('')}</div>`
    }
    return `<div class="chat-tool${running ? ' running' : ''}" data-status="${tool.status}">${head}${body}</div>`
  }

  function readGroupHtml(key: string, tools: ToolItem[]): string {
    const open = ui.get(key)?.expanded
    const head = `<button type="button" class="chat-tool-head" data-toggle="${escapeHtml(key)}" aria-expanded="${open ? 'true' : 'false'}">`
      + `<span class="chat-tool-icon" data-kind="read">${ICONS.read}</span>`
      + `<span class="chat-tool-title">read ${tools.length} files</span>`
      + `<span class="chat-tool-status ok">${ICON_CHECK}</span></button>`
    const body = open ? `<div class="chat-tool-body"><ul class="chat-read-list">${tools.map((t) => `<li>${escapeHtml(t.title)}</li>`).join('')}</ul></div>` : ''
    return `<div class="chat-tool chat-read-group" data-status="completed">${head}${body}</div>`
  }

  function planHtml(item: PlanItem): string {
    const rows = item.entries.map((e) => `<li class="chat-plan-entry" data-status="${e.status}"><span class="chat-plan-mark" aria-hidden="true">${e.status === 'completed' ? ICON_CHECK : e.status === 'in_progress' ? ICON_SPIN : ''}</span><span>${escapeHtml(e.content)}</span></li>`).join('')
    return `<div class="chat-card chat-plan"><div class="chat-card-title">Plan</div>${item.explanation ? `<div class="chat-card-desc">${escapeHtml(item.explanation)}</div>` : ''}<ul class="chat-plan-list">${rows}</ul></div>`
  }

  function permissionHtml(item: PermissionItem, focused: boolean): string {
    const desc = item.description ? `<div class="chat-card-desc">${escapeHtml(item.description)}</div>` : ''
    const input = item.input !== undefined ? `<pre class="chat-tool-pre">${preview(item.input, 600)}</pre>` : ''
    let actions: string
    if (!item.resolved) {
      actions = `<div class="chat-card-actions">${item.options.map((o, i) =>
        `<button type="button" class="chat-card-btn" data-permission="${escapeHtml(item.id)}" data-option="${escapeHtml(o.id)}" data-kind="${o.kind}">`
        + `<span class="chat-card-key">${i + 1}</span>${escapeHtml(o.name)}</button>`).join('')}</div>`
    } else {
      const chosen = item.options.find((o) => o.id === item.resolved!.optionId)
      const label = item.resolved.by === 'cancelled' ? 'Cancelled' : `${chosen ? chosen.name : item.resolved.optionId}${item.resolved.by === 'session' ? ' (remembered)' : item.resolved.by === 'auto_merge' ? ' (auto-merge)' : item.resolved.by === 'unrestricted' ? ' (unrestricted)' : ''}`
      const cls = chosen && chosen.kind.startsWith('allow') ? 'chat-edit-card-badge-applied' : 'chat-edit-card-badge-declined'
      actions = `<div class="chat-card-actions"><span class="chat-edit-card-badge ${cls}">${escapeHtml(label)}</span></div>`
    }
    return `<div class="chat-card chat-permission${item.resolved ? ' resolved' : ' pending'}${focused ? ' focused' : ''}" data-request="${escapeHtml(item.id)}">`
      + `<div class="chat-card-title">Permission · ${escapeHtml(item.title)}</div>${desc}${input}${actions}</div>`
  }

  function answerLabel(answered: NonNullable<QuestionItem['answered']>, ctx: RenderContext): string {
    if (answered.by === 'cancelled') return 'Cancelled'
    if (answered.by === 'user') return 'Answered'
    return `Answered by ${actorHtml(answered.source, ctx)}`
  }

  function questionHtml(item: QuestionItem, focused: boolean, ctx: RenderContext): string {
    const qs = item.questions.map((q, qi) => {
      const answered = item.answered?.answers[q.id]
      const opts = q.options.map((o, oi) => {
        const type = q.multiSelect ? 'checkbox' : 'radio'
        const checked = answered !== undefined && (Array.isArray(answered) ? answered.includes(o.label) : answered === o.label)
        return `<label class="chat-q-option"><input type="${type}" name="q-${escapeHtml(item.id)}-${qi}" value="${escapeHtml(o.label)}"${checked ? ' checked' : ''}${item.answered ? ' disabled' : ''}>`
          + `<span class="chat-card-key">${oi + 1}</span><span>${escapeHtml(o.label)}</span>${o.description ? `<span class="chat-q-desc">${escapeHtml(o.description)}</span>` : ''}</label>`
      }).join('')
      const free = q.freeText
        ? `<input type="text" class="chat-q-text" name="free-${escapeHtml(item.id)}-${qi}" placeholder="Type an answer…" aria-label="Answer"${item.answered ? ` value="${escapeHtml(typeof answered === 'string' && !q.options.some((o) => o.label === answered) ? answered : '')}" disabled` : ''}>`
        : ''
      return `<div class="chat-q" data-qid="${escapeHtml(q.id)}" data-multi="${q.multiSelect ? '1' : '0'}">${q.header ? `<div class="chat-card-title">${escapeHtml(q.header)}</div>` : ''}<div class="chat-q-text-body">${escapeHtml(q.question)}</div><div class="chat-q-options">${opts}</div>${free}</div>`
    }).join('')
    const actions = item.answered
      ? `<div class="chat-card-actions"><span class="chat-edit-card-badge chat-edit-card-badge-applied">${answerLabel(item.answered, ctx)}</span></div>`
      : `<div class="chat-card-actions"><button type="button" class="chat-card-btn chat-q-submit" data-question="${escapeHtml(item.id)}">Submit</button></div>`
    return `<div class="chat-card chat-question${item.answered ? ' resolved' : ' pending'}${focused ? ' focused' : ''}" data-request="${escapeHtml(item.id)}">${qs}${actions}</div>`
  }

  // The visible time is short. The full one is what a screen reader reads and
  // what the tooltip shows on hover or keyboard focus; the ARIA 1.3 draft
  // prohibits naming the time role with aria-label.
  function timeHtml(f: NonNullable<TurnModel['finished']>, clock: Clock): string {
    const time = turnTime(f.at, f.stopReason, clock.zone, clock.now)
    return `<time class="chat-turn-time" datetime="${escapeHtml(f.at)}" tabindex="0" data-help="${escapeHtml(time.label)}">`
      + `<span aria-hidden="true">${escapeHtml(time.text)}</span><span class="chat-turn-time-label">${escapeHtml(time.label)}</span></time>`
  }

  // One meta row: when the turn ended, how it stopped, what it took, and the
  // copy button of its last message.
  function footerHtml(turn: TurnModel, ctx: RenderContext, clock: Clock, final: TextItem | undefined): string {
    const parts: string[] = []
    const f = turn.finished
    if (f) {
      parts.push(timeHtml(f, clock))
      if (f.stopReason !== 'end_turn') {
        if (f.stopReason === 'cancelled' && f.stoppedBy) {
          parts.push(`<span class="chat-turn-stop">Stopped by ${actorHtml(f.stoppedBy, ctx)}</span>`)
        } else {
          const label = f.stopReason === 'error' ? `Error: ${f.error || 'unknown'}` : STOP_LABEL[f.stopReason]
          parts.push(`<span class="chat-turn-stop${f.stopReason === 'error' ? ' bad' : ''}">${escapeHtml(label)}</span>`)
        }
      }
      if (ctx.showActivity !== false && f.durationMs !== undefined) parts.push(`<span>${fmtDuration(f.durationMs)}</span>`)
      const total = f.usage?.totalTokens ?? ((f.usage?.inputTokens ?? 0) + (f.usage?.outputTokens ?? 0) || undefined)
      if (ctx.showActivity !== false && total) parts.push(`<span>${total.toLocaleString()} tokens</span>`)
    } else if (ctx.interruptedTurnId === turn.turnId) {
      parts.push('<span class="chat-turn-stop">Interrupted</span>')
    }
    return parts.length ? `<div class="chat-turn-footer">${parts.join('<span class="chat-turn-dot">·</span>')}${final ? copyButton(final.key) : ''}</div>` : ''
  }

  // ── Render ───────────────────────────────────────────────────────────

  function rememberQuestion(node: HTMLElement, key: string): void {
    if (!node.classList.contains('chat-item-question') || !node.querySelector('.chat-question.pending')) return
    const answers = [...node.querySelectorAll<HTMLInputElement>('input')].map(input =>
      ({ name: input.name, type: input.type, value: input.value, checked: input.checked }))
    ui.set(key, { ...ui.get(key), answers })
  }

  function restoreQuestion(node: HTMLElement, key: string): void {
    if (!node.querySelector('.chat-question.pending')) return
    const answers = ui.get(key)?.answers || []
    for (const input of node.querySelectorAll<HTMLInputElement>('input')) {
      const saved = answers.find(answer => answer.name === input.name && answer.type === input.type
        && (input.type === 'text' || answer.value === input.value))
      if (!saved) continue
      if (input.type === 'text') input.value = saved.value
      else input.checked = saved.checked
    }
  }

  function renderTurn(el: HTMLElement, turn: TurnModel, ctx: RenderContext, clock: Clock, focused: PermissionItem | QuestionItem | null, isLast: boolean, repaintActors: boolean, repaintEdits: boolean, decisions: TranscriptModel['decisions']): void {
    let head = el.querySelector<HTMLElement>(':scope > .chat-turn-head')
    let items = el.querySelector<HTMLElement>(':scope > .chat-turn-items')
    let foot = el.querySelector<HTMLElement>(':scope > .chat-turn-foot')
    if (!head || !items || !foot) {
      el.innerHTML = '<div class="chat-turn-head"></div><div class="chat-turn-items"></div><div class="chat-turn-foot"></div>'
      head = el.querySelector<HTMLElement>(':scope > .chat-turn-head')!
      items = el.querySelector<HTMLElement>(':scope > .chat-turn-items')!
      foot = el.querySelector<HTMLElement>(':scope > .chat-turn-foot')!
    }
    const headHtml = userPill(turn, ctx)
    if (head.dataset.html !== headHtml) { head.innerHTML = headHtml; head.dataset.html = headHtml }

    const keep = new Set<string>()
    const list = renderList(turn)
    const final = turn.finished ? lastText(turn) : undefined
    let cursor = items.firstElementChild as HTMLElement | null
    for (const item of list) {
      keep.add(item.key)
      const { el: node, fresh } = ensure(items, item.key, cursor, `chat-item chat-item-${item.kind}`)
      const focusedHere = focused !== null && (item.kind === 'permission' || item.kind === 'question') && item.id === focused.id
      // Expansion, and becoming a finished turn's last message, change markup;
      // request focus is only a CSS class. Rebuilding a form on focus changes
      // would erase a partially typed answer.
      const uiRev = (ui.get(item.key)?.expanded ? 1 : 0)
      const rev = item.rev * 4 + uiRev + (item === final ? 2 : 0)
      // Actor labels follow the session list: a rename, delete or reload
      // repaints the items that carry one. Drafts survive: questions
      // remember and restore theirs around the repaint.
      const actorItem = (item.kind === 'steer' && !!item.source) || (item.kind === 'question' && item.answered?.by === 'chat')
      if ((repaintActors && actorItem) || (repaintEdits && item.kind === 'text') || setRev(item.key, rev) || (item.kind === 'tool' && node.childElementCount === 0)) {
        const paint = () => {
        switch (item.kind) {
          case 'text': patchContent(node, textHtml(turn, item, item === final, ctx, decisions)); break
          case 'thought': patchContent(node, thoughtHtml(item, item.key)); break
          case 'tool': patchContent(node, toolHtml(item)); break
          case 'readgroup': patchContent(node, readGroupHtml(item.key, item.tools)); break
          case 'plan': patchContent(node, planHtml(item)); break
          case 'permission': patchContent(node, permissionHtml(item, focusedHere)); break
          case 'question':
            rememberQuestion(node, item.key)
            patchContent(node, questionHtml(item, focusedHere, ctx))
            restoreQuestion(node, item.key)
            break
          case 'steer': node.innerHTML = item.source
            ? `<div class="chat-msg chat-msg-chat chat-msg-steer"><div class="chat-msg-body"><span class="chat-msg-mode-tag">steer</span> <span class="chat-msg-from">from ${actorHtml(item.source, ctx)}</span> ${escapeHtml(item.text)}${contextExtras(item)}</div></div>`
            : `<div class="chat-msg chat-msg-user chat-msg-steer"><div class="chat-msg-body"><span class="chat-msg-mode-tag">steer</span>${escapeHtml(item.text)}${contextExtras(item)}</div></div>`; break
          case 'error': node.innerHTML = `<div class="chat-msg chat-msg-agent chat-msg-error"><div class="chat-msg-body">${escapeHtml(item.message)}</div></div>`; break
        }
        }
        if (disclosures.delete(item.key)) resizeContent(node, paint)
        else paint()
        if (fresh && item.kind !== 'text') reveal(node, { distance: 8 })
      }
      if (item.kind === 'question' && item.answered && ui.has(item.key)) delete ui.get(item.key)!.answers
      if (item.kind === 'question' || item.kind === 'permission') node.firstElementChild?.classList.toggle('focused', focusedHere)
      // Hide rather than destroy detail: preserve tool expansion, forms and
      // live updates. Requests requiring a response and errors stay visible.
      const internalReminder = ctx.agent === 'muse' && item.kind === 'tool'
        && item.toolKind === 'other' && item.title === 'Reminder child session'
        && item.input === undefined && !item.diffs.length && !item.locations?.length
      const activity = item.kind === 'tool' || item.kind === 'readgroup' || item.kind === 'plan'
        || (item.kind === 'permission' && !!item.resolved) || (item.kind === 'question' && !!item.answered)
      const toolCall = item.kind === 'tool' || item.kind === 'readgroup'
      node.hidden = internalReminder || (item.kind === 'thought' ? ctx.showReasoning !== true : ctx.showActivity === false && activity)
        || (ctx.showTools === false && toolCall)
      cursor = node.nextElementSibling as HTMLElement | null
    }
    prune(items, keep)

    // Dots under the running turn, which is always the last one: at the
    // bottom of the transcript for the whole turn, including long tool runs.
    const dots = isLast && ctx.running && !turn.finished
    let dotsEl = el.querySelector<HTMLElement>(':scope > .chat-turn-dots')
    if (dots && !dotsEl) {
      dotsEl = document.createElement('div')
      dotsEl.className = 'chat-turn-dots'
      dotsEl.innerHTML = '<div class="chat-thinking"><span></span><span></span><span></span></div>'
      el.insertBefore(dotsEl, foot)
    } else if (!dots && dotsEl) dotsEl.remove()

    const footHtml = footerHtml(turn, ctx, clock, final)
    if (foot.dataset.html !== footHtml) { foot.innerHTML = footHtml; foot.dataset.html = footHtml }
  }

  function render(model: TranscriptModel, ctx: RenderContext): void {
    swapDrafts(ctx.sessionId || '')
    const focused = focusedPending(model)
    const clock: Clock = { zone: effectiveTimezone(), now: Date.now() }
    // A new day or time zone relabels every turn's time.
    renderedDay = clockDay(clock.zone, clock.now)
    // Actor labels follow the session list: a rename, delete or reload
    // re-renders them without any new transcript event.
    const chatsKey = (ctx.chats || []).map((c) => `${c.id}\n${c.role || ''}\n${c.title}`).join('\n')
    const ctxKey = `${ctx.running ? 1 : 0}:${ctx.interruptedTurnId || ''}:${focused?.id || ''}:${ctx.showActivity !== false}:${ctx.showReasoning === true}:${ctx.showTools !== false}:${ctx.agent || ''}:${renderedDay}:${chatsKey}:${ctx.edits ? `${ctx.edits.surface}:${ctx.edits.readOnly ? 'ro' : 'rw'}:${ctx.edits.revision ?? 0}` : ''}`
    const ctxChanged = ctxKey !== lastCtxKey
    lastCtxKey = ctxKey
    const chatsChanged = chatsKey !== lastChatsKey
    lastChatsKey = chatsKey
    const keep = new Set<string>()
    let cursor = container.firstElementChild as HTMLElement | null
    let lastTurnKey = ''
    for (const b of model.blocks) if (b.kind === 'turn') lastTurnKey = b.key
    for (const b of model.blocks) {
      keep.add(b.key)
      const { el, fresh } = ensure(container, b.key, cursor, b.kind === 'turn' ? 'chat-turn' : `chat-block chat-block-${b.kind}`)
      if (b.kind === 'turn') {
        // The running flag and the focused request only affect the last turn
        // and the turn holding the request; both sit in the item revisions,
        // so a turn renders when its rev moved or the context did.
        const isLast = b.key === lastTurnKey
        if (setRev(b.key, b.turn.rev) || ctxChanged || isLast) renderTurn(el, b.turn, b.turn.agent ? { ...ctx, agent: b.turn.agent } : ctx, clock, focused, isLast, chatsChanged, ctxChanged && !!ctx.edits, model.decisions)
      } else if (setRev(b.key, b.rev)) {
        if (b.kind === 'error') {
          el.innerHTML = `<div class="chat-msg chat-msg-agent chat-msg-error"><div class="chat-msg-body">${escapeHtml(b.message)}</div></div>`
        } else if (b.kind === 'imported') {
          el.innerHTML = renderImportedHtml(b.turns, b.omitted, false)
        } else if (b.kind === 'content') {
          el.innerHTML = contentCardHtml(b, contentState.get(b.key))
          pollContent(b, model)
        } else if (b.kind === 'consensus') {
          el.innerHTML = consensusCardHtml(b)
        } else {
          el.innerHTML = `<div class="chat-note">${escapeHtml(b.text)}</div>`
        }
      }
      if (fresh) reveal(el, { distance: 8 })
      cursor = el.nextElementSibling as HTMLElement | null
    }
    prune(container, keep)
  }

  function clear(): void {
    for (const [key, node] of nodes) rememberQuestion(node.el, key)
    stopContentPolls()
    container.innerHTML = ''
    nodes.clear()
    texts.clear()
    cards.clear()
    lastCtxKey = ''
    lastChatsKey = ''
    renderedDay = ''
  }

  function tick(): void {
    const now = Date.now()
    // Midnight, or a time zone saved in Settings, relabels turn times without an event.
    if (renderedDay && clockDay(effectiveTimezone(), now) !== renderedDay) container.dispatchEvent(new CustomEvent('chat:rerender'))
    for (const el of container.querySelectorAll<HTMLElement>('.chat-tool.running .chat-tool-elapsed')) {
      const started = Number(el.dataset.started)
      if (!Number.isFinite(started)) continue
      const next = fmtSeconds(now - started)
      if (el.textContent !== next) el.textContent = next
    }
  }

  function persistQuestionDrafts(): void {
    for (const [key, node] of nodes) rememberQuestion(node.el, key)
    stashDrafts()
    // Merge with the other transcript's sessions: read, set ours, write.
    let merged: Record<string, DraftRow[]> = {}
    try {
      const saved = JSON.parse(sessionStorage.getItem(questionDraftKey) || '{}')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) merged = saved as Record<string, DraftRow[]>
    } catch { /* keep ours alone */ }
    for (const [session, rows] of draftStore) merged[session] = rows
    if (draftSession !== null && !draftStore.has(draftSession)) delete merged[draftSession]
    try { sessionStorage.setItem(questionDraftKey, JSON.stringify(merged)) } catch { /* in-page state is still retained */ }
  }
  window.addEventListener('beforeunload', persistQuestionDrafts)
  window.addEventListener('pagehide', persistQuestionDrafts)

  // ── Interaction ──────────────────────────────────────────────────────

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const article = target.closest<HTMLButtonElement>('.chat-content-open')
    if (article?.dataset.slug) {
      window.dispatchEvent(new CustomEvent('poise:open-editor-doc', { detail: { slug: article.dataset.slug } }))
      return
    }
    const file = target.closest<HTMLAnchorElement>('a[data-chat-file]')
    if (file && handlers.onFile) {
      e.preventDefault()
      // Native dialog restoration needs the clicked link focused in WebKit too.
      file.focus({ preventScroll: true })
      handlers.onFile(file.dataset.chatFile!)
      return
    }
    const toggle = target.closest<HTMLElement>('[data-toggle]')
    if (toggle) {
      const key = toggle.dataset.toggle!
      const state = ui.get(key) || {}
      state.expanded = !state.expanded
      disclosures.add(key)
      ui.set(key, state)
      // Re-render just this node from its current markup state: flip the
      // revision so the next render rewrites it, and ask for one now.
      const entry = nodes.get(key)
      if (entry) entry.rev = -1
      container.dispatchEvent(new CustomEvent('chat:rerender'))
      return
    }
    const showAll = target.closest<HTMLElement>('[data-showall]')
    if (showAll) {
      const id = showAll.dataset.showall!
      ui.set(id, { ...(ui.get(id) || {}), showAll: true })
      const entry = nodes.get(id.split('#')[0])
      if (entry) entry.rev = -1
      container.dispatchEvent(new CustomEvent('chat:rerender'))
      return
    }
    const copy = target.closest<HTMLButtonElement>('[data-copy]')
    if (copy) {
      const text = texts.get(copy.dataset.copy!) || ''
      void copyText(text).then((ok) => {
        if (!ok) return
        copy.classList.add('is-copied')
        copy.setAttribute('aria-label', 'Copied')
        window.setTimeout(() => {
          copy.classList.remove('is-copied')
          copy.setAttribute('aria-label', 'Copy message')
        }, 1500)
      })
      return
    }
    const chat = target.closest<HTMLButtonElement>('[data-chat-session]')
    if (chat) {
      handlers.onSelectSession?.(chat.dataset.chatSession!)
      return
    }
    const perm = target.closest<HTMLButtonElement>('[data-permission]')
    if (perm) {
      handlers.onPermission(perm.dataset.permission!, perm.dataset.option!)
      return
    }
    const submit = target.closest<HTMLButtonElement>('[data-question]')
    if (submit) {
      const card = submit.closest<HTMLElement>('.chat-question')!
      handlers.onQuestion(submit.dataset.question!, collectAnswers(card))
      return
    }
    const loadDiff = target.closest<HTMLButtonElement>('[data-load-diff]')
    if (loadDiff) {
      handlers.onLoadDiff?.(loadDiff.dataset.loadDiff!)
      return
    }
    const revert = target.closest<HTMLButtonElement>('[data-revert]')
    if (revert) {
      handlers.onRevert(revert.dataset.revert!)
      return
    }
    const accept = target.closest<HTMLButtonElement>('[data-edit-accept]')
    const decline = target.closest<HTMLButtonElement>('[data-edit-decline]')
    if (accept || decline) {
      const key = (accept || decline)!.closest<HTMLElement>('.chat-edit-card')?.dataset.cardKey
      const found = key ? cards.get(key) : undefined
      if (found) handlers.onEditDecide?.(found.turnId, found.messageId, found.index, accept ? 'applied' : 'declined', found.edit)
      return
    }
    const openEditor = target.closest<HTMLButtonElement>('[data-open-in-editor]')
    if (openEditor) {
      handlers.onOpenInEditor?.()
      return
    }
    const useReply = target.closest<HTMLButtonElement>('[data-use-suggested-reply]')
    if (useReply) {
      handlers.onSuggestedReply?.(useReply.dataset.reply || '')
      return
    }
  })

  // Edit-card hover highlights the card's target in the document. Enter/leave
  // semantics across the card's children, so a move between tracks does not
  // flicker. Cards without an opaque key (the suggested reply) never hover.
  container.addEventListener('mouseover', (e) => {
    if (!handlers.onEditHover) return
    const card = (e.target as HTMLElement).closest?.('.chat-edit-card') as HTMLElement | null
    const from = (e.relatedTarget as HTMLElement | null)?.closest?.('.chat-edit-card')
    if (card && card !== from && card.dataset.cardKey && cards.has(card.dataset.cardKey)) handlers.onEditHover(editFromCard(card))
  })
  container.addEventListener('mouseout', (e) => {
    if (!handlers.onEditLeave) return
    const card = (e.target as HTMLElement).closest?.('.chat-edit-card')
    const to = (e.relatedTarget as HTMLElement | null)?.closest?.('.chat-edit-card')
    if (card && card !== to) handlers.onEditLeave()
  })

  function collectAnswers(card: HTMLElement): Record<string, string | string[]> {
    const answers: Record<string, string | string[]> = {}
    for (const q of card.querySelectorAll<HTMLElement>('.chat-q')) {
      const qid = q.dataset.qid!
      const multi = q.dataset.multi === '1'
      const picked = Array.from(q.querySelectorAll<HTMLInputElement>('input:checked')).map((i) => i.value)
      const free = q.querySelector<HTMLInputElement>('.chat-q-text')?.value.trim() || ''
      if (multi) answers[qid] = free ? [...picked, free] : picked
      else answers[qid] = free || picked[0] || ''
    }
    return answers
  }

  function destroy(): void {
    destroyed = true
    stopContentPolls()
    persistQuestionDrafts()
    window.removeEventListener('beforeunload', persistQuestionDrafts)
    window.removeEventListener('pagehide', persistQuestionDrafts)
  }

  return { render, clear, tick, textFor: (key) => texts.get(key) || '', destroy }
}

/** Pick the nth option of a question card from the keyboard (first unanswered question). */
export function pickQuestionOption(container: HTMLElement, requestId: string, n: number): boolean {
  const card = container.querySelector<HTMLElement>(`.chat-question[data-request="${CSS.escape(requestId)}"]`)
  if (!card) return false
  const q = Array.from(card.querySelectorAll<HTMLElement>('.chat-q')).find((el) => !el.querySelector('input:checked'))
    || card.querySelector<HTMLElement>('.chat-q')
  if (!q) return false
  const inputs = q.querySelectorAll<HTMLInputElement>('.chat-q-option input')
  const input = inputs[n - 1]
  if (!input) return false
  input.checked = input.type === 'checkbox' ? !input.checked : true
  return true
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
