// First-run setup in service mode (docs/Service-architecture.md, "First-run
// setup"): whether this workspace still has to be set up and the step it
// reached, the agent CLI logins that finished in a Connect terminal, and the
// check that proves a GitHub account signed in to gh can actually be used.

import { getMeta, setMeta } from '../db'
import { GH_STORED_ACCOUNTS_ENV } from '../accounts/clis'
import { isAccountId, type AccountId } from '../accounts/types'
import { readyOrganizations } from '../organizations'
import { runFile } from '../process'
import { setSettings } from '../settings'

export const ONBOARDING_STEPS = ['theme', 'github', 'agent', 'organizations', 'time', 'ai', 'models', 'link', 'finish'] as const
export type OnboardingStep = typeof ONBOARDING_STEPS[number]

export interface OnboardingState {
  status: 'pending' | 'done'
  /** Where setup resumes. */
  step: OnboardingStep
  completedAt: string | null
}

/** When each agent CLI's login last finished successfully in a Connect
 *  terminal, or the person said it had. Grok, Muse and Antigravity report no
 *  sign-in status, so this is how setup knows which of them were signed in here. */
export type AccountLogins = Partial<Record<AccountId, string>>

/** The CLIs with no command that reports a sign-in (server/accounts/status.ts). */
export const UNREPORTED_SIGN_IN: readonly AccountId[] = ['grok', 'muse', 'antigravity']
// Antigravity has no login command: its Connect terminal runs the app itself,
// which exits cleanly whether or not a sign-in finished. Only the person can say.
const EXIT_IS_NO_LOGIN: ReadonlySet<string> = new Set(['antigravity'])

const STATE_KEY = 'onboarding'
const LOGINS_KEY = 'account_logins'
// GitHub logins as settings.ts accepts them.
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
// What reviews, approvals and organization indexing need from an OAuth token.
const REQUIRED_SCOPES = ['repo', 'read:org']
const GH_TIMEOUT_MS = 20_000

function isStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value)
}

function stored(): OnboardingState | null {
  const raw = getMeta(STATE_KEY)
  if (!raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const state = value as Record<string, unknown>
  if (state.status !== 'pending' && state.status !== 'done') return null
  return {
    status: state.status,
    step: isStep(state.step) ? state.step : 'theme',
    completedAt: typeof state.completedAt === 'string' ? state.completedAt : null,
  }
}

function save(state: OnboardingState): OnboardingState {
  setMeta(STATE_KEY, JSON.stringify(state))
  return state
}

/**
 * The setup state, decided once: a workspace that already reads a GitHub
 * account was set up before setup existed and never sees it; any other
 * workspace starts it. The decision is stored, so adding accounts during
 * setup does not end it.
 */
export function onboardingState(): OnboardingState {
  return stored() ?? save(readyOrganizations().length > 0
    ? { status: 'done', step: 'finish', completedAt: null }
    : { status: 'pending', step: 'theme', completedAt: null })
}

export function updateOnboarding(input: unknown): OnboardingState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('send { step }, { done: true }, { restart: true } or { account, signedIn }')
  const body = input as Record<string, unknown>
  const current = onboardingState()
  if ('account' in body) {
    markLogin(body.account, body.signedIn)
    return current
  }
  if (body.restart === true) return save({ status: 'pending', step: 'theme', completedAt: current.completedAt })
  if (body.done === true) return save({ status: 'done', step: 'finish', completedAt: new Date().toISOString() })
  if (!isStep(body.step)) throw new Error(`step must be one of ${ONBOARDING_STEPS.join(', ')}`)
  return save({ ...current, step: body.step })
}

export function accountLogins(): AccountLogins {
  const raw = getMeta(LOGINS_KEY)
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(Object.entries(value).filter(([id, at]) => isAccountId(id) && typeof at === 'string')) as AccountLogins
  } catch {
    return {}
  }
}

/** A Connect terminal's login exited with `code`; a clean exit is a finished
 *  login, except where the terminal runs a whole app rather than a login. */
export function recordLogin(preset: string, code: number): void {
  if (code !== 0 || !isAccountId(preset) || EXIT_IS_NO_LOGIN.has(preset)) return
  setMeta(LOGINS_KEY, JSON.stringify({ ...accountLogins(), [preset]: new Date().toISOString() }))
}

/** The person says whether a CLI that reports no sign-in is signed in. */
export function markLogin(account: unknown, signedIn: unknown): void {
  if (typeof account !== 'string' || !(UNREPORTED_SIGN_IN as readonly string[]).includes(account)) {
    throw new Error(`account must be one of ${UNREPORTED_SIGN_IN.join(', ')}: the others report their own sign-in`)
  }
  if (typeof signedIn !== 'boolean') throw new Error('signedIn must be true or false')
  const logins: AccountLogins = { ...accountLogins() }
  if (signedIn) logins[account as AccountId] = new Date().toISOString()
  else delete logins[account as AccountId]
  setMeta(LOGINS_KEY, JSON.stringify(logins))
}

export type GitHubRole = 'me' | 'agent'

export type GitHubCheck =
  | { ok: true, login: string, scopes: string[] | null, note?: string }
  | { ok: false, reason: 'not-signed-in' | 'rejected' | 'other-account' | 'scopes', message: string }

/** `gh api --include` output: the status line and headers, a blank line, the body. */
function splitResponse(output: string): { headers: Map<string, string>, body: string } {
  const normalized = output.replace(/\r\n/g, '\n')
  const end = normalized.indexOf('\n\n')
  const head = end === -1 ? '' : normalized.slice(0, end)
  const headers = new Map<string, string>()
  for (const line of head.split('\n').slice(1)) {
    const colon = line.indexOf(':')
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return { headers, body: end === -1 ? normalized : normalized.slice(end + 2) }
}

/**
 * Proves that gh holds a working sign-in for `login`: the token gh keeps for
 * it answers GitHub's /user as that very account, with the scopes Poise needs.
 * The token stays inside this function; nothing it returns or throws holds it.
 */
export async function checkGitHubAccount(login: string): Promise<GitHubCheck> {
  let token: string
  try {
    token = (await runFile('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login], {
      env: { ...GH_STORED_ACCOUNTS_ENV }, timeoutMs: GH_TIMEOUT_MS, maxOutputBytes: 64 * 1024,
    })).stdout.trim()
  } catch {
    token = ''
  }
  if (!token) {
    return { ok: false, reason: 'not-signed-in', message: `gh holds no sign-in for ${login} yet. Connect it while signed in to GitHub as ${login}.` }
  }
  let output: string
  try {
    output = (await runFile('gh', ['api', 'user', '--include'], {
      env: { ...GH_STORED_ACCOUNTS_ENV, GH_TOKEN: token, GH_HOST: 'github.com' }, timeoutMs: GH_TIMEOUT_MS, maxOutputBytes: 512 * 1024,
    })).stdout
  } catch {
    return { ok: false, reason: 'rejected', message: `GitHub did not accept the sign-in gh holds for ${login}. Connect it again.` }
  }
  const { headers, body } = splitResponse(output)
  let user: unknown
  try { user = JSON.parse(body) } catch { user = null }
  const actual = user && typeof user === 'object' ? (user as { login?: unknown }).login : undefined
  if (typeof actual !== 'string' || !GITHUB_NAME.test(actual)) {
    return { ok: false, reason: 'rejected', message: `GitHub gave no account for the sign-in gh holds for ${login}. Connect it again.` }
  }
  if (actual.toLowerCase() !== login.toLowerCase()) {
    return { ok: false, reason: 'other-account', message: `The sign-in gh holds for ${login} belongs to ${actual}. Sign in to GitHub as ${login} and connect it again.` }
  }
  // Fine-grained and app tokens carry no scope header; their permissions show when they are used.
  const header = headers.get('x-oauth-scopes')
  const scopes = header === undefined ? null : header.split(',').map((scope) => scope.trim()).filter(Boolean)
  const missing = scopes ? REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope)) : []
  if (missing.length) {
    return { ok: false, reason: 'scopes', message: `${actual}'s sign-in lacks the ${missing.join(' and ')} scope Poise needs. Connect it again and accept every scope GitHub asks for.` }
  }
  return { ok: true, login: actual, scopes }
}

async function gh(args: string[]): Promise<string | null> {
  try {
    await runFile('gh', args, { env: { ...GH_STORED_ACCOUNTS_ENV }, timeoutMs: GH_TIMEOUT_MS, maxOutputBytes: 64 * 1024 })
    return null
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    return (typeof stderr === 'string' && stderr.trim().split('\n').at(-1)) || (error instanceof Error ? error.message : String(error))
  }
}

/**
 * Checks `login` and, when it works, makes it your GitHub account or the agent
 * account. git in the workspace then signs in through gh as your own account:
 * gh makes the account it signed in last the active one, so after the agent
 * account's login your own is made active again.
 */
export async function connectGitHubAccount(input: unknown): Promise<GitHubCheck> {
  const body = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  if (body.role !== 'me' && body.role !== 'agent') throw new Error('role must be "me" or "agent"')
  const login = typeof body.login === 'string' ? body.login.trim() : ''
  if (!GITHUB_NAME.test(login)) throw new Error('login must be a GitHub login: letters, digits and single hyphens')
  const check = await checkGitHubAccount(login)
  if (!check.ok) return check
  setSettings(body.role === 'me' ? { me: check.login } : { agentAccount: check.login })
  const me = body.role === 'me' ? check.login : getMeta('me')?.trim() || ''
  const problems: string[] = []
  if (body.role === 'agent' && me && me.toLowerCase() !== check.login.toLowerCase()) {
    const switched = await gh(['auth', 'switch', '--hostname', 'github.com', '--user', me])
    if (switched) problems.push(`gh could not make ${me} its active account again (${switched})`)
  }
  if (body.role === 'me') {
    const setup = await gh(['auth', 'setup-git', '--hostname', 'github.com'])
    if (setup) problems.push(`git could not be set up to sign in through gh (${setup})`)
  }
  return problems.length ? { ...check, note: `${problems.join('; ')}.` } : check
}
