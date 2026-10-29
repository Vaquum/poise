// Automatic write access for the agent account on every repository under the
// covered accounts (issue #125, PRD #744). Each pass invites the configured
// agent account with push permission wherever its access is not confirmed,
// then accepts the person's pending invitations on the agent side. Listing
// reuses github-interface --view-repos; the grant itself is gh api with
// per-account tokens, like publishing and action runs.

import { getMeta, setMeta } from './db'
import { readyOrganizations } from './organizations'
import { runFile } from './process'

const GH_INTERFACE = 'github-interface'
const PASS_INTERVAL_MS = 60_000
const FAILURE_BACKOFF_MS = 24 * 60 * 60_000
const WARNING_INTERVAL_MS = 60 * 60_000
const API_TIMEOUT_MS = 30_000
const TOKEN_TIMEOUT_MS = 15_000
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/
const TOKEN_PATTERN = /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g

const credentialEnv = {
  GH_HOST: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
  GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined,
}

export interface ReconcileResult {
  repos: number
  invited: string[]
  accepted: number[]
}

interface ListedRepo {
  fullName: string
  id: number
  archived: boolean
}

interface Invitation {
  id: number
  owner: string
  inviter: string
}

// Recent failures and warnings by key, so a persistently failing repository
// or a missing login neither spams GitHub nor the log on every pass.
const recentFailures = new Map<string, number>()

/** Forget backoff and warning state, so the next pass retries everything. */
export function resetAgentCollaboratorFailures(): void {
  recentFailures.clear()
}

function backedOff(key: string, now: number): boolean {
  const failedAt = recentFailures.get(key)
  return failedAt !== undefined && now - failedAt < FAILURE_BACKOFF_MS
}

function warnOnce(key: string, now: number, message: string): void {
  const warnedAt = recentFailures.get(key)
  if (warnedAt !== undefined && now - warnedAt < WARNING_INTERVAL_MS) return
  recentFailures.set(key, now)
  console.warn(`[agent-collaborator] ${message}`)
}

// Confirmations are scoped to the agent account they were granted to: a
// Settings change re-verifies every repository for the new agent instead of
// inheriting the previous agent's access. Entries bind the repository id, so
// a deleted and recreated same-name repository re-verifies instead of
// inheriting the deleted repository's confirmation.
function confirmedKey(login: string, agent: string): string {
  return `agent_collaborator_confirmed:${login.toLowerCase()}:${agent.toLowerCase()}`
}

function readConfirmed(login: string, agent: string): Map<string, number> {
  const empty = new Map<string, number>()
  const raw = getMeta(confirmedKey(login, agent))
  if (!raw) return empty
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    const confirmed = new Map<string, number>()
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2 || !Number.isInteger(entry[0]) || typeof entry[1] !== 'string') {
        throw new Error('not an id/name pair')
      }
      confirmed.set(entry[1].toLowerCase(), entry[0])
    }
    return confirmed
  } catch {
    console.warn(`[agent-collaborator] confirmed repositories for ${login} are unreadable; re-verifying all of them`)
    return empty
  }
}

async function tokenFor(login: string): Promise<string | null> {
  try {
    const token = (await runFile('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login], {
      env: credentialEnv, timeoutMs: TOKEN_TIMEOUT_MS, maxOutputBytes: 64 * 1024,
    })).stdout.trim()
    return token || null
  } catch {
    return null
  }
}

interface GhAnswer {
  status: number
  body: unknown
}

function parseAnswer(stdout: string): GhAnswer {
  const separator = /\r?\n\r?\n/.exec(stdout)
  if (!separator) throw new Error('GitHub returned no HTTP response')
  const status = Number(/^HTTP\/\S+ (\d{3})\b/.exec(stdout.slice(0, separator.index))?.[1])
  if (!Number.isInteger(status)) throw new Error('GitHub returned no HTTP status')
  const text = stdout.slice(separator.index + separator[0].length).trim()
  return { status, body: text ? JSON.parse(text) as unknown : null }
}

function stdoutOf(error: unknown): string | null {
  const stdout = (error as { stdout?: unknown }).stdout
  return typeof stdout === 'string' && stdout ? stdout : null
}

// One GitHub API request as the token's account. gh exits 1 on an HTTP
// error but still prints the --include response, which is the answer;
// anything without a status (no network, a timeout) still throws.
async function ghApi(token: string, method: string, endpoint: string, args: readonly string[] = []): Promise<GhAnswer> {
  try {
    const { stdout } = await runFile('gh', ['api', endpoint, '--method', method, '--include', ...args], {
      env: { ...credentialEnv, GH_HOST: 'github.com', GH_TOKEN: token },
      timeoutMs: API_TIMEOUT_MS, maxOutputBytes: 1024 * 1024,
    })
    return parseAnswer(stdout)
  } catch (error) {
    const printed = stdoutOf(error)
    if (printed) return parseAnswer(printed)
    throw error
  }
}

function redact(text: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((acc, secret) => acc.split(secret).join('***'), text).replace(TOKEN_PATTERN, '***')
}

function failureMessage(repo: string, status: number, body: unknown, secrets: readonly string[]): string {
  const detail = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message
    : 'no detail'
  return redact(`${repo}: GitHub returned HTTP ${status}: ${detail}`, secrets)
}

// Repositories are listed as the person: what they can see. Archived and
// disabled repositories cannot take a new collaborator, so they are
// reported for skipping instead of attempted every pass.
async function discoverRepos(login: string, me: string): Promise<ListedRepo[]> {
  const { stdout } = await runFile(GH_INTERFACE, ['--view-repos', login, '--token-user', me], {
    timeoutMs: API_TIMEOUT_MS, maxOutputBytes: 32 * 1024 * 1024,
  })
  const data: unknown = JSON.parse(stdout)
  const entries = (data as { repos?: unknown }).repos
  if (!Array.isArray(entries)) throw new Error(`repository discovery for ${login} returned no repository list`)
  return entries.map((entry) => {
    const record = entry as { full_name?: unknown, id?: unknown, archived?: unknown, disabled?: unknown, owner?: unknown }
    const fullName = typeof record.full_name === 'string' ? record.full_name : ''
    const owner = (record.owner as { login?: unknown } | undefined)?.login
    if (!REPOSITORY.test(fullName) || fullName.split('/')[0].toLowerCase() !== login.toLowerCase()
      || (owner !== undefined && String(owner).toLowerCase() !== login.toLowerCase())) {
      throw new Error(`repository discovery for ${login} returned an unexpected repository: ${fullName || '(unnamed)'}`)
    }
    if (!Number.isInteger(record.id)) {
      throw new Error(`repository discovery for ${login} returned a repository without an id: ${fullName}`)
    }
    return { fullName, id: record.id as number, archived: record.archived === true || record.disabled === true }
  })
}

async function listInvitations(token: string): Promise<Invitation[]> {
  const invitations: Invitation[] = []
  for (let page = 1; ; page += 1) {
    const { status, body } = await ghApi(token, 'GET', `user/repository_invitations?per_page=100&page=${page}`)
    if (status !== 200 || !Array.isArray(body)) throw new Error(`repository invitation listing returned HTTP ${status}`)
    if (body.length === 0) return invitations
    for (const entry of body) {
      const record = entry as { id?: unknown, repository?: unknown, inviter?: unknown }
      const repository = record.repository as { full_name?: unknown, owner?: unknown } | undefined
      const owner = (repository?.owner as { login?: unknown } | undefined)?.login
      const inviter = (record.inviter as { login?: unknown } | undefined)?.login
      if (!Number.isInteger(record.id) || typeof repository?.full_name !== 'string'
        || typeof owner !== 'string' || typeof inviter !== 'string') {
        console.warn('[agent-collaborator] skipping a malformed repository invitation')
        continue
      }
      invitations.push({ id: record.id as number, owner, inviter })
    }
    if (body.length < 100) return invitations
  }
}

async function inviteMissing(
  login: string, me: string, agent: string, secrets: readonly string[], getMeToken: () => Promise<string | null>,
): Promise<{ repos: number, invited: string[] }> {
  const now = Date.now()
  let listed: ListedRepo[]
  try {
    listed = await discoverRepos(login, me)
  } catch (error) {
    console.warn(`[agent-collaborator] ${redact(error instanceof Error ? error.message : String(error), secrets)}`)
    return { repos: 0, invited: [] }
  }
  const stored = readConfirmed(login, agent)
  const next = new Map<string, number>()
  const invited: string[] = []
  let token: string | null | undefined
  for (const repo of listed) {
    const key = repo.fullName.toLowerCase()
    if (repo.archived) continue
    if (stored.get(key) === repo.id) {
      next.set(key, repo.id)
      continue
    }
    if (backedOff(key, now)) continue
    token ??= await getMeToken()
    if (!token) {
      warnOnce(`token:${me.toLowerCase()}`, now, `GitHub sign-in is unavailable for ${me}; collaborator invites wait until gh auth login succeeds`)
      break
    }
    try {
      // A single idempotent write: 2xx covers an invitation created (201),
      // an existing collaborator (204), and a pending invitation restated.
      const { status, body } = await ghApi(token, 'PUT', `repos/${repo.fullName}/collaborators/${agent}`, ['--field', 'permission=push'])
      if (status < 200 || status >= 300) throw new Error(failureMessage(repo.fullName, status, body, [token, ...secrets]))
      next.set(key, repo.id)
      recentFailures.delete(key)
      invited.push(repo.fullName)
    } catch (error) {
      recentFailures.set(key, now)
      console.warn(`[agent-collaborator] ${redact(error instanceof Error ? error.message : String(error), token ? [token, ...secrets] : [...secrets])}`)
    }
  }
  const ordered = [...next.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, id]) => [id, name])
  setMeta(confirmedKey(login, agent), JSON.stringify(ordered))
  return { repos: listed.length, invited }
}

async function acceptPending(covered: ReadonlySet<string>, me: string, agent: string, secrets: readonly string[]): Promise<number[]> {
  const now = Date.now()
  const token = await tokenFor(agent)
  if (!token) {
    warnOnce(`token:${agent.toLowerCase()}`, now, `GitHub sign-in is unavailable for ${agent}; repository invitations wait until gh auth login succeeds`)
    return []
  }
  const withAgent = [token, ...secrets]
  let invitations: Invitation[]
  try {
    invitations = await listInvitations(token)
  } catch (error) {
    console.warn(`[agent-collaborator] ${redact(error instanceof Error ? error.message : String(error), withAgent)}`)
    return []
  }
  const accepted: number[] = []
  for (const invitation of invitations) {
    // Only the person's invitations under covered accounts are accepted;
    // anything else addressed to the agent is left for a human.
    if (!covered.has(invitation.owner.toLowerCase()) || invitation.inviter.toLowerCase() !== me.toLowerCase()) continue
    const key = `invitation:${invitation.id}`
    if (backedOff(key, now)) continue
    try {
      const { status, body } = await ghApi(token, 'PATCH', `user/repository_invitations/${invitation.id}`)
      if (status === 404) {
        recentFailures.delete(key)
        continue
      }
      if (status < 200 || status >= 300) throw new Error(failureMessage(`invitation ${invitation.id}`, status, body, withAgent))
      recentFailures.delete(key)
      accepted.push(invitation.id)
    } catch (error) {
      recentFailures.set(key, now)
      console.warn(`[agent-collaborator] ${redact(error instanceof Error ? error.message : String(error), withAgent)}`)
    }
  }
  return accepted
}

/** Invite the agent where its access is unconfirmed and accept the person's
 *  pending invitations on the agent side. Inert while either account is
 *  unset; failures are logged and retried, never thrown. */
export async function reconcileAgentCollaborators(): Promise<ReconcileResult> {
  const result: ReconcileResult = { repos: 0, invited: [], accepted: [] }
  const me = (getMeta('me') || '').trim()
  const agent = (getMeta('agentAccount') || '').trim()
  if (!me || !agent || me.toLowerCase() === agent.toLowerCase()) return result
  const ready = readyOrganizations()
  if (!ready.length) return result
  let meToken: string | null | undefined
  const secrets: string[] = []
  const getMeToken = async (): Promise<string | null> => {
    if (meToken === undefined) {
      meToken = await tokenFor(me)
      if (meToken) secrets.push(meToken)
    }
    return meToken
  }
  for (const org of ready) {
    const account = await inviteMissing(org.login, me, agent, secrets, getMeToken)
    result.repos += account.repos
    result.invited.push(...account.invited)
  }
  result.accepted = await acceptPending(new Set(ready.map((org) => org.login.toLowerCase())), me, agent, secrets)
  return result
}

let timer: ReturnType<typeof setInterval> | undefined
let stopping = false
let passing: Promise<ReconcileResult> | undefined

export function startAgentCollaboratorRuntime(): void {
  if (timer) return
  stopping = false
  const tick = () => {
    if (stopping || passing) return
    passing = reconcileAgentCollaborators().catch((error: unknown) => {
      console.error('[agent-collaborator] the reconciliation pass failed:', error instanceof Error ? error.message : String(error))
      return { repos: 0, invited: [], accepted: [] }
    }).finally(() => { passing = undefined })
  }
  tick()
  timer = setInterval(tick, PASS_INTERVAL_MS)
  timer.unref()
}

export async function stopAgentCollaboratorRuntime(): Promise<void> {
  stopping = true
  if (timer) clearInterval(timer)
  timer = undefined
  await passing?.catch(() => undefined)
}
