// First-run setup (docs/Service-architecture.md, "First-run setup"): a new
// workspace opens a dialog in the middle of the screen, with everything else
// dimmed, that takes the person through what Poise needs in the order it
// needs it. Every step saves through the same API Settings uses, and checks
// that its connection actually works before the next one opens.

import {
  effectiveTimezone, getOrganizations, getRefreshRate, getSettings, getTheme, loadSettings, setOrganizations,
  setRefreshRate, setTheme, type Organization, type RefreshRate, type Theme,
} from './config'
import { fetchAccounts } from './views/connected-accounts'
import { ACCOUNT_LOGINS, type AccountId, type ConnectedAccount } from '../server/accounts/types'
import { fetchDevices } from './gateway-client'
import { gatewayAccount } from './service-settings'
import { poiseLinkSection, type PoiseLinkSection } from './views/poise-link'
import type { TerminalPanel } from './views/terminal-panel'
import { startDeviceLogin, type DeviceLogin } from './views/device-login'
import './views/onboarding.css'

type StepId = 'theme' | 'github' | 'agent' | 'organizations' | 'time' | 'ai' | 'models' | 'link' | 'finish'
type Logins = Partial<Record<AccountId, string>>

export interface OnboardingInfo {
  available: boolean
  status: 'pending' | 'done'
  step: StepId
  owner: string
  logins: Logins
}

interface GitHubCheck {
  ok: boolean
  login?: string
  message?: string
  reason?: string
  note?: string
}

interface StepView {
  element: HTMLElement
  /** Whether Continue may be pressed now; asked again on `ctx.update()`. */
  ready(): boolean
  /** Runs on Continue; false keeps the step open, having said why. */
  leave?(): Promise<boolean>
  focus?(): void
  dispose?(): void
}

interface StepContext {
  owner: string
  logins(): Logins
  /** Re-evaluates the footer after the step's state changed. */
  update(): void
  status(text: string, tone?: 'info' | 'ok' | 'error'): void
  /** One login terminal at a time, opened in `slot`. */
  terminal(preset: AccountId, slot: HTMLElement, onEnd: () => void): Promise<void>
  closeTerminal(): void
  terminalRunning(): boolean
  accounts(fresh?: boolean): Promise<ConnectedAccount[]>
  refreshInfo(): Promise<void>
}

interface StepSpec {
  id: StepId
  /** In the progress rail. */
  name: string
  title: string
  intro: (owner: string) => string
  skippable?: boolean
  render(ctx: StepContext): StepView
}

const PROVIDERS: AccountId[] = ['claude', 'codex', 'grok', 'muse', 'antigravity']
const NAMES: Record<AccountId, string> = { claude: 'Claude', codex: 'Codex', gh: 'GitHub', grok: 'Grok', muse: 'Muse', antigravity: 'Antigravity' }
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const ORGANIZATIONS_POLL_MS = 1_500
const BURGER = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 5h10M3 8h10M3 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const CHECK = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function element(className: string, html = ''): HTMLElement {
  const node = document.createElement('div')
  node.className = className
  node.innerHTML = html
  return node
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let data: unknown = null
  try { data = await res.json() } catch { /* reported below */ }
  if (!res.ok) {
    const message = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `HTTP ${res.status}`
    throw new Error(message)
  }
  return data as T
}

export async function loadOnboarding(): Promise<OnboardingInfo | null> {
  const res = await fetch('/api/onboarding', { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as Partial<OnboardingInfo> | null
  if (data?.available !== true || (data.status !== 'pending' && data.status !== 'done') || typeof data.owner !== 'string') return null
  return { available: true, status: data.status, step: (data.step ?? 'theme') as StepId, owner: data.owner, logins: data.logins ?? {} }
}

/** A provider counts as signed in when its CLI says so or, for the CLIs that
 *  cannot say, when its login finished in a terminal here. */
function signedIn(accounts: ConnectedAccount[], logins: Logins): Set<AccountId> {
  const result = new Set<AccountId>()
  for (const account of accounts) {
    if (account.signedIn === true || (account.signedIn === null && account.installed && logins[account.id])) result.add(account.id)
  }
  return result
}

// ── Steps ──────────────────────────────────────────────────────────────

function themeStep(ctx: StepContext): StepView {
  const view = element('ob-themes', (['light', 'dark'] as Theme[]).map((theme) => `
    <button type="button" class="ob-theme" data-choice="${theme}" aria-pressed="${getTheme() === theme}">
      <span class="ob-theme-preview ob-theme-preview-${theme}" aria-hidden="true">
        <span class="ob-tp-bar"><span></span><span></span><span></span></span>
        <span class="ob-tp-card"><span class="ob-tp-line"></span><span class="ob-tp-line ob-tp-short"></span></span>
        <span class="ob-tp-card"><span class="ob-tp-line"></span><span class="ob-tp-line ob-tp-shorter"></span></span>
      </span>
      <span class="ob-theme-name">${theme === 'light' ? 'Light' : 'Dark'}</span>
    </button>`).join(''))
  view.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-choice]')
    if (!button) return
    setTheme(button.dataset.choice as Theme)
    for (const option of view.querySelectorAll<HTMLButtonElement>('[data-choice]')) option.setAttribute('aria-pressed', String(option === button))
    ctx.update()
  })
  return {
    element: view,
    ready: () => true,
  }
}

/** A GitHub account's connection: a status card, how to connect it, the
 *  one-time code of GitHub's device sign-in, and the check that proves the
 *  account works. Shared by your account and the agent account. */
function githubConnection(ctx: StepContext, options: {
  role: 'me' | 'agent'
  login: () => string
  steps: string
  connectLabel: string
  /** Your own account signs in in this browser; the agent account in a private window. */
  openHere: boolean
}): { element: HTMLElement, connected: () => boolean, check: (quiet: boolean) => Promise<void>, reset: () => void, dispose: () => void } {
  const view = element('ob-connection-block', `
    <div class="ob-connection" data-state="checking">
      <span class="ob-connection-dot" aria-hidden="true"></span>
      <div class="ob-connection-copy">
        <div class="ob-connection-title"></div>
        <div class="ob-connection-text" role="status" aria-live="polite"></div>
      </div>
    </div>
    <ol class="ob-steps">${options.steps}</ol>
    <div class="ob-actions">
      <button type="button" class="st-save ob-connect">${escapeHtml(options.connectLabel)}</button>
      <button type="button" class="st-clear ob-recheck">Check again</button>
    </div>
    <div class="ob-device" data-state="starting" hidden>
      <div class="ob-device-label">One-time code</div>
      <div class="ob-device-code ob-device-pending" aria-live="polite">····-····</div>
      <div class="ob-device-actions">
        <button type="button" class="st-save ob-device-copy" disabled>${options.openHere ? 'Copy code and open GitHub' : 'Copy code'}</button>
        <button type="button" class="st-clear ob-device-cancel">Cancel</button>
      </div>
      <div class="ob-device-where">${options.openHere
        ? 'GitHub opens in a new tab at github.com/login/device: paste the code there and approve.'
        : 'In the private window, open <strong>github.com/login/device</strong>, paste the code and approve.'}</div>
      <div class="ob-device-status"><span class="ob-device-dot" aria-hidden="true"></span><span class="ob-device-status-text" role="status" aria-live="polite">Starting GitHub's sign-in…</span></div>
      <div class="ob-device-stuck" hidden>gh has not shown a code. <button type="button" class="ob-device-terminal">Answer it in a terminal</button></div>
      <details class="ob-device-log"><summary>What gh says</summary><pre></pre></details>
    </div>
    <div class="ob-terminal-slot"></div>`)
  const card = view.querySelector<HTMLElement>('.ob-connection')!
  const title = view.querySelector<HTMLElement>('.ob-connection-title')!
  const text = view.querySelector<HTMLElement>('.ob-connection-text')!
  const connect = view.querySelector<HTMLButtonElement>('.ob-connect')!
  const recheck = view.querySelector<HTMLButtonElement>('.ob-recheck')!
  const actions = view.querySelector<HTMLElement>('.ob-actions')!
  const slot = view.querySelector<HTMLElement>('.ob-terminal-slot')!
  const device = view.querySelector<HTMLElement>('.ob-device')!
  const codeEl = view.querySelector<HTMLElement>('.ob-device-code')!
  const copy = view.querySelector<HTMLButtonElement>('.ob-device-copy')!
  const statusEl = view.querySelector<HTMLElement>('.ob-device-status-text')!
  const stuck = view.querySelector<HTMLElement>('.ob-device-stuck')!
  const log = view.querySelector<HTMLElement>('.ob-device-log pre')!
  let connected = false
  let generation = 0
  let login: DeviceLogin | null = null
  let code: string | null = null
  let stuckTimer: ReturnType<typeof setTimeout> | null = null
  let copyTimer: ReturnType<typeof setTimeout> | null = null

  const show = (state: 'checking' | 'connected' | 'missing' | 'error', heading: string, detail: string) => {
    card.dataset.state = state
    title.textContent = heading
    text.textContent = detail
    connect.textContent = state === 'connected' ? 'Reconnect' : options.connectLabel
    connect.classList.toggle('st-save', state !== 'connected')
    connect.classList.toggle('st-clear', state === 'connected')
  }

  const deviceStatus = (state: 'starting' | 'waiting' | 'done' | 'error', message: string) => {
    device.dataset.state = state
    statusEl.textContent = message
  }

  const stopLogin = () => {
    if (stuckTimer) clearTimeout(stuckTimer)
    stuckTimer = null
    login?.cancel()
    login = null
  }

  const check = async (quiet: boolean) => {
    const account = options.login()
    const current = ++generation
    connected = false
    ctx.update()
    if (!GITHUB_NAME.test(account)) {
      show('missing', 'No account yet', 'Enter the agent account\'s GitHub login above.')
      return
    }
    show('checking', account, 'Checking the connection with GitHub…')
    try {
      const answer = await postJson<GitHubCheck>('/api/onboarding/github', { role: options.role, login: account })
      if (current !== generation) return
      if (answer.ok) {
        connected = true
        device.hidden = true
        show('connected', answer.login ?? account, answer.note
          ? `Connected. GitHub confirms the account works. ${answer.note}`
          : options.role === 'me'
            ? 'Connected. GitHub confirms the account works, and Poise reads GitHub as it.'
            : 'Connected. GitHub confirms the account works; reviews and comments are posted as it.')
        await loadSettings()
      } else if (answer.reason === 'not-signed-in' && quiet) {
        show('missing', account, 'Not connected yet.')
      } else {
        show('error', account, answer.message ?? 'The connection could not be confirmed.')
      }
    } catch (error) {
      if (current === generation) show('error', account, `Poise could not check the connection: ${(error as Error).message}`)
    }
    ctx.update()
  }

  // gh asked something setup does not answer: hand it to a terminal, where the person can.
  const toTerminal = () => {
    stopLogin()
    device.hidden = true
    actions.hidden = false
    show('checking', options.login() || 'GitHub', 'Answer gh in the terminal below. Poise checks the connection when it finishes.')
    void ctx.terminal('gh', slot, () => { void check(false) })
  }

  connect.addEventListener('click', () => {
    if (login?.running || ctx.terminalRunning()) return
    if (options.role === 'agent' && !GITHUB_NAME.test(options.login())) {
      show('missing', 'No account yet', 'Enter the agent account\'s GitHub login above first.')
      return
    }
    ctx.closeTerminal()
    code = null
    codeEl.textContent = '····-····'
    codeEl.classList.add('ob-device-pending')
    copy.disabled = true
    copy.textContent = options.openHere ? 'Copy code and open GitHub' : 'Copy code'
    stuck.hidden = true
    log.textContent = ''
    device.hidden = false
    actions.hidden = true
    deviceStatus('starting', 'Starting GitHub\'s sign-in…')
    show('checking', options.login() || 'GitHub', 'Waiting for GitHub to approve the sign-in.')
    stuckTimer = setTimeout(() => { if (!code) stuck.hidden = false }, 20_000)
    login = startDeviceLogin({
      code: (value) => {
        code = value
        codeEl.textContent = value
        codeEl.classList.remove('ob-device-pending')
        copy.disabled = false
        stuck.hidden = true
        deviceStatus('waiting', 'Waiting for you to approve at GitHub…')
      },
      output: (value) => { log.textContent = value.trim().split('\n').slice(-40).join('\n') },
      end: (end) => {
        if (stuckTimer) clearTimeout(stuckTimer)
        stuckTimer = null
        login = null
        actions.hidden = false
        if (end.ok) {
          deviceStatus('done', 'GitHub approved. Checking the connection…')
          void check(false)
          return
        }
        const lines = (log.textContent ?? '').trim().split('\n').filter(Boolean)
        const said = lines[lines.length - 1]
        deviceStatus('error', `${end.message}${said && !end.ok && end.exitCode !== null ? ` gh said: ${said}` : ''} Choose ${options.connectLabel} to start again.`)
        show('error', options.login() || 'GitHub', 'The sign-in did not finish.')
        ctx.update()
      },
    })
  })
  copy.addEventListener('click', async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      copy.textContent = 'Copied'
    } catch {
      // Without clipboard access the code is selected, ready to copy by hand.
      const range = document.createRange()
      range.selectNodeContents(codeEl)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      copy.textContent = 'Selected: copy it'
    }
    if (options.openHere) window.open('https://github.com/login/device', '_blank', 'noopener')
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copy.textContent = options.openHere ? 'Copy code and open GitHub' : 'Copy code' }, 2_400)
  })
  view.querySelector<HTMLButtonElement>('.ob-device-cancel')!.addEventListener('click', () => {
    stopLogin()
    device.hidden = true
    actions.hidden = false
    void check(true)
  })
  view.querySelector<HTMLButtonElement>('.ob-device-terminal')!.addEventListener('click', toTerminal)
  recheck.addEventListener('click', () => { void check(false) })
  return {
    element: view,
    connected: () => connected,
    check,
    reset: () => {
      generation++
      connected = false
      show('missing', options.login() || 'No account yet', 'Not checked yet.')
      ctx.update()
    },
    dispose: () => {
      stopLogin()
      if (copyTimer) clearTimeout(copyTimer)
    },
  }
}

function githubStep(ctx: StepContext): StepView {
  const connection = githubConnection(ctx, {
    role: 'me',
    login: () => ctx.owner,
    connectLabel: 'Connect GitHub',
    openHere: true,
    steps: `
      <li>Choose <strong>Connect GitHub</strong>. Poise starts GitHub's sign-in and shows a one-time code.</li>
      <li>Choose <strong>Copy code and open GitHub</strong>, signed in to GitHub as <strong>${escapeHtml(ctx.owner)}</strong>, then paste the code and approve.</li>
      <li>Poise notices the approval, checks the connection with GitHub, and you can continue.</li>`,
  })
  void connection.check(true)
  return {
    element: connection.element,
    ready: connection.connected,
    dispose: connection.dispose,
  }
}

function agentStep(ctx: StepContext): StepView {
  const view = element('ob-agent', `
    <div class="tp-section">
      <label class="tp-label" for="ob-agent-login">Agent account</label>
      <input id="ob-agent-login" type="text" class="st-input" placeholder="my-review-bot" autocomplete="off" spellcheck="false" />
    </div>`)
  const input = view.querySelector<HTMLInputElement>('#ob-agent-login')!
  input.value = getSettings().agentAccount ?? ''
  const connection = githubConnection(ctx, {
    role: 'agent',
    login: () => input.value.trim(),
    connectLabel: 'Connect agent account',
    openHere: false,
    steps: `
      <li>Open a <strong>private window</strong> in your browser and sign in to GitHub there as the agent account.</li>
      <li>Choose <strong>Connect agent account</strong> and copy the one-time code Poise shows.</li>
      <li>In the private window, open <strong>github.com/login/device</strong>, paste the code and approve. Poise then checks that GitHub accepts the account.</li>`,
  })
  view.append(connection.element)
  input.addEventListener('input', () => connection.reset())
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void connection.check(false) } })
  if (input.value) void connection.check(true)
  else connection.reset()
  return {
    element: view,
    ready: connection.connected,
    // An empty login is where to start; a filled one is checked already.
    focus: input.value ? undefined : () => input.focus(),
    dispose: connection.dispose,
  }
}

const ORGANIZATION_STAGES: Record<string, string> = {
  queued: 'Waiting to activate…',
  authenticating: 'Checking GitHub access…',
  indexing: 'Indexing repositories…',
  'building-user': 'Preparing your issues and pull requests…',
  syncing: 'Syncing repositories…',
  checking: 'Checking the datastore…',
  reconciling: 'Preparing account…',
  'rate-limited': 'Waiting for GitHub\'s rate limit to reset…',
}

function organizationsStep(ctx: StepContext): StepView {
  const view = element('ob-organizations', `
    <div class="ob-org-list" aria-live="polite"></div>
    <div class="st-org-add-row">
      <input type="text" class="st-input ob-org-input" aria-label="Organization or personal GitHub account" placeholder="acme-corp or octocat" autocomplete="off" spellcheck="false" />
      <button type="button" class="st-save ob-org-add">Add</button>
    </div>
    <div class="st-help st-help-info">An organization name or a personal GitHub username, one at a time. The first index can take a while; it continues in the background, so you can go on.</div>`)
  const list = view.querySelector<HTMLElement>('.ob-org-list')!
  const input = view.querySelector<HTMLInputElement>('.ob-org-input')!
  const add = view.querySelector<HTMLButtonElement>('.ob-org-add')!
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let adding = false
  let rendered = ''

  const render = () => {
    const organizations = getOrganizations()
    const html = organizations.map((org) => {
      const state = org.status === 'ready' ? (org.error ? 'Sync failed' : 'Ready') : org.status === 'error' ? 'Activation failed' : 'Activating…'
      const tone = org.status === 'ready' && !org.error ? 'ready' : org.status === 'error' || org.error ? 'error' : 'initializing'
      return `
        <div class="ob-org" data-org="${escapeHtml(org.login)}">
          <div class="ob-org-head"><span class="ob-org-name">${escapeHtml(org.login)}</span><span class="ob-org-state ob-org-state-${tone}">${state}</span></div>
          ${org.status === 'initializing' ? `<div class="st-help st-help-info">${escapeHtml(ORGANIZATION_STAGES[org.stage] ?? 'Preparing account…')}</div>` : ''}
          ${org.status === 'error' || org.error ? `<div class="st-help st-help-error">${escapeHtml(org.error ?? 'Activation failed.')}</div><button type="button" class="st-clear ob-org-retry" data-retry="${escapeHtml(org.login)}">Retry</button>` : ''}
        </div>`
    }).join('') || '<div class="st-help st-help-info ob-empty">No organizations yet.</div>'
    if (html === rendered) return
    rendered = html
    list.innerHTML = html
  }

  const poll = async () => {
    timer = null
    try {
      const res = await fetch('/api/organizations', { cache: 'no-store' })
      const data = await res.json() as { organizations?: Organization[] }
      if (!disposed && Array.isArray(data.organizations)) setOrganizations(data.organizations)
    } catch { /* the next poll tries again */ }
    if (disposed) return
    render()
    ctx.update()
    timer = setTimeout(() => { void poll() }, ORGANIZATIONS_POLL_MS)
  }

  const submit = async (retry?: string) => {
    if (adding) return
    const login = retry ?? input.value.trim()
    if (!GITHUB_NAME.test(login)) {
      ctx.status('Enter an organization name or personal GitHub username, not a URL.', 'error')
      input.focus()
      return
    }
    adding = true
    add.disabled = true
    ctx.status(retry ? `Retrying ${login}…` : `Adding ${login}…`)
    try {
      const data = await postJson<{ organizations?: Organization[] }>(retry ? `/api/organizations/${encodeURIComponent(login)}/retry` : '/api/organizations', { org: login })
      if (Array.isArray(data.organizations)) setOrganizations(data.organizations)
      if (!retry) input.value = ''
      ctx.status(`${login} is activating. Add another, or continue.`, 'ok')
    } catch (error) {
      ctx.status((error as Error).message, 'error')
    } finally {
      adding = false
      add.disabled = false
      render()
      ctx.update()
    }
  }

  add.addEventListener('click', () => { void submit() })
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void submit() } })
  list.addEventListener('click', (event) => {
    const retry = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-retry]')?.dataset.retry
    if (retry) void submit(retry)
  })
  render()
  // An account added before GitHub was connected failed to activate for that
  // reason alone: GitHub is connected now, so each one is tried again once.
  void (async () => {
    for (const org of getOrganizations().filter((entry) => entry.managed && entry.status === 'error')) {
      if (disposed) return
      try {
        const data = await postJson<{ organizations?: Organization[] }>(`/api/organizations/${encodeURIComponent(org.login)}/retry`, { org: org.login })
        if (Array.isArray(data.organizations)) setOrganizations(data.organizations)
      } catch { /* it keeps its Retry button */ }
    }
    if (!disposed) { render(); ctx.update() }
  })()
  void poll()
  return {
    element: view,
    ready: () => getOrganizations().some((org) => org.status !== 'error'),
    leave: async () => {
      window.dispatchEvent(new CustomEvent('poise:organizations-changed'))
      window.dispatchEvent(new CustomEvent('poise:synced'))
      return true
    },
    focus: () => input.focus(),
    dispose: () => {
      disposed = true
      if (timer) clearTimeout(timer)
    },
  }
}

function timezones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone')
    if (list?.length) return list.includes('UTC') ? list : ['UTC', ...list]
  } catch { /* the short list below */ }
  return ['UTC', 'Europe/Helsinki', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Singapore']
}

function timeStep(ctx: StepContext): StepView {
  const zone = effectiveTimezone()
  const zones = timezones()
  if (!zones.includes(zone)) zones.unshift(zone)
  const view = element('ob-time', `
    <div class="tp-section">
      <label class="tp-label" for="ob-timezone">Time zone</label>
      <select id="ob-timezone" class="st-select">${zones.map((value) => `<option value="${escapeHtml(value)}"${value === zone ? ' selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select>
      <div class="st-help st-help-info">Where "today", "yesterday" and "this week" begin, and the time Poise's daily model check runs.</div>
    </div>
    <div class="tp-section">
      <span class="tp-label">Refresh rate</span>
      <div class="range-picker ob-refresh">
        <button type="button" data-rate="1m">Every minute</button>
        <button type="button" data-rate="5m">Every 5 minutes</button>
      </div>
      <div class="st-help st-help-info">How often Current, Swarm and Archive pull fresh data.</div>
    </div>`)
  const select = view.querySelector<HTMLSelectElement>('#ob-timezone')!
  const picker = view.querySelector<HTMLElement>('.ob-refresh')!
  let rate: RefreshRate = getRefreshRate()
  const showRate = () => {
    for (const button of picker.querySelectorAll<HTMLButtonElement>('[data-rate]')) button.classList.toggle('active', button.dataset.rate === rate)
  }
  picker.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-rate]')
    if (!button) return
    rate = button.dataset.rate as RefreshRate
    showRate()
  })
  showRate()
  return {
    element: view,
    ready: () => !!select.value,
    leave: async () => {
      try {
        await postJson('/api/settings', { timezone: select.value })
        await loadSettings()
      } catch (error) {
        ctx.status(`The time zone was not saved: ${(error as Error).message}`, 'error')
        return false
      }
      setRefreshRate(rate)
      return true
    },
  }
}

function accountState(account: ConnectedAccount, logins: Logins): { text: string, tone: 'on' | 'off' | 'unknown' } {
  if (!account.installed) return { text: 'Not installed in this workspace', tone: 'unknown' }
  if (account.signedIn === true) return { text: account.identity ? `Signed in as ${account.identity}` : 'Signed in', tone: 'on' }
  if (account.signedIn === false) return { text: account.detail ?? 'Not signed in', tone: 'off' }
  if (logins[account.id]) return { text: 'Signed in here', tone: 'on' }
  return { text: 'Not signed in yet', tone: 'off' }
}

function aiStep(ctx: StepContext): StepView {
  const view = element('ob-ai', `
    <div class="ob-ai-list" aria-live="polite"><div class="st-help st-help-info">Asking each CLI…</div></div>
    <div class="ob-terminal-slot"></div>`)
  const list = view.querySelector<HTMLElement>('.ob-ai-list')!
  const slot = view.querySelector<HTMLElement>('.ob-terminal-slot')!
  let accounts: ConnectedAccount[] | null = null
  let disposed = false

  const render = () => {
    if (!accounts) return
    const logins = ctx.logins()
    list.innerHTML = PROVIDERS.map((id) => accounts!.find((account) => account.id === id)).filter((account): account is ConnectedAccount => !!account).map((account) => {
      const { text, tone } = accountState(account, logins)
      const label = tone === 'on' ? 'Reconnect' : 'Connect'
      // A CLI that cannot report its sign-in counts as signed in when the person says so.
      const marked = !!logins[account.id]
      const mark = account.installed && account.signedIn === null
        ? `<button type="button" class="st-clear ob-ai-mark" data-mark="${account.id}" data-signed-in="${!marked}" aria-label="${escapeHtml(NAMES[account.id])}: ${marked ? 'not signed in' : 'I have signed in'}">${marked ? 'Not signed in' : 'I\'ve signed in'}</button>`
        : ''
      return `
        <div class="ob-ai-row" data-account="${account.id}">
          <span class="ob-ai-dot ob-ai-dot-${tone}" aria-hidden="true"></span>
          <div class="ob-ai-copy">
            <div class="ob-ai-name">${escapeHtml(NAMES[account.id])}${account.version ? `<span class="ob-ai-version">${escapeHtml(account.version)}</span>` : ''}</div>
            <div class="ob-ai-state">${escapeHtml(text)}</div>
          </div>
          ${mark}
          <button type="button" class="${tone === 'on' ? 'st-clear' : 'st-save'} ob-ai-connect" data-connect="${account.id}"${!account.installed || ctx.terminalRunning() ? ' disabled' : ''} aria-label="${label} ${escapeHtml(NAMES[account.id])}">${label}</button>
        </div>`
    }).join('')
  }

  const refresh = async (fresh: boolean) => {
    try {
      accounts = await ctx.accounts(fresh)
      await ctx.refreshInfo()
      if (!disposed) render()
    } catch (error) {
      if (!disposed) list.innerHTML = `<div class="st-help st-help-error">${escapeHtml(`Could not ask the CLIs: ${(error as Error).message}`)}</div>`
    }
    ctx.update()
  }

  list.addEventListener('click', (event) => {
    const mark = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mark]')
    if (mark) {
      mark.disabled = true
      void postJson('/api/onboarding', { account: mark.dataset.mark, signedIn: mark.dataset.signedIn === 'true' })
        .then(() => refresh(false))
        .catch((error: unknown) => {
          mark.disabled = false
          ctx.status(`That was not saved: ${(error as Error).message}`, 'error')
        })
      return
    }
    const id = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-connect]')?.dataset.connect as AccountId | undefined
    if (!id || ctx.terminalRunning()) return
    void ctx.terminal(id, slot, () => {
      // Antigravity's terminal runs the app itself, which exits the same way whether or not a sign-in finished.
      if (id === 'antigravity') ctx.status('Antigravity cannot say whether its sign-in finished. If it did, choose I\'ve signed in.', 'info')
      void refresh(true)
    }).then(render)
    render()
  })
  void refresh(false)
  return {
    element: view,
    ready: () => true,
    leave: async () => {
      if (accounts && signedIn(accounts, ctx.logins()).size === 0) {
        ctx.status('Poise\'s agents need at least one AI account. You can sign in later in Settings → Accounts.', 'info')
      }
      return true
    },
    dispose: () => { disposed = true },
  }
}

interface CatalogModel { identity: string, provider: string }
interface ModelPlace {
  key: string
  label: string
  why: string
  review: boolean
  reviewers: boolean
  providers?: string[] | null
  default: string
  fallback: string
  secondary?: string
  tertiary?: string
}
interface ModelsAnswer { catalog: { models: CatalogModel[], review_providers: string[] }, places: ModelPlace[] }
type Slot = 'default' | 'fallback' | 'secondary' | 'tertiary'
const SLOT_LABELS: Record<Slot, string> = { default: 'Default', fallback: 'Fallback', secondary: 'Secondary reviewer', tertiary: 'Tertiary reviewer' }

/** For each slot of a place, the stored or proposed model when its provider is
 *  signed in, otherwise the first signed-in model no earlier slot took. */
function proposeChoice(place: ModelPlace, eligible: CatalogModel[], usable: Set<string>): Record<Slot, string> {
  const slots: Slot[] = place.reviewers ? ['default', 'fallback', 'secondary', 'tertiary'] : ['default', 'fallback']
  const choice = {} as Record<Slot, string>
  const taken = new Set<string>()
  const provider = (identity: string) => eligible.find((model) => model.identity === identity)?.provider
  for (const slot of slots) {
    const current = place[slot] ?? ''
    const keep = current && !taken.has(current) && usable.has(provider(current) ?? '')
    const next = keep ? current : eligible.find((model) => usable.has(model.provider) && !taken.has(model.identity))?.identity
      ?? (current && !taken.has(current) ? current : eligible.find((model) => !taken.has(model.identity))?.identity ?? '')
    choice[slot] = next
    if (next) taken.add(next)
  }
  return choice
}

function modelsStep(ctx: StepContext): StepView {
  const view = element('ob-models', `
    <div class="ob-provider-chips" aria-live="polite"></div>
    <div class="ob-places"><div class="st-help st-help-info">Reading the model catalog…</div></div>`)
  const chips = view.querySelector<HTMLElement>('.ob-provider-chips')!
  const placesEl = view.querySelector<HTMLElement>('.ob-places')!
  let answer: ModelsAnswer | null = null
  let disposed = false

  void (async () => {
    try {
      const [res, accounts] = await Promise.all([fetch('/api/models', { cache: 'no-store' }), ctx.accounts(false)])
      const data = await res.json() as ModelsAnswer & { error?: string }
      if (!res.ok || !data.catalog || !Array.isArray(data.places)) throw new Error(data.error || `HTTP ${res.status}`)
      if (disposed) return
      answer = data
      const usable = signedIn(accounts, ctx.logins()) as Set<string>
      const providers = [...new Set(data.catalog.models.map((model) => model.provider))]
      chips.innerHTML = providers.map((provider) => `
        <span class="ob-chip${usable.has(provider) ? ' ob-chip-on' : ''}">${usable.has(provider) ? CHECK : ''}${escapeHtml(NAMES[provider as AccountId] ?? provider)}</span>`).join('')
        + `<span class="st-help st-help-info ob-chip-note">${usable.size ? 'Models from providers you have not signed in to are dimmed.' : 'No AI account is signed in yet, so every model is dimmed. Go back to sign in, or choose now and sign in later.'}</span>`
      placesEl.innerHTML = data.places.map((place) => {
        const allowed = place.providers !== undefined ? place.providers : place.review ? data.catalog.review_providers : null
        const eligible = allowed ? data.catalog.models.filter((model) => allowed.includes(model.provider)) : data.catalog.models
        const choice = proposeChoice(place, eligible, usable)
        const options = (selected: string) => {
          const on = eligible.filter((model) => usable.has(model.provider))
          const off = eligible.filter((model) => !usable.has(model.provider))
          const option = (model: CatalogModel, disabled: boolean) => `<option value="${escapeHtml(model.identity)}"${model.identity === selected ? ' selected' : ''}${disabled && model.identity !== selected ? ' disabled' : ''}>${escapeHtml(model.identity)}</option>`
          return (on.length ? `<optgroup label="Signed in">${on.map((model) => option(model, false)).join('')}</optgroup>` : '')
            + (off.length ? `<optgroup label="Not signed in">${off.map((model) => option(model, true)).join('')}</optgroup>` : '')
        }
        const slots = (Object.keys(choice) as Slot[])
        const provider = (identity: string) => eligible.find((model) => model.identity === identity)?.provider ?? ''
        return `
          <div class="ob-place" data-place="${escapeHtml(place.key)}">
            <div class="ob-place-head"><span class="ob-place-name">${escapeHtml(place.label)}</span></div>
            <div class="st-help st-help-info ob-place-why">${escapeHtml(place.why)}</div>
            <div class="ob-place-grid">${slots.map((slot) => {
              const off = !!choice[slot] && !usable.has(provider(choice[slot]))
              return `
              <label class="ob-model">
                <span class="st-sublabel">${SLOT_LABELS[slot]}</span>
                <select class="st-select${off ? ' ob-model-off' : ''}" data-slot="${slot}" aria-label="${escapeHtml(place.label)} ${SLOT_LABELS[slot].toLowerCase()}">${options(choice[slot])}</select>
                ${off ? `<span class="st-help st-help-info">Needs ${escapeHtml(NAMES[provider(choice[slot]) as AccountId] ?? provider(choice[slot]))}; there are not enough signed-in models for every slot.</span>` : ''}
              </label>`
            }).join('')}
            </div>
          </div>`
      }).join('')
      // A choice changed to a signed-in model is no longer dimmed.
      placesEl.addEventListener('change', (event) => {
        const select = event.target as HTMLSelectElement
        if (!select.matches('select[data-slot]')) return
        const model = data.catalog.models.find((entry) => entry.identity === select.value)
        const off = !!model && !usable.has(model.provider)
        select.classList.toggle('ob-model-off', off)
        if (!off) select.parentElement?.querySelector('.st-help')?.remove()
      })
    } catch (error) {
      if (!disposed) placesEl.innerHTML = `<div class="st-help st-help-error">${escapeHtml(`The model catalog is unavailable: ${(error as Error).message}`)}</div>`
    }
    ctx.update()
  })()

  return {
    element: view,
    ready: () => !!answer,
    leave: async () => {
      const models: Record<string, Partial<Record<Slot, string>>> = {}
      for (const place of placesEl.querySelectorAll<HTMLElement>('.ob-place')) {
        const choice: Partial<Record<Slot, string>> = {}
        for (const select of place.querySelectorAll<HTMLSelectElement>('select[data-slot]')) choice[select.dataset.slot as Slot] = select.value
        if (choice.default && choice.fallback && choice.default === choice.fallback) {
          ctx.status(`${place.querySelector('.ob-place-name')?.textContent}: the fallback must differ from the default.`, 'error')
          return false
        }
        models[place.dataset.place ?? ''] = choice
      }
      try {
        await postJson('/api/settings', { models })
        await loadSettings()
        window.dispatchEvent(new CustomEvent('poise:models-changed'))
        return true
      } catch (error) {
        ctx.status(`The models were not saved: ${(error as Error).message}`, 'error')
        return false
      }
    },
    dispose: () => { disposed = true },
  }
}

function linkStep(ctx: StepContext): StepView {
  const view = element('ob-link', '<div class="st-help st-help-info">Asking the gateway…</div>')
  let section: PoiseLinkSection | null = null
  let paired = false
  let disposed = false
  void gatewayAccount().then((account) => {
    if (disposed || !account) return
    section = poiseLinkSection(account, {
      guided: true,
      onPaired: () => {
        paired = true
        ctx.status('This computer is paired. Continue when you are ready.', 'ok')
        ctx.update()
      },
    })
    view.replaceChildren(section.element)
  }).catch((error: unknown) => {
    if (!disposed) view.innerHTML = `<div class="st-help st-help-error">${escapeHtml(`The gateway did not answer: ${(error as Error).message}. You can pair later in Settings → Accounts.`)}</div>`
  })
  return {
    element: view,
    ready: () => true,
    leave: async () => {
      if (!paired) ctx.status('', 'info')
      return true
    },
    focus: () => view.querySelector<HTMLInputElement>('.pl-code')?.focus(),
    dispose: () => {
      disposed = true
      section?.dispose()
    },
  }
}

function summaryRow(key: string, label: string, value: string, done: boolean): string {
  return `
      <li class="ob-summary-row${done ? ' ob-done' : ''}" data-row="${key}">
        <span class="ob-summary-mark" aria-hidden="true">${done ? CHECK : ''}</span>
        <span class="ob-summary-label">${escapeHtml(label)}</span>
        <span class="ob-summary-value">${escapeHtml(value)}</span>
      </li>`
}

function finishStep(ctx: StepContext): StepView {
  const settings = getSettings()
  const organizations = getOrganizations()
  const rows: Array<[string, string, string, boolean]> = [
    ['theme', 'Theme', getTheme() === 'dark' ? 'Dark' : 'Light', true],
    ['github', 'Your GitHub account', settings.me || 'Not connected', !!settings.me],
    ['agent', 'Agent account', settings.agentAccount || 'Not set', !!settings.agentAccount],
    ['organizations', 'Organizations', organizations.length ? organizations.map((org) => `${org.login}${org.status === 'ready' ? '' : org.status === 'error' ? ' (failed)' : ' (activating)'}`).join(', ') : 'None yet', organizations.some((org) => org.status !== 'error')],
    ['time', 'Time', `${effectiveTimezone()}, refreshing ${getRefreshRate() === '5m' ? 'every 5 minutes' : 'every minute'}`, true],
    ['ai', 'AI accounts', '…', false],
    ['link', 'This computer', '…', false],
  ]
  const view = element('ob-finish', `
    <ul class="ob-summary">${rows.map(([key, label, value, done]) => summaryRow(key, label, value, done)).join('')}
    </ul>
    <div class="ob-settings-hint">
      <span class="ob-burger" aria-hidden="true">${BURGER}</span>
      <div>
        <div class="ob-settings-hint-title">Everything here lives in Settings</div>
        <div class="ob-settings-hint-text">Open the menu ☰ at the top right and choose <strong>Settings</strong> to change any of it at any time: accounts and sign-ins, organizations, models, time, theme and this computer's pairing.</div>
      </div>
    </div>`)
  const fill = (key: string, label: string, value: string, done: boolean) => {
    view.querySelector(`[data-row="${key}"]`)?.replaceWith(element('', summaryRow(key, label, value, done)).firstElementChild!)
  }
  void ctx.accounts(false).then((accounts) => {
    const names = PROVIDERS.filter((id) => signedIn(accounts, ctx.logins()).has(id)).map((id) => NAMES[id])
    fill('ai', 'AI accounts', names.length ? names.join(', ') : 'None signed in yet', names.length > 0)
  }).catch(() => fill('ai', 'AI accounts', 'Unknown', false))
  void fetchDevices().then((devices) => {
    const paired = devices.filter((device) => device.state === 'active').length
    fill('link', 'This computer', paired ? `${paired} computer${paired === 1 ? '' : 's'} paired with Poise Link` : 'Not paired yet', paired > 0)
  }).catch(() => fill('link', 'This computer', 'Unknown', false))
  return { element: view, ready: () => true }
}

const STEPS: StepSpec[] = [
  { id: 'theme', name: 'Theme', title: 'Choose how Poise looks', intro: () => 'Light or dark, applied at once. You can switch any time.', render: themeStep },
  { id: 'github', name: 'GitHub', title: 'Connect your GitHub account', intro: (owner) => `Poise reads GitHub as you, ${owner}, through gh, GitHub's own command-line tool in your workspace.`, render: githubStep },
  { id: 'agent', name: 'Agent', title: 'Add the agent account', intro: () => 'Reviews, approvals and comments are posted as a separate GitHub account, such as a bot. It signs in to gh here too, and Poise confirms it works.', skippable: true, render: agentStep },
  { id: 'organizations', name: 'Organizations', title: 'Add your organizations', intro: () => 'The GitHub organizations, and personal accounts, whose work Poise follows: Current, Swarm, Archive and your automations read them.', render: organizationsStep },
  { id: 'time', name: 'Time', title: 'Time zone and refresh rate', intro: () => 'How Poise tells time, and how often it looks for news.', render: timeStep },
  { id: 'ai', name: 'AI accounts', title: 'Sign in to your AI accounts', intro: () => 'Connect the ones you use. Each opens its own login in a terminal here; the CLI keeps what it signs in with in your workspace, and Poise never reads it.', render: aiStep },
  { id: 'models', name: 'Models', title: 'Choose your models', intro: () => 'Which model each place in Poise launches. Only providers you signed in to are offered.', render: modelsStep },
  { id: 'link', name: 'This computer', title: 'Connect this computer', intro: () => 'Poise Link keeps your snippets on your computer and brings Poise\'s alerts to it.', skippable: true, render: linkStep },
  { id: 'finish', name: 'Done', title: 'You\'re all set', intro: () => 'Poise is ready.', render: finishStep },
]

// ── The dialog ─────────────────────────────────────────────────────────

let active: Onboarding | null = null

class Onboarding {
  private readonly root: HTMLElement
  private readonly dialog: HTMLElement
  private readonly body: HTMLElement
  private readonly title: HTMLElement
  private readonly intro: HTMLElement
  private readonly count: HTMLElement
  private readonly rail: HTMLElement
  private readonly back: HTMLButtonElement
  private readonly skip: HTMLButtonElement
  private readonly next: HTMLButtonElement
  private readonly statusEl: HTMLElement
  private readonly later: HTMLButtonElement
  private index = 0
  private view: StepView | null = null
  private terminal: TerminalPanel | null = null
  private terminalOpening = false
  private accountsAnswer: Promise<ConnectedAccount[]> | null = null
  private leaving = false
  private readonly inerted: HTMLElement[] = []

  constructor(private info: OnboardingInfo, start: StepId) {
    this.root = element('ob-backdrop')
    this.root.innerHTML = `
      <div class="ob-dialog" role="dialog" aria-modal="true" aria-labelledby="ob-title" aria-describedby="ob-intro">
        <header class="ob-head">
          <div class="ob-rail" aria-hidden="true">${STEPS.slice(0, -1).map((step) => `<span class="ob-rail-step" data-step="${step.id}" title="${escapeHtml(step.name)}"></span>`).join('')}</div>
          <div class="ob-meta"><span class="ob-count"></span><button type="button" class="ob-later">Finish later</button></div>
          <h2 class="ob-title" id="ob-title" tabindex="-1"></h2>
          <p class="ob-intro" id="ob-intro"></p>
        </header>
        <div class="ob-body"></div>
        <footer class="ob-foot">
          <button type="button" class="st-clear ob-back">Back</button>
          <span class="st-help ob-status" role="status" aria-live="polite"></span>
          <button type="button" class="st-clear ob-skip">Skip for now</button>
          <button type="button" class="st-save ob-next">Continue</button>
        </footer>
      </div>`
    this.dialog = this.root.querySelector('.ob-dialog')!
    this.body = this.root.querySelector('.ob-body')!
    this.title = this.root.querySelector('.ob-title')!
    this.intro = this.root.querySelector('.ob-intro')!
    this.count = this.root.querySelector('.ob-count')!
    this.rail = this.root.querySelector('.ob-rail')!
    this.back = this.root.querySelector('.ob-back')!
    this.skip = this.root.querySelector('.ob-skip')!
    this.next = this.root.querySelector('.ob-next')!
    this.statusEl = this.root.querySelector('.ob-status')!
    this.later = this.root.querySelector('.ob-later')!
    this.back.addEventListener('click', () => { void this.go(this.index - 1, false) })
    this.skip.addEventListener('click', () => { void this.go(this.index + 1, false) })
    this.next.addEventListener('click', () => { void this.forward() })
    this.later.addEventListener('click', () => this.close(false))
    // Setup is a path, not a popup: Escape does not end it (Finish later does),
    // and focus stays inside while it is open.
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !(event.target as Element).closest('.st-terminal')) event.preventDefault()
      if (event.key === 'Tab') this.trapFocus(event)
    })
    for (const id of ['app', 'settings-panel', 'typo-panel', 'analytics-panel', 'claude-auth-banner', 'menu-popover']) {
      const node = document.getElementById(id)
      if (node && !node.hasAttribute('inert')) {
        node.setAttribute('inert', '')
        this.inerted.push(node)
      }
    }
    document.documentElement.classList.add('ob-open')
    document.body.append(this.root)
    requestAnimationFrame(() => this.root.classList.add('ob-visible'))
    void this.go(Math.max(0, STEPS.findIndex((step) => step.id === start)), false)
  }

  private context(): StepContext {
    return {
      owner: this.info.owner,
      logins: () => this.info.logins,
      update: () => this.footer(),
      status: (text, tone = 'info') => this.status(text, tone),
      terminal: (preset, slot, onEnd) => this.openTerminal(preset, slot, onEnd),
      closeTerminal: () => this.closeTerminal(),
      terminalRunning: () => this.terminalOpening || !!this.terminal?.running,
      accounts: (fresh = false) => {
        if (fresh || !this.accountsAnswer) {
          const attempt = fetchAccounts()
          this.accountsAnswer = attempt
          attempt.catch(() => { if (this.accountsAnswer === attempt) this.accountsAnswer = null })
        }
        return this.accountsAnswer
      },
      refreshInfo: async () => {
        const info = await loadOnboarding().catch(() => null)
        if (info) this.info = info
      },
    }
  }

  private status(text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
    this.statusEl.textContent = text
    this.statusEl.className = `st-help st-help-${tone} ob-status`
  }

  private footer(): void {
    const step = STEPS[this.index]
    const last = step.id === 'finish'
    this.back.hidden = this.index === 0
    this.skip.hidden = !step.skippable || (this.view?.ready() ?? false)
    this.next.textContent = last ? 'Open Poise' : 'Continue'
    this.next.disabled = this.leaving || !(this.view?.ready() ?? false)
  }

  private async openTerminal(preset: AccountId, slot: HTMLElement, onEnd: () => void): Promise<void> {
    if (this.terminalOpening || this.terminal?.running) return
    this.terminal?.dispose()
    this.terminalOpening = true
    try {
      const { openTerminal } = await import('./views/terminal-panel')
      const panel = openTerminal({
        preset,
        title: ACCOUNT_LOGINS[preset].join(' '),
        onEnd: () => {
          this.accountsAnswer = null
          onEnd()
        },
        onDispose: () => { if (this.terminal === panel) this.terminal = null },
      })
      this.terminal = panel
      slot.replaceChildren(panel.element)
      panel.element.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    } catch (error) {
      this.status(`Could not open the terminal: ${(error as Error).message}`, 'error')
    } finally {
      this.terminalOpening = false
    }
  }

  private closeTerminal(): void {
    this.terminal?.dispose()
    this.terminal = null
  }

  private async forward(): Promise<void> {
    if (this.leaving || !(this.view?.ready() ?? false)) return
    if (STEPS[this.index].id === 'finish') {
      this.next.disabled = true
      try {
        await postJson('/api/onboarding', { done: true })
      } catch (error) {
        this.status(`Setup could not be marked finished: ${(error as Error).message}`, 'error')
        this.next.disabled = false
        return
      }
      this.close(true)
      return
    }
    await this.go(this.index + 1, true)
  }

  private async go(index: number, checked: boolean): Promise<void> {
    if (index < 0 || index >= STEPS.length || this.leaving) return
    if (checked && this.view?.leave) {
      this.leaving = true
      this.footer()
      const ok = await this.view.leave().catch((error: unknown) => {
        this.status((error as Error).message, 'error')
        return false
      })
      this.leaving = false
      if (!ok) { this.footer(); return }
    }
    this.closeTerminal()
    this.view?.dispose?.()
    this.index = index
    const step = STEPS[index]
    this.status('')
    const ctx = this.context()
    this.view = step.render(ctx)
    this.title.textContent = step.title
    this.intro.textContent = step.intro(this.info.owner)
    const visible = STEPS.length - 1
    this.count.textContent = step.id === 'finish' ? 'Setup complete' : `Step ${index + 1} of ${visible} · ${step.name}`
    this.later.hidden = step.id === 'finish'
    for (const [position, node] of [...this.rail.querySelectorAll<HTMLElement>('.ob-rail-step')].entries()) {
      node.classList.toggle('ob-rail-done', position < index)
      node.classList.toggle('ob-rail-current', position === index)
    }
    this.dialog.dataset.step = step.id
    this.body.replaceChildren(this.view.element)
    this.body.scrollTop = 0
    this.view.element.classList.add('ob-step-enter')
    this.footer()
    requestAnimationFrame(() => {
      if (this.view?.focus) this.view.focus()
      else this.title.focus({ preventScroll: true })
    })
    if (step.id !== this.info.step) {
      this.info = { ...this.info, step: step.id }
      void postJson('/api/onboarding', { step: step.id }).catch(() => { /* the step is only where setup resumes */ })
    }
  }

  private trapFocus(event: KeyboardEvent): void {
    const focusable = [...this.dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.hasAttribute('disabled') && !node.hidden && node.offsetParent !== null)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  close(finished: boolean): void {
    this.closeTerminal()
    this.view?.dispose?.()
    this.view = null
    for (const node of this.inerted) node.removeAttribute('inert')
    document.documentElement.classList.remove('ob-open')
    this.root.classList.remove('ob-visible')
    this.root.classList.add('ob-leaving')
    window.setTimeout(() => this.root.remove(), 260)
    active = null
    window.dispatchEvent(new CustomEvent('poise:synced'))
    if (finished) {
      // Point once at where everything set here lives.
      const toggle = document.getElementById('menu-toggle')
      toggle?.classList.add('ob-pulse')
      window.setTimeout(() => toggle?.classList.remove('ob-pulse'), 3200)
    }
  }
}

export function openOnboarding(info: OnboardingInfo, start: StepId = info.step): void {
  if (active) return
  active = new Onboarding(info, start)
}

/** Opens setup when this workspace still needs it; true when it opened. The
 *  gateway's /link (as /?settings=link) opens it at pairing. */
export async function startOnboarding(place: string | null): Promise<boolean> {
  let info: OnboardingInfo | null
  try {
    info = await loadOnboarding()
  } catch (error) {
    console.error('[setup] the setup state could not be read:', error)
    return false
  }
  if (!info || info.status !== 'pending') return false
  openOnboarding(info, place === 'link' ? 'link' : info.step)
  return true
}

/** Settings → General → Run setup again. */
export async function restartOnboarding(): Promise<void> {
  await postJson('/api/onboarding', { restart: true })
  const info = await loadOnboarding()
  if (info) openOnboarding(info, 'theme')
}
