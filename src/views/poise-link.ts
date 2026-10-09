// Poise Link in Settings → Accounts, and as the last step of first-run setup:
// how to install it, approving the code it shows, and the computers paired
// with this workspace. Pairing is the gateway's (src/gateway-client.ts).

import { effectiveTimezone } from '../config'
import { decidePairing, fetchDevices, revokeDevice, type GatewayAccount, type PairedDevice } from '../gateway-client'
import './poise-link.css'

export interface PoiseLinkSection {
  readonly element: HTMLElement
  /** Reads the paired computers again. */
  refresh(): Promise<void>
  dispose(): void
}

export interface PoiseLinkOptions {
  /** A computer finished pairing after a code was approved here. */
  onPaired?: (device: PairedDevice) => void
  /** Inside first-run setup: its step already says what Poise Link is, and the two steps are numbered. */
  guided?: boolean
}

// After an approval Poise Link collects its token on its next poll, every five
// seconds; the list is read until its device shows up.
const PAIRING_POLL_MS = 2_500
const PAIRING_WATCH_MS = 2 * 60_000

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function deviceName(device: PairedDevice): string {
  const version = /^PoiseLink\/(\S+)/.exec(device.label ?? '')?.[1]
  return version ? `Poise Link ${version}` : device.label || 'Poise Link'
}

function moment(ms: number): string {
  return new Date(ms).toLocaleString([], { timeZone: effectiveTimezone(), dateStyle: 'medium', timeStyle: 'short' })
}

const STATE_TEXT: Record<PairedDevice['state'], string> = { active: 'Paired', revoked: 'Revoked', expired: 'Expired' }

function devicesHtml(devices: PairedDevice[]): string {
  if (!devices.length) return '<div class="st-help st-help-info">No computer is paired yet.</div>'
  return devices.map((device) => `
    <div class="pl-device" data-device="${escapeHtml(device.id)}">
      <div class="pl-device-head">
        <span class="pl-device-name">${escapeHtml(deviceName(device))}</span>
        <span class="pl-device-state pl-device-state-${device.state}">${STATE_TEXT[device.state]}</span>
      </div>
      <div class="st-help st-help-info">Paired ${escapeHtml(moment(device.createdAt))} · ${device.lastUsedAt ? `last used ${escapeHtml(moment(device.lastUsedAt))}` : 'not used yet'}</div>
      ${device.state === 'active'
        ? `<button type="button" class="st-clear pl-revoke" data-revoke="${escapeHtml(device.id)}">Revoke</button>`
        : device.state === 'expired' ? '<div class="st-help st-help-info">Pair it again in Poise Link.</div>' : ''}
    </div>`).join('')
}

// Settings and first-run setup can each hold a section at once.
let sections = 0

export function poiseLinkSection(account: GatewayAccount, options: PoiseLinkOptions = {}): PoiseLinkSection {
  const codeId = `pl-code-${++sections}`
  const element = document.createElement('div')
  element.className = 'pl'
  const curl = `curl -fsSL ${account.link.installer} | sh`
  const wget = `wget -qO- ${account.link.installer} | sh`
  element.innerHTML = `
    ${options.guided ? '' : `<div class="tp-section">
      <div class="st-help st-help-info pl-intro">Poise Link keeps your snippets on your computer and brings Poise's alerts to it.</div>
    </div>`}
    <div class="tp-section">
      <span class="tp-label">${options.guided ? '1. Install Poise Link' : 'Install it'}</span>
      <div class="pl-command">
        <code class="pl-command-text">${escapeHtml(curl)}</code>
        <button type="button" class="st-clear pl-copy">Copy</button>
      </div>
      <div class="st-help st-help-info">Run it in a terminal on macOS, Debian 12+ or Ubuntu 24.04+. It installs Poise Link, and Espanso when it is missing, then opens Poise Link to pair. Without curl: <code>${escapeHtml(wget)}</code>. Windows installers are on the <a href="${escapeHtml(account.link.releases)}" target="_blank" rel="noopener noreferrer">release page</a>.</div>
    </div>
    <div class="tp-section">
      <label class="tp-label" for="${codeId}">${options.guided ? '2. Enter the code Poise Link shows' : 'Enter the code Poise Link shows'}</label>
      <input id="${codeId}" type="text" class="st-input pl-code" placeholder="XXXX-XXXX" maxlength="9" autocomplete="off" autocapitalize="characters" spellcheck="false" />
      <div class="st-row pl-decide">
        <button type="button" class="st-save pl-approve">Approve</button>
        <button type="button" class="st-clear pl-deny">Deny</button>
      </div>
      <div class="st-help st-help-info">Approve only a code your own Poise Link shows you. It pairs with <code>${escapeHtml(account.workspaceHost)}</code>.</div>
      <div class="st-help pl-status" role="status" aria-live="polite"></div>
    </div>
    <div class="tp-section">
      <span class="tp-label">Paired computers</span>
      <div class="pl-devices" aria-live="polite"><div class="st-help st-help-info">Reading the paired computers…</div></div>
    </div>`

  const codeInput = element.querySelector<HTMLInputElement>('.pl-code')!
  const approveBtn = element.querySelector<HTMLButtonElement>('.pl-approve')!
  const denyBtn = element.querySelector<HTMLButtonElement>('.pl-deny')!
  const copyBtn = element.querySelector<HTMLButtonElement>('.pl-copy')!
  const statusEl = element.querySelector<HTMLElement>('.pl-status')!
  const devicesEl = element.querySelector<HTMLElement>('.pl-devices')!
  let devices: PairedDevice[] | null = null
  let generation = 0
  let deciding = false
  let disposed = false
  let watchTimer: ReturnType<typeof setTimeout> | null = null
  let copyTimer: ReturnType<typeof setTimeout> | null = null

  const status = (text: string, tone: 'info' | 'ok' | 'error' = 'info') => {
    statusEl.textContent = text
    statusEl.className = `st-help st-help-${tone} pl-status`
  }

  const render = () => {
    if (devices) devicesEl.innerHTML = devicesHtml(devices)
  }

  const refresh = async (): Promise<void> => {
    const current = ++generation
    try {
      const next = await fetchDevices()
      if (current !== generation || disposed) return
      devices = next
      render()
    } catch (error) {
      if (current !== generation || disposed) return
      if (!devices) devicesEl.innerHTML = `<div class="st-help st-help-error">${escapeHtml(`Could not read the paired computers: ${(error as Error).message}`)}</div>`
    }
  }

  const stopWatching = () => {
    if (watchTimer) clearTimeout(watchTimer)
    watchTimer = null
  }

  // The device appears once Poise Link has collected its token.
  const watchForPairing = (known: Set<string>) => {
    stopWatching()
    const until = Date.now() + PAIRING_WATCH_MS
    const tick = async () => {
      watchTimer = null
      await refresh()
      if (disposed) return
      const paired = devices?.find((device) => device.state === 'active' && !known.has(device.id))
      if (paired) {
        status(`${deviceName(paired)} is paired. Your snippets and alerts now reach that computer.`, 'ok')
        options.onPaired?.(paired)
        return
      }
      if (Date.now() < until) watchTimer = setTimeout(() => { void tick() }, PAIRING_POLL_MS)
    }
    watchTimer = setTimeout(() => { void tick() }, PAIRING_POLL_MS)
  }

  const decide = async (decision: 'approve' | 'deny') => {
    if (deciding) return
    const code = codeInput.value.trim()
    if (!/^[A-Za-z]{4}-?[A-Za-z]{4}$/.test(code)) {
      status('Enter the eight letters Poise Link shows, like BCDF-GHJK.', 'error')
      codeInput.focus()
      return
    }
    deciding = true
    approveBtn.disabled = true
    denyBtn.disabled = true
    status(decision === 'approve' ? 'Approving…' : 'Denying…')
    const known = new Set((devices ?? []).map((device) => device.id))
    try {
      const answer = await decidePairing(code, decision)
      if (disposed) return
      codeInput.value = ''
      if (answer.decision === 'approve') {
        status(`${answer.message} Waiting for Poise Link to finish…`, 'ok')
        watchForPairing(known)
      } else status(answer.message, 'info')
    } catch (error) {
      if (!disposed) status((error as Error).message, 'error')
    } finally {
      deciding = false
      approveBtn.disabled = false
      denyBtn.disabled = false
    }
  }

  codeInput.addEventListener('input', () => {
    const upper = codeInput.value.toUpperCase()
    if (upper !== codeInput.value) codeInput.value = upper
  })
  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void decide('approve') }
  })
  approveBtn.addEventListener('click', () => { void decide('approve') })
  denyBtn.addEventListener('click', () => { void decide('deny') })
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(curl)
      copyBtn.textContent = 'Copied'
    } catch {
      // Without clipboard access the command is selected for a manual copy.
      const range = document.createRange()
      range.selectNodeContents(element.querySelector('.pl-command-text')!)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      copyBtn.textContent = 'Selected'
    }
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy' }, 1600)
  })
  devicesEl.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-revoke]')
    if (!button?.dataset.revoke) return
    button.disabled = true
    try {
      devices = await revokeDevice(button.dataset.revoke)
      generation++
      render()
    } catch (error) {
      button.disabled = false
      status(`Could not revoke it: ${(error as Error).message}`, 'error')
    }
  })

  void refresh()
  return {
    element,
    refresh,
    dispose: () => {
      disposed = true
      stopWatching()
      if (copyTimer) clearTimeout(copyTimer)
      element.remove()
    },
  }
}
