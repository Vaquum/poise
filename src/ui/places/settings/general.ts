// Settings → General (#556; SETTINGS.md, G1–G17): who you are on GitHub, what
// Poise follows, time, notifications, chats, and this install. Each row saves
// its own field: the GitHub accounts and the time zone whole, a chat setting as
// its one leaf of `chat`. Following, storage and the release line read and act
// on the same routes classic's General does (src/settings.ts).
import { esc } from '../../dom'
import { getOrganizations, getRefreshRate, setOrganizations, setRefreshRate, effectiveTimezone, type Organization } from '../../../config'
import { CHAT_DEFAULTS, GITHUB_NAME } from '../../../settings-save'
import { logTime, shortTime } from '../../../clock'
import { productionSummary, type ProductionUpdate } from '../../../production-status'
import { releaseLine, type ReleaseLine } from '../../../release'
import { openSetup } from '../../setup'
import { field, leaf, type Known } from './save'
import { stateHTML, type Row } from './rows'
import type { SectionContext, SectionDef } from './types'

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const chatOf = (known: Known) => record(known.chat)

const browserZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } })()
function zones(): string[] {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone')
    if (all?.length) return all.includes('UTC') ? all : ['UTC', ...all]
  } catch { /* the list below */ }
  return ['UTC', 'Europe/Helsinki', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Singapore']
}
const offset = (zone: string): string => {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '' } catch { return '' }
}
let zoneOptions: [string, string][] | null = null
const zoneChoices = (): [string, string][] => (zoneOptions ??= [['', `This browser’s zone · ${browserZone}`], ...zones().map((z): [string, string] => [z, `${z} · ${offset(z)}`])])

/** A GitHub login, with main's rule: a stored value is grandfathered past the double hyphen. */
const login = (label: string, required: boolean, stored: () => string) => (v: unknown): string => {
  const s = String(v ?? '')
  if (!s) return required ? `${label} is required` : ''
  return GITHUB_NAME.test(s) && (!s.includes('--') || s === stored()) ? '' : 'it must be a GitHub login, not a URL or an email'
}
const whole = (min: number, max: number, what: string) => (v: unknown): string => (/^\d+$/.test(String(v)) && Number(v) >= min && Number(v) <= max ? '' : `${what} must be a whole number from ${min} to ${max}`)

// ---------- Following: each account's index, in the state words ----------
const STAGES: Record<string, string> = {
  queued: 'Waiting to activate…', authenticating: 'Checking GitHub access…', indexing: 'Indexing repositories…',
  'building-user': 'Preparing your issues and pull requests…', syncing: 'Syncing repositories…', checking: 'Checking the datastore…', reconciling: 'Preparing account…',
}
const waitingOnGitHub = (org: Organization): boolean => org.stage === 'rate-limited' && !!org.retryAt && Date.parse(org.retryAt) > Date.now()
function orgHTML(org: Organization, busy: boolean): string {
  const tz = effectiveTimezone()
  const reset = org.retryAt ? logTime(org.retryAt, tz, Date.now()) : ''
  const paused = waitingOnGitHub(org)
  const state = paused ? stateHTML('waiting', `GitHub API limit · ${org.activatedAt ? 'sync' : 'activation'} resumes at ${esc(reset)}`)
    : org.status === 'initializing' ? stateHTML('running', esc(STAGES[org.stage ?? ''] || org.stage || 'Preparing account…'))
      : org.status === 'error' ? stateHTML('failed', 'Activation failed')
        : org.error ? stateHTML('waiting', 'Sync failed') : '<span class="fnote">Ready</span>'
  const why = !paused && (org.status === 'error' || org.error) ? `<span class="fsub">${esc(org.error || 'Activation failed. Try again.')}${org.retryAt ? ` · retries at ${esc(reset)}` : ''}</span>` : ''
  const retry = org.status === 'error' || org.error || paused ? `<button type="button" class="btn-ghost" data-act="retry-org" data-org="${esc(org.login)}" data-ref="set.follow.retry"${busy || paused ? ' aria-disabled="true"' : ''}>Retry</button>` : ''
  return `<div class="frow" data-item="${esc(org.login)}" data-ref="set.follow.row"><span class="fmain"><span class="name t-mono">${esc(org.login)}</span>${why}</span><span class="fstate">${state}${retry}</span></div>`
}

/** The sections whose Following already polls: a row is built again for Find and the counts. */
const polled = new WeakSet<AbortSignal>()
function following(ctx: SectionContext): Row {
  let adding = false
  let polling = false
  const paint = () => {
    const list = ctx.rows.rowEl('following')?.querySelector<HTMLElement>('[data-flist]')
    if (list) list.innerHTML = getOrganizations().map((o) => orgHTML(o, adding)).join('') || '<p class="fnone">No GitHub accounts followed yet.</p>'
  }
  const say = (html: string) => ctx.rows.lstat(row, html)
  async function poll(): Promise<void> {
    if (polling) return
    polling = true
    try {
      const response = await fetch('/api/organizations', { cache: 'no-store' })
      if (!response.ok) throw new Error(`Could not refresh the accounts followed (Poise answered ${response.status})`)
      const data = await response.json() as { organizations?: Organization[] }
      if (Array.isArray(data.organizations)) { setOrganizations(data.organizations); paint() }
    } catch (error) {
      say(`<span class="is-err">${esc((error as Error).message)}</span>`)
    } finally { polling = false }
  }
  async function follow(retry?: string): Promise<void> {
    if (adding) return
    const input = ctx.rows.rowEl('following')?.querySelector<HTMLInputElement>('[data-list-in]')
    const org = retry || input?.value.trim() || ''
    const me = String(ctx.known().me ?? '')
    if (!retry && (!GITHUB_NAME.test(org) || org.includes('--'))) { say('<span class="is-err">Not followed: enter an organization name or a personal GitHub username, not a URL.</span>'); input?.setAttribute('aria-invalid', 'true'); return }
    if (!me) { say('<span class="is-err">Not followed: save Your GitHub account first.</span>'); return }
    adding = true
    paint()
    say(`<span class="sdot"></span>${retry ? 'Retrying' : 'Following'} ${esc(org)}…`)
    try {
      const response = await fetch(retry ? `/api/organizations/${encodeURIComponent(org)}/retry` : '/api/organizations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org }),
      })
      const data = await response.json().catch(() => ({})) as { organizations?: Organization[], error?: string }
      if (!response.ok) throw new Error(data.error || `Poise answered ${response.status}`)
      if (Array.isArray(data.organizations)) setOrganizations(data.organizations)
      if (!retry && input) { input.value = ''; input.setAttribute('aria-invalid', 'false') }
      say(`<span class="sdot is-saved"></span>${esc(org)}: activation continues if you leave this page`)
    } catch (error) {
      say(`<span class="is-err">Not followed: ${esc((error as Error).message)}</span>`)
    } finally {
      adding = false
      paint()
    }
  }
  const row: Row = {
    key: 'following', group: 'GitHub', label: 'Following', type: 'custom', wide: true,
    gloss: 'Organizations and people whose repositories Poise indexes for Board, Observe and the Manager. The first index can take a few minutes.',
    now: () => { const all = getOrganizations(), busy = all.filter((o) => o.status === 'initializing').length; return `${all.length} accounts${busy ? `: ${busy} activating` : ''}.` },
    findText: () => getOrganizations().map((o) => o.login).join(' '),
    control: () => `<div class="flist" data-flist>${getOrganizations().map((o) => orgHTML(o, adding)).join('') || '<p class="fnone">No GitHub accounts followed yet.</p>'}</div><div class="fadd"><input class="sinput t-mono" placeholder="acme-corp or octocat" aria-label="Organization or person to follow" autocomplete="off" spellcheck="false" data-list-in data-ref="set.follow.input"><button type="button" class="btn-ghost" data-act="follow" data-ref="set.follow.add">Follow</button></div>`,
    act: (act, el) => { if (act === 'follow') void follow(); if (act === 'retry-org') void follow(el.dataset.org) },
    mounted: (el) => {
      el.querySelector<HTMLInputElement>('[data-list-in]')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void follow() } }, { signal: ctx.signal })
      if (polled.has(ctx.signal)) return
      polled.add(ctx.signal)
      void poll()
      // While an account activates, its stage is read again every second and a half, as classic does.
      ctx.every(1500, () => { if (getOrganizations().some((o) => o.status === 'initializing' || waitingOnGitHub(o))) void poll() })
    },
  }
  return row
}

// ---------- Storage: this workspace's disk, what fills it, and maintenance ----------
interface StorageCategory { key: string, label: string, bytes: number | null, status?: 'ok' | 'partial' | 'unavailable', error?: string }
interface StorageStatus {
  at: string
  categories: StorageCategory[]
  disk: { totalBytes: number, freeBytes: number, usedPercent: number }
  pressure: boolean
  complete?: boolean
  stale?: boolean
  error?: string
  lastRun: { finishedAt: string, dryRun: boolean, reclaimedBytes: number, held: unknown[] } | null
}
interface MaintenanceRun { reclaimedBytes: number, removed: unknown[], pruned: unknown[], caches: unknown[], held: Array<{ path: string, reason: string }>, errors: unknown[] }
const STORAGE_TIMEOUT_MS = 15_000
function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
const categoryValue = (c: StorageCategory): string => (typeof c.bytes !== 'number' || c.status === 'unavailable' ? 'unavailable' : c.status === 'partial' ? `${size(c.bytes)} (partial)` : size(c.bytes))
function measured(at: string): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t) || Date.now() < t) return ''
  const ago = Date.now() - t
  if (ago < 60_000) return 'measured just now'
  if (ago < 3_600_000) { const m = Math.floor(ago / 60_000); return `measured ${m} minute${m === 1 ? '' : 's'} ago` }
  return `measured ${shortTime(t, effectiveTimezone(), Date.now())}`
}

function storage(ctx: SectionContext): Row {
  let reading: StorageStatus | null = null
  let failure = ''
  let running: 'run' | 'dry' | null = null
  let generation = 0
  const draw = () => ctx.rows.rerow('storage')
  async function read(fresh = false): Promise<void> {
    const mine = ++generation
    ctx.rows.lstat(row, stateHTML('running', 'measuring…'))
    try {
      const response = await fetch(`/api/storage${fresh ? '?fresh=1' : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) })
      const data = await response.json().catch(() => null) as (StorageStatus & { error?: string }) | null
      if (!response.ok) throw new Error(data?.error || `the storage read failed (Poise answered ${response.status})`)
      if (!data || !Array.isArray(data.categories) || !data.disk) throw new Error('the storage answer is unreadable')
      if (mine !== generation) return
      reading = data
      failure = ''
      draw()
      ctx.rows.lstat(row, '')
    } catch (error) {
      if (mine !== generation) return
      const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
      failure = timedOut ? `the storage read timed out after ${STORAGE_TIMEOUT_MS / 1000} seconds` : (error as Error).message
      draw()
      ctx.rows.lstat(row, '')
    }
  }
  async function maintain(dryRun: boolean): Promise<void> {
    if (running) return
    running = dryRun ? 'dry' : 'run'
    generation++
    draw()
    ctx.rows.lstat(row, stateHTML('running', dryRun ? 'dry run: finding what nothing owns…' : 'clearing what nothing owns…'))
    try {
      const response = await fetch('/api/storage/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun }) })
      const data = await response.json().catch(() => null) as (MaintenanceRun & { error?: string }) | null
      if (!response.ok || !data) throw new Error(data?.error || `Poise answered ${response.status}`)
      const held = data.held.length ? ` · held ${data.held.length}: ${data.held.slice(0, 3).map((h) => `${h.path} (${h.reason})`).join('; ')}${data.held.length > 3 ? '…' : ''}` : ''
      const errors = data.errors.length ? ` · ${data.errors.length} error${data.errors.length === 1 ? '' : 's'}` : ''
      running = null
      await read()
      ctx.rows.lstat(row, `${stateHTML(data.errors.length ? 'failed' : 'done', esc(shortTime(Date.now(), effectiveTimezone(), Date.now())))} <span class="fnote">${dryRun ? 'Would reclaim' : 'Reclaimed'} ${esc(size(data.reclaimedBytes))} · ${data.removed.length} removed, ${data.pruned.length} pruned, ${data.caches.length} cache${data.caches.length === 1 ? '' : 's'} capped${esc(held)}${errors}</span>`)
    } catch (error) {
      running = null
      draw()
      ctx.rows.lstat(row, `<span class="is-err">${dryRun ? 'The dry run' : 'Maintenance'} failed: ${esc((error as Error).message)}</span>`)
    }
  }
  const row: Row = {
    key: 'storage', group: 'This install', label: 'Storage', type: 'custom', wide: true,
    gloss: 'This workspace’s disk, what fills it, and the maintenance that clears what nothing owns. It never removes shared sign-ins, history or your files.',
    findText: () => 'storage disk maintenance space free',
    now: () => (reading ? `${size(reading.disk.freeBytes)} free of ${size(reading.disk.totalBytes)}, ${reading.disk.usedPercent.toFixed(0)}% used.` : failure ? `Not read: ${failure}.` : ''),
    control: () => {
      const busy = running ? ' aria-disabled="true"' : ''
      const head = reading
        ? `<p class="fnote"><b>${esc(size(reading.disk.freeBytes))} free</b> of ${esc(size(reading.disk.totalBytes))} · ${reading.disk.usedPercent.toFixed(0)}% used · ${reading.stale ? `<span class="is-attn">showing the last reading, ${esc(measured(reading.at))}; it could not refresh: ${esc(reading.error || 'the storage read failed')}</span>` : esc(measured(reading.at))}${reading.complete === false && !reading.stale ? ' · <span class="is-attn">some categories could not be measured</span>' : ''}</p>`
        : failure ? `<p class="fnote is-attn" role="alert">Storage could not be read: ${esc(failure)}.</p>` : '<p class="fnote">Reading storage…</p>'
      const cats = reading ? reading.categories.map((c) => `<div class="kv"${c.error ? ` data-help="${esc(c.error)}"` : ''}><span>${esc(c.label)}</span><span class="t-mono${c.status && c.status !== 'ok' ? ' is-attn' : ''}">${esc(categoryValue(c))}</span></div>`).join('') : ''
      const last = reading?.lastRun ? `<span class="fnote">Last maintenance${reading.lastRun.dryRun ? ' (dry run)' : ''} ${esc(shortTime(reading.lastRun.finishedAt, effectiveTimezone(), Date.now()))} · reclaimed ${esc(size(reading.lastRun.reclaimedBytes))} · ${reading.lastRun.held.length} held</span>` : reading ? '<span class="fnote">Maintenance has not run yet</span>' : ''
      const retry = failure || reading?.stale || reading?.complete === false ? `<button type="button" class="btn-ghost" data-act="retry" data-ref="set.storage.retry"${busy}>Retry</button>` : ''
      return `<div class="kvs" data-ref="set.storage">${head}${cats}</div><span class="cline">${retry}<button type="button" class="btn-ghost" data-act="maint" data-ref="set.storage.run"${busy}>Run maintenance now</button><button type="button" class="btn-ghost" data-act="dry" data-ref="set.storage.dry"${busy}>Dry run</button>${last}</span>`
    },
    act: (act) => { if (act === 'retry') void read(true); if (act === 'maint') void maintain(false); if (act === 'dry') void maintain(true) },
    mounted: () => { if (!reading && !failure && generation === 0) void read() },
  }
  return row
}

// ---------- This install: the release, production updates and setup ----------
let release: ReleaseLine | null = null
let production: ProductionUpdate | null = null
async function readInstall(): Promise<void> {
  const [rel, health] = await Promise.allSettled([
    fetch('/api/release', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
    fetch('/api/health', { cache: 'no-store' }).then((r) => r.json() as Promise<{ production?: ProductionUpdate }>),
  ])
  if (rel.status === 'fulfilled') release = releaseLine(rel.value, effectiveTimezone())
  if (health.status === 'fulfilled' && health.value?.production) production = health.value.production
}

export const GENERAL: SectionDef = {
  key: 'general',
  name: 'General',
  what: 'Who you are on GitHub, what Poise follows, time, notifications, chats, and this install.',
  load: readInstall,
  rows: (ctx) => {
    const known = () => ctx.known()
    const chat = (key: keyof typeof CHAT_DEFAULTS) => () => String(chatOf(known())[key] ?? CHAT_DEFAULTS[key])
    const productionWords = production ? productionSummary(production, Date.now(), effectiveTimezone()) : null
    const rows: Row[] = [
      { key: 'me', group: 'GitHub', label: 'Your GitHub account', type: 'text', mono: true, placeholder: 'octocat', applies: 'from the next refresh',
        gloss: 'Shows the issues and pull requests you are involved in. Connect this account under Accounts.',
        value: () => String(known().me ?? ''), check: login('Your GitHub account', true, () => String(known().me ?? '')), save: (v) => field('me', v) },
      { key: 'agent', group: 'GitHub', label: 'Automation account', type: 'text', mono: true, applies: 'from the next review or comment',
        gloss: 'The GitHub account that posts automated reviews and comments. Connect it under Accounts. Poise adds it to every repository in your organizations by itself, and accepts the invitation for it.',
        value: () => String(known().agentAccount ?? ''), check: login('The automation account', false, () => String(known().agentAccount ?? '')), save: (v) => field('agentAccount', v) },
      following(ctx),
      { key: 'timezone', group: 'Time', label: 'Time zone', type: 'select', applies: 'applies now',
        gloss: 'Sets where days and weeks begin in Overview, Board and Observe, and the zone Poise shows times in.',
        value: () => String(known().timezone ?? ''), def: '', defWords: 'this browser’s zone', options: zoneChoices(),
        words: (v) => (v ? String(v) : `this browser’s zone, ${browserZone}`), save: (v) => field('timezone', v) },
      { key: 'refresh', group: 'Time', label: 'Refresh rate', type: 'seg', local: true, applies: 'applies now',
        gloss: 'How often Overview, Board and Observe read fresh data.',
        value: () => getRefreshRate(), def: '1m', options: [['1m', '1 min'], ['5m', '5 min']], apply: (v) => setRefreshRate(v as '1m' | '5m') },
      { key: 'notifications', group: 'Notifications', label: 'Notifications', type: 'switch', applies: 'applies now, in every browser',
        gloss: 'Alerts for sign-ins, failed behaviors, chats waiting for you and pull requests ready to merge. A ready pull request reminds you every 15 minutes until it is merged or silenced. Off stops them and the check of pull requests at once; Behaviors’ diagnostics stay.',
        value: () => (record(known().notifications).enabled === false ? 'off' : 'on'), def: 'on', words: (v) => (v === 'on' ? 'On' : 'Off'),
        save: (v) => field('notifications', { enabled: v === 'on' }) },
      { key: 'branch', group: 'Chats', label: 'Branch prefix', type: 'text', mono: true, applies: 'from the next chat',
        gloss: 'Starts the name of the branch each new chat creates.', value: chat('branchPrefix'), def: CHAT_DEFAULTS.branchPrefix,
        hint: (v) => `next: ${v}tidy-onboarding`,
        check: (v) => { const s = String(v); return /^[A-Za-z0-9._/-]+$/.test(s) && !s.startsWith('/') && !s.includes('..') ? '' : 'it must be a git ref fragment, like chat/' },
        save: (v) => leaf('chat', 'branchPrefix', v) },
      { key: 'idle', group: 'Chats', label: 'Idle timeout', type: 'number', unit: 'minutes', applies: 'applies now',
        gloss: 'Closes an idle agent process after this many minutes; 0 keeps it open. The chat resumes when you send another message.',
        value: chat('idleTimeoutMinutes'), def: String(CHAT_DEFAULTS.idleTimeoutMinutes), words: (v) => (String(v) === '0' ? 'Never' : `${v} minutes`),
        check: whole(0, 10080, 'Idle timeout'), save: (v) => leaf('chat', 'idleTimeoutMinutes', Number(v)) },
      { key: 'running', group: 'Chats', label: 'Running at once', type: 'number', unit: 'at once', applies: 'applies now; turns already running finish',
        gloss: 'How many agent turns may run at the same time, chats and behavior runs together. From 2, one is always left for the turns you send; from 3, workers’ turns also leave one for behavior runs, so reviews can finish the workers’ own work. Past the limit, a turn or run shows Waiting, saying for what, and starts when another finishes.',
        value: chat('maxConcurrentLocalTurns'), def: String(CHAT_DEFAULTS.maxConcurrentLocalTurns),
        check: whole(1, 64, 'Running at once'), save: (v) => leaf('chat', 'maxConcurrentLocalTurns', Number(v)) },
      { key: 'updatewait', group: 'Chats', label: 'Update wait', type: 'number', unit: 'minutes', applies: 'from the next update',
        gloss: 'How long running turns may hold up a Poise update. Past it, they are interrupted and resume after the update.',
        value: chat('updateTurnBoundMinutes'), def: String(CHAT_DEFAULTS.updateTurnBoundMinutes),
        check: whole(1, 10080, 'Update wait'), save: (v) => leaf('chat', 'updateTurnBoundMinutes', Number(v)) },
      { key: 'style', group: 'Appearance', label: 'Style', type: 'custom', plain: true,
        gloss: 'Every font, size, space, shape and colour Poise uses, as tokens you can change.',
        control: () => '<button type="button" class="btn-ghost" data-act="style" data-ref="set.style"><i data-i="palette" class="sm"></i>Open Style</button>',
        act: () => ctx.go('style') },
    ]
    if (release) {
      const line = release
      rows.push({ key: 'release', group: 'This install', label: 'Poise version', type: 'custom', plain: true, findText: () => 'release commit update version',
        gloss: 'The commit this Poise runs, and when it was updated to it.',
        control: () => `<span class="cline" data-ref="set.release"><a class="lnk t-mono" href="${esc(line.href)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(line.label)}">${esc(line.commit)}</a>${line.when ? `<span class="fnote">since ${esc(line.when)}</span>` : ''}</span>` })
    }
    if (productionWords) {
      rows.push({ key: 'production', group: 'This install', label: 'Production updates', type: 'custom', plain: true, findText: () => 'production updates updater',
        gloss: production?.status === 'off' ? 'How this install takes new releases.' : 'This install updates from main by itself. An updater failure raises a desktop notification.',
        control: () => `<p class="fnote${productionWords.level === 'error' ? ' is-err' : ''}" data-ref="set.production">${esc(productionWords.text)}</p>` })
    }
    rows.push(storage(ctx))
    if (ctx.service) {
      rows.push({ key: 'setup', group: 'This install', label: 'First-run setup', type: 'custom', plain: true,
        gloss: 'Walk through setup again, from its first step, with your current choices prefilled.',
        control: () => '<button type="button" class="btn-ghost" data-act="setup" data-ref="set.setup">Run setup again</button>',
        act: () => openSetup({ again: true }) })
    }
    return rows
  },
}
