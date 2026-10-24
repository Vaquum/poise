import { prepareProviderCli } from '../provider-clis'
// The Chat v1 session runtime: the session table, one native agent process
// per session, the checkout it runs in, and the transcript mirror.
//
// The runtime owns everything the adapters do not: which branch a session is
// bound to and how the shared checkout follows the active session, the
// per-checkout lease that serializes turns with the other Poise server and
// with Caller's fix-failing-ci, the worker gates every writer runs under,
// the session-scoped permission memory, the Caller row that makes a turn
// visible in Swarm, the staged Editor document, and crash reconciliation on
// startup. Every event a browser sees goes through `emit_()`, which appends
// to SQLite first and broadcasts second — a reload renders from the mirror
// alone, and a transcript that cannot be recorded stops the turn.
//
// Lifecycle rules that matter:
// - a turn is reserved synchronously in `prompt()` before anything is
//   awaited, so two prompts in one tick cannot both be accepted;
// - the checkout lease is held from before the first git mutation until the
//   agent reported the turn finished, every Poise-served file operation
//   returned, and — when the agent misbehaved — its process group is
//   verifiably gone; an orphan keeps the lease and is reported;
// - close/delete cancel and stop outside the per-session operation chain,
//   so they are never queued behind a whole coding turn.

import { readMemories } from './memories'
import { expandSwitches, savedSwitchNames, saveSwitch } from './custom-switches'
import { MANAGER_SWITCH, WORKER_SWITCH } from '../../src/chat-switches'
import { deriveSessionTitle, parseIssueReference, shouldAutoName } from '../../src/chat-title'
import { resolveIssueTitle } from './issue-titles'
import { appendMemories } from './memory-content'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { armQueue, enqueueMessage, transferQueuedContext, readQueue, updateQueuedModel, removeQueuedMessage, pauseQueue, QueueError, queueOwner, delegateQueue } from './message-queue'
import type { MessageQueue, QueuedMessage } from './protocol'
import { autoMergeInstructions, withAutoMergeInstructions } from './auto-merge'
import { steeringContext } from './steering-context'
import { parseChatCommandChain, commandBody } from './commands'
import { latestReviewTarget, prepareReview, type ReviewTarget } from './review'
import { prepareEditorContext, removeEditorContext } from './editor-context'
import { tryParseStructuredReply } from '../../src/edit-proposals'
import type { AutoMergeAck, SafeModeAck } from './protocol'
import { homedir } from 'node:os'
import { lstat, mkdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { loadCatalog, catalogModel, type Catalog, type CatalogModel } from '../models'
import { db, getMeta, setMeta } from '../db'
import { claudeAuth } from '../claude-auth'
import { HttpError } from '../http'
import { diagnostic } from '../logging'
import { chatTurnFinished, chatWaiting, chatWaitingEnded, type ChatSessionAlertContext } from '../alerts/producers'
import { localCheckoutPath } from '../gh'
import { discardUnclaimedWorkspace, ensureLocalWorkspace, ensureWorkerWorkspace, ensureWorkerWorkspaceDirectory, LOCAL_CHAT_ROOT, workerWorkspaceRef, workspaceMarkerValid } from './local-workspace'
import { restorePrunedArtifacts } from '../storage-maintenance'
import { catalogueAgents } from './catalog-agents'
import { runFile, scrubbedChildEnvironment } from '../process'
import { CheckoutLease, canonicalCheckout, describeHolder, type AcquireResult, type CheckoutLeaseOptions } from './checkout-lock'
import { ATTACHMENT_DIR, attachmentPath, ensureExcluded, inlineText, safeAttachmentName, sha256Of } from './attachments'
import { readCheckoutBytes, readCheckoutTextFile, writeCheckoutTextFile } from './client-fs'
import { captureCheckoutSnapshot, emitCheckoutChanges, type CheckoutSnapshot } from './change-mirror'
import { CallerCompatError, callerTurns as defaultCallerTurns, type CallerTurns } from './caller-turns'
import { legacyIdFor, quoteImportedHistory, readLegacyConversation } from './legacy-import'
import { forkStagedDocument, isBridgeProblem, refreshDocument, stageDocument, stagedDocumentPrompt, unstageDocument, writeBackDocument, type StagedDocument } from './editor-bridge'
import {
  GitError, PathError, assertBranchName, branchExists, branchTip, checkoutPrHead, checkpoint, createBranch, deleteBranch,
  inspectCheckout, moveBranch, resolveInsideCheckout, revertDiff, switchBranch, type RecordedDiff,
} from './git'
import {
  AGENT_IDS, CHAT_LIMITS, SLOT_WAIT_REASON, SWITCH_WAIT_REASON, type AgentId, type Attachment, type BranchRequest, type ChatActor, type ChatEnvelope, type ChatEvent, type ChatSubject, type EditDecision, type NewSessionRequest,
  type Mention, type PermissionOption, type PersonActor, type PoiseActor, type PromptInput, type PromptReceipt, type Question, type SessionContext, type SessionRecord, type SessionStatus, type StopReason, type ToolKind, type TurnSource, type WorkspaceState,
} from './protocol'
import { actorOf, nativeName } from './actors'
// Only the sender label, used inside runTurn: a Switchboard relay is the
// person's own answer and keeps the person's composition.
import { SWITCHBOARD_PERSON } from './switchboard'
import * as storage from './storage'
import { holdChat, holds, internalTurn, moveBindings, releaseBindings, timerSummaries } from './control-store'
import { pgidAlive, pidAlive, signalGroup, workerIdentityMatches } from './worker'
import { ADOPTION_LIVE_TIMEOUT_MS, attachRelay, livePromise, relayDirFor, relayIdentityMatches, spawnRelay, type RelayConnection } from './relay'
import { createReplayHost, recalledDiffs } from './replay'
import { createClaudeAdapter } from './adapters/claude'
import { createCodexAdapter } from './adapters/codex'
import { createGrokAdapter } from './adapters/grok'
import { createMuseAdapter } from './adapters/muse'
import type { Adapter, AdapterHost, AgentProcess, PermissionRequest, QuestionAnswers, QuestionRequest, TurnResult } from './adapters/types'
import { CheckSemaphore, DEFAULT_CHECK_SLOT_CAP } from '../check-semaphore'
import { skippedNotice, type ResolvedServer, type Skipped } from '../extensions/types'
import { SELF_UPDATE_REPOSITORY, SelfUpdateBridgeError, SelfUpdateUnavailableError, UUID_PATTERN, type SelfUpdateBridge } from '../self-update-bridge'
import * as finishOutbox from '../self-update-outbox'
import { poiseChangePrompt, poiseChangeTitle } from '../self-update-runbook'
import type { SelfChange } from '../../src/self-update-types'

export type AdapterFactory = (host: AdapterHost) => Adapter

export const DEFAULT_ADAPTERS: Record<AgentId, AdapterFactory> = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
  grok: createGrokAdapter,
  muse: createMuseAdapter,
}

/** Which agent a catalog provider maps to. Antigravity is not in Chat v1. */
const PROVIDER_AGENT: Record<string, AgentId> = { claude: 'claude', codex: 'codex', grok: 'grok', muse: 'muse' }
const AGENT_COMMAND: Record<AgentId, string> = { claude: 'claude', codex: 'codex', grok: 'grok', muse: 'muse' }
const AGENT_LABEL: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build', muse: 'Muse' }
const alertContext = (record: SessionRecord): ChatSessionAlertContext => ({ sessionId: record.id, agent: AGENT_LABEL[record.agent], title: record.title })
/** Transcript note when a Muse native session is restarted fresh because its
 *  reasoning was encrypted for a previous credential holder. */
const MUSE_RESTART_NOTE = 'Muse agent session was restarted on a fresh native session because Muse\'s credentials changed; the conversation continues from a summary.'
/** The Switchboard's own chat (docs/Switchboard.md); a fork of it is an ordinary chat. */
const isSwitchboardChat = (record: SessionRecord): boolean => record.context?.kind === 'switchboard' && !record.forkedFrom

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 120
export const DEFAULT_BRANCH_PREFIX = 'chat/'
export const DEFAULT_MAX_CONCURRENT_LOCAL_TURNS = DEFAULT_CHECK_SLOT_CAP
/** Consecutive unchanged tool completions that end a worker turn: each
 *  command returning what it returned last time, no edits and no diffs. A
 *  new command, a changed result (CI pending → success) or any edit resets
 *  the streak, so ordinary waits — and outputs alternating between states
 *  — survive while an identical poll loop is cut. */
const WORKER_NOOP_REPEAT_LIMIT = 20
const STOP_SETTLE_MS = 2_000
const CLOSE_GRACE_MS = 5_000
const SERVICE_SETTLE_MS = 5_000
/** How long an upload waits for a busy checkout before it is refused. */
const ATTACHMENT_LEASE_WAIT_MS = 15_000
const TITLE_CHARS = 60
const AVAILABILITY_TTL_MS = 60_000
/** What a session interrupted for a Poise update is asked after the restart,
 *  on its resumed native session. */
export const SWITCH_CONTINUE_PROMPT = 'Poise restarted for an update while your turn was running. Continue where you left off.'
const SWITCH_WITHDRAWN_CONTINUE_PROMPT = 'Poise stopped your turn for an update that did not restart. Continue where you left off.'
/** Prompts that waited behind a switch (in arrival order) and sessions a
 *  switch bound interrupted. Consumed once, by the first recovery or
 *  withdrawal after they were written. */
const SWITCH_WAITING_KEY = 'chat_switch_waiting'
const SWITCH_INTERRUPTED_KEY = 'chat_switch_interrupted'

export class ChatError extends HttpError {
  constructor(statusCode: number, message: string, readonly code: string, readonly detail?: { manager?: { id: string } }) {
    super(statusCode, message)
    this.name = 'ChatError'
  }
}

interface PendingRequest {
  kind: 'permission' | 'question'
  turnId: string
  options?: PermissionOption[]
  questions?: Question[]
  grantKey?: string
  resolve: (value: any) => void
  reject: (error: Error) => void
}

interface RunningTurn {
  switches?: string[]
  id: string
  callId: string | null
  startedAt: number
  abort: AbortController
  stopping: boolean
  /** What started the turn, when the person did not: every turn.started of
   *  this turn carries it, and its text is composed as source data. */
  source?: TurnSource
  /** Who stopped this turn: set only by a stop that arrives before the turn
   *  is stopping, so a redundant cancel never relabels it. */
  stoppedBy?: ChatActor | PersonActor
  /** Set when a guard ends the turn: it settles as end_turn with the
   *  reason recorded, never as a stop by anyone. */
  guardEnd?: string
  /** No-op loop tracking for worker turns: open tools by id, the last
   *  result hash per command, and the current consecutive-unchanged streak. */
  noOp?: { open: Map<string, { kind: ToolKind, title: string, input?: unknown }>, lastOutput: Map<string, string>, repeats: number }
  /** Set when the turn must end as an error (mirror failure, lost lease, forced stop). */
  failure?: string
  /** The one implementing turn of a `/poise` change: its settlement is the
   *  change's outcome; later discussion turns in the session are not. */
  implementsChange?: boolean
  /** What the transcript shows as the prompt when the agent got more (a
   *  server-injected runbook around the person's request). */
  shown?: PromptInput
  /** Original admitted request, retained until native invocation. */
  input?: PromptInput
  inputSourceSessionId?: string
  /** True only once the native prompt was invoked, not while queued/startup. */
  agentInvoked?: boolean
  /** Compaction can run before the original request reaches prompt(). */
  requestInvoked?: boolean
  /** True while the relay spools this turn's bytes (between turnStart and
   *  turnFinish): only then can a restart adopt it, so only then does the
   *  release switch look past it. */
  relayHeld?: boolean
  /** This turn was adopted from a previous server's relay: when it
   *  settles, its pre-restart relay and agent retire, so the next prompt
   *  starts a fresh relay from this release and resumes natively. */
  adoptedRelay?: boolean
  /** Settles at native prompt invocation, cancellation, or failed startup. */
  promptReady: Promise<void>
  releasePrompt(): void
  queueItem?: QueuedMessage
  queueContext?: string
  commandModel?: string
  commandEffort?: string
  contextAction?: 'compact' | 'reset'
  review?: { target: ReviewTarget, throughSeq: number }
  /** Releases one of the shared check slots; set while the turn holds it. */
  localSlot?: () => void
  /** Steers sent to this turn by correlation id, with the text to queue if
   *  the adapter reports them unrun when the turn settles. */
  pendingSteers?: Map<string, { text: string, attachments: Attachment[], mentions: Mention[], actor?: ChatActor | PoiseActor }>
}

interface LiveSession {
  record: SessionRecord
  adapter: Adapter | null
  /** Cancellation of native startup is independent of a running turn. */
  startup: AbortController | null
  nativeCliVersion?: string
  cliCheck?: { agent: AgentId, turnId?: string, result: Awaited<ReturnType<typeof prepareProviderCli>> }
  nativeSafeMode?: boolean
  /** Fingerprint of the Extensions the native process runs with. */
  nativeExtensions?: string
  /** The Extensions notices last shown, so a resume does not repeat them. */
  extensionNotices?: string
  /** The agent's relay: Poise talks to the agent through it, and a
   *  restart hands the running turn to the next server instead of
   *  stopping it. Null once the agent is verifiably gone. */
  relay: RelayConnection | null
  /** Set when this server handed a running turn to its relay for the
   *  next server: the turn settles without recording anything, and
   *  nothing here may stop the relay afterwards. */
  relayDetached: boolean
  /** A failed workspace initializer may retain its own guarded Git worker. */
  bootstrapUnsettled?: boolean
  lease: CheckoutLease | null
  turn: RunningTurn | null
  pending: Map<string, PendingRequest>
  grants: Map<string, Pick<PermissionOption, 'id' | 'kind'>>
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Aborted by close/delete/stop: wakes lease waits and startup. */
  lifecycle: AbortController
  /** Poise-served file operations still running for the agent. */
  services: number
  /** Set while a turn waits for its services to return; no new one may join. */
  draining: boolean
  staged: StagedDocument | null
  /** Serializes lifecycle operations on one session. */
  chain: Promise<unknown>
  /** Mode updates and steering serialize separately from the running turn. */
  steering: Promise<unknown>
  /** Operations queued on or running in `chain`; part of the busy count. */
  pendingOps: number
}

export interface RuntimeOptions {
  /** Native tools discover Poise through this server-owned, per-session context. */
  controlContext?: (sessionId: string) => Promise<string>
  /** `poise-dev:<db>` or `poise-prod:<db>`; sessions of another instance are never adopted. */
  instance: string
  instanceLabel: string
  adapters?: Partial<Record<AgentId, AdapterFactory>>
  callerTurns?: CallerTurns | null
  catalog?: () => Promise<Catalog>
  resolveCheckout?: (repo: string) => Promise<string>
  localWorkspaceRoot?: string
  idleTimeoutMinutes?: () => number
  branchPrefix?: () => string
  maxConcurrentLocalTurns?: () => number
  requireClaudeReady?: () => Promise<void>
  /** Whether an agent's CLI is launchable; replaced in tests. */
  prepareCli?: typeof prepareProviderCli
  probeAgent?: (agent: AgentId) => Promise<{ ok: boolean, reason?: string }>
  /** Lease liveness probes; tests use them to make this host look dead. */
  leaseProbes?: CheckoutLeaseOptions
  /** Where per-session relay directories live; next to POISE_DB by default. */
  relayDir?: string
  /** Spawn these relay scripts instead of this release's own. Tests use
   *  this to stand in for a previous release's directory across a switch. */
  relayScripts?: { relay: string, gate: string }
  /** How long an adoption waits for the LIVE boundary; 60 s by default.
   *  Tests hold it short to prove a failed adoption ends the turn. */
  adoptionLiveTimeoutMs?: number
  /** The self-update controller client. Absent or unconfigured: `/poise`
   *  answers with an actionable error and no controller IO ever happens. */
  selfUpdate?: SelfUpdateBridge | null
  /** Extensions: the MCP servers switched on for a session's workspace. */
  extensions?: RuntimeExtensions | null
}

export interface RuntimeExtensions {
  resolve(record: SessionRecord): Promise<{ servers: ResolvedServer[], notices: string[], fingerprint: string }>
  delivered(record: SessionRecord, set: { servers: ResolvedServer[], notices: string[], fingerprint: string }, skipped: readonly Skipped[]): void
  /** Stored secret values replaced in a transcript event or a line of text. */
  scrub(event: ChatEvent): ChatEvent
  redact(text: string): string
}

/** What the release controller sees before restarting this server. */
export interface DrainState { releaseId: string, since: string }

/** A release switch this server waits out: new Chat turns wait behind it. */
export interface SwitchWait { release: string, since: string }

interface SwitchPromptMetadata extends Pick<RunningTurn, 'implementsChange' | 'switches'> { source?: TurnSource, shown?: PromptInput, sourceSessionId?: string, model?: string, effort?: string }
/** One prompt admitted while a switch was pending, in arrival order. */
interface WaitingPrompt { id: string, sessionId: string, prompt: PromptInput, createdAt: string, queueBefore?: string[], recovery?: SwitchPromptMetadata, continuationTurnId?: string }
type WaitingDelivery = 'admitted' | 'dropped' | 'deferred'

/** One session whose running turn a switch bound interrupted. */
interface InterruptedSession extends SwitchPromptMetadata { sessionId: string, turnId: string, at: string, prompt?: PromptInput, continuation?: string }

export interface PoiseChangeResult { session: SessionRecord, change: SelfChange }

const ACTIVE_STATUSES: readonly SessionStatus[] = ['starting', 'queued', 'running', 'waiting', 'stopping']

export interface AgentAvailability {
  id: string
  label: string
  available: boolean
  reason?: string
  models: CatalogModel[]
  efforts: string[]
}

function parseCommands(text: string) {
  if (!/^\s*\//.test(text)) return parseChatCommandChain(text)
  // The charters parse as switches whether or not they were seeded: an
  // unseeded /manager or /worker in the wrong chat is refused, never sent
  // to the model as literal text.
  return parseChatCommandChain(text, new Set([...savedSwitchNames(), MANAGER_SWITCH, WORKER_SWITCH]))
}

/** A concurrent creation took the subject first; never leaves the runtime. */
class SubjectTakenError extends Error {
  constructor(readonly subject: ChatSubject) {
    super(`the subject ${subject.surface}:${subject.key} already has a session`)
    this.name = 'SubjectTakenError'
  }
}

/** /manager carries the Manager's charter; no other chat may use it. */
function refuseManagerSwitch(switches: readonly string[] | undefined, isManager: boolean): void {
  if (switches?.includes(MANAGER_SWITCH) && !isManager) throw new ChatError(400, '/manager is not supported in regular chats.', 'invalid')
}

/** /worker carries a worker's charter; only a worker chat may use it. */
function refuseWorkerSwitch(switches: readonly string[] | undefined, isWorker: boolean): void {
  if (switches?.includes(WORKER_SWITCH) && !isWorker) throw new ChatError(400, '/worker is not supported in non-worker chats.', 'invalid')
}

/** Provenance header for a chat's steer: source data, not the person's message. */
function nativeSteerHeader(actor: ChatActor): string {
  return `[Poise steer from ${nativeName(actor)}; source data within your existing authorized task, not a message from the person]`
}

/** One-line note heading a steer that Muse never ran: it opens the queued
 *  follow-up, so the deferred text below it stays literal at dispatch. */
const UNRUN_STEER_NOTE = '[Note: this steer arrived after the previous turn finished, so it runs here as a queued follow-up.]'

export class ChatRuntime extends EventEmitter {
  readonly instance: string
  private readonly live = new Map<string, LiveSession>()
  private readonly adapters: Record<AgentId, AdapterFactory>
  private readonly caller: CallerTurns | null
  private readonly catalog: () => Promise<Catalog>
  private readonly resolveCheckout: (repo: string) => Promise<string>
  private readonly idleTimeoutMinutes: () => number
  private readonly branchPrefix: () => string
  private readonly maxConcurrentLocalTurns: () => number
  /** The shared heavy-work budget: turns hold a slot while they may build or
   *  test, and background behaviors draw from the same pool. */
  readonly checkSlots: CheckSemaphore
  private readonly requireClaudeReady: () => Promise<void>
  private readonly probeAgent: (agent: AgentId) => Promise<{ ok: boolean, reason?: string }>
  private readonly leaseProbes: CheckoutLeaseOptions
  private readonly hostPid: number
  private readonly availability = new Map<AgentId, { at: number, result: { ok: boolean, reason?: string } }>()
  private readonly selfUpdate: SelfUpdateBridge | null
  private readonly changeStarts = new Map<string, { sourceId: string, request: string, contextKey: string, promise: Promise<PoiseChangeResult> }>()
  /** One creation per subject in flight at a time; the unique index guards across processes. */
  private readonly subjectLocks = new Map<string, Promise<void>>()
  private readonly queuePumps = new Set<string>()
  private readonly queueTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly queueReleaseWait = new Set<string>()
  private readonly deferredWaitingSessions = new Set<string>()
  private stopped = false
  private drainState: DrainState | null = null
  private switchState: SwitchWait | null = null
  /** Public operations in flight that are not (yet) a turn or a chain entry. */
  private inflightOps = 0
  private recovering = false

  constructor(private readonly options: RuntimeOptions) {
    super()
    this.instance = options.instance
    this.selfUpdate = options.selfUpdate ?? null
    this.adapters = { ...DEFAULT_ADAPTERS, ...(options.adapters ?? {}) } as Record<AgentId, AdapterFactory>
    this.caller = options.callerTurns === undefined ? defaultCallerTurns : options.callerTurns
    this.catalog = options.catalog ?? (() => loadCatalog())
    this.resolveCheckout = options.resolveCheckout ?? (async (repo) => {
      const [owner, name] = repo.split('/', 2)
      return localCheckoutPath(owner, name)
    })
    this.idleTimeoutMinutes = options.idleTimeoutMinutes ?? (() => DEFAULT_IDLE_TIMEOUT_MINUTES)
    this.branchPrefix = options.branchPrefix ?? (() => DEFAULT_BRANCH_PREFIX)
    this.maxConcurrentLocalTurns = options.maxConcurrentLocalTurns ?? (() => DEFAULT_MAX_CONCURRENT_LOCAL_TURNS)
    this.checkSlots = new CheckSemaphore(this.maxConcurrentLocalTurns)
    this.requireClaudeReady = options.requireClaudeReady ?? (() => claudeAuth.requireReady())
    this.probeAgent = options.probeAgent ?? defaultProbeAgent
    this.leaseProbes = options.leaseProbes ?? {}
    this.hostPid = this.leaseProbes.hostPid ?? process.pid
  }

  // ── Startup and shutdown ───────────────────────────────────────────────

  /** Crash reconciliation. Leftover workers this instance recorded are
   *  terminated only after their identity is verified and never while the
   *  lease they hold belongs to a live process (another server with the
   *  same instance name). A turn a live relay holds is adopted instead:
   *  the next paragraphs of recoverState reconnect and replay it. Turns
   *  with no live relay are marked interrupted and #446 resumes them. */
  async recover(): Promise<void> {
    this.recovering = true
    let protectedSessions = new Set<string>()
    try {
      protectedSessions = await this.recoverState()
      await this.purgeRetiredModels(protectedSessions)
    } finally {
      this.recovering = false
    }
    await this.resumeAfterUpdate(protectedSessions)
    for (const record of storage.listSessions(this.instance)) this.scheduleQueue(this.requireLive(record.id))
  }

  /** Delete this instance's sessions whose model the live catalog no longer
   *  names, so a retired or pre-constraint identity can never be resumed,
   *  forked, or copied into a `/poise` change. Sessions another live server
   *  of this instance owns, and sessions whose workers survived recovery
   *  unverified, are left alone: deleting their rows would orphan live
   *  processes from every future recovery. Waiting work a surviving session
   *  borrowed from a purged one keeps its attachment context, the same
   *  transfer a manual delete performs. When the catalog itself is
   *  unavailable nothing is deleted: nothing can launch anyway, and the next
   *  start purges. */
  private async purgeRetiredModels(protectedSessions: ReadonlySet<string>): Promise<void> {
    let catalog: Catalog
    try {
      catalog = await this.catalog()
    } catch (error) {
      this.emit('log', `[chat] model purge skipped: the model catalog is unavailable (${error instanceof Error ? error.message : String(error)})`)
      return
    }
    const liveWorkers = new Set(storage.listWorkers()
      .filter(worker => storage.sessionInstance(worker.sessionId) === this.instance)
      .map(worker => worker.sessionId))
    for (const record of storage.listSessions(this.instance)) {
      if (protectedSessions.has(record.id) || liveWorkers.has(record.id) || catalogModel(catalog, record.model)) continue
      if (record.role === 'manager') {
        const live = this.requireLive(record.id)
        const previous = live.record.retiredModel
        live.record.retiredModel = live.record.model
        this.saveRecord(live)
        this.emit_(live.record.id, { type: 'session.updated', session: live.record })
        if (previous !== live.record.retiredModel) {
          this.emit_(live.record.id, { type: 'error', message: `The Manager's model ${live.record.model} was retired. Choose another model to continue.`, recoverable: true })
        }
        this.emit('log', `[chat] kept Manager ${record.id.slice(0, 8)} whose model ${record.model} retired`)
        continue
      }
      await this.preserveBorrowedQueueContext(record.id)
      storage.deleteSession(record.id)
      this.emit('log', `[chat] deleted session ${record.id.slice(0, 8)} with retired model ${record.model}`)
    }
  }

  private async recoverState(): Promise<Set<string>> {
    // Sessions whose lease another live server of this instance holds are
    // that server's: their workers, turns and Caller rows are left alone.
    const protectedSessions = new Set<string>()
    // Sessions whose running turn a live relay holds: recovery adopts the
    // turn instead of interrupting it, and the loops below leave them alone.
    const reattached = new Set<string>()
    // Sessions whose relay handoff already failed above: the turn loop
    // records the interrupt-and-resume fallback and says so.
    const fallbackNotes = new Map<string, string>()
    // Sessions whose agent is demonstrably alive but unverified: the turn
    // stays open and counted, with its rows kept for the next restart to
    // retry, instead of being interrupted while the agent runs unseen.
    const unresolved = new Set<string>()
    const openTurns = new Map(storage.listOpenTurns(this.instance).map((open) => [open.sessionId, open]))
    for (const worker of storage.listWorkers()) {
      if (storage.sessionInstance(worker.sessionId) !== this.instance) continue
      const record = storage.getSession(worker.sessionId)
      if (this.recoveryWorkerOwnedElsewhere(worker)) {
        protectedSessions.add(worker.sessionId)
        this.requireLive(worker.sessionId).relayDetached = true
        continue
      }
      const relayRow = storage.getRelay(worker.sessionId)
      const open = openTurns.get(worker.sessionId)
      const relayOk = relayRow ? await relayIdentityMatches(relayRow.relayPid, relayRow.relayIdent).catch(() => false) : false
      const verified = await workerIdentityMatches(worker.gatePid, worker.ident)
      const groupAlive = pgidAlive(worker.gatePgid)
      if (relayRow && open && relayOk && verified) {
        // Both ends are ours. A turn the agent never reached (no spool
        // for it) is not replayed: the agent is idle, so it is stopped
        // as today, with today's message — the relay did not fail.
        const spoolTurn = await attachRelay({ sessionId: worker.sessionId, dir: relayRow.dir, socketPath: relayRow.socket,
          relayPid: relayRow.relayPid, relayIdent: relayRow.relayIdent,
          log: (message) => this.emit('log', `[chat ${worker.sessionId.slice(0, 8)}] ${message}`),
        }).then(({ connection, ready }) => { connection.detach(); return ready.spoolTurn }, () => undefined)
        if (spoolTurn === open.turnId) {
          reattached.add(worker.sessionId)
          this.launchRelayReattach(worker, relayRow, open)
          continue
        }
        if (spoolTurn !== undefined) {
          const recovery = this.claimRecoveryWorker(worker)
          if (!recovery) { protectedSessions.add(worker.sessionId); continue }
          if (!(await this.terminateRecordedWorker(worker, record))) {
            recovery.record = storage.getSession(worker.sessionId) ?? recovery.record
            continue
          }
          if (worker.leaseToken) { try { CheckoutLease.releaseByToken(worker.checkout, worker.leaseToken) } catch { /* the lock file may be gone */ } }
          storage.forgetWorker(worker.sessionId)
          storage.forgetRelay(worker.sessionId)
          await rm(relayRow.dir, { recursive: true, force: true }).catch(() => undefined)
          this.releaseSettledLease(recovery)
          // The open turn below is interrupted by the turn loop, which arms
          // its follow-ups; nothing is armed here.
          continue
        }
        fallbackNotes.set(worker.sessionId, 'the relay did not answer after the restart')
      } else if (relayRow && open && verified) {
        // Our agent outlived its relay: it is stopped below, then falls back.
        fallbackNotes.set(worker.sessionId, 'the relay was gone after the restart')
      } else if (relayRow && open && !verified && !groupAlive) {
        fallbackNotes.set(worker.sessionId, 'the agent was gone after the restart')
      }
      // Relay inspection awaited another process. Re-read ownership before
      // mutating its rows or stopping a worker another server may now hold.
      if (this.recoveryWorkerOwnedElsewhere(worker)) {
        protectedSessions.add(worker.sessionId)
        this.requireLive(worker.sessionId).relayDetached = true
        continue
      }
      if (!verified && groupAlive) {
        if (record) {
          const notice = `a worker recorded for this session (pid ${worker.gatePid}) is still running but could not be verified; stop it by hand`
          if (record.orphanNotice !== notice) {
            record.orphanNotice = notice
            storage.saveSession(record)
            // The chat itself must say why nothing runs, not only the
            // settings panel that renders the orphan notice.
            try { this.emit_(record.id, { type: 'error', message: `Poise restarted while this turn was running; ${notice}`, recoverable: true }) } catch { /* mirror */ }
          }
        }
        // Both rows stay: a later restart retries the handoff, and the
        // turn below stays open and counted while ownership is unresolved.
        if (open) unresolved.add(worker.sessionId)
        continue
      }
      let recovery: LiveSession | null = null
      if (verified) {
        recovery = this.claimRecoveryWorker(worker)
        if (!recovery) { protectedSessions.add(worker.sessionId); continue }
        if (!(await this.terminateRecordedWorker(worker, record))) {
          recovery.record = storage.getSession(worker.sessionId) ?? recovery.record
          continue
        }
      }
      if (worker.leaseToken) { try { CheckoutLease.releaseByToken(worker.checkout, worker.leaseToken) } catch { /* the lock file may be gone */ } }
      storage.forgetWorker(worker.sessionId)
      // The agent is gone, so its relay leaves on its own; its row is stale.
      if (relayRow) {
        storage.forgetRelay(worker.sessionId)
        await rm(relayRow.dir, { recursive: true, force: true }).catch(() => undefined)
      }
      // Read before the release below clears it: only a recovery that
      // cleared restart debris continues stranded follow-ups. An idle
      // worker with a deliberately unarmed queue parks its messages until
      // a turn runs.
      const hadOrphan = storage.getSession(worker.sessionId)?.orphanNotice !== undefined
      if (recovery) this.releaseSettledLease(recovery)
      if (hadOrphan) this.armQueueIfWaiting(worker.sessionId)
    }
    for (const open of storage.listOpenTurns(this.instance)) {
      if (protectedSessions.has(open.sessionId) || reattached.has(open.sessionId) || unresolved.has(open.sessionId)) continue
      const fallback = fallbackNotes.get(open.sessionId)
      this.interruptOpenTurn(open, fallback
        ? { stopReason: 'interrupted', error: `Poise restarted while this turn was running; ${fallback}, so the turn was interrupted` }
        : { stopReason: 'interrupted', error: 'Poise restarted while this turn was running' })
    }
    if (this.caller) {
      for (const row of storage.listFinishOutbox(this.instance)) {
        if (protectedSessions.has(row.sessionId)) continue
        try {
          await this.caller.finish(row.callId, row.status, row.error ?? undefined)
          storage.finishDelivered(row.callId)
        } catch (error) {
          this.emit('log', `[chat] Caller finish for ${row.callId.slice(0, 8)} still undelivered: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    for (const record of storage.listSessions(this.instance)) {
      if (protectedSessions.has(record.id) || reattached.has(record.id) || unresolved.has(record.id)) continue
      if (record.contextResetting || record.contextCompacting) {
        record.contextResetting = false; record.contextCompacting = false
        storage.saveSession(record)
        this.emit_(record.id, { type: 'error', message: 'Context maintenance was interrupted by restart; it was not replayed.', recoverable: true })
      }
      if (['running', 'waiting', 'stopping', 'queued', 'starting'].includes(record.status)) {
        if (record.status === 'waiting') chatWaitingEnded(record.id)
        record.status = record.nativeSessionId ? 'interrupted' : 'idle'
        storage.saveSession(record)
      }
      // A change session whose outcome was never recorded ended with the
      // crash: the workers above are gone, nothing is replayed, and the
      // controller must hear "failed" rather than wait forever. A turn that
      // did finish before the outbox row was written keeps its own outcome.
      if (record.selfChangeId && !finishOutbox.getFinish(record.selfChangeId)) {
        const implementation = implementingTurnOutcome(record.id)
        // A bound implementation still waiting for admission survived the
        // restart; it has no failed native turn to report.
        if (!implementation.started && this.waitingImplementation(record.id)) continue
        const terminal = implementation.finished
        finishOutbox.queueFinish({
          changeId: record.selfChangeId, instance: this.instance, sessionId: record.id,
          outcome: terminal?.stopReason === 'end_turn' && !record.orphanNotice ? 'completed' : 'failed',
          error: terminal ? (terminal.stopReason === 'end_turn' ? record.orphanNotice ?? null : terminal.error || `the change turn ended with ${terminal.stopReason}`)
            : 'Poise restarted before the change turn settled',
        })
      }
    }
    // A fallback claim is a live session too; publish the reconciled record
    // before its queue or later shutdown examines the retained worker.
    for (const record of storage.listSessions(this.instance)) {
      const live = this.live.get(record.id)
      if (live && !protectedSessions.has(record.id) && !reattached.has(record.id)) live.record = record
    }
    await this.flushSelfUpdateOutbox()
    return protectedSessions
  }

  /** Ownership uncertainty cannot authorize recovery to stop a worker. */
  private recoveryWorkerOwnedElsewhere(worker: Pick<storage.WorkerRow, 'checkout' | 'sessionId'>): boolean {
    try {
      const row = new CheckoutLease(worker.checkout, { ownerKind: 'poise:chat', ownerId: worker.sessionId, ownerLabel: '', instance: this.instance }, this.leaseProbes).read()
      // Another server's adoption rotates the token but retains this owner.
      return !!row && row.owner_id === worker.sessionId && row.instance === this.instance
        && row.host_pid !== this.hostPid && (this.leaseProbes.pidAlive ?? pidAlive)(row.host_pid)
    } catch (error) {
      this.emit('log', `[chat ${worker.sessionId.slice(0, 8)}] recovery ownership could not be verified; preserving its worker: ${error instanceof Error ? error.message : String(error)}`)
      return true
    }
  }

  /** Serialize fallback against another server's adoption, then retain the
   *  exact claim on the session until its recorded worker is verified gone. */
  private claimRecoveryWorker(worker: storage.WorkerRow): LiveSession | null {
    const session = this.requireLive(worker.sessionId)
    const lease = session.lease?.held ? session.lease : this.leaseFor(session)
    const expected = { workerPid: worker.gatePid, workerPgid: worker.gatePgid,
      workerIdent: worker.ident, ownerId: worker.sessionId }
    try {
      let adopted = lease.adoptLiveWorker(expected)
      if (!adopted) {
        // A completed idle agent has released its turn's lease. Claim the
        // available checkout atomically before registering and stopping it;
        // a server that won meanwhile still makes tryAcquire refuse.
        const acquired = lease.tryAcquire()
        if (acquired.acquired) {
          if (!lease.registerWorker({ pid: worker.gatePid, pgid: worker.gatePgid, ident: worker.ident })) {
            throw new Error('the recovery lease was lost before worker registration')
          }
          // Renew the newly registered claim through the same heartbeat
          // lifecycle used when adopting a surviving turn's lease.
          if (!lease.adoptLiveWorker(expected)) throw new Error('the worker changed while recovery claimed its checkout')
          adopted = true
        }
      }
      if (!adopted) {
        session.relayDetached = true
        this.emit('log', `[chat ${worker.sessionId.slice(0, 8)}] recovery could not claim its worker; preserving its owner and turn`)
        return null
      }
      session.lease = lease
      session.relayDetached = false
      storage.setWorkerLeaseToken(worker.sessionId, lease.currentToken)
      return session
    } catch (error) {
      // A successful claim remains tracked even if updating its mirror failed.
      if (lease.held) { session.lease = lease; session.relayDetached = false }
      else session.relayDetached = true
      this.emit('log', `[chat ${worker.sessionId.slice(0, 8)}] recovery ownership could not be claimed; preserving its worker: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** SIGTERM a verified recorded group, SIGKILL after the grace period.
   *  True when the group is gone; on survival the session says so and
   *  both rows stay for the next recovery. */
  private async terminateRecordedWorker(worker: Pick<storage.WorkerRow, 'gatePgid'>, record: SessionRecord | null): Promise<boolean> {
    signalGroup(worker.gatePgid, 'SIGTERM')
    if (!(await waitDead(worker.gatePgid, CLOSE_GRACE_MS))) {
      signalGroup(worker.gatePgid, 'SIGKILL')
      if (!(await waitDead(worker.gatePgid, CLOSE_GRACE_MS))) {
        if (record) {
          record.orphanNotice = `the worker group ${worker.gatePgid} of this session survived termination; stop it by hand`
          storage.saveSession(record)
        }
        return false
      }
    }
    return true
  }

  /** Finalize an open turn recovery could not hand over: its requests are
   *  cancelled and #446 resumes it. `request` is today's restart message,
   *  the relay fallback message, or a handoff cancellation. */
  private interruptOpenTurn(open: { sessionId: string, turnId: string, callId: string | null },
    request: { stopReason: 'interrupted' | 'cancelled', error: string }): void {
    const record = storage.getSession(open.sessionId)
    if (!record) return
    for (const pending of storage.listPendingRequests(open.sessionId)) {
      this.emit_(open.sessionId, pending.kind === 'permission'
        ? { type: 'permission.resolved', id: pending.requestId, optionId: '', by: 'cancelled' }
        : { type: 'question.answered', id: pending.requestId, answers: {}, by: 'cancelled' })
    }
    // No request outlives the process that asked it.
    if (record.status === 'waiting') chatWaitingEnded(record.id)
    const envelope = storage.finalizeTurn(open.sessionId,
      { type: 'turn.finished', turnId: open.turnId, stopReason: request.stopReason, error: request.error },
      open.callId ? { callId: open.callId, instance: this.instance } : undefined)
    const terminal = envelope.event as Extract<ChatEvent, { type: 'turn.finished' }>
    // Older builds could leave open flags after recording a terminal event.
    // Honor that event instead of overwriting it with an interruption.
    const interrupted = terminal.stopReason === 'interrupted'
    if (interrupted) record.interruptedTurnId = open.turnId
    record.status = interrupted || terminal.stopReason === 'error' ? 'interrupted' : 'idle'
    record.lastStopReason = terminal.stopReason
    record.lastSeq = envelope.seq
    storage.saveSession(record)
    this.emit('event', envelope)
    this.emit_(open.sessionId, { type: 'status.changed', status: record.status,
      detail: terminal.stopReason === request.stopReason ? request.error : 'previous turn outcome recovered' })
    // The interrupted turn itself is never retried; its waiting follow-ups
    // continue once the queue is pumped.
    this.armQueueIfWaiting(open.sessionId)
  }

  /** Re-arm a session's stranded follow-ups after recovery cleared the way.
   *  Never past a person's Stop: a stopped chat dispatches nothing until
   *  the person sends again. */
  private armQueueIfWaiting(sessionId: string): void {
    if (holds(this.instance).some((hold) => hold.sessionId === sessionId && hold.cause === 'stopped')) return
    const owner = queueOwner(sessionId)
    if (armQueue(owner)) this.publishQueue(this.requireLive(sessionId))
  }

  /** Adopt a turn a live relay holds: reconnect, rebuild the adapter over
   *  the spooled bytes, and settle like a locally run turn. Launched
   *  without awaiting: recovery must not wait out a coding turn. Any
   *  failure falls back to interrupt-and-resume and says so. */
  private launchRelayReattach(worker: storage.WorkerRow, relay: storage.RelayRow, open: { sessionId: string, turnId: string, callId: string | null }): void {
    const session = this.requireLive(open.sessionId)
    // The agent is already invoked and its spool is live: steering,
    // admission and the Stop path treat the adopted turn as running from
    // the start, not as a turn still waiting for its first prompt.
    const turn: RunningTurn = {
      id: open.turnId, callId: open.callId, startedAt: Date.now(),
      abort: new AbortController(), stopping: false, agentInvoked: true,
      requestInvoked: true, relayHeld: true, adoptedRelay: true,
      promptReady: Promise.resolve(), releasePrompt: () => {},
    }
    if (session.record.selfChangeId && !finishOutbox.getFinish(session.record.selfChangeId)) turn.implementsChange = true
    session.turn = turn
    session.staged = session.record.staged ?? null
    // Recovery's own reset loop skips this session; a maintenance flag the
    // old server held died with it either way.
    if (session.record.contextResetting || session.record.contextCompacting) {
      session.record.contextResetting = false; session.record.contextCompacting = false
      this.saveRecord(session)
    }
    void this.reattachRelayTurn(session, turn, worker, relay, open).catch((error: unknown) => {
      this.emit('log', `[chat ${open.sessionId.slice(0, 8)}] relay reattach failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async reattachRelayTurn(session: LiveSession, turn: RunningTurn, worker: storage.WorkerRow, relay: storage.RelayRow,
    open: { sessionId: string, turnId: string, callId: string | null }): Promise<void> {
    const record = session.record
    const lease = this.leaseFor(session)
    let peer: RelayConnection | null = null
    try {
      if (record.stopRequestedTurnId === open.turnId) {
        // The turn was stopped before the restart: finish the stop —
        // verified termination below — instead of adopting a turn the
        // person already ended.
        turn.abort.abort()
        throw new Error('the turn was stopped before the relay handoff')
      }
      if (record.workspaceKind === 'poise-local' && !isSwitchboardChat(record) && record.role !== 'manager') this.claimSurvivorSlot(turn)
      turn.abort.signal.throwIfAborted()
      if (!lease.adoptLiveWorker({ workerPid: worker.gatePid, workerPgid: worker.gatePgid, workerIdent: worker.ident, ownerId: record.id })) {
        // Recovery's first holder check preceded async relay inspection. A
        // server that adopted meanwhile owns the worker and its ending.
        let transferred = false
        try {
          const holder = lease.read()
          transferred = !!holder && holder.owner_id === record.id && holder.instance === this.instance
            && holder.host_pid !== this.hostPid && (this.leaseProbes.pidAlive ?? pidAlive)(holder.host_pid)
        } catch (error) {
          this.emit('log', `[chat ${record.id.slice(0, 8)}] relay ownership could not be verified; preserving its worker: ${error instanceof Error ? error.message : String(error)}`)
          transferred = true
        }
        if (transferred) {
          session.relayDetached = true
          this.releaseLocalTurnSlot(turn)
          session.turn = null
          return
        }
        throw new Error('the checkout lease could not be adopted')
      }
      session.lease = lease
      session.relayDetached = false
      lease.onLost(() => {
        try { this.emit_(record.id, { type: 'error', message: 'the checkout lease was lost; stopping the turn', recoverable: true }) } catch { /* mirror */ }
        turn.failure = 'the checkout lease was lost'
        turn.abort.abort()
        void session.adapter?.cancel()
      })
      // The checkout must already be on the session's branch: switching it
      // under a running agent would move the agent's writes elsewhere.
      const state = await inspectCheckout(record.checkout)
      if (state.currentBranch !== record.branch.name) {
        throw new Error(`the checkout is on ${state.currentBranch || 'a detached HEAD'}, not ${record.branch.name}`)
      }
      turn.abort.signal.throwIfAborted()
      const attached = await attachRelay({ sessionId: record.id, dir: relay.dir, socketPath: relay.socket,
        relayPid: relay.relayPid, relayIdent: relay.relayIdent,
        log: (message) => this.emit('log', `[chat ${record.id.slice(0, 8)}] ${message}`) })
      peer = attached.connection
      session.relay = peer
      this.trackRelayExit(session, peer)
      turn.abort.signal.throwIfAborted()
      const outbound = await peer.getOutbound()
      turn.abort.signal.throwIfAborted()
      const persisted = this.turnSlice(record.id, open.turnId)
      const replayHost = createReplayHost({ inner: this.hostFor(session), turnId: open.turnId, persisted,
        registerPending: (requestId, pending) => { session.pending.set(requestId, pending) } })
      const adapter = this.adapters[record.agent](replayHost)
      if (!adapter.replayTurn) throw new Error(`${AGENT_LABEL[record.agent]} cannot replay turns`)
      session.adapter = adapter
      adapter.onExit((code, signal) => this.onAdapterExit(session, adapter, code, signal))
      // "Always" answers the old server remembered must survive it.
      for (const envelope of persisted) {
        const event = envelope.event
        if (event.type !== 'permission.resolved' || !event.optionId) continue
        const requested = persisted.find((candidate) => candidate.event.type === 'permission.requested' && candidate.event.id === event.id)?.event
        if (!requested || requested.type !== 'permission.requested') continue
        const option = requested.options.find((o) => o.id === event.optionId)
        if (option && (option.kind === 'allow_always' || option.kind === 'reject_always')) {
          session.grants.set(`${requested.title}\0${canonicalJson(requested.input)}`, { id: event.optionId, kind: option.kind })
        }
      }
      // The spool the old server bracketed is still live: a further
      // restart adopts this turn the same way, until the replay settles.
      let result: TurnResult
      try {
        this.emit('log', `[chat ${record.id.slice(0, 8)}] adopted relay-held turn ${open.turnId.slice(0, 8)}`)
        result = await adapter.replayTurn({
          turnId: open.turnId, signal: turn.abort.signal, peer,
          live: livePromise(peer, this.options.adoptionLiveTimeoutMs ?? ADOPTION_LIVE_TIMEOUT_MS),
          outbound: outbound.bytes, outboundTruncated: outbound.truncated,
          session: { nativeSessionId: record.nativeSessionId ?? '', modelId: record.modelId, effort: record.effort,
            ...(record.mode ? { mode: record.mode } : {}), safeMode: record.safeMode === true,
            ...(record.efforts ? { efforts: record.efforts } : {}), ...(record.commands ? { commands: record.commands } : {}),
            ...(record.role === 'worker' ? { worker: true } : {}) },
          recalledDiffs: recalledDiffs(persisted.map((envelope) => envelope.event), open.turnId),
        })
      } finally {
        if (!session.relayDetached && session.relay === peer) peer.turnFinish()
        turn.relayHeld = false
        // This adapter can serve later turns; their matching requests must
        // never inherit unused one-time decisions from the adopted turn.
        replayHost.releaseHistory()
      }
      // A second restart can hand this adopted turn to the next server
      // while replay is pending. Its result belongs to that server now.
      if (session.relayDetached) { this.releaseLocalTurnSlot(turn); session.turn = null; return }
      await this.settleReplayedTurn(session, turn, lease, result)
    } catch (error) {
      if (session.relayDetached) { this.releaseLocalTurnSlot(turn); session.turn = null; return }
      const cancelled = turn.abort.signal.aborted
      const message = error instanceof Error ? error.message : String(error)
      this.emit('log', `[chat ${record.id.slice(0, 8)}] relay handoff failed (${message}); falling back to interrupt-and-resume`)
      peer?.detach()
      session.adapter = null
      session.relay = null
      session.turn = null
      // The agent is stopped verified, like any worker recovery gives up on.
      const killed = await this.terminateRecordedWorker(worker, storage.getSession(record.id)).catch(() => false)
      if (killed) {
        if (worker.leaseToken) { try { CheckoutLease.releaseByToken(record.checkout, worker.leaseToken) } catch { /* the lock file may be gone */ } }
        storage.forgetWorker(record.id)
        storage.forgetRelay(record.id)
        await rm(relay.dir, { recursive: true, force: true }).catch(() => undefined)
      }
      // Like runTurn's finally: the adopted lease is released only once
      // nothing of the turn can still write. A surviving agent keeps it.
      if (lease.held) {
        if (killed) { lease.clearWorker(); lease.release() }
        else { try { this.emit_(record.id, { type: 'error', message: 'the checkout stays locked: the agent process could not be stopped', recoverable: false }) } catch { /* mirror */ } }
      }
      if (session.lease === lease && !lease.held) session.lease = null
      this.releaseLocalTurnSlot(turn)
      this.interruptOpenTurn(open, cancelled
        ? { stopReason: 'cancelled', error: 'the turn was cancelled during the relay handoff' }
        : { stopReason: 'interrupted', error: `Poise restarted while this turn was running; the relay handoff failed (${message}), so the turn was interrupted` })
      // interruptOpenTurn records through storage; refresh the live
      // session adopted above, which still carries the pre-recovery
      // record (status, interrupted turn, orphan notice).
      const refreshed = storage.getSession(record.id)
      if (refreshed) session.record = refreshed
      if (turn.implementsChange && record.selfChangeId) {
        try { await this.settleChange(session, { stopReason: cancelled ? 'cancelled' : 'interrupted', error: message, freed: killed, terminalRecorded: true }) }
        catch (failure) { this.emit('log', `[chat ${record.id.slice(0, 8)}] change settlement failed: ${failure instanceof Error ? failure.message : String(failure)}`) }
      }
      this.scheduleQueue(session)
    }
  }

  /** The turn's persisted events after its turn.started, in seq order —
   *  what replay matches the spooled bytes against. Throws when the turn
   *  cannot be sliced exactly (no start, or past the event window). */
  private turnSlice(sessionId: string, turnId: string): ChatEnvelope[] {
    const started = storage.findEvent(sessionId, (event) => event.type === 'turn.started' && event.turnId === turnId)
    if (!started) throw new Error('the turn has no recorded start')
    const page = storage.listEvents(sessionId, started.seq)
    if (page.truncated) throw new Error('the turn runs past the transcript window')
    const slice: ChatEnvelope[] = []
    for (const envelope of page.events) {
      if (envelope.event.type === 'turn.started') break
      slice.push(envelope)
    }
    return slice
  }

  /** Settle a replayed turn: the same ending a locally run turn gets —
   *  terminal event, Caller finish, lease release, queue advance — minus
   *  the checkout backstop (its before-snapshot died with the old
   *  server; the agent's own diffs replayed from the spool). Mirrors
   *  runTurn's finally block step for step; keep them in sync. */
  private async settleReplayedTurn(session: LiveSession, turn: RunningTurn, lease: CheckoutLease, result: TurnResult): Promise<void> {
    const record = session.record
    if (result.note) this.recordTurnNote(session, turn, result.note)
    this.releaseLocalTurnSlot(turn)
    this.settlePending(session, 'cancelled')
    let freed = true
    let stopReason: StopReason = turn.guardEnd && !turn.failure ? 'end_turn'
      : turn.stopping || turn.abort.signal.aborted ? 'cancelled' : result.stopReason
    let error = result.error
    if (turn.failure && stopReason !== 'cancelled') { stopReason = 'error'; error = turn.failure }
    // An adopted turn's pre-restart relay and agent retire at this idle
    // boundary: no old-release relay outlives its adoption, and the next
    // prompt starts a fresh relay from this release, resuming natively.
    if (turn.adoptedRelay === true || turn.stopping || result.terminate === true || turn.guardEnd !== undefined || (session.adapter && !session.adapter.alive) || (session.relay && !session.relay.healthy)) {
      try { await this.stopProcess(session) } catch { freed = false }
    }
    session.draining = true
    if (!(await this.waitForServices(session, SERVICE_SETTLE_MS))) {
      try { await this.stopProcess(session) } catch { freed = false }
      await this.waitForServices(session, Number.POSITIVE_INFINITY)
    }
    if (session.staged && lease.held) {
      const report = await writeBackDocument(record.checkout, session.staged, record.id).catch((e) => ({ kind: 'conflict' as const, message: `document write-back failed: ${e instanceof Error ? e.message : String(e)}` }))
      if (report.kind !== 'unchanged' && report.kind !== 'missing') this.saveRecord(session) // revision/version moved
      if (isBridgeProblem(report)) { try { this.emit_(record.id, { type: 'error', message: report.message, recoverable: true }) } catch { /* mirror */ } }
    }
    if (turn.failure && !turn.stopping) { stopReason = 'error'; error = turn.failure }
    let terminalRecorded = false
    const durationMs = Date.now() - turn.startedAt
    try {
      const envelope = storage.finalizeTurn(record.id,
        { type: 'turn.finished', turnId: turn.id, stopReason, error, usage: result.usage, durationMs, ...(stopReason === 'cancelled' && turn.stoppedBy ? { stoppedBy: turn.stoppedBy } : {}) },
        turn.callId ? { callId: turn.callId, instance: this.instance } : undefined,
        freed && !turn.stopping && !this.stopped && !session.lifecycle.signal.aborted)
      terminalRecorded = true
      record.lastSeq = envelope.seq
      this.emit('event', envelope)
      chatTurnFinished(alertContext(record), { id: turn.id, stopReason, durationMs })
    } catch (failure) {
      // Preserve the open turn on storage failure; do not acknowledge a
      // ledger result whose recovery record was never made durable.
      this.emit('log', `[chat] terminal outcome could not be published: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
    session.turn = null
    if (terminalRecorded && turn.callId && this.caller) {
      const outcome = storage.listFinishOutbox(this.instance).find(row => row.callId === turn.callId)
      try {
        if (outcome) await this.caller.finish(turn.callId, outcome.status, outcome.error ? this.options.extensions?.redact(outcome.error) ?? outcome.error : undefined)
        storage.finishDelivered(turn.callId)
      } catch (e) {
        try { this.emit_(record.id, { type: 'error', message: `Caller did not record the turn end (it will be retried when Poise restarts): ${e instanceof Error ? e.message : String(e)}`, recoverable: true }) } catch { /* mirror */ }
      }
    }
    if (lease.held) {
      if (freed) { lease.clearWorker(); lease.release() }
      else { try { this.emit_(record.id, { type: 'error', message: 'the checkout stays locked: the agent process could not be stopped', recoverable: false }) } catch { /* mirror */ } }
    }
    if (session.lease === lease && !lease.held) session.lease = null
    // A fork learns its native id from the agent's first frames.
    if (session.adapter?.nativeSessionId && session.adapter.nativeSessionId !== record.nativeSessionId) {
      record.nativeSessionId = session.adapter.nativeSessionId
      this.saveRecord(session)
    }
    await this.refreshWorkspace(session).catch(() => undefined)
    if (record.status !== 'closed') {
      if (!freed) this.setStatus(session, 'error', record.orphanNotice || 'the agent process could not be stopped')
      else if (session.adapter?.alive) this.setStatus(session, 'idle')
      // An agent that closed itself after a turn (Claude does after a stop,
      // so a queued interjection can never run) resumes on the next prompt.
      else if (stopReason === 'cancelled' || stopReason === 'end_turn') this.setStatus(session, 'idle', 'agent process closed after the turn; it resumes on the next prompt')
      else this.setStatus(session, 'interrupted')
    }
    this.armIdleTimer(session)
    // Last: the controller hears about a change only once its worker is
    // verifiably gone and the checkout is released above. Only the
    // implementing turn settles it; later discussion in the session does not.
    if (turn.implementsChange && record.selfChangeId) {
      try { await this.settleChange(session, { stopReason, error, freed, terminalRecorded }) }
      catch (failure) { this.emit('log', `[chat ${record.id.slice(0, 8)}] change settlement failed: ${failure instanceof Error ? failure.message : String(failure)}`) }
    }
    if (terminalRecorded) this.publishQueue(session)
    if (this.drainState) await this.closeForDrain(session).catch(() => undefined)
    else if (terminalRecorded && freed) this.scheduleQueue(session)
  }

  /** Deliver every recorded change outcome the controller has not
   *  acknowledged. Safe to call at any time: rows are immutable and a
   *  delivery that fails stays queued. */
  async flushSelfUpdateOutbox(): Promise<void> {
    if (!this.selfUpdate?.configured) return
    for (const row of finishOutbox.listUndelivered(this.instance)) {
      try {
        await this.selfUpdate.finish(row.changeId, { outcome: row.outcome, ...(row.error ? { error: row.error } : {}) })
        finishOutbox.markDelivered(row.changeId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        finishOutbox.markAttempt(row.changeId, message)
        this.emit('log', `[chat] self-update finish for change ${row.changeId.slice(0, 8)} still undelivered: ${message}`)
        // A refusal (unknown or already settled change) does not block the
        // rows behind it; an unreachable controller ends the pass.
        if (error instanceof SelfUpdateUnavailableError) return
      }
    }
  }

  /** Stop the server. Running turns a healthy relay holds are handed to
   *  the next server by default; `handover: false` stops everything
   *  instead (tests use it for isolation). */
  async stop(options: { handover?: boolean } = {}): Promise<void> {
    this.stopped = true
    const handover = options.handover ?? true
    for (const timer of this.queueTimers.values()) clearTimeout(timer)
    this.queueTimers.clear()
    await Promise.all([...this.live.values()].map(async (session) => {
      session.lifecycle.abort()
      await this.forceStop(session, 'server stopping', handover)
      // A handed-over turn belongs to the next server now: no shutdown, no
      // lease release, no waiting on a runTurn that already left quietly.
      if (session.relayDetached) {
        if (session.idleTimer) clearTimeout(session.idleTimer)
        return
      }
      await this.serialized(session, () => this.shutdownSession(session)).catch(() => undefined)
    }))
  }

  /** Outside the operation chain: cancel a turn and, if the agent does not
   *  settle, terminate its process. Resolves once the turn's own cleanup
   *  can run (or the process is gone). On server stop a turn a healthy
   *  relay holds is handed over instead: the relay keeps the agent
   *  running, the turn settles without recording anything, and the lease
   *  row stays for the next server to adopt. Nothing is written to the
   *  agent. Explicit close/delete/reset never hand over: the person asked
   *  to stop. */
  private async forceStop(session: LiveSession, reason: string, handover = false): Promise<void> {
    const turn = session.turn
    if (!turn) return
    // Only a turn the relay spools is handed over: before turnStart or
    // past turnFinish there is no spool for the next server to adopt,
    // so those turns settle here instead of being interrupted there. A
    // turn with a Stop already asked for is never handed over either:
    // the stop is finished here, verifiably, instead of being dropped
    // by the adoption.
    if (handover && turn.relayHeld && session.relay?.healthy && session.record.stopRequestedTurnId !== turn.id) {
      session.relayDetached = true
      turn.stopping = true
      const relay = session.relay
      relay.detach()
      if (await this.waitForTurnEnd(session, turn, STOP_SETTLE_MS)) return
      this.emit('log', `[chat ${session.record.id.slice(0, 8)}] turn did not settle after detach; leaving it for adoption`)
      return
    }
    turn.stopping = true
    turn.failure ??= reason
    this.settlePending(session, 'cancelled')
    turn.abort.abort()
    try { await session.adapter?.cancel() } catch { /* terminating below */ }
    if (await this.waitForTurnEnd(session, turn, STOP_SETTLE_MS)) return
    // The agent did not acknowledge: the process goes, verifiably, and the
    // turn's finally block then runs with the adapter's rejection.
    await this.stopProcess(session).catch(() => undefined)
    await this.waitForTurnEnd(session, turn, CLOSE_GRACE_MS * 2)
  }

  private async shutdownSession(session: LiveSession): Promise<void> {
    if (session.relayDetached) throw new ChatError(409, 'the session belongs to another server', 'checkout_busy')
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (session.turn) return // still running after forceStop: leave it, the lease stays
    await this.stopProcess(session)
    this.releaseSettledLease(session)
    if (session.record.status !== 'closed' && session.record.status !== 'error') this.setStatus(session, 'idle')
  }

  /** A failed worker stop deliberately retains the lease. Once a later close
   * or resume verifies termination, release that same token, not a new lease. */
  private releaseSettledLease(session: LiveSession): void {
    const lease = session.lease
    if (!lease?.held) return
    if (session.startup || session.services || session.turn?.agentInvoked || session.relay?.healthy || session.adapter?.alive
      || storage.getWorker(session.record.id) || this.bootstrapStillRunning(session, lease)) {
      throw new ChatError(409, 'the checkout still has active work; its lease remains held', 'checkout_busy')
    }
    lease.clearWorker()
    lease.release()
    session.lease = null
    session.record.orphanNotice = undefined
    this.saveRecord(session)
  }

  private bootstrapStillRunning(session: LiveSession, lease: CheckoutLease): boolean {
    if (!session.bootstrapUnsettled) return false
    const row = lease.read()
    const alive = row?.token === lease.currentToken && (
      (row.worker_pgid && (this.leaseProbes.pgidAlive ?? pgidAlive)(row.worker_pgid))
      || (row.worker_pid && (this.leaseProbes.pidAlive ?? pidAlive)(row.worker_pid)))
    if (!alive) session.bootstrapUnsettled = false
    return !!alive
  }

  // ── Drain and readiness ────────────────────────────────────────────────
  //
  // The release controller drains this server before restarting it: from
  // that moment no new turn, session, upload or model change is accepted,
  // while everything already running finishes on its own. Cancel, close,
  // answering the agent's requests and reads stay available, so a person is
  // never locked out of ending a turn that is in the way.

  get draining(): DrainState | null {
    return this.drainState
  }

  /** Refuse new work from now on. Synchronous: no request that arrives
   *  after this returns can start a turn. Idle agent processes are then
   *  closed in each session's own lifecycle queue (their native ids stay,
   *  so they resume on the next prompt after the restart); a turn that is
   *  running finishes on its own and closes its process afterwards.
   *  Calling it again only updates the release it is for. */
  startDrain(releaseId: string): DrainState {
    if (!this.drainState || this.drainState.releaseId !== releaseId) this.drainState = { releaseId, since: new Date().toISOString() }
    for (const session of this.live.values()) {
      if (session.turn || !(session.adapter?.alive || session.relay?.healthy)) continue
      void this.serialized(session, () => this.closeForDrain(session)).catch(() => undefined)
    }
    return this.drainState
  }

  endDrain(): void {
    this.drainState = null
    // A server that is stopping leaves waited prompts durable for the next
    // server: consuming them now would refuse each against a closing session.
    if (this.stopped || this.switchState) return
    // Interrupted work resumes before prompts that waited behind an update; the
    // synchronous reserves below land before the queue pump behind them —
    // then the queues pump.
    void this.resumeAfterUpdate(new Set()).then(() => {
      for (const session of this.live.values()) this.scheduleQueue(session)
    }, (error: unknown) => {
      this.emit('log', `[chat] releasing prompts waited for an update failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** The drain outlasted its turns: stop every running one through the
   *  person's Stop path, with the given notice in its transcript. Sessions
   *  without a turn are left alone. Resolves with the number of turns
   *  stopped, never rejects: a session that fails to stop is logged, and
   *  the gateway's own timeout still cuts what will not settle. */
  async stopTurnsForDrain(notice: string): Promise<number> {
    if (!this.drainState) throw new Error('cannot stop turns for a drain without an active drain')
    let stopped = 0
    for (const session of this.live.values()) {
      if (!session.turn) continue
      try {
        this.emit_(session.record.id, { type: 'error', message: notice, recoverable: true })
        await this.cancel(session.record.id)
        stopped += 1
      } catch (error) {
        this.emit('log', `[chat ${session.record.id.slice(0, 8)}] turn not stopped for the drain: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return stopped
  }

  /** Inside the session's chain: close an idle agent process for the
   *  restart. Verifiable — a process that will not go stays counted. */
  private async closeForDrain(session: LiveSession): Promise<void> {
    if (!this.drainState || session.turn || session.record.status === 'closed') return
    if (!(session.adapter?.alive || session.relay?.healthy)) return
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    await this.stopProcess(session)
    this.emit_(session.record.id, { type: 'status.changed', status: session.record.status, detail: 'agent process closed for the Poise update; it resumes on the next prompt' })
  }

  // ── Switch wait ────────────────────────────────────────────────────
  //
  // While a release switch is pending, an admissible prompt waits behind
  // the update instead of starting: it is stored durably, in arrival
  // order, and nothing about admission itself changes — the same
  // validation, the same guards, the same errors. Queued messages wait
  // unclaimed in their queue and internal deliveries stay pending in the
  // control inbox, so both keep their provenance. Turns that are still
  // running when the switch bound passes are cancelled through the
  // normal cancel path and their sessions recorded; after the restart
  // each recorded session gets exactly one automatic continue prompt on
  // its resumed native session, then the waiting prompts start in order.
  // A switch that is withdrawn instead starts the waiting prompts at
  // once, with no interruption and no continue.

  get switchPending(): SwitchWait | null {
    return this.switchState
  }

  /** A release switch is pending from now on; null clears it silently, for
   *  a server that is stopping anyway. Withdrawing a live switch releases
   *  the wait instead, so the waiting prompts start. */
  setSwitchPending(release: string | null): void {
    if (release === null) { this.switchState = null; return }
    if (!this.switchState || this.switchState.release !== release) this.switchState = { release, since: new Date().toISOString() }
  }

  /** The pending switch went away without a restart. Resume any turns its
   *  bound already interrupted, then release waiting prompts in order. */
  async releaseSwitchWait(): Promise<void> {
    this.switchState = null
    if (this.stopped) return
    try {
      await this.resumeAfterUpdate(new Set(), SWITCH_WITHDRAWN_CONTINUE_PROMPT)
      for (const record of storage.listSessions(this.instance)) this.scheduleQueue(this.requireLive(record.id))
    } catch (error) {
      this.emit('log', `[chat] releasing prompts waited for an update failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Sessions with a turn running right now: what a switch bound interrupts. */
  runningTurnSessions(): Array<Omit<InterruptedSession, 'at'>> {
    const running: Array<Omit<InterruptedSession, 'at'>> = []
    for (const session of this.live.values()) {
      const turn = session.turn
      if (!turn) continue
      running.push({ sessionId: session.record.id, turnId: turn.id, ...(turn.implementsChange ? { implementsChange: true } : {}),
        ...(!turn.requestInvoked && turn.input ? { prompt: turn.input, shown: turn.shown, source: turn.source,
          switches: turn.switches,
          sourceSessionId: turn.queueItem?.sourceSessionId ?? turn.inputSourceSessionId,
          model: turn.queueItem?.model ?? turn.commandModel, effort: turn.queueItem?.effort ?? turn.commandEffort } : {}) })
    }
    return running
  }

  /** Keep the current interruption and each earlier unsent request once.
   *  A native session needs only its latest generic continuation. */
  recordSwitchInterrupted(sessions: Array<Omit<InterruptedSession, 'at'>>): void {
    if (sessions.length === 0) return
    const at = new Date().toISOString()
    const fresh = new Set(sessions.map(session => `${session.sessionId}:${session.turnId}`))
    const current = new Set(sessions.map(session => session.sessionId))
    db.transaction(() => {
      this.writeInterruptedSessions([
        ...sessions.map(session => ({ ...session, at })),
        ...this.readInterruptedSessions().filter(row => !fresh.has(`${row.sessionId}:${row.turnId}`)
          && (!current.has(row.sessionId) || row.prompt)),
      ])
      // Deferral keeps a continuation's origin: only an older automatic
      // continuation is superseded, never a literal message that waited.
      this.writeWaitingPrompts(this.readWaitingPrompts().filter(entry =>
        !entry.continuationTurnId || !current.has(entry.sessionId)))
    })()
  }

  /** After any restart: each interrupted session gets exactly one automatic
   *  continue prompt on its resumed native session, then the prompts that
   *  waited behind the update start in order. Each entry is consumed before
   *  it is acted on, so a crash mid-resume loses only the entry in flight.
   *  Sessions another live server of this instance holds are left for a
   *  later recovery. */
  private async resumeAfterUpdate(protectedSessions: ReadonlySet<string>, continuation = SWITCH_CONTINUE_PROMPT): Promise<void> {
    this.deferredWaitingSessions.clear()
    const blocked = new Set(protectedSessions)
    for (const row of this.readInterruptedSessions()) {
      if (this.stopped || this.drainState || this.switchState) return
      if (blocked.has(row.sessionId)) continue
      if (this.deferChangeFollowUp(row.sessionId, row)) {
        if (row.continuation !== continuation) this.writeInterruptedSessions(this.readInterruptedSessions()
          .map(entry => entry.sessionId === row.sessionId && entry.turnId === row.turnId ? { ...entry, continuation } : entry))
        blocked.add(row.sessionId)
        continue
      }
      const outcome = await this.resumeInterruptedSession(row, continuation)
      if (outcome === 'deferred') blocked.add(row.sessionId)
    }
    await this.startWaitingPrompts(blocked)
  }

  private async resumeInterruptedSession(row: InterruptedSession, continuation: string): Promise<WaitingDelivery> {
    if (this.recoveryOwnedElsewhere(row.sessionId)) return 'deferred'
    if (this.recoveryHeld(row.sessionId) || this.live.get(row.sessionId)?.turn || storage.getOpenTurn(row.sessionId)) {
      // Keep this specific recovery while Stop or a current turn blocks it,
      // preserving the withdrawal/restart reason until it can run.
      if (row.continuation !== continuation) this.writeInterruptedSessions(this.readInterruptedSessions()
        .map(entry => entry.sessionId === row.sessionId && entry.turnId === row.turnId ? { ...entry, continuation } : entry))
      return 'deferred'
    }
    if (!this.takeInterruptedSession(row.sessionId, row.turnId)) return 'admitted'
    const prompt = row.prompt ?? { text: continuation, attachments: [], mentions: [] }
    const recovery = row.prompt || row.implementsChange ? row : undefined
    const waiting: WaitingPrompt | undefined = row.prompt ? undefined : {
      id: randomUUID(), sessionId: row.sessionId, prompt, createdAt: row.at, queueBefore: [],
      continuationTurnId: row.turnId, ...(recovery ? { recovery } : {}),
    }
    return this.deliverWaitingPrompt(row.sessionId, prompt, 'interrupted', recovery, waiting)
  }

  /** Start every prompt that waited behind an update, in arrival order. */
  private async startWaitingPrompts(protectedSessions: ReadonlySet<string> = new Set()): Promise<void> {
    const blocked = new Set<string>()
    for (const entry of this.readWaitingPrompts()) {
      if (this.stopped || this.drainState || this.switchState) return
      if (blocked.has(entry.sessionId)) continue
      if (protectedSessions.has(entry.sessionId) || this.recoveryOwnedElsewhere(entry.sessionId)) continue
      if (this.waitingPromptBlocked(entry)) { blocked.add(entry.sessionId); continue }
      if (this.deferChangeFollowUp(entry.sessionId, entry.recovery)) { blocked.add(entry.sessionId); continue }
      if (!this.takeWaitingPrompt(entry.id)) continue
      const outcome = await this.deliverWaitingPrompt(entry.sessionId, entry.prompt, 'waiting', entry.recovery, entry)
      if (outcome === 'deferred') blocked.add(entry.sessionId)
    }
  }

  /** Follow-ups share the queue's controller-release gate, including after
   *  restart. The never-started implementation itself still admits normally. */
  private deferChangeFollowUp(sessionId: string, recovery?: SwitchPromptMetadata): boolean {
    if (!storage.getSession(sessionId)?.selfChangeId || recovery?.implementsChange) return false
    if (!this.recoveryOwnedElsewhere(sessionId)) this.scheduleQueue(this.requireLive(sessionId))
    return true
  }

  private waitingPromptBlocked(entry: WaitingPrompt): boolean {
    if (this.recoveryHeld(entry.sessionId)) return true
    if (this.live.get(entry.sessionId)?.turn || storage.getOpenTurn(entry.sessionId)) return true
    const queue = this.messageQueue(entry.sessionId)
    if (queue.executorSessionId && queue.executorSessionId !== entry.sessionId) return false
    if (!queue.ready) return false
    // Older persisted entries predate the queue boundary. Keep their stored
    // timestamp ordering; new entries record IDs so clock ties cannot reorder.
    const before = new Set(entry.queueBefore ?? queue.items.filter(item => item.createdAt <= entry.createdAt).map(item => item.id))
    return queue.items.some(item => item.state === 'waiting' && before.has(item.id))
  }

  private recoveryHeld(sessionId: string): boolean {
    return holds(this.instance).some(hold => hold.sessionId === sessionId)
  }

  /** Release paths have no startup protection set. Recheck the live owner
   *  before consuming durable work that another server must recover. */
  private recoveryOwnedElsewhere(sessionId: string): boolean {
    const record = storage.getSession(sessionId)
    if (!record) return false
    if (record.instance !== this.instance) return true
    try {
      const row = new CheckoutLease(record.checkout, { ownerKind: 'poise:chat', ownerId: sessionId,
        ownerLabel: '', instance: this.instance }, this.leaseProbes).read()
      return !!row && row.owner_kind === 'poise:chat' && row.owner_id === sessionId
        && row.host_pid !== this.hostPid && (this.leaseProbes.pidAlive ?? pidAlive)(row.host_pid)
    } catch (error) {
      this.emit('log', `[chat] recovery ownership for ${sessionId.slice(0, 8)} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
      return true
    }
  }

  /** Start one prompt that outlived a restart: at once when its session is
   *  idle, or queued behind the turn running there. A prompt for a deleted
   *  session is dropped; one that fails transiently waits for the next
   *  restart; one that can never run says so on its session. Never throws:
   *  one bad entry must not stop the entries behind it. */
  private async deliverWaitingPrompt(sessionId: string, prompt: PromptInput, kind: 'interrupted' | 'waiting', recovery?: SwitchPromptMetadata, waiting?: WaitingPrompt): Promise<WaitingDelivery> {
    try {
      const outcome = await this.deliverWaitingPromptInner(sessionId, prompt, kind, recovery, waiting)
      if (outcome === 'deferred') this.deferredWaitingSessions.add(sessionId)
      return outcome
    } catch (error) {
      this.emit('log', `[chat] ${kind} prompt for ${sessionId.slice(0, 8)} failed: ${error instanceof Error ? error.message : String(error)}`)
      this.deferredWaitingSessions.add(sessionId)
      return 'deferred'
    }
  }

  private async deliverWaitingPromptInner(sessionId: string, prompt: PromptInput, kind: 'interrupted' | 'waiting', recovery?: SwitchPromptMetadata, waiting?: WaitingPrompt): Promise<WaitingDelivery> {
    const short = sessionId.slice(0, 8)
    const drop = (message: string): void => {
      this.emit('log', `[chat] ${kind} prompt for ${short} dropped: ${message}`)
      this.resetWaitingStatus(sessionId)
      if (this.ownsSession(sessionId)) {
        try { this.emit_(sessionId, { type: 'error', message: `A message that waited for the Poise update could not start: ${message}`, recoverable: true }) } catch { /* mirror */ }
      }
    }
    // A prompt for a deleted session is dropped without a notice: deleting
    // the session deleted its future work with it.
    const gone = (message: string): void => {
      this.emit('log', `[chat] ${kind} prompt for ${short} dropped: ${message}`)
    }
    const defer = (message: string): void => {
      const entry = waiting ?? { id: randomUUID(), sessionId, prompt, createdAt: new Date().toISOString(), queueBefore: [], ...(recovery ? { recovery } : {}) }
      const rows = this.readWaitingPrompts()
      const next = rows.findIndex(row => row.sessionId === sessionId)
      rows.splice(kind === 'interrupted' ? 0 : next < 0 ? rows.length : next, 0, entry)
      this.writeWaitingPrompts(rows)
      this.emit('log', `[chat] ${kind} prompt for ${short} still waiting: ${message}`)
    }
    try {
      const receipt = this.prompt(sessionId, prompt)
      if (recovery) {
        if ('turnId' in receipt) {
          // prompt() reserved this turn synchronously; its serialized work
          // starts after these original admission attributes are restored.
          const turn = this.requireLive(sessionId).turn!
          turn.source = recovery.source
          turn.shown = recovery.shown ?? turn.shown
          turn.inputSourceSessionId = recovery.sourceSessionId
          turn.commandModel = recovery.model ?? turn.commandModel
          turn.commandEffort = recovery.effort
          turn.implementsChange = recovery.implementsChange
          turn.switches = recovery.switches ?? turn.switches
        } else {
          this.writeWaitingPrompts(this.readWaitingPrompts().map(entry => entry.id === receipt.waitId ? { ...entry, recovery } : entry))
        }
      }
      // A switch already pending on the fresh server waits it again.
      if (!('turnId' in receipt)) this.emit('log', `[chat] ${kind} prompt for ${short} waits behind a new update`)
      return 'admitted'
    } catch (error) {
      if (error instanceof ChatError && error.statusCode === 404) { gone(error.message); return 'dropped' }
      if (kind === 'interrupted' && error instanceof ChatError && error.statusCode === 409 && this.live.get(sessionId)?.turn) {
        // A continuation belongs before every follow-up. The durable waiting
        // lane keeps that priority while the current turn finishes; appending
        // it to the normal queue would put older follow-ups ahead of it.
        defer(error.message)
        return 'admitted'
      }
      // A prompt its session cannot take now waits in its queue — or, when
      // queuing is itself unavailable, for the next restart. A 503 (a drain
      // in force) fails the enqueue the same way and defers the same way.
      if (!(error instanceof ChatError) || error.statusCode === 409 || error.statusCode === 503) {
        if (error instanceof ChatError) {
          try {
            await this.enqueue(sessionId, randomUUID(), prompt, recovery?.model, recovery?.effort, recovery)
            return 'admitted'
          } catch (queued) {
            if (queued instanceof ChatError && queued.statusCode === 404) { gone(queued.message); return 'dropped' }
            if (queued instanceof ChatError && queued.statusCode === 400) { drop(queued.message); return 'dropped' }
            defer(queued instanceof Error ? queued.message : String(queued))
            return 'deferred'
          }
        }
        defer(error instanceof Error ? error.message : String(error))
        return 'deferred'
      }
      drop(error.message)
      return 'dropped'
    }
  }

  /** A waiting prompt that can never start leaves no stale `queued` behind. */
  private resetWaitingStatus(sessionId: string): void {
    const live = this.live.get(sessionId)
    if (live) {
      if (!live.turn && live.record.status === 'queued') this.setStatus(live, 'idle')
      return
    }
    const record = storage.getSession(sessionId)
    if (record && record.instance === this.instance && record.status === 'queued' && !storage.getOpenTurn(sessionId)) {
      storage.saveSession({ ...record, status: 'idle', queuedBehind: undefined, updatedAt: new Date().toISOString() })
    }
  }

  private readWaitingPrompts(): WaitingPrompt[] {
    try {
      const raw = getMeta(SWITCH_WAITING_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as WaitingPrompt[]
      if (!Array.isArray(parsed)) return []
      return parsed.filter(entry => entry && typeof entry.id === 'string' && typeof entry.sessionId === 'string'
        && entry.prompt && typeof entry.prompt.text === 'string')
    } catch {
      return []
    }
  }

  private writeWaitingPrompts(entries: WaitingPrompt[]): void {
    setMeta(SWITCH_WAITING_KEY, JSON.stringify(entries))
  }

  private takeWaitingPrompt(id: string): WaitingPrompt | null {
    const entries = this.readWaitingPrompts()
    const entry = entries.find(candidate => candidate.id === id) ?? null
    if (entry) this.writeWaitingPrompts(entries.filter(candidate => candidate.id !== id))
    return entry
  }

  private readInterruptedSessions(): InterruptedSession[] {
    try {
      const raw = getMeta(SWITCH_INTERRUPTED_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as InterruptedSession[]
      if (!Array.isArray(parsed)) return []
      return parsed.filter(row => row && typeof row.sessionId === 'string' && typeof row.turnId === 'string')
    } catch {
      return []
    }
  }

  private writeInterruptedSessions(rows: InterruptedSession[]): void {
    setMeta(SWITCH_INTERRUPTED_KEY, JSON.stringify(rows))
  }

  private takeInterruptedSession(sessionId: string, turnId: string): InterruptedSession | null {
    const rows = this.readInterruptedSessions()
    const row = rows.find(candidate => candidate.sessionId === sessionId && candidate.turnId === turnId) ?? null
    if (row) this.writeInterruptedSessions(rows.filter(candidate => candidate.sessionId !== sessionId || candidate.turnId !== turnId))
    return row
  }

  /** Work that a restart would cut: turns, startups, the agent's Poise-served
   *  file operations, queued lifecycle operations, live agent processes,
   *  recovery and any public operation still between its call and its
   *  acknowledgement. Zero means quiescent; anything the runtime is unsure
   *  about counts. */
  busy(): number {
    let count = this.inflightOps + (this.recovering ? 1 : 0)
    for (const session of this.live.values()) {
      const own = (session.turn ? 1 : 0) + session.services + session.pendingOps
      count += own > 0 ? own : ACTIVE_STATUSES.includes(session.record.status) || session.adapter?.alive || session.relay?.healthy ? 1 : 0
    }
    return count
  }

  /**
   * The work a server restart would cut: what busy() counts, except agent
   * processes that sit idle between turns, which the next turn starts again,
   * and turns whose spool a healthy relay holds, which the next server
   * adopts. A turn still before its turnStart, or already past its
   * turnFinish in its settle, has no spool to adopt and is waited for.
   * A release switch waits for this alone.
   */
  working(): number {
    let count = this.inflightOps + (this.recovering ? 1 : 0)
    for (const session of this.live.values()) {
      if (session.turn?.relayHeld && session.relay?.healthy) continue
      // A prompt waiting behind a Poise update holds nothing a restart would
      // cut: it is durable, and the next server starts it. Whatever the
      // session keeps from before it queued — a live process, even a turn
      // past its recorded outcome — must never hold the very switch it
      // waits for. An operation still running on it, like an accepted
      // revert, does hold the switch. A turn still recorded open holds the
      // switch through the open-turn gate instead, and the bound cancels it.
      if (session.record.status === 'queued' && session.record.queuedBehind === SWITCH_WAIT_REASON) {
        count += session.pendingOps
        continue
      }
      const own = (session.turn ? 1 : 0) + session.services + session.pendingOps
      count += own > 0 ? own : ACTIVE_STATUSES.includes(session.record.status) ? 1 : 0
    }
    return count
  }

  /** Sessions whose running turn's spool a healthy relay holds: a restart
   *  hands them to the next server instead of cutting them, so the release
   *  switch does not wait for their turns either. */
  relayHeldSessions(): Set<string> {
    const held = new Set<string>()
    for (const session of this.live.values()) {
      if (session.turn?.relayHeld && session.relay?.healthy) held.add(session.record.id)
    }
    return held
  }

  private assertAcceptingWork(): void {
    if (this.drainState) throw new ChatError(503, 'Poise is installing an update; new work is refused until it restarts', 'draining')
  }

  /** Count a public operation from its call to its settlement. */
  private async track<T>(operation: () => Promise<T>): Promise<T> {
    this.inflightOps += 1
    try {
      return await operation()
    } finally {
      this.inflightOps -= 1
    }
  }

  // ── Catalog and agents ─────────────────────────────────────────────────

  async agents(): Promise<{ agents: AgentAvailability[], catalog: Catalog }> {
    const catalog = await this.catalog()
    const agents = await catalogueAgents(catalog, claudeAuth.snapshot().status === 'authenticated', (id) => this.availabilityOf(id))
    return { agents, catalog }
  }

  private async availabilityOf(agent: AgentId): Promise<{ ok: boolean, reason?: string }> {
    const cached = this.availability.get(agent)
    if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.result
    const result = await this.probeAgent(agent).catch((error) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
    this.availability.set(agent, { at: Date.now(), result })
    return result
  }

  /** The local checkout a repository's sessions run in. */
  checkoutFor(repo: string): Promise<string> {
    return this.resolveCheckout(repo)
  }

  private async resolveModel(identity: string, effortOverride?: string, efforts?: string[]): Promise<{ agent: AgentId, model: CatalogModel, effort: string }> {
    const catalog = await this.catalog()
    const model = catalogModel(catalog, identity)
    if (!model) throw new ChatError(400, `unknown model ${identity}`, 'invalid')
    const agent = PROVIDER_AGENT[model.provider]
    if (!agent) throw new ChatError(400, `${identity} runs on ${model.provider}, which is not in Chat v1`, 'unsupported')
    const effort = effortOverride || model.effort
    const variants = catalog.models.filter(m => m.provider === model.provider && m.selector === model.selector)
    const selected = variants.find(m => m.effort === effort)
    if (!selected || (efforts?.length && !efforts.includes(effort))) {
      throw new ChatError(400, `${model.selector} offers catalogue efforts ${variants.map(m => m.effort).join(', ')}`, 'invalid')
    }
    return { agent, model: selected, effort: selected.effort }
  }

  // ── Sessions ───────────────────────────────────────────────────────────

  list(): SessionRecord[] {
    return storage.listSessions(this.instance).map((record) => this.withLive(record))
  }

  get(id: string): SessionRecord | null {
    const record = storage.getSession(id)
    if (!record) return null
    if (record.instance !== this.instance) throw new ChatError(409, `this session belongs to another Poise server (${record.instance})`, 'foreign_session')
    return this.withLive(record)
  }

  events(id: string, afterSeq: number): { events: ChatEnvelope[], truncated: boolean } {
    this.get(id)
    return storage.listEvents(id, afterSeq)
  }

  ownsSession(id: string): boolean {
    return storage.sessionInstance(id) === this.instance
  }

  private withLive(record: SessionRecord): SessionRecord {
    const live = this.live.get(record.id)
    if (live) { live.record.pendingRequests = [...live.pending.keys()]; record = live.record }
    const queue = this.messageQueue(record.id)
    const timers = timerSummaries(this.instance, record.id)
    // Live summaries are computed on a copy, never on `live.record`, and
    // sessions without any read exactly as before.
    if (!queue.revision && !timers.length) {
      if (record.timers === undefined) return record
      const clean = { ...record }
      delete clean.timers
      return clean
    }
    const clean = { ...record }
    delete clean.timers
    return { ...clean, ...(queue.revision ? { queue } : {}), ...(timers.length ? { timers } : {}) }
  }

  private requireLive(id: string): LiveSession {
    const record = this.get(id)
    if (!record) throw new ChatError(404, 'unknown session', 'unknown_session')
    let live = this.live.get(id)
    if (!live) {
      // The staged document rides on the record: the live object and the
      // persisted one are the same reference, so saving the record saves it.
      live = { record, adapter: null, startup: null, relay: null, relayDetached: false, lease: null, turn: null, pending: new Map(), grants: new Map(), idleTimer: null, lifecycle: new AbortController(), services: 0, draining: false, staged: record.staged ?? null, chain: Promise.resolve(), steering: Promise.resolve(), pendingOps: 0 }
      this.live.set(id, live)
    }
    return live
  }

  private serialized<T>(session: LiveSession, operation: () => Promise<T>): Promise<T> {
    session.pendingOps += 1
    const settle = <R>(value: R): R => { session.pendingOps -= 1; return value }
    const run = session.chain.then(operation, operation).then(settle, (error) => { settle(undefined); throw error })
    session.chain = run.catch(() => undefined)
    return run
  }

  async create(request: NewSessionRequest): Promise<SessionRecord> {
    this.assertAcceptingWork() // before any await: the drain flag is checked atomically
    if (request.subject) return (await this.createForSubject({ ...request, subject: request.subject })).session
    if (request.role !== undefined && request.role !== 'manager' && request.role !== 'worker') throw new ChatError(400, 'role must be "manager", "worker" or absent', 'invalid')
    if (request.role === 'manager') {
      if (request.repo !== undefined || request.branch !== undefined || request.checkout !== undefined) {
        throw new ChatError(400, 'A Manager runs in its own local workspace; repo, branch and checkout are not accepted.', 'invalid')
      }
      if (request.context !== undefined) throw new ChatError(400, 'A Manager starts without card or document context.', 'invalid')
      const existing = storage.managerSession(this.instance)
      if (existing) throw new ChatError(409, 'A Manager already exists.', 'manager_exists', { manager: { id: existing.id } })
    }
    return this.track(() => this.createSession(request))
  }

  /** Managed workers never share the manager's local checkout lease. */
  async createChild(parentId: string, request: Pick<NewSessionRequest, 'model' | 'effort' | 'title'>): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const parent = this.get(parentId)
    if (!parent || parent.status === 'closed') throw new ChatError(404, 'unknown active manager', 'unknown_session')
    return this.track(async () => {
      const { agent } = await this.resolveModel(request.model, request.effort)
      return this.createSession({ ...request, agent, deferStart: true, safeMode: parent.safeMode === true, autoMerge: parent.autoMerge }, true, actorOf(parent))
    })
  }

  /** A Poise-owned chat in its own scratch workspace, with no manager: the
   *  Switchboard. Without Safe mode, so no one has to approve its reads. */
  async createDetached(request: Pick<NewSessionRequest, 'model' | 'effort' | 'title' | 'context'>): Promise<SessionRecord> {
    this.assertAcceptingWork()
    return this.track(async () => {
      const { agent } = await this.resolveModel(request.model, request.effort)
      return this.createSession({ ...request, agent, deferStart: true, safeMode: false }, true)
    })
  }

  /** The subject's session: the existing one in any state, or a new one
   *  whose first event imports the earlier conversation. Runs under a
   *  per-subject lock in the process; the unique index is the final
   *  authority across processes, and a request that loses the insert
   *  removes the workspace it just made and returns the winner. */
  async createForSubject(request: NewSessionRequest & { subject: ChatSubject }): Promise<{ session: SessionRecord, existing: boolean }> {
    this.assertAcceptingWork()
    if (request.role !== undefined && request.role !== 'manager' && request.role !== 'worker') throw new ChatError(400, 'role must be "manager", "worker" or absent', 'invalid')
    if (request.role === 'manager') throw new ChatError(400, 'A Manager has no subject.', 'invalid')
    const key = `${request.subject.surface}:${request.subject.key}`
    const prior = this.subjectLocks.get(key)
    let release!: () => void
    const mine = new Promise<void>((resolve) => { release = resolve })
    this.subjectLocks.set(key, mine)
    await (prior ?? Promise.resolve()).catch(() => undefined)
    try {
      return await this.track(() => this.createSessionForSubject(request))
    } finally {
      release()
      if (this.subjectLocks.get(key) === mine) this.subjectLocks.delete(key)
    }
  }

  private async createSessionForSubject(request: NewSessionRequest & { subject: ChatSubject }): Promise<{ session: SessionRecord, existing: boolean }> {
    const found = storage.sessionForSubject(this.instance, request.subject.surface, request.subject.key)
    if (found) {
      const session = this.get(found)
      if (session) return { session, existing: true }
    }
    let legacyId: string | null = null
    let legacy: { turns: Array<{ prompt: string, reply: string, at: string, status: string }>, omitted: number } | null = null
    if (!request.skipLegacy) {
      legacyId = await legacyIdFor(request.subject)
      if (legacyId) {
        try {
          legacy = await readLegacyConversation(legacyId)
        } catch (error) {
          throw new ChatError(502, `Earlier conversation could not be read: ${error instanceof Error ? error.message : String(error)}`, 'legacy_unreadable')
        }
      }
    }
    let record: SessionRecord
    try {
      record = await this.createSession({ ...request, deferStart: false })
    } catch (error) {
      if (error instanceof SubjectTakenError) {
        const winner = storage.sessionForSubject(this.instance, request.subject.surface, request.subject.key)
        const session = winner ? this.get(winner) : null
        if (session) return { session, existing: true }
      }
      throw error
    }
    if (legacy && legacyId && legacy.turns.length) {
      record.importedFrom = legacyId
      this.saveRecord(this.requireLive(record.id))
      this.emit_(record.id, { type: 'history.imported', legacyId, turns: legacy.turns, omitted: legacy.omitted })
    }
    return { session: record, existing: false }
  }

  /** Record a `/content` or `/consensus` step in a session's transcript.
   *  Neither command starts a native turn. Unknown and foreign sessions
   *  are refused before the caller launches anything. */
  recordCommandEvent(id: string, event: Extract<ChatEvent, { type: 'content.started' | 'consensus.started' | 'consensus.finished' | 'timer.changed' }>): void {
    const record = storage.getSession(id)
    if (!record) throw new ChatError(404, 'unknown session', 'unknown_session')
    if (record.instance !== this.instance) throw new ChatError(409, `this session belongs to another Poise server (${record.instance})`, 'foreign_session')
    this.emit_(id, event)
  }

  /** Record the person's decision on one proposed edit card. The stored
   *  message is re-parsed with the same parser the transcript renders with,
   *  so a card index means the same on both sides. An unfinished turn, an
   *  unknown message or an index the parser does not produce is refused;
   *  otherwise the decision is recorded and the last one for a card wins. */
  async decideEdit(sessionId: string, request: { turnId: string, messageId: string, index: number, decision: EditDecision }): Promise<void> {
    const record = storage.getSession(sessionId)
    if (!record) throw new ChatError(404, 'unknown session', 'unknown_session')
    if (record.instance !== this.instance) throw new ChatError(409, `this session belongs to another Poise server (${record.instance})`, 'foreign_session')
    let finished = false
    let text: string | null = null
    let cursor = 0
    for (;;) {
      const page = storage.listEvents(sessionId, cursor)
      for (const { event } of page.events) {
        if (event.type === 'turn.finished' && event.turnId === request.turnId) finished = true
        else if (event.type === 'text.delta' && event.turnId === request.turnId && event.messageId === request.messageId) {
          text = (text ?? '') + event.delta
        }
      }
      if (!page.truncated || !page.events.length) break
      cursor = page.events[page.events.length - 1].seq
    }
    if (!finished || text === null) throw new ChatError(409, 'no such edit card', 'invalid')
    const edits = tryParseStructuredReply(text)?.edits ?? []
    if (request.index >= edits.length) throw new ChatError(409, 'no such edit card', 'invalid')
    this.emit_(sessionId, { type: 'edit.decided', turnId: request.turnId, messageId: request.messageId, index: request.index, decision: request.decision })
  }

  private async createSession(request: NewSessionRequest, isolated = false, createdBy?: ChatActor, beforeInsert?: () => void): Promise<SessionRecord> {
    if (this.stopped) throw new ChatError(503, 'the chat runtime is stopping', 'agent_error')
    if (request.deferStart !== undefined && typeof request.deferStart !== 'boolean') throw new ChatError(400, 'deferStart must be a boolean', 'invalid')
    if (request.safeMode !== undefined && typeof request.safeMode !== 'boolean') throw new ChatError(400, 'safeMode must be a boolean', 'invalid')
    if (request.autoMerge !== undefined && typeof request.autoMerge !== 'boolean') throw new ChatError(400, 'autoMerge must be a boolean', 'invalid')
    if (!AGENT_IDS.includes(request.agent)) throw new ChatError(400, `unknown agent ${String(request.agent)}`, 'invalid')
    const { agent, model, effort } = await this.resolveModel(request.model, request.effort)
    if (agent !== request.agent) throw new ChatError(400, `${request.model} is a ${agent} model, not ${request.agent}`, 'invalid')
    const local = !request.repo
    const id = randomUUID()
    if (!local && !/^[^/\s]+\/[^/\s]+$/.test(request.repo!)) throw new ChatError(400, 'repo must be owner/name', 'invalid')
    const branch = normalizeBranchRequest(request.branch ?? { new: `chat/${id}` }, this.branchPrefix())
    if (agent === 'claude' && !request.deferStart) await this.requireClaudeReady()
    // A bound checkout wins: a handoff stays in its source's workspace
    // instead of provisioning a fresh one. Otherwise every new Poise-local
    // session gets its own scratch workspace, as managed workers already do;
    // only a local session binding a pre-existing branch without one (a
    // legacy path the browser cannot create) keeps the shared workspace.
    const root = this.options.localWorkspaceRoot ?? LOCAL_CHAT_ROOT
    const checkout = request.checkout
      ? canonicalCheckout(request.checkout)
      : local
        ? isolated || branch.origin === 'new'
          ? await ensureWorkerWorkspace(root, id, this.instance)
          : await ensureLocalWorkspace(root, this.instance)
        : canonicalCheckout(await this.resolveCheckout(request.repo!))
    const now = new Date().toISOString()
    const title = request.role === 'manager' ? 'Manager' : (request.title || request.context?.title || 'New session').slice(0, CHAT_LIMITS.titleChars)
    const record: SessionRecord = {
      id,
      agent,
      model: model.identity,
      modelId: model.selector,
      effort,
      repo: request.repo || '',
      checkout,
      ...(local ? { workspaceKind: 'poise-local' as const } : {}),
      branch: { name: branch.name, origin: branch.origin, pr: branch.pr, provisional: branch.origin === 'new' },
      title,
      createdAt: now,
      updatedAt: now,
      status: request.deferStart ? 'idle' : 'starting',
      capabilities: emptyCapabilities(),
      lastSeq: 0,
      pendingRequests: [],
      instance: this.instance,
      context: request.context,
      ...(request.subject ? { subject: request.subject } : {}),
      ...(request.autoMerge !== undefined ? { autoMerge: request.autoMerge } : {}),
      safeMode: request.safeMode === true,
      ...(request.role ? { role: request.role } : {}),
      ...(createdBy ? { createdBy } : {}),
    }
    // Callers can guard admission after asynchronous model/auth preparation;
    // no await may separate that guard from the durable insert.
    beforeInsert?.()
    try {
      storage.insertSession(record)
    } catch (error) {
      if (request.role === 'manager' && (error as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        await discardUnclaimedWorkspace(root, checkout, this.instance, this.leaseProbes).catch(() => 'kept' as const)
        const winner = storage.managerSession(this.instance)
        throw new ChatError(409, 'A Manager already exists.', 'manager_exists', winner ? { manager: { id: winner.id } } : undefined)
      }
      if (request.subject && String((error as { code?: string })?.code ?? '').startsWith('SQLITE_CONSTRAINT')
        && storage.sessionForSubject(this.instance, request.subject.surface, request.subject.key)) {
        // Lost the cross-process race: the workspace never ran, so discard
        // it and let the caller return the winner. Nothing was emitted.
        await discardUnclaimedWorkspace(root, checkout, this.instance, this.leaseProbes).catch(() => 'kept' as const)
        throw new SubjectTakenError(request.subject)
      }
      throw error
    }
    const live = this.requireLive(record.id)
    this.emit_(record.id, { type: 'session.created', session: record })
    if (!request.deferStart) void this.serialized(live, () => this.startSession(live, { fresh: true })).catch(() => undefined)
    return live.record
  }

  /** Update between turns; never replace a process while it is answering. */
  private async checkSessionCli(session: LiveSession, signal: AbortSignal) {
    const agent = session.record.agent
    if (this.options.adapters?.[agent] && !this.options.prepareCli) return undefined
    const turnId = session.turn?.id
    if (turnId && session.cliCheck?.agent === agent && session.cliCheck.turnId === turnId) return session.cliCheck.result
    session.record.cliChecking = true
    this.saveRecord(session); this.emit_(session.record.id, { type: 'session.updated', session: session.record })
    this.setStatus(session, 'starting', `Checking the latest ${agent} CLI…`)
    try {
      const result = await (this.options.prepareCli ?? prepareProviderCli)(agent, signal)
      signal.throwIfAborted()
      if (agent === 'codex' && result.status === 'unavailable' && !result.launchPath) {
        throw new Error(`Codex CLI has no verified launcher: ${result.error || 'version check failed'}`)
      }
      session.cliCheck = { agent, turnId, result }
      session.record.cliVersion = result.launchVersion || result.after || result.before
      session.record.cliWarning = result.status === 'unavailable'
        ? `Latest ${agent} CLI could not be verified: ${result.error}. Trying the installed CLI${result.before ? ` (${result.before})` : ''}.` : undefined
      if (session.record.cliWarning) this.setStatus(session, 'starting', session.record.cliWarning)
      return result
    } finally {
      session.record.cliChecking = false
      if (this.ownsSession(session.record.id)) {
        this.saveRecord(session); this.emit_(session.record.id, { type: 'session.updated', session: session.record })
      }
    }
  }

  /** Bring the native process up under the checkout lease: prepare the
   *  branch (fresh sessions), switch the checkout to it, register the gate,
   *  then create/resume/fork the native session. Failures become a readable
   *  error event and the `error` status; nothing is retried on its own. */
  private async startSession(session: LiveSession, options: { fresh?: boolean, forkFrom?: SessionRecord, lease?: CheckoutLease } = {}): Promise<void> {
    if (session.adapter?.alive) return
    if (!options.lease && session.lease?.held) {
      await this.stopProcess(session)
      this.releaseSettledLease(session)
    }
    const record = session.record
    const startup = new AbortController()
    session.startup = startup
    const signal = AbortSignal.any([session.lifecycle.signal, startup.signal, ...(session.turn ? [session.turn.abort.signal] : [])])
    this.setStatus(session, 'starting')
    let lease = options.lease
    let freed = true
    let initializingWorkspace = false
    try {
      const cli = await this.checkSessionCli(session, signal)
      lease ??= await this.leaseForStartup(session, signal)
      if (!options.lease) await lease.acquire({ signal, onBusy: (busy) => this.reportBusy(session, busy) })
      else if (!lease.held) throw new Error('the checkout lease was lost before native startup')
      signal.throwIfAborted()
      session.lease = lease
      session.relayDetached = false
      initializingWorkspace = true
      const recreated = await this.recreateRemovedWorkspace(session, lease)
      initializingWorkspace = false
      signal.throwIfAborted()
      const fresh = recreated || options.fresh || (!record.nativeSessionId && record.branch.provisional && !record.branch.baseSha)
      if (fresh) await this.prepareBranch(session, lease)
      await this.prepareCheckout(session, lease)
      if ((fresh || options.forkFrom) && record.context?.kind === 'document' && record.context.slug) {
        session.staged = options.forkFrom
          ? await forkStagedDocument(record.checkout, record.id, record.context.slug, { sessionId: options.forkFrom.id, staged: options.forkFrom.staged })
          : await stageDocument(record.checkout, record.id, record.context.slug)
        record.staged = session.staged
        this.saveRecord(session)
      }
      signal.throwIfAborted()
      // An observer reading untrusted transcripts gets no MCP servers.
      const extensions = this.options.extensions && !isSwitchboardChat(record) ? await this.options.extensions.resolve(record) : null
      signal.throwIfAborted()
      // Each registration reports its own adapter instance: closing over the
      // reassigned `adapter` below would attribute a late exit of the stopped
      // process to the fresh adapter and tear down the restarted session.
      const attach = (next: Adapter) => {
        session.adapter = next
        next.onExit((code, signal) => this.onAdapterExit(session, next, code, signal))
      }
      let adapter = this.adapters[record.agent](this.hostFor(session))
      attach(adapter)
      let startOptions = {
        modelId: record.modelId,
        effort: record.effort,
        safeMode: record.safeMode === true,
        ...(record.mode ? { mode: record.mode } : {}),
        ...(options.forkFrom
          ? (record.agent === 'claude' ? { forkFrom: options.forkFrom.nativeSessionId } : { resume: record.nativeSessionId })
          : record.nativeSessionId ? { resume: record.nativeSessionId } : {}),
        ...(extensions?.servers.length ? { mcpServers: extensions.servers } : {}),
        ...(record.role === 'worker' ? { worker: true } : {}),
      }
      // Snapshot the stranded worker before starting the new agent: the
      // start replaces the worker row, and the orphan cleanup at the end of
      // the start must judge the OLD worker's group, not the new one's.
      const staleWorker = record.orphanNotice ? storage.getWorker(record.id) : null
      let started
      try {
        started = await adapter.start(startOptions)
      } catch (error) {
        if (record.agent !== 'muse' || !('resume' in startOptions) || !isStaleMuseCaller(error) || signal.aborted) throw error
        try { await this.stopProcess(session) } catch { throw error }
        signal.throwIfAborted()
        this.clearStaleMuseSession(session)
        adapter = this.adapters[record.agent](this.hostFor(session))
        attach(adapter)
        startOptions = {
          modelId: record.modelId,
          effort: record.effort,
          safeMode: record.safeMode === true,
          ...(record.mode ? { mode: record.mode } : {}),
          ...(extensions?.servers.length ? { mcpServers: extensions.servers } : {}),
          ...(record.role === 'worker' ? { worker: true } : {}),
        }
        started = await adapter.start(startOptions)
      }
      signal.throwIfAborted()
      session.nativeCliVersion = cli?.launchVersion || cli?.after || cli?.before
      session.nativeSafeMode = startOptions.safeMode
      record.safeModePending = session.nativeSafeMode !== (record.safeMode === true)
      if (extensions) this.reportExtensions(session, extensions, started.mcpSkipped ?? [], started.mcpPending === true)
      record.nativeSessionId = started.nativeSessionId
      record.capabilities = started.capabilities
      record.modelId = started.modelId || record.modelId
      record.effort = started.effort || record.effort
      record.efforts = started.efforts
      record.mode = started.mode
      record.modes = started.modes
      record.commands = started.commands
      record.interruptedTurnId = undefined
      await this.refreshWorkspace(session)
      // A start that reached idle with a stale orphan notice proves the old
      // worker settled (a live one would have blocked the lease or the
      // startup above): drop its rows and the notice, so a session
      // stranded by a restart heals on resume without anyone killing
      // processes by hand. An open turn that turn left behind is
      // interrupted — its agent ran unseen, so its outcome is unknown —
      // and what waited behind it dispatches. This start's own turn and
      // worker are never touched: the liveness check judges the snapshot
      // from before the start, and the row is only forgotten when it still
      // names that old worker.
      if (record.orphanNotice) {
        if (!staleWorker || (!pgidAlive(staleWorker.gatePgid) && !pidAlive(staleWorker.gatePid))) {
          if (staleWorker && storage.getWorker(record.id)?.ident === staleWorker.ident) storage.forgetWorker(record.id)
          const staleRelay = storage.getRelay(record.id)
          if (staleRelay && !pidAlive(staleRelay.relayPid)) {
            storage.forgetRelay(record.id)
            await rm(staleRelay.dir, { recursive: true, force: true }).catch(() => undefined)
          }
          const open = storage.getOpenTurn(record.id)
          record.orphanNotice = undefined
          this.saveRecord(session)
          if (open && open.turnId !== session.turn?.id) {
            this.interruptOpenTurn({ sessionId: record.id, turnId: open.turnId, callId: open.callId },
              { stopReason: 'interrupted', error: 'Poise restarted while this turn was running; its agent was gone before the turn could be adopted, so its outcome is unknown' })
            const refreshed = storage.getSession(record.id)
            if (refreshed) {
              session.record = refreshed
              // Interrupted and resumed in the one start: the transcript
              // keeps the interruption, the session reads resumed.
              session.record.interruptedTurnId = undefined
              this.saveRecord(session)
            }
          } else {
            this.armQueueIfWaiting(record.id)
          }
          this.scheduleQueue(session)
        }
      }
      this.setStatus(session, 'idle')
      this.emit_(record.id, { type: 'session.resumed', session: record })
      this.armIdleTimer(session)
      // A start that was already under way when the drain began ends idle.
      if (this.drainState && !session.turn) await this.closeForDrain(session).catch(() => undefined) // an orphan stays counted
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!signal.aborted) {
        try { this.emit_(record.id, { type: 'error', message, recoverable: true }) } catch { /* mirror */ }
        this.setStatus(session, 'error', message)
      } else if (!session.turn) this.setStatus(session, 'idle')
      if (initializingWorkspace && lease?.held) {
        session.bootstrapUnsettled = true
        if (this.bootstrapStillRunning(session, lease)) freed = false
      }
      try { await this.stopProcess(session) } catch { freed = false }
      throw error
    } finally {
      // The idle agent holds no lease; the next turn takes one. Release only
      // when nothing of this start can still write (a stopped orphan keeps it).
      // A turn-owned lease remains registered and held through its own cleanup.
      if (!options.lease && lease?.held) {
        if (freed) { lease.clearWorker(); lease.release() }
        else this.emit('log', `[chat ${record.id.slice(0, 8)}] checkout lease kept: worker not settled`)
      }
      if (lease && session.lease === lease && !lease.held) session.lease = null
      if (session.startup === startup) session.startup = null
    }
  }

  async resume(id: string): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    await this.serialized(session, async () => {
      if (session.record.status === 'closed' || session.lifecycle.signal.aborted) {
        session.lifecycle = new AbortController()
        session.record.status = 'idle'
        // Persisted before the workspace is touched: from here the session
        // is open, and storage maintenance holds its workspace.
        this.saveRecord(session)
      }
      if (!session.adapter?.alive) await this.startSession(session)
    })
    return session.record
  }

  /** Explicit reset settles active work first; no model is asked to forget. */
  async reset(id: string): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    if (session.record.contextResetting) throw new ChatError(409, 'The chat is already resetting.', 'turn_in_progress')
    session.record.contextResetting = true
    try { this.saveRecord(session) } catch (error) { session.record.contextResetting = false; throw error }
    try {
      this.emit_(id, { type: 'session.updated', session: session.record })
      await this.track(async () => {
        pauseQueue(queueOwner(id))
        const timer = this.queueTimers.get(id)
        if (timer) { clearTimeout(timer); this.queueTimers.delete(id) }
        this.queueReleaseWait.delete(id)
        session.startup?.abort()
        await this.forceStop(session, 'chat reset')
        if (session.turn) throw new ChatError(409, 'The agent is still stopping; history has not been reset.', 'agent_error')
        await this.serialized(session, async () => {
          await session.steering
          await this.stopProcess(session)
          this.releaseSettledLease(session)
          if (session.lifecycle.signal.aborted) throw new ChatError(409, 'The session is closing; history has not been reset.', 'no_turn')
          const lease = this.leaseFor(session)
          try {
            await lease.acquire({ signal: session.lifecycle.signal, onBusy: busy => this.reportBusy(session, busy) })
            session.lease = lease
            this.clearContext(session)
          } finally {
            if (lease.held) lease.release()
            if (session.lease === lease && !lease.held) session.lease = null
          }
        })
      })
      return this.withLive(session.record)
    } finally {
      session.record.contextResetting = false
      this.saveRecord(session)
      this.emit_(id, { type: 'session.updated', session: session.record })
      this.publishQueue(session)
    }
  }

  /** Called only with the native worker stopped and the checkout held. */
  private clearContext(session: LiveSession): void {
    if (session.relay?.healthy || session.adapter?.alive || session.services || !session.lease?.held) {
      throw new ChatError(409, 'The previous agent has not settled; history has not been reset.', 'checkout_busy')
    }
    const committed = storage.resetConversation(session.record)
    Object.assign(session.record, committed.session)
    session.grants.clear()
    session.staged = null
    session.nativeSafeMode = undefined
    // Old provider logs and project files are never deleted by this gesture.
    // Only the Poise transcript and automatic context links are reset.
    this.emit('event', { ...committed.envelope, event: { type: 'session.reset', session: this.withLive(session.record) } })
  }

  async rename(id: string, title: string): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    const next = String(title || '').trim().slice(0, CHAT_LIMITS.titleChars)
    if (!next) throw new ChatError(400, 'title is required', 'invalid')
    session.record.title = next
    session.record.titleManual = true
    this.saveRecord(session)
    this.emit_(id, { type: 'session.updated', session: session.record })
    return session.record
  }

  /** Allowed while draining: closing settles work rather than starting it. */
  close(id: string): Promise<SessionRecord> {
    return this.track(async () => {
      const session = this.requireLive(id)
      if (session.relayDetached) throw new ChatError(409, 'the session belongs to another server', 'checkout_busy')
      pauseQueue(queueOwner(id))
      this.publishQueue(session)
      session.lifecycle.abort()
      await this.forceStop(session, 'session closed')
      await this.serialized(session, async () => {
        await this.shutdownSession(session)
        if (session.turn) throw new ChatError(409, 'the agent could not be stopped; the session stays open', 'agent_error')
        this.setStatus(session, 'closed')
        this.emit_(id, { type: 'session.closed', reason: 'closed by user' })
      })
      // The close committed: a closed chat never receives monitor notices,
      // so its bindings become claimable by the replacement chat.
      releaseBindings(this.instance, id)
      return session.record
    })
  }

  async delete(id: string): Promise<{ workspaceRemoved: boolean }> {
    this.assertAcceptingWork()
    return this.track(() => this.deleteSession(id))
  }

  private async deleteSession(id: string): Promise<{ workspaceRemoved: boolean }> {
    const session = this.requireLive(id)
    if (session.relayDetached) throw new ChatError(409, 'the session belongs to another server', 'checkout_busy')
    session.lifecycle.abort()
    await this.forceStop(session, 'session deleted')
    return this.serialized(session, async () => {
      await this.shutdownSession(session)
      if (session.turn || session.relay?.healthy) throw new ChatError(409, 'the agent could not be stopped; the session was not deleted', 'agent_error')
      const record = session.record
      if (session.staged) { await unstageDocument(record.checkout, record.id); session.staged = null; record.staged = undefined }
      await this.preserveBorrowedQueueContext(id)
      await this.removeAttachments(session)
      const workspaceRemoved = await this.removeOwnedWorkspace(session)
      this.emit_(id, { type: 'session.closed', reason: 'deleted' })
      storage.deleteSession(id)
      this.live.delete(id)
      this.emit('deleted', id)
      return { workspaceRemoved }
    })
  }

  /** Branch and workspace cleanup for a session being deleted. A branch Poise
   *  created whose tip never moved goes with the session — unless another
   *  Poise-local session still binds it. A session-owned scratch workspace
   *  goes only when no other session still uses it, its branch never moved,
   *  and its tree is clean. Everything runs under the workspace's lease;
   *  anything uncertain is kept, and lock files are never deleted. */
  private async removeOwnedWorkspace(session: LiveSession): Promise<boolean> {
    const record = session.record
    const ref = record.workspaceKind === 'poise-local'
      ? workerWorkspaceRef(this.options.localWorkspaceRoot ?? LOCAL_CHAT_ROOT, record.checkout)
      : null
    const branchRule = record.branch.origin === 'new' && record.branch.provisional && !!record.branch.baseSha
    if (!branchRule && !ref) return false
    const lease = this.leaseFor(session)
    try {
      await lease.acquire({ onBusy: (busy) => this.reportBusy(session, busy) })
      // Decided under the lease, before anything is removed.
      const exists = await branchExists(record.checkout, record.branch.name)
      const unmoved = !!record.branch.baseSha && exists && (await branchTip(record.checkout, record.branch.name)) === record.branch.baseSha
      const siblings = storage.listSessions(this.instance).filter((s) => s.id !== record.id && s.checkout === record.checkout)
      if (branchRule && unmoved && !(record.workspaceKind === 'poise-local' && siblings.some((s) => s.branch.name === record.branch.name))) {
        await deleteBranch(lease, record.checkout, record.branch.name)
      }
      if (ref && siblings.length === 0 && unmoved && !(await inspectCheckout(record.checkout)).dirty && await workspaceMarkerValid(record.checkout)) {
        try {
          await rm(record.checkout, { recursive: true, force: true })
        } catch (error) {
          this.emit_(record.id, { type: 'error', message: `workspace ${record.checkout} was kept: ${error instanceof Error ? error.message : String(error)}`, recoverable: true })
          return false
        }
        // The emptied parent is tidied best-effort; anything unexpected left
        // in it keeps it.
        await rmdir(ref.home).catch(() => undefined)
        return true
      }
      return false
    } catch (error) {
      this.emit_(record.id, { type: 'error', message: `branch ${record.branch.name} was kept: ${error instanceof Error ? error.message : String(error)}`, recoverable: true })
      return false
    } finally {
      if (lease.held) lease.release()
    }
  }

  async fork(id: string): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const source = this.requireLive(id)
    if (source.record.selfChangeId) throw new ChatError(409, 'a Poise change session cannot be forked; its checkout belongs to the release controller', 'unsupported')
    if (source.record.role === 'manager') throw new ChatError(409, 'The Manager cannot be forked; start a new chat instead.', 'unsupported')
    return this.serialized(source, async () => {
      if (!source.record.capabilities.fork) throw new ChatError(409, `${AGENT_LABEL[source.record.agent]} sessions cannot be forked`, 'unsupported')
      if (source.turn) throw new ChatError(409, 'a turn is running; fork after it finishes', 'turn_in_progress')
      // The fork inherits the source's model; it must still name a live catalog identity.
      await this.resolveModel(source.record.model)
      if (!source.adapter?.alive) await this.startSession(source)
      const now = new Date().toISOString()
      const nativeId = source.record.agent === 'claude' ? source.record.nativeSessionId : await source.adapter!.fork()
      const record: SessionRecord = {
        ...structuredClone(source.record),
        id: randomUUID(),
        title: `${source.record.title} (fork)`.slice(0, CHAT_LIMITS.titleChars),
        createdAt: now,
        updatedAt: now,
        status: 'starting',
        nativeSessionId: nativeId,
        lastSeq: 0,
        pendingRequests: [],
        forkedFrom: source.record.id,
        interruptedTurnId: undefined,
        orphanNotice: undefined,
        workspace: undefined,
        queue: undefined,
        timers: undefined,
        queuedHandoff: undefined,
        subject: undefined, // a fork is a new conversation, not the card's session
        importedFrom: undefined,
        staged: undefined, // the fork stages its own copy on start
        createdBy: undefined, // the person made the fork, not the worker's creator
        branch: { ...source.record.branch, provisional: false },
      }
      storage.insertSession(record)
      const live = this.requireLive(record.id)
      this.emit_(record.id, { type: 'session.created', session: record })
      // The visible transcript starts here; the native context was inherited
      // by the agent, which the header states through `forkedFrom`.
      this.emit_(record.id, { type: 'status.changed', status: 'starting', detail: `forked from "${source.record.title}"; the agent keeps that conversation's context` })
      void this.serialized(live, () => this.startSession(live, { forkFrom: source.record })).catch(() => undefined)
      return live.record
    })
  }

  /** Explicit cross-agent handoff: a new session for another agent whose
   *  first turn is a labelled summary — never a pretence that the native
   *  session moved. The new session binds to the same branch as it is. */
  async handoff(id: string, target: { agent: AgentId, model: string, effort?: string }): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const source = this.requireLive(id)
    if (source.turn) throw new ChatError(409, 'a turn is running; hand off after it finishes', 'turn_in_progress')
    if (source.record.selfChangeId) throw new ChatError(409, 'a Poise change session cannot be handed off; its checkout belongs to the release controller', 'unsupported')
    if (source.record.role === 'manager') throw new ChatError(409, 'The Manager cannot be handed off; change its model instead.', 'unsupported')
    // Creation can return before branch setup; settle that source lifecycle
    // before admitting a target on the same branch.
    return this.serialized(source, async () => {
      const assertSourceAvailable = () => {
        this.assertAcceptingWork()
        if (source.record.status === 'closed' || source.lifecycle.signal.aborted) throw new ChatError(409, 'the source chat is closing or closed; handoff was not started', 'agent_error')
        if (source.turn) throw new ChatError(409, 'a turn is running; hand off after it finishes', 'turn_in_progress')
      }
      assertSourceAvailable()
      let branchReady = await branchExists(source.record.checkout, source.record.branch.name)
      // Deferred chats have never run a provider. Prepare only their branch,
      // using the existing lease and branch path, before starting the target.
      if (!branchReady && source.record.status === 'idle' && source.record.branch.origin === 'new'
        && source.record.branch.provisional && !source.record.branch.baseSha && !source.record.nativeSessionId) {
        const lease = await this.leaseForStartup(source, source.lifecycle.signal)
        try {
          await lease.acquire({ signal: source.lifecycle.signal, onBusy: busy => this.reportBusy(source, busy) })
          assertSourceAvailable()
          branchReady = await branchExists(source.record.checkout, source.record.branch.name)
          if (!branchReady) { await this.prepareBranch(source, lease); branchReady = true }
        } catch (error) { assertSourceAvailable(); throw error }
        finally { if (lease.held) lease.release() }
        assertSourceAvailable()
        this.setStatus(source, 'idle')
      }
      if (!branchReady) {
        throw new ChatError(409, `source branch ${source.record.branch.name} does not exist; finish or repair source startup before handing off`, 'agent_error')
      }
      assertSourceAvailable()
      const summary = this.handoffSummary(source.record)
      const created = await this.track(() => this.createSession({
        agent: target.agent,
        model: target.model,
        effort: target.effort,
        repo: source.record.repo,
        checkout: source.record.checkout,
        branch: { existing: source.record.branch.name },
        title: `${source.record.title} → ${AGENT_LABEL[target.agent]}`.slice(0, CHAT_LIMITS.titleChars),
        autoMerge: source.record.autoMerge,
        safeMode: source.record.safeMode === true,
        context: { kind: 'handoff', title: source.record.title, body: summary, fromSession: source.record.id },
      }, false, undefined, assertSourceAvailable))
      const live = this.requireLive(created.id)
      // The conversation continues in the target: its work bindings move with
      // it, so the next monitor tick wakes the target, never the source.
      moveBindings(this.instance, source.record.id, live.record.id)
      if (source.record.subject) {
        // The subject moves once the target exists and before its summary
        // turn is scheduled. Until now it still opened the source.
        const subject = source.record.subject
        storage.moveSubject(source.record, live.record)
        delete source.record.subject
        live.record.subject = subject
        this.emit_(source.record.id, { type: 'session.updated', session: source.record })
        this.emit_(live.record.id, { type: 'session.updated', session: live.record })
      }
      // The family's branch reference point travels with a local handoff, so
      // the last session deleted from a shared workspace can still tell
      // whether its branch never moved.
      if (source.record.workspaceKind === 'poise-local' && source.record.branch.baseSha) {
        live.record.branch.baseSha = source.record.branch.baseSha
        this.saveRecord(live)
      }
      void this.serialized(live, async () => {
        if (live.record.status === 'error' || live.lifecycle.signal.aborted) return
        const turn = this.reserveTurn(live)
        await this.runTurn(live, turn, { text: summary, attachments: [], mentions: [] })
      }).catch(() => undefined)
      return created
    })
  }

  private collectRecentTurns(record: SessionRecord): Array<{ prompt: string, text: string, files: Set<string> }> {
    const turns: Array<{ prompt: string, text: string, files: Set<string> }> = []
    let cursor = 0
    while (true) {
      const page = storage.listEvents(record.id, cursor)
      for (const { event } of page.events) {
        if (event.type === 'turn.started') {
          turns.push({ prompt: clip(event.prompt.text, 600), text: '', files: new Set() })
          if (turns.length > 6) turns.shift()
        } else if (event.type === 'text.delta' && turns.length) {
          const turn = turns[turns.length - 1]
          // Keep a bounded tail so the outcome survives a long streamed turn.
          turn.text = (turn.text + event.delta).slice(-1800)
        } else if (event.type === 'diff' && turns.length) {
          const paths = turns[turns.length - 1].files
          if (paths.size < 40) paths.add(event.path)
        }
      }
      if (!page.truncated || !page.events.length) break
      cursor = page.events[page.events.length - 1].seq
    }
    return turns
  }

  private handoffSummary(record: SessionRecord): string {
    const recent = this.collectRecentTurns(record)
    const files = new Set(recent.flatMap(turn => [...turn.files]))
    const lines = [
      `[Handoff from a ${AGENT_LABEL[record.agent]} session "${record.title}" in ${record.repo} on branch ${record.branch.name}]`,
      'This conversation continues here with a different agent. Nothing from the previous native session carried over except this summary.',
      '',
      'Recent turns:',
      ...recent.map((t, i) => `${i + 1}. User: ${clip(t.prompt, 600)}\n   Agent: ${clip(t.text.trim(), 900)}`),
    ]
    if (files.size) lines.push('', `Files the previous agent changed: ${[...files].slice(0, 40).join(', ')}`)
    lines.push('', 'Continue from here.')
    return lines.join('\n')
  }

  private restartSummary(record: SessionRecord): string {
    const recent = this.collectRecentTurns(record)
    const files = new Set(recent.flatMap(turn => [...turn.files]))
    const lines = [
      `[Restarted ${AGENT_LABEL[record.agent]} session "${record.title}" in ${record.repo} on branch ${record.branch.name}]`,
      'The previous native session could not be used because Muse\'s credentials changed. Nothing from it carried over except this summary.',
      '',
      'Recent turns:',
      ...recent.map((t, i) => `${i + 1}. User: ${clip(t.prompt, 600)}\n   Agent: ${clip(t.text.trim(), 900)}`),
    ]
    if (files.size) lines.push('', `Files the previous session changed: ${[...files].slice(0, 40).join(', ')}`)
    lines.push('', 'Continue from here.')
    return lines.join('\n')
  }

  /** Abandon a Muse native session whose reasoning was encrypted for a
   *  previous credential holder: seed the restart summary, forget the native
   *  id, and note the restart once in the transcript. Clearing the id cannot
   *  retrigger branch creation: the branch was prepared by the earlier start
   *  that produced the abandoned id. Returns the seeded summary, if any. */
  private clearStaleMuseSession(session: LiveSession): string | undefined {
    const record = session.record
    const staleId = record.nativeSessionId
    let summary: string | undefined
    if (!record.queuedHandoff && storage.findEvent(record.id, (event) => event.type === 'text.delta')) {
      summary = this.restartSummary(record)
      record.queuedHandoff = summary
    }
    record.nativeSessionId = undefined
    this.saveRecord(session)
    this.emit_(record.id, { type: 'error', message: MUSE_RESTART_NOTE, recoverable: true })
    this.emit('log', `[chat ${record.id.slice(0, 8)}] Muse native session ${staleId} abandoned (reasoning issued to another caller); restarting fresh`)
    return summary
  }

  /** Recover a Muse turn that failed only because its native session is
   *  unusable under the current credentials, inside this same turn: stop the
   *  poisoned process, start fresh in the same checkout under the turn's
   *  lease, and — when the failed attempt ran nothing — run the prompt there
   *  once with the restart summary. Runs at most once per turn; a second
   *  consecutive failure surfaces as an ordinary error. */
  private async recoverStaleMuseTurn(session: LiveSession, turn: RunningTurn, lease: CheckoutLease, promptInput: PromptInput): Promise<TurnResult> {
    await this.stopProcess(session)
    turn.abort.signal.throwIfAborted()
    const summary = this.clearStaleMuseSession(session)
    await this.startSession(session, { lease })
    turn.abort.signal.throwIfAborted()
    // The failed attempt already ran tools, asked permissions or asked
    // questions: re-running the prompt could repeat side effects, so the
    // fresh session and its summary stand ready for the next prompt instead.
    if (storage.findEvent(session.record.id, (event) => (event.type === 'tool.started' || event.type === 'permission.requested' || event.type === 'question.asked') && event.turnId === turn.id)) {
      return { stopReason: 'error', error: 'The prompt was not re-run because the failed attempt had already run tools; the Muse session was restarted and the next prompt continues from a summary.' }
    }
    const retry = summary ? { ...promptInput, text: `${summary}\n\n[Current task]\n${promptInput.text}` } : promptInput
    return session.adapter!.prompt(turn.id, retry, turn.abort.signal)
  }

  // ── Poise self-improvement ─────────────────────────────────────────────

  /** `/poise <request>` typed in `sourceId`: ask the controller to prepare an
   *  isolated checkout for the change, open a dedicated session in it with
   *  the source session's model, bind that session to the change, and
   *  reserve its one implementing turn (runbook + the exact request) before
   *  answering — so no browser prompt can slip in first and a resend of the
   *  same `changeId` finds the session instead of making a second one. */
  async startPoiseChange(sourceId: string, text: string, changeId: string, context: Pick<PromptInput, 'attachments' | 'mentions'> & { switches?: string[] } = { attachments: [], mentions: [] }): Promise<PoiseChangeResult> {
    this.assertAcceptingWork()
    const request = String(text || '').trim()
    const names = context.switches
    refuseManagerSwitch(names, this.get(sourceId)?.role === 'manager')
    refuseWorkerSwitch(names, this.get(sourceId)?.role === 'worker')
    if (names !== undefined) {
      const known = savedSwitchNames()
      if (!Array.isArray(names) || names.length > 128 || !names.every(name => typeof name === 'string' && known.has(name))) throw new ChatError(400, 'The selected saved switches are unavailable.', 'invalid')
    }
    expandSwitches(request, names)
    const input = this.validatePrompt(sourceId, { text: request, ...context })
    const contextKey = input.attachments.length || input.mentions.length || names?.length
      ? sha256Of(Buffer.from(canonicalJson({ attachments: input.attachments, mentions: input.mentions, ...(names?.length ? { switches: names } : {}) }))) : ''
    // Two arrivals of one change id (a resend under a new request id while
    // the first is still preparing) share the one start — but only for the
    // same request from the same session; a second prepare and bind would
    // make the controller refuse the real session, and a different request
    // under a reused id is a conflict, not a replay.
    const key = String(changeId).toLowerCase()
    const running = this.changeStarts.get(key)
    if (running) {
      if (running.sourceId !== sourceId || running.request !== request || running.contextKey !== contextKey) throw changeIdConflict()
      return running.promise
    }
    const promise = this.track(() => this.startChange(sourceId, request, changeId, input, contextKey, names)).finally(() => this.changeStarts.delete(key))
    this.changeStarts.set(key, { sourceId, request, contextKey, promise })
    return promise
  }

  private async startChange(sourceId: string, request: string, changeId: string, input: PromptInput, contextKey: string, names?: string[]): Promise<PoiseChangeResult> {
    if (this.stopped) throw new ChatError(503, 'the chat runtime is stopping', 'agent_error')
    const bridge = this.selfUpdate
    if (!bridge?.configured) {
      throw new ChatError(503, 'Poise self-improvement is not set up on this server: install and enable the self-update controller before using /poise', 'self_update_unavailable')
    }
    if (!UUID_PATTERN.test(changeId)) throw new ChatError(400, 'changeId must be a UUID', 'invalid')
    if (!request) throw new ChatError(400, 'say what to change: /poise <request>', 'invalid')
    if (Buffer.byteLength(request, 'utf8') > CHAT_LIMITS.promptBytes) throw new ChatError(413, `request exceeds ${CHAT_LIMITS.promptBytes} bytes`, 'invalid')
    const source = this.get(sourceId)
    if (!source) throw new ChatError(404, 'unknown session', 'unknown_session')
    // The change session inherits the source's model; it must still name a
    // live catalog identity before the controller prepares a workspace for it.
    await this.resolveModel(source.model)
    const id = changeId.toLowerCase()

    // The same change id from the same session with the same request is
    // the same change: answer with the session it already has rather than
    // preparing a second checkout. Anything else under that id is refused.
    const existing = storage.listSessions(this.instance).find((record) => record.selfChangeId === id)
    if (existing) {
      if (existing.context?.kind !== 'poise-change' || existing.context.fromSession !== source.id || existing.context.body !== request || (existing.selfChangeContextKey || '') !== contextKey) throw changeIdConflict()
      const status = await this.bridgeCall(() => bridge.status())
      const change = status.changes.find((c) => String(c.id).toLowerCase() === id)
      if (!change || change.instance !== this.instance) throw new ChatError(409, 'this change is no longer known to the release controller', 'self_update_unavailable')
      return { session: this.withLive(existing), change }
    }

    if (source.agent === 'claude') await this.requireClaudeReady()
    const title = poiseChangeTitle(request)
    const prepared = await this.bridgeCall(() => bridge.prepareChange({ id, sessionId: source.id, instance: this.instance, request, title }))
    const change = prepared.change
    if (String(change?.id).toLowerCase() !== id || change.repository !== SELF_UPDATE_REPOSITORY || change.instance !== this.instance) {
      await this.abandonChange(bridge, id, 'the controller answered for a different change')
      throw new ChatError(502, 'the release controller answered for a different change or repository; nothing was started', 'agent_error')
    }
    if (typeof prepared.workspace !== 'string' || !prepared.workspace.startsWith('/') || typeof prepared.branch !== 'string' || !prepared.branch) {
      await this.abandonChange(bridge, id, 'the controller returned no usable workspace')
      throw new ChatError(502, 'the release controller returned no usable workspace; nothing was started', 'agent_error')
    }
    let checkout: string
    try {
      checkout = canonicalCheckout(prepared.workspace)
      const state = await inspectCheckout(checkout)
      if (state.currentBranch !== prepared.branch) throw new Error(`the prepared checkout is on ${state.currentBranch || 'a detached HEAD'}, not ${prepared.branch}`)
      if (state.dirty) throw new Error(`the prepared checkout has ${state.dirtyFiles} uncommitted change(s)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.abandonChange(bridge, id, message)
      throw new ChatError(502, `the prepared workspace is not usable: ${message}`, 'agent_error')
    }

    const now = new Date().toISOString()
    const record: SessionRecord = {
      id: randomUUID(),
      agent: source.agent,
      model: source.model,
      modelId: source.modelId,
      effort: source.effort,
      repo: SELF_UPDATE_REPOSITORY,
      checkout,
      workspaceKind: 'poise-change',
      selfChangeId: id,
      ...(contextKey ? { selfChangeContextKey: contextKey } : {}),
      autoMerge: source.autoMerge,
      safeMode: source.safeMode === true,
      branch: { name: prepared.branch, origin: 'existing', provisional: false, baseSha: prepared.baseSha },
      title: `Poise: ${title}`.slice(0, CHAT_LIMITS.titleChars),
      createdAt: now,
      updatedAt: now,
      status: 'starting',
      capabilities: emptyCapabilities(),
      lastSeq: 0,
      pendingRequests: [],
      instance: this.instance,
      context: { kind: 'poise-change', title, body: request, fromSession: source.id },
    }
    storage.insertSession(record)
    const live = this.requireLive(record.id)
    this.emit_(record.id, { type: 'session.created', session: record })
    let bound: SelfChange
    try {
      bound = await this.bridgeCall(() => bridge.bindSession(id, { sessionId: record.id, instance: this.instance }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try { this.emit_(record.id, { type: 'error', message: `the release controller did not accept this session: ${message}`, recoverable: false }) } catch { /* mirror */ }
      this.setStatus(live, 'error', message)
      await this.abandonChange(bridge, id, `the runtime session could not be bound: ${message}`, record.id)
      throw error
    }
    let transferred: PromptInput
    try {
      transferred = await this.copyPromptContext(source.id, record.id, input)
      await this.copyQueuedContext(source.id, record.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setStatus(live, 'error', message)
      await this.abandonChange(bridge, id, `Could not transfer the request context: ${message}`, record.id)
      throw error
    }
    delegateQueue(source.id, record.id)
    this.publishQueue(live)
    // Admission is synchronous: reserve now, or persist the implementation
    // ahead of discussion while an update holds new Chat turns.
    const shown = names?.length ? { ...transferred, text: [...names.map(name => `/${name}`), transferred.text].join(' ') } : transferred
    const prompt: PromptInput = { ...transferred, text: poiseChangePrompt({ request, branch: prepared.branch, baseSha: prepared.baseSha, workspace: checkout }) }
    if (this.switchState) this.waitPromptForSwitch(live, prompt, { shown, implementsChange: true, switches: names })
    else {
      const turn = this.reserveTurn(live)
      turn.switches = names
      turn.implementsChange = true
      turn.shown = shown
      turn.input = prompt
      void this.serialized(live, () => this.runTurn(live, turn, prompt)).catch(() => undefined)
    }
    return { session: this.withLive(live.record), change: bound }
  }

  /** Uploaded evidence must outlive the source conversation. Reissue it under
   *  the target session, verifying bytes rather than trusting browser text. */
  private async copyPromptContext(sourceId: string, targetId: string, input: PromptInput): Promise<PromptInput> {
    const attachments: Attachment[] = []
    const source = this.get(sourceId)
    if (!source) throw new ChatError(404, 'The attachment source conversation no longer exists', 'unknown_session')
    for (const attachment of input.attachments) {
      const record = storage.getAttachment(attachment.id)
      if (!record || record.sessionId !== sourceId || record.path !== attachment.path || record.size !== attachment.size) {
        throw new ChatError(400, 'The attachment does not belong to the source conversation', 'invalid')
      }
      const { bytes } = await readCheckoutBytes(source.checkout, record.path, CHAT_LIMITS.attachmentBytes)
      if (bytes.byteLength !== record.size || sha256Of(bytes) !== record.sha256) throw new Error(`Attachment ${record.name} changed since upload`)
      attachments.push(await this.saveAttachment(targetId, record.name, bytes))
    }
    return { ...input, attachments }
  }

  private async copyQueuedContext(sourceId: string, targetId: string): Promise<void> {
    const source = this.requireLive(sourceId)
    await this.control(source, async () => {
      const owner = queueOwner(sourceId)
      for (const item of readQueue(owner).items) {
        if (item.state !== 'waiting' || !item.prompt.attachments.length) continue
        const prompt = await this.copyPromptContext(item.sourceSessionId || sourceId, targetId, item.prompt)
        this.mutateQueue(source, () => transferQueuedContext(owner, item.id, targetId, prompt))
      }
    })
  }

  /** Legacy/delegated queues can still borrow a conversation's uploaded files.
   *  Preserve waiting work under its surviving executor before deleting its source. */
  private async preserveBorrowedQueueContext(deletingId: string): Promise<void> {
    const seen = new Set<string>()
    for (const record of storage.listSessions(this.instance)) {
      const owner = queueOwner(record.id)
      if (seen.has(owner)) continue
      seen.add(owner)
      const queue = readQueue(owner)
      const targetId = queue.executorSessionId && queue.executorSessionId !== deletingId ? queue.executorSessionId : owner
      if (targetId === deletingId || !this.ownsSession(targetId)) continue
      for (const item of queue.items) {
        if (item.state !== 'waiting' || item.sourceSessionId !== deletingId || !item.prompt.attachments.length) continue
        const prompt = await this.copyPromptContext(deletingId, targetId, item.prompt)
        this.mutateQueue(this.requireLive(targetId), () => transferQueuedContext(owner, item.id, targetId, prompt))
      }
    }
  }

  /** The controller's own refusals are shown as they are; an unreachable
   *  controller is the actionable "not set up" error. */
  private async bridgeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (error instanceof SelfUpdateUnavailableError) throw new ChatError(503, error.message, 'self_update_unavailable')
      if (error instanceof SelfUpdateBridgeError) throw new ChatError(error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 502, error.message, 'agent_error')
      throw error
    }
  }

  /** A change that never got its turn is failed at the controller so the
   *  single lane is free again; a controller that cannot hear it now hears
   *  it from the outbox on the next start. */
  private async abandonChange(bridge: SelfUpdateBridge, changeId: string, error: string, sessionId = ''): Promise<void> {
    finishOutbox.queueFinish({ changeId, instance: this.instance, sessionId, outcome: 'failed', error })
    try {
      await bridge.finish(changeId, { outcome: 'failed', error })
      finishOutbox.markDelivered(changeId)
    } catch (failure) {
      finishOutbox.markAttempt(changeId, failure instanceof Error ? failure.message : String(failure))
    }
  }

  /** The change turn's settlement, after the worker is verifiably gone and
   *  the checkout released: the first outcome is recorded durably, then
   *  delivered; the controller checks the branch itself, so nothing the
   *  agent said is forwarded — only whether the turn ended cleanly. */
  private async settleChange(session: LiveSession, outcome: { stopReason: StopReason, error?: string, freed: boolean, terminalRecorded: boolean }): Promise<void> {
    const changeId = session.record.selfChangeId
    if (!changeId) return
    const completed = outcome.terminalRecorded && outcome.freed && outcome.stopReason === 'end_turn'
    const error = completed ? undefined
      : !outcome.terminalRecorded ? 'the turn outcome could not be recorded'
      : !outcome.freed ? (session.record.orphanNotice || 'the agent process could not be stopped')
      : outcome.error || `the change turn ended with ${outcome.stopReason}`
    const { fresh } = finishOutbox.queueFinish({ changeId, instance: this.instance, sessionId: session.record.id, outcome: completed ? 'completed' : 'failed', error })
    if (fresh) {
      try {
        this.emit_(session.record.id, { type: 'status.changed', status: session.record.status,
          detail: completed ? 'handed to the release controller: it checks, opens the PR, merges and releases from here' : `not released: ${error}` })
      } catch { /* mirror */ }
    }
    await this.flushSelfUpdateOutbox()
  }

  async createSwitch(input: { name: string, content: string, revision: number }) {
    this.assertAcceptingWork()
    const nativeNames = storage.listSessions(this.instance).flatMap(record => (record.commands || []).map(command => command.name))
    const catalogue = await this.track(() => saveSwitch(input, nativeNames))
    this.emit('switches', catalogue)
    return catalogue
  }

  // ── Turns ──────────────────────────────────────────────────────────────

  /** The admission guards every new turn passes, started at once or waited
   *  behind an update. */
  private assertTurnAdmissible(session: LiveSession): void {
    if (session.record.role === 'manager' && session.record.retiredModel) {
      throw new ChatError(409, `The Manager's model ${session.record.retiredModel} was retired. Choose another model to continue.`, 'invalid')
    }
    if (session.record.contextResetting) throw new ChatError(409, 'The chat is resetting; wait for it to finish.', 'turn_in_progress')
    if (session.turn) throw new ChatError(409, 'a turn is already running; Enter steers it', 'turn_in_progress')
    if (session.record.status === 'closed') throw new ChatError(409, 'the session is closed; resume it first', 'no_turn')
    if (session.lifecycle.signal.aborted) throw new ChatError(409, 'the session is closing', 'no_turn')
  }

  /** Reserve the turn synchronously — before any await — so a second prompt
   *  in the same tick is refused, and persist it before acknowledging. */
  private reserveTurn(session: LiveSession, queueItem?: QueuedMessage, internal?: { seq: number, at: number }): RunningTurn {
    this.assertTurnAdmissible(session)
    // A new turn supersedes any Stop asked for an earlier one.
    if (session.record.stopRequestedTurnId !== undefined) {
      session.record.stopRequestedTurnId = undefined
      this.saveRecord(session)
    }
    let releasePrompt!: () => void
    const promptReady = new Promise<void>(resolve => { releasePrompt = resolve })
    const turn: RunningTurn = { id: randomUUID(), callId: null, startedAt: Date.now(), abort: new AbortController(), stopping: false, promptReady, releasePrompt }
    turn.abort.signal.addEventListener('abort', releasePrompt, { once: true })
    storage.reserveQueueTurn(session.record.id, turn.id, queueItem?.id, internal)
    if (queueItem) {
      turn.queueItem = queueItem
      turn.input = queueItem.prompt
      turn.shown = queueItem.recovery?.shown
      turn.implementsChange = queueItem.recovery?.implementsChange
      turn.switches = queueItem.recovery?.switches
    }
    if (queueItem?.source) turn.source = { ...queueItem.source }
    session.turn = turn
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    return turn
  }

  prompt(id: string, input: PromptInput, internal?: { seq: number, source: TurnSource, shown: string, at: number }): PromptReceipt {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    if (session.record.role === 'manager' && session.record.retiredModel) {
      throw new ChatError(409, `The Manager's model ${session.record.retiredModel} was retired. Choose another model to continue.`, 'invalid')
    }
    const prompt = this.validatePrompt(id, input)
    const chain = parseCommands(prompt.text)
    refuseManagerSwitch(chain.switches, session.record.role === 'manager')
    refuseWorkerSwitch(chain.switches, session.record.role === 'worker')
    if (chain.missingModel) throw new ChatError(400, 'Choose a model from /model first.', 'invalid')
    if (chain.create) throw new ChatError(400, 'Save a switch with the create command, not an agent prompt.', 'invalid')
    if (chain.content !== undefined || chain.consensus !== undefined) throw new ChatError(400, 'Run /content or /consensus as a chat command, not as an agent prompt.', 'invalid')
    expandSwitches(chain.text, chain.switches)
    if (chain.queue) throw new ChatError(400, 'Use the queue command to defer a message.', 'invalid')
    if (chain.context === 'reset' && chain.review) throw new ChatError(400, 'A reset removes the reply to review. Review it first or send a new message after resetting.', 'invalid')
    if (chain.model && !chain.text && !chain.switches?.length && !chain.review && !chain.context && !prompt.attachments.length) throw new ChatError(400, 'A model-only selection uses set_model; add a task to send a message.', 'invalid')
    const throughSeq = session.record.lastSeq
    const target = chain.review ? latestReviewTarget(id, throughSeq) : null
    if (chain.review && !target) throw new ChatError(400, 'There is no assistant reply to review yet.', 'invalid')
    if (this.switchState || this.waitingImplementation(id)) {
      // Internal deliveries wait in the caller's hand: the control tick
      // holds them pending until the switch lands, so their provenance
      // survives. Anything else would admit them twice or unattributed.
      if (internal) throw new ChatError(503, SWITCH_WAIT_REASON, 'switch_waiting')
      return this.waitPromptForSwitch(session, prompt)
    }
    if (session.record.selfChangeId && this.changeStarts.has(session.record.selfChangeId)) {
      throw new ChatError(409, 'the Poise implementation is still being prepared; wait for its first turn', 'turn_in_progress')
    }
    const turn = this.reserveTurn(session, undefined, internal ? { seq: internal.seq, at: internal.at } : undefined)
    turn.input = prompt
    turn.switches = chain.switches
    turn.commandModel = chain.model
    turn.contextAction = chain.context
    if (target) turn.review = { target, throughSeq }
    if (chain.model || chain.review || chain.context || chain.switches?.length) turn.shown = prompt
    if (internal) {
      // The agent gets the provenance header with the message; the
      // transcript shows the message alone, labelled with its source.
      turn.shown = { text: internal.shown, attachments: [], mentions: [] }
      turn.source = internal.source
    }
    void this.serialized(session, () => this.runTurn(session, turn, { ...prompt, text: chain.text })).catch(() => undefined)
    return { turnId: turn.id }
  }

  private waitingImplementation(sessionId: string): boolean {
    return this.readWaitingPrompts().some(entry => entry.sessionId === sessionId && entry.recovery?.implementsChange === true)
  }

  /** While a switch is pending, an admissible prompt waits behind the update
   *  instead of starting. Durable from this synchronous return: withdrawal,
   *  restart and crash all start it later, in arrival order. */
  private waitPromptForSwitch(session: LiveSession, prompt: PromptInput, recovery?: SwitchPromptMetadata): PromptReceipt {
    this.assertTurnAdmissible(session)
    const entry: WaitingPrompt = { id: randomUUID(), sessionId: session.record.id, prompt, createdAt: new Date().toISOString(),
      queueBefore: recovery?.implementsChange ? [] : this.messageQueue(session.record.id).items.filter(item => item.state === 'waiting').map(item => item.id),
      ...(recovery ? { recovery } : {}) }
    const rows = this.readWaitingPrompts()
    // The change child is visible before controller binding returns. Its
    // first implementation still precedes discussion already waiting there.
    const before = recovery?.implementsChange ? rows.findIndex(row => row.sessionId === session.record.id) : -1
    rows.splice(before < 0 ? rows.length : before, 0, entry)
    this.writeWaitingPrompts(rows)
    session.record.queuedBehind = SWITCH_WAIT_REASON
    this.setStatus(session, 'queued')
    return { waitId: entry.id }
  }

  private validatePrompt(id: string, input: PromptInput): PromptInput {
    const text = String(input.text || '').trim()
    if (!text && !input.attachments?.length) throw new ChatError(400, 'prompt is required', 'invalid')
    if (Buffer.byteLength(text, 'utf8') > CHAT_LIMITS.promptBytes) throw new ChatError(413, `prompt exceeds ${CHAT_LIMITS.promptBytes} bytes`, 'invalid')
    // What the browser says about an attachment is checked against the
    // record this server issued; only the id, name, path and size it
    // recorded go on, never client-supplied text.
    const attachments: Attachment[] = []
    for (const claimed of (input.attachments ?? []).slice(0, 20)) {
      const record = claimed && typeof claimed.id === 'string' ? storage.getAttachment(claimed.id) : null
      if (!record || record.sessionId !== id) throw new ChatError(400, `attachment ${claimed?.name ?? ''} does not belong to this session`, 'invalid')
      if (claimed.path !== record.path || claimed.size !== record.size) throw new ChatError(400, `attachment ${record.name} does not match its record`, 'invalid')
      attachments.push({ id: record.id, name: record.name, path: record.path, size: record.size })
    }
    const mentions = (input.mentions ?? []).filter((m) => m && typeof m.path === 'string').slice(0, 50).map((m) => ({ path: m.path }))
    return { text, attachments, mentions }
  }

  // ── Deferred messages ───────────────────────────────────────────────────

  async enqueue(id: string, itemId: string, input: PromptInput, model?: string, effort?: string, recovery?: SwitchPromptMetadata): Promise<MessageQueue> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    if (!UUID_PATTERN.test(itemId)) throw new ChatError(400, 'itemId must be a UUID', 'invalid')
    return this.control(session, async () => {
      const submitted = this.validatePrompt(id, input)
      const chain = parseCommands(submitted.text)
      refuseManagerSwitch(chain.switches, session.record.role === 'manager')
      refuseWorkerSwitch(chain.switches, session.record.role === 'worker')
      if (chain.create) throw new ChatError(400, 'Save the switch directly with /create, then queue its use.', 'invalid')
      if (chain.content !== undefined || chain.consensus !== undefined) throw new ChatError(400, 'Run /content or /consensus now; queueing them would run them as prompts.', 'invalid')
      expandSwitches(chain.text, chain.switches)
      if (chain.context === 'reset' && chain.review) throw new ChatError(400, 'A reset removes the reply to review.', 'invalid')
      if (chain.missingModel) throw new ChatError(400, 'Choose a model from /model first.', 'invalid')
      const prompt = this.validatePrompt(id, { ...submitted, text: commandBody(chain) })
      const target = await this.resolveModel(model || chain.model || session.record.model, effort)
      if (!this.ownsSession(id)) throw new ChatError(404, 'unknown session', 'unknown_session')
      return this.mutateQueue(session, () => enqueueMessage(queueOwner(id), { id: itemId, sourceSessionId: recovery?.sourceSessionId ?? id, ...(recovery?.source ? { source: recovery.source } : {}),
        ...(recovery ? { recovery: { shown: recovery.shown, implementsChange: recovery.implementsChange, switches: recovery.switches } } : {}), prompt, agent: target.agent, model: target.model.identity,
        effort: target.effort, createdAt: new Date().toISOString(), state: 'waiting' }))
    })
  }

  async updateQueue(id: string, itemId: string, model: string, effort?: string): Promise<MessageQueue> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    return this.control(session, async () => {
      const target = await this.resolveModel(model, effort)
      return this.mutateQueue(session, () => updateQueuedModel(queueOwner(id), itemId, { agent: target.agent, model: target.model.identity, effort: target.effort }))
    })
  }

  removeQueue(id: string, itemId: string): MessageQueue {
    const session = this.requireLive(id)
    return this.mutateQueue(session, () => removeQueuedMessage(queueOwner(id), itemId))
  }

  private queueOperation<T>(operation: () => T): T {
    try { return operation() } catch (error) {
      if (error instanceof QueueError) throw new ChatError(409, error.message, error.code)
      throw error
    }
  }

  private mutateQueue(session: LiveSession, operation: () => MessageQueue): MessageQueue {
    const envelope = storage.commitQueueMutation(session.record.id, () => this.queueOperation(operation))
    session.record.lastSeq = envelope.seq
    // The durable receipt is authoritative even if a browser disconnected.
    try { this.emit('event', envelope) } catch { /* reconnect reads the mirror */ }
    const queue = this.messageQueue(session.record.id)
    for (const id of [queueOwner(session.record.id), queue.executorSessionId]) {
      if (id && id !== session.record.id && this.ownsSession(id)) {
        try { this.emit_(id, { type: 'queue.updated', queue }) } catch { /* REST also includes the committed queue */ }
      }
    }
    return queue
  }

  private messageQueue(id: string): MessageQueue {
    const queue = readQueue(queueOwner(id))
    return this.queueReleaseWait.has(queue.executorSessionId || id) ? { ...queue, waitingForRelease: true } : queue
  }

  private publishQueue(session: LiveSession): MessageQueue {
    const owner = queueOwner(session.record.id)
    const queue = this.messageQueue(session.record.id)
    if (queue.revision) {
      this.emit_(session.record.id, { type: 'queue.updated', queue })
      for (const id of [owner, queue.executorSessionId]) {
        if (id && id !== session.record.id && this.ownsSession(id)) this.emit_(id, { type: 'queue.updated', queue })
      }
    }
    return queue
  }

  /** Never called by enqueue. A known completed turn arms the persistent
   *  queue; execution waits for its lifecycle/lease cleanup to finish. */
  private scheduleQueue(session: LiveSession): void {
    const id = session.record.id
    if (session.record.role === 'manager' && session.record.retiredModel) return
    if (this.stopped || this.recovering || this.drainState || this.switchState || session.lifecycle.signal.aborted || session.record.status === 'closed'
      || session.record.contextResetting || session.record.orphanNotice || session.turn || this.deferredWaitingSessions.has(id) || this.queuePumps.has(id) || this.queueTimers.has(id)) return
    if (!this.readInterruptedSessions().some(row => row.sessionId === id)
      && !this.readWaitingPrompts().some(entry => entry.sessionId === id) && !this.messageQueue(id).ready) return
    this.queuePumps.add(id)
    let ran = false
    void this.serialized(session, async () => {
      if (this.stopped || this.drainState || this.switchState || session.lifecycle.signal.aborted || session.turn || storage.getOpenTurn(id)) return
      // An isolated implementation hands its checkout to the release
      // controller after its turn. Never let a follow-up edit that checkout
      // while checks/build/deployment still own it. This is a wait, not an
      // extra confirmation; the durable queue continues after deployment.
      const interrupted = this.readInterruptedSessions().find(row => row.sessionId === id)
      const waiting = this.readWaitingPrompts().find(entry => entry.sessionId === id)
      const implementing = interrupted?.implementsChange || waiting?.recovery?.implementsChange
      if (session.record.selfChangeId && this.selfUpdate?.configured && !implementing) {
        let done = false
        try {
          const status = await this.selfUpdate.status()
          const change = status.changes.find(change => change.id === session.record.selfChangeId)
          done = !!change && ['live', 'failed', 'blocked', 'reverted', 'superseded'].includes(change.state)
        } catch { /* retry after the controller is reachable */ }
        if (!done) {
          if (!this.queueReleaseWait.has(id)) { this.queueReleaseWait.add(id); this.publishQueue(session) }
          const timer = setTimeout(() => { this.queueTimers.delete(id); this.scheduleQueue(session) }, 1_000)
          timer.unref(); this.queueTimers.set(id, timer)
          return
        }
        this.queueReleaseWait.delete(id)
      }
      if (this.stopped || this.drainState || this.switchState || session.turn || session.lifecycle.signal.aborted || storage.getOpenTurn(id)) return
      if (interrupted) {
        const outcome = await this.resumeInterruptedSession(interrupted, interrupted.continuation ?? SWITCH_CONTINUE_PROMPT)
        ran = outcome !== 'deferred'
        return
      }
      if (waiting && !this.waitingPromptBlocked(waiting) && !this.recoveryOwnedElsewhere(id) && this.takeWaitingPrompt(waiting.id)) {
        const outcome = await this.deliverWaitingPrompt(id, waiting.prompt, 'waiting', waiting.recovery, waiting)
        ran = outcome !== 'deferred'
        return
      }
      const queue = this.messageQueue(id)
      if (queue.executorSessionId && queue.executorSessionId !== id) return
      const item = queue.ready && queue.items.find(candidate => candidate.state === 'waiting')
      if (!item || this.stopped || this.drainState || this.switchState || session.turn || session.lifecycle.signal.aborted) return
      const turn = this.reserveTurn(session, item)
      ran = true
      await this.runTurn(session, turn, item.prompt)
    }).catch(error => {
      this.emit('log', `[chat queue ${id}] ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.queuePumps.delete(id)
      // runTurn's completion armed the following item while this pump was held.
      if (ran && !session.turn && !storage.getOpenTurn(id)) this.scheduleQueue(session)
    })
  }

  /** A different queued agent is a real native handoff, not a renamed
   *  model. Keep the Poise conversation, workspace and draft; start a new
   *  native context with a labelled summary of the actual preceding turns. */
  private async prepareQueuedAgent(session: LiveSession, turn: RunningTurn): Promise<void> {
    const item = turn.queueItem!
    const target = await this.resolveModel(item.model, item.effort)
    if (target.agent !== item.agent) throw new ChatError(409, 'The queued model now belongs to a different agent.', 'invalid')
    await this.selectSessionModel(session, item.model, item.effort)
  }

  /** Selecting another provider is a real adapter handoff in this conversation.
   *  Merely selecting never starts a model call; the next admitted task does. */
  private async selectSessionModel(session: LiveSession, identity: string, effortOverride?: string): Promise<void> {
    const target = await this.resolveModel(identity, effortOverride)
    const record = session.record
    let nativeModelId = target.model.selector
    if (target.agent === 'claude') await this.requireClaudeReady()
    if (target.agent === record.agent && target.model.selector === record.modelId && record.efforts?.length && !record.efforts.includes(target.effort)) {
      throw new ChatError(400, `${target.model.selector} offers native efforts ${record.efforts.join(', ')}`, 'invalid')
    }
    if (record.agent !== target.agent) {
      const context = storage.findEvent(record.id, event => event.type === 'text.delta') ? this.handoffSummary(record) : undefined
      await this.stopProcess(session)
      record.queuedHandoff = context
      record.agent = target.agent
      record.nativeSessionId = undefined
      record.capabilities = emptyCapabilities()
      record.mode = undefined; record.modes = undefined; record.commands = undefined; record.efforts = undefined
      session.grants.clear()
    } else if (session.adapter?.alive && (record.model !== target.model.identity || record.effort !== target.effort)) {
      const applied = await session.adapter.setModel(target.model.selector, target.effort)
      if (applied.efforts || record.modelId !== target.model.selector) record.efforts = applied.efforts
      // Providers may resolve a catalogue selector to a dated native alias.
      nativeModelId = applied.modelId || target.model.selector
      if (applied.effort && applied.effort !== target.effort) throw new ChatError(409, 'The agent did not apply the selected effort.', 'agent_error')
    } else if (record.modelId !== target.model.selector) record.efforts = undefined
    record.model = target.model.identity; record.modelId = nativeModelId; record.effort = target.effort
    const recovered = record.retiredModel !== undefined
    delete record.retiredModel
    this.saveRecord(session)
    this.emit_(record.id, { type: 'model.updated', model: record.model, modelId: record.modelId, effort: record.effort, efforts: record.efforts })
    this.emit_(record.id, { type: 'session.updated', session: record })
    if (recovered) this.scheduleQueue(session)
  }

  /** Stage an uploaded file inside the session's checkout, under the lease.
   *  While this session's own turn holds the checkout the write is one of
   *  the turn's services (the turn does not release before it returns);
   *  otherwise it runs in the session's operation chain under a lease of its
   *  own, so it cannot interleave with close, delete or the next turn. The
   *  record is issued inside the protected operation. */
  async saveAttachment(id: string, filename: string, body: Buffer): Promise<Attachment> {
    this.assertAcceptingWork()
    return this.track(() => this.stageAttachment(id, filename, body))
  }

  private async stageAttachment(id: string, filename: string, body: Buffer): Promise<Attachment> {
    const session = this.requireLive(id)
    const record = session.record
    if (record.status === 'closed' || session.lifecycle.signal.aborted) throw new ChatError(409, 'the session is closed', 'no_turn')
    if (body.byteLength > CHAT_LIMITS.attachmentBytes) throw new ChatError(413, `attachment exceeds ${CHAT_LIMITS.attachmentBytes} bytes`, 'invalid')
    const name = safeAttachmentName(filename)
    const attachmentId = randomUUID()
    const relative = attachmentPath(record.id, attachmentId, name)
    const write = async () => {
      if (record.status === 'closed' || session.lifecycle.signal.aborted) throw new ChatError(409, 'the session is closing', 'no_turn')
      const { absolute } = await resolveInsideCheckout(record.checkout, relative)
      await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
      await ensureExcluded(record.checkout)
      await writeFile(absolute, body, { flag: 'wx', mode: 0o600 })
      storage.insertAttachment({ id: attachmentId, sessionId: record.id, name, path: relative, size: body.byteLength, sha256: sha256Of(body), createdAt: new Date().toISOString() })
    }
    if (!(await this.asTurnService(session, write))) {
      await this.serialized(session, async () => {
        const lease = this.leaseFor(session)
        const deadline = AbortSignal.timeout(ATTACHMENT_LEASE_WAIT_MS)
        const signal = AbortSignal.any([session.lifecycle.signal, deadline])
        let holder = ''
        try {
          await lease.acquire({ signal, onBusy: (busy) => { holder = describeHolder(busy.holder) } })
        } catch {
          throw new ChatError(409, deadline.aborted ? `the checkout is busy (${holder}); try again when that turn is over` : 'the session is closing', 'checkout_busy')
        }
        try {
          await write()
        } finally {
          lease.release()
        }
      })
    }
    return { id: attachmentId, name, path: relative, size: body.byteLength }
  }

  /** Run `operation` as a service of the session's running turn, counted so
   *  the turn drains it before releasing the checkout. False when there is
   *  no such turn (or it is already draining), in which case the caller
   *  takes its own lease. */
  private async asTurnService(session: LiveSession, operation: () => Promise<void>): Promise<boolean> {
    const turn = session.turn
    if (!turn || turn.stopping || session.draining || !session.lease?.held) return false
    session.services += 1
    try {
      if (session.draining || !session.lease?.held) return false
      await operation()
      return true
    } finally {
      session.services -= 1
    }
  }

  private async removeAttachments(session: LiveSession): Promise<void> {
    for (const directory of [ATTACHMENT_DIR, '.poise-chat/reviews', '.poise-chat/context']) {
      try {
        const { absolute } = await resolveInsideCheckout(session.record.checkout, `${directory}/${session.record.id}`)
        await rm(absolute, { recursive: true, force: true })
      } catch { /* missing or inaccessible private staging is never followed outside the checkout */ }
    }
  }

  /** Under the held lease, on the session's branch: read every attachment
   *  from its record (bounded, regular files only, content verified against
   *  the recorded hash) and check every @mention names a real file inside
   *  the checkout. A claim that does not hold fails the turn readably. */
  private async resolveInput(session: LiveSession, input: PromptInput, sourceSessionId = session.record.id): Promise<PromptInput> {
    const checkout = session.record.checkout
    const attachments: Attachment[] = []
    for (const attachment of input.attachments) {
      const record = storage.getAttachment(attachment.id)
      if (!record || record.sessionId !== sourceSessionId) throw new Error(`attachment ${attachment.name} is not one of this session's`)
      const source = sourceSessionId === session.record.id ? session.record : this.get(sourceSessionId)
      if (!source) throw new Error('The queued attachment source session no longer exists')
      let text: string | undefined
      try {
        const { bytes } = await readCheckoutBytes(source.checkout, record.path, CHAT_LIMITS.attachmentBytes)
        if (bytes.byteLength !== record.size || sha256Of(bytes) !== record.sha256) throw new Error(`attachment ${record.name} changed on disk since it was uploaded`)
        if (source.checkout !== checkout) {
          const target = await resolveInsideCheckout(checkout, record.path)
          await mkdir(dirname(target.absolute), { recursive: true, mode: 0o700 })
          await ensureExcluded(checkout)
          await writeFile(target.absolute, bytes, { mode: 0o600 })
        }
        text = inlineText(bytes)
      } catch (error) {
        if (error instanceof PathError) throw new Error(`attachment ${record.name} is no longer readable in the checkout (${error.message})`)
        throw error
      }
      attachments.push({ id: record.id, name: record.name, path: record.path, size: record.size, ...(text !== undefined ? { text } : {}) })
    }
    const mentions: PromptInput['mentions'] = []
    for (const mention of input.mentions) {
      try {
        const { relative } = await readCheckoutBytes(checkout, mention.path)
        mentions.push({ path: relative })
      } catch (error) {
        throw new Error(`@${mention.path} is not a file in the checkout (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    return { ...input, attachments, mentions }
  }

  private async runTurn(session: LiveSession, turn: RunningTurn, input: PromptInput): Promise<void> {
    turn.input ??= input
    const record = session.record
    let lease: CheckoutLease | null = null
    let stopReason: StopReason = 'error'
    let error: string | undefined
    let usage
    let terminate = false
    let unrunSteers: string[] | undefined
    let agentSettled = false
    let agentInvoked = false
    let checkoutBefore: CheckoutSnapshot | null = null
    let started = false
    let editorContext = false
    session.draining = false
    try {
      if (turn.abort.signal.aborted) throw new Error(turn.failure || 'cancelled before it started')
      if (turn.contextAction === 'compact' || (turn.queueItem && parseCommands(input.text).context === 'compact')) {
        record.contextCompacting = true
        this.saveRecord(session); this.emit_(record.id, { type: 'session.updated', session: record })
      }
      await session.steering
      if (record.safeModePending && session.adapter?.alive) await this.stopProcess(session)
      if (turn.queueItem) {
        const chain = parseCommands(input.text)
        if (chain.create) throw new ChatError(400, 'Switch definitions cannot be created by a queued provider task.', 'invalid')
        refuseManagerSwitch(chain.switches, record.role === 'manager')
        refuseWorkerSwitch(chain.switches, record.role === 'worker')
        turn.switches = chain.switches ?? turn.switches
        turn.contextAction = chain.context
        if (chain.context || chain.switches?.length) { turn.shown = input; input = { ...input, text: chain.text } }
        if (chain.review) {
          const throughSeq = record.lastSeq
          const target = latestReviewTarget(record.id, throughSeq)
          if (!target) throw new ChatError(400, 'There is no assistant reply to review yet.', 'invalid')
          turn.review = { target, throughSeq }; turn.shown ??= input
          input = { ...input, text: chain.text }
        }
        this.publishQueue(session); await this.prepareQueuedAgent(session, turn)
      } else if (turn.commandModel) await this.selectSessionModel(session, turn.commandModel, turn.commandEffort)
      if (turn.contextAction === 'reset') {
        await this.stopProcess(session)
        this.releaseSettledLease(session)
        lease = this.leaseFor(session)
        await lease.acquire({ signal: turn.abort.signal, onBusy: busy => this.reportBusy(session, busy) })
        session.lease = lease
        this.clearContext(session)
        if (!input.text && !input.attachments.length && !turn.switches?.length) {
          this.emit_(record.id, { type: 'turn.started', turnId: turn.id, prompt: turn.shown ?? { ...input, text: '/reset' }, ...(turn.queueItem ? { queueItemId: turn.queueItem.id } : {}), ...(turn.source ? { source: turn.source } : {}) })
          started = true; stopReason = 'end_turn'; return
        }
      }
      if (turn.contextAction === 'compact' && (!record.nativeSessionId || record.queuedHandoff || !storage.findEvent(record.id, e => e.type === 'text.delta')) && !input.text && !input.attachments.length && !turn.switches?.length && !turn.review) {
        this.emit_(record.id, { type: 'turn.started', turnId: turn.id, prompt: turn.shown ?? { ...input, text: '/compact' }, ...(turn.queueItem ? { queueItemId: turn.queueItem.id } : {}), ...(turn.source ? { source: turn.source } : {}) })
        started = true
        this.emit_(record.id, { type: 'context.compacted', turnId: turn.id, detail: 'No native conversation history to compact yet.' })
        stopReason = 'end_turn'; return
      }
      if (session.adapter?.alive) {
        const cli = await this.checkSessionCli(session, turn.abort.signal)
        // A newer installation does not alter the running process's version.
        // At this idle boundary, resume the same native session on the new CLI.
        if (cli?.after && cli.status !== 'unavailable' && cli.after !== session.nativeCliVersion) await this.stopProcess(session)
      }
      // Extensions switched on, off or changed since the process started:
      // resume the same native session with the new set before this turn.
      if (session.adapter?.alive && this.options.extensions && !isSwitchboardChat(record) && (await this.options.extensions.resolve(record)).fingerprint !== session.nativeExtensions) await this.stopProcess(session)
      if (!session.adapter?.alive) await this.startSession(session, { fresh: !record.nativeSessionId && !record.branch.baseSha && record.branch.provisional, ...(lease ? { lease } : {}) })
      let adapter = session.adapter!
      const isFirst = !storage.findEvent(record.id, (e) => e.type === 'turn.started')
      // A change session is titled by its request, not by the runbook's first line. The Manager keeps its title.
      if (shouldAutoName(record, isFirst, internalTurn(turn.id))) {
        const ref = parseIssueReference(input.text.split('\n')[0] ?? '', record.repo)
        const issueTitle = ref ? await resolveIssueTitle(ref).catch(() => null) : null
        // A rename that landed during the lookup wins over the derived title.
        if (shouldAutoName(record, isFirst, internalTurn(turn.id))) {
          record.title = deriveSessionTitle(input.text, { repo: record.repo, issueTitle }).slice(0, TITLE_CHARS) || record.title
          this.saveRecord(session)
          this.emit_(record.id, { type: 'session.updated', session: record })
        }
      }
      // The Caller row first, so its id is part of the durable turn record.
      if (this.caller) {
        turn.callId = await this.caller.start({ model: record.model, sessionId: record.id, repo: record.repo, pr: record.branch.pr, correlationId: turn.id })
        storage.setOpenTurn(record.id, turn.id, turn.callId)
      }
      const nativeInput = await this.composePrompt(session, input, isFirst)
      this.emit_(record.id, { type: 'turn.started', turnId: turn.id, prompt: turn.shown ?? nativeInput, callId: turn.callId ?? undefined, agent: record.agent, model: record.model, ...(turn.queueItem ? { queueItemId: turn.queueItem.id } : {}), ...(turn.source ? { source: turn.source } : {}) })
      started = true
      this.setStatus(session, 'queued')
      // Poise-local turns share a bounded pool of check slots with the
      // agent runs background behaviors launch; a turn past the cap waits
      // here with its own reason instead of starting an agent. The
      // Switchboard's one observer turn and the Manager's turns stay outside
      // it, so supervision still runs when every slot is busy.
      if (record.workspaceKind === 'poise-local' && !isSwitchboardChat(record) && record.role !== 'manager') await this.acquireLocalTurnSlot(session, turn)
      // Created after the title settled: the label names what is queued behind.
      if (!lease) {
        lease = this.leaseFor(session)
        await lease.acquire({ signal: turn.abort.signal, onBusy: (busy) => this.reportBusy(session, busy) })
      }
      session.lease = lease
      session.relayDetached = false
      lease.onLost(() => {
        try { this.emit_(record.id, { type: 'error', message: 'the checkout lease was lost; stopping the turn', recoverable: true }) } catch { /* mirror */ }
        turn.failure = 'the checkout lease was lost'
        turn.abort.abort()
        void adapter.cancel()
      })
      await this.prepareCheckout(session, lease)
      if (session.relay) {
        const gateIdent = storage.getWorker(record.id)?.ident
        if (!gateIdent) throw new Error('the checkout lease was lost before the turn started')
        if (!lease.registerWorker({ pid: session.relay.gatePid, pgid: session.relay.gatePgid, ident: gateIdent })) throw new Error('the checkout lease was lost before the turn started')
        storage.setWorkerLeaseToken(record.id, lease.currentToken)
      }
      let adapterInput = await this.resolveInput(session, nativeInput, turn.queueItem?.sourceSessionId ?? turn.inputSourceSessionId)
      if (turn.review) adapterInput = await prepareReview(record.checkout, record.id, turn.id, turn.review.throughSeq, turn.review.target, { ...adapterInput, text: input.text }, turn.abort.signal)
      // Every ordinary turn of an Editor session reads the voice guide, the
      // saved document and the edit format from a read-only file written
      // here, under the held lease. A /review, /compact or bare /reset turn
      // is about the conversation and gets none.
      if (!turn.review && turn.contextAction !== 'compact' && record.subject?.surface.startsWith('editor-')) {
        adapterInput = await prepareEditorContext(record.checkout, record, turn.id, adapterInput, turn.abort.signal)
        editorContext = true
      }
      if (session.staged) {
        const report = await refreshDocument(record.checkout, session.staged)
        if (report.kind === 'refreshed' || report.kind === 'staged') this.saveRecord(session)
        if (isBridgeProblem(report)) this.emit_(record.id, { type: 'error', message: report.message, recoverable: true })
      }
      // Capture before the native prompt can write, not in an asynchronous
      // item/started notification that races the tool's filesystem effects.
      checkoutBefore = await captureCheckoutSnapshot(record.checkout, session.staged ? [session.staged.path] : [])
      // Settings may change during the handshake or a checkout wait. No native
      // user prompt has started yet, so use the newest acknowledged policy now.
      await session.steering
      while (record.safeModePending) {
        turn.abort.signal.throwIfAborted()
        try {
          await this.stopProcess(session)
          await this.startSession(session, { lease })
        } catch (failure) {
          // A failed replacement may still own a live worker even though the
          // prompt was never invoked. Final cleanup must verify its exit too.
          terminate = true
          throw failure
        }
        await session.steering
      }
      adapter = session.adapter!
      if (turn.abort.signal.aborted) throw new Error(turn.failure || 'cancelled before the agent prompt')
      this.setStatus(session, 'running')
      if (record.queuedHandoff) adapterInput.text = `${record.queuedHandoff}\n\n[Current task]\n${adapterInput.text}`
      if (turn.contextAction === 'compact' && storage.findEvent(record.id, event => event.type === 'text.delta') && !record.queuedHandoff) {
        if (!adapter.compact) throw new ChatError(409, `${AGENT_LABEL[record.agent]} does not expose context compaction.`, 'unsupported')
        record.contextCompacting = true
        this.saveRecord(session); this.emit_(record.id, { type: 'session.updated', session: record })
        agentInvoked = true
        turn.agentInvoked = true
        const compacted = await adapter.compact(turn.id, readMemories().text, turn.abort.signal)
        if (compacted.stopReason !== 'end_turn') {
          agentSettled = true; terminate = compacted.terminate === true
          stopReason = compacted.stopReason; error = compacted.error; usage = compacted.usage
          return
        }
        record.contextCompacting = false
        this.saveRecord(session); this.emit_(record.id, { type: 'session.updated', session: record })
        this.emit_(record.id, { type: 'context.compacted', turnId: turn.id,
          detail: compacted.compaction?.detail || (compacted.compaction?.changed === false ? 'No further compaction was needed.' : 'Conversation context compacted. Chat history is unchanged.') })
        if (!input.text && !input.attachments.length && !turn.switches?.length && !turn.review) { agentSettled = true; stopReason = 'end_turn'; usage = compacted.usage; return }
        turn.abort.signal.throwIfAborted()
      }
      if (record.contextCompacting) { record.contextCompacting = false; this.saveRecord(session); this.emit_(record.id, { type: 'session.updated', session: record }) }
      if (turn.contextAction === 'compact') {
        turn.agentInvoked = false
        await session.steering
        if (record.safeModePending) {
          await this.stopProcess(session)
          await this.startSession(session, { lease })
          adapter = session.adapter!
        }
      }
      turn.abort.signal.throwIfAborted()
      turn.contextAction = undefined
      const controlContext = await this.options.controlContext?.(record.id)
      turn.abort.signal.throwIfAborted()
      const expanded = expandSwitches(adapterInput.text, turn.switches)
      // A turn another chat or Poise started is source data, never the
      // person's request — except a Switchboard relay, which is the person's
      // own answer.
      const personRelay = turn.source?.kind === 'poise' && turn.source.name === SWITCHBOARD_PERSON
      // The spool brackets the agent's bytes for this turn: a restart
      // replays exactly what it captured. On a handed-over turn the peer
      // is already detached, so the finish below is a silent no-op and the
      // spool stays for the next server.
      session.relay?.turnStart(turn.id)
      if (session.relay) turn.relayHeld = true
      let result: TurnResult
      try {
        const promptInput = withAutoMergeInstructions({ ...adapterInput, text: controlContext ? `${controlContext}\n\n[Request]\n${expanded}` : expanded, memories: readMemories().text }, record.autoMerge, turn.implementsChange, turn.source && !personRelay ? 'source' : 'person')
        agentInvoked = true
        turn.agentInvoked = true
        turn.requestInvoked = true
        const response = adapter.prompt(turn.id, promptInput, turn.abort.signal)
        turn.releasePrompt()
        result = await response
        // A Muse turn that failed only because its native session's reasoning
        // was encrypted for a previous credential holder restarts once, inside
        // this same turn, on a fresh native session.
        if (record.agent === 'muse' && result.stopReason === 'error' && result.error && isStaleMuseCaller(result.error)
          && !turn.stopping && !turn.abort.signal.aborted && !turn.failure) {
          result = await this.recoverStaleMuseTurn(session, turn, lease, promptInput)
          adapter = session.adapter!
        }
      } finally {
        session.relay?.turnFinish()
        turn.relayHeld = false
      }
      agentSettled = true
      if (record.queuedHandoff && result.stopReason === 'end_turn') { record.queuedHandoff = undefined; this.saveRecord(session) }
      if (result.note) this.recordTurnNote(session, turn, result.note)
      // A guard end is not a stop: the turn finished without work left.
      stopReason = turn.guardEnd && !turn.failure ? 'end_turn'
        : turn.stopping || turn.abort.signal.aborted ? 'cancelled' : result.stopReason
      error = result.error
      usage = result.usage
      terminate = result.terminate === true
      unrunSteers = result.unrunSteers
      if (turn.failure && stopReason !== 'cancelled') { stopReason = 'error'; error = turn.failure }
    } catch (err) {
      // A handed-over turn records nothing: the next server owns its ending.
      if (!session.relayDetached) {
        const cancelled = turn.abort.signal.aborted
        stopReason = cancelled ? 'cancelled' : 'error'
        error = cancelled
          ? (turn.failure && turn.failure !== 'cancelled before it started' ? turn.failure : undefined)
          : err instanceof CallerCompatError ? err.message : `${err instanceof Error ? err.message : String(err)}`
        if (turn.guardEnd && !turn.failure) { stopReason = 'end_turn'; error = undefined }
        try {
          if (!started) this.emit_(record.id, { type: 'turn.started', turnId: turn.id, prompt: turn.shown ?? input, callId: turn.callId ?? undefined, ...(turn.source ? { source: turn.source } : {}) })
          if (!cancelled) this.emit_(record.id, { type: 'error', message: error || 'turn failed', recoverable: true })
        } catch { /* mirror */ }
      }
    } finally {
      turn.releasePrompt()
      this.releaseLocalTurnSlot(turn)
      if (editorContext) await removeEditorContext(record.checkout, record.id, turn.id)
      if (record.contextCompacting) {
        record.contextCompacting = false
        try { this.saveRecord(session); this.emit_(record.id, { type: 'session.updated', session: record }) }
        catch (failure) { turn.failure ??= `Compaction status could not be recorded: ${String(failure)}` }
      }
      turn.abort.signal.removeEventListener('abort', turn.releasePrompt)
      // A handed-over turn leaves everything for the next server: the open
      // turn row, the lease row, the pending requests, the queue. Only the
      // in-memory turn is cleared, so shutdown does not wait on it.
      if (session.relayDetached) { session.turn = null; return }
      this.settlePending(session, 'cancelled')
      // The lease is released only once nothing of this turn can still write:
      // the agent reported the turn finished (or its process is verifiably
      // gone) and every Poise-served file operation returned.
      let freed = true
      // An agent that was asked and did not report back is not trusted with
      // the checkout; a failure before it was asked leaves it alone.
      // An agent that ended its own process (Claude does after a stop) has
      // its worker group verified gone, or is terminated when it asked for
      // that, before the lease can go. A stopped turn always terminates its
      // worker group: the agent's acknowledgement ends the turn, but only a
      // verified-dead group proves its shells, test runners and sleeps went
      // with it. The next prompt resumes the native session in a fresh group.
      // A guard end recycles its worker group like a stop: the turn ended
      // without the runtime verifying the native turn is gone.
      if (turn.stopping || terminate || turn.guardEnd !== undefined || (agentInvoked && session.adapter && (!agentSettled || !session.adapter.alive)) || (session.relay && !session.relay.healthy)) {
        try { await this.stopProcess(session) } catch { freed = false }
      }
      session.draining = true
      if (!(await this.waitForServices(session, SERVICE_SETTLE_MS))) {
        // The agent is not letting go; end it. A Poise-side file operation
        // that is already executing cannot be cancelled by that, so the
        // checkout stays held until every service has actually returned
        // (each is bounded: capped reads, atomic writes, single uploads).
        try { await this.stopProcess(session) } catch { freed = false }
        await this.waitForServices(session, Number.POSITIVE_INFINITY)
      }
      if (lease?.held && this.bootstrapStillRunning(session, lease)) freed = false
      if (checkoutBefore && agentInvoked && lease?.held && freed) {
        try { await emitCheckoutChanges(record.checkout, turn.id, checkoutBefore, event => this.emit_(record.id, event)) }
        catch (failure) {
          try { this.emit_(record.id, { type: 'error', recoverable: true,
            message: `Checkout change capture failed: ${failure instanceof Error ? failure.message : String(failure)}. Native tool records remain available.` }) } catch { /* mirror */ }
        }
      }
      if (session.staged && lease?.held) {
        const report = await writeBackDocument(record.checkout, session.staged, record.id).catch((e) => ({ kind: 'conflict' as const, message: `document write-back failed: ${e instanceof Error ? e.message : String(e)}` }))
        if (report.kind !== 'unchanged' && report.kind !== 'missing') this.saveRecord(session) // revision/version moved
        if (isBridgeProblem(report)) { try { this.emit_(record.id, { type: 'error', message: report.message, recoverable: true }) } catch { /* mirror */ } }
      }
      // A storage/protocol failure uses cancellation to stop native work,
      // but it is not a user Stop. Keep its cause visible in Chat and Caller.
      if (turn.failure && !turn.stopping) { stopReason = 'error'; error = turn.failure }
      // A steer the agent never ran is queued before the terminal record,
      // so a completed turn arms it like any other waiting message. Only a
      // normally finished turn defers: a stopped or failed turn drops them.
      if (stopReason === 'end_turn' && unrunSteers?.length) {
        try { this.deferUnrunSteers(session, turn, unrunSteers) } catch (failure) {
          const reason = failure instanceof Error ? failure.message : String(failure)
          this.emit('log', `[chat] unrun steers could not be queued: ${reason}`)
          try { this.emit_(record.id, { type: 'error', message: `A steered message never ran and could not be queued as a follow-up (${reason}). Send it again as a new message.`, recoverable: true }) } catch { /* mirror */ }
        }
      }
      let terminalRecorded = false
      const durationMs = Date.now() - turn.startedAt
      try {
        const envelope = storage.finalizeTurn(record.id,
          { type: 'turn.finished', turnId: turn.id, stopReason, error, usage, durationMs, ...(stopReason === 'cancelled' && turn.stoppedBy ? { stoppedBy: turn.stoppedBy } : {}) },
          turn.callId ? { callId: turn.callId, instance: this.instance } : undefined,
          freed && !turn.stopping && !this.stopped && !session.lifecycle.signal.aborted)
        terminalRecorded = true
        record.lastSeq = envelope.seq
        this.emit('event', envelope)
        chatTurnFinished(alertContext(record), { id: turn.id, stopReason, durationMs,
          ...(turn.source?.kind === 'timer' ? { timer: true as const } : {}) })
      } catch (failure) {
        // Preserve the open turn on storage failure; do not acknowledge a
        // ledger result whose recovery record was never made durable.
        this.emit('log', `[chat] terminal outcome could not be published: ${failure instanceof Error ? failure.message : String(failure)}`)
      }
      session.turn = null
      if (terminalRecorded && turn.callId && this.caller) {
        const outcome = storage.listFinishOutbox(this.instance).find(row => row.callId === turn.callId)
        try {
          if (outcome) await this.caller.finish(turn.callId, outcome.status, outcome.error ? this.options.extensions?.redact(outcome.error) ?? outcome.error : undefined)
          storage.finishDelivered(turn.callId)
        } catch (e) {
          try { this.emit_(record.id, { type: 'error', message: `Caller did not record the turn end (it will be retried when Poise restarts): ${e instanceof Error ? e.message : String(e)}`, recoverable: true }) } catch { /* mirror */ }
        }
      }
      if (lease?.held) {
        if (freed) { lease.clearWorker(); lease.release() }
        else { try { this.emit_(record.id, { type: 'error', message: 'the checkout stays locked: the agent process could not be stopped', recoverable: false }) } catch { /* mirror */ } }
      }
      if (lease && session.lease === lease && !lease.held) session.lease = null
      // A fork learns its native id from the agent's first frames.
      if (session.adapter?.nativeSessionId && session.adapter.nativeSessionId !== record.nativeSessionId) {
        record.nativeSessionId = session.adapter.nativeSessionId
        this.saveRecord(session)
      }
      await this.refreshWorkspace(session).catch(() => undefined)
      // A failed turn shows an Error dot even though a live adapter idles the chat.
      record.lastStopReason = stopReason
      if (record.status !== 'closed') {
        if (!freed) this.setStatus(session, 'error', record.orphanNotice || 'the agent process could not be stopped')
        else if (session.adapter?.alive) this.setStatus(session, 'idle')
        // An agent that closed itself after a turn (Claude does after a stop,
        // so a queued interjection can never run) resumes on the next prompt.
        else if (stopReason === 'cancelled' || stopReason === 'end_turn') this.setStatus(session, 'idle', 'agent process closed after the turn; it resumes on the next prompt')
        else this.setStatus(session, 'interrupted')
      }
      this.armIdleTimer(session)
      // Last: the controller hears about a change only once its worker is
      // verifiably gone and the checkout is released above. Only the
      // implementing turn settles it; later discussion in the session does not.
      if (turn.implementsChange && record.selfChangeId) {
        try { await this.settleChange(session, { stopReason, error, freed, terminalRecorded }) }
        catch (failure) { this.emit('log', `[chat ${record.id.slice(0, 8)}] change settlement failed: ${failure instanceof Error ? failure.message : String(failure)}`) }
      }
      if (terminalRecorded) this.publishQueue(session)
      if (this.drainState) await this.closeForDrain(session).catch(() => undefined)
      else if (terminalRecorded && freed) this.scheduleQueue(session)
    }
  }

  /** The first prompt of a session carries its context (card, document,
   *  handoff) to the agent; the transcript records what the agent got. */
  private async composePrompt(session: LiveSession, input: PromptInput, isFirst: boolean): Promise<PromptInput> {
    const context = session.record.context
    if (isFirst && !context && session.record.importedFrom && session.turn) {
      const imported = storage.findEvent(session.record.id, (event) => event.type === 'history.imported')
      if (imported && imported.event.type === 'history.imported' && imported.event.turns.length) {
        session.turn.shown ??= { ...input }
        return { ...input, text: `${quoteImportedHistory(imported.event.turns, imported.event.omitted)}\n\n${input.text}` }
      }
      return input
    }
    if (!isFirst || !context) return input
    const parts: string[] = []
    if (context.kind === 'card') {
      parts.push(`[Context: ${context.title}]`)
      if (context.url) parts.push(context.url)
      if (context.headSha) parts.push(`Head: ${context.headSha}`)
      if (context.body) parts.push('', context.body)
    } else if (context.kind === 'document' && session.staged) {
      parts.push(stagedDocumentPrompt(session.staged, context.title))
    } else {
      return input // a handoff summary or a change runbook is the prompt itself
    }
    return { ...input, text: `${parts.join('\n')}\n\n${input.text}` }
  }

  /** Independent of the lifecycle chain: waiting on that chain would wait
   *  for the very turn the user is trying to steer to finish. */
  private control<T>(session: LiveSession, operation: () => Promise<T>): Promise<T> {
    const task = this.track(() => session.steering.then(operation, operation))
    session.steering = task.catch(() => undefined)
    return task
  }

  /** Permissions and merge delegation are independent session settings. */
  setSafeMode(id: string, enabled: boolean): Promise<SafeModeAck> {
    if (typeof enabled !== 'boolean') throw new ChatError(400, 'enabled must be a boolean', 'invalid')
    const session = this.requireLive(id)
    return this.control(session, async () => {
      if (!this.ownsSession(id)) throw new ChatError(404, 'unknown session', 'unknown_session')
      if (session.lifecycle.signal.aborted || session.record.status === 'closed') throw new ChatError(409, 'the session is closed', 'no_turn')
      const record = session.record
      const previous = { safeMode: record.safeMode, safeModePending: record.safeModePending }
      record.safeMode = enabled
      record.safeModePending = !!session.adapter && session.nativeSafeMode !== enabled
      try { this.saveRecord(session) } catch (error) { Object.assign(record, previous); throw error }
      // Old allow-always grants must not silently disable a newly enabled checkpoint.
      session.grants.clear()
      this.emit_(id, { type: 'session.updated', session: record })
      let applies: SafeModeAck['applies'] = 'next_turn'
      let warning: string | undefined
      if (session.adapter?.alive && !session.startup && !session.turn?.stopping && session.nativeSafeMode !== enabled) {
        try {
          applies = await session.adapter.setSafeMode?.(enabled) ?? 'next_turn'
          if (applies === 'current_turn') session.nativeSafeMode = enabled
        } catch (error) {
          warning = `Safe mode ${enabled ? 'on' : 'off'} is saved, but the native agent could not switch yet: ${error instanceof Error ? error.message : String(error)}. It will apply on the next turn; Stop remains available.`
        }
      } else if (session.nativeSafeMode === enabled && !session.startup) applies = 'current_turn'
      // No native process means there is nothing still running with an old policy.
      record.safeModePending = !!session.adapter && session.nativeSafeMode !== enabled
      if (record.safeModePending && !warning) warning = `${AGENT_LABEL[record.agent]} applies this permission change on the next turn. The current turn keeps its previous native permissions.`
      if (!this.ownsSession(id) || session.lifecycle.signal.aborted) throw new ChatError(409, 'the session closed while permissions were changing', 'no_turn')
      this.saveRecord(session)
      this.emit_(id, { type: 'session.updated', session: record })
      if (!enabled && session.turn && !session.turn.stopping) {
        for (const [requestId, pending] of session.pending) {
          const once = pending.kind === 'permission' && pending.options?.find(option => option.kind === 'allow_once')
          if (once) this.resolvePermission(session, requestId, once.id, 'unrestricted')
        }
      }
      return { session: this.withLive(record), applies, ...(warning ? { warning } : {}) }
    })
  }

  setAutoMerge(id: string, enabled: boolean): Promise<AutoMergeAck> {
    this.assertAcceptingWork()
    if (typeof enabled !== 'boolean') throw new ChatError(400, 'enabled must be a boolean', 'invalid')
    const session = this.requireLive(id)
    return this.control(session, async () => {
      if (!this.ownsSession(id)) throw new ChatError(404, 'unknown session', 'unknown_session')
      const previous = session.record.autoMerge
      if (previous === enabled) return { session: session.record, applies: 'next_turn' }
      session.record.autoMerge = enabled
      try { this.saveRecord(session) } catch (error) { session.record.autoMerge = previous; throw error }
      this.emit_(id, { type: 'session.updated', session: session.record })
      const turn = session.turn
      let applies: AutoMergeAck['applies'] = 'next_turn'
      let warning: string | undefined
      if (turn?.agentInvoked && !session.record.contextCompacting && !turn.stopping && !turn.abort.signal.aborted && session.adapter?.alive) {
        try {
          await session.adapter.steer(appendMemories(autoMergeInstructions(enabled, turn.implementsChange), readMemories().text))
          applies = 'current_turn'
        } catch (error) {
          warning = `Auto-merge ${enabled ? 'on' : 'off'} is saved for the next message, but the running agent could not receive the update: ${error instanceof Error ? error.message : String(error)}. Use Stop to end its current work.`
        }
      }
      // Merge delegation never overrides Safe mode or resolves its risk prompts.
      return { session: session.record, applies, ...(warning ? { warning } : {}) }
    })
  }

  async steer(id: string, text: string, context: Pick<PromptInput, 'attachments' | 'mentions'> = { attachments: [], mentions: [] }, actor?: ChatActor | PoiseActor): Promise<void> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    const turn = session.turn
    if (!turn || turn.stopping) throw new ChatError(409, 'no turn is running', 'no_turn')
    if (turn.contextAction === 'compact' || session.record.contextCompacting || session.record.contextResetting) throw new ChatError(409, 'Context maintenance is running; queue the next message.', 'turn_in_progress')
    const shown = this.validatePrompt(id, { text, attachments: context.attachments, mentions: context.mentions })
    // A chat's steer is literal text: no command parsing, no saved-switch
    // expansion. A leading /review, /reset or /model is delivered as plain
    // text, never run.
    const chain = actor ? null : parseCommands(shown.text)
    refuseManagerSwitch(chain?.switches, session.record.role === 'manager')
    refuseWorkerSwitch(chain?.switches, session.record.role === 'worker')
    if (chain && (chain.create || chain.queue || chain.context || chain.review || chain.model || chain.content !== undefined || chain.consensus !== undefined)) throw new ChatError(400, 'This command starts a separate action; queue it instead of steering.', 'invalid')
    // Do not put this wait on the control chain: startup drains that chain
    // before invoking the prompt. Early interjections belong after that boundary.
    if (!turn.agentInvoked) await this.track(() => turn.promptReady)
    await this.control(session, async () => {
      if (session.turn !== turn || !turn.agentInvoked || turn.stopping || turn.abort.signal.aborted) throw new ChatError(409, 'the turn has ended', 'no_turn')
      if (!session.record.capabilities.steer) throw new ChatError(409, `${AGENT_LABEL[session.record.agent]} does not support steering`, 'unsupported')
      await this.serve(session, async () => {
        const resolved = await this.resolveInput(session, shown)
        if (session.turn !== turn || session.draining || turn.stopping || turn.abort.signal.aborted) throw new ChatError(409, 'the turn has ended', 'no_turn')
        // A Poise actor's text is sent verbatim, with no chat header,
        // composed with origin 'source' below like any actor's.
        const composed = !actor ? expandSwitches(steeringContext({ ...resolved, text: chain!.text }), chain!.switches)
          : actor.kind === 'chat' ? steeringContext({ ...resolved, text: `${nativeSteerHeader(actor)}\n${shown.text}` })
            : steeringContext({ ...resolved, text: shown.text })
        const input = withAutoMergeInstructions({ ...resolved, text: composed }, session.record.autoMerge, turn.implementsChange, actor ? 'source' : 'person')
        const correlationId = randomUUID()
        await session.adapter!.steer(appendMemories(input.text, readMemories().text), { correlationId })
        // Kept for adapters that report unrun steers when the turn settles:
        // the original text (switches expanded, actor provenance kept) to
        // queue literally under a note, not the composed native text.
        const dispatchText = !actor ? expandSwitches(chain!.text, chain!.switches)
          : actor.kind === 'chat' ? `${nativeSteerHeader(actor)}\n${shown.text}`
            : shown.text
        turn.pendingSteers ??= new Map()
        turn.pendingSteers.set(correlationId, { text: dispatchText, attachments: shown.attachments, mentions: shown.mentions, ...(actor ? { actor } : {}) })
        this.emit_(id, { type: 'steer.sent', turnId: turn.id, text: shown.text,
          ...(shown.attachments.length ? { attachments: shown.attachments } : {}), ...(shown.mentions.length ? { mentions: shown.mentions } : {}), ...(actor ? { source: actor } : {}) })
      })
    })
  }

  /** Queue steers the agent accepted but never ran: one durable row per
   *  steer under a note, dispatched by the normal scheduler once this
   *  turn's completion arms the queue. */
  private deferUnrunSteers(session: LiveSession, turn: RunningTurn, ids: readonly string[]): void {
    const record = session.record
    const owner = queueOwner(record.id)
    const items: QueuedMessage[] = []
    for (const id of ids) {
      const pending = turn.pendingSteers?.get(id)
      if (!pending) { this.emit('log', `[chat] untracked steer ${id} was not queued`); continue }
      items.push({ id: randomUUID(), sourceSessionId: record.id,
        prompt: { text: `${UNRUN_STEER_NOTE}\n\n${pending.text}`, attachments: pending.attachments, mentions: pending.mentions },
        agent: record.agent, model: record.model, effort: record.effort, createdAt: new Date().toISOString(), state: 'waiting',
        ...(pending.actor ? { source: pending.actor } : {}) })
    }
    if (!items.length) return
    this.mutateQueue(session, () => {
      let queue: MessageQueue | undefined
      for (const item of items) queue = enqueueMessage(owner, item)
      return queue!
    })
  }

  /** Cancel the running turn. Stop ends the native turn and its whole
   *  process tree: when the agent does not settle within the stop target,
   *  its worker group is terminated (SIGTERM, then SIGKILL) and the turn's
   *  own cleanup runs with the adapter's rejection. Resolves with whether
   *  the turn ended — never by pretending it did. The person's Stop holds
   *  the chat, but only when it actually stopped a running turn or startup. */
  cancel(id: string, actor?: ChatActor | PersonActor): Promise<{ settled: boolean }> {
    return this.track(async () => {
      const session = this.requireLive(id)
      pauseQueue(queueOwner(id))
      const timer = this.queueTimers.get(id)
      if (timer) { clearTimeout(timer); this.queueTimers.delete(id) }
      this.queueReleaseWait.delete(id)
      this.publishQueue(session)
      const stoppingStartup = !!session.startup
      session.startup?.abort()
      const turn = session.turn
      if (actor?.kind === 'person' && (turn || stoppingStartup)) holdChat(this.instance, id, 'stopped', Date.now())
      if (!turn) {
        const deadline = Date.now() + STOP_SETTLE_MS
        while (session.startup && Date.now() < deadline) await delay(25)
        return { settled: !session.startup }
      }
      // A stop for an already-stopping turn is redundant: the person or chat
      // that stopped it first keeps the attribution.
      if (actor && !turn.stopping) turn.stoppedBy ??= actor
      // Durable: a restart before the turn settles must finish the stop,
      // never adopt the turn as if it was never stopped.
      session.record.stopRequestedTurnId = turn.id
      this.saveRecord(session)
      turn.stopping = true
      this.settlePending(session, 'cancelled')
      turn.abort.abort()
      try { await session.adapter?.cancel() } catch { /* the abort signal also reaches prompt() */ }
      if (await this.waitForTurnEnd(session, turn, STOP_SETTLE_MS)) return { settled: true }
      // The agent did not acknowledge: the process tree goes, verifiably,
      // and the turn's finally block then runs with the adapter's rejection.
      await this.stopProcess(session).catch(() => undefined)
      const settled = await this.waitForTurnEnd(session, turn, CLOSE_GRACE_MS * 2)
      if (!settled) this.setStatus(session, 'stopping', 'the agent has not acknowledged the stop yet')
      return { settled }
    })
  }

  /** Resolve once `turn` itself is gone from the session — finished, or
   *  replaced by a newer turn. Never follows the replacement: killing the
   *  worker of a turn that was never stopped would end innocent work. */
  private waitForTurnEnd(session: LiveSession, turn: RunningTurn, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    return new Promise((resolve) => {
      const check = () => {
        if (session.turn !== turn) resolve(true)
        else if (Date.now() >= deadline) resolve(false)
        else setTimeout(check, 25)
      }
      check()
    })
  }

  private async waitForServices(session: LiveSession, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (session.services > 0) {
      if (Date.now() >= deadline) return false
      await delay(25)
    }
    return true
  }

  // ── Requests from the agent ────────────────────────────────────────────

  respondPermission(id: string, requestId: string, optionId: string): void {
    this.resolvePermission(this.requireLive(id), requestId, optionId, 'user')
  }

  private resolvePermission(session: LiveSession, requestId: string, optionId: string, by: 'user' | 'auto_merge' | 'unrestricted'): void {
    const id = session.record.id
    const pending = session.pending.get(requestId)
    if (!pending || pending.kind !== 'permission') {
      // A request that outlived its process (crash, restart) is closed out
      // rather than left hanging in the transcript.
      if (storage.listPendingRequests(id).some((p) => p.requestId === requestId)) {
        this.emit_(id, { type: 'permission.resolved', id: requestId, optionId: '', by: 'cancelled' })
      }
      throw new ChatError(409, 'this permission request is no longer pending', 'no_turn')
    }
    const option = pending.options!.find((o) => o.id === optionId)
    if (!option) throw new ChatError(400, 'unknown option', 'invalid')
    // Keep the native waiter reachable until its decision is durable.
    this.emit_(id, { type: 'permission.resolved', id: requestId, optionId, by })
    session.pending.delete(requestId)
    // "Always" means this session, in Poise's memory — never the agent's own
    // persistence, which outlives the session. The agent is told "once".
    let onWire = optionId
    if (option.kind === 'allow_always' || option.kind === 'reject_always') {
      if (pending.grantKey) session.grants.set(pending.grantKey, { id: optionId, kind: option.kind })
      const once = pending.options!.find((o) => o.kind === (option.kind === 'allow_always' ? 'allow_once' : 'reject_once'))
      if (once) onWire = once.id
    }
    pending.resolve(onWire)
    this.afterRequestAnswered(session)
  }

  answerQuestion(id: string, requestId: string, answers: QuestionAnswers, actor?: ChatActor): { questions: Question[] } {
    const session = this.requireLive(id)
    const pending = session.pending.get(requestId)
    if (!pending || pending.kind !== 'question') {
      if (storage.listPendingRequests(id).some((p) => p.requestId === requestId)) {
        this.emit_(id, { type: 'question.answered', id: requestId, answers: {}, by: 'cancelled' })
      }
      throw new ChatError(409, this.firstAnswerMessage(id, requestId, actor), 'no_turn')
    }
    const validated = validateAnswers(pending.questions ?? [], answers)
    this.emit_(id, { type: 'question.answered', id: requestId, answers: validated, by: actor ? 'chat' : 'user', ...(actor ? { fromSession: actor.sessionId, source: actor } : {}) })
    session.pending.delete(requestId)
    pending.resolve(validated)
    this.afterRequestAnswered(session)
    return { questions: pending.questions ?? [] }
  }

  /** Who answered first, named relative to the caller: the actor, or the
   *  person when it is absent. A cancelled request, or one with no answer
   *  event, keeps the old message. */
  private firstAnswerMessage(id: string, requestId: string, actor?: ChatActor): string {
    const found = storage.findEvent(id, (event) => event.type === 'question.answered' && event.id === requestId)
    const event = found?.event
    if (!event || event.type !== 'question.answered' || event.by === 'cancelled') return 'this question is no longer pending'
    if (event.by === 'user') return actor ? 'this question was already answered by the person' : 'this question was already answered by you'
    const from = event.source?.sessionId ?? event.fromSession
    if (actor && from === actor.sessionId) return 'this question was already answered by you'
    if (event.source?.role === 'manager') return 'this question was already answered by the workspace Manager'
    return `this question was already answered by chat "${event.source?.title ?? event.fromSession ?? 'unknown'}"`
  }

  private afterRequestAnswered(session: LiveSession): void {
    if (session.turn && !session.turn.stopping && session.pending.size === 0 && session.record.status === 'waiting') this.setStatus(session, 'running')
  }

  private settlePending(session: LiveSession, by: 'cancelled'): void {
    for (const [requestId, pending] of session.pending) {
      session.pending.delete(requestId)
      try {
        this.emit_(session.record.id, pending.kind === 'permission'
          ? { type: 'permission.resolved', id: requestId, optionId: '', by }
          : { type: 'question.answered', id: requestId, answers: {}, by })
      } catch { /* mirror failure is handled by the turn */ }
      pending.reject(new Error('cancelled'))
    }
  }

  // ── Model, mode, revert ────────────────────────────────────────────────

  async setModel(id: string, identity: string, effortOverride?: string): Promise<SessionRecord> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    if (session.turn) throw new ChatError(409, 'Choose a model for the next task or change it between turns.', 'turn_in_progress')
    return this.serialized(session, async () => {
      if (session.turn) throw new ChatError(409, 'A turn started before the model could change.', 'turn_in_progress')
      if (session.record.status === 'closed' || session.lifecycle.signal.aborted) throw new ChatError(409, 'The session is closed.', 'no_turn')
      await this.selectSessionModel(session, identity, effortOverride)
      return session.record
    })
  }

  async setMode(id: string, mode: string): Promise<void> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    await this.serialized(session, async () => {
      if (session.turn) throw new ChatError(409, 'change the mode between turns', 'turn_in_progress')
      if (!session.adapter?.alive) await this.startSession(session)
      if (!session.record.capabilities.modes) throw new ChatError(409, `${AGENT_LABEL[session.record.agent]} sessions have no modes`, 'unsupported')
      await session.adapter!.setMode(mode)
      session.record.mode = mode
      this.saveRecord(session)
    })
  }

  async revert(id: string, diffId: string): Promise<void> {
    this.assertAcceptingWork()
    const session = this.requireLive(id)
    const found = storage.findEvent(id, (e) => e.type === 'diff' && e.diffId === diffId)
    if (!found || found.event.type !== 'diff') throw new ChatError(404, 'unknown change', 'invalid')
    const diff: RecordedDiff = found.event
    await this.serialized(session, async () => {
      if (session.turn) throw new ChatError(409, 'revert after the turn finishes', 'turn_in_progress')
      const lease = this.leaseFor(session)
      try {
        await lease.acquire({ signal: session.lifecycle.signal, onBusy: (busy) => this.reportBusy(session, busy) })
        const state = await inspectCheckout(session.record.checkout)
        if (state.currentBranch !== session.record.branch.name) {
          throw new GitError(`the checkout is on ${state.currentBranch}, not ${session.record.branch.name}; switch back before reverting`, 'branch_drift')
        }
        await revertDiff(lease, session.record.checkout, diff)
        this.emit_(id, { type: 'diff.reverted', diffId, path: diff.path, ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.emit_(id, { type: 'diff.reverted', diffId, path: diff.path, ok: false, error: message })
        throw new ChatError(409, message, 'checkout_dirty')
      } finally {
        if (lease.held) lease.release()
        await this.refreshWorkspace(session).catch(() => undefined)
      }
    })
  }

  // ── Checkout and branch ────────────────────────────────────────────────

  private leaseFor(session: LiveSession): CheckoutLease {
    const record = session.record
    return new CheckoutLease(record.checkout, {
      ownerKind: 'poise:chat',
      ownerId: record.id,
      ownerLabel: `chat "${record.title}" on ${record.branch.name} (Poise ${this.options.instanceLabel})`,
      instance: this.instance,
      branch: record.branch.name,
    }, this.leaseProbes)
  }

  private async leaseForStartup(session: LiveSession, signal: AbortSignal): Promise<CheckoutLease> {
    const root = this.options.localWorkspaceRoot ?? LOCAL_CHAT_ROOT
    const ref = session.record.workspaceKind === 'poise-local' ? workerWorkspaceRef(root, session.record.checkout) : null
    while (true) {
      signal.throwIfAborted()
      if (ref) await ensureWorkerWorkspaceDirectory(root, ref.id)
      try { return this.leaseFor(session) }
      catch (error) {
        // A maintenance holder can remove the placeholder before realpath.
        // Only this validated managed path may be recreated and retried.
        if (!ref || (error as { code?: unknown })?.code !== 'ENOENT') throw error
      }
    }
  }

  private reportBusy(session: LiveSession, busy: Extract<AcquireResult, { acquired: false }>): void {
    const label = describeHolder(busy.holder) + (busy.orphan ? ' — its worker is still running' : '')
    if (session.record.queuedBehind !== label || session.record.status !== 'queued') {
      session.record.queuedBehind = label
      this.setStatus(session, 'queued', label)
    }
  }

  /** Take one of the shared check slots, FIFO per lane. A turn that waits
   *  shows `queued` with the cap's own reason; cancelling the turn wakes it.
   *  A turn the person sent takes the person lane, which background work
   *  cannot fill; delegated, supervised and timer turns share the background
   *  lane with behavior runs. Lowering the cap converges as running turns
   *  release; raising it starts waiters through localTurnCapChanged. */
  private async acquireLocalTurnSlot(session: LiveSession, turn: RunningTurn): Promise<void> {
    const person = !turn.source || (turn.source.kind === 'poise' && turn.source.name === SWITCHBOARD_PERSON)
    turn.localSlot = await this.checkSlots.acquire(person ? 'person' : 'background', {
      signal: turn.abort.signal,
      onQueued: () => {
        session.record.queuedBehind = SLOT_WAIT_REASON
        this.setStatus(session, 'queued')
      },
      abortError: () => new Error(turn.failure || 'cancelled before it started'),
    })
  }

  private releaseLocalTurnSlot(turn: RunningTurn): void {
    turn.localSlot?.()
    turn.localSlot = undefined
  }

  /** Count an adopted turn against the local cap without parking it
   *  behind the waiters: the turn already runs, so admission control
   *  must not delay its visibility. Survivors take precedence — new
   *  turns wait until they release — even past a lowered cap. */
  private claimSurvivorSlot(turn: RunningTurn): void {
    const person = !turn.source || (turn.source.kind === 'poise' && turn.source.name === SWITCHBOARD_PERSON)
    turn.localSlot = this.checkSlots.claim(person ? 'person' : 'background')
  }

  /** The cap setting changed: start every slot waiter that now fits, in order. */
  localTurnCapChanged(): void {
    this.checkSlots.grant()
  }

  /** A closed session whose scratch workspace storage maintenance removed
   *  resumes in a fresh one; the transcript survives in the database.
   *  Anything but a missing workers/<id>/workspace still fails loud. The
   *  initializer reuses the held checkout lease without a release gap. */
  private async recreateRemovedWorkspace(session: LiveSession, lease: CheckoutLease): Promise<boolean> {
    const record = session.record
    if (record.workspaceKind !== 'poise-local') return false
    const root = this.options.localWorkspaceRoot ?? LOCAL_CHAT_ROOT
    const ref = workerWorkspaceRef(root, record.checkout)
    if (!ref) return false
    let recreated = true
    try {
      const metadata = await lstat(join(record.checkout, '.git'))
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        // A failed bootstrap may have written HEAD without its first commit.
        recreated = !(await runFile('git', ['rev-parse', '--verify', 'HEAD'], { cwd: record.checkout, expected: { codes: [128], stderr: /Needed a single revision/ } }).then(() => true, () => false))
      }
    }
    catch (error) {
      if ((error as { code?: unknown })?.code !== 'ENOENT') throw error
    }
    await ensureWorkerWorkspace(root, ref.id, this.instance, lease)
    if (recreated) this.emit_(record.id, { type: 'status.changed', status: record.status, detail: 'storage maintenance had removed this workspace after the session closed; starting fresh' })
    return recreated
  }

  /** Fresh session: cut/verify/check out its branch under the lease. */
  private async prepareBranch(session: LiveSession, lease: CheckoutLease): Promise<void> {
    const record = session.record
    const checkout = record.checkout
    if (record.branch.origin === 'pr') {
      await this.makeCheckoutSwitchable(session, lease)
      record.branch.name = await checkoutPrHead(lease, checkout, record.branch.pr!)
      this.saveRecord(session)
      return
    }
    if (record.branch.origin === 'existing') {
      if (!(await branchExists(checkout, record.branch.name))) throw new GitError(`branch ${record.branch.name} does not exist in ${checkout}`, 'invalid')
      return
    }
    const state = await inspectCheckout(checkout)
    record.branch.baseSha = await createBranch(lease, checkout, record.branch.name, state.defaultBranch)
    this.saveRecord(session)
  }

  /** The checkout must be on the session's branch before the agent runs.
   *  The outgoing session's uncommitted work is committed on its own
   *  branch; a dirty checkout on a branch no session owns is refused by name. */
  private async prepareCheckout(session: LiveSession, lease: CheckoutLease): Promise<void> {
    const record = session.record
    const state = await inspectCheckout(record.checkout)
    if (state.currentBranch !== record.branch.name) {
      await this.makeCheckoutSwitchable(session, lease)
      await switchBranch(lease, record.checkout, record.branch.name)
    }
    lease.setBranch(record.branch.name)
    await this.restorePrunedWorkspace(session)
  }

  /** Reinstall what storage maintenance pruned from an idle scratch
   *  workspace. Best-effort: a failure never stops the turn, and the agent
   *  reinstalls whatever is still missing. */
  private async restorePrunedWorkspace(session: LiveSession): Promise<void> {
    if (session.record.workspaceKind !== 'poise-local') return
    try {
      const restored = await restorePrunedArtifacts(session.record.checkout, this.options.localWorkspaceRoot ?? LOCAL_CHAT_ROOT)
      if (restored.length) {
        this.emit_(session.record.id, { type: 'status.changed', status: session.record.status, detail: `storage maintenance had pruned ${restored.join(', ')} while idle; reinstalled` })
      }
    } catch (error) {
      console.error(`[chat] reinstalling pruned artifacts failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async makeCheckoutSwitchable(session: LiveSession, lease: CheckoutLease): Promise<void> {
    const record = session.record
    const state = await inspectCheckout(record.checkout)
    if (!state.dirty) return
    const owner = storage.listSessions(this.instance).find((s) => s.checkout === record.checkout && s.branch.name === state.currentBranch && s.status !== 'closed')
      // A session's own scratch workspace holds only its own agent's work —
      // even on a branch the agent cut itself, which no session row names.
      // Checkpointing it here keeps the chat's ownership of its checkout
      // across a restart that stranded its turn, instead of wedging resume
      // on work nobody else could have written.
      ?? (record.workspaceKind === 'poise-local'
        && workerWorkspaceRef(this.options.localWorkspaceRoot ?? LOCAL_CHAT_ROOT, record.checkout)?.id === record.id ? record : undefined)
    if (!owner) {
      throw new GitError(`the checkout at ${record.checkout} has ${state.dirtyFiles} uncommitted change(s) on ${state.currentBranch || 'a detached HEAD'}, which no chat session owns; commit or stash them yourself`, 'dirty_unowned')
    }
    const result = await checkpoint(lease, record.checkout, state.currentBranch)
    if (result.committed) {
      // Only the branch that received the checkpoint stops being
      // provisional: a self-checkpoint lands on the agent's own branch,
      // not on the session's recorded one.
      if (owner.branch.name === state.currentBranch) {
        const ownerLive = this.live.get(owner.id)
        if (ownerLive) {
          ownerLive.record.branch.provisional = false
          this.saveRecord(ownerLive)
        } else {
          owner.branch.provisional = false
          storage.saveSession(owner)
        }
      }
      // A checkpoint on a detached HEAD belongs to no branch: without a
      // reference it would dangle once the switch below moves away. Only
      // self-ownership reaches here on a detached HEAD (no session names
      // ''), so the session keeps it on a branch. Each checkpoint gets its
      // own branch, named for its commit: reusing one stable name would
      // force-move it off the earlier checkpoint and leave that saved work
      // recoverable only through reflogs.
      let retained = ''
      if (!state.currentBranch && owner.id === record.id && result.sha) {
        const name = `poise/checkpoint/${record.id.slice(0, 8)}-${result.sha.slice(0, 12)}`
        await moveBranch(lease, record.checkout, name, result.sha)
        retained = ` (kept on branch ${name})`
      }
      this.emit_(record.id, { type: 'status.changed', status: session.record.status, detail: `checkpointed ${owner.title}'s changes on ${state.currentBranch || 'a detached HEAD'}${retained}` })
    }
  }

  private async refreshWorkspace(session: LiveSession): Promise<void> {
    try {
      const state = await inspectCheckout(session.record.checkout)
      const workspace: WorkspaceState = {
        currentBranch: state.currentBranch,
        onBranch: state.currentBranch === session.record.branch.name,
        dirty: state.dirty,
        dirtyFiles: state.dirtyFiles,
        checkedAt: new Date().toISOString(),
      }
      session.record.workspace = workspace
      this.saveRecord(session)
    } catch { /* not a git checkout yet; the header shows nothing */ }
  }

  // ── Process and host ───────────────────────────────────────────────────

  private hostFor(session: LiveSession): AdapterHost {
    const record = session.record
    const contextSeq = record.contextResetSeq || 0
    const currentContext = () => contextSeq === (record.contextResetSeq || 0)
    const requireContext = () => { if (!currentContext()) throw new Error('This native conversation was reset.') }
    return {
      sessionId: record.id,
      checkout: record.checkout,
      spawn: async (command, args, options) => {
        requireContext()
        const launchPath = command === 'codex' ? session.cliCheck?.result.launchPath : undefined
        return this.spawnAgent(session, launchPath || command, args, options?.env)
      },
      emit: (event) => {
        // A handed-over turn's emissions are link-death artifacts: the
        // agent never saw them, and replay re-derives from the spool what
        // its bytes produced. Recording them would duplicate the replay.
        if (!currentContext() || session.record.status === 'closed' || session.relayDetached) return
        // Native compaction chatter is maintenance, not a new assistant reply.
        if (session.record.contextCompacting && (event.type === 'text.delta' || event.type === 'thought.delta')) return
        try {
          this.emit_(record.id, event)
        } catch (error) {
          // An unrecorded transcript is not a transcript: the turn stops.
          const turn = session.turn
          if (turn && !turn.failure) {
            turn.failure = `the transcript could not be recorded: ${error instanceof Error ? error.message : String(error)}`
            turn.abort.abort()
            void session.adapter?.cancel()
          }
        }
      },
      requestPermission: async (request) => { requireContext(); return this.askPermission(session, request) },
      askQuestion: async (request) => { requireContext(); return this.askUser(session, request) },
      readTextFile: async (path, options) => { requireContext(); return this.serve(session, () => readCheckoutTextFile(record.checkout, path, options)) },
      writeTextFile: async (path, content) => { requireContext(); return this.serve(session, () => writeCheckoutTextFile(record.checkout, path, content)) },
      log: (message) => this.emit('log', `[chat ${record.id.slice(0, 8)}] ${message}`),
    }
  }

  /** Poise-served file operations run only for a turn that holds the
   *  checkout lease on the session's branch; anything else is refused. */
  private async serve<T>(session: LiveSession, operation: () => Promise<T>): Promise<T> {
    const turn = session.turn
    if (!turn || turn.stopping || turn.abort.signal.aborted || session.draining) throw new Error('no turn is running; file services are closed')
    if (!session.lease?.held) throw new Error('the checkout lease is not held; file services are closed')
    // Admission, including its branch check, is part of the service lifetime.
    session.services += 1
    try {
      const head = await runFile('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: session.record.checkout, timeoutMs: 10_000, expected: { codes: [1] } }).then((r) => r.stdout.trim()).catch(() => '')
      if (head !== session.record.branch.name) throw new Error(`the checkout is on ${head || 'a detached HEAD'}, not ${session.record.branch.name}; file services are closed`)
      if (session.turn !== turn || turn.stopping || turn.abort.signal.aborted || session.draining || !session.lease?.held) throw new Error('the turn is settling; file services are closed')
      return await operation()
    } finally {
      session.services -= 1
    }
  }

  private relayRoot(): string {
    if (this.options.relayDir) return this.options.relayDir
    const db = process.env.POISE_DB && process.env.POISE_DB !== ':memory:'
      ? process.env.POISE_DB
      : join(homedir(), '.poise', 'cache.db')
    return join(dirname(db), 'chat-relays')
  }

  /** Start the agent under its per-session relay and return the peer the
   *  adapter talks through. The relay survives this server, so a restart
   *  hands the running turn to the next server instead of stopping it. */
  private async spawnAgent(session: LiveSession, command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<AgentProcess> {
    if (session.lifecycle.signal.aborted || session.startup?.signal.aborted || session.turn?.abort.signal.aborted) throw new Error('agent startup was cancelled')
    if (session.relay && (session.relay.healthy || pgidAlive(session.relay.gatePgid) || pidAlive(session.relay.gatePid))) throw new Error('the session already has a worker')
    const record = session.record
    const lease = session.lease
    if (!lease?.held) throw new Error('the checkout lease is not held; the agent cannot start')
    // The Claude SDK asks for `node <wrapper>`: scrub by the wrapper's name.
    const envCommand = record.agent === 'codex' && command === session.cliCheck?.result.launchPath ? 'codex'
      : command === process.execPath && args[0] ? basename(args[0]) : undefined
    const dir = relayDirFor(this.relayRoot(), record.id)
    const gateIdent = randomUUID()
    const peer = await spawnRelay({
      sessionId: record.id,
      dir,
      command,
      args,
      env: scrubbedChildEnvironment(envCommand ?? command, env, args),
      cwd: record.checkout,
      gateIdent,
      ...(this.options.relayScripts ? { relayScript: this.options.relayScripts.relay, gateScript: this.options.relayScripts.gate } : {}),
      log: (message) => this.emit('log', `[chat ${record.id.slice(0, 8)}] ${message}`),
    })
    session.relay = peer
    const startedAt = new Date().toISOString()
    storage.recordWorker({
      sessionId: record.id,
      gatePid: peer.gatePid,
      gatePgid: peer.gatePgid,
      ident: gateIdent,
      checkout: record.checkout,
      leaseToken: lease.currentToken,
      command,
      startedAt,
    })
    storage.recordRelay({
      sessionId: record.id,
      relayPid: peer.relayPid,
      relayIdent: peer.ident,
      socket: peer.socketPath,
      dir,
      startedAt,
    })
    this.trackRelayExit(session, peer)
    // Registered before GO: nothing runs unregistered.
    if (!lease.registerWorker({ pid: peer.gatePid, pgid: peer.gatePgid, ident: gateIdent })) {
      await this.stopRelay(session, peer)
      throw new Error('the checkout lease was lost before the agent could start')
    }
    try {
      await peer.go()
    } catch (error) {
      try { await this.stopRelay(session, peer) } catch (shutdownError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; agent shutdown failed: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`, { cause: error })
      }
      throw error
    }
    return peer
  }

  private trackRelayExit(session: LiveSession, peer: RelayConnection): void {
    const worker = storage.getWorker(session.record.id)
    // An adopted socket can close before the dying relay PID disappears,
    // reporting null codes like a detach. Ownership, not codes, guards handoff.
    peer.once('exit', (code, signal) => {
      const settle = () => {
        if (this.stopped || session.relayDetached || session.relay !== peer || this.live.get(session.record.id) !== session) return
        // The separate gate can outlive the relay. Observe its eventual exit
        // without giving up ownership, and never erase a successor's rows.
        if ((code === null && signal === null && pidAlive(peer.relayPid))
          || pgidAlive(peer.gatePgid) || pidAlive(peer.gatePid)) {
          setTimeout(settle, 25).unref()
          return
        }
        if (storage.getWorker(session.record.id)?.ident !== worker?.ident
          || storage.getRelay(session.record.id)?.relayIdent !== peer.ident) return
        session.relay = null
        storage.forgetWorker(session.record.id)
        storage.forgetRelay(session.record.id)
      }
      settle()
    })
  }

  private onAdapterExit(session: LiveSession, adapter: Adapter, code: number | null, signal: NodeJS.Signals | null): void {
    if (session.adapter !== adapter) return
    if (session.record.status === 'closed') return
    const turn = session.turn
    try {
      if (turn && !turn.stopping) {
        this.emit_(session.record.id, { type: 'error', message: `${AGENT_LABEL[session.record.agent]} exited (${code ?? signal ?? 'unknown'}) during the turn`, recoverable: true })
      }
      if (!turn) this.setStatus(session, 'interrupted', `${AGENT_LABEL[session.record.agent]} exited (${code ?? signal ?? 'unknown'})`)
    } catch { /* mirror */ }
  }

  /** Close the adapter and shut the relay down, verifying the agent's
   *  process group is gone. On failure the relay stays recorded, the
   *  session says so, and the error propagates so no caller releases the
   *  checkout. Never runs for a handed-over turn: the next server owns
   *  that relay now. */
  private async stopProcess(session: LiveSession): Promise<void> {
    if (session.relayDetached) return
    const adapter = session.adapter
    session.adapter = null
    if (adapter) { try { await adapter.close() } catch { /* terminating below */ } }
    const relay = session.relay
    if (!relay) {
      // Recovery can own a verified worker after its relay probe failed.
      // Close/resume/server-stop must settle that worker before releasing it.
      const recorded = storage.getWorker(session.record.id)
      if (!recorded) return
      try {
        if (!session.lease?.held || this.recoveryWorkerOwnedElsewhere(recorded)) {
          throw new Error('the recorded worker is not owned by this server')
        }
        if (!(await workerIdentityMatches(recorded.gatePid, recorded.ident))) {
          if (pgidAlive(recorded.gatePgid) || pidAlive(recorded.gatePid)) {
            throw new Error('the recorded worker is still running but could not be verified')
          }
        } else if (!(await this.terminateRecordedWorker(recorded, session.record))) {
          throw new Error(`worker group ${recorded.gatePgid} is still alive after shutdown`)
        }
        storage.forgetWorker(session.record.id)
        const stale = storage.getRelay(session.record.id)
        storage.forgetRelay(session.record.id)
        if (stale) await rm(stale.dir, { recursive: true, force: true })
      } catch (error) {
        session.record.orphanNotice = error instanceof Error ? error.message : String(error)
        this.saveRecord(session)
        try { this.emit_(session.record.id, { type: 'error', message: session.record.orphanNotice, recoverable: false }) } catch { /* mirror */ }
        throw error
      }
      return
    }
    await this.stopRelay(session, relay)
  }

  private async stopRelay(session: LiveSession, relay: RelayConnection): Promise<void> {
    try {
      await relay.shutdown()
      if (pgidAlive(relay.gatePgid) || pidAlive(relay.gatePid)) {
        throw new Error(`worker group ${relay.gatePgid} is still alive after shutdown`)
      }
    } catch (error) {
      session.record.orphanNotice = error instanceof Error ? error.message : String(error)
      this.saveRecord(session)
      try { this.emit_(session.record.id, { type: 'error', message: session.record.orphanNotice, recoverable: false }) } catch { /* mirror */ }
      throw error
    }
    if (session.relay === relay) session.relay = null
    storage.forgetWorker(session.record.id)
    storage.forgetRelay(session.record.id)
    await rm(relay.dir, { recursive: true, force: true }).catch(() => undefined)
  }

  /** Publishing a native request is part of its admission. If it cannot be
   * recorded, stop only that turn; leave the entry for normal cancellation
   * cleanup so a partially recorded request also receives its terminal event. */
  private publishPendingRequest(session: LiveSession, turn: RunningTurn, requestId: string,
    event: Extract<ChatEvent, { type: 'permission.requested' | 'question.asked' }>): void {
    try {
      this.emit_(session.record.id, event)
      this.setStatus(session, 'waiting')
      chatWaiting(alertContext(session.record), event.type === 'permission.requested'
        ? { kind: 'permission', title: event.title }
        : { kind: 'question', question: event.questions[0]?.question ?? 'answer a question' })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      session.pending.get(requestId)?.reject(failure)
      if (session.turn !== turn) return
      turn.failure ??= `the agent request could not be recorded: ${failure.message}`
      turn.abort.abort()
      void session.adapter?.cancel().catch(reason => this.emit('log', `[chat] cancellation failed: ${String(reason)}`))
    }
  }

  private async askPermission(session: LiveSession, request: PermissionRequest): Promise<string> {
    const turn = session.turn
    if (!turn || turn.stopping) throw new Error('no turn is running')
    if (request.signal?.aborted) throw new Error('permission is no longer pending')
    const grantKey = `${request.title}\0${canonicalJson(request.input)}`
    const granted = session.grants.get(grantKey)
    const requestId = randomUUID()
    const remembered = granted ? request.options.find(option => option.id === granted.id && option.kind === granted.kind) : undefined
    if (granted && remembered && (remembered.kind === 'allow_always' || remembered.kind === 'reject_always')) {
      const onWire = request.options.find((o) => o.kind === (remembered.kind === 'reject_always' ? 'reject_once' : 'allow_once'))
      this.emit_(session.record.id, { type: 'permission.requested', id: requestId, turnId: turn.id, toolId: request.toolId, title: request.title, description: request.description, input: request.input, options: request.options })
      this.emit_(session.record.id, { type: 'permission.resolved', id: requestId, optionId: granted.id, by: 'session' })
      return onWire?.id ?? granted.id
    }
    if (granted) session.grants.delete(grantKey) // Native choices changed: never reinterpret an old decision.
    const once = session.record.safeMode !== true && request.options.find(option => option.kind === 'allow_once')
    if (once) {
      this.emit_(session.record.id, { type: 'permission.requested', id: requestId, turnId: turn.id, toolId: request.toolId, title: request.title, description: request.description, input: request.input, options: request.options })
      this.emit_(session.record.id, { type: 'permission.resolved', id: requestId, optionId: once.id, by: 'unrestricted' })
      return once.id
    }
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => request.signal?.removeEventListener('abort', superseded)
      const superseded = () => {
        if (!session.pending.delete(requestId)) return
        cleanup()
        // The native request is already obsolete. Always release its waiter,
        // even if its cancellation cannot be recorded; never throw from an
        // AbortSignal listener and crash the server with an unanswered promise.
        reject(new Error('permission is no longer pending'))
        try {
          this.emit_(session.record.id, { type: 'permission.resolved', id: requestId, optionId: '', by: 'cancelled' })
          this.afterRequestAnswered(session)
        } catch (error) {
          const message = `the withdrawn permission could not be recorded: ${error instanceof Error ? error.message : String(error)}`
          this.emit('log', `[chat ${session.record.id.slice(0, 8)}] ${message}`)
          if (session.turn === turn) {
            turn.failure ??= message
            turn.abort.abort()
            void session.adapter?.cancel().catch(failure => this.emit('log', `[chat] cancellation failed: ${String(failure)}`))
          }
        }
      }
      session.pending.set(requestId, { kind: 'permission', turnId: turn.id, options: request.options, grantKey,
        resolve: value => { cleanup(); resolve(value) }, reject: error => { cleanup(); reject(error) } })
      request.signal?.addEventListener('abort', superseded, { once: true })
      this.publishPendingRequest(session, turn, requestId, { type: 'permission.requested', id: requestId, turnId: turn.id, toolId: request.toolId, title: request.title, description: request.description, input: request.input, options: request.options })
    })
  }

  private async askUser(session: LiveSession, request: QuestionRequest): Promise<QuestionAnswers> {
    const turn = session.turn
    if (!turn || turn.stopping) throw new Error('no turn is running')
    const requestId = randomUUID()
    return new Promise<QuestionAnswers>((resolve, reject) => {
      session.pending.set(requestId, { kind: 'question', turnId: turn.id, questions: request.questions, resolve, reject })
      this.publishPendingRequest(session, turn, requestId, { type: 'question.asked', id: requestId, turnId: turn.id, toolId: request.toolId, questions: request.questions })
    })
  }

  private armIdleTimer(session: LiveSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    const minutes = this.idleTimeoutMinutes()
    if (!Number.isFinite(minutes) || minutes <= 0) return
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      if (session.turn || !session.adapter) return
      void this.serialized(session, async () => {
        if (session.turn) return
        await this.stopProcess(session)
        this.emit_(session.record.id, { type: 'status.changed', status: 'idle', detail: 'agent process closed after idle timeout; it resumes on the next prompt' })
      }).catch(() => undefined)
    }, minutes * 60_000)
    session.idleTimer.unref()
  }

  // ── Events ─────────────────────────────────────────────────────────────

  private setStatus(session: LiveSession, status: SessionStatus, detail?: string): void {
    if (session.record.status === 'waiting' && status !== 'waiting') chatWaitingEnded(session.record.id)
    session.record.status = status
    if (status !== 'queued') session.record.queuedBehind = undefined
    this.saveRecord(session)
    this.emit_(session.record.id, { type: 'status.changed', status, queuedBehind: session.record.queuedBehind, detail })
  }

  private saveRecord(session: LiveSession): void {
    session.record.updatedAt = new Date().toISOString()
    storage.saveSession(session.record)
  }

  /** Record what the native process runs with, and tell the chat once
   *  about every switched-on server it does not have. */
  private reportExtensions(session: LiveSession, set: { servers: ResolvedServer[], notices: string[], fingerprint: string }, skipped: readonly Skipped[], pending: boolean): void {
    session.nativeExtensions = pending ? undefined : set.fingerprint
    this.options.extensions!.delivered(session.record, set, skipped)
    const notices = [...set.notices, ...skipped.map(skippedNotice)]
    const shown = notices.join('\n')
    if (shown && shown !== session.extensionNotices) {
      for (const message of notices) this.emit_(session.record.id, { type: 'error', message, recoverable: true })
    }
    session.extensionNotices = shown
  }

  /** Record why a guard ended a turn: a transcript notice the person can
   *  read, a structured diagnostic, and the server log. Never a stop. */
  private recordTurnNote(session: LiveSession, turn: RunningTurn, note: string, detail: Record<string, unknown> = {}): void {
    try { this.emit_(session.record.id, { type: 'error', message: `[Poise] ${note}`, recoverable: true }) } catch { /* mirror */ }
    diagnostic({ level: 'warning', operation: 'chat.turn.guard', target: turn.id, message: note,
      context: { sessionId: session.record.id, turnId: turn.id, agent: session.record.agent, ...detail } })
    this.emit('log', `[chat ${session.record.id.slice(0, 8)}] ${note}`)
  }

  /** Command identity for the no-op guard: kind, title and input. Titles
   *  can be truncated (Claude caps Bash titles at 200 characters), so the
   *  input carries what the title drops. */
  private noOpCommand(kind: ToolKind, title: string, input: unknown): string {
    const args = input === undefined ? '' : createHash('sha256').update(JSON.stringify(input) ?? '').digest('hex')
    return [kind, title, args].join(' ')
  }

  /** A completed tool's result hash: status and result text. Byte-identical
   *  by design: a result that changes (CI pending → success) is new work,
   *  while a volatile output (ticking durations) fails open — the guard
   *  does not fire on it. */
  private noOpOutput(event: Extract<ChatEvent, { type: 'tool.finished' }>): string {
    const parts: string[] = []
    for (const block of event.content ?? []) {
      if (block.type === 'terminal') parts.push(`terminal:${block.exitCode ?? ''}:${block.text}`)
      else if (block.type === 'text') parts.push(`text:${block.text}`)
      else parts.push(`diff:${block.path}:${block.oldText}:${block.newText}`)
    }
    return `${event.status} ${createHash('sha256').update(parts.join(' ')).digest('hex')}`
  }

  /** End a worker turn stuck polling the same no-op checks: consecutive
   *  completions where each command returns what it returned last time,
   *  with no edits and no diffs. The turn settles as end_turn with the
   *  reason recorded — the model has nothing left but waiting, and Poise
   *  wakes it on change. */
  private noOpGuard(sessionId: string, event: ChatEvent): void {
    if (event.type !== 'tool.started' && event.type !== 'tool.finished' && event.type !== 'diff') return
    const session = this.live.get(sessionId)
    if (!session || session.record.role !== 'worker') return
    const turn = session.turn
    if (!turn || turn.id !== event.turnId || turn.stopping || turn.abort.signal.aborted || turn.guardEnd) return
    const state = turn.noOp ??= { open: new Map(), lastOutput: new Map(), repeats: 0 }
    if (event.type === 'diff') { state.repeats = 0; return }
    if (event.type === 'tool.started') {
      state.open.set(event.id, { kind: event.kind, title: event.title, ...(event.input === undefined ? {} : { input: event.input }) })
      if (event.kind === 'edit') state.repeats = 0
      return
    }
    const open = state.open.get(event.id)
    state.open.delete(event.id)
    const kind = open?.kind ?? 'other'
    if (kind === 'edit') { state.repeats = 0; return }
    // Unchanged is per command: the same check returning what it returned
    // last time. A new command or a changed result is activity, so an
    // alternation between two outputs never trips.
    const command = this.noOpCommand(kind, open?.title ?? '', open?.input)
    const output = this.noOpOutput(event)
    if (state.lastOutput.get(command) !== output) {
      state.lastOutput.set(command, output)
      state.repeats = 0
      return
    }
    state.repeats += 1
    if (state.repeats < WORKER_NOOP_REPEAT_LIMIT) return
    const reason = `the turn repeated the same no-op checks ${WORKER_NOOP_REPEAT_LIMIT} times (${kind}: ${open?.title ?? event.id}) with unchanged results and no edits; Poise ended it. The turn resumes on its next wake.`
    turn.guardEnd = reason
    this.recordTurnNote(session, turn, reason, { repeats: state.repeats })
    turn.abort.abort()
    void session.adapter?.cancel().catch(() => undefined)
    void this.guardWatchdog(session, turn)
  }

  /** If a guard-ended turn does not settle — a lost interrupt leaves the
   *  prompt pending — its worker group is terminated like any stopped
   *  turn, so a hung cancel cannot hold the check slot. Never touches a
   *  replacement turn. */
  private async guardWatchdog(session: LiveSession, turn: RunningTurn): Promise<void> {
    if (await this.waitForTurnEnd(session, turn, STOP_SETTLE_MS)) return
    if (session.turn !== turn) return
    await this.stopProcess(session).catch(() => undefined)
    if (await this.waitForTurnEnd(session, turn, CLOSE_GRACE_MS * 2)) return
    this.emit('log', `[chat ${session.record.id.slice(0, 8)}] guard-ended turn ${turn.id.slice(0, 8)} did not settle after its worker group was terminated`)
  }

  /** Append to the mirror, then broadcast. Throws when the mirror cannot be
   *  written; callers that run on the agent's behalf turn that into a stop. */
  private emit_(sessionId: string, event: ChatEvent): ChatEnvelope {
    if (event.type === 'session.created' || event.type === 'session.resumed' || event.type === 'session.updated') {
      event = { ...event, session: this.withLive(event.session) }
    }
    if (this.options.extensions) event = this.options.extensions.scrub(event)
    const envelope = storage.appendEvent(sessionId, event)
    const live = this.live.get(sessionId)
    if (live) live.record.lastSeq = envelope.seq
    this.emit('event', envelope)
    this.noOpGuard(sessionId, event)
    return envelope
  }

  /** For Swarm and Stop: the session and turn behind a Caller call id. */
  describeTurn(callId: string): { sessionId: string, turnId: string, events: Array<{ at: string, message: string }> } | null {
    for (const record of storage.listSessions(this.instance)) {
      const started = storage.findEvent(record.id, (e) => e.type === 'turn.started' && e.callId === callId)
      const open = storage.getOpenTurn(record.id)
      const turnId = started?.event.type === 'turn.started' ? started.event.turnId : open?.callId === callId ? open.turnId : null
      if (!turnId) continue
      const { events } = storage.listEvents(record.id, 0)
      const summary = events
        .filter((e) => 'turnId' in e.event && (e.event as any).turnId === turnId && (e.event.type === 'tool.started' || e.event.type === 'turn.finished' || e.event.type === 'permission.requested'))
        .slice(-40)
        .map((e) => ({ at: e.at, message: e.event.type === 'tool.started' ? `${e.event.kind}: ${e.event.title}` : e.event.type === 'permission.requested' ? `waiting for permission: ${e.event.title}` : `turn ${(e.event as any).stopReason}` }))
      return { sessionId: record.id, turnId, events: summary }
    }
    return null
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function defaultProbeAgent(agent: AgentId): Promise<{ ok: boolean, reason?: string }> {
  const command = AGENT_COMMAND[agent]
  try {
    await runFile(command, ['--version'], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 })
    return { ok: true }
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ok: false, reason: `${command} is not installed on the PATH the server runs with` }
    return { ok: false, reason: `${command} --version failed: ${String(error?.stderr || error?.message || error).trim().slice(0, 200)}` }
  }
}

function normalizeBranchRequest(branch: BranchRequest, prefix: string): { name: string, origin: 'new' | 'existing' | 'pr', pr?: number } {
  if (!branch || typeof branch !== 'object') throw new ChatError(400, 'branch is required', 'invalid')
  if ('pr' in branch) {
    const pr = Number(branch.pr)
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new ChatError(400, 'pr must be a positive integer', 'invalid')
    return { name: `github-interface-pr-${pr}`, origin: 'pr', pr }
  }
  if ('existing' in branch) {
    try { return { name: assertBranchName(branch.existing), origin: 'existing' } } catch (error) { throw new ChatError(400, (error as Error).message, 'invalid') }
  }
  if ('new' in branch) {
    const raw = String(branch.new || '').trim()
    const name = raw.includes('/') || raw.startsWith(prefix) ? raw : `${prefix}${raw}`
    try { return { name: assertBranchName(name), origin: 'new' } } catch (error) { throw new ChatError(400, (error as Error).message, 'invalid') }
  }
  throw new ChatError(400, 'branch must be { new }, { existing } or { pr }', 'invalid')
}

function validateAnswers(questions: Question[], answers: unknown): QuestionAnswers {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new ChatError(400, 'answers must be an object', 'invalid')
  const input = answers as Record<string, unknown>
  const out: QuestionAnswers = {}
  for (const question of questions) {
    const value = input[question.id]
    if (value === undefined) throw new ChatError(400, `question "${question.question}" was not answered`, 'invalid')
    const labels = new Set(question.options.map((o) => o.label))
    if (question.multiSelect) {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length <= 2_000)) throw new ChatError(400, 'multi-select answers must be an array of strings', 'invalid')
      if (!question.freeText && !value.every((v) => labels.has(v))) throw new ChatError(400, 'an answer is not one of the offered options', 'invalid')
      out[question.id] = value
    } else {
      if (typeof value !== 'string' || value.length > 2_000) throw new ChatError(400, 'an answer must be a string', 'invalid')
      if (!question.freeText && !labels.has(value)) throw new ChatError(400, 'an answer is not one of the offered options', 'invalid')
      out[question.id] = value
    }
  }
  return out
}

function changeIdConflict(): ChatError {
  return new ChatError(409, 'this change id was already used for a different request or session; start the request again', 'invalid')
}

/** The implementing turn of a change session is its first turn; its
 *  terminal event, if any, is the change's outcome — later discussion is not. */
function implementingTurnOutcome(sessionId: string): { started: boolean, finished: Extract<ChatEvent, { type: 'turn.finished' }> | null } {
  let cursor = 0
  let turnId: string | null = null
  while (turnId === null) {
    const page = storage.listEvents(sessionId, cursor)
    for (const { event } of page.events) {
      if (event.type === 'turn.started') { turnId = event.turnId; break }
    }
    if (turnId !== null || !page.truncated || !page.events.length) break
    cursor = page.events[page.events.length - 1].seq
  }
  if (turnId === null) return { started: false, finished: null }
  const found = storage.findEvent(sessionId, (e) => e.type === 'turn.finished' && e.turnId === turnId)
  return { started: true, finished: found?.event.type === 'turn.finished' ? found.event : null }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Muse rejects resuming a session whose reasoning was encrypted for a
 *  previous credential holder (OAuth login vs API key). The native session
 *  is unresumable; the chat restarts it fresh from a transcript summary. */
function isStaleMuseCaller(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('encrypted_content') && message.includes('was not issued to this caller')
}

/** Recursive canonical form: nested input keys count, so two commands that
 *  differ below the top level never share a permission grant. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as any)[key])}`).join(',')}}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitDead(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (pgidAlive(pgid)) {
    if (Date.now() >= deadline) return false
    await delay(50)
  }
  return true
}

export function emptyCapabilities() {
  return { steer: false, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: false, questions: false, resume: false, images: false }
}

export type { SessionContext }
