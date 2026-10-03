// Settings → Connected accounts: one row per agent CLI with what its own
// status command says (GET /api/accounts), and the button that opens its
// login in a terminal.

import type { AccountId, ConnectedAccount } from '../../server/accounts/types'

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

/** The two GitHub accounts Settings → General names (`me` and `agentAccount`). */
export interface GitHubIdentities {
  me: string
  agentAccount: string
}

// GitHub logins are case-insensitive.
function sameLogin(a: string, b: string): boolean {
  return !!b && a.toLowerCase() === b.toLowerCase()
}

/** Every account gh holds, which is active and which are yours, and a line for
 *  each of your two accounts gh cannot use. Nothing is said about them while
 *  gh's own status is unknown. */
function ghAccounts(account: ConnectedAccount, identities: GitHubIdentities): string {
  if (!account.accounts) return ''
  const held = account.accounts
  const list = held.length ? `<ul class="st-gh-accounts" aria-label="GitHub accounts gh holds">${held.map((gh) => {
    const notes = [
      gh.active ? 'active' : '',
      sameLogin(gh.login, identities.me) ? 'your GitHub account' : '',
      sameLogin(gh.login, identities.agentAccount) ? 'agent account' : '',
    ].filter(Boolean)
    return `<li class="st-gh-account st-account-state-${gh.signedIn ? 'on' : 'off'}" data-login="${escapeHtml(gh.login)}">
      <span class="st-gh-login">${escapeHtml(gh.login)}</span>${notes.length ? `<span class="st-gh-notes">${notes.join(' · ')}</span>` : ''}
      ${gh.detail ? `<span class="st-gh-problem">${escapeHtml(gh.detail)}</span>` : ''}
    </li>`
  }).join('')}</ul>` : ''
  const usable = (login: string) => held.some((gh) => gh.signedIn && sameLogin(gh.login, login))
  const missing = [
    identities.me && !usable(identities.me) ? `Your GitHub account ${identities.me} is not signed in to gh.` : '',
    identities.agentAccount && !usable(identities.agentAccount) ? `The agent account ${identities.agentAccount} is not signed in to gh.` : '',
  ].filter(Boolean)
  return list + missing.map((text) => `<div class="st-help st-help-error st-gh-missing">${escapeHtml(text)}</div>`).join('')
}

/** The rows. `busy` while a terminal runs: one login at a time. */
export function accountsHtml(accounts: ConnectedAccount[], identities: GitHubIdentities, busy: boolean): string {
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
      ${ghAccounts(account, identities)}
      <div class="st-help st-help-info st-account-login">Runs <code>${escapeHtml(account.login.label)}</code></div>
    </div>`
  }).join('')
}
