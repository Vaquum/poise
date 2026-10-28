import { db, getMeta, setMeta } from './db'
import { invalidateRepoListCache } from './gh'
import { HttpError } from './http'
import { type Catalog, type ModelPlace, type ModelPlaceChoice, type ModelSettings, type ModelSlotChoices, assertSlotsDistinct, isModelPlace, isModelSlot, migrateLegacyModelSettings, validateModelSettings } from './models'

// GitHub logins and organization names: 1–39 characters, alphanumerics and
// hyphens, not leading or trailing; your account and the agent account
// refuse consecutive hyphens as well. Stored with nothing but .trim()
// before, so a pasted URL saved cleanly and every query built from it came
// back empty with no indication why.
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

// A zone Intl does not know throws in every view that formats a time, so it is
// refused here rather than stored. Constructing a formatter is the test:
// supportedValuesOf('timeZone') leaves out UTC and the aliases Intl accepts.
// It is this server's Intl; a browser whose ICU differs reports a saved zone
// it does not know itself (src/config.ts).
export function knownTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

export interface Settings {
  org: string
  // Your GitHub account: Current and Archive are scoped to it, and reads done
  // as you use it.
  me: string
  // The agent account: the GitHub user reviews, approvals and issue-review
  // comments are posted as. It must be signed in to gh on this machine.
  agentAccount: string
  timezone: string
  // The three slot models chosen once, and the slot each place runs. What
  // actually launches is resolved against the live catalog (server/models.ts).
  models: ModelSettings
  chat: ChatSettings
  notifications: NotificationSettings
  manager: ManagerSettings
  behaviorChain: BehaviorChainSettings
}

export interface BehaviorChainSettings { enabled: boolean, seedMode: 'label' | 'all', label: string }
export const DEFAULT_BEHAVIOR_CHAIN_SETTINGS: BehaviorChainSettings = { enabled: false, seedMode: 'label', label: 'poise' }

function validateBehaviorChainSettings(value: unknown): BehaviorChainSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('behavior chain settings must be an object')
  const input = value as Record<string, unknown>
  if (typeof input.enabled !== 'boolean' || !['label', 'all'].includes(String(input.seedMode))
    || typeof input.label !== 'string' || !input.label.trim() || [...input.label.trim()].length > 50
    || /[\u0000-\u001f\u007f]/.test(input.label)) throw new Error('behavior chain needs enabled, seedMode (label or all) and a label of 1 to 50 characters')
  return { enabled: input.enabled, seedMode: input.seedMode as BehaviorChainSettings['seedMode'], label: input.label.trim() }
}

export function getBehaviorChainSettings(): BehaviorChainSettings {
  const raw = getMeta('behavior_chain_settings')
  if (raw === undefined || raw === null || raw === '') return { ...DEFAULT_BEHAVIOR_CHAIN_SETTINGS }
  // Corrupt authority cannot silently select broader intake or enable execution.
  return validateBehaviorChainSettings(JSON.parse(raw))
}

// Chat v1 (server/chat): the prefix of branches new sessions cut from the
// default branch, how long an idle agent process is kept alive, how many
// Poise-local turns may run concurrently, and how long running turns may hold
// up a Poise update before they are interrupted and resumed after it.
export interface ChatSettings {
  branchPrefix: string
  idleTimeoutMinutes: number
  maxConcurrentLocalTurns: number
  updateTurnBoundMinutes: number
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }
const BRANCH_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}\/$/

export function getChatSettings(): ChatSettings {
  const raw = getMeta('chat_settings')
  if (!raw) return { ...DEFAULT_CHAT_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<ChatSettings>
    return {
      branchPrefix: typeof parsed.branchPrefix === 'string' && BRANCH_PREFIX.test(parsed.branchPrefix) ? parsed.branchPrefix : DEFAULT_CHAT_SETTINGS.branchPrefix,
      idleTimeoutMinutes: Number.isSafeInteger(parsed.idleTimeoutMinutes) && Number(parsed.idleTimeoutMinutes) >= 0 ? Number(parsed.idleTimeoutMinutes) : DEFAULT_CHAT_SETTINGS.idleTimeoutMinutes,
      maxConcurrentLocalTurns: Number.isSafeInteger(parsed.maxConcurrentLocalTurns) && Number(parsed.maxConcurrentLocalTurns) >= 1 && Number(parsed.maxConcurrentLocalTurns) <= 64 ? Number(parsed.maxConcurrentLocalTurns) : DEFAULT_CHAT_SETTINGS.maxConcurrentLocalTurns,
      updateTurnBoundMinutes: Number.isSafeInteger(parsed.updateTurnBoundMinutes) && Number(parsed.updateTurnBoundMinutes) >= 1 && Number(parsed.updateTurnBoundMinutes) <= 10_080 ? Number(parsed.updateTurnBoundMinutes) : DEFAULT_CHAT_SETTINGS.updateTurnBoundMinutes,
    }
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS }
  }
}

function validateChatSettings(value: unknown): ChatSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('chat settings must be an object')
  const current = getChatSettings()
  const input = value as Record<string, unknown>
  const next = { ...current }
  if ('branchPrefix' in input) {
    const prefix = String(input.branchPrefix ?? '').trim()
    if (!BRANCH_PREFIX.test(prefix)) throw new Error('branch prefix must be a short branch namespace ending in /, like chat/')
    next.branchPrefix = prefix
  }
  if ('idleTimeoutMinutes' in input) {
    const minutes = Number(input.idleTimeoutMinutes)
    if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 10_080) throw new Error('idle timeout must be a whole number of minutes between 0 and 10080')
    next.idleTimeoutMinutes = minutes
  }
  if ('maxConcurrentLocalTurns' in input) {
    const slots = Number(input.maxConcurrentLocalTurns)
    if (!Number.isSafeInteger(slots) || slots < 1 || slots > 64) throw new Error('concurrent local turns must be a whole number between 1 and 64')
    next.maxConcurrentLocalTurns = slots
  }
  if ('updateTurnBoundMinutes' in input) {
    const minutes = Number(input.updateTurnBoundMinutes)
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10_080) throw new Error('update turn bound must be a whole number of minutes between 1 and 10080')
    next.updateTurnBoundMinutes = minutes
  }
  return next
}

// The notifications at the top of the page (server/alerts/notices.ts): on
// unless the person turns them off.
export interface NotificationSettings {
  enabled: boolean
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = { enabled: true }

export function getNotificationSettings(): NotificationSettings {
  const raw = getMeta('notification_settings')
  if (!raw) return { ...DEFAULT_NOTIFICATION_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>
    return { enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_NOTIFICATION_SETTINGS.enabled }
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS }
  }
}

function validateNotificationSettings(value: unknown): NotificationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('notification settings must be an object')
  const enabled = (value as Record<string, unknown>).enabled
  if (typeof enabled !== 'boolean') throw new Error('notifications must be turned on or off: enabled is true or false')
  return { enabled }
}

// The Manager controls (General pane): how the workspace Manager works.
// Rhythm is its concurrent slots, Stability and Autonomy are five-position
// scales, scope is the repositories it may bind (null: every followed one),
// and paused holds new work. Version counts the settings saves — every
// writer advances it — and serves as the policy version the turns carry.
export const MANAGER_STABILITY = ['Stability', 'Lean to stability', 'Balanced', 'Lean to expansion', 'Full expansion'] as const
export type ManagerStability = typeof MANAGER_STABILITY[number]
export const MANAGER_AUTONOMY = ['Ask first', 'Ask on judgement calls', 'Balanced', 'Ask on the irreversible', 'Standing instructions'] as const
export type ManagerAutonomy = typeof MANAGER_AUTONOMY[number]

export interface ManagerSettings {
  rhythm: number
  stability: ManagerStability
  autonomy: ManagerAutonomy
  scope: string[] | null
  paused: boolean
  version: number
}

export const DEFAULT_MANAGER_SETTINGS: ManagerSettings = { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 0 }
const MANAGER_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/

export function getManagerSettings(): ManagerSettings {
  const raw = getMeta('manager_settings')
  if (!raw) return { ...DEFAULT_MANAGER_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<ManagerSettings>
    return {
      rhythm: Number.isSafeInteger(parsed.rhythm) && Number(parsed.rhythm) >= 1 && Number(parsed.rhythm) <= 10 ? Number(parsed.rhythm) : DEFAULT_MANAGER_SETTINGS.rhythm,
      stability: typeof parsed.stability === 'string' && (MANAGER_STABILITY as readonly string[]).includes(parsed.stability) ? parsed.stability : DEFAULT_MANAGER_SETTINGS.stability,
      autonomy: typeof parsed.autonomy === 'string' && (MANAGER_AUTONOMY as readonly string[]).includes(parsed.autonomy) ? parsed.autonomy : DEFAULT_MANAGER_SETTINGS.autonomy,
      scope: parsed.scope === null || parsed.scope === undefined ? null
        : Array.isArray(parsed.scope) && parsed.scope.every((repo) => typeof repo === 'string' && MANAGER_REPO.test(repo)) ? [...parsed.scope] : null,
      paused: typeof parsed.paused === 'boolean' ? parsed.paused : DEFAULT_MANAGER_SETTINGS.paused,
      version: Number.isSafeInteger(parsed.version) && Number(parsed.version) >= 0 ? Number(parsed.version) : 0,
    }
  } catch {
    return { ...DEFAULT_MANAGER_SETTINGS }
  }
}

function validateManagerSettings(value: unknown): ManagerSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manager settings must be an object')
  const current = getManagerSettings()
  const input = value as Record<string, unknown>
  const next = { ...current, version: current.version }
  if ('rhythm' in input) {
    const rhythm = Number(input.rhythm)
    if (!Number.isSafeInteger(rhythm) || rhythm < 1 || rhythm > 10) throw new Error('rhythm must be a whole number of Manager slots between 1 and 10')
    next.rhythm = rhythm
  }
  if ('stability' in input) {
    const stability = input.stability
    if (typeof stability !== 'string' || !(MANAGER_STABILITY as readonly string[]).includes(stability)) {
      throw new Error(`stability must be one of: ${MANAGER_STABILITY.join(', ')}`)
    }
    next.stability = stability as (typeof MANAGER_STABILITY)[number]
  }
  if ('autonomy' in input) {
    const autonomy = input.autonomy
    if (typeof autonomy !== 'string' || !(MANAGER_AUTONOMY as readonly string[]).includes(autonomy)) {
      throw new Error(`autonomy must be one of: ${MANAGER_AUTONOMY.join(', ')}`)
    }
    next.autonomy = autonomy as (typeof MANAGER_AUTONOMY)[number]
  }
  if ('scope' in input) {
    if (input.scope !== null && (!Array.isArray(input.scope) || !input.scope.every((repo) => typeof repo === 'string' && MANAGER_REPO.test(repo)))) {
      throw new Error('scope must be null or a list of repositories like owner/name')
    }
    next.scope = input.scope === null ? null : [...(input.scope as string[])]
  }
  if ('paused' in input) {
    if (typeof input.paused !== 'boolean') throw new Error('paused must be true or false')
    next.paused = input.paused
  }
  return next
}

const TEXT_KEYS = ['org', 'me', 'agentAccount', 'timezone'] as const
const ACCOUNT_KEYS: ReadonlySet<string> = new Set(['org', 'me', 'agentAccount'])

// Before identities the only choice was `reviewModel` = opus | astra. Read it
// once as the review places' preference so nobody's setting silently flips.
function legacyReviewModels(): ModelSettings {
  const legacy = getMeta('reviewModel')
  if (legacy !== 'astra') return {}
  return {
    slots: { primary: 'gpt-6-astra-ultra', secondary: 'opus-5-xhigh' },
    places: { pr_review: { slot: 'primary' }, pr_approve: { slot: 'primary' } },
  }
}

function readModelSettings(record: Record<string, unknown>): ModelSettings {
  const settings: ModelSettings = {}
  const slots = record.slots
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    const picked: ModelSlotChoices = {}
    for (const [slot, identity] of Object.entries(slots as Record<string, unknown>)) {
      if (isModelSlot(slot) && typeof identity === 'string' && identity) picked[slot] = identity
    }
    if (Object.keys(picked).length > 0) settings.slots = picked
  }
  const places = record.places
  if (places && typeof places === 'object' && !Array.isArray(places)) {
    const picked: Partial<Record<ModelPlace, ModelPlaceChoice>> = {}
    for (const [place, value] of Object.entries(places as Record<string, unknown>)) {
      const slot = (value as { slot?: unknown } | null)?.slot
      if (isModelPlace(place) && isModelSlot(slot)) picked[place] = { slot }
    }
    if (Object.keys(picked).length > 0) settings.places = picked
  }
  return settings
}

export function getModelSettings(): ModelSettings {
  const raw = getMeta('models')
  if (!raw) return legacyReviewModels()
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  // Slots and places are the stored shape; anything else is a per-place
  // choice from before slots, migrated on read.
  if ('slots' in record || 'places' in record) return readModelSettings(record)
  return migrateLegacyModelSettings(record)
}

export function getSettings(): Settings {
  return {
    org: getMeta('org') || '',
    me: getMeta('me') || '',
    agentAccount: getMeta('agentAccount') || '',
    timezone: getMeta('timezone') || '',
    models: getModelSettings(),
    chat: getChatSettings(),
    notifications: getNotificationSettings(),
    manager: getManagerSettings(),
    behaviorChain: getBehaviorChainSettings(),
  }
}

// A save refused for overwriting another tab's edit, with the current values
// of the fields it expected.
export class SettingsConflictError extends HttpError {
  constructor(public readonly current: Record<string, unknown>) {
    super(409, 'Settings changed since this tab read them. Nothing was saved; read again and retry.')
    this.name = 'SettingsConflictError'
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => deepEqual(value, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => deepEqual(left[key], right[key]))
}

// Validate everything before writing anything, and write everything in one
// transaction on one consistent read, as Memories' save does: the expected
// values are compared, the partials merged, every key written and the
// version advanced together, so two saves from two processes cannot
// interleave. A refused save changes no field and no counter. `models`
// needs the catalog to validate, so the caller passes it in — loaded before
// the transaction starts; without one the models part is left untouched.
const saveSettings = db.transaction((partial: Partial<Settings>, catalog: Catalog | undefined, opts: { expect?: Record<string, unknown> } | undefined): { settings: Settings, orgChanged: boolean } => {
  const current = getSettings()
  if (opts?.expect !== undefined) {
    if (!opts.expect || typeof opts.expect !== 'object' || Array.isArray(opts.expect)) {
      throw new HttpError(400, 'expect must be an object of field names to the values this tab read')
    }
    const stale: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(opts.expect)) {
      if (!(field in current)) throw new HttpError(400, `expect names no settings field: ${field}`)
      if (!deepEqual(current[field as keyof Settings], value)) stale[field] = current[field as keyof Settings]
    }
    if (Object.keys(stale).length > 0) throw new SettingsConflictError(stale)
  }
  const next: Partial<Settings> = {}
  for (const k of TEXT_KEYS) {
    const v = partial[k]
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    // The legacy org keeps the shape check only: there is no org field left
    // to fix a stored value with, so tightening it here would brick saves
    // that carry it.
    // A value identical to the stored one is likewise grandfathered past the
    // consecutive-hyphen check: the Settings panel only sends drafted fields,
    // but other API callers may still send a stored value, and refusing it
    // would refuse their saves on installs that stored one while permissive.
    const unchanged = (k === 'me' || k === 'agentAccount') && trimmed === (getMeta(k) || '')
    if (ACCOUNT_KEYS.has(k) && trimmed && (!GITHUB_NAME.test(trimmed) || (k !== 'org' && !unchanged && trimmed.includes('--')))) {
      throw new Error(`${k} must be a GitHub name: letters, digits and single hyphens`)
    }
    if (k === 'timezone' && trimmed && !knownTimeZone(trimmed)) {
      // Named, but cut short: a request body may hold a megabyte.
      const named = trimmed.length > 100 ? `${trimmed.slice(0, 100)}…` : trimmed
      throw new Error(`timezone must be a time zone the Poise server knows, such as Europe/Helsinki; "${named}" is not one`)
    }
    next[k] = trimmed
  }
  let models: ModelSettings | undefined
  if ('models' in partial && partial.models !== undefined) {
    if (!catalog) throw new Error('the model catalog is unavailable; model settings were not saved')
    const patch = validateModelSettings(catalog, partial.models)
    const base = getModelSettings()
    const slots = { ...base.slots, ...patch.slots }
    // A partial slot save can still collide with a stored slot: the patch
    // alone validated, so only the merged whole can tell.
    assertSlotsDistinct(slots)
    models = {
      ...(Object.keys(slots).length > 0 ? { slots } : {}),
      ...((base.places || patch.places) ? { places: { ...base.places, ...patch.places } } : {}),
    }
  }
  let chat: ChatSettings | undefined
  if ('chat' in partial && partial.chat !== undefined) chat = validateChatSettings(partial.chat)
  let notifications: NotificationSettings | undefined
  if ('notifications' in partial && partial.notifications !== undefined) notifications = validateNotificationSettings(partial.notifications)
  const behaviorChain = 'behaviorChain' in partial ? validateBehaviorChainSettings(partial.behaviorChain) : undefined
  const mergedManager = 'manager' in partial && partial.manager !== undefined ? validateManagerSettings(partial.manager) : current.manager
  const manager: ManagerSettings = { ...mergedManager, version: current.manager.version + 1 }
  const orgChanged = typeof next.org === 'string' && next.org !== (getMeta('org') || '')
  for (const k of TEXT_KEYS) {
    const v = next[k]
    if (typeof v === 'string') setMeta(k, v)
  }
  if (models) setMeta('models', JSON.stringify(models))
  if (chat) setMeta('chat_settings', JSON.stringify(chat))
  if (notifications) setMeta('notification_settings', JSON.stringify(notifications))
  if (behaviorChain) setMeta('behavior_chain_settings', JSON.stringify(behaviorChain))
  setMeta('manager_settings', JSON.stringify(manager))
  return { settings: getSettings(), orgChanged }
})

export function setSettings(partial: Partial<Settings>, catalog?: Catalog, opts?: { expect?: Record<string, unknown> }): Settings {
  const { settings, orgChanged } = saveSettings(partial, catalog, opts)
  if (orgChanged) invalidateRepoListCache()
  return settings
}

/** The agent account, or '' while none is set. */
export function agentAccount(): string {
  return getMeta('agentAccount') || ''
}

/** The agent account, for anything that posts or reviews as it. */
export function requireAgentAccount(): string {
  const account = agentAccount()
  if (!account) {
    throw new Error('No agent account is set. Set it in Settings → General: it is the GitHub user your reviews and comments are posted as.')
  }
  if (!GITHUB_NAME.test(account)) throw new Error('The agent account in Settings → General is not a GitHub username')
  return account
}

// REVIEW_AGENT_USERNAME from the environment only seeds the agent account, on
// the first start without one saved. Once saved, cleared included, Settings is
// the only source.
export function seedAgentAccount(value: string | undefined): void {
  const seed = String(value || '').trim()
  if (!seed || getMeta('agentAccount') !== null) return
  if (!GITHUB_NAME.test(seed)) throw new Error('REVIEW_AGENT_USERNAME must be a GitHub username to seed the agent account')
  setMeta('agentAccount', seed)
}

/** The accounts every github-interface and agent-interface process acts as. */
export function callerAccounts(): { GITHUB_INTERFACE_USER?: string, GITHUB_INTERFACE_AGENT_USER?: string } {
  const me = getMeta('me') || ''
  const agent = agentAccount()
  return {
    ...(me ? { GITHUB_INTERFACE_USER: me } : {}),
    ...(agent ? { GITHUB_INTERFACE_AGENT_USER: agent } : {}),
  }
}

export function isReady(): boolean {
  const s = getSettings()
  return !!(s.org && s.me)
}
