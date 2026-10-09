// Settings → Admin, for the gateway's admins only: everyone who has signed in,
// how they get in, their workspace's state and image, and who may sign in.
// The gateway does the work (src/gateway-client.ts); its apex /admin page has
// the same controls for when the admin's own workspace cannot open.

import { effectiveTimezone } from '../config'
import { changeAdmin, fetchAdmin, type AdminChange, type AdminOverview, type AdminUser, type GatewayAccount } from '../gateway-client'
import './admin-settings.css'

export interface AdminSection {
  readonly element: HTMLElement
  refresh(): Promise<void>
  dispose(): void
}

const CONFIRM_MS = 4_000

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function moment(ms: number): string {
  return new Date(ms).toLocaleString([], { timeZone: effectiveTimezone(), dateStyle: 'medium', timeStyle: 'short' })
}

function action(user: AdminUser, change: AdminChange, label: string, danger = false): string {
  return `<button type="button" class="st-clear${danger ? ' ad-danger' : ''}" data-change="${change}" data-handle="${escapeHtml(user.handle)}">${label}</button>`
}

/** Bytes as a person reads them: 2.4 GB. */
export function size(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

function diskHtml(view: AdminOverview): string {
  const disk = view.disk
  if (!disk || disk.free === null || disk.total === null) return ''
  const text = `Server disk: ${size(disk.free)} free of ${size(disk.total)}, measured ${moment(disk.measuredAt)}.`
  return disk.low
    ? `<div class="st-help st-help-error">${escapeHtml(text)} Less than a tenth is free.</div>`
    : `<div class="st-help st-help-info">${escapeHtml(text)}</div>`
}

function userDiskHtml(user: AdminUser, budget: number): string {
  if (!user.disk) return ''
  return user.disk.overBudget
    ? `<div class="st-help st-help-error">${escapeHtml(`${size(user.disk.bytes)} on disk, over its ${size(budget)} budget`)}</div>`
    : `<div class="st-help st-help-info">${escapeHtml(`${size(user.disk.bytes)} on disk`)}</div>`
}

function userHtml(user: AdminUser, self: string, budget = 0): string {
  const state = user.workspace?.state ?? 'unknown'
  return `
    <div class="ad-user" data-user="${escapeHtml(user.handle)}">
      <div class="ad-user-head">
        <span class="ad-user-login">${escapeHtml(user.login)}</span>
        ${user.admin ? '<span class="ad-badge">admin</span>' : ''}
        <span class="ad-user-state ad-state-${escapeHtml(state.replace(/[^a-z]/g, '-'))}">${escapeHtml(state)}</span>
      </div>
      <div class="st-help st-help-info">${escapeHtml(user.access)} · last sign-in ${escapeHtml(moment(user.lastLoginAt))}</div>
      ${user.workspace?.image ? `<div class="st-help st-help-info">Image <code>${escapeHtml(user.workspace.image)}</code></div>` : ''}
      ${userDiskHtml(user, budget)}
      ${user.lastError ? `<div class="st-help st-help-error">${escapeHtml(user.lastError)}</div>` : ''}
      <div class="ad-actions">
        ${action(user, 'workspaces/start', 'Start')}
        ${action(user, 'workspaces/stop', 'Stop')}
        ${action(user, 'workspaces/restart', 'Restart')}
        ${user.handle === self ? '' : user.disabled ? action(user, 'users/enable', 'Enable') : action(user, 'users/disable', 'Disable', true)}
      </div>
    </div>`
}

function allowedHtml(view: AdminOverview): string {
  if (!view.allowed.length) return ''
  return view.allowed.map((entry) => `
    <div class="ad-allowed-row">
      <span class="ad-allowed-login">${escapeHtml(entry.handle)}</span>
      <span class="st-help st-help-info">${entry.source === 'env' ? 'POISE_ALLOWED_USERS' : `added by ${escapeHtml(entry.addedBy ?? 'an admin')}`}</span>
      ${entry.source === 'env' ? '' : `<button type="button" class="st-clear ad-danger" data-change="allow/remove" data-login="${escapeHtml(entry.handle)}">Remove</button>`}
    </div>`).join('')
}

export function adminSection(account: GatewayAccount): AdminSection {
  const element = document.createElement('div')
  element.className = 'ad'
  element.innerHTML = `
    <div class="tp-group-label">People and workspaces</div>
    <div class="st-help st-help-error ad-docker" hidden></div>
    <div class="ad-disk"></div>
    <div class="ad-users" aria-live="polite"><div class="st-help st-help-info">Reading who has signed in…</div></div>

    <div class="tp-group-label">Who may sign in</div>
    <div class="st-help st-help-info ad-allow-note"></div>
    <div class="ad-allowed"></div>
    <div class="st-org-add-row ad-allow-row">
      <input type="text" class="st-input ad-allow-input" aria-label="GitHub login to allow" placeholder="GitHub login" autocomplete="off" spellcheck="false" />
      <button type="button" class="st-clear ad-allow">Allow</button>
    </div>
    <div class="st-help ad-status" role="status" aria-live="polite"></div>

    <div class="tp-hint">If your own workspace will not open, the same controls are on the gateway's <a href="${escapeHtml(account.apexOrigin)}/admin" target="_blank" rel="noopener noreferrer">admin page</a>.</div>`

  const usersEl = element.querySelector<HTMLElement>('.ad-users')!
  const dockerEl = element.querySelector<HTMLElement>('.ad-docker')!
  const diskEl = element.querySelector<HTMLElement>('.ad-disk')!
  const noteEl = element.querySelector<HTMLElement>('.ad-allow-note')!
  const allowedEl = element.querySelector<HTMLElement>('.ad-allowed')!
  const allowInput = element.querySelector<HTMLInputElement>('.ad-allow-input')!
  const allowBtn = element.querySelector<HTMLButtonElement>('.ad-allow')!
  const statusEl = element.querySelector<HTMLElement>('.ad-status')!
  let generation = 0
  let busy = false
  let disposed = false
  let confirming: { button: HTMLButtonElement, label: string, timer: ReturnType<typeof setTimeout> } | null = null

  const status = (text: string, tone: 'info' | 'ok' | 'error' = 'info') => {
    statusEl.textContent = text
    statusEl.className = `st-help st-help-${tone} ad-status`
  }

  const render = (view: AdminOverview) => {
    dockerEl.hidden = !view.dockerError
    dockerEl.textContent = view.dockerError ? `Docker Engine: ${view.dockerError}` : ''
    diskEl.innerHTML = diskHtml(view)
    usersEl.innerHTML = view.users.length
      ? view.users.map((user) => userHtml(user, account.handle, view.disk?.budget ?? 0)).join('')
      : '<div class="st-help st-help-info">Nobody has signed in yet.</div>'
    noteEl.textContent = `Admins (${view.admins.join(', ')}) may always sign in.${view.allowedOrgs.length ? ` Members of ${view.allowedOrgs.join(', ')} may sign in too.` : ''}`
    allowedEl.innerHTML = allowedHtml(view)
  }

  const refresh = async (): Promise<void> => {
    const current = ++generation
    try {
      const view = await fetchAdmin()
      if (current === generation && !disposed) render(view)
    } catch (error) {
      if (current === generation && !disposed) status(`Could not read the admin overview: ${(error as Error).message}`, 'error')
    }
  }

  const apply = async (change: AdminChange, body: { login: string } | { handle: string }, done: string) => {
    if (busy) return
    busy = true
    element.classList.add('ad-busy')
    status('Working…')
    try {
      const view = await changeAdmin(change, body)
      generation++
      if (disposed) return
      render(view)
      status(done, 'ok')
    } catch (error) {
      if (!disposed) status((error as Error).message, 'error')
    } finally {
      busy = false
      element.classList.remove('ad-busy')
    }
  }

  const clearConfirm = () => {
    if (!confirming) return
    clearTimeout(confirming.timer)
    confirming.button.textContent = confirming.label
    confirming.button.classList.remove('ad-confirm')
    confirming = null
  }

  element.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-change]')
    if (!button) return
    const change = button.dataset.change as AdminChange
    if (change === 'allow/remove') {
      const login = button.dataset.login ?? ''
      void apply(change, { login }, `${login} may no longer sign in.`)
      return
    }
    const handle = button.dataset.handle ?? ''
    // Disabling ends every session, revokes every device and stops the workspace: one click asks, the second does it.
    if (change === 'users/disable' && confirming?.button !== button) {
      clearConfirm()
      confirming = { button, label: button.textContent ?? 'Disable', timer: setTimeout(clearConfirm, CONFIRM_MS) }
      button.textContent = 'Confirm disable'
      button.classList.add('ad-confirm')
      return
    }
    clearConfirm()
    const verb = { 'workspaces/start': 'started', 'workspaces/stop': 'stopped', 'workspaces/restart': 'restarted', 'users/disable': 'disabled', 'users/enable': 'enabled' }[change as Exclude<AdminChange, 'allow' | 'allow/remove'>]
    void apply(change, { handle }, change.startsWith('workspaces/') ? `The workspace of ${handle} is ${verb}.` : `${handle} is ${verb}.`)
  })

  const allow = () => {
    const login = allowInput.value.trim()
    if (!login) { allowInput.focus(); return }
    void apply('allow', { login }, `${login} may sign in now.`).then(() => {
      if (!statusEl.classList.contains('st-help-error')) allowInput.value = ''
    })
  }
  allowBtn.addEventListener('click', allow)
  allowInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); allow() }
  })

  void refresh()
  return {
    element,
    refresh,
    dispose: () => {
      disposed = true
      clearConfirm()
      element.remove()
    },
  }
}
