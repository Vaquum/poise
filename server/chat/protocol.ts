// Chat v1 wire contract — one vocabulary for the runtime, the adapters and the
// browser. ACP-shaped because Grok speaks ACP natively and the other three
// agents map onto it with little loss. These objects go over the WebSocket
// unchanged and are what the SQLite transcript mirror stores, so this file has
// no runtime imports: the client bundles it as types only.
//
// Every event the runtime emits for a session is appended to `chat_events`
// with a strictly increasing `seq`; a browser that reconnects asks for
// everything after the last `seq` it acknowledged and renders the transcript
// from the mirror alone — the agent is never woken to show history.

import type { ChatSwitches } from '../../src/chat-switches'
import type { SelfChange } from '../../src/self-update-types'

export type AgentId = 'claude' | 'codex' | 'grok' | 'muse'

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'grok', 'muse']

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok Build',
  muse: 'Muse',
}

/** Why a Poise-local turn is `queued` while it waits for a free agent slot —
 *  distinct from queueing behind another checkout holder. */
export const SLOT_WAIT_REASON = 'waiting for a free agent slot'

/** Which optional controls the view shows for a session. `permissions`,
 *  `questions`, `steer` and `resume` are required of every v1 adapter; the
 *  rest are honest flags — a control for a false flag is hidden, never faked. */
export interface Capabilities {
  steer: boolean
  fork: boolean
  thought: boolean
  plan: boolean
  commands: boolean
  modes: boolean
  permissions: boolean
  questions: boolean
  resume: boolean
  images: boolean
}

export type SessionStatus =
  | 'starting'
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'stopping'
  | 'interrupted'
  | 'closed'
  | 'error'

export type BranchOrigin = 'new' | 'existing' | 'pr'

export interface BranchBinding {
  /** The branch the session is bound to for its whole life. */
  name: string
  origin: BranchOrigin
  /** Pull request number when `origin === 'pr'`. */
  pr?: number
  /** True while a Poise-created branch has received no commit; such a branch
   *  is deleted together with the session. */
  provisional: boolean
  /** Commit a Poise-created branch started at; the branch is only deleted
   *  while its tip is still exactly this. */
  baseSha?: string
}

/** A queued task is not a native prompt until a preceding turn completes. */
export interface QueuedMessage {
  /** Validated attachment/mention provenance across an isolated Poise handoff. */
  sourceSessionId?: string
  /** Actor whose deferred steer this row continues; dispatched as source
   *  data under that actor, never as the person's request. */
  source?: ChatActor | PoiseActor
  id: string
  prompt: PromptInput
  agent: AgentId
  model: string
  effort: string
  createdAt: string
  state: 'waiting' | 'running' | 'failed'
  turnId?: string
  error?: string
}
export interface MessageQueue {
  executorSessionId?: string
  waitingForRelease?: boolean
  revision: number
  ready: boolean
  items: QueuedMessage[]
}

export interface SessionRecord {
  /** Monotonic reset barrier; earlier transcript events must never reappear. */
  contextResetSeq?: number
  /** A reset has been admitted and is waiting for native work to settle. */
  contextResetting?: boolean
  /** Native compaction is in progress; new tasks wait rather than steer it. */
  contextCompacting?: boolean
  /** Server-owned pending tasks; never copied when a session is forked. */
  queue?: MessageQueue
  /** Live timer summaries; computed on a copy, never stored. */
  timers?: TimerSummary[]
  /** A queued cross-agent handoff survives a startup failure or restart. */
  queuedHandoff?: string
  id: string
  agent: AgentId
  /** Catalog identity, e.g. `opus-5-max`. */
  model: string
  /** Native model selector the adapter launched with, e.g. `claude-opus-5`. */
  modelId: string
  effort: string
  /** `owner/name` of the repository, or `''` for a bare local checkout. */
  repo: string
  /** Absolute canonical path of the checkout the session runs in. */
  checkout: string
  /** `poise-local`: Poise-owned scratch storage. `poise-change`: a checkout
   *  the self-update controller prepared for one `/poise` change; the
   *  session was created by the server, never from a browser repo choice. */
  workspaceKind?: 'poise-local' | 'poise-change'
  /** The self-update change this session implements (`workspaceKind` is
   *  `poise-change`). Its first turn's settlement is reported to the controller. */
  selfChangeId?: string
  /** Immutable attachment/mention identity for retry conflict detection. */
  selfChangeContextKey?: string
  /** User-enabled, session-scoped delegation to finish and merge the requested PRs in any repository. Missing means off. */
  autoMerge?: boolean
  /** Off/missing: unrestricted tools. On: native risk-based approvals, still unsandboxed. */
  safeMode?: boolean
  /** The native process cannot apply the saved choice until its next turn. */
  safeModePending?: boolean
  branch: BranchBinding
  title: string
  /** The person named this chat by hand; automatic titling never overwrites it. */
  titleManual?: boolean
  /** How the latest turn ended; the work-log dot reads a failed turn from it. */
  lastStopReason?: StopReason
  createdAt: string
  updatedAt: string
  status: SessionStatus
  /** Native CLI maintenance is separate from the selected model identity. */
  cliChecking?: boolean
  cliVersion?: string
  cliWarning?: string
  /** Who holds the checkout while this session is `queued`. */
  queuedBehind?: string
  /** Native session/thread id kept for resume. Absent until the adapter created one. */
  nativeSessionId?: string
  capabilities: Capabilities
  mode?: string
  modes?: ModeOption[]
  commands?: CommandOption[]
  /** Efforts the agent advertises for the current model, when it does. */
  efforts?: string[]
  /** Last event sequence written for this session. */
  lastSeq: number
  /** Unanswered permission/question requests, by id. */
  pendingRequests: string[]
  forkedFrom?: string
  /** The chat that created this one through the control create operation, frozen at creation. Never copied by fork. */
  createdBy?: ChatActor
  /** The one workspace Manager. Set at creation; never changes; read from the chat_sessions.role column. */
  role?: 'manager'
  /** The Manager's catalogue model was retired; every turn is refused until set_model picks one. */
  retiredModel?: string
  /** Which Poise server owns the session: `poise-dev:<db>` or `poise-prod:<db>`. */
  instance: string
  /** Set when a turn was cut by a crash or restart and never replayed. */
  interruptedTurnId?: string
  /** Set when the session's worker could not be verified for cleanup. */
  orphanNotice?: string
  /** Optional context handed over at creation (card, document, another session). */
  context?: SessionContext
  /** The subject this session belongs to; at most one session per subject. */
  subject?: ChatSubject
  /** The legacy chat id whose earlier conversation was imported, if any. */
  importedFrom?: string
  /** What the checkout looks like right now, refreshed on every status change. */
  workspace?: WorkspaceState
  /** The Editor document copy this session owns inside its checkout, when it
   *  has document context. Persisted so a restart neither loses the binding
   *  nor mistakes another session's copy for this one's. */
  staged?: StagedDocument
}

/** A session's own copy of an Editor document inside the checkout, at
 *  `.poise-chat/docs/<sessionId>/<slug>.md`. One session, one copy: the path
 *  carries the session id so two sessions on one document never share a file. */
export interface StagedDocument {
  slug: string
  /** Checkout-relative path of the staged copy. */
  path: string
  /** Editor version the copy was taken from. */
  baseVersion: string
  /** sha256 of the staged content, to tell an agent edit from an untouched copy. */
  stagedHash: string
  revision: number
  /** Set when the copy's content was taken from another session's stage (a fork). */
  provenance?: { fromSession: string }
}

export interface WorkspaceState {
  /** Branch currently checked out in the shared checkout. */
  currentBranch: string
  /** True when the checkout is on this session's branch. */
  onBranch: boolean
  /** Uncommitted changes (tracked or untracked, not ignored) in the checkout. */
  dirty: boolean
  dirtyFiles: number
  /** Who holds the checkout lock when it is not this session. */
  lockedBy?: string
  checkedAt: string
}

/** Where a subject's chat starts. `current` is a Current card; later slices
 *  add the Editor surfaces. */
export type SubjectSurface = 'current'

/** What a session belongs to: at most one session per subject in an
 *  instance. The key is opaque after validation and compared exactly. */
export interface ChatSubject { surface: SubjectSurface, key: string, label: string, url?: string }

/** A subject's earlier legacy conversation: prompts quoted as the call log
 *  returns them, newest kept first when the import bound bites. */
export interface LegacyConversation { turns: Array<{ prompt: string, reply: string, at: string, status: string }>, omitted: number }

export interface SessionContext {
  /** `poise-change`: the exact `/poise` request (`body`) and the session it
   *  was typed in (`fromSession`); the server composes the first prompt.
   *  `switchboard`: the observer chat Poise creates for the Switchboard pane;
   *  browsers can never set it. */
  kind: 'card' | 'document' | 'handoff' | 'poise-change' | 'switchboard'
  title: string
  body?: string
  url?: string
  headSha?: string
  /** Editor document slug for `document` context. */
  slug?: string
  /** Source session for an explicit cross-agent handoff or a `/poise` change. */
  fromSession?: string
}

export interface ModeOption { id: string, name: string, description?: string }
export interface CommandOption { name: string, description?: string, hint?: string }

export type ToolKind = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'other'
export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type ContentBlock =
  | { type: 'text', text: string }
  | { type: 'terminal', text: string, exitCode?: number | null, truncated?: boolean }
  | { type: 'diff', path: string, oldText: string, newText: string, previewOnly?: boolean }

export interface ToolLocation { path: string, line?: number }

/** Tool cards are keyed by `turnId + id`: native tool ids can recur across
 *  turns. A `diff` carries its own `diffId` so a Revert always reverses one
 *  recorded change and never a later edit of the same file. `oldExists` /
 *  `newExists` distinguish a created or deleted file from an empty one. */

export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' | 'error' | 'interrupted'

export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export interface PermissionOption { id: string, name: string, kind: PermissionOptionKind }

export interface QuestionOption { label: string, description?: string }

export interface Question {
  id: string
  header?: string
  question: string
  options: QuestionOption[]
  multiSelect: boolean
  /** The agent accepts a free-text answer in addition to (or instead of) options. */
  freeText: boolean
}

export interface PlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: 'high' | 'medium' | 'low'
}

/** A chat acting on another chat through the native control. Frozen when the
 *  action happens: `title` is the acting chat's title at that moment, at
 *  most 200 characters, and `role` is copied from its `SessionRecord.role`,
 *  so only the workspace Manager ever renders as the Manager. */
export interface ChatActor { kind: 'chat', sessionId: string, title: string, role?: 'manager' }
/** Poise itself acting on a chat: supervision, the work monitor, or a relay. */
export interface PoiseActor { kind: 'poise', name: string }
/** The person, acting from the browser: a Stop, a hold, or a timer they set. */
export interface PersonActor { kind: 'person' }
/** What started a turn the person did not start: a chat, Poise, or a timer.
 *  `seq` is the delivered inbox row, absent for a deferred steer. Timer
 *  sources retain the required delivered inbox row and firing metadata. */
export type TurnSource = ((ChatActor | PoiseActor) & { seq?: number })
  | { kind: 'timer', timerId: string, label: string, setBy: ChatActor | PersonActor, missed: number, dueAt: string, seq: number }

/** One durable timer on a chat, as the Timers pane and session records show
 *  it. Times are ISO strings; `nextAt` is null once nothing is scheduled. */
export interface TimerSummary {
  id: string
  sessionId: string
  label: string
  /** The message's first 200 code points, then `…` when cut. */
  preview: string
  schedule: { kind: 'once', delayMinutes: number } | { kind: 'every', minutes: number }
  nextAt: string | null
  /** A failed timer waits until this time before its next turn, if set. */
  notBefore: string | null
  state: 'active' | 'held' | 'tripped' | 'done' | 'cancelled' | 'expired'
  reason?: 'person_stopped' | 'person_held' | 'all_held' | 'failed_3_times' | 'completed' | 'turn_failed'
    | 'target_deleted' | 'creator_deleted' | 'cancelled_by_person' | 'cancelled_by_manager' | 'skipped_while_held'
  setBy: ChatActor | PersonActor
  failures: number
  skipped: number
  /** Set while a firing is fired but not yet admitted. */
  pending?: { since: string, missed: number, waitingFor?: 'starting' | 'queued' | 'running' | 'waiting' | 'stopping'
    | 'maintenance' | 'queue' | 'reopening' | 'model' | 'person' | 'update' | 'backoff' }
  createdAt: string
}
/** A timer with its full message: the control `timers` operation and the
 *  person's Timers pane read these, never other chats' summaries. */
export type TimerView = TimerSummary & { message: string }
/** What creating a timer takes: exactly one of the two schedules. */
export interface TimerInput { sessionId: string, label: string, message: string, delayMinutes?: number, everyMinutes?: number }
/** One chat's hold: its timers skip their firings and turns other chats
 *  would start in it wait. `stopped` clears on the person's next message or
 *  Resume; `held` clears only on Resume. */
export interface ChatHold { sessionId: string, cause: 'stopped' | 'held', since: string }

export interface Attachment {
  /** Server-issued id; the record behind it is what a prompt is checked against. */
  id: string
  /** Display name. */
  name: string
  /** Path inside the checkout where the file was saved, relative to the checkout root. */
  path: string
  size: number
  /** Inlined text for text files under the inline limit. */
  text?: string
}

export interface Mention {
  /** Path relative to the checkout root. */
  path: string
}

export interface PromptInput {
  /** Runtime-only appendix; browsers cannot set it. Serialized last by every adapter. */
  memories?: string
  text: string
  attachments: Attachment[]
  mentions: Mention[]
}

// ── Events: runtime → view ────────────────────────────────────────────────

export type ChatEvent =
  | { type: 'session.reset', session: SessionRecord }
  | { type: 'context.compacted', turnId: string, detail: string }
  | { type: 'session.created', session: SessionRecord }
  | { type: 'session.resumed', session: SessionRecord }
  | { type: 'session.updated', session: SessionRecord }
  | { type: 'queue.updated', queue: MessageQueue }
  | { type: 'session.closed', reason: string }
  | { type: 'status.changed', status: SessionStatus, queuedBehind?: string, detail?: string }
  | { type: 'turn.started', turnId: string, prompt: PromptInput, callId?: string, queueItemId?: string, agent?: AgentId, model?: string, source?: TurnSource }
  | { type: 'steer.sent', turnId: string, text: string, attachments?: Attachment[], mentions?: Mention[], source?: ChatActor | PoiseActor }
  | { type: 'turn.finished', turnId: string, stopReason: StopReason, error?: string, usage?: TurnUsage, durationMs?: number, stoppedBy?: ChatActor | PersonActor }
  | { type: 'timer.changed', timer: TimerSummary, change: 'created' | 'cancelled' | 'held' | 'released' | 'tripped' | 'rearmed' | 'ended', by?: ChatActor | PersonActor | PoiseActor, error?: string }
  | { type: 'text.delta', turnId: string, messageId: string, delta: string }
  | { type: 'thought.delta', turnId: string, messageId: string, delta: string }
  | { type: 'tool.started', turnId: string, id: string, kind: ToolKind, title: string, locations?: ToolLocation[], input?: unknown }
  | { type: 'tool.updated', turnId: string, id: string, kind?: ToolKind, title?: string, status?: ToolStatus, content?: ContentBlock[], locations?: ToolLocation[] }
  | { type: 'tool.finished', turnId: string, id: string, status: ToolStatus, content?: ContentBlock[], durationMs?: number }
  | { type: 'diff', turnId: string, toolId: string, diffId: string, path: string, oldText: string, newText: string, oldExists: boolean, newExists: boolean, unified?: boolean, previewOnly?: boolean }
  | { type: 'diff.reverted', diffId: string, path: string, ok: boolean, error?: string }
  | { type: 'plan.updated', turnId: string, entries: PlanEntry[], explanation?: string }
  | { type: 'permission.requested', id: string, turnId: string, toolId?: string, title: string, description?: string, input?: unknown, options: PermissionOption[] }
  | { type: 'permission.resolved', id: string, optionId: string, by: 'user' | 'session' | 'auto_merge' | 'unrestricted' | 'cancelled' }
  | { type: 'question.asked', id: string, turnId: string, toolId?: string, questions: Question[] }
  | { type: 'question.answered', id: string, answers: Record<string, string | string[]>, by: 'user' | 'chat' | 'cancelled', fromSession?: string, source?: ChatActor }
  | { type: 'commands.updated', commands: CommandOption[] }
  | { type: 'mode.updated', mode: string, modes: ModeOption[] }
  | { type: 'model.updated', model: string, modelId: string, effort: string, efforts?: string[] }
  | { type: 'history.imported', legacyId: string, turns: Array<{ prompt: string, reply: string, at: string, status: string }>, omitted: number }
  | { type: 'content.started', topic: string, launchId: string, callId?: string }
  | { type: 'consensus.started', id: string, topic: string }
  | { type: 'consensus.finished', id: string, synthesis?: string, truncated?: boolean, error?: string }
  | { type: 'error', message: string, recoverable: boolean }

export type ChatEventType = ChatEvent['type']

/** One persisted transcript row, as the browser receives it. */
export interface ChatEnvelope {
  seq: number
  sessionId: string
  at: string
  event: ChatEvent
}

// ── Commands: view → runtime ──────────────────────────────────────────────

export type BranchRequest = { new: string } | { existing: string } | { pr: number }

export interface NewSessionRequest {
  agent: AgentId
  /** Catalog identity. */
  model: string
  /** Optional effort override, one of the agent's advertised efforts. */
  effort?: string
  repo?: string
  /** Server-only: bind the new session to this existing checkout instead of
   *  provisioning one (a handoff stays in its source's workspace). Browser
   *  creation routes discard it with repo/branch/path. */
  checkout?: string
  branch?: BranchRequest
  title?: string
  context?: SessionContext
  /** Explicit fallback choice when the default provider is not signed in. */
  fallbackModel?: string
  /** Save queue storage without starting a native session or a turn. */
  deferStart?: boolean
  autoMerge?: boolean
  safeMode?: boolean
  /** Only POST /api/chat/sessions with a browser Origin passes it; never with repo, branch, checkout or context. */
  role?: 'manager'
  /** Create (or adopt) the subject's session instead of a fresh one. */
  subject?: ChatSubject
  /** Skip reading the earlier conversation when creating for a subject. */
  skipLegacy?: boolean
}

export type ChatCommand =
  | { type: 'switch.create', name: string, content: string, revision: number }
  | { type: 'subscribe', sessionId: string, afterSeq: number }
  | { type: 'unsubscribe', sessionId: string }
  | { type: 'session.list' }
  | ({ type: 'session.new' } & NewSessionRequest)
  | { type: 'session.resume', id: string }
  | { type: 'context.reset', sessionId: string }
  | { type: 'session.fork', id: string }
  | { type: 'session.close', id: string }
  | { type: 'session.delete', id: string }
  | { type: 'session.rename', id: string, title: string }
  | { type: 'prompt', sessionId: string, text: string, attachments?: Attachment[], mentions?: Mention[] }
  | { type: 'queue.add', sessionId: string, itemId: string, text: string, attachments?: Attachment[], mentions?: Mention[], model?: string, effort?: string }
  | { type: 'queue.update', sessionId: string, itemId: string, model: string, effort?: string }
  | { type: 'queue.remove', sessionId: string, itemId: string }
  | { type: 'steer', sessionId: string, text: string, attachments?: Attachment[], mentions?: Mention[] }
  | { type: 'cancel', sessionId: string }
  | { type: 'timer.create', sessionId: string, label: string, message: string, delayMinutes?: number, everyMinutes?: number }
  | { type: 'timer.cancel', timerId: string }
  | { type: 'timer.rearm', timerId: string }
  | { type: 'chat.hold', sessionId: string, held: boolean }
  | { type: 'timers.holdAll', held: boolean }
  | { type: 'permission.respond', sessionId: string, id: string, optionId: string }
  | { type: 'question.answer', sessionId: string, id: string, answers: Record<string, string | string[]> }
  | { type: 'set_model', sessionId: string, model: string, effort?: string }
  | { type: 'set_mode', sessionId: string, mode: string }
  | { type: 'set_auto_merge', sessionId: string, enabled: boolean }
  | { type: 'set_safe_mode', sessionId: string, enabled: boolean }
  | { type: 'revert', sessionId: string, diffId: string }
  /** Implement and auto-release one Poise change. Only ever sent by the
   *  browser for a typed `/poise …` message; `changeId` is minted once per
   *  request so a resend after an in-doubt answer never starts a second
   *  change. The ack is a `PoiseChangeAck`. */
  | { type: 'poise.change', sessionId: string, text: string, changeId: string, attachments?: Attachment[], mentions?: Mention[], switches?: string[] }

export interface SafeModeAck { session: SessionRecord, applies: 'current_turn' | 'next_turn', warning?: string }

export interface AutoMergeAck { session: SessionRecord, applies: 'current_turn' | 'next_turn', warning?: string }

export type ChatCommandType = ChatCommand['type']

/** Ack payload of `poise.change`: the dedicated session the change runs in
 *  (already selected model, controller-prepared checkout) and the change. */
export interface PoiseChangeAck { session: SessionRecord, change: SelfChange }

/** Client → server frame. `id` is a client-chosen request id; a frame with an
 *  id the server already answered is answered again from its cache instead of
 *  being executed twice. */
export interface ClientFrame {
  id: string
  command: ChatCommand
}

/** Server → client frames. */
export type ServerFrame =
  | { kind: 'session.created' | 'session.updated', session: SessionRecord }
  | { kind: 'switches.updated', catalogue: ChatSwitches }
  /** The Switchboard's state changed; read it again from `/api/chat/switchboard`. */
  | { kind: 'switchboard.updated', revision: number }
  | { kind: 'ack', id: string, ok: true, result?: unknown }
  | { kind: 'ack', id: string, ok: false, error: string, code?: string }
  | { kind: 'event', envelope: ChatEnvelope }
  | { kind: 'hello', instance: string, serverStartedAt: string }
  | { kind: 'gap', sessionId: string, fromSeq: number, toSeq: number }

/** Error codes a command ack can carry. */
export type ChatErrorCode =
  | 'turn_in_progress'
  | 'no_turn'
  | 'unknown_session'
  | 'foreign_session'
  | 'checkout_busy'
  | 'checkout_dirty'
  | 'unsupported'
  | 'invalid'
  | 'compat'
  | 'agent_error'
  /** Poise is installing an update: new work is refused until it restarts. */
  | 'draining'
  /** `/poise` needs the separately installed self-update controller. */
  | 'self_update_unavailable'
  | 'manager_exists'
  /** The subject's earlier conversation could not be read. */
  | 'legacy_unreadable'

// ── Switchboard: the observer pane (docs/Switchboard.md) ─────────────────

export type SwitchboardKind = 'progress' | 'blocked' | 'done' | 'decision'

/** One of the asking chat's own choices; the open-text answer is not one. */
export interface SwitchboardOption { id: string, label: string, detail: string | null, recommended: boolean }

export interface SwitchboardItem {
  id: number
  kind: SwitchboardKind
  /** The chat the update is about: its live identity, or what it was when deleted. */
  source: { sessionId: string, title: string, agent: AgentId, model: string, exists: boolean
    /** For an open decision: turns the chat has started since it asked. */
    turnsSince?: number }
  /** The transcript event the update rests on. */
  sourceSeq: number
  text: string
  detail: string | null
  createdAt: string
  /** A decision's choices, the asking chat's own, its recommendation first; none means an open question. */
  options?: SwitchboardOption[]
  /** The person's answer to a decision. `relay` follows its delivery to the asking chat; `held`:
   *  that chat is stopped, failed or deleted and takes no message until resumed. */
  answer?: { label: string, freeText: boolean, at: string, relay: 'queued' | 'delivered' | 'held' }
  /** A decision settled in its own chat. */
  resolved?: { at: string, reason: string }
  explanation:
    | { state: 'none' }
    | { state: 'pending', since: string }
    | { state: 'failed', error: string }
    | { state: 'ready', changed: string, matters: string, uncertain: string, at: string }
}

export interface SwitchboardState {
  /** Increases with every change; a lower one is stale. */
  revision: number
  /** `stopped`: its delivery is paused or its chat failed; a restart is needed. */
  status: 'off' | 'live' | 'paused' | 'stopped'
  sessionId: string | null
  sessionStatus: SessionStatus | null
  model: string
  error: string | null
  /** A check is waiting for the Switchboard to finish it. */
  checking: boolean
  lastCheckAt: string | null
  /** What the last finished check's turn cost, when its agent reported usage. */
  lastCheckTokens: number | null
  nextCheckAt: string | null
  /** Chats it observes: every chat of this instance but itself. */
  chats: number
  /** Every open decision and each chat's five newest updates, newest first. */
  items: SwitchboardItem[]
}

export const WS_PATH = '/ws/chat'

/** Recursive canonical form: nested keys count, so two values that differ
 *  below the top level never compare equal. Object key order is normalized;
 *  array order is significant. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as any)[key])}`).join(',')}}`
}

/** Hard bounds shared by the server and the client. */
export const CHAT_LIMITS = {
  frameBytes: 1 * 1024 * 1024,
  promptBytes: 256 * 1024,
  attachmentBytes: 2 * 1024 * 1024,
  inlineAttachmentBytes: 64 * 1024,
  titleChars: 200,
  /** Terminal output kept per tool card; more is truncated with a marker. */
  toolOutputBytes: 256 * 1024,
  /** Events a subscriber can be behind before the server closes the socket. */
  outboundQueue: 2_000,
} as const
