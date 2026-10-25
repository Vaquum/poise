import { navigationSection } from './navigation-settings'
import { scrollToActor } from './motion'
import { patchContent, patchInformation } from './dom-patch'
import { MODEL_CHECK_TIMEOUT_MS, modelRefreshSummary, type ModelRefreshReport } from './model-refresh'
// General, Models and Accounts are direct destinations in the burger menu.
// They share one panel and keep their drafts while moving between destinations.
//
// GitHub credentials stay in gh; Poise asks it for the account it acts as.
// Your account scopes the views to your user-footprint (things you're
// involved in) rather than the whole org. The agent account is who reviews
// and comments are posted as.
//
// Model names are identities from Caller's catalog (`opus-5-max`), shown
// verbatim: the same string the Swarm log records and the CLI takes. The
// panel never invents a label for one.

import { getSettings as getCachedSettings, setLocalSettings, loadSettings, settingsLoadOk, getRefreshRate, setRefreshRate, getTheme, setTheme, getOrganizations, setOrganizations, settingsReady, effectiveTimezone, type Organization } from './config'
import { CHAT_DEFAULTS, GITHUB_NAME, conflictLeaves, conflictMessage, deepEqual, generalPayload, isRecord, mergeSaveBaseline, rereadValue, validateGeneralDraft, validateModelChoices, type ConflictLeaf, type GeneralDraft, type GeneralField, type GeneralTopField, type ModelChoice } from './settings-save'
import { productionSummary, type ProductionUpdate } from './production-status'
import { clockDay, logTime, shortTime } from './clock'
import { ACCOUNT_IDS, ACCOUNT_LOGINS, CONNECTED_ACCOUNTS_PATH, MUSE_API_KEY_LOGIN, type ConnectedAccount } from '../server/accounts/types'
import { isTerminalPreset, type TerminalPreset } from '../server/terminal/protocol'
import { googleAccountsSection } from './views/google-accounts'
import { accountsHtml, fetchAccounts } from './views/connected-accounts'
import { publishingSection, type PublishingSection } from './views/publishing-settings'
import { sendLatest } from './notices'
import './views/connected-accounts.css'
import type { TerminalPanel } from './views/terminal-panel'

interface CatalogModel { identity: string, provider: string, selector: string, effort: string }
interface ModelPlace {
  key: string
  label: string
  why: string
  review: boolean
  // The providers this place may launch; null for all of them.
  providers?: string[] | null
  // The PR review and Issue review places also name a secondary and a
  // tertiary reviewer; Behaviors decides how many of the three review each
  // new pull request or issue.
  reviewers: boolean
  default: string
  fallback: string
  secondary?: string
  tertiary?: string
  notes: string[]
  stored: { default: string, fallback: string, secondary?: string, tertiary?: string } | null
}
const REVIEWER_SLOTS = ['secondary', 'tertiary'] as const
interface FixedPlace { key: string, label: string, model: string, why: string }
interface ModelsResponse {
  catalog: { models: CatalogModel[], review_providers: string[], path: string }
  places: ModelPlace[]
  fixed: FixedPlace[]
  refresh: ModelRefreshReport | null
  presets?: ModelPreset[]
}

// A saved model configuration: model choices kept under a name to switch to in one step.
interface ModelPreset { name: string, models: Record<string, ModelChoice>, savedAt: string }

let panelEl: HTMLElement | null = null
let publishing: PublishingSection | null = null
let orgInput: HTMLInputElement | null = null
let meInput: HTMLInputElement | null = null
let agentInput: HTMLInputElement | null = null
let tzSelect: HTMLSelectElement | null = null
let branchPrefixInput: HTMLInputElement | null = null
let idleTimeoutInput: HTMLInputElement | null = null
let maxConcurrentLocalTurnsInput: HTMLInputElement | null = null
let updateTurnBoundInput: HTMLInputElement | null = null
let saveBtn: HTMLButtonElement | null = null
let helpEl: HTMLElement | null = null
let modelsEl: HTMLElement | null = null
let fixedEl: HTMLElement | null = null
let catalogStatusEl: HTMLElement | null = null
let productionEl: HTMLElement | null = null
let refreshBtn: HTMLButtonElement | null = null
let notificationsPicker: HTMLElement | null = null
let notificationsStatusEl: HTMLElement | null = null
// A model select someone has changed keeps its value across background
// reloads until Save, exactly like the text fields keep typed text.
const dirtyModels = new Set<string>()
const dirtyFields = new Set<HTMLInputElement | HTMLSelectElement>()
// The values this tab read, captured per top-level settings field when its
// first draft is made. A save carries them as `expect`, so another tab's edit
// to the same field is refused with 409 instead of silently overwritten.
const saveBaselines = new Map<string, unknown>()
// A refused save's read-again offer: the section it was saving, the leaves
// that moved elsewhere, and whether each conflict refresh landed — Read again
// prefers the refresh over the 409's snapshot when it did.
let pendingConflict: { section: 'general' | 'models', leaves: ConflictLeaf[], generalRefreshed: boolean, modelsRefreshed: boolean } | null = null
let rereadBtn: HTMLButtonElement | null = null
let modelRefreshActive = false
let modelsGeneration = 0
// Bumped by each saved or deleted configuration: a catalog read that started before it brings older ones.
let presetsGeneration = 0
let lastModels: ModelsResponse | null = null
let accountsEl: HTMLElement | null = null
let accountsStatusEl: HTMLElement | null = null
let terminalSlot: HTMLElement | null = null
let shellBtn: HTMLButtonElement | null = null
let accounts: ConnectedAccount[] | null = null
let accountsGeneration = 0
let accountsLoading: Promise<void> | null = null
let terminal: TerminalPanel | null = null
let terminalOpening = false

async function refreshStatus(): Promise<void> {
  const before = getOrganizations().filter((org) => org.status === 'ready').map((org) => org.login).join(',')
  await loadSettings()
  syncFieldsFromCache()
  renderOrganizations()
  // The gh row marks your account and the agent account as saved now.
  renderAccounts()
  const after = getOrganizations().filter((org) => org.status === 'ready').map((org) => org.login).join(',')
  if (before !== after) {
    window.dispatchEvent(new CustomEvent('poise:organizations-changed'))
    window.dispatchEvent(new CustomEvent('poise:synced'))
  }
}

function syncFieldsFromCache() {
  const s = getCachedSettings()
  // openSettingsPanel kicks off a refresh it does not await, so on first run
  // its response lands a moment after the panel opens — straight over the
  // first characters someone has already typed into an empty field. Only fill
  // a field the person is not currently in.
  const active = document.activeElement
  // A synced input shows a fresh read, so its baseline moves with it: the
  // next draft is based on what is shown. Drafted and focused fields keep
  // both their text and their baseline.
  const synced = (input: HTMLInputElement | HTMLSelectElement | null): input is HTMLInputElement | HTMLSelectElement =>
    !!input && input !== active && !dirtyFields.has(input)
  if (synced(meInput)) {
    meInput.value = s.me
    saveBaselines.set('me', s.me)
  }
  if (synced(agentInput)) {
    agentInput.value = s.agentAccount ?? ''
    saveBaselines.set('agentAccount', s.agentAccount ?? '')
  }
  if (synced(tzSelect)) {
    const fallback = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } })()
    tzSelect.value = ensureTimezoneOption(s.timezone || fallback)
    // The stored zone, not the displayed fallback: the server holds '' while
    // nothing is saved, and the fallback would 409 against it.
    saveBaselines.set('timezone', s.timezone)
  }
  // The chat baseline is whole: it moves only when every chat input synced,
  // so a draft keeps the basis it was written against.
  let chatSynced = true
  if (synced(branchPrefixInput)) branchPrefixInput.value = s.chat?.branchPrefix ?? CHAT_DEFAULTS.branchPrefix
  else chatSynced = false
  if (synced(idleTimeoutInput)) idleTimeoutInput.value = String(s.chat?.idleTimeoutMinutes ?? CHAT_DEFAULTS.idleTimeoutMinutes)
  else chatSynced = false
  if (synced(maxConcurrentLocalTurnsInput)) maxConcurrentLocalTurnsInput.value = String(s.chat?.maxConcurrentLocalTurns ?? CHAT_DEFAULTS.maxConcurrentLocalTurns)
  else chatSynced = false
  if (synced(updateTurnBoundInput)) updateTurnBoundInput.value = String(s.chat?.updateTurnBoundMinutes ?? CHAT_DEFAULTS.updateTurnBoundMinutes)
  else chatSynced = false
  if (chatSynced) saveBaselines.set('chat', { ...(s.chat ?? CHAT_DEFAULTS) })
  showNotificationsChoice(s.notifications?.enabled !== false)
}

function showNotificationsChoice(enabled: boolean): void {
  notificationsPicker?.querySelectorAll<HTMLButtonElement>('[data-notifications]').forEach((button) => {
    const on = (button.dataset.notifications === 'on') === enabled
    button.classList.toggle('active', on)
    button.setAttribute('aria-pressed', on ? 'true' : 'false')
  })
}

// Notifications apply at once, like the theme, but are kept by the server: the
// check behind them runs there, whether or not a page is open. Choices are
// saved one at a time, so the last one made is the one kept.
const saveNotifications = sendLatest(async (enabled: boolean) => {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notifications: { enabled } }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || typeof data !== 'object') throw new Error((data as { error?: string } | null)?.error || `HTTP ${res.status}`)
  setLocalSettings(data)
  // The response carries full settings, which may be newer than the display.
  syncFieldsFromCache()
  window.dispatchEvent(new CustomEvent('poise:notifications-changed'))
}, (error, enabled) => {
  showNotificationsChoice(getCachedSettings().notifications?.enabled !== false)
  if (notificationsStatusEl) {
    notificationsStatusEl.textContent = `Notifications were not turned ${enabled ? 'on' : 'off'}: ${(error as Error).message}`
    notificationsStatusEl.hidden = false
  }
})

function setNotifications(enabled: boolean): void {
  showNotificationsChoice(enabled)
  if (notificationsStatusEl) {
    notificationsStatusEl.textContent = ''
    notificationsStatusEl.hidden = true
  }
  saveNotifications(enabled)
}

// A <select> silently renders blank when told to show a value it has no option
// for — and the engine's list is not guaranteed to contain the browser's own
// zone, nor did the fallback list contain plain UTC in every branch. A blank
// timezone then saves as an empty string and the day-boundary filters quietly
// fall back to the machine zone. Add the value rather than show nothing.
function ensureTimezoneOption(zone: string): string {
  if (!tzSelect || !zone) return zone
  const has = [...tzSelect.options].some((o) => o.value === zone)
  if (!has) {
    const opt = document.createElement('option')
    opt.value = zone
    opt.textContent = zone
    tzSelect.insertBefore(opt, tzSelect.firstChild)
  }
  return zone
}

function setHelp(text: string, cls: 'info' | 'error' | 'ok' = 'info') {
  if (!helpEl) return
  helpEl.textContent = text
  // Keep st-status: assigning className wholesale dropped it, so the node lost
  // the class that identifies it after the very first message.
  helpEl.className = `st-help st-help-${cls} st-status`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function helpAttributes(text: string): string {
  return `data-help="${escapeHtml(text)}" tabindex="0"`
}

let organizationsPollTimer: ReturnType<typeof setTimeout> | null = null
let organizationsPollGeneration = 0
let organizationAdding = false
let organizationsRendered = ''
const ORGANIZATION_STAGES: Record<string, string> = {
  queued: 'Waiting to activate…',
  authenticating: 'Checking GitHub access…',
  indexing: 'Indexing repositories…',
  'building-user': 'Preparing your issues and pull requests…',
  syncing: 'Syncing repositories…',
  checking: 'Checking the datastore…',
  reconciling: 'Preparing account…',
}

function organizationStatus(text: string, failed = false): void {
  const status = panelEl?.querySelector<HTMLElement>('.st-org-status')
  if (!status) return
  status.textContent = text
  status.className = `st-help st-help-${failed ? 'error' : 'info'} st-org-status`
}

function renderOrganizations(): void {
  const list = panelEl?.querySelector<HTMLElement>('.st-organizations')
  if (!list) return
  const organizations = getOrganizations()
  const waiting = organizations.map((org) => org.stage === 'rate-limited' && !!org.retryAt && Date.parse(org.retryAt) > Date.now())
  // The day and zone too, so a retry time follows a newly saved zone.
  const rendered = JSON.stringify([organizations, organizationAdding, waiting, clockDay(effectiveTimezone(), Date.now())])
  if (organizationsRendered === rendered) return
  organizationsRendered = rendered
  patchInformation(list, organizations.map((org, index) => {
    const paused = waiting[index]
    // With its second: GitHub's reset is not on the minute.
    const resetTime = paused ? logTime(org.retryAt!, effectiveTimezone(), Date.now()) : ''
    const state = paused ? 'Waiting for GitHub' : org.status === 'ready' ? org.error ? 'Sync failed' : 'Ready' : org.status === 'error' ? 'Activation failed' : 'Activating…'
    return `
    <div class="st-organization" data-org="${escapeHtml(org.login)}">
      <div class="st-organization-name">${escapeHtml(org.login)}<span class="st-org-state st-org-state-${paused ? 'initializing' : org.error ? 'error' : org.status}">${state}</span></div>
      ${paused ? `<div class="st-help st-help-info">GitHub API limit reached. ${org.activatedAt ? 'Sync' : 'Activation'} resumes automatically at ${escapeHtml(resetTime)}.</div>` : org.status === 'initializing' ? `<div class="st-help st-help-info">${escapeHtml(ORGANIZATION_STAGES[org.stage] || org.stage || 'Preparing account…')}</div>` : ''}
      ${!paused && (org.status === 'error' || org.error) ? `<div class="st-help st-help-error">${escapeHtml(org.error || 'Activation failed. Try again.')}</div>` : ''}
      ${org.status === 'error' || org.error || paused ? `<button type="button" class="st-clear" data-retry-org="${escapeHtml(org.login)}"${organizationAdding || paused ? ' disabled' : ''}>Retry</button>` : ''}
    </div>`
  }).join('') || '<div class="st-help st-help-info">No GitHub accounts added yet.</div>')
}

async function pollOrganizations(): Promise<void> {
  const generation = ++organizationsPollGeneration
  if (organizationsPollTimer) clearTimeout(organizationsPollTimer)
  organizationsPollTimer = null
  try {
    const res = await fetch('/api/organizations')
    if (!res.ok) throw new Error(`Could not refresh GitHub accounts (HTTP ${res.status}).`)
    const data = await res.json() as { organizations?: Organization[] }
    if (generation !== organizationsPollGeneration) return
    if (Array.isArray(data.organizations)) {
      setOrganizations(data.organizations)
      renderOrganizations()
    }
  } catch (error) {
    if (generation === organizationsPollGeneration) organizationStatus((error as Error).message, true)
  } finally {
    if (generation === organizationsPollGeneration && panelEl?.classList.contains('open')) {
      organizationsPollTimer = setTimeout(() => { void pollOrganizations() }, 1500)
    }
  }
}

async function addOrganization(retry?: string): Promise<void> {
  if (!orgInput || organizationAdding || saving) return
  const org = retry || orgInput.value.trim()
  if (!GITHUB_NAME.test(org) || org.includes('--')) {
    organizationStatus('Enter an organization name or personal GitHub username, not a URL.', true)
    orgInput.focus()
    return
  }
  if (!getCachedSettings().me || meInput?.value.trim() !== getCachedSettings().me) {
    await saveGeneral()
    if (!getCachedSettings().me || meInput?.value.trim() !== getCachedSettings().me) {
      organizationStatus('Save your valid GitHub username before adding an account.', true)
      return
    }
  }
  organizationAdding = true
  const button = panelEl?.querySelector<HTMLButtonElement>('.st-add-organization')
  if (button) button.disabled = true
  renderOrganizations()
  organizationStatus(retry ? `Retrying ${org}…` : `Adding ${org}…`)
  // An earlier poll must not restore the list from before this addition.
  organizationsPollGeneration++
  if (organizationsPollTimer) clearTimeout(organizationsPollTimer)
  organizationsPollTimer = null
  try {
    const res = await fetch(retry ? `/api/organizations/${encodeURIComponent(org)}/retry` : '/api/organizations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org }),
    })
    const data = await res.json() as { organizations?: Organization[], error?: string }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    if (Array.isArray(data.organizations)) setOrganizations(data.organizations)
    if (!retry) orgInput.value = ''
    organizationStatus('Activation continues if you close Settings.')
  } catch (error) {
    organizationStatus((error as Error).message, true)
  } finally {
    organizationAdding = false
    if (button) button.disabled = false
    renderOrganizations()
    if (panelEl?.classList.contains('open')) void pollOrganizations()
  }
}

// ── Production ──────────────────────────────────────────────────────────

function renderProduction(update: ProductionUpdate) {
  if (!productionEl) return
  const summary = productionSummary(update, Date.now(), effectiveTimezone())
  const group = productionEl.closest<HTMLElement>('.st-production-group')
  if (!summary) {
    if (group) group.hidden = true
    productionEl.textContent = ''
    return
  }
  productionEl.textContent = summary.text
  productionEl.className = `st-help st-help-${summary.level} st-production`
  // The launchd updater and its desktop notification do not exist in service mode.
  const updater = group?.querySelector<HTMLElement>('.st-production-updater')
  if (updater) updater.hidden = update.status === 'off'
  if (group) group.hidden = false
}

async function loadProduction(): Promise<void> {
  if (!productionEl) return
  try {
    // 503 still carries the body; a degraded runtime must not blank this line.
    const res = await fetch('/api/health')
    const data = await res.json() as { production?: ProductionUpdate }
    if (data.production) renderProduction(data.production)
  } catch {
    // Leave whatever was shown; the next open tries again.
  }
}

// ── Storage ─────────────────────────────────────────────────────────────

interface StorageCategoryJson { key: string, label: string, path: string, bytes: number }
interface StorageStatusJson {
  categories: StorageCategoryJson[]
  disk: { path: string, totalBytes: number, freeBytes: number, usedPercent: number }
  pressure: boolean
  lastRun: { finishedAt: string, dryRun: boolean, reclaimedBytes: number, held: Array<{ path: string, reason: string }>, errors: unknown[] } | null
}
interface MaintenanceRunJson {
  reclaimedBytes: number
  removed: unknown[]
  pruned: unknown[]
  caches: unknown[]
  held: Array<{ path: string, reason: string }>
  errors: Array<{ message: string }>
}

let storageLoading: Promise<void> | null = null
let storageRunning = false

function storageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

function renderStorageBreakdown(categories: StorageCategoryJson[]): void {
  const breakdownEl = panelEl?.querySelector<HTMLElement>('.st-storage-breakdown')
  if (!breakdownEl) return
  breakdownEl.innerHTML = categories.map((category) =>
    `<div class="st-storage-row"><span>${escapeHtml(category.label)}</span><span>${escapeHtml(storageSize(category.bytes))}</span></div>`).join('')
}

function renderStorage(data: StorageStatusJson): void {
  const statusEl = panelEl?.querySelector<HTMLElement>('.st-storage-status')
  if (!statusEl) return
  const disk = data.disk
  const lines = [`${storageSize(disk.freeBytes)} free of ${storageSize(disk.totalBytes)} (${disk.usedPercent.toFixed(0)}% used).`]
  if (data.lastRun) {
    const run = data.lastRun
    lines.push(`Last maintenance ${run.dryRun ? '(dry run) ' : ''}${shortTime(run.finishedAt, effectiveTimezone(), Date.now())}:`
      + ` reclaimed ${storageSize(run.reclaimedBytes)}, held ${run.held.length}.`)
  } else {
    lines.push('Maintenance has not run yet.')
  }
  statusEl.textContent = lines.join(' ')
  statusEl.className = `st-help st-help-${data.pressure ? 'warn' : 'info'} st-storage-status`
  renderStorageBreakdown(data.categories)
}

function storageError(message: string): void {
  const statusEl = panelEl?.querySelector<HTMLElement>('.st-storage-status')
  if (!statusEl) return
  statusEl.textContent = message
  statusEl.className = 'st-help st-help-error st-storage-status'
}

async function fetchStorage(): Promise<StorageStatusJson | null> {
  try {
    const res = await fetch('/api/storage')
    const data = await res.json() as StorageStatusJson & { error?: string }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  } catch {
    // Leave whatever was shown; the next open tries again.
    return null
  }
}

async function loadStorage(): Promise<void> {
  if (!panelEl || storageRunning) return
  storageLoading ??= (async () => {
    try {
      const data = await fetchStorage()
      if (data) renderStorage(data)
    } finally {
      storageLoading = null
    }
  })()
  await storageLoading
}

async function runStorageMaintenance(dryRun: boolean): Promise<void> {
  if (!panelEl || storageRunning) return
  storageRunning = true
  for (const button of panelEl.querySelectorAll<HTMLButtonElement>('.st-storage-run, .st-storage-dry-run')) button.disabled = true
  try {
    const res = await fetch('/api/storage/maintenance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun }),
    })
    const data = await res.json() as MaintenanceRunJson & { error?: string }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    const statusEl = panelEl.querySelector<HTMLElement>('.st-storage-status')
    if (statusEl) {
      const held = data.held.length ? ` Held: ${data.held.slice(0, 3).map((item) => `${item.path} (${item.reason})`).join('; ')}${data.held.length > 3 ? '…' : ''}` : ''
      const errors = data.errors.length ? ` ${data.errors.length} error${data.errors.length === 1 ? '' : 's'}.` : ''
      statusEl.textContent = `${dryRun ? 'Dry run' : 'Maintenance'} reclaimed ${storageSize(data.reclaimedBytes)}`
        + ` (${data.removed.length} removed, ${data.pruned.length} pruned, ${data.caches.length} cache${data.caches.length === 1 ? '' : 's'} capped).${held}${errors}`
      statusEl.className = `st-help st-help-${data.errors.length ? 'warn' : 'ok'} st-storage-status`
    }
    // Fresh sizes under the run's own result line.
    const fresh = await fetchStorage()
    if (fresh) renderStorageBreakdown(fresh.categories)
  } catch (error) {
    storageError((error as Error).message)
  } finally {
    storageRunning = false
    for (const button of panelEl?.querySelectorAll<HTMLButtonElement>('.st-storage-run, .st-storage-dry-run') ?? []) button.disabled = false
  }
}

// ── Connected accounts tab ──────────────────────────────────────────────

// One login at a time from this panel; the server allows two terminals in
// all, across every open tab.
function terminalBusy(): boolean {
  return terminalOpening || !!terminal?.running
}

function renderAccounts(): void {
  const settings = getCachedSettings()
  if (accountsEl && accounts) patchInformation(accountsEl, accountsHtml(accounts, { me: settings.me, agentAccount: settings.agentAccount ?? '' }, terminalBusy()))
  if (shellBtn) shellBtn.disabled = terminalBusy()
}

function accountsStatus(text: string, failed = false): void {
  if (!accountsStatusEl) return
  accountsStatusEl.textContent = text
  accountsStatusEl.className = `st-help st-help-${failed ? 'error' : 'info'} st-accounts-status`
}

function accountChecksStatus(text: string, failed = false): void {
  const el = panelEl?.querySelector<HTMLElement>('.st-account-checks-status')
  if (!el) return
  el.textContent = text
  el.className = `st-help st-help-${failed ? 'error' : 'info'} st-account-checks-status`
}

let googleAccountsPanel: ReturnType<typeof googleAccountsSection> | null = null

function loadAccounts(force = false): Promise<void> {
  void googleAccountsPanel?.refresh()
  if (!accountsEl) return Promise.resolve()
  if (!force && accountsLoading) return accountsLoading
  const generation = ++accountsGeneration
  const pending = new Set<string>(ACCOUNT_IDS)
  const errors: string[] = []
  const status = () => accountChecksStatus([
    pending.size ? `Checking ${[...pending].join(', ')}…` : '', ...errors,
  ].filter(Boolean).join(' '), errors.length > 0)
  status()
  const loading = Promise.all(ACCOUNT_IDS.map(async id => {
    try {
      const next = await fetchAccounts(id)
      if (generation !== accountsGeneration) return
      const account = next.find(account => account.id === id)
      if (!account) throw new Error('the answer is missing this account')
      const byId = new Map((accounts ?? []).map(account => [account.id, account]))
      byId.set(id, account)
      accounts = ACCOUNT_IDS.flatMap(key => byId.has(key) ? [byId.get(key)!] : [])
      renderAccounts()
    } catch (error) {
      if (generation !== accountsGeneration) return
      errors.push(`Could not check ${id}: ${(error as Error).message}.`)
    } finally {
      if (generation === accountsGeneration) { pending.delete(id); status() }
    }
  })).then(() => undefined).finally(() => {
    if (accountsLoading === loading) accountsLoading = null
  })
  accountsLoading = loading
  return loading
}

function terminalTitle(preset: TerminalPreset): string {
  if (preset === 'shell') return 'Login shell'
  if (preset === 'muse-api-key') return MUSE_API_KEY_LOGIN.join(' ')
  return ACCOUNT_LOGINS[preset].join(' ')
}

async function connect(preset: TerminalPreset): Promise<void> {
  if (!panelEl || !terminalSlot) return
  if (terminalBusy()) {
    accountsStatus('A terminal is already open here; close it first.', true)
    terminal?.focus()
    return
  }
  // A finished terminal gives way to the new one.
  terminal?.dispose()
  terminalOpening = true
  accountsStatus('')
  renderAccounts()
  panelEl.classList.add('st-terminal-open')
  try {
    const { openTerminal } = await import('./views/terminal-panel')
    const opened = openTerminal({
      preset,
      title: terminalTitle(preset),
      // A login may have changed what the CLI's status says.
      onEnd: () => { renderAccounts(); void loadAccounts(true) },
      onDispose: () => {
        if (terminal === opened) terminal = null
        panelEl?.classList.remove('st-terminal-open')
        renderAccounts()
      },
    })
    terminal = opened
    terminalSlot.append(opened.element)
    scrollToActor(opened.element)
  } catch (error) {
    panelEl.classList.remove('st-terminal-open')
    accountsStatus(`Could not open the terminal: ${(error as Error).message}`, true)
  } finally {
    terminalOpening = false
    renderAccounts()
  }
}

function accountsTabSelected(): boolean {
  return panelEl?.dataset.section === 'accounts'
}

// A sign-in alert opens the workspace at CONNECTED_ACCOUNTS_PATH. The query is
// dropped once read, so reloading the page does not open Settings again.
function openFromAddress(): void {
  if (!panelEl) return
  const wanted = new URL(CONNECTED_ACCOUNTS_PATH, location.origin).searchParams
  const params = new URLSearchParams(location.search)
  if ([...wanted].some(([key, value]) => params.get(key) !== value)) return
  for (const key of wanted.keys()) params.delete(key)
  const query = params.toString()
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
  openSettingsPanel()
  selectSection(panelEl, 'accounts')
}

// ── Models tab ──────────────────────────────────────────────────────────

function modelOptions(models: CatalogModel[], place: ModelPlace, reviewProviders: string[], selected: string): string {
  // The server names the providers a place may launch; older servers only
  // said whether it reviews.
  const providers = place.providers !== undefined ? place.providers : place.review ? reviewProviders : null
  const eligible = providers ? models.filter((m) => providers.includes(m.provider)) : models
  return eligible
    .map((m) => `<option value="${escapeHtml(m.identity)}"${m.identity === selected ? ' selected' : ''}>${escapeHtml(m.identity)}</option>`)
    .join('')
}

function sectionChoice(section: HTMLElement): ModelChoice {
  const choice: ModelChoice = {
    default: section.querySelector<HTMLSelectElement>('.st-model-default')?.value || '',
    fallback: section.querySelector<HTMLSelectElement>('.st-model-fallback')?.value || '',
  }
  for (const slot of REVIEWER_SLOTS) {
    const value = section.querySelector<HTMLSelectElement>(`.st-model-${slot}`)?.value
    if (value) choice[slot] = value
  }
  return choice
}

// The stored model choices a save compares against: what the server held when
// this tab read the catalog. Cloned, so later renders cannot move it.
function storedModelsSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}
  for (const place of lastModels?.places ?? []) {
    if (place.stored) snapshot[place.key] = { ...place.stored }
  }
  return snapshot
}

function renderPlaces(data: ModelsResponse) {
  if (!modelsEl || !fixedEl) return
  const kept = new Map<string, ModelChoice>()
  for (const section of modelsEl.querySelectorAll<HTMLElement>('.st-place')) {
    const key = section.dataset.place || ''
    if (!dirtyModels.has(key)) continue
    kept.set(key, sectionChoice(section))
  }
  patchContent(modelsEl, data.places.map((place) => {
    const current: ModelChoice = kept.get(place.key)
      || { default: place.default, fallback: place.fallback, secondary: place.secondary, tertiary: place.tertiary }
    const providers = place.providers !== undefined ? place.providers : place.review ? data.catalog.review_providers : null
    const notes = place.notes.map((n) => `<div class="st-help st-help-${providers?.length === 0 ? 'error' : 'warn'}">${escapeHtml(n)}</div>`).join('')
    const reviewers = place.reviewers
      ? REVIEWER_SLOTS.map((slot) => `
        <label class="st-sublabel">${slot === 'secondary' ? 'Secondary reviewer' : 'Tertiary reviewer'}</label>
        <select class="st-select st-model-${slot}" aria-label="${escapeHtml(place.label)} ${slot} reviewer">${modelOptions(data.catalog.models, place, data.catalog.review_providers, current[slot] || '')}</select>`).join('')
      : ''
    return `
      <div class="tp-section st-place" data-place="${escapeHtml(place.key)}">
        <label class="tp-label" ${helpAttributes(place.why)}>${escapeHtml(place.label)}</label>
        <label class="st-sublabel">Default</label>
        <select class="st-select st-model-default" aria-label="${escapeHtml(place.label)} default model">${modelOptions(data.catalog.models, place, data.catalog.review_providers, current.default)}</select>
        <label class="st-sublabel" ${helpAttributes("Used when the default model cannot complete the request.")}>Fallback</label>
        <select class="st-select st-model-fallback" aria-label="${escapeHtml(place.label)} fallback model">${modelOptions(data.catalog.models, place, data.catalog.review_providers, current.fallback)}</select>
        ${reviewers}
        ${notes}
      </div>`
  }).join(''))
  for (const section of modelsEl.querySelectorAll<HTMLElement>('.st-place')) {
    section.onchange = () => {
      if (!saveBaselines.has('models')) saveBaselines.set('models', storedModelsSnapshot())
      dirtyModels.add(section.dataset.place || '')
    }
  }
  patchContent(fixedEl, data.fixed.map((place) => `
      <div class="tp-section">
        <label class="tp-label" ${helpAttributes(place.why)}>${escapeHtml(place.label)}</label>
        <div class="st-fixed-model"><code>${escapeHtml(place.model)}</code></div>
      </div>`).join(''))
  const fixedHeading = panelEl?.querySelector<HTMLElement>('.st-fixed-heading')
  if (fixedHeading) fixedHeading.hidden = data.fixed.length === 0
  renderCatalogStatus(data)
}

function renderCatalogStatus(data: ModelsResponse) {
  if (!catalogStatusEl || modelRefreshActive) return
  let line = `${data.catalog.models.length} models from Caller.`
  const report = data.refresh
  if (report) {
    const when = new Date(report.completed_at || report.checked_at || '')
    const stamp = Number.isNaN(when.getTime()) ? '' : ` Last checked ${shortTime(when.getTime(), effectiveTimezone(), Date.now())}.`
    const summary = modelRefreshSummary(report)
    const versions = Object.entries(report.cli_updates || {}).filter(([, item]) => item.after).map(([name, item]) => `${name} ${item.after}`).join(', ')
    line += `${stamp} ${summary.text}${versions ? ` CLI versions: ${versions}.` : ''}`
  } else line += ' Not checked yet; the daily check runs at 07:00.'
  catalogStatusEl.dataset.help = line
  catalogStatusEl.tabIndex = 0
  const failed = report && modelRefreshSummary(report).level === 'error'
  const checkedAt = report?.completed_at || report?.checked_at
  const when = checkedAt ? new Date(checkedAt) : null
  const checked = when && !Number.isNaN(when.getTime()) ? `Checked ${shortTime(when.getTime(), effectiveTimezone(), Date.now())}` : 'Checked'
  catalogStatusEl.textContent = failed
    ? modelRefreshSummary(report).text
    : `${data.catalog.models.length} models · ${report ? checked : 'Not checked yet'}`
  catalogStatusEl.classList.toggle('st-help-error', !!failed)
}

async function loadModels(signal?: AbortSignal): Promise<boolean> {
  if (!modelsEl) return false
  const generation = ++modelsGeneration
  const presetsAt = presetsGeneration
  try {
    const res = await fetch('/api/models', { signal })
    const data = await res.json()
    if (generation !== modelsGeneration) return false
    if (!res.ok) throw new Error(data.error || 'Model catalog unavailable')
    if (!data.catalog || !Array.isArray(data.catalog.models) || !Array.isArray(data.places) || !Array.isArray(data.fixed)) throw new Error('The model catalogue response is unreadable')
    const fresh = data as ModelsResponse
    if (presetsAt !== presetsGeneration) fresh.presets = lastModels?.presets ?? fresh.presets
    lastModels = fresh
    renderPlaces(lastModels)
    renderPresets(lastModels.presets ?? [])
    return true
  } catch (err) {
    if (generation !== modelsGeneration) return false
    const message = (err as Error).message
    if (!lastModels) modelsEl.innerHTML = `<div class="st-help st-help-error">${escapeHtml(message)}</div>`
    else setHelp(message + '; your model selections are kept.', 'error')
    return false
  }
}

function renderPresets(presets: ModelPreset[]): void {
  const select = panelEl?.querySelector<HTMLSelectElement>('.st-preset-select')
  if (!select) return
  const chosen = select.value
  select.innerHTML = presets.length
    ? presets.map((preset) => `<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</option>`).join('')
    : '<option value="">None saved</option>'
  select.disabled = !presets.length
  if (presets.some((preset) => preset.name === chosen)) select.value = chosen
  for (const button of panelEl!.querySelectorAll<HTMLButtonElement>('.st-preset-use, .st-preset-delete')) {
    button.disabled = !presets.length
    button.hidden = !presets.length
  }
}

// One configuration action at a time: overlapping saves, uses and deletes could
// answer out of order and bring back a deleted configuration or an earlier choice.
let presetBusy = false
async function presetAction(run: () => Promise<void>): Promise<void> {
  if (presetBusy || !panelEl) return
  presetBusy = true
  const buttons = [...panelEl.querySelectorAll<HTMLButtonElement>('.st-preset-save, .st-preset-use, .st-preset-delete')]
  for (const button of buttons) button.disabled = true
  try {
    await run()
  } finally {
    presetBusy = false
    panelEl.querySelector<HTMLButtonElement>('.st-preset-save')!.disabled = false
    renderPresets(lastModels?.presets ?? [])
  }
}

async function postPresets(path: string, body: unknown): Promise<ModelPreset[] | null> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json()
    if (!res.ok) { setHelp(data.error || 'The configurations were not changed', 'error'); return null }
    presetsGeneration++
    if (lastModels) lastModels.presets = data.presets
    renderPresets(data.presets)
    return data.presets as ModelPreset[]
  } catch (err) {
    setHelp('Network error: ' + (err as Error).message, 'error')
    return null
  }
}

async function savePreset(): Promise<void> {
  const input = panelEl?.querySelector<HTMLInputElement>('.st-preset-name')
  const name = input?.value.trim() || ''
  const models = collectModels()
  if (!name) { setHelp('Name the configuration first.', 'error'); return }
  if (!models) { setHelp('There are no model choices to save yet.', 'error'); return }
  if (await postPresets('/api/models/presets', { name, models })) {
    input!.value = ''
    panelEl!.querySelector<HTMLSelectElement>('.st-preset-select')!.value = name
    setHelp(`Saved the model choices as "${name}".`, 'ok')
  }
}

async function usePreset(): Promise<void> {
  const name = panelEl?.querySelector<HTMLSelectElement>('.st-preset-select')?.value || ''
  const preset = lastModels?.presets?.find((entry) => entry.name === name)
  if (!preset) return
  try {
    // Saved like the Save button saves: the server validates every choice against today's catalog.
    const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: preset.models }) })
    const data = await res.json()
    if (!res.ok) { setHelp(data.error || `"${name}" could not be used`, 'error'); return }
    dirtyModels.clear()
    saveBaselines.delete('models')
    setLocalSettings(data)
    // The response carries full settings, which may be newer than the display.
    syncFieldsFromCache()
    // Shown at once, so a Save before the reload below lands posts these choices, not the previous ones.
    if (lastModels) {
      for (const place of lastModels.places) {
        const choice = preset.models[place.key]
        // Stored too, mirroring the server's merge: a draft made after this
        // Use reads its baseline from it.
        if (choice) { Object.assign(place, choice); place.stored = { ...place.stored, ...choice } }
      }
      renderPlaces(lastModels)
    }
    setHelp(`Using "${name}".`, 'ok')
    window.dispatchEvent(new CustomEvent('poise:models-changed'))
    void loadModels()
  } catch (err) {
    setHelp('Network error: ' + (err as Error).message, 'error')
  }
}

async function deletePreset(): Promise<void> {
  const name = panelEl?.querySelector<HTMLSelectElement>('.st-preset-select')?.value || ''
  if (name && await postPresets('/api/models/presets/delete', { name })) setHelp(`Deleted "${name}".`, 'ok')
}

function collectModels(): Record<string, ModelChoice> | null {
  if (!modelsEl) return null
  const models: Record<string, ModelChoice> = {}
  for (const section of modelsEl.querySelectorAll<HTMLElement>('.st-place')) {
    const key = section.dataset.place || ''
    const choice = sectionChoice(section)
    if (!key || !choice.default || !choice.fallback) continue
    models[key] = choice
  }
  return Object.keys(models).length ? models : null
}

async function refreshModels(): Promise<void> {
  if (!refreshBtn || modelRefreshActive) return
  modelRefreshActive = true
  modelsGeneration++
  refreshBtn.disabled = true
  refreshBtn.textContent = 'Checking…'
  setHelp('')
  if (catalogStatusEl) {
    catalogStatusEl.classList.remove('st-help-error')
    delete catalogStatusEl.dataset.help
  }
  const started = Date.now()
  const controller = new AbortController()
  const progress = () => {
    const seconds = Math.floor((Date.now() - started) / 1000)
    if (catalogStatusEl) catalogStatusEl.textContent = `Updating provider CLIs, then checking models — ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} elapsed. Existing chats can continue.`
  }
  progress()
  const ticker = setInterval(progress, 1000)
  const deadline = setTimeout(() => controller.abort(), MODEL_CHECK_TIMEOUT_MS)
  let summary: { text: string, level: 'ok' | 'error' }
  try {
    const res = await fetch('/api/models/refresh', { method: 'POST', signal: controller.signal })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Model check failed')
    if (!data || typeof data !== 'object') throw new Error('The model check returned an unreadable report')
    if (!await loadModels(controller.signal)) throw new Error('The check finished, but the updated catalogue could not be loaded. Your selections are kept.')
    if (lastModels) lastModels.refresh = data as ModelRefreshReport
    summary = modelRefreshSummary(data as ModelRefreshReport)
    window.dispatchEvent(new Event('poise:models-updated'))
  } catch (err) {
    summary = { text: controller.signal.aborted ? 'Model check timed out. Latest CLI and model versions could not be confirmed; your selections are kept. Check now is available to retry.' : `Model check failed: ${(err as Error).message}`, level: 'error' }
  } finally {
    clearInterval(ticker); clearTimeout(deadline)
    modelRefreshActive = false
    refreshBtn.disabled = false
    refreshBtn.textContent = 'Check now'
  }
  if (lastModels) renderCatalogStatus(lastModels)
  if (summary.level === 'error' && catalogStatusEl) {
    catalogStatusEl.textContent = summary.text
    catalogStatusEl.classList.add('st-help-error')
  }
  setHelp(summary.text, summary.level)
}

// ── Save ────────────────────────────────────────────────────────────────

// Disabling the button is not a guard on its own: Enter in any field calls
// the save directly and never looks at it, so a repeated Enter fired a POST
// and a full view remount each time.
let saving = false

// A save carries only the active section's drafts: a Models save neither
// commits nor is blocked by General drafts, and the reverse. Untouched fields
// are never sent, so another tab's edits to them survive this save.

// The first draft under a top-level field captures what this tab read for the
// save's `expect`.
function markGeneralDirty(field: HTMLInputElement | HTMLSelectElement, top: GeneralTopField): void {
  if (!saveBaselines.has(top)) {
    const cached = getCachedSettings()
    if (top === 'chat') saveBaselines.set(top, { ...(cached.chat ?? CHAT_DEFAULTS) })
    else if (top === 'agentAccount') saveBaselines.set(top, cached.agentAccount ?? '')
    else saveBaselines.set(top, cached[top])
  }
  dirtyFields.add(field)
}

// An emptied field is not a zero: Number('') is 0, which the idle timeout now
// reads as "no idle expiry". NaN keeps it refused, as before.
function readWholeMinutes(input: HTMLInputElement | null, fallback: number): number {
  if (!input) return fallback
  const raw = input.value.trim()
  return raw === '' ? NaN : Number(raw)
}

function readGeneralDraft(): GeneralDraft {
  return {
    me: meInput?.value.trim() ?? '',
    agentAccount: agentInput?.value.trim() ?? '',
    timezone: tzSelect?.value ?? '',
    branchPrefix: (branchPrefixInput?.value ?? CHAT_DEFAULTS.branchPrefix).trim() || CHAT_DEFAULTS.branchPrefix,
    idleTimeoutMinutes: readWholeMinutes(idleTimeoutInput, CHAT_DEFAULTS.idleTimeoutMinutes),
    maxConcurrentLocalTurns: readWholeMinutes(maxConcurrentLocalTurnsInput, CHAT_DEFAULTS.maxConcurrentLocalTurns),
    updateTurnBoundMinutes: readWholeMinutes(updateTurnBoundInput, CHAT_DEFAULTS.updateTurnBoundMinutes),
  }
}

function generalInput(field: GeneralField): HTMLInputElement | HTMLSelectElement | null {
  switch (field) {
    case 'me': return meInput
    case 'agentAccount': return agentInput
    case 'timezone': return tzSelect
    case 'branchPrefix': return branchPrefixInput
    case 'idleTimeoutMinutes': return idleTimeoutInput
    case 'maxConcurrentLocalTurns': return maxConcurrentLocalTurnsInput
    case 'updateTurnBoundMinutes': return updateTurnBoundInput
  }
}

function topInputs(top: GeneralTopField): Array<HTMLInputElement | HTMLSelectElement | null> {
  return top === 'chat'
    ? [branchPrefixInput, idleTimeoutInput, maxConcurrentLocalTurnsInput, updateTurnBoundInput]
    : [generalInput(top)]
}

function generalDirtyFields(): Set<GeneralField> {
  const dirty = new Set<GeneralField>()
  for (const field of ['me', 'agentAccount', 'timezone', 'branchPrefix', 'idleTimeoutMinutes', 'maxConcurrentLocalTurns', 'updateTurnBoundMinutes'] as const) {
    const input = generalInput(field)
    if (input && dirtyFields.has(input)) dirty.add(field)
  }
  return dirty
}

function saveActiveSection(): void {
  if (panelEl?.dataset.section === 'models') void saveModels()
  else void saveGeneral()
}

async function saveGeneral(): Promise<void> {
  if (!saveBtn || !meInput || !agentInput || !tzSelect) return
  if (saving) return
  // A new save attempt supersedes the offered read-again; drafts are kept either way.
  dismissReread()
  const cached = getCachedSettings()
  const draft = readGeneralDraft()
  const dirty = generalDirtyFields()
  const problem = validateGeneralDraft(draft, { me: cached.me, agentAccount: cached.agentAccount ?? '' }, dirty)
  if (problem) {
    setHelp(problem.message, 'error')
    generalInput(problem.field)?.focus()
    return
  }
  const payload = generalPayload(draft, dirty, saveBaselines)
  if (!payload) {
    setHelp('No changes to save.', 'info')
    return
  }

  saving = true
  const savedValues = new Map([...dirty].map((field) => generalInput(field))
    .filter((input) => input !== null).map((input) => [input, input.value] as const))
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving…'
  try {
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload.body, ...(Object.keys(payload.expect).length > 0 ? { expect: payload.expect } : {}) }),
    })
    const data = await res.json()
    const conflicted = res.status === 409 ? conflictCurrent(data) : null
    if (conflicted) {
      await handleConflict('general', conflicted)
      return
    }
    if (!res.ok) {
      setHelp(data.error || 'Failed to save settings', 'error')
      return
    }
    for (const [input, value] of savedValues) {
      if (input.value === value) dirtyFields.delete(input)
    }
    for (const top of payload.fields) {
      if (topInputs(top).every((input) => !input || !dirtyFields.has(input))) saveBaselines.delete(top)
      else saveBaselines.set(top, mergeSaveBaseline(saveBaselines.get(top), payload.body[top]))
    }
    setLocalSettings(data)
    // Untouched inputs show what the save response carries: another tab's
    // edit that landed in it must be seen before the next draft is based on
    // it. Drafts are skipped, as on every sync.
    syncFieldsFromCache()
    renderOrganizations()
    renderAccounts()
    setHelp('Saved.', 'ok')
    window.dispatchEvent(new CustomEvent('poise:synced'))
    window.dispatchEvent(new CustomEvent('poise:models-changed'))
  } catch (err) {
    setHelp('Network error: ' + (err as Error).message, 'error')
  } finally {
    saving = false
    saveBtn.disabled = false
    saveBtn.textContent = 'Save'
  }
}

async function saveModels(): Promise<void> {
  if (!saveBtn || !modelsEl) return
  if (saving) return
  dismissReread()
  const sections = [...modelsEl.querySelectorAll<HTMLElement>('.st-place')]
  if (sections.length === 0) {
    setHelp('Model choices have not loaded yet.', 'info')
    return
  }
  const changes: Record<string, ModelChoice> = {}
  for (const section of sections) {
    const key = section.dataset.place || ''
    if (!key || !dirtyModels.has(key)) continue
    const choice = sectionChoice(section)
    if (!choice.default || !choice.fallback) continue
    changes[key] = choice
  }
  if (Object.keys(changes).length === 0) {
    setHelp('No changes to save.', 'info')
    return
  }
  const problem = validateModelChoices(changes)
  if (problem) {
    setHelp(problem, 'error')
    return
  }

  saving = true
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving…'
  try {
    const baseline = saveBaselines.get('models')
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: changes, ...(baseline === undefined ? {} : { expect: { models: baseline } }) }),
    })
    const data = await res.json()
    const conflicted = res.status === 409 ? conflictCurrent(data) : null
    if (conflicted) {
      await handleConflict('models', conflicted)
      return
    }
    if (!res.ok) {
      setHelp(data.error || 'Failed to save settings', 'error')
      return
    }
    for (const [key, sent] of Object.entries(changes)) {
      const section = modelsEl.querySelector<HTMLElement>(`.st-place[data-place="${CSS.escape(key)}"]`)
      if (section && deepEqual(sectionChoice(section), sent)) dirtyModels.delete(key)
    }
    if (dirtyModels.size === 0) saveBaselines.delete('models')
    else saveBaselines.set('models', mergeSaveBaseline(saveBaselines.get('models'), changes))
    // Stored mirrors the save at once, mirroring the server's merge: a draft
    // made before the reload below lands reads its baseline from it, not from
    // the pre-save catalog.
    if (lastModels) {
      for (const [key, sent] of Object.entries(changes)) {
        const place = lastModels.places.find((entry) => entry.key === key)
        if (place) place.stored = { ...place.stored, ...sent }
      }
    }
    setLocalSettings(data)
    syncFieldsFromCache()
    renderOrganizations()
    renderAccounts()
    setHelp('Saved.', 'ok')
    window.dispatchEvent(new CustomEvent('poise:synced'))
    window.dispatchEvent(new CustomEvent('poise:models-changed'))
    void loadModels()
  } catch (err) {
    setHelp('Network error: ' + (err as Error).message, 'error')
  } finally {
    saving = false
    saveBtn.disabled = false
    saveBtn.textContent = 'Save'
  }
}

function conflictCurrent(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null
  const current = (data as { current?: unknown }).current
  return isRecord(current) ? current : null
}

// Another tab saved the same field first: the server refused and sent what it
// holds. Drafts stay put for an intentional retry; everything unedited is
// read again at once, and Read again offers the saved values for the rest.
async function handleConflict(section: 'general' | 'models', current: Record<string, unknown>): Promise<void> {
  const leaves = conflictLeaves(current, saveBaselines)
  // Baselines move to what the server holds, so Save again retries with intent.
  for (const [field, value] of Object.entries(current)) saveBaselines.set(field, value)
  await loadSettings({ fresh: true })
  const generalRefreshed = settingsLoadOk()
  syncFieldsFromCache()
  const modelsRefreshed = section === 'models' ? await loadModels() : false
  renderOrganizations()
  renderAccounts()
  pendingConflict = { section, leaves, generalRefreshed, modelsRefreshed }
  if (rereadBtn) rereadBtn.hidden = false
  setHelp(conflictMessage(leaves), 'error')
}

function dismissReread(): void {
  pendingConflict = null
  if (rereadBtn) rereadBtn.hidden = true
}

function applyReread(): void {
  const conflict = pendingConflict
  dismissReread()
  if (!conflict) return
  const cached = getCachedSettings()
  for (const entry of conflict.leaves) {
    const value = entry.field === 'models' ? entry.current : rereadValue(entry.field, entry.leaf, entry.current, cached, conflict.generalRefreshed)
    revertConflictLeaf({ ...entry, current: value })
  }
  // The re-render reads the catalog: without a landed reload it still holds
  // pre-conflict choices, so the 409's saved choices are applied first.
  if (!conflict.modelsRefreshed) {
    for (const entry of conflict.leaves) {
      if (entry.field !== 'models') continue
      if (entry.leaf === null && isRecord(entry.current)) {
        for (const [key, choice] of Object.entries(entry.current)) updateStoredChoice(key, choice)
      } else if (entry.leaf !== null) {
        updateStoredChoice(entry.leaf, entry.current)
      }
    }
  }
  if (conflict.leaves.some((entry) => entry.field === 'models') && lastModels) renderPlaces(lastModels)
  // Baselines clear only past a landed refresh: without one the cache still
  // holds pre-conflict values, and the kept 409 baselines stay the newest
  // known server state for the next draft.
  if (conflict.generalRefreshed) {
    for (const [input, top] of [[meInput, 'me'], [agentInput, 'agentAccount'], [tzSelect, 'timezone']] as const) {
      if (input && !dirtyFields.has(input)) saveBaselines.delete(top)
    }
    if ([branchPrefixInput, idleTimeoutInput, maxConcurrentLocalTurnsInput, updateTurnBoundInput].every((input) => !input || !dirtyFields.has(input))) {
      saveBaselines.delete('chat')
    }
  }
  if (conflict.modelsRefreshed && dirtyModels.size === 0) saveBaselines.delete('models')
  setHelp('Read the latest saved values.', 'info')
}

// A saved model choice from the 409, written into the catalog the re-render
// and later baselines read. The server replaces each place's stored choice
// whole, so this replaces whole too.
function updateStoredChoice(key: string, choice: unknown): void {
  if (!isRecord(choice) || typeof choice.default !== 'string' || typeof choice.fallback !== 'string') return
  const place = lastModels?.places.find((entry) => entry.key === key)
  if (!place) return
  const stored = {
    default: choice.default,
    fallback: choice.fallback,
    ...(typeof choice.secondary === 'string' ? { secondary: choice.secondary } : {}),
    ...(typeof choice.tertiary === 'string' ? { tertiary: choice.tertiary } : {}),
  }
  place.default = stored.default
  place.fallback = stored.fallback
  place.secondary = stored.secondary
  place.tertiary = stored.tertiary
  place.stored = stored
}

function revertConflictLeaf(entry: ConflictLeaf): void {
  const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
  if (entry.leaf === null) {
    if (entry.field === 'me' && meInput) {
      meInput.value = text(entry.current)
      dirtyFields.delete(meInput)
    } else if (entry.field === 'agentAccount' && agentInput) {
      agentInput.value = text(entry.current)
      dirtyFields.delete(agentInput)
    } else if (entry.field === 'timezone' && tzSelect) {
      tzSelect.value = ensureTimezoneOption(text(entry.current))
      dirtyFields.delete(tzSelect)
    } else if (entry.field === 'chat') {
      // A whole-section leaf, reached only when shapes differ: every drafted
      // chat field takes the saved value.
      const current = isRecord(entry.current) ? entry.current : {}
      const cached = getCachedSettings().chat ?? CHAT_DEFAULTS
      const saved = (key: 'branchPrefix' | 'idleTimeoutMinutes' | 'maxConcurrentLocalTurns' | 'updateTurnBoundMinutes'): string => {
        const value = current[key] ?? cached[key]
        return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
      }
      const pairs = [[branchPrefixInput, saved('branchPrefix')], [idleTimeoutInput, saved('idleTimeoutMinutes')], [maxConcurrentLocalTurnsInput, saved('maxConcurrentLocalTurns')], [updateTurnBoundInput, saved('updateTurnBoundMinutes')]] as const
      for (const [input, value] of pairs) {
        if (input && dirtyFields.has(input)) {
          input.value = value
          dirtyFields.delete(input)
        }
      }
    } else if (entry.field === 'models') {
      dirtyModels.clear()
    }
    return
  }
  if (entry.field === 'chat') {
    const input = entry.leaf === 'branchPrefix' ? branchPrefixInput
      : entry.leaf === 'idleTimeoutMinutes' ? idleTimeoutInput
        : entry.leaf === 'maxConcurrentLocalTurns' ? maxConcurrentLocalTurnsInput
          : entry.leaf === 'updateTurnBoundMinutes' ? updateTurnBoundInput : null
    if (input) {
      input.value = text(entry.current)
      dirtyFields.delete(input)
    }
    return
  }
  if (entry.field === 'models') dirtyModels.delete(entry.leaf)
}

function timezoneOptions(): string[] {
  try {
    const fn = (Intl as any).supportedValuesOf
    if (typeof fn === 'function') return fn('timeZone') as string[]
  } catch { /* ignore */ }
  return ['UTC', 'Europe/Helsinki', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Singapore']
}

export type SettingsSection = 'general' | 'models' | 'accounts' | 'publishing' | 'navigation' | 'admin'

function selectSection(panel: HTMLElement, tab: SettingsSection) {
  if (!panel.querySelector(`.st-tab[data-tab="${tab}"]`)) return
  panel.dataset.section = tab
  const title = tab[0].toUpperCase() + tab.slice(1)
  panel.querySelector('.tp-title')!.textContent = title
  panel.setAttribute('aria-label', `Settings: ${title}`)
  for (const section of panel.querySelectorAll<HTMLElement>('.st-tab')) {
    section.hidden = section.dataset.tab !== tab
  }
  panel.querySelector<HTMLElement>('.st-footer')!.hidden = tab === 'accounts' || tab === 'publishing' || tab === 'navigation' || tab === 'admin'
  if (panel.classList.contains('open')) {
    if (tab === 'accounts') void loadAccounts()
    if (tab === 'publishing') void publishing?.refresh()
    if (tab === 'general') void loadStorage()
  }
  window.dispatchEvent(new CustomEvent('poise:settings-section-changed', { detail: { section: tab } }))
}

function buildPanel(): HTMLElement {
  const panel = document.createElement('aside')
  panel.id = 'settings-panel'
  panel.dataset.section = 'general'
  panel.setAttribute('aria-label', 'Settings: General')

  const tzList = timezoneOptions()
  const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } })()
  const tzOptionsHtml = tzList.map((z) => `<option value="${z}">${z}</option>`).join('')

  panel.innerHTML = `
    <div class="tp-header"><span class="tp-title">General</span></div>
    <div class="tp-body">

      <section class="st-tab" data-tab="general">
        <div class="tp-group-label">GitHub</div>

        <div class="tp-section">
          <label class="tp-label" for="st-username" ${helpAttributes("Shows the issues and pull requests you are involved in. Connect this GitHub account under Accounts.")}>Your GitHub account</label>
          <input id="st-username" type="text" class="st-input st-input-me" autocomplete="off" spellcheck="false" placeholder="octocat" />

        </div>

        <div class="tp-section">
          <label class="tp-label" for="st-agent-account" ${helpAttributes("The GitHub account that posts automated reviews and comments. Connect it under Accounts.")}>GitHub automation account</label>
          <input id="st-agent-account" type="text" class="st-input st-input-agent" autocomplete="off" spellcheck="false" />

        </div>

        <div class="tp-section">
          <label class="tp-label" for="st-organization" ${helpAttributes("Organizations and personal accounts to follow. Initial indexing can take a few minutes.")}>Following</label>
          <div class="st-organizations" aria-live="polite"></div>
          <div class="st-org-add-row">
            <input id="st-organization" type="text" class="st-input st-input-org" aria-label="New GitHub account" autocomplete="off" spellcheck="false" placeholder="acme-corp or octocat" />
            <button type="button" class="st-clear st-add-organization">Add</button>
          </div>

          <div class="st-help st-help-info st-org-status" role="status"></div>
        </div>

        <div class="tp-group-label">Time</div>

        <div class="tp-section">
          <label class="tp-label" for="st-timezone" ${helpAttributes("Sets the day and week boundaries in Current, Archive and Analytics, and the zone Poise shows times in.")}>Time zone</label>
          <select id="st-timezone" class="st-select st-input-tz">${tzOptionsHtml}</select>

        </div>

        <div class="tp-section">
          <label class="tp-label" id="st-refresh-label" ${helpAttributes("How often Current, Swarm and Archive read fresh data.")}>Refresh rate</label>
          <div class="range-picker st-refresh-picker" role="group" aria-labelledby="st-refresh-label">
            <button type="button" data-rate="1m" class="${getRefreshRate() === '1m' ? 'active' : ''}">1 min</button>
            <button type="button" data-rate="5m" class="${getRefreshRate() === '5m' ? 'active' : ''}">5 min</button>
          </div>

        </div>

        <div class="tp-group-label">Notifications</div>

        <div class="tp-section">
          <label class="tp-label" id="st-notifications-label" ${helpAttributes("Alerts for sign-ins, failed behaviors, chats waiting for you and pull requests ready to merge. Ready pull requests remind you every 15 minutes until merged or silenced.")}>Notifications</label>
          <div class="range-picker st-notifications-picker" role="group" aria-labelledby="st-notifications-label">
            <button type="button" data-notifications="on" class="active" aria-pressed="true">On</button>
            <button type="button" data-notifications="off" aria-pressed="false">Off</button>
          </div>

          <div class="st-help st-help-error st-notifications-status" role="status" hidden></div>
        </div>

        <div class="tp-group-label">Chat</div>

        <div class="tp-section">
          <label class="tp-label" for="st-chat-branch-prefix" ${helpAttributes("Names the branch created for each new chat session.")}>Branch prefix</label>
          <input type="text" id="st-chat-branch-prefix" class="st-input st-input-branch-prefix" autocomplete="off" spellcheck="false" placeholder="chat/" />

        </div>

        <div class="tp-section">
          <label class="tp-label" for="st-chat-idle-timeout" ${helpAttributes("Closes an idle agent process after this many minutes. The chat resumes when you send another message. 0 means no idle expiry.")}>Idle timeout (minutes)</label>
          <input type="number" id="st-chat-idle-timeout" class="st-input st-input-idle-timeout" min="0" max="10080" step="1" placeholder="120" />

        </div>

        <div class="tp-section">
          <label class="tp-label" for="st-chat-max-concurrent-local-turns" ${helpAttributes("Heavy runs allowed at once, shared by Poise-local chat turns and behavior runs. A turn past the cap waits for a free agent slot; background work leaves one slot free for turns you send.")}>Concurrent local turns</label>
          <input type="number" id="st-chat-max-concurrent-local-turns" class="st-input st-input-max-concurrent-local-turns" min="1" max="64" step="1" placeholder="4" />

        </div>

        <div class="tp-section">
          <label class="tp-label" for="st-chat-update-turn-bound" ${helpAttributes("How long running turns may hold up a Poise update. Past the bound they are interrupted and resume after the update.")}>Update turn bound (minutes)</label>
          <input type="number" id="st-chat-update-turn-bound" class="st-input st-input-update-turn-bound" min="1" max="10080" step="1" placeholder="15" />

        </div>

        <div class="tp-group-label">Storage</div>

        <div class="tp-section">
          <div class="st-help st-help-info st-storage-status" role="status">Loading storage…</div>
          <div class="st-storage-breakdown" aria-live="polite"></div>
          <div class="st-row st-row-tight">
            <button type="button" class="st-clear st-storage-run">Run maintenance now</button>
            <button type="button" class="st-clear st-storage-dry-run">Dry run</button>
          </div>

        </div>

        <div class="tp-group-label">Appearance</div>

        <div class="tp-section">
          <label class="tp-label" id="st-theme-label">Theme</label>
          <div class="range-picker st-theme-picker" role="group" aria-labelledby="st-theme-label">
            <button type="button" data-theme="light" class="${getTheme() === 'light' ? 'active' : ''}">Light</button>
            <button type="button" data-theme="dark"  class="${getTheme() === 'dark'  ? 'active' : ''}">Dark</button>
          </div>

        </div>

        <div class="st-production-group" hidden>
          <div class="tp-group-label">Production</div>
          <div class="tp-section">
            <div class="st-help st-help-info st-production" role="status" aria-live="polite"></div>
            <span class="st-production-updater" data-help="Updates from main automatically. An updater failure raises a desktop notification." tabindex="0">Automatic updates</span>
          </div>
        </div>
      </section>

      <section class="st-tab" data-tab="models" hidden>
        <div class="tp-group-label" ${helpAttributes("Save the model choices below under a name, then restore them with Use.")}>Saved configurations</div>
        <div class="tp-section st-presets">
          <div class="st-row st-row-tight">
            <select class="st-select st-preset-select" aria-label="Saved model configuration"></select>
            <button type="button" class="st-clear st-preset-use">Use</button>
            <button type="button" class="st-clear st-preset-delete">Delete</button>
          </div>
          <div class="st-row st-row-tight">
            <input type="text" class="st-input st-preset-name" maxlength="40" autocomplete="off" spellcheck="false" placeholder="Name" aria-label="Configuration name" />
            <button type="button" class="st-clear st-preset-save">Save current</button>
          </div>

        </div>

        <div class="tp-group-label">Model choices</div>
        <div class="st-models"><div class="st-help st-help-info">Loading the catalog…</div></div>

        <div class="tp-group-label st-fixed-heading" ${helpAttributes("These model choices are fixed by Caller.")} hidden>Fixed models</div>
        <div class="st-models-fixed"></div>

        <div class="tp-group-label" ${helpAttributes("Models are checked daily at 07:00 in your time zone. Check now refreshes provider CLIs and the model list.")}>Model catalog</div>
        <div class="tp-section">
          <div class="st-help st-help-info st-catalog-status"></div>
          <div class="st-row st-row-tight">
            <button type="button" class="st-clear st-refresh-models">Check now</button>
          </div>

        </div>
      </section>

      <section class="st-tab" data-tab="accounts" hidden>
        <div class="st-terminal-slot"></div>
        <div class="st-accounts" aria-live="polite"></div>
        <section class="st-google-accounts" aria-label="Google accounts"></section>
        <div class="st-help st-help-info st-account-checks-status" role="status"></div>
        <div class="st-help st-help-info st-accounts-status" role="status"></div>

        <div class="tp-group-label" ${helpAttributes("A shell in your workspace for connections the account buttons do not cover. Two terminals can run at once; an idle terminal closes after 15 minutes.")}>Terminal</div>
        <div class="tp-section">
          <div class="st-account-actions">
            <button type="button" class="st-clear st-open-shell">Open a shell</button>
          </div>

        </div>
      </section>

      <section class="st-tab" data-tab="publishing" hidden></section>

      </div>
      <div class="st-row st-footer">
        <button class="st-save" type="button">Save</button>
        <button class="st-clear st-reread" type="button" hidden>Read again</button>
        <span class="st-help st-help-info st-status" role="status" aria-live="polite"></span>
      </div>
  `

  orgInput = panel.querySelector('.st-input-org') as HTMLInputElement
  meInput = panel.querySelector('.st-input-me') as HTMLInputElement
  agentInput = panel.querySelector('.st-input-agent') as HTMLInputElement
  tzSelect = panel.querySelector('.st-input-tz') as HTMLSelectElement
  branchPrefixInput = panel.querySelector('.st-input-branch-prefix') as HTMLInputElement
  idleTimeoutInput = panel.querySelector('.st-input-idle-timeout') as HTMLInputElement
  maxConcurrentLocalTurnsInput = panel.querySelector('.st-input-max-concurrent-local-turns') as HTMLInputElement
  updateTurnBoundInput = panel.querySelector('.st-input-update-turn-bound') as HTMLInputElement
  saveBtn = panel.querySelector('.st-save') as HTMLButtonElement
  modelsEl = panel.querySelector('.st-models')
  fixedEl = panel.querySelector('.st-models-fixed')
  catalogStatusEl = panel.querySelector('.st-catalog-status')
  productionEl = panel.querySelector('.st-production')
  refreshBtn = panel.querySelector('.st-refresh-models') as HTMLButtonElement
  refreshBtn.addEventListener('click', () => { void refreshModels() })
  panel.querySelector('.st-storage-run')!.addEventListener('click', () => { void runStorageMaintenance(false) })
  panel.querySelector('.st-storage-dry-run')!.addEventListener('click', () => { void runStorageMaintenance(true) })
  notificationsPicker = panel.querySelector('.st-notifications-picker')
  notificationsStatusEl = panel.querySelector('.st-notifications-status')
  notificationsPicker!.addEventListener('click', (event) => {
    const choice = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-notifications]')?.dataset.notifications
    if (choice === 'on' || choice === 'off') setNotifications(choice === 'on')
  })
  panel.querySelector('.st-preset-save')!.addEventListener('click', () => { void presetAction(savePreset) })
  panel.querySelector('.st-preset-use')!.addEventListener('click', () => { void presetAction(usePreset) })
  panel.querySelector('.st-preset-delete')!.addEventListener('click', () => { void presetAction(deletePreset) })
  panel.querySelector('.tp-body')!.append(navigationSection())
  publishing = publishingSection()
  panel.querySelector('.st-tab[data-tab="publishing"]')!.append(publishing.element)
  accountsEl = panel.querySelector('.st-accounts')
  googleAccountsPanel = googleAccountsSection(panel.querySelector<HTMLElement>('.st-google-accounts')!)
  accountsStatusEl = panel.querySelector('.st-accounts-status')
  terminalSlot = panel.querySelector('.st-terminal-slot')
  shellBtn = panel.querySelector('.st-open-shell') as HTMLButtonElement
  shellBtn.addEventListener('click', () => { void connect('shell') })
  accountsEl!.addEventListener('click', (event) => {
    const preset = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-connect]')?.dataset.connect
    if (isTerminalPreset(preset)) void connect(preset)
  })
  // This used to be `panel.querySelector('.st-help')`, which is an account
  // explainer — the first element of that class in the panel. Every "Saved."
  // and every validation error overwrote it, permanently for the session, and
  // in a short window the message landed off-screen where nobody would see it.
  // Status has its own node, beside the Save button.
  helpEl = panel.querySelector('.st-status')

  // Default the timezone select to the browser zone before the cache loads.
  tzSelect.value = browserTz

  saveBtn.addEventListener('click', saveActiveSection)
  rereadBtn = panel.querySelector('.st-reread') as HTMLButtonElement
  rereadBtn.addEventListener('click', applyReread)
  panel.querySelector<HTMLButtonElement>('.st-add-organization')!.addEventListener('click', () => { void addOrganization() })
  orgInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void addOrganization() } })
  panel.querySelector('.st-organizations')!.addEventListener('click', (event) => {
    const retry = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-retry-org]')
    if (retry?.dataset.retryOrg) void addOrganization(retry.dataset.retryOrg)
  })
  for (const inp of [meInput, agentInput, branchPrefixInput, idleTimeoutInput, maxConcurrentLocalTurnsInput, updateTurnBoundInput]) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveActiveSection() })
  }
  for (const [field, top] of [[meInput, 'me'], [agentInput, 'agentAccount'], [tzSelect, 'timezone'], [branchPrefixInput, 'chat'], [idleTimeoutInput, 'chat'], [maxConcurrentLocalTurnsInput, 'chat'], [updateTurnBoundInput, 'chat']] as const) {
    if (!field) continue
    field.addEventListener('input', () => markGeneralDirty(field, top))
    field.addEventListener('change', () => markGeneralDirty(field, top))
  }

  // Refresh-rate toggle — applies live (no Save needed); each view's
  // running timer restarts via the `poise:refresh-rate-changed` event.
  const refreshPicker = panel.querySelector<HTMLElement>('.st-refresh-picker')!
  refreshPicker.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn || !btn.dataset.rate) return
    const rate = btn.dataset.rate as '1m' | '5m'
    refreshPicker.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    setRefreshRate(rate)
  })

  // Theme toggle — applies live, persisted in localStorage.
  const themePicker = panel.querySelector<HTMLElement>('.st-theme-picker')!
  themePicker.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn || !btn.dataset.theme) return
    const theme = btn.dataset.theme as 'light' | 'dark'
    themePicker.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    setTheme(theme)
  })

  return panel
}

export function initSettings() {
  panelEl = buildPanel()
  panelEl.setAttribute('inert', '')
  panelEl.setAttribute('aria-hidden', 'true')
  document.body.appendChild(panelEl)
  void refreshStatus()
  // Closed Settings releases its rapid timer; the app's regular refresh clock
  // still reconciles pending activation so filters catch up without reopening.
  window.addEventListener('poise:refresh-tick', () => {
    if (!panelEl?.classList.contains('open') && getOrganizations().some((org) => org.status === 'initializing')) void pollOrganizations()
  })
  // Elsewhere in Poise (the Claude sign-in banner in service mode) asks for a
  // CLI's login: Settings → Connected accounts, with its terminal open.
  window.addEventListener('poise:connect-account', (event) => {
    const preset = (event as CustomEvent<{ id?: string }>).detail?.id
    if (!panelEl || !isTerminalPreset(preset)) return
    openSettingsPanel()
    selectSection(panelEl, 'accounts')
    void connect(preset)
  })
  // A destination asked for from elsewhere (the Editor's Publish panel).
  window.addEventListener('poise:open-settings', (event) => {
    const section = (event as CustomEvent<{ section?: string }>).detail?.section
    if (section && panelEl?.querySelector(`.st-tab[data-tab="${CSS.escape(section)}"]`)) openSettingsAt(section as SettingsSection)
  })
  openFromAddress()
}

export function openSettingsPanel() {
  if (!panelEl) return
  window.dispatchEvent(new CustomEvent('poise:panel-opening', { detail: { id: panelEl.id } }))
  panelEl.removeAttribute('inert')
  panelEl.removeAttribute('aria-hidden')
  panelEl.classList.add('open')
  document.addEventListener('keydown', onSettingsKeydown)
  void refreshStatus()
  if (panelEl.dataset.section === 'models') void loadModels()
  if (panelEl.dataset.section === 'general') void loadProduction()
  if (panelEl.dataset.section === 'general') void loadStorage()
  void pollOrganizations()
  if (accountsTabSelected()) void loadAccounts()
  if (panelEl.dataset.section === 'publishing') void publishing?.refresh()
}

/** Direct destination from the menu, a notification or a gateway link. */
export function openSettingsAt(tab: SettingsSection): void {
  if (!panelEl) return
  selectSection(panelEl, tab)
  openSettingsPanel()
}

export function closeSettingsPanel() {
  window.dispatchEvent(new Event('poise:settings-closed'))
  organizationsPollGeneration++
  if (organizationsPollTimer) clearTimeout(organizationsPollTimer)
  organizationsPollTimer = null
  if (!panelEl) return
  panelEl.classList.remove('open')
  // Translated off-screen is not gone: without this the closed panel keeps its
  // place in the tab order, so tabbing from the last view control lands in
  // inputs nobody can see, and a screen reader still announces them.
  panelEl.setAttribute('inert', '')
  panelEl.setAttribute('aria-hidden', 'true')
  document.removeEventListener('keydown', onSettingsKeydown)
}

function onSettingsKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  // Navigation pickups stop propagation; other view handlers can save an
  // editor on the same Escape that dismisses Settings.
  if (!panelEl?.classList.contains('open')) return
  // Escape inside a terminal belongs to the program running there.
  if ((e.target as Element | null)?.closest?.('.st-terminal')) return
  e.preventDefault()
  closeSettingsPanel()
}

export function toggleSettingsPanel() {
  if (!panelEl) return
  if (panelEl.classList.contains('open')) closeSettingsPanel()
  else openSettingsPanel()
}

// Mirrors isReady() on the server: org and username are what everything else
// is scoped by. A read that never reached the server is not an answer — say
// "configured" rather than force the panel open over a working install on a
// blip. The views surface their own errors when the server is unreachable.
export async function isFullyConfigured(): Promise<boolean> {
  await refreshStatus()
  if (!settingsLoadOk()) return true
  return settingsReady()
}
