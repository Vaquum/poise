// Settings → Connected accounts: one row per agent CLI with what its own
// status command says (GET /api/accounts), and the button that opens its
// login in a terminal.

import type { AccountId, ConnectedAccount } from '../../server/accounts/types'
import './connected-accounts.css'

const ACCOUNT_NAMES: Record<AccountId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gh: 'GitHub',
  grok: 'Grok',
  muse: 'Muse',
  antigravity: 'Antigravity',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export async function fetchAccounts(): Promise<ConnectedAccount[]> {
  const res = await fetch('/api/accounts', { cache: 'no-store' })
  let data: { accounts?: unknown, error?: unknown } | null = null
  try { data = await res.json() } catch { /* reported below */ }
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`)
  if (!Array.isArray(data?.accounts)) throw new Error('the answer is unreadable')
  return data.accounts as ConnectedAccount[]
}

function state(account: ConnectedAccount): { text: string, tone: 'on' | 'off' | 'unknown' } {
  if (!account.installed) return { text: 'Not installed', tone: 'unknown' }
  if (account.signedIn === true) return { text: account.identity ? `Signed in as ${account.identity}` : 'Signed in', tone: 'on' }
  if (account.signedIn === false) return { text: 'Not signed in', tone: 'off' }
  return { text: 'Sign-in not reported', tone: 'unknown' }
}

function ghAccounts(account: ConnectedAccount, me: string): string {
  if (!account.accounts?.length) return ''
  return `<ul class="st-gh-accounts" aria-label="GitHub accounts gh holds">${account.accounts.map((gh) => {
    const notes = [gh.active ? 'active' : '', me && gh.login.toLowerCase() === me.toLowerCase() ? 'you' : ''].filter(Boolean)
    return `<li class="st-gh-account st-account-state-${gh.signedIn ? 'on' : 'off'}" data-login="${escapeHtml(gh.login)}">
      <span class="st-gh-login">${escapeHtml(gh.login)}</span>${notes.length ? `<span class="st-gh-notes">${notes.join(' · ')}</span>` : ''}
      ${gh.detail ? `<span class="st-gh-problem">${escapeHtml(gh.detail)}</span>` : ''}
    </li>`
  }).join('')}</ul>`
}

/** The rows. `busy` while a terminal runs: one login at a time. */
export function accountsHtml(accounts: ConnectedAccount[], me: string, busy: boolean): string {
  return accounts.map((account) => {
    const name = ACCOUNT_NAMES[account.id]
    const { text, tone } = state(account)
    const action = account.signedIn ? 'Reconnect' : 'Connect'
    const disabled = busy || !account.installed
    return `
    <div class="st-account" data-account="${account.id}">
      <div class="st-account-head">
        <span class="st-account-name">${escapeHtml(name)}</span>
        ${account.version ? `<span class="st-account-version">${escapeHtml(account.version)}</span>` : ''}
        <button type="button" class="st-clear st-account-connect" data-connect="${account.id}" aria-label="${action} ${escapeHtml(name)}"${disabled ? ' disabled' : ''}>${action}</button>
      </div>
      <div class="st-account-state st-account-state-${tone}">${escapeHtml(text)}</div>
      ${account.detail ? `<div class="st-help st-help-info st-account-detail">${escapeHtml(account.detail)}</div>` : ''}
      ${ghAccounts(account, me)}
      <div class="st-help st-help-info st-account-login">Runs <code>${escapeHtml(account.login.label)}</code></div>
    </div>`
  }).join('')
}
