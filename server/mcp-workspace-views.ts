import { isMcpRepository, type McpWorkspaceView } from '../gateway/src/mcp-contract'
import { placeHref, type Section } from '../src/ui/address'
import { accountLogins } from './accounts/logins'
import { HANDLING_RETENTION_MS, listHandling } from './alerts/handling'
import { noticesState } from './alerts/notices'
import { readAnalyticsHealth } from './analytics-health'
import { BEHAVIOR_KEYS, getBehaviorChainRuntimeHealth, getBehaviorsRuntimeHealth, getEnabledMap, getIssueAuthors,
  getIssueRepositories, getPausedBy, getPausedUntil, getRepositorySkips, getSettingMap, isSkippableBehavior } from './behaviors'
import { readWake } from './chat/manager-settings'
import { readMemories } from './chat/memories'
import { lastCommitted, openDecisions, outstandingCheck, readBoard } from './chat/switchboard-store'
import { listCards } from './current'
import { listOrganizationsRepos } from './gh'
import { listServers } from './extensions/store'
import { readGithubQuota } from './github-quota'
import { dependencySnapshot, livenessSnapshot } from './health'
import { loadCatalog, resolveSlots } from './models'
import { getOrganizations } from './organizations'
import { releaseBackgroundPaused, releaseSwitchPending } from './release-background'
import { runningRelease } from './running-release'
import { getBehaviorChainSettings, getModelSettings, getSettings } from './settings'
import { readSwitches } from './snippet-library'
import { storageStatus } from './storage-maintenance'
import { getWorkerCapacity } from './worker-capacity'

const settingsLink = (settings: Section) => '/' + placeHref('settings', { settings })
const observeLink = (part: 'behaviors' | 'logging') => '/' + placeHref('observe', { part })
const overview = '/' + placeHref('overview')
const sources = {
  settings: ['Workspace settings', 'Current applied settings', settingsLink('general')],
  accounts: ['Followed accounts and recorded sign-in', 'Current readiness and stored sign-in observations', settingsLink('accounts')],
  models: ['Caller catalog and saved model slots', 'Latest successful catalog load', settingsLink('models')],
  behaviors: ['Behavior policy, sweep and admission runtime', 'Current configuration and retained runtime evidence', observeLink('behaviors')],
  release: ['Running release and update state', 'Current applied release', settingsLink('general')],
  health: ['Workspace dependency observations', 'Current readiness and retained ledger gaps', overview],
  storage: ['Workspace storage measurement', 'Latest cached measurement and maintenance run', settingsLink('general')],
  'github-quota': ['GitHub quota observations', 'Most recent successful observation per configured account', settingsLink('accounts')],
  'analytics-health': ['Behavior chain analytics', 'Observed 24-hour work cohort and retained coverage', overview],
  notices: ['Open workspace notifications', 'Current unresolved notices', overview],
  handling: ['Workspace handling log', '30 days after handling', overview],
  extensions: ['Saved Poise extension registrations', 'Current registrations and latest status', settingsLink('extensions')],
  memories: ['Saved Chat memories', 'Current revision', '/' + placeHref('chat')],
  snippets: ['Saved snippet switches', 'Current revisions', settingsLink('snippets')],
  current: ['Current cards', 'Current board cards', '/' + placeHref('board')],
  repositories: ['Configured owner repository discovery', 'Latest GitHub account discovery', '/' + placeHref('board', { part: 'github' })],
  switchboard: ['Switchboard and Manager runtime', 'Current checks, decisions and Rhythm slots', overview],
} satisfies Record<McpWorkspaceView, [source: string, retention: string, href: string]>

export function workspaceViewSurface(id: McpWorkspaceView) {
  const [source, retention, href] = sources[id]
  return { kind: 'workspace', source, retention, href, permission: 'Workspace settings and operational data consent',
    tool: 'poise_get' as const, requiresWorkspace: true, reason: 'Exact workspace snapshot ' + id }
}

const ITEM_LIMIT = 20
const bounded = <T>(items: readonly T[], limit = ITEM_LIMIT) => ({ items: items.slice(0, limit), more: items.length > limit })
const safeTitle = (value: string) => value.slice(0, 300)
type Snapshot = { value: unknown; coverage?: 'partial' | 'stale' | 'unavailable' }

async function view(id: McpWorkspaceView, chatInstance?: string): Promise<Snapshot> {
  switch (id) {
    case 'current': {
      const cards = listCards(ITEM_LIMIT + 1)
      const items = bounded(cards.map(({ id, text, lane, position, repo, created_at, updated_at }) => ({
        id, text: text.slice(0, 1000), truncated: text.length > 1000, lane, position,
        repository: repo && isMcpRepository(repo) ? repo : null, createdAt: created_at, updatedAt: updated_at,
      })))
      return { value: items, coverage: items.more || items.items.some(item => item.truncated) ? 'partial' : undefined }
    }
    case 'repositories': {
      const result = await listOrganizationsRepos()
      const repositories = bounded(result.repos.filter(isMcpRepository), 50)
      return { value: { repositories, unavailableOrganizations: result.errors.map(row => row.org) },
        coverage: repositories.more || result.errors.length ? 'partial' : undefined }
    }
    case 'switchboard': {
      if (!chatInstance) return { value: null, coverage: 'unavailable' }
      const board = readBoard(chatInstance)
      const pending = outstandingCheck(chatInstance)
      const lastCheck = lastCommitted(chatInstance)
      const { rhythm, paused } = getSettings().manager
      const capacity = getWorkerCapacity()
      return { value: { switchboard: board ? { chatId: board.session, paused: board.paused === 1, revision: board.revision,
        nextCheckAt: board.next_check_at || null, failures: board.failures, pendingCheck: pending?.id ?? null,
        lastCheck: lastCheck ?? null, openDecisions: openDecisions(chatInstance) } : null,
        manager: { rhythm, paused, capacity: { running: capacity.running, target: capacity.target, backlog: capacity.backlog, label: capacity.label } } } }
    }
    case 'settings': {
      const { org, me, agentAccount, timezone, chat, notifications, manager, behaviorChain } = getSettings()
      return { value: { org, me, agentAccount, timezone, chat, notifications, manager: { ...manager,
        scope: manager.scope === null ? null : bounded(manager.scope) }, behaviorChain, managerWake: readWake() } }
    }
    case 'accounts': {
      const organizations = bounded(getOrganizations().map(({ login, managed, status, stage, activatedAt, retryAt }) =>
        ({ login, managed, status, stage, activatedAt, retryAt })))
      return { value: { organizations, recordedSignIn: accountLogins() }, coverage: organizations.more ? 'partial' : undefined }
    }
    case 'models': {
      const catalog = await loadCatalog()
      const stored = getModelSettings()
      const models = bounded(catalog.models.map(({ identity, provider, effort }) => ({ identity, provider, effort })), 50)
      return { value: { models, slots: resolveSlots(catalog, stored.slots), places: stored.places ?? null },
        coverage: models.more ? 'partial' : undefined }
    }
    case 'behaviors': {
      const enabled = getEnabledMap(), settings = getSettingMap(), runtime = getBehaviorsRuntimeHealth()
      const configuration = BEHAVIOR_KEYS.map(key => ({ key, enabled: enabled[key], setting: settings[key],
        pausedUntil: getPausedUntil(key), pausedBy: getPausedBy(key),
        excludedRepositories: isSkippableBehavior(key) ? bounded(getRepositorySkips(key)) : null }))
      const { status, running, lastTickAt, lastTickCompletedAt, chainCapacity } = runtime
      const failures = bounded(runtime.failures.map(({ error: _error, diagnostic: _diagnostic, ...failure }) => failure))
      const holds = bounded(runtime.holds.map(({ error: _error, ...hold }) => hold))
      return { value: { configuration, intake: getBehaviorChainSettings(), reviewRepositories: bounded(getIssueRepositories().map(row => row.repo)),
        trustedAuthors: bounded(getIssueAuthors()), sweep: { status, running, lastTickAt, lastTickCompletedAt,
          organizations: bounded(getBehaviorChainRuntimeHealth().map(({ organization, lastSweepAt, error }) =>
            ({ organization, lastSweepAt, failed: error !== null }))) },
        capacity: { ...chainCapacity, error: chainCapacity.error ? 'Capacity evidence is unavailable' : null }, failures, holds },
        coverage: status === 'degraded' || failures.more || holds.more || configuration.some(row => row.excludedRepositories?.more) ? 'partial' : undefined }
    }
    case 'release':
      return { value: { ...runningRelease(), admissionPaused: releaseBackgroundPaused(), switchPending: releaseSwitchPending() } }
    case 'health': {
      const { readiness, dependencies, history } = dependencySnapshot()
      return { value: { liveness: livenessSnapshot(), readiness: { status: readiness.status },
        ledger: dependencies.ledger, history: history.ledger, collectors: dependencies.collectors,
        datastore: bounded(dependencies.datastore.map(({ error: _error, ...row }) => row)),
        githubQuota: bounded(dependencies.githubQuota.map(({ error: _error, ...row }) => row)) } }
    }
    case 'storage': {
      const { at, disk, pressure, categories, lastRun, complete, stale } = await storageStatus()
      return { value: { at, disk: { totalBytes: disk.totalBytes, freeBytes: disk.freeBytes, usedPercent: disk.usedPercent },
        pressure, categories: categories.map(({ key, label, bytes, status }) => ({ key, label, bytes, status })),
        lastRun: lastRun ? { at: lastRun.finishedAt, reclaimedBytes: lastRun.reclaimedBytes, errorCount: lastRun.errors.length } : null },
        coverage: stale ? 'stale' : complete ? undefined : 'partial' }
    }
    case 'github-quota': {
      const report = await readGithubQuota({ lastObserved: true })
      const accounts = bounded(report.accounts.map(({ login, roles, checkedAt, error, buckets }) => ({
        login, roles, checkedAt, checkFailed: error !== null, buckets: bounded(buckets.map(({ history: _history, ...bucket }) => bucket)),
      })))
      return { value: accounts, coverage: report.accounts.length === 0 ? 'unavailable'
        : accounts.more || accounts.items.some(row => row.checkFailed || !row.checkedAt || row.buckets.more) ? 'partial' : undefined }
    }
    case 'analytics-health': {
      const report = await readAnalyticsHealth()
      return { value: { readAt: report.readAt, window: report.window, limits: bounded(report.limits),
        rate: { ...report.rate, items: bounded(report.rate.items, 5) },
        blocked: { ...report.blocked, items: bounded(report.blocked.items, 5) },
        recovery: { automatic: bounded(report.recovery.automatic, 5), intervention: bounded(report.recovery.intervention, 5), unknown: report.recovery.unknown },
        lastError: report.lastError, coverage: bounded(report.coverage) },
        coverage: report.limits.length || report.rate.items.length > 5 || report.blocked.items.length > 5 ? 'partial' : undefined }
    }
    case 'notices': {
      const { enabled, notices } = noticesState()
      const current = bounded(notices.map(({ id, kind, title, body, since, due }) =>
        ({ id, kind, title: safeTitle(title), body: body.slice(0, 600), since, due })))
      return { value: { enabled, ...current }, coverage: current.more ? 'partial' : undefined }
    }
    case 'handling': {
      const rows = bounded(listHandling(ITEM_LIMIT + 1).map(({ error, ...row }) => ({ ...row, hadError: !!error, title: safeTitle(row.title) })))
      return { value: { ...rows, retainedFrom: new Date(Date.now() - HANDLING_RETENTION_MS).toISOString() },
        coverage: rows.more ? 'partial' : undefined }
    }
    case 'extensions': {
      const registrations = bounded(listServers().map(({ id, name, title, transport, source, status, enabled, signedIn, updatedAt }) =>
        ({ id, name, title: safeTitle(title), transport, source, signedIn, updatedAt, enabledByDefault: enabled.default,
          workspaceOverrideCount: Object.keys(enabled.workspaces).length, state: status.state, checkedAt: status.checkedAt ?? null })))
      return { value: registrations, coverage: registrations.more ? 'partial' : undefined }
    }
    case 'memories': {
      const { text, revision } = readMemories()
      return { value: { revision, bytes: Buffer.byteLength(text) } }
    }
    case 'snippets': {
      const { revision, switches } = readSwitches()
      const snippets = bounded(switches.map(({ name, snippetTrigger, content, revision, updatedAt }) =>
        ({ name, trigger: snippetTrigger ?? null, bytes: Buffer.byteLength(content), revision, updatedAt })))
      return { value: { revision, ...snippets }, coverage: snippets.more ? 'partial' : undefined }
    }
  }
}

export async function readWorkspaceView(id: McpWorkspaceView, chatInstance?: string) {
  const { source, retention, href } = workspaceViewSurface(id)
  try {
    const snapshot = await view(id, chatInstance)
    return { observedAt: new Date().toISOString(), source, retention, href, coverage: snapshot.coverage ?? 'complete',
      record: { kind: 'workspace', id, value: snapshot.value } }
  } catch {
    return { observedAt: new Date().toISOString(), source, retention, href, coverage: 'unavailable', reason: 'The workspace source could not be read',
      record: { kind: 'workspace', id, value: null } }
  }
}
