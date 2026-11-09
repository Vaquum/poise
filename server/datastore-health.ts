import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { db, getMeta, setMeta } from './db'
import { diagnostic } from './logging'
import { conditionCorrelation } from './logging-context'
import { organizationArgs, type Organization } from './organizations'
import { runFile, type RunFileOptions, type RunFileResult } from './process'
import { behaviorErrorMessage } from './behavior-diagnostics'

export const DATASTORE_MAX_AGE_SECONDS = 120
const EPISODE_PREFIX = 'datastore_stale:'

export interface DatastoreFreshness {
  status: 'unchecked' | 'healthy' | 'unavailable'
  checkedAt: string
  ageSeconds: number | null
  lastSuccessAt: string | null
  error: string | null
}

export const initialDatastoreFreshness: DatastoreFreshness = {
  status: 'unchecked', checkedAt: new Date(0).toISOString(), ageSeconds: null, lastSuccessAt: null, error: null,
}
export const datastoreFreshnessByOrganization = new Map<string, DatastoreFreshness>()

interface FreshnessEvidence {
  checkedAt: string
  ageSeconds: number
  lastSuccessAt: string
  maxAgeSeconds: number
}

interface StaleMirrorEpisode {
  id: string
  account: string
  database: string
  startedAt: string
  first: FreshnessEvidence
  latest: FreshnessEvidence
  behaviors: string[]
  recoveredAt: string | null
}

interface Health {
  database: string
  status: 'healthy' | 'stale'
  evidence: FreshnessEvidence
}

// Only the documented, account-bound freshness result establishes staleness
// or recovery. In particular, an arbitrary exit 1 is still a process fault.
function validatedHealth(stdout: string, org: Organization | null): Health | null {
  let data: Record<string, unknown>
  try { data = JSON.parse(stdout) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || data.action !== 'health' || typeof data.database !== 'string' || !isAbsolute(data.database)
    || (org?.datastorePath && data.database !== resolve(org.datastorePath))
    || data.max_age_seconds !== DATASTORE_MAX_AGE_SECONDS
    || !Number.isSafeInteger(data.age_seconds) || Number(data.age_seconds) < 0
    || typeof data.last_success_at !== 'string' || !Number.isFinite(Date.parse(data.last_success_at))) return null
  const stale = data.status === 'stale' && data.healthy === false && Number(data.age_seconds) > DATASTORE_MAX_AGE_SECONDS
  const healthy = data.status === 'healthy' && data.healthy === true && Number(data.age_seconds) <= DATASTORE_MAX_AGE_SECONDS
  if (!stale && !healthy) return null
  return { database: data.database, status: stale ? 'stale' : 'healthy', evidence: {
    checkedAt: new Date().toISOString(), ageSeconds: Number(data.age_seconds),
    lastSuccessAt: data.last_success_at, maxAgeSeconds: DATASTORE_MAX_AGE_SECONDS,
  } }
}

function episodeKey(account: string, database: string): string {
  return EPISODE_PREFIX + conditionCorrelation(account, database)
}

function readEpisode(key: string): StaleMirrorEpisode | null {
  const raw = getMeta(key)
  return raw ? JSON.parse(raw) as StaleMirrorEpisode : null
}

export function staleMirrorMessage(episode: StaleMirrorEpisode): string {
  return `Datastore stale: last successful sync ${episode.latest.lastSuccessAt}; age ${episode.latest.ageSeconds}s exceeds ${episode.latest.maxAgeSeconds}s`
}

function reportEpisode(episode: StaleMirrorEpisode, phase: 'opened' | 'recovered'): void {
  diagnostic({ id: `${episode.id}:${phase}`, level: 'warning', operation: 'github-datastore.stale', phase,
    condition: episode.id, correlationId: episode.id, behavior: null, repository: null,
    account: episode.account, target: episode.database,
    time: phase === 'opened' ? episode.startedAt : episode.recoveredAt,
    message: phase === 'opened' ? staleMirrorMessage(episode) : 'Datastore freshness recovered',
    context: { startedAt: episode.startedAt, first: episode.first, latest: episode.latest,
      blockedBehaviors: episode.behaviors, recoveredAt: episode.recoveredAt } })
}

function observeHealth(org: Organization | null, health: Health, blockedBy: readonly string[]): StaleMirrorEpisode | null {
  const account = org?.login.toLowerCase() ?? 'legacy'
  const key = episodeKey(account, health.database)
  const transition = db.transaction(() => {
    const previous = readEpisode(key)
    if (health.status === 'healthy') {
      if (!previous || previous.recoveredAt) return null
      const episode = { ...previous, latest: health.evidence, recoveredAt: health.evidence.checkedAt }
      setMeta(key, JSON.stringify(episode))
      return { episode, phase: 'recovered' as const }
    }
    const opened = !previous || previous.recoveredAt !== null
    const episode: StaleMirrorEpisode = opened ? {
      id: randomUUID(), account, database: health.database, startedAt: health.evidence.checkedAt,
      first: health.evidence, latest: health.evidence, behaviors: [...blockedBy], recoveredAt: null,
    } : { ...previous, latest: health.evidence, behaviors: [...new Set([...previous.behaviors, ...blockedBy])] }
    setMeta(key, JSON.stringify(episode))
    return { episode, phase: opened ? 'opened' as const : null }
  }).immediate()
  datastoreFreshnessByOrganization.set(`${account}:review-new-prs`, {
    status: health.status === 'healthy' ? 'healthy' : 'unavailable', checkedAt: health.evidence.checkedAt,
    ageSeconds: health.evidence.ageSeconds, lastSuccessAt: health.evidence.lastSuccessAt,
    error: health.status === 'stale' ? staleMirrorMessage(transition!.episode) : null,
  })
  if (transition?.phase) reportEpisode(transition.episode, transition.phase)
  return health.status === 'stale' ? transition!.episode : null
}

export class StaleDatastoreError extends Error {
  readonly code = 1
  constructor(readonly episode: StaleMirrorEpisode, readonly stdout: string, readonly stderr: string, cause?: unknown) {
    super(staleMirrorMessage(episode), { cause })
  }
}

export function staleDatastoreFailure(error: unknown): StaleDatastoreError | null {
  const seen = new Set<unknown>()
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof StaleDatastoreError) return error
    seen.add(error)
    error = error.cause
  }
  return null
}

export function recordStaleMirrorBlock(error: StaleDatastoreError, behavior: string): void {
  const key = episodeKey(error.episode.account, error.episode.database)
  db.transaction(() => {
    const episode = readEpisode(key)
    if (!episode || episode.id !== error.episode.id) throw new Error('Stale mirror episode changed before recording its refusal')
    if (!episode.behaviors.includes(behavior)) setMeta(key, JSON.stringify({ ...episode, behaviors: [...episode.behaviors, behavior] }))
  }).immediate()
}

export function openStaleMirrors(org: Organization | null): StaleMirrorEpisode[] {
  const rows = db.prepare('SELECT value FROM meta WHERE substr(key, 1, ?) = ?').all(EPISODE_PREFIX.length, EPISODE_PREFIX) as Array<{ value: string }>
  return rows.map(({ value }) => JSON.parse(value) as StaleMirrorEpisode).filter((episode) => !episode.recoveredAt
    && episode.account === (org?.login.toLowerCase() ?? 'legacy')
    && (!org?.datastorePath || episode.database === resolve(org.datastorePath)))
}

/** Reporting only: native probes retain their exit-based admission rules. */
export async function runDatastoreHealth(org: Organization | null, options: RunFileOptions = {}, blockedBy: readonly string[] = []): Promise<RunFileResult & { stale: StaleDatastoreError | null }> {
  const args = ['health', '--max-age-seconds', String(DATASTORE_MAX_AGE_SECONDS)]
  let result: RunFileResult
  try {
    result = await runFile('github-datastore', org ? organizationArgs(org, args) : args, {
      ...options, expected: { codes: [1], stderr: /^\s*$/, stdout: (stdout) => validatedHealth(stdout, org)?.status === 'stale' },
    })
  } catch (error) {
    const failure = error as { code?: unknown, killed?: unknown, signal?: unknown, stdout?: unknown, stderr?: unknown }
    const health = failure.code === 1 && !failure.killed && !failure.signal && typeof failure.stdout === 'string'
      ? validatedHealth(failure.stdout, org) : null
    if (health?.status !== 'stale') {
      datastoreFreshnessByOrganization.set(`${org?.login.toLowerCase() ?? 'legacy'}:review-new-prs`, {
        status: 'unavailable', checkedAt: new Date().toISOString(), ageSeconds: null, lastSuccessAt: null, error: behaviorErrorMessage(error),
      })
      throw error
    }
    const episode = observeHealth(org, health, blockedBy)!
    throw new StaleDatastoreError(episode, String(failure.stdout), typeof failure.stderr === 'string' ? failure.stderr : '', error)
  }
  const health = validatedHealth(result.stdout, org)
  if (!health) {
    const message = 'github-datastore health returned malformed or mismatched freshness evidence'
    datastoreFreshnessByOrganization.set(`${org?.login.toLowerCase() ?? 'legacy'}:review-new-prs`, {
      status: 'unavailable', checkedAt: new Date().toISOString(), ageSeconds: null, lastSuccessAt: null, error: message,
    })
    diagnostic({ level: 'error', operation: 'github-datastore.health', exitCode: 0,
      account: org?.login ?? null, target: org?.datastorePath ?? null, message })
  }
  const episode = health ? observeHealth(org, health, []) : null
  return { ...result, stale: episode ? new StaleDatastoreError(episode, result.stdout, result.stderr) : null }
}
