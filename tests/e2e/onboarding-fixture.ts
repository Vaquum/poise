// First-run setup's stand-ins: Poise's API and the gateway's for a workspace
// that still has to be set up. The GitHub check, the logins and the gateway
// are tested on their own sides (tests/onboarding.test.ts, gateway/tests).

import type { Page } from '@playwright/test'
import type { ConnectedAccount } from '../../server/accounts/types'
import type { Organization } from '../../src/config'
import type { PairedDevice } from '../../src/gateway-client'

export interface SetupState {
  status: 'pending' | 'done'
  step: string
  logins: Record<string, string>
  me: string
  agentAccount: string
  timezone: string
  models: Record<string, Record<string, string>>
  organizations: Organization[]
  devices: PairedDevice[]
  /** The accounts gh holds a working sign-in for. */
  githubAccounts: string[]
  writes: Array<{ path: string, body: Record<string, unknown> }>
}

export function organization(login: string, status: Organization['status'], error: string | null = null): Organization {
  return { login, managed: true, status, stage: status === 'initializing' ? 'indexing' : status, error, activatedAt: status === 'ready' ? '2026-10-09T07:00:00Z' : null }
}

const ACCOUNTS: ConnectedAccount[] = [
  { id: 'claude', installed: true, version: '2.3.0', signedIn: true, identity: 'octo@example.test', detail: 'Claude Max subscription', login: { label: 'claude auth login --claudeai' } },
  { id: 'codex', installed: true, version: '0.160.0', signedIn: false, identity: null, detail: null, login: { label: 'codex login --device-auth' } },
  { id: 'gh', installed: true, version: '2.92.0', signedIn: true, identity: 'octocat', detail: null, login: { label: 'gh auth login' }, accounts: [{ login: 'octocat', active: true, signedIn: true, detail: null }] },
  { id: 'grok', installed: true, version: '1.0.46', signedIn: null, identity: null, detail: 'Grok\'s CLI has no command that reports whether it is signed in.', login: { label: 'grok login --device-auth' } },
  { id: 'muse', installed: true, version: '1.4.2', signedIn: null, identity: null, detail: 'Muse\'s CLI has no command that reports whether it is signed in.', login: { label: 'muse login' } },
  { id: 'antigravity', installed: false, version: null, signedIn: null, identity: null, detail: 'agy is not installed: Poise cannot find it on its PATH.', login: { label: 'agy' } },
]

const CATALOG = {
  models: [
    { identity: 'opus-5-max', provider: 'claude', selector: 'opus', effort: 'max' },
    { identity: 'opus-5-high', provider: 'claude', selector: 'opus', effort: 'high' },
    { identity: 'gpt-6-astra-ultra', provider: 'codex', selector: 'gpt-6', effort: 'ultra' },
    { identity: 'grok-5-heavy', provider: 'grok', selector: 'grok-5', effort: 'heavy' },
    { identity: 'muse-2-deep', provider: 'muse', selector: 'muse-2', effort: 'deep' },
  ],
  review_providers: ['claude', 'codex', 'grok', 'muse'],
  path: '/models.toml',
}

const PLACES = [
  { key: 'chat', label: 'Chat', why: 'Card chats opened from Current, Archive and Swarm.', review: false, reviewers: false, providers: null, default: 'gpt-6-astra-ultra', fallback: 'opus-5-high', notes: [], stored: null },
  { key: 'pr_review', label: 'PR review', why: 'Automatic and manual reviews, including replays.', review: true, reviewers: true, providers: ['claude', 'codex', 'grok', 'muse'], default: 'opus-5-max', fallback: 'gpt-6-astra-ultra', secondary: 'muse-2-deep', tertiary: 'grok-5-heavy', notes: [], stored: null },
]

export async function setupWorkspace(page: Page, initial: Partial<SetupState> = {}): Promise<SetupState> {
  const state: SetupState = {
    status: 'pending',
    step: 'theme',
    logins: { grok: '2026-10-09T06:00:00Z' },
    me: '',
    agentAccount: 'octo-agent',
    timezone: '',
    models: {},
    organizations: [organization('acme', 'error', 'GitHub authentication is unavailable for octocat. Run gh auth login for that account and retry.')],
    devices: [],
    githubAccounts: ['octocat', 'octo-agent'],
    writes: [],
    ...initial,
  }
  await page.addInitScript(() => {
    if (sessionStorage.getItem('setup-test-started')) return
    sessionStorage.setItem('setup-test-started', '1')
    localStorage.clear()
    localStorage.setItem('poise-view', 'current')
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com|avatars\.githubusercontent\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.method() === 'POST' ? (request.postDataJSON() ?? {}) as Record<string, unknown> : null
    if (body) state.writes.push({ path: url.pathname, body })
    const settings = () => ({ org: '', me: state.me, agentAccount: state.agentAccount, timezone: state.timezone, organizations: state.organizations, models: state.models })
    switch (url.pathname) {
      case '/api/workspace': return route.fulfill({ json: { mode: 'service', owner: 'octocat' } })
      case '/api/onboarding':
        if (typeof body?.account === 'string') {
          if (body.signedIn === true) state.logins = { ...state.logins, [body.account]: '2026-10-09T07:00:00Z' }
          else state.logins = Object.fromEntries(Object.entries(state.logins).filter(([id]) => id !== body.account))
        } else if (body?.done === true) { state.status = 'done'; state.step = 'finish' }
        else if (body?.restart === true) { state.status = 'pending'; state.step = 'theme' }
        else if (typeof body?.step === 'string') state.step = body.step
        return route.fulfill({ json: { available: true, status: state.status, step: state.step, owner: 'octocat', logins: state.logins, completedAt: null } })
      case '/api/onboarding/github': {
        const login = String(body?.login)
        if (!state.githubAccounts.includes(login)) {
          return route.fulfill({ json: { ok: false, reason: 'not-signed-in', message: `gh holds no sign-in for ${login} yet. Connect it while signed in to GitHub as ${login}.` } })
        }
        if (body?.role === 'me') state.me = login
        else state.agentAccount = login
        return route.fulfill({ json: { ok: true, login, scopes: ['repo', 'read:org', 'gist'] } })
      }
      case '/api/settings':
        if (body && typeof body.timezone === 'string') state.timezone = body.timezone
        if (body && body.models) state.models = body.models as SetupState['models']
        return route.fulfill({ json: settings() })
      case '/api/organizations':
        if (body?.org) state.organizations = [...state.organizations, organization(String(body.org), 'initializing')]
        return route.fulfill({ status: body ? 202 : 200, json: { organizations: state.organizations } })
      case '/api/accounts': return route.fulfill({ json: { accounts: ACCOUNTS } })
      case '/api/models': return route.fulfill({ json: { catalog: CATALOG, places: PLACES, fixed: [], refresh: null } })
      case '/api/claude-auth': return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
      case '/api/current': return route.fulfill({ json: { cards: [] } })
      case '/_poise/api/account':
        return route.fulfill({ json: { login: 'octocat', handle: 'octocat', isAdmin: false, workspaceHost: 'octocat.poise.example.test', apexOrigin: 'https://poise.example.test', link: { installer: 'https://github.com/autonomio/poise/releases/latest/download/install.sh', releases: 'https://github.com/autonomio/poise/releases/latest' } } })
      case '/_poise/api/devices': return route.fulfill({ json: { devices: state.devices } })
      case '/_poise/api/devices/pair':
        setTimeout(() => {
          state.devices = [{ id: 'laptop', label: 'PoiseLink/0.3.1', createdAt: Date.parse('2026-10-09T07:00:00Z'), lastUsedAt: null, revokedAt: null, state: 'active' }]
        }, 300)
        return route.fulfill({ json: { decision: 'approve', message: 'Approved. Poise Link on that computer is now paired with octocat.poise.example.test.' } })
    }
    const retry = /^\/api\/organizations\/([^/]+)\/retry$/.exec(url.pathname)
    if (retry) {
      state.organizations = state.organizations.map((org) => org.login === retry[1] ? organization(org.login, 'initializing') : org)
      return route.fulfill({ status: 202, json: { organizations: state.organizations } })
    }
    return route.fulfill({ json: {} })
  })
  return state
}
