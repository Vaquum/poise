// GitHub as the person publishing (server/publishing-api.ts): every call is
// `gh api` with the token gh holds for their own account, Settings → General →
// Your GitHub account, never the automation account. The same rule as the
// Editor's Create issue (server/gh.ts, open_issue).

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from './http'
import { runFile } from './process'

const CREDENTIAL_ENV = {
  GH_HOST: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
  GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined,
}
const API_TIMEOUT_MS = 60_000
const FORK_READY_ATTEMPTS = 20
const FORK_READY_DELAY_MS = 1_500

export const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/** A GitHub answer that was not a success: its HTTP status and GitHub's message. */
export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GitHubError'
  }
}

export interface GitHubSession {
  me: string
  token: string
}

/** The person's own GitHub credential, as gh holds it. */
export async function signIn(me: string): Promise<GitHubSession> {
  if (!me) throw new HttpError(400, 'Set your GitHub account in Settings → General before publishing.')
  let token = ''
  try {
    token = (await runFile('gh', ['auth', 'token', '--hostname', 'github.com', '--user', me], {
      env: CREDENTIAL_ENV, timeoutMs: 15_000, maxOutputBytes: 64 * 1024,
    })).stdout.trim()
  } catch {
    // The credential command's own output never reaches an answer.
    throw new HttpError(502, `GitHub sign-in is unavailable for ${me}. Run gh auth login as ${me}, then try again.`)
  }
  if (!token) throw new HttpError(502, `gh holds no GitHub credential for ${me}. Run gh auth login as ${me}.`)
  return { me, token }
}

function redact(text: string, session: GitHubSession): string {
  return text.split(session.token).join('***').replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '***')
}

interface Answer {
  status: number
  body: any
}

function answerFrom(stdout: string): Answer | null {
  const separator = /\r?\n\r?\n/.exec(stdout)
  const head = separator ? stdout.slice(0, separator.index) : stdout
  const status = /^HTTP\/\S+ (\d{3})\b/.exec(head)?.[1]
  if (!status) return null
  const text = separator ? stdout.slice(separator.index + separator[0].length).trim() : ''
  let body: unknown = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { status: Number(status), body }
}

function messageOf(body: any, fallback: string): string {
  if (body && typeof body === 'object') {
    const details = Array.isArray(body.errors)
      ? body.errors.map((e: any) => (typeof e === 'string' ? e : e?.message)).filter(Boolean).join('; ')
      : ''
    if (typeof body.message === 'string') return details ? `${body.message}: ${details}` : body.message
    if (details) return details
  }
  return fallback
}

/** One GitHub API request. A JSON body travels in a private file, so a long document never meets the argument limit. */
async function request(session: GitHubSession, method: string, endpoint: string, input?: unknown): Promise<Answer> {
  const args = ['api', endpoint, '--method', method, '--include', '--header', 'Accept: application/vnd.github+json']
  let folder = ''
  try {
    if (input !== undefined) {
      folder = await mkdtemp(join(tmpdir(), 'poise-publish-'))
      const file = join(folder, 'request.json')
      await writeFile(file, JSON.stringify(input), { mode: 0o600 })
      args.push('--input', file)
    }
    let stdout: string
    try {
      stdout = (await runFile('gh', args, {
        env: { ...CREDENTIAL_ENV, GH_HOST: 'github.com', GH_TOKEN: session.token },
        timeoutMs: API_TIMEOUT_MS,
        maxOutputBytes: 16 * 1024 * 1024,
      })).stdout
    } catch (error) {
      // gh exits 1 on an HTTP error and still prints the response; that is an
      // answer. Anything else (no network, a timeout) is not.
      const printed = (error as { stdout?: unknown }).stdout
      const answer = typeof printed === 'string' ? answerFrom(printed) : null
      if (answer) return answer
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n').pop() || (error as Error).message
      throw new GitHubError(`GitHub could not be reached: ${redact(stderr, session)}`, 502)
    }
    const answer = answerFrom(stdout)
    if (!answer) throw new GitHubError('GitHub returned no HTTP status', 502)
    return answer
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true })
  }
}

function fail(answer: Answer, what: string): never {
  throw new GitHubError(`${what}: ${messageOf(answer.body, `GitHub answered ${answer.status}`)}`, answer.status)
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export interface RepositoryInfo {
  fullName: string
  owner: string
  defaultBranch: string
  canPush: boolean
}

export async function repository(session: GitHubSession, repo: string): Promise<RepositoryInfo> {
  const answer = await request(session, 'GET', `repos/${repo}`)
  if (answer.status === 404) throw new GitHubError(`${repo} does not exist, or ${session.me} cannot see it`, 404)
  if (answer.status !== 200) fail(answer, `Reading ${repo}`)
  const body = answer.body
  return {
    fullName: String(body.full_name),
    owner: String(body.owner?.login ?? String(body.full_name).split('/')[0]),
    defaultBranch: String(body.default_branch),
    canPush: body.permissions?.push === true,
  }
}

export interface RepositoryFile {
  text: string
  sha: string
}

/** A file's text on a branch, or null when there is none. */
export async function fileAt(session: GitHubSession, repo: string, path: string, ref: string): Promise<RepositoryFile | null> {
  const answer = await request(session, 'GET', `repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`)
  if (answer.status === 404) return null
  if (answer.status !== 200) fail(answer, `Reading ${path} in ${repo}`)
  const body = answer.body
  if (!body || body.type !== 'file') throw new GitHubError(`${path} in ${repo} is not a file`, 422)
  if (body.encoding !== 'base64' || typeof body.content !== 'string') throw new GitHubError(`${path} in ${repo} is too large to read`, 422)
  return { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: String(body.sha) }
}

/** The commit at the head of a branch, or null when there is no such branch. */
export async function branchHead(session: GitHubSession, repo: string, branch: string): Promise<string | null> {
  const answer = await request(session, 'GET', `repos/${repo}/git/ref/${encodePath(`heads/${branch}`)}`)
  if (answer.status === 404) return null
  if (answer.status !== 200) fail(answer, `Reading ${branch} in ${repo}`)
  return String(answer.body?.object?.sha)
}

/** A new branch at `sha`; false when the name is taken. */
export async function createBranch(session: GitHubSession, repo: string, branch: string, sha: string): Promise<boolean> {
  const answer = await request(session, 'POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha })
  if (answer.status === 201) return true
  if (answer.status === 422 && /already exists/i.test(messageOf(answer.body, ''))) return false
  fail(answer, `Creating ${branch} in ${repo}`)
}

/**
 * One file written as one commit on a branch, if the branch is still at
 * `expectedHead`. A branch that moved on is a 409, for the caller to read
 * again rather than write over what it has not seen.
 */
export async function commitFile(session: GitHubSession, repo: string, branch: string, expectedHead: string, message: string, path: string, text: string): Promise<string> {
  const query = 'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }'
  const variables = { input: {
    branch: { repositoryNameWithOwner: repo, branchName: branch },
    expectedHeadOid: expectedHead,
    message: { headline: message.slice(0, 200) },
    fileChanges: { additions: [{ path, contents: Buffer.from(text, 'utf8').toString('base64') }] },
  } }
  const answer = await request(session, 'POST', 'graphql', { query, variables })
  const errors = Array.isArray(answer.body?.errors) ? answer.body.errors : []
  if (answer.status === 200 && !errors.length) return String(answer.body.data.createCommitOnBranch.commit.oid)
  const detail = messageOf(answer.body, `GitHub answered ${answer.status}`)
  if (/expected branch to point to|expectedHeadOid|head oid/i.test(detail)) {
    throw new GitHubError(`${branch} in ${repo} changed while publishing; try again`, 409)
  }
  throw new GitHubError(`Committing ${path} to ${repo}: ${detail}`, answer.status === 200 ? 422 : answer.status)
}

export interface PullRequestInfo {
  number: number
  url: string
  state: 'open' | 'closed' | 'merged'
  headRef: string
  /** The commit its branch was at: for a merged one, what it merged. */
  headSha: string
}

function pullRequestFrom(body: any): PullRequestInfo {
  return {
    number: Number(body.number),
    url: String(body.html_url),
    state: body.merged === true || body.merged_at ? 'merged' : body.state === 'open' ? 'open' : 'closed',
    headRef: String(body.head?.ref ?? ''),
    headSha: String(body.head?.sha ?? ''),
  }
}

export async function openPullRequest(session: GitHubSession, repo: string, input: { title: string, body: string, head: string, base: string }): Promise<PullRequestInfo> {
  const answer = await request(session, 'POST', `repos/${repo}/pulls`, { ...input, maintainer_can_modify: true })
  if (answer.status !== 201) fail(answer, `Opening a pull request in ${repo}`)
  return pullRequestFrom(answer.body)
}

export async function pullRequest(session: GitHubSession, repo: string, number: number): Promise<PullRequestInfo> {
  const answer = await request(session, 'GET', `repos/${repo}/pulls/${number}`)
  if (answer.status !== 200) fail(answer, `Reading pull request #${number} in ${repo}`)
  return pullRequestFrom(answer.body)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The person's fork of `repo`, made when there is none, once GitHub can take
 * a branch in it. GitHub makes a fork in the background.
 */
export async function fork(session: GitHubSession, repo: string, options: { delayMs?: number } = {}): Promise<RepositoryInfo> {
  const answer = await request(session, 'POST', `repos/${repo}/forks`, { default_branch_only: true })
  if (answer.status !== 202 && answer.status !== 200) fail(answer, `Forking ${repo}`)
  const fullName = String(answer.body?.full_name)
  for (let attempt = 0; attempt < FORK_READY_ATTEMPTS; attempt++) {
    const info = await repository(session, fullName).catch((error: unknown) => {
      if (error instanceof GitHubError && error.status === 404) return null
      throw error
    })
    if (info && await branchHead(session, fullName, info.defaultBranch)) return info
    await wait(options.delayMs ?? FORK_READY_DELAY_MS)
  }
  throw new GitHubError(`GitHub is still making ${session.me}'s fork of ${repo}; try again in a minute`, 503)
}
