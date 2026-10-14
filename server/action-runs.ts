import { getMeta } from './db'
import { listOrganizationsRepos, selectOrganizations, type OrganizationReadError } from './gh'
import { HttpError } from './http'
import { runFile } from './process'

export interface ActionRun {
  kind: 'action'
  repo: string
  number: number
  title: string
  url: string
  author: string
  state: string
  updated_at: string
  branch: string
  event: string
}

interface Snapshot {
  records: ActionRun[]
  errors: OrganizationReadError[]
  warnings: string[]
  expires?: number
}
interface RepositoryRead extends Snapshot { etag?: string }
interface Cached<T> { expires: number, read: Promise<T> }
interface RepositoryCache extends Cached<RepositoryRead> { last?: RepositoryRead }

const TTL_MS = 5 * 60_000
const ERROR_TTL_MS = 60_000
const cache = new Map<string, Cached<Snapshot>>()
const repositoryCache = new Map<string, RepositoryCache>()
export function invalidateActionRunCache(): void { cache.clear(); repositoryCache.clear() }
const credentialEnv = {
  GH_HOST: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
  GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined,
}

function toActionRun(value: unknown, repo: string): ActionRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed workflow run')
  const run = value as Record<string, unknown>
  if (!Number.isSafeInteger(run.id) || Number(run.id) < 1 || typeof run.html_url !== 'string'
    || typeof run.status !== 'string' || typeof run.updated_at !== 'string' || typeof run.name !== 'string') {
    throw new Error(`malformed workflow run ${Number.isSafeInteger(run.id) ? run.id : '(unknown ID)'}`)
  }
  const actor = run.actor as { login?: string } | null
  return {
    kind: 'action', repo, number: run.id as number,
    title: `${run.name}${typeof run.display_title === 'string' && run.display_title !== run.name ? ` · ${run.display_title}` : ''}`,
    url: run.html_url, author: typeof actor?.login === 'string' ? actor.login : '',
    state: typeof run.conclusion === 'string' ? run.conclusion : run.status,
    updated_at: run.updated_at, branch: typeof run.head_branch === 'string' ? run.head_branch : '',
    event: typeof run.event === 'string' ? run.event : '',
  }
}

async function readRepository(repo: string, token: string, failed: boolean, previous?: RepositoryRead): Promise<RepositoryRead> {
  const args = ['api', `repos/${repo}/actions/runs?per_page=100${failed ? '&status=failure' : ''}`, '--method', 'GET', '--include']
  if (previous?.etag) args.push('--header', `If-None-Match: ${previous.etag}`)
  let stdout: string
  try {
    stdout = (await runFile('gh', args, {
      env: { ...credentialEnv, GH_HOST: 'github.com', GH_TOKEN: token }, timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024,
    })).stdout
  } catch (error) {
    // gh exits 1 on HTTP 304. Accept only that complete conditional response;
    // network failures, timeouts and every other HTTP error still propagate.
    if (!(error instanceof Error) || !('code' in error) || error.code !== 1
      || !('stdout' in error) || typeof error.stdout !== 'string'
      || !previous?.etag || !/^HTTP\/\S+ 304\b/.test(error.stdout)) throw error
    stdout = error.stdout
  }
  const separator = /\r?\n\r?\n/.exec(stdout)
  if (!separator) throw new Error('GitHub returned no HTTP response headers')
  const headers = stdout.slice(0, separator.index)
  const status = /^HTTP\/\S+ (\d{3})\b/.exec(headers)?.[1]
  if (status === '304') {
    if (!previous?.etag) throw new Error('GitHub returned 304 without a cached workflow inventory')
    return previous
  }
  if (status !== '200') throw new Error(`GitHub workflow read returned HTTP ${status || 'unknown'}`)
  const data = JSON.parse(stdout.slice(separator.index + separator[0].length))
  if (!Array.isArray(data.workflow_runs) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) {
    throw new Error('GitHub returned malformed workflow inventory')
  }
  const records: ActionRun[] = []
  const errors: OrganizationReadError[] = []
  for (const value of data.workflow_runs) {
    try {
      const run = toActionRun(value, repo)
      // A rerun can change conclusion while GitHub builds the response.
      if (!failed || run.state === 'failure') records.push(run)
    } catch (error) {
      errors.push({ org: repo.split('/')[0], error: `${repo}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  const warnings = data.total_count > data.workflow_runs.length
    ? [`${repo}: showing the latest ${data.workflow_runs.length} of ${data.total_count} ${failed ? 'failed ' : ''}runs. Open GitHub for older runs.`] : []
  return { records, errors, warnings, etag: /^etag:\s*(.+)$/im.exec(headers)?.[1].trim() }
}

async function readSnapshot(me: string, org: string, failed: boolean): Promise<Snapshot> {
  const discovery = await listOrganizationsRepos(org)
  if (!discovery.repos.length) return { records: [], errors: discovery.errors, warnings: [] }
  const token = (await runFile('gh', ['auth', 'token', '--hostname', 'github.com', '--user', me], {
    env: credentialEnv, timeoutMs: 15_000,
  })).stdout.trim()
  if (!token) throw new Error(`No GitHub credential for ${me}`)
  const records: ActionRun[] = []
  const errors = [...discovery.errors]
  const warnings: string[] = []
  let successfulReads = 0
  let expires = Infinity
  // No history crawl, job reads or run polling. Healthy repositories stay cached
  // while unavailable ones recover, and unchanged reads use authenticated ETags.
  for (let i = 0; i < discovery.repos.length; i += 4) {
    await Promise.all(discovery.repos.slice(i, i + 4).map(async (repo) => {
      try {
        const key = `${me.toLowerCase()}:${repo.toLowerCase()}:${failed}`
        let entry = repositoryCache.get(key)
        if (!entry || entry.expires <= Date.now()) {
          const previous = entry?.last
          const read = readRepository(repo, token, failed, previous).then((result) => {
            next.last = result
            next.expires = Date.now() + (result.errors.length ? ERROR_TTL_MS : TTL_MS)
            return result
          }, (error: unknown) => {
            next.last = previous
            next.expires = Date.now() + ERROR_TTL_MS
            throw error
          })
          const next: RepositoryCache = { expires: Infinity, read }
          repositoryCache.set(key, next)
          entry = next
        }
        const result = await entry.read
        expires = Math.min(expires, entry.expires)
        records.push(...result.records)
        errors.push(...result.errors)
        warnings.push(...result.warnings)
        successfulReads++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push({ org: repo.split('/')[0], error: `${repo}: ${message.split(token).join('***')}` })
      }
    }))
  }
  if (errors.length && successfulReads === 0) throw new HttpError(502, errors.map((entry) => entry.error).join('; '))
  return { records, errors, warnings, expires }
}

export async function listActionRuns(body: Record<string, unknown>): Promise<{ status: number, body: unknown }> {
  const orgs = selectOrganizations(body.org)
  if (!orgs.length) return { status: 200, body: body.count_only ? { count: 0, errors: [], warnings: [] } : { records: [], errors: [], warnings: [] } }
  const me = getMeta('me') || ''
  if (!me) throw new HttpError(400, 'Set your GitHub account in Settings → GitHub to read Actions')
  const failed = body.record_state !== 'all'
  const results = await Promise.allSettled(orgs.map((org) => {
    const key = `${me.toLowerCase()}:${org.login.toLowerCase()}:${failed}`
    const existing = cache.get(key)
    if (existing && existing.expires > Date.now()) return existing.read
    // Pending reads never expire. Pages/counts share a snapshot, and a transient
    // failure gets a one-minute backoff instead of poisoning the five-minute cache.
    const read = readSnapshot(me, org.login, failed).then((result) => {
      entry.expires = Math.min(Date.now() + (result.errors.length ? ERROR_TTL_MS : TTL_MS), result.expires ?? Infinity)
      return result
    }, (error: unknown) => {
      entry.expires = Date.now() + ERROR_TTL_MS
      throw error
    })
    const entry: Cached<Snapshot> = { expires: Infinity, read }
    cache.set(key, entry)
    return entry.read
  }))
  const errors: OrganizationReadError[] = []
  const warnings: string[] = []
  let records: ActionRun[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      records.push(...result.value.records)
      errors.push(...result.value.errors)
      warnings.push(...result.value.warnings)
    } else errors.push({ org: orgs[i].login, error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
  })
  if (results.every((result) => result.status === 'rejected')) throw new HttpError(502, errors.map((entry) => `${entry.org}: ${entry.error}`).join('; '))
  const q = typeof body.q === 'string' ? body.q.toLowerCase() : ''
  records = records.filter((run) => (!body.updated_since || run.updated_at >= String(body.updated_since))
    && (!body.updated_until || run.updated_at < String(body.updated_until))
    && (!q || [run.repo, run.title, run.author, run.branch, run.event, String(run.number)].some((value) => value.toLowerCase().includes(q))))
  records.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.number - a.number)
  if (body.count_only) return { status: 200, body: { count: records.length, errors, warnings } }
  const offset = Math.max(0, Number(body.offset) || 0)
  const limit = Math.max(1, Number(body.limit) || 20)
  return { status: 200, body: { records: records.slice(offset, offset + limit), errors, warnings } }
}
