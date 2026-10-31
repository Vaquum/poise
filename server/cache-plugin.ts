import { noticeEvidence, behaviorEvidence } from './notification-evidence'
import { addDiagnosticSecrets, startLogging, stopLogging } from './logging'
import { localLogging, stopLoggingApi } from './logging-api'
import { startBehaviorLedger, stopBehaviorLedger } from './behavior-ledger'
import { handleBehaviorLedger } from './behavior-ledger-http'
import { handleBehaviorPrStatus } from './behavior-pr-status'
import { handleJevApi, stopJev } from './jev/api'
import type { Plugin, Connect } from 'vite'
import type { ServerResponse } from 'node:http'
import { agentAccount, callerAccounts, getModelSettings, getSettings, seedAgentAccount, setSettings, SettingsConflictError } from './settings'
import { handleBehaviorChains } from './behavior-chain-api'
import { MODEL_PLACES, canaryClaudeModel, loadCatalog, placeProviders, readCatalogReport, resolvePlace, resolveSlots } from './models'
import { refreshModelCatalog } from './models-refresh'
import { deleteModelPreset, listModelPresets, saveModelPreset } from './model-presets'
import { claudeAuth, type ClaudeAuthCheckOptions, type ClaudeAuthSnapshot, type ClaudeAuthStatus } from './claude-auth'
import { accountsChecked, claudeAuthStatusChanged, startLedgerHealthRuntime, stopLedgerHealthRuntime } from './alerts/producers'
import { pruneAlerts } from './alerts/store'
import { HANDLED_READ_LIMIT, listHandling, pruneHandling } from './alerts/handling'
import { checkNotices, dismissNotice, noticesState, silenceNotice, startNoticesRuntime, stopNoticesRuntime } from './alerts/notices'
import { startTemporaryStorageRuntime, stopTemporaryStorageRuntime } from './temporary-storage'
import { recordRunningRelease, runningRelease } from './running-release'
import { LinkApi } from './link/api'
import { getCallerReleaseHealth } from './caller-release'
import { getProductionUpdateHealth } from './production-update'
import { listCards, createCard, setCardText, setCardRepo, moveCard, removeCard, type Lane } from './current'
import { parseBounds, parseWindow, readAnalytics, readAnalyticsHistory } from './analytics'
import { checkGithubQuota, readGithubQuota, startGithubQuotaRuntime, stopGithubQuotaRuntime } from './github-quota'
import { dependencySnapshot, livenessSnapshot } from './health'
import { handleGhBody, listOrgRepos, listOrganizationsRepos, selectOrganizations, repoBelongsTo, requireConfiguredRepository } from './gh'
import { handlePullRequestApprove, handlePullRequestMerge } from './pull-requests'
import { getOrganizations, readyOrganizations, addOrganization, retryOrganization, removeOrganization, startOrganizationsRuntime, stopOrganizationsRuntime } from './organizations'
import { startAgentCollaboratorRuntime, stopAgentCollaboratorRuntime } from './agent-collaborator'
import { fetchAgentLogs, fetchAgentLogSnapshot, fetchAgentResponse, fetchAgentReasoning, fetchSelectedAgentLogSnapshot, fetchRunningAgentLogSnapshot, fetchAgentLogPage, fetchAgentLogById, triggerPrReview, replayAgentJob, stopAgentJob } from './agent'
import { readBehaviorMetrics } from './behavior-metrics'
import { readBehaviorEstimates } from './behavior-estimates'
import { listCapabilities } from './capabilities'
import { runDebate } from './chat'
import { listDocs, readDoc, writeDoc, deleteDoc, newSlug, readAnnotations, writeAnnotations, MAX_DOC_BYTES, MAX_ANNOTATIONS_BYTES, EditorConflictError } from './editor'
import { handleSnippetApi } from './snippet-api'
import { handlePublishingApi } from './publishing-api'
import { startPublicationReviewsRuntime, stopPublicationReviewsRuntime } from './publishing-reviews'
import { createExtensionsApi } from './extensions/http'
import { runtimeExtensions } from './extensions/delivery'
import { redactSecrets, secretValues } from './extensions/store'
import { workspaceOf } from './extensions/types'
import { listSessions } from './chat/storage'
import { handleGoogleApi } from './google/api'
import { validateGoogleEnvironment } from './google/accounts'
import { getBehaviorDiagnosticIncidents } from './behaviors'
import { setEnabled as setBehaviorEnabled, setSetting as setBehaviorSetting, setScratchpad as setBehaviorScratchpad, setReviewers as setBehaviorReviewers, setReviewCap as setBehaviorReviewCap, getEnabledMap, getSettingMap, getScratchpadMap, getReviewers, getReviewCap, getBehaviorsRuntimeHealth, isValidSetting, isValidReviewers, isValidReviewCap, isPanelBehavior, getIssueRepositories, setIssueRepositories, isValidRepository, getIssueAuthors, setIssueAuthors, isValidAuthorList, isSkippableBehavior, isValidRepositoryList, getRepositorySkips, setRepositorySkips, MAX_SKIPPED_REPOSITORIES, admitReplay, ReplayRefusedError, startBehaviorsRuntime, stopBehaviorsRuntime, getResolveUnblockingLastFired, getMergePrsLastFired, getGreyCiLastFired, getGreyCiLastSucceeded, setPaused as setBehaviorPaused, getPausedUntil as getBehaviorPausedUntil, getPausedBy as getBehaviorPausedBy, BEHAVIOR_KEYS, type BehaviorKey } from './behaviors'
import { startReviewCheckoutPruning, stopReviewCheckoutPruning } from './review-checkout'
import { maintenanceRunning, runStorageMaintenanceOnce, startStorageMaintenanceRuntime, stopStorageMaintenanceRuntime, storageStatus } from './storage-maintenance'
import { ContentLaunchPendingError, contentLaunchIdForCall, getContentJobResponse, getContentLaunchResponse, launchAndEnqueueContentJob, startContentFinalizer, stopContentFinalizer } from './content-jobs'
import { ProcessLockError } from './process-lock'
import { retryFailedPrReviews, setBehaviorCheckSlots } from './behaviors'
import { setWorkerChatReader } from './worker-capacity'
import { bindings as workBindings } from './chat/control-store'
import { enforceApiRequest, httpStatus, readJson, setApiHeaders, type RequestAuthority } from './http'
import { ChatRuntime } from './chat/runtime'
import { ChatControl, CHAT_CONTROL_PATH } from './chat/control'
import { ChatSocketServer, handleChatApi, speaksForPerson } from './chat/transport'
import { Switchboard } from './chat/switchboard'
import { getChatSettings } from './settings'
import { buildIdentity } from './build-identity'
import { setCallerAccounts } from './process'
import { SelfUpdateService, createSelfUpdateBridge, drainAllowsPath, handleSelfUpdateApi, handleSelfUpdateTurnedOff, isSelfUpdateControlRoute, resolveSelfUpdateRoot, unconfiguredSelfUpdateBridge, type SelfUpdateBridge } from './self-update'
import { releaseBackgroundPaused } from './release-background'
import { applyServiceEnvironment, readServiceConfig, type ServiceConfig } from './service/config'
import { DRAINING_ERROR, ServiceControl, handleServiceApi } from './service/control'
import { countDebate } from './service/caller-calls'
import { DailyModelRefresh } from './service/model-refresh'
import { CLAUDE_BROWSER_LOGIN_OFF, SELF_UPDATE_OFF, SERVICE_MODE_CODE, productionUpdaterOff } from './service/turned-off'
import { invalidateAccounts, listAccounts, scheduleAccountsCheck } from './accounts'
import { accountLogins, recordLogin } from './accounts/logins'
import { connectGitHubAccount, onboardingState, updateOnboarding } from './service/onboarding'
import { isAccountId, type AccountId, type ConnectedAccount } from './accounts/types'
import { randomUUID } from 'node:crypto'
import { ChatError } from './chat/runtime'
import { TerminalSocketServer } from './terminal/server'
import type { TerminalCommand } from './terminal/pty'
import type { TerminalPreset } from './terminal/protocol'
import type { Server } from 'node:http'

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export interface CachePluginOptions {
  /** REVIEW_AGENT_USERNAME: seeds the agent account (Settings → GitHub) on
   *  the first start without one saved, and is ignored after that. */
  reviewAgentUsername?: string
  /** Additional hostnames allowed to access the local API. */
  allowedHosts?: string[]
  /** Auth runtime override for isolated integration tests. */
  claudeAuth?: ClaudeAuthRuntime
  /** What a Connect terminal runs for a preset. Omitted: the CLI's own login;
   *  tests confine it to their fake CLIs. */
  terminalCommand?: (preset: TerminalPreset) => TerminalCommand
  /** Which Poise server this is; chat sessions are owned per instance and
   *  the dev and production servers never adopt each other's. */
  instanceLabel?: 'dev' | 'production'
  /** The self-update controller client. Omitted: resolved from
   *  POISE_SELF_UPDATE_ROOT / the production default root. `null`: never
   *  configured (tests). */
  selfUpdateBridge?: SelfUpdateBridge | null
  /** Service mode. Omitted: read from the environment; `null`: off. */
  service?: ServiceConfig | null
}

// Chat v1: one runtime per server process. Sessions are keyed by instance
// (`poise-<label>:<db path>`), so the same database file never hosts two
// servers' sessions and two different databases never mix.
let chatRuntime: ChatRuntime | null = null
let chatControl: ChatControl | null = null
let chatSwitchboard: Switchboard | null = null
let chatSockets: ChatSocketServer | null = null
let terminalSockets: TerminalSocketServer | null = null
// Service mode only: Connected accounts read on a schedule, for their alerts.
let stopAccountsCheck: (() => void) | null = null
let selfUpdate: SelfUpdateService | null = null
// Service mode only: the gateway's drain. The in-process daily model check
// runs in service mode and on the personal production server.
let serviceControl: ServiceControl | null = null
let dailyModelRefresh: DailyModelRefresh | null = null
// What paired Poise Link devices read: snippets, alerts and the event stream.
let linkApi: LinkApi | null = null
const handleExtensionsApi = createExtensionsApi({
  recentWorkspaces: () => chatRuntime ? listSessions(chatRuntime.instance).map(workspaceOf) : [],
})

function serviceOf(opts: CachePluginOptions): ServiceConfig | null {
  return opts.service === undefined ? readServiceConfig() : opts.service
}

export function getChatRuntime(): ChatRuntime {
  if (!chatRuntime) throw new Error('the chat runtime is not started')
  return chatRuntime
}

/** Refuse an unknown or foreign Chat session before anything launches. */
function requireChatSession(runtime: ChatRuntime | null, id: string): void {
  if (!runtime) throw new ChatError(503, 'the chat runtime is not started', 'agent_error')
  if (!runtime.get(id)) throw new ChatError(404, 'unknown session', 'unknown_session')
}

const CONSENSUS_SYNTHESIS_MAX_BYTES = 64 * 1024

/** Cut a synthesis to 64 KiB at a character boundary, stating the cut. */
function cutSynthesis(synthesis: string): { synthesis: string, truncated: boolean } {
  const text = String(synthesis ?? '')
  if (Buffer.byteLength(text, 'utf8') <= CONSENSUS_SYNTHESIS_MAX_BYTES) return { synthesis: text, truncated: false }
  let end = Math.min(text.length, CONSENSUS_SYNTHESIS_MAX_BYTES)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > CONSENSUS_SYNTHESIS_MAX_BYTES) {
    const over = Buffer.byteLength(text.slice(0, end), 'utf8') - CONSENSUS_SYNTHESIS_MAX_BYTES
    end -= Math.max(1, Math.floor(over / 4))
  }
  let cut = text.slice(0, end)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return { synthesis: cut, truncated: true }
}

export function getSelfUpdateService(): SelfUpdateService {
  if (!selfUpdate) throw new Error('the chat runtime is not started')
  return selfUpdate
}

/** Stop the in-process daily model check. The production server stands its
 *  own scheduler down when the legacy launchd job it replaces survives, so
 *  the two can never both fire; the next restart retries the retirement. */
export function stopDailyModelRefresh(): void {
  dailyModelRefresh?.stop()
}

/** Serve /ws/chat and /ws/terminal on an HTTP server (production server or
 *  Vite's). */
export function attachChatSockets(server: Server): void {
  if (!chatSockets || !terminalSockets) throw new Error('the chat runtime is not started')
  chatSockets.attach(server)
  chatControl?.attach(server)
  terminalSockets.attach(server)
}

export interface ClaudeAuthRuntime {
  start(): void
  stop(): Promise<void>
  snapshot(): ClaudeAuthSnapshot
  startLogin(): ClaudeAuthSnapshot
  check(options?: ClaudeAuthCheckOptions): Promise<ClaudeAuthSnapshot>
  /** Calls `listener` with each new status; returns the unsubscribe. */
  onStatus(listener: (status: ClaudeAuthStatus) => void): () => void
}

// Each running auth monitor, with the unsubscribe of the alert it raises.
const activeClaudeAuthRuntimes = new Map<ClaudeAuthRuntime, () => void>()

export function startPoiseRuntime(opts: CachePluginOptions = {}): void {
  // First: a malformed seed stops the start before anything is running.
  seedAgentAccount(opts.reviewAgentUsername)
  const service = serviceOf(opts)
  validateGoogleEnvironment(!!service)
  if (service) applyServiceEnvironment()
  startLogging()
  void startBehaviorLedger()
  const auth = opts.claudeAuth ?? claudeAuth
  if (!activeClaudeAuthRuntimes.has(auth)) activeClaudeAuthRuntimes.set(auth, auth.onStatus(claudeAuthStatusChanged))
  auth.start()
  pruneAlerts()
  pruneHandling()
  recordRunningRelease()
  setCallerAccounts(callerAccounts)
  startOrganizationsRuntime()
  startAgentCollaboratorRuntime()
  startBehaviorsRuntime()
  startNoticesRuntime()
  startPublicationReviewsRuntime()
  startGithubQuotaRuntime()
  startLedgerHealthRuntime()
  if (service) startTemporaryStorageRuntime()
  startReviewCheckoutPruning()
  startStorageMaintenanceRuntime()
  startContentFinalizer()
  if (!chatRuntime) {
    const label = opts.instanceLabel ?? 'dev'
    // The self-update controller is separately installed; without a root
    // (development, tests) the bridge is inert and `/poise` says so. Service
    // mode never talks to one.
    const bridge = service
      ? unconfiguredSelfUpdateBridge()
      : opts.selfUpdateBridge === undefined
        ? createSelfUpdateBridge({ root: resolveSelfUpdateRoot(label) })
        : opts.selfUpdateBridge ?? unconfiguredSelfUpdateBridge()
    chatRuntime = new ChatRuntime({
      instance: `poise-${label}:${process.env.POISE_DB || 'default'}`,
      instanceLabel: label,
      idleTimeoutMinutes: () => getChatSettings().idleTimeoutMinutes,
      branchPrefix: () => getChatSettings().branchPrefix,
      maxConcurrentLocalTurns: () => getChatSettings().maxConcurrentLocalTurns,
      selfUpdate: bridge,
      controlContext: id => {
        if (!chatControl) throw new Error('the native chat control is not started')
        return chatControl.context(id)
      },
      extensions: runtimeExtensions,
    })
    setBehaviorCheckSlots(chatRuntime.checkSlots)
    setWorkerChatReader(() => {
      const runtime = chatRuntime
      if (!runtime) return { running: 0, hasManager: false, boundTargets: [] }
      const sessions = runtime.list()
      return {
        running: sessions.filter((session) => session.role === 'worker' && session.status !== 'closed').length,
        hasManager: sessions.some((session) => session.role === 'manager'),
        boundTargets: workBindings(runtime.instance).map((binding) => binding.target),
      }
    })
    // Before recovery, so it sees the turns a restart cut.
    chatSwitchboard = new Switchboard(chatRuntime)
    chatControl = new ChatControl(chatRuntime, { switchboard: chatSwitchboard })
    addDiagnosticSecrets(secretValues)
    chatRuntime.on('log', (line: string) => console.log(redactSecrets(line)))
    chatSockets = new ChatSocketServer(chatRuntime, { allowedHosts: opts.allowedHosts, service }, chatSwitchboard, chatControl)
    terminalSockets = new TerminalSocketServer({ allowedHosts: opts.allowedHosts, service }, { command: opts.terminalCommand })
    // A login may have just changed an account. Claude's sign-in also gates
    // Claude-backed work, so it is verified now instead of at the next poll.
    terminalSockets.on('exit', (preset, code) => {
      invalidateAccounts()
      // Accounts and setup share completed logins in both local and service mode.
      recordLogin(preset, code)
      if (preset === 'claude') void auth.check({ forceLive: true })
    })
    if (service) {
      serviceControl = new ServiceControl(chatRuntime, { drainTimeoutSeconds: service.drainTimeoutSeconds, switchTurnBoundMinutes: () => getChatSettings().updateTurnBoundMinutes })
      stopAccountsCheck = scheduleAccountsCheck(checkAccounts)
    } else {
      selfUpdate = new SelfUpdateService(chatRuntime, bridge)
    }
    // The daily model check runs inside the server wherever the server is the
    // installation — service mode and the personal production server — at
    // 07:00 in the timezone saved in Settings. A dev server never schedules
    // one.
    if (service || label === 'production') {
      dailyModelRefresh = new DailyModelRefresh({
        timeZone: () => getSettings().timezone,
        refresh: refreshModelCatalog,
        paused: releaseBackgroundPaused,
      })
      dailyModelRefresh.start()
    }
    void chatRuntime.recover().then(() => { chatControl?.start(); chatSwitchboard?.start() }).catch((error: unknown) => {
      console.error('[chat] startup reconciliation failed:', error)
      chatControl?.failStart(error)
    })
  }
  if (!linkApi) linkApi = new LinkApi({ service })
}

export async function stopPoiseRuntime(): Promise<void> {
  const authStops = [...activeClaudeAuthRuntimes].map(([auth, unwatch]) => {
    unwatch()
    return auth.stop()
  })
  activeClaudeAuthRuntimes.clear()
  const chatStop = chatRuntime?.stop() ?? Promise.resolve()
  const controlStop = chatControl?.stop(chatStop) ?? Promise.resolve()
  const switchboardStop = chatSwitchboard?.stop() ?? Promise.resolve()
  const socketStop = chatSockets?.close() ?? Promise.resolve()
  const terminalStop = terminalSockets?.close() ?? Promise.resolve()
  stopAccountsCheck?.()
  stopAccountsCheck = null
  selfUpdate?.reset()
  serviceControl?.reset()
  dailyModelRefresh?.stop()
  // Open event streams and long polls would otherwise hold the server open.
  linkApi?.close()
  setCallerAccounts(null)
  chatRuntime = null
  chatControl = null
  chatSwitchboard = null
  chatSockets = null
  terminalSockets = null
  selfUpdate = null
  serviceControl = null
  dailyModelRefresh = null
  linkApi = null
  await Promise.all([stopOrganizationsRuntime(), stopAgentCollaboratorRuntime(), stopBehaviorsRuntime(), stopNoticesRuntime(), stopPublicationReviewsRuntime(), stopGithubQuotaRuntime(), stopLedgerHealthRuntime(), stopTemporaryStorageRuntime(), stopReviewCheckoutPruning(), stopStorageMaintenanceRuntime(), stopContentFinalizer(), stopJev(), controlStop, switchboardStop, chatStop, socketStop, terminalStop, ...authStops])
  await stopBehaviorLedger()
  await stopLoggingApi()
  await stopLogging()
}

/** Connected accounts, read now or from the last few seconds, with their
 *  sign-in alerts recorded. */
async function checkAccounts(id?: AccountId): Promise<ConnectedAccount[]> {
  const accounts = await listAccounts(id)
  accountsChecked(accounts, { me: getSettings().me, agentAccount: agentAccount() })
  return accounts
}

export function createPoiseMiddleware(opts: CachePluginOptions = {}): Connect.NextHandleFunction {
      const service = serviceOf(opts)
      startPoiseRuntime({ ...opts, service })
      const auth = opts.claudeAuth ?? claudeAuth
      return async (req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/api/')) return next()
        // A mutating request counts towards release readiness from before
        // the drain gate until its handler has actually finished — not until
        // the response closed, since a client can disconnect while a
        // handler's writes are still settling. The controller's own
        // readiness/drain/resume calls are the one exemption.
        const path = url.split('?')[0]
        const mutating = req.method !== 'GET' && req.method !== 'HEAD'
        const release = selfUpdate && mutating && !isSelfUpdateControlRoute(path) ? selfUpdate.beginApiWrite() : null
        // Releases due once the handler has finished: a service-mode launch
        // counts as work from its drain check until then.
        const finished: Array<() => void> = []
        try {
          return await handleApi(req, res, next, url, path, mutating, finished)
        } catch (error) {
          return json(res, httpStatus(error, 400), { error: (error as Error).message })
        } finally {
          release?.()
          for (const done of finished) done()
        }
      }

      async function handleApi(req: Parameters<Connect.NextHandleFunction>[0], res: ServerResponse, next: Connect.NextFunction, url: string, path: string, mutating: boolean, finished: Array<() => void>): Promise<void> {
        setApiHeaders(res)
        const selectedOrg = new URLSearchParams(url.split('?')[1] || '').get('org') || undefined
        let authority: RequestAuthority
        try {
          authority = enforceApiRequest(req, { allowedHosts: opts.allowedHosts, service })
        } catch (err) {
          return json(res, httpStatus(err, 403), { error: (err as Error).message })
        }
        if (path === '/api/behavior-ledger/pr-status') {
          return handleBehaviorPrStatus(req, res, url)
        }
        if (path === '/api/behavior-ledger' || path.startsWith('/api/behavior-ledger/')) {
          return handleBehaviorLedger(req, res, url)
        }
        if (path === '/api/logging' || path.startsWith('/api/logging/')) {
          if (service) return json(res, 404, { error: 'logging_not_available_here', message: 'Use the gateway Logging API for environment history.' })
          return localLogging(req, res)
        }
        if (req.method === 'OPTIONS') {
          return json(res, 405, { error: 'cross-origin preflight is not supported' })
        }
        // Liveness answers 200 whenever the process does, in both modes and
        // while draining: it performs no I/O, so no dependency can slow it.
        if (url === '/api/health/live' && req.method === 'GET') {
          return json(res, 200, livenessSnapshot())
        }
        if (path === CHAT_CONTROL_PATH) {
          if (!chatControl) return json(res, 503, { error: 'native chat control is not started' })
          return chatControl.handle(req, res)
        }

        // ── Service mode: the gateway's endpoints, the self-update routes
        // that do not exist here, and the drain's refusal of new launches ──
        if (service) {
          if (!serviceControl) throw new Error('the service runtime is not started')
          if (path === '/api/service' || path.startsWith('/api/service/')) return handleServiceApi(req, res, path, authority, serviceControl)
          if (path === '/api/self-update' || path.startsWith('/api/self-update/')) {
            return handleSelfUpdateTurnedOff(req, res, path, SELF_UPDATE_OFF, SERVICE_MODE_CODE)
          }
          const launch = serviceControl.admitLaunch(req.method, path)
          if (launch === 'draining') return json(res, 503, { error: DRAINING_ERROR, code: 'draining' })
          if (launch) finished.push(launch)
        }

        // ── /api/link/* — what a paired Poise Link reads (server/link) ──
        if (path.startsWith('/api/link/')) {
          if (!linkApi) throw new Error('the Link API is not started')
          return linkApi.handle(req, res, url)
        }

        // ── Self-update: the controller's private endpoints and the public
        // status/revert, ahead of the drain gate they are exempt from ──
        if (selfUpdate && (path === '/api/self-update' || path.startsWith('/api/self-update/'))) {
          if (await handleSelfUpdateApi(req, res, url, selfUpdate)) return
        }
        // Every other mutating request is refused once the controller drains
        // this server, except the few that settle work (cancel, close, stop).
        // It was registered before this check, so a request that was in
        // before the drain is never missed by readiness.
        if (selfUpdate && mutating && selfUpdate.draining && !drainAllowsPath(path)) {
          return json(res, 503, { error: DRAINING_ERROR, code: 'draining' })
        }

        if (await handleJevApi(req, res, url)) return
        if (path === '/api/behavior-chains') return handleBehaviorChains(req, res, url)

        if (url === '/api/health' && req.method === 'GET') {
          const scheduler = getBehaviorsRuntimeHealth()
          const claudeAuthState = auth.snapshot()
          const [callerRelease, production] = await Promise.all([
            getCallerReleaseHealth(),
            service ? productionUpdaterOff() : getProductionUpdateHealth(),
          ])
          const organizations = getOrganizations()
          const requiresClaude = () => {
            const enabled = getEnabledMap()
            return enabled['review-new-prs'] || enabled['approve-prs'] || enabled['review-new-issues']
          }
          const claudeBackedEnabled = requiresClaude()
          const healthy = scheduler.status === 'ok'
            && (!claudeBackedEnabled || claudeAuthState.status === 'authenticated')
            && callerRelease.status !== 'invalid'
            && !organizations.some((org) => org.status === 'error' || org.error)
          // `production` is informational: a stalled updater leaves the
          // running service healthy, so it does not turn this degraded — the
          // health monitor raises that on its own and Settings shows it.
          // `build` is what the release controller verifies after a switch
          // and what the browser compares its own bundle against; both come
          // from the compiled bundle, never from a checkout on disk.
          // `liveness`, `readiness`, `dependencies` and `history` are
          // additive: nothing in them changes this response's status code,
          // `status`, or `scheduler.status`, which the release judge, the
          // browser watcher and the health monitor read as before.
          const split = dependencySnapshot()
          return json(res, healthy ? 200 : 503, {
            status: healthy ? 'ok' : 'degraded',
            scheduler,
            organizations,
            claudeAuth: claudeAuthState,
            callerRelease,
            production,
            build: buildIdentity(),
            selfUpdate: selfUpdate?.summary() ?? { configured: false, draining: false },
            liveness: { status: 'ok' },
            readiness: split.readiness,
            dependencies: split.dependencies,
            history: split.history,
          })
        }

        // Claude Code owns credentials. Poise exposes only sanitized health
        // metadata and can start the subscription login flow; no token or
        // provider output crosses this API boundary. In service mode no
        // browser runs beside the server to complete that flow.
        if (url === '/api/claude-auth' && req.method === 'GET') {
          return json(res, 200, service ? { ...auth.snapshot(), loginUnavailable: CLAUDE_BROWSER_LOGIN_OFF } : auth.snapshot())
        }
        if (url === '/api/claude-auth/login' && req.method === 'POST') {
          if (service) return json(res, 409, { error: CLAUDE_BROWSER_LOGIN_OFF, code: SERVICE_MODE_CODE })
          const before = auth.snapshot()
          const state = auth.startLogin()
          return json(res, before.status === 'authenticated' ? 200 : 202, state)
        }

        // ── Connected accounts: each CLI's own status command, never its
        // credentials ──
        if (path === '/api/accounts' && req.method === 'GET') {
          const id = new URLSearchParams(url.split('?')[1] || '').get('id')
          if (id !== null && !isAccountId(id)) return json(res, 400, { error: 'id must name a connected account CLI' })
          try {
            return json(res, 200, { accounts: await checkAccounts(id ?? undefined) })
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // Service mode, and whose workspace this is: Settings then adds the
        // gateway's own sections (Poise Link, and Admin for its admins).
        if (path === '/api/workspace' && req.method === 'GET') {
          return json(res, 200, service ? { mode: 'service', owner: service.owner } : { mode: 'local' })
        }

        // ── First-run setup: a step-by-step dialog a new workspace opens on
        // first sign-in (server/service/onboarding.ts). Service mode only ──
        if (path === '/api/onboarding' || path === '/api/onboarding/github') {
          if (!service) {
            if (path === '/api/onboarding' && req.method === 'GET') return json(res, 200, { available: false, status: 'done' })
            return json(res, 404, { error: 'first-run setup exists only in service mode' })
          }
          const answer = () => ({ available: true, ...onboardingState(), owner: service.owner, logins: accountLogins() })
          try {
            if (path === '/api/onboarding' && req.method === 'GET') return json(res, 200, answer())
            if (path === '/api/onboarding' && req.method === 'POST') {
              updateOnboarding(await readJson(req))
              return json(res, 200, answer())
            }
            if (req.method === 'POST') return json(res, 200, await connectGitHubAccount(await readJson(req)))
            return json(res, 405, { error: 'method not allowed' })
          } catch (error) {
            return json(res, httpStatus(error, 400), { error: (error as Error).message })
          }
        }

        // Activation returns immediately; progress survives closing Settings
        // and restarting Poise. Only server-generated datastore paths are used.
        if (path === '/api/organizations' && req.method === 'GET') {
          return json(res, 200, { organizations: getOrganizations() })
        }
        if (path === '/api/organizations' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            addOrganization(body?.org)
            return json(res, 202, { organizations: getOrganizations() })
          } catch (error) {
            return json(res, httpStatus(error, 400), { error: (error as Error).message })
          }
        }
        const organizationRetry = path.match(/^\/api\/organizations\/([^/]+)\/retry$/)
        if (organizationRetry && req.method === 'POST') {
          try {
            retryOrganization(decodeURIComponent(organizationRetry[1]))
            return json(res, 202, { organizations: getOrganizations() })
          } catch (error) {
            return json(res, httpStatus(error, 400), { error: (error as Error).message })
          }
        }
        // Person-only: stopping following an account answers 403 without
        // the person's authority, and removes nothing. Nothing changes on
        // GitHub; the legacy account and the last one are refused.
        const organizationRemove = path.match(/^\/api\/organizations\/([^/]+)$/)
        if (organizationRemove && req.method === 'DELETE') {
          if (!speaksForPerson(req, !!service, authority)) {
            return json(res, 403, { error: 'Stopping following an account is the person\'s action, taken in the browser.', code: 'invalid' })
          }
          try {
            await removeOrganization(decodeURIComponent(organizationRemove[1]))
            return json(res, 200, { organizations: getOrganizations() })
          } catch (error) {
            return json(res, httpStatus(error, 400), { error: (error as Error).message })
          }
        }

        // ── The running release ──
        // The commit this Poise runs and since when, for the menu's first line.
        if (path === '/api/release' && req.method === 'GET') {
          return json(res, 200, runningRelease())
        }

        // ── Storage ──
        // The workspace storage breakdown, disk pressure and the last
        // maintenance run, plus on-demand runs from Settings.
        if (path === '/api/storage' && req.method === 'GET') {
          try {
            const fresh = new URLSearchParams(url.split('?')[1] || '').get('fresh') === '1'
            return json(res, 200, await storageStatus({ fresh }))
          } catch (err: any) {
            return json(res, httpStatus(err, 500), { error: err.message || String(err) })
          }
        }
        if (path === '/api/storage/maintenance' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            if (body && typeof body === 'object' && 'dryRun' in body && typeof (body as { dryRun: unknown }).dryRun !== 'boolean') {
              return json(res, 400, { error: 'dryRun must be a boolean' })
            }
            if (maintenanceRunning()) return json(res, 409, { error: 'a maintenance run is already in progress' })
            return json(res, 200, await runStorageMaintenanceOnce({ dryRun: (body as { dryRun?: boolean })?.dryRun ?? false }))
          } catch (err: any) {
            return json(res, httpStatus(err, 500), { error: err.message || String(err) })
          }
        }

        // ── Settings ──
        // Org / username / timezone (the few user-facing knobs Poise still
        // needs locally). Persisted in ~/.poise/cache.db meta table.
        if (url.startsWith('/api/settings') && req.method === 'GET') {
          return json(res, 200, { ...getSettings(), organizations: getOrganizations() })
        }
        if (url.startsWith('/api/settings') && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            // Person-only, checked before any state changes: the Manager
            // controls and the local turn limit. Saves of other fields keep
            // working for every caller.
            const touchesManagerControls = body !== null && typeof body === 'object' && !Array.isArray(body)
              && ('manager' in body || (typeof body.chat === 'object' && body.chat !== null && 'maxConcurrentLocalTurns' in body.chat))
            if (touchesManagerControls && !speaksForPerson(req, !!service, authority)) {
              return json(res, 403, { error: 'The Manager controls and the local turn limit are the person\'s: change them in the browser.', code: 'invalid' })
            }
            const catalog = body && typeof body === 'object' && 'models' in body ? await loadCatalog() : undefined
            if (typeof body?.org === 'string' && body.org.trim() !== getSettings().org) {
              return json(res, 400, { error: 'Add GitHub accounts through account setup.' })
            }
            // A save may carry the values its tab read: changed since, it is
            // refused with 409 and the current values, changing nothing.
            const settings = setSettings(body, catalog,
              body && typeof body === 'object' && 'expect' in body ? { expect: (body as { expect?: Record<string, unknown> }).expect } : undefined)
            // A raised Chat cap starts turns waiting for a free agent slot now.
            if (body && typeof body === 'object' && 'chat' in body) chatRuntime?.localTurnCapChanged()
            // Turned on, what needs attention is looked for now, not at the next pass.
            if (body && typeof body === 'object' && 'notifications' in body) void checkNotices()
            if (body && typeof body === 'object' && ['notifications', 'me', 'agentAccount'].some((key) => key in body)) checkGithubQuota()
            return json(res, 200, { ...settings, organizations: getOrganizations() })
          } catch (err: any) {
            const conflict = err instanceof SettingsConflictError ? { current: err.current } : {}
            return json(res, httpStatus(err, 400), { error: err.message || String(err), ...conflict })
          }
        }

        // ── Notices ──
        // The notifications at the top of the page (server/alerts/notices.ts).
        if (path === '/api/notices' && req.method === 'GET') {
          return json(res, 200, await noticeEvidence(noticesState()))
        }
        const noticeAction = path.match(/^\/api\/notices\/([^/]+)\/(dismiss|silence)$/)
        if (noticeAction && req.method === 'POST') {
          // Dismissing is the person's action in the browser. A silence
          // from anyone else is recorded as the api's.
          const person = speaksForPerson(req, !!service, authority)
          if (noticeAction[2] === 'dismiss' && !person) {
            return json(res, 403, { error: 'Dismissing a notification is the person\'s action, taken in the browser.', code: 'invalid' })
          }
          try {
            const id = decodeURIComponent(noticeAction[1])
            if (noticeAction[2] === 'dismiss') dismissNotice(id)
            else silenceNotice(id, Date.now(), person ? 'person' : 'api')
            return json(res, 200, await noticeEvidence(noticesState()))
          } catch (error) {
            return json(res, httpStatus(error, 400), { error: (error as Error).message })
          }
        }
        // The handling log: the newest handled notices, behavior firings
        // and Caller-reported runs. The checks settle first, so a handled
        // row never stays active; failures keep prior state, as they do
        // for the active notices, and the stored rows still answer.
        // `?since=<ISO>` keeps rows handled at or after that time.
        if (path === '/api/notices/handled' && req.method === 'GET') {
          const since = new URLSearchParams(url.split('?')[1] || '').get('since')
          if (since !== null && !Number.isFinite(Date.parse(since))) {
            return json(res, 400, { error: 'since must be an ISO time' })
          }
          await checkNotices()
          return json(res, 200, { handled: listHandling(HANDLED_READ_LIMIT, Date.now(), since ?? undefined) })
        }

        // ── Models ──
        // The catalog Caller exports, the three slot models resolved once, the
        // slot each place runs, the places Caller decides on its own, and the
        // last daily refresh report.
        if (url === '/api/models' && req.method === 'GET') {
          try {
            const catalog = await loadCatalog()
            const stored = getModelSettings()
            const slots = { ...resolveSlots(catalog, stored.slots), stored: stored.slots || null }
            const places = MODEL_PLACES.map((place) => {
              const resolved = resolvePlace(catalog, place.key, stored)
              const random = stored.places?.[place.key]?.slot === 'random'
              return {
                ...place,
                slot: random ? 'random' : resolved.slot,
                model: resolved.model,
                notes: random ? [...resolved.notes, 'Drawn at random per run from the three models.'] : resolved.notes,
                stored: stored.places?.[place.key] || null,
                // Which providers this place may launch; null means all of them.
                providers: placeProviders(catalog, place.key),
              }
            })
            const fixed = [
              { key: 'content', label: '/content', model: catalog.behaviors.author_content, why: 'Authors content, in the voice guide AGENT_INTERFACE_VOICE_GUIDE names when one is set; set by the Caller catalog.' },
              { key: 'consensus', label: '/consensus', model: catalog.behaviors.debate_moderator, why: `Moderates the debate; participants: ${catalog.debate_participants.join(', ')}.` },
              { key: 'fix_failing_ci', label: 'Fix failing CI', model: catalog.behaviors.fix_failing_ci, why: 'Caller behavior; set by the Caller catalog.' },
              { key: 'issue_simplify', label: 'Simplify issue', model: catalog.behaviors.issue_simplify, why: 'Caller behavior; set by the Caller catalog.' },
              { key: 'canary', label: 'Sign-in check', model: canaryClaudeModel(catalog)?.identity ?? 'unavailable', why: 'One minimal Claude request on the cheapest catalog row that proves the Claude.ai sign-in; runs once at boot and while unhealthy, never per launch.' },
            ]
            return json(res, 200, { catalog, slots, places, fixed, refresh: await readCatalogReport(), presets: listModelPresets() })
          } catch (err: any) {
            return json(res, httpStatus(err, 503), { error: err.message || String(err) })
          }
        }
        // Saved model configurations: save the choices under a name, or delete one.
        if (url === '/api/models/presets' && req.method === 'POST') {
          try {
            const body = await readJson<unknown>(req)
            return json(res, 200, { presets: saveModelPreset(body, await loadCatalog()) })
          } catch (err: any) {
            return json(res, httpStatus(err, 400), { error: err.message || String(err) })
          }
        }
        if (url === '/api/models/presets/delete' && req.method === 'POST') {
          try {
            return json(res, 200, { presets: deleteModelPreset(await readJson<unknown>(req)) })
          } catch (err: any) {
            return json(res, httpStatus(err, 400), { error: err.message || String(err) })
          }
        }
        if (url === '/api/models/refresh' && req.method === 'POST') {
          try {
            const report = await refreshModelCatalog()
            return json(res, 200, report)
          } catch (err: any) {
            return json(res, httpStatus(err, 502), { error: err.message || String(err) })
          }
        }

        // ── /api/gh — github-datastore bridge ──
        // POST /api/gh translates Poise's body shape ({ operation, record_type,
        // record_state, updated_since, ... }) to the local `github-datastore`
        // CLI and maps the result back to the legacy { records: [...] } envelope
        // the views consume. See server/gh.ts for the shape mapping and the
        // user-footprint scoping logic.
        if (url === '/api/gh' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const { status, body: respBody } = await handleGhBody(body)
            return json(res, status, respBody)
          } catch (err: any) {
            return json(res, httpStatus(err, 502), { error: 'github-datastore call failed: ' + (err.message || String(err)) })
          }
        }

        // ── /api/pull-requests/approve and /merge — the person's buttons ──
        // Body: { repo, number, expectedHeadSha, actionId }. Acts with the
        // person's GitHub account; the actionId receipt makes retries safe.
        // Person-only: without the person's authority this answers 403 and
        // acts on nothing. See server/pull-requests.ts.
        if ((url === '/api/pull-requests/approve' || url === '/api/pull-requests/merge') && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const person = speaksForPerson(req, !!service, authority)
            const { status, body: respBody } = url === '/api/pull-requests/approve'
              ? await handlePullRequestApprove(body, person)
              : await handlePullRequestMerge(body, person)
            return json(res, status, respBody)
          } catch (err: any) {
            return json(res, httpStatus(err, 502), { error: 'pull request action failed: ' + (err.message || String(err)) })
          }
        }

        // ── /api/agent-logs — Swarm's data source ──
        // History pages come from Caller's bounded newest-first reads; each
        // page costs its own rows plus an exact total that counts without
        // loading. The running lane answers from its own indexed read.
        if (path === '/api/agent-logs' && req.method === 'GET') {
          const query = new URLSearchParams(url.split('?')[1] || '')
          const limitText = query.get('limit')
          const limit = limitText === null ? undefined : Number(limitText)
          if (limitText !== null && (!/^[1-9]\d*$/.test(limitText) || !Number.isSafeInteger(limit) || limit! > 1000)) {
            return json(res, 400, { error: 'limit must be an integer from 1 to 1000' })
          }
          const status = query.get('status')
          if (status !== null && status !== 'running') {
            return json(res, 400, { error: 'status must be running' })
          }
          const cursor = query.get('cursor')
          if (cursor !== null && !/^[1-9][0-9]*$/.test(cursor)) {
            return json(res, 400, { error: 'cursor is invalid' })
          }
          const search = query.get('search')
          if (search !== null && (search.length < 1 || search.length > 2048)) {
            return json(res, 400, { error: 'search must be 1..2048 characters' })
          }
          const id = query.get('id')
          if (id !== null && !/^[0-9a-fA-F]{32}$/.test(id)) {
            return json(res, 400, { error: 'id must be a 32-character call id' })
          }
          if (id !== null && (limit !== undefined || cursor !== null || search !== null || status !== null)) {
            return json(res, 400, { error: 'id cannot combine with limit, cursor, search or status' })
          }
          if ((cursor !== null || search !== null) && limit === undefined) {
            return json(res, 400, { error: 'cursor and search require limit' })
          }
          if ((cursor !== null || search !== null) && status !== null) {
            return json(res, 400, { error: 'cursor and search require history reads' })
          }
          // History without a bound would load the full log to slice it;
          // Swarm pages instead. Running stays unpaged: it is already few.
          if (status === null && limit === undefined && id === null) {
            return json(res, 400, { error: 'limit is required for history reads; page with cursor' })
          }
          try {
            const orgs = selectedOrg ? selectOrganizations(selectedOrg) : null
            const belongs = (repo: string | null) => !orgs || (!!repo && orgs.some((org) => repoBelongsTo(repo, org.login)))
            // One exact call by primary key for settled-running refresh.
            if (id !== null) {
              const snapshot = await fetchAgentLogById(id)
              const selected = snapshot.entries.filter((entry) => belongs(entry.repo))
              const quarantined = snapshot.quarantined.filter((row) => !row.repo || belongs(row.repo)
                || selected.some((entry) => row.id === entry.id
                  || (!!entry.correlation_id && row.correlationId === entry.correlation_id)))
              const readable = selected.filter((entry) => !snapshot.quarantined.some((row) => row.id === entry.id
                  || (!!entry.correlation_id && row.correlationId === entry.correlation_id)))
              return json(res, 200, { logs: readable, quarantined })
            }
            // The running lane answers from its own indexed read; history
            // pages never queue it. Filtering stays here too, so the read
            // is exact even when Caller cannot pre-filter.
            if (status !== null) {
              const snapshot = await fetchRunningAgentLogSnapshot()
              const selected = snapshot.entries.filter((entry) => belongs(entry.repo))
              const quarantined = snapshot.quarantined.filter((row) => !row.repo || belongs(row.repo)
                || selected.some((entry) => row.id === entry.id
                  || (!!entry.correlation_id && row.correlationId === entry.correlation_id)))
              const readable = selected.filter((entry) => !snapshot.quarantined.some((row) => row.id === entry.id
                  || (!!entry.correlation_id && row.correlationId === entry.correlation_id)))
              const logs = readable.filter((entry) => entry.status === status)
              const scopedQuarantined = quarantined.filter((row) => !row.status || row.status === status)
              return json(res, 200, { logs: limit === undefined ? logs : logs.slice(0, limit), quarantined: scopedQuarantined,
                ...(limit === undefined ? {} : { total: logs.length }) })
            }
            const page = await fetchAgentLogPage(limit!, cursor, {
              ...(orgs?.length === 1 ? { org: orgs[0].login } : {}),
              ...(search !== null ? { search } : {}),
            })
            const selected = page.entries.filter((entry) => belongs(entry.repo))
            const quarantined = page.quarantined.filter((row) => !row.repo || belongs(row.repo)
              || selected.some((entry) => row.id === entry.id
                || (!!entry.correlation_id && row.correlationId === entry.correlation_id)))
            const readable = selected.filter((entry) => !page.quarantined.some((row) => row.id === entry.id
                || (!!entry.correlation_id && row.correlationId === entry.correlation_id)))
            return json(res, 200, { logs: readable, quarantined, total: page.total, nextCursor: page.nextCursor })
          } catch (err: any) {
            return json(res, 502, { error: 'agent-interface --logs failed: ' + (err.message || String(err)) })
          }
        }

        // ── /api/behavior-estimates — how long running behavior runs have left ──
        // Each running agent behavior run with its estimate from similar
        // runs: the same behavior and model, completed in the last 30 days.
        // See server/behavior-estimates.ts.
        if (path === '/api/behavior-estimates' && req.method === 'GET') {
          try {
            const [running, history] = await Promise.all([fetchRunningAgentLogSnapshot(), fetchAgentLogSnapshot()])
            return json(res, 200, { estimates: readBehaviorEstimates(history.entries, running.entries) })
          } catch (err: any) {
            return json(res, 502, { error: 'agent-interface --logs failed: ' + (err.message || String(err)) })
          }
        }

        // ── /api/capabilities — which redesigned-interface capabilities exist ──
        // #556's interface reads this once at mount. See server/capabilities.ts.
        if (path === '/api/capabilities' && req.method === 'GET') {
          return json(res, 200, { capabilities: listCapabilities() })
        }

        // ── /api/behaviors — state + metadata for behavior automations ──
        if (path === '/api/behaviors/retry-pr-reviews' && req.method === 'POST') {
          const body = await readJson<{ callIds?: unknown }>(req)
          return json(res, 200, await retryFailedPrReviews(body.callIds))
        }
        // GET returns owner (the agent account), enabled flag, and the
        // per-behavior setting (e.g. "p2") from cache.db meta. Owner is
        // who the agent acts as; enabled is whether the server-side
        // runtime is running this behavior; setting is the threshold
        // value passed to agent-interface as `--p`.
        //
        // `lastTriggered` is NOT persisted by Poise — it's derived
        // from a bounded newest-first walk of `agent-interface --logs`
        // (the canonical record of every pr_review / pr_approve run).
        // Each behavior maps to a `behavior` field value in that log:
        // review-new-prs ↔ pr_review, approve-prs ↔ pr_approve.
        // resolve-unblocking has no log surface (github-interface
        // doesn't persist its calls) so its lastTriggered stays null —
        // the dash in the Behaviors view reflects the actual state of
        // the world.
        if (path === '/api/behavior-metrics' && req.method === 'GET') {
          const query = new URLSearchParams(url.split('?')[1] || '')
          const window = parseWindow(query.get('since'), query.get('until'))
          try {
            const snapshot = await fetchAgentLogSnapshot()
            return json(res, 200, readBehaviorMetrics(snapshot.entries, window, null, snapshot.quarantined))
          } catch (error) {
            return json(res, 200, readBehaviorMetrics([], window, error instanceof Error ? error.message : String(error)))
          }
        }
        if (path === '/api/behaviors' && req.method === 'GET') {
          const enabled = getEnabledMap()
          const settings = getSettingMap()
          const scratch = getScratchpadMap()
          // A pause holds new launches until its time; `enabled` stays the
          // saved on/off, and expiry needs no write.
          const pauseState = (key: BehaviorKey) => ({ pausedUntil: getBehaviorPausedUntil(key), pausedBy: getBehaviorPausedBy(key) })
          // Indexed latest-trigger and exact incident lookups also prove
          // absence: a never-run kind cannot cause a whole-history walk.
          const accounts = getOrganizations()
          const triggers: Array<[string, string]> = [
            ['implement_issue', 'poise:behavior-chain'],
            ['repair_pr', 'poise:behavior-chain'],
            ['pr_review', 'poise:review-new-prs'],
            ['pr_approve', 'poise:approve-prs'],
            ['issue_review', 'poise:review-new-issues'],
            ['pr_review', 'poise:behavior-chain'],
            ['pr_approve', 'poise:behavior-chain'],
            ['issue_review', 'poise:behavior-chain'],
          ]
          const triggered = (entry: { behavior: string | null, source: string | null, repo: string | null, pr_id: string | null },
            cliBehavior: string, source: string) =>
            entry.behavior === cliBehavior
            && (entry.source === source || entry.source === 'poise:behavior-chain')
            && !!entry.repo
            && accounts.some((account) => repoBelongsTo(entry.repo!, account.login))
            && !!entry.pr_id
          const pending = new Set(getBehaviorDiagnosticIncidents(null)
            .map((incident) => incident.callId).filter((callId): callId is string => !!callId))
          let logs: Awaited<ReturnType<typeof fetchAgentLogs>> = []
          let snapshot: Awaited<ReturnType<typeof fetchAgentLogSnapshot>> | null = null
          let agentLogsError: string | null = null
          try {
            snapshot = await fetchSelectedAgentLogSnapshot({
              latest: triggers.flatMap(([behavior, source]) => accounts.map(account => ({ behavior, source, owner: account.login }))),
              ids: [...pending].sort(),
            })
            logs = snapshot.entries
            if (snapshot.quarantined.length > 0) agentLogsError = `${snapshot.quarantined.length} unreadable worker log row(s) quarantined`
          } catch (error) {
            agentLogsError = error instanceof Error ? error.message : String(error)
          }
          // Selection is ordered by started_at, not insertion rowid: calls
          // can register out of timestamp order on concurrent connections.
          const lastFor = (cliBehavior: string, source: string) => {
            const r = logs.find((e) => triggered(e, cliBehavior, source))
            return r ? {
              at: r.started_at_precise || r.started_at,
              target: `${r.repo}#${r.pr_id}`,
            } : null
          }
          const runtime = getBehaviorsRuntimeHealth()
          const evidence = await behaviorEvidence({ failures: runtime.failures, deadLetters: getBehaviorDiagnosticIncidents(snapshot) })
          const owner = [getSettings().me, agentAccount()].filter(Boolean).join(' / ') || null
          return json(res, 200, {
            ...Object.fromEntries((['implement-issues', 'repair-prs'] as const).map((key) => [key, {
              ...pauseState(key), owner: getSettings().me || null, enabled: enabled[key],
              setting: null, reviewers: null, scratchpad: scratch[key],
              lastTriggered: lastFor(key === 'implement-issues' ? 'implement_issue' : 'repair_pr', 'poise:behavior-chain'),
            }])),
            'review-new-prs': {
              ...pauseState('review-new-prs'),
              owner,
              enabled: enabled['review-new-prs'],
              setting: settings['review-new-prs'],
              // How many of the PR review place's reviewers (Settings →
              // Models) review each new pull request, in parallel.
              reviewers: getReviewers('review-new-prs'),
              // Repositories the behavior never acts in.
              skipRepos: getRepositorySkips('review-new-prs'),
              scratchpad: scratch['review-new-prs'],
              lastTriggered: lastFor('pr_review', 'poise:review-new-prs'),
            },
            // approve-prs has no priority setting — `setting: null` so
            // the Behaviors view can render an em dash instead of a
            // dropdown for that row.
            'approve-prs': {
              ...pauseState('approve-prs'),
              owner,
              enabled: enabled['approve-prs'],
              setting: null,
              reviewers: null,
              // The review-round cap: null is off, otherwise 2-10 rounds.
              reviewCap: getReviewCap(),
              skipRepos: getRepositorySkips('approve-prs'),
              scratchpad: scratch['approve-prs'],
              lastTriggered: lastFor('pr_approve', 'poise:approve-prs'),
            },
            // resolve-unblocking calls github-interface directly (no
            // agent), so it has no agent-interface log surface. Its
            // lastTriggered is instead persisted by the behavior
            // itself in cache.db meta whenever it actually resolves a
            // conversation — getResolveUnblockingLastFired reads it.
            // `scratchpad: null` because there's no agent prompt to
            // inject memory into — the view renders no memory control.
            'resolve-unblocking': {
              ...pauseState('resolve-unblocking'),
              owner,
              enabled: enabled['resolve-unblocking'],
              setting: null,
              reviewers: null,
              skipRepos: getRepositorySkips('resolve-unblocking'),
              scratchpad: null,
              lastTriggered: getResolveUnblockingLastFired(),
            },
            'rerun-grey-ci': {
              ...pauseState('rerun-grey-ci'),
              owner, enabled: enabled['rerun-grey-ci'], setting: null, reviewers: null,
              skipRepos: getRepositorySkips('rerun-grey-ci'), scratchpad: null,
              lastTriggered: getGreyCiLastFired(),
              lastSucceeded: getGreyCiLastSucceeded(),
            },
            'merge-prs': {
              ...pauseState('merge-prs'),
              owner,
              enabled: enabled['merge-prs'],
              setting: null,
              reviewers: null,
              skipRepos: getRepositorySkips('merge-prs'),
              scratchpad: null,
              lastTriggered: getMergePrsLastFired(),
            },
            // Review New Issues is opt-in per repository: nothing triggers
            // until `repos` names one. `authors` are the trusted accounts
            // whose issues it reviews.
            'review-new-issues': {
              ...pauseState('review-new-issues'),
              owner,
              enabled: enabled['review-new-issues'],
              setting: null,
              reviewers: getReviewers('review-new-issues'),
              repos: getIssueRepositories().map((entry) => entry.repo),
              authors: getIssueAuthors(),
              scratchpad: scratch['review-new-issues'],
              lastTriggered: lastFor('issue_review', 'poise:review-new-issues'),
            },
            diagnostics: {
              status: runtime.status,
              runtimeError: runtime.runtimeError,
              agentLogsError,
              datastore: runtime.datastore,
              identity: runtime.identity,
              failures: evidence.failures,
              deadLetters: evidence.deadLetters,
              holds: runtime.holds,
              workerCapacity: runtime.workerCapacity,
            },
          })
        }

        // POST /api/behaviors/<key> { enabled?, pausedUntil?, setting?, reviewers?: 1|2|3, reviewCap?: number|null, repos?: string[], authors?: string[], skipRepos?: string[], scratchpad? }
        // — every field optional; several can be sent in one call.
        const behaviorMatch = url.match(/^\/api\/behaviors\/([a-z0-9-]+)(?:\?|$)/)
        if (behaviorMatch && req.method === 'POST') {
          const key = behaviorMatch[1] as BehaviorKey
          if (!BEHAVIOR_KEYS.includes(key)) {
            return json(res, 400, { error: 'unknown behavior: ' + key })
          }
          try {
            const body = await readJson<any>(req)
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              return json(res, 400, { error: 'behavior update must be an object' })
            }
            // Validate the complete update before applying any field. A bad
            // setting must never leave an automation enabled as a partial
            // side effect, and string values are not booleans.
            if ('enabled' in body && typeof body.enabled !== 'boolean') {
              return json(res, 400, { error: 'enabled must be a boolean' })
            }
            // A pause holds new launches until its time, apart from the
            // saved on/off; null clears it at once. An already past time
            // simply holds nothing.
            if ('pausedUntil' in body && body.pausedUntil !== null
              && (typeof body.pausedUntil !== 'string' || !Number.isFinite(Date.parse(body.pausedUntil)))) {
              return json(res, 400, { error: 'pausedUntil must be an ISO time or null' })
            }
            if ('setting' in body) {
              if (!isValidSetting(body.setting)) {
                return json(res, 400, { error: 'invalid setting: ' + String(body.setting) })
              }
            }
            if ('reviewers' in body) {
              if (!isPanelBehavior(key)) {
                return json(res, 400, { error: 'only the review behaviors have a reviewer count' })
              }
              if (!isValidReviewers(body.reviewers)) {
                return json(res, 400, { error: 'reviewers must be 1, 2 or 3' })
              }
            }
            if ('reviewCap' in body) {
              if (key !== 'approve-prs') {
                return json(res, 400, { error: 'only approve-prs takes a review cap' })
              }
              if (!isValidReviewCap(body.reviewCap)) {
                return json(res, 400, { error: 'reviewCap must be null or an integer from 2 to 10' })
              }
            }
            if (('repos' in body || 'authors' in body) && key !== 'review-new-issues') {
              return json(res, 400, { error: 'only review-new-issues takes repositories and authors' })
            }
            if ('repos' in body) {
              if (!Array.isArray(body.repos) || body.repos.length > 200 || !body.repos.every(isValidRepository)) {
                return json(res, 400, { error: 'repos must be a list of owner/name repositories' })
              }
              // Validate newly selected repositories against their own
              // account; existing selections keep their original start dates.
              const selected = new Set(getIssueRepositories().map((entry) => entry.repo))
              const added = (body.repos as string[]).filter((repo) => !selected.has(repo))
              if (added.length) {
                let known: Set<string>
                try {
                  const owners = [...new Set(added.map((repo) => repo.split('/')[0]!.toLowerCase()))]
                  const inventories = await Promise.all(owners.map((owner) => listOrgRepos(owner)))
                  known = new Set(inventories.flat())
                } catch (err: any) {
                  return json(res, 502, { error: 'could not list the account repositories: ' + (err.message || String(err)) })
                }
                const unknown = added.filter((repo) => !known.has(repo))
                if (unknown.length) return json(res, 400, { error: 'not a repository of the account: ' + unknown.join(', ') })
              }
            }
            if ('authors' in body && !isValidAuthorList(body.authors)) {
              return json(res, 400, { error: 'authors must be up to 20 GitHub usernames' })
            }
            if ('skipRepos' in body) {
              if (!isSkippableBehavior(key)) {
                return json(res, 400, { error: 'only pull-request behaviors skip repositories' })
              }
              if (!isValidRepositoryList(body.skipRepos)) {
                return json(res, 400, { error: `skipRepos must be a list of up to ${MAX_SKIPPED_REPOSITORIES} owner/name repositories` })
              }
              // A newly skipped repository must belong to a ready account. One
              // already skipped stays valid after its account stops listing it,
              // so it can still be removed. Nothing is asked of GitHub: an
              // opt-out must not depend on a repository listing succeeding.
              const skipped = new Set(getRepositorySkips(key).map((repo) => repo.toLowerCase()))
              const accounts = readyOrganizations()
              const foreign = (body.skipRepos as string[]).filter((repo) => !skipped.has(repo.toLowerCase())
                && !accounts.some((account) => repoBelongsTo(repo, account.login)))
              if (foreign.length) return json(res, 400, { error: 'not a repository of a ready GitHub account: ' + foreign.join(', ') })
            }
            if ('scratchpad' in body) {
              if (typeof body.scratchpad !== 'string') {
                return json(res, 400, { error: 'scratchpad must be a string' })
              }
              // A memory write is a blind overwrite of whatever is stored. Two
              // Poise windows editing the same behavior meant the later save
              // silently discarded the earlier one. When the client says what
              // it believed was stored, hold it to that and let it re-read.
              if (typeof body.scratchpadPrevious === 'string'
                && getScratchpadMap()[key] !== body.scratchpadPrevious) {
                return json(res, 409, {
                  error: 'the memory changed since it was loaded',
                  scratchpad: getScratchpadMap()[key],
                })
              }
            }
            // Persist passive configuration first; enabling last guarantees
            // the first tick observes the submitted setting and memory.
            if ('setting' in body) setBehaviorSetting(key, body.setting)
            if ('reviewers' in body && isPanelBehavior(key)) setBehaviorReviewers(body.reviewers, key)
            if ('reviewCap' in body && key === 'approve-prs') setBehaviorReviewCap(body.reviewCap)
            if ('repos' in body) setIssueRepositories(body.repos)
            if ('authors' in body) setIssueAuthors(body.authors)
            if ('skipRepos' in body && isSkippableBehavior(key)) setRepositorySkips(key, body.skipRepos)
            if ('scratchpad' in body) setBehaviorScratchpad(key, body.scratchpad)
            if ('enabled' in body) await setBehaviorEnabled(key, body.enabled)
            // The pause records who asked: the person, or `api` for a
            // write that does not speak for them — the server cannot name
            // the chat behind one.
            if ('pausedUntil' in body) {
              await setBehaviorPaused(key, body.pausedUntil,
                speaksForPerson(req, !!service, authority) ? 'person' : 'api')
            }
            return json(res, 200, {
              ok: true,
              enabled: getEnabledMap()[key],
              pausedUntil: getBehaviorPausedUntil(key),
              pausedBy: getBehaviorPausedBy(key),
              setting: getSettingMap()[key],
              reviewers: isPanelBehavior(key) ? getReviewers(key) : null,
              ...(key === 'approve-prs' ? { reviewCap: getReviewCap() } : {}),
              ...(key === 'review-new-issues' ? {
                repos: getIssueRepositories().map((entry) => entry.repo),
                authors: getIssueAuthors(),
              } : {}),
              ...(isSkippableBehavior(key) ? { skipRepos: getRepositorySkips(key) } : {}),
              scratchpad: getScratchpadMap()[key],
            })
          } catch (err: any) {
            return json(res, httpStatus(err, 400), { error: err.message || String(err) })
          }
        }

        // ── /api/repos — every repo in the org with any PR/issue ──
        // Cached 5 min server-side. Used by Current's repo selectors so
        // the user can pick from every repository of their accounts, not
        // just the ones they've personally touched.
        if (path === '/api/repos' && req.method === 'GET') {
          try {
            return json(res, 200, await listOrganizationsRepos(selectedOrg))
          } catch (err: any) {
            return json(res, 502, { error: 'listOrgRepos failed: ' + (err.message || String(err)) })
          }
        }

        if (path === '/api/github-quota' && req.method === 'GET') {
          try {
            return json(res, 200, await readGithubQuota())
          } catch (error: unknown) {
            return json(res, 502, { error: error instanceof Error ? error.message : String(error) })
          }
        }

        // ── Analytics day and history; abandoned reads release their worker ──
        if ((path === '/api/analytics' || path === '/api/analytics/history') && req.method === 'GET') {
          const controller = new AbortController()
          const close = () => controller.abort(new Error('Analytics client disconnected'))
          res.once('close', close)
          if (res.destroyed) close()
          try {
            const query = new URLSearchParams(url.split('?')[1] || '')
            const report = path === '/api/analytics/history'
              ? await readAnalyticsHistory(parseBounds(query.get('bounds')), selectedOrg, controller.signal)
              : await readAnalytics(parseWindow(query.get('since'), query.get('until')), selectedOrg, query.has('dailyBounds') ? parseBounds(query.get('dailyBounds')) : undefined, controller.signal)
            if (!res.destroyed) return json(res, 200, report)
          } catch (err: any) {
            if (!res.destroyed) return json(res, httpStatus(err, 502), { error: err.message || String(err) })
          } finally {
            res.off('close', close)
          }
          return
        }

        // ── /api/chat/* — Chat v1 sessions (server/chat) ──
        if (url.startsWith('/api/chat/') && chatRuntime) {
          if (await handleChatApi(req, res, url, chatRuntime, chatSwitchboard ?? undefined, speaksForPerson(req, !!service, authority), chatControl ?? undefined)) return
        }

        // ── /api/chat-content — /content slash command bridge ──
        // POST launches agent-interface and commits a durable pending job
        // before returning. A leased server-side reconciler owns completion,
        // so browser polling is observational only and restart-safe.
        if (url === '/api/chat-content' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const topic   = String(body.topic   || '')
            const chatSession = typeof body.chatSession === 'string' && body.chatSession ? body.chatSession : ''
            const session = String(body.session || '') || chatSession
            if (chatSession) requireChatSession(chatRuntime, chatSession)
            const job = await launchAndEnqueueContentJob(topic, session)
            if (chatSession && chatRuntime) {
              const pending = job as { pending?: boolean, launch_id?: string }
              if (pending.pending && pending.launch_id) {
                chatRuntime.recordCommandEvent(chatSession, { type: 'content.started', topic, launchId: pending.launch_id })
              } else {
                const linked = job as { call_id: string }
                const launchId = contentLaunchIdForCall(linked.call_id)
                chatRuntime.recordCommandEvent(chatSession, { type: 'content.started', topic, launchId, callId: linked.call_id })
              }
            }
            // 202 when the agent is running but its call row has not been
            // identified yet — the recovery pass links it shortly. It is not a
            // failure and must not be reported as one.
            return json(res, (job as { pending?: boolean }).pending ? 202 : 200, job)
          } catch (err: any) {
            const status = err instanceof ProcessLockError
              ? 503
              : err instanceof ContentLaunchPendingError
                ? 409
                : httpStatus(err, 502)
            return json(res, status, {
              error: '/content trigger failed: ' + (err.message || String(err)),
            })
          }
        }
        if (url?.startsWith('/api/chat-content/status') && req.method === 'GET') {
          try {
            const qs = new URLSearchParams(url.split('?')[1] || '')
            const launchId = qs.get('launch_id') || ''
            if (launchId) {
              const job = getContentLaunchResponse(launchId)
              if (!job) return json(res, 404, { error: 'author-content job not found' })
              return json(res, 200, job)
            }
            const callId = qs.get('call_id') || ''
            if (!callId) return json(res, 400, { error: 'call_id is required' })
            const job = getContentJobResponse(callId)
            if (!job) return json(res, 404, { error: 'author-content job not found' })
            return json(res, 200, job)
          } catch (err: any) {
            return json(res, 500, { error: 'status check failed: ' + (err.message || String(err)) })
          }
        }

        // ── /api/debate — wraps agent-interface --debate ──
        // Routed here by Chat's `/consensus` slash command.
        // Synchronous: blocks until the local multi-model debate
        // completes, then returns the parsed JSON {synthesis, rounds}.
        // agent-interface logs the call so it appears in Swarm.
        if (url === '/api/debate' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const chatSession = typeof body.chatSession === 'string' && body.chatSession ? body.chatSession : ''
            if (!chatSession) {
              const result = await countDebate(() => runDebate(String(body.topic || ''), Number(body.rounds || 1)))
              return json(res, 200, result)
            }
            requireChatSession(chatRuntime, chatSession)
            const topic = String(body.topic || '')
            const id = randomUUID()
            chatRuntime!.recordCommandEvent(chatSession, { type: 'consensus.started', id, topic })
            try {
              const result = await countDebate(() => runDebate(topic, 1))
              const { synthesis, truncated } = cutSynthesis(result.synthesis)
              chatRuntime!.recordCommandEvent(chatSession, { type: 'consensus.finished', id, synthesis, ...(truncated ? { truncated: true } : {}) })
              return json(res, 200, { ...result, id })
            } catch (error: any) {
              chatRuntime!.recordCommandEvent(chatSession, { type: 'consensus.finished', id, error: error?.message || String(error) })
              throw error
            }
          } catch (err: any) {
            return json(res, httpStatus(err, 500), { error: err?.message || String(err) })
          }
        }

        // ── /api/pr-review — kick off agent-interface --pr-review ──
        // Body: { url } where url is a github PR URL. Resolves the
        // local checkout path via github-interface, then spawns the
        // CLI detached. The frontend gets an immediate 200; the actual
        // run lands in Swarm as a new agent-interface log entry.
        if (url === '/api/pr-review' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const result = await triggerPrReview(String(body.url || ''))
            return json(res, 200, result)
          } catch (err: any) {
            const stderr = err?.stderr?.toString?.() || ''
            const msg = stderr || err?.message || String(err)
            return json(res, httpStatus(err, 502), { error: 'pr-review trigger failed: ' + msg })
          }
        }

        // ── /api/agent-replay — re-run an existing agent-interface job ─
        // Body: { behavior, repo, pr_id }. Server maps behavior to the
        // CLI flag (--pr-review / --pr-approve) and re-spawns. A new
        // row appears in `agent-interface --logs`; the original row is
        // untouched. Used by the Swarm view's Replay column. A target the
        // scheduler would not act on is refused with 409.
        if (url === '/api/agent-replay' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const result = await replayAgentJob(body, admitReplay)
            return json(res, 200, result)
          } catch (err: any) {
            // A refusal is the answer, not a failure: it names the check the
            // target failed, as the scheduler would have.
            if (err instanceof ReplayRefusedError) return json(res, 409, { error: err.message })
            const stderr = err?.stderr?.toString?.() || ''
            const msg = stderr || err?.message || String(err)
            return json(res, httpStatus(err, 400), { error: 'agent-replay failed: ' + msg })
          }
        }

        // ── /api/agent-stop — interrupt a running agent-interface call ─
        // Body: { id }. Caller signals the call's process group and closes
        // the row as failed / "stopped"; the Swarm row settles on the next
        // poll. Used by the Swarm view's Stop column.
        if (url === '/api/agent-stop' && req.method === 'POST') {
          try {
            const body = await readJson<any>(req)
            const id = String(body.id || '').toLowerCase()
            // A Chat turn has no Caller process to signal: Stop goes to the
            // runtime that owns the session, and only that one. A turn of the
            // other Poise server is reported, never touched.
            const chatTurn = chatRuntime && /^[0-9a-f]{32}$/.test(id) ? chatRuntime.describeTurn(id) : null
            if (chatTurn) {
              // Stopping a chat turn is the person's action, as on the chat
              // routes. Stopping agent-interface jobs below is unchanged.
              if (!speaksForPerson(req, !!service, authority)) return json(res, 403, { error: 'This is the person\'s action, taken in the browser. Chats use the control operations.', code: 'invalid' })
              const { settled } = await chatRuntime!.cancel(chatTurn.sessionId, { kind: 'person' })
              return json(res, 200, { id, stopped: settled, status: settled ? 'cancelled' : 'stopping', error_code: 'stopped' })
            }
            if (/^[0-9a-f]{32}$/.test(id)) {
              const row = (await fetchAgentLogs().catch(() => [])).find((entry) => entry.id === id)
              if (row && row.runner === 'external') {
                return json(res, 409, { error: 'this turn belongs to another Poise server; stop it from that server\'s Chat view' })
              }
            }
            const result = await stopAgentJob(id)
            return json(res, 200, result)
          } catch (err: any) {
            const stderr = err?.stderr?.toString?.() || ''
            const msg = (stderr || err?.message || String(err)).trim()
            return json(res, httpStatus(err, 502), { error: 'agent-stop failed: ' + msg })
          }
        }

        // ── /api/editor — markdown editor docs ──
        // Each doc is a plain .md file under ~/.poise/editor/ (or
        // $POISE_EDITOR_DIR). server/editor.ts owns sanitization and
        // the on-disk layout; this just bridges HTTP to those calls.
        if (url === '/api/editor/docs' && req.method === 'GET') {
          try {
            const docs = await listDocs()
            return json(res, 200, { docs })
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }
        if (url === '/api/editor/docs' && req.method === 'POST') {
          // Create a new blank doc with a server-minted slug.
          try {
            const result = await writeDoc(newSlug(), '')
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }
        const editorDocMatch = url.match(/^\/api\/editor\/doc\/([A-Za-z0-9._-]+)$/)
        if (editorDocMatch && req.method === 'GET') {
          try {
            const result = await readDoc(editorDocMatch[1])
            return json(res, 200, result)
          } catch (err: any) {
            if (err.code === 'ENOENT') return json(res, 404, { error: 'not found' })
            return json(res, 500, { error: err.message || String(err) })
          }
        }
        if (editorDocMatch && (req.method === 'PUT' || req.method === 'POST')) {
          try {
            // JSON string escaping can expand control-heavy Markdown by up to
            // six bytes per decoded byte. writeDoc still enforces 5 MiB after
            // parsing; this envelope cap preserves that domain limit.
            const body = await readJson<any>(req, MAX_DOC_BYTES * 6 + 1024)
            if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.content !== 'string') {
              return json(res, 400, { error: 'content must be a string' })
            }
            if (body.client_id === undefined && body.revision === undefined && body.base_version === undefined) {
              return json(res, 428, { error: 'editor write precondition is required; reload the document' })
            }
            const writeContext = body.client_id === undefined
                && body.revision === undefined
                && body.base_version === undefined
              ? undefined
              : {
                  clientId: body.client_id,
                  revision: body.revision,
                  baseVersion: body.base_version,
                }
            const result = await writeDoc(editorDocMatch[1], body.content, writeContext)
            return json(res, 200, result)
          } catch (err: any) {
            const conflict = err instanceof EditorConflictError
            return json(res, conflict ? 409 : httpStatus(err, 400), {
              error: err.message || String(err),
              ...(conflict ? { current_version: err.currentVersion } : {}),
            })
          }
        }
        if (editorDocMatch && req.method === 'DELETE') {
          try {
            const result = await deleteDoc(editorDocMatch[1])
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }

        // ── /api/editor/doc/:slug/annotations — side-car notes per doc ──
        // GET returns the full list; PUT replaces it. The front-end owns
        // ids/snippets and decides when to add/remove; we just persist.
        const editorAnnMatch = url.match(/^\/api\/editor\/doc\/([A-Za-z0-9._-]+)\/annotations$/)
        if (editorAnnMatch && req.method === 'GET') {
          try {
            const result = await readAnnotations(editorAnnMatch[1])
            return json(res, 200, result)
          } catch (err: any) {
            return json(res, 500, { error: err.message || String(err) })
          }
        }
        if (editorAnnMatch && (req.method === 'PUT' || req.method === 'POST')) {
          try {
            const body = await readJson<any>(req, MAX_ANNOTATIONS_BYTES + 1024)
            if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.annotations)) {
              return json(res, 400, { error: 'annotations must be an array' })
            }
            if (body.client_id === undefined && body.revision === undefined && body.base_version === undefined) {
              return json(res, 428, { error: 'editor write precondition is required; reload annotations' })
            }
            const annotations = body.annotations
            const writeContext = body.client_id === undefined
                && body.revision === undefined
                && body.base_version === undefined
              ? undefined
              : {
                  clientId: body.client_id,
                  revision: body.revision,
                  baseVersion: body.base_version,
                }
            const result = await writeAnnotations(editorAnnMatch[1], { annotations }, writeContext)
            return json(res, 200, result)
          } catch (err: any) {
            const conflict = err instanceof EditorConflictError
            return json(res, conflict ? 409 : httpStatus(err, 400), {
              error: err.message || String(err),
              ...(conflict ? { current_version: err.currentVersion } : {}),
            })
          }
        }

        // ── /api/agent-response/:id — body of one agent call ──
        // Only a full 32-hex call id is accepted. The short `response` marker
        // from --logs is not an identity and can become ambiguous.
        const agentRespMatch = url.match(/^\/api\/agent-response\/([0-9a-fA-F]{32})(?:\?|$)/)
        if (agentRespMatch && req.method === 'GET') {
          const callId = agentRespMatch[1]
          try {
            const result = await fetchAgentResponse(callId)
            return json(res, 200, result)
          } catch (err: any) {
            const stderr = err?.stderr?.toString?.() || ''
            const msg = stderr || err?.message || String(err)
            return json(res, 502, { error: 'agent-interface --read-response failed: ' + msg })
          }
        }

        const reasoningMatch = url.match(/^\/api\/agent-reasoning\/([0-9a-fA-F]{32})(?:\?|$)/)
        if (reasoningMatch && req.method === 'GET') {
          try {
            return json(res, 200, await fetchAgentReasoning(reasoningMatch[1]))
          } catch (err: any) {
            return json(res, 502, { error: 'agent-interface --read-reasoning failed: ' + (err.message || String(err)) })
          }
        }

        // ── Current (kanban) — manual cards (idea / concept / plan) ──
        // Stays Poise-local. The Issue + PR lanes pull from /api/gh.
        if (path === '/api/current' && req.method === 'GET') {
          const orgs = selectedOrg ? selectOrganizations(selectedOrg) : null
          return json(res, 200, { cards: listCards().filter((card) => !orgs || !card.repo || orgs.some((org) => repoBelongsTo(card.repo!, org.login))) })
        }
        if (url === '/api/current' && req.method === 'POST') {
          try {
            const parsed = await readJson<any>(req)
            if (typeof parsed.repo === 'string' && parsed.repo.trim()) requireConfiguredRepository(parsed.repo.trim())
            const card = createCard(String(parsed.text ?? ''), parsed.lane as Lane, parsed.repo)
            return json(res, 200, card)
          } catch (err: any) {
            return json(res, httpStatus(err, 400), { error: err.message || String(err) })
          }
        }
        const currentMatch = url.match(/^\/api\/current\/(\d+)(?:\?|$)/)
        if (currentMatch) {
          const id = Number(currentMatch[1])
          if (req.method === 'PATCH') {
            try {
              const parsed = await readJson<any>(req)
              // PATCH accepts any combination of {text}, {repo}, or
              // {lane, position}. Multiple fields in one call apply in
              // order so the edit form can save text + repo together.
              if (typeof parsed.repo === 'string' && parsed.repo.trim()) requireConfiguredRepository(parsed.repo.trim())
              let card = null
              if (typeof parsed.text === 'string') card = setCardText(id, parsed.text)
              if ('repo' in parsed)                card = setCardRepo(id, parsed.repo)
              if (typeof parsed.lane === 'string' && typeof parsed.position === 'number') {
                const organization = parsed.org ? selectOrganizations(parsed.org)[0]?.login : undefined
                card = moveCard(id, parsed.lane as Lane, parsed.position, organization)
              }
              if (card) return json(res, 200, card)
              return json(res, 400, { error: 'Provide one or more of { text }, { repo }, { lane, position }' })
            } catch (err: any) {
              return json(res, httpStatus(err, 400), { error: err.message || String(err) })
            }
          }
          if (req.method === 'DELETE') {
            try {
              removeCard(id)
              return json(res, 200, { ok: true })
            } catch (err: any) {
              return json(res, 400, { error: err.message || String(err) })
            }
          }
        }

        if (await handleGoogleApi(req, res, url, service)) return
        if (await handlePublishingApi(req, res, url)) return
        if (await handleExtensionsApi(req, res, url)) return
        if (await handleSnippetApi(req, res, url, speaksForPerson(req, !!service, authority))) return

        return next()
      }
}

export function cachePlugin(opts: CachePluginOptions = {}): Plugin {
  return {
    name: 'poise-cache',
    configureServer(server) {
      server.middlewares.use(createPoiseMiddleware(opts))
    },
  }
}
