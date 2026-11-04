import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { BehaviorCutoverState } from '../src/behavior-cutover'
import { budgetShortfall, validateExecutionLimits, type BehaviorExecutionLimits, type BehaviorResourceBudget, type BehaviorResourceReservation } from './behavior-resources'
import { nativeResourcesPending, resourceReleaseProven } from './behavior-resource-receipt'

const CUTOVER_ID = '@behavior-admission'
interface CutoverEvent { type: 'admission.changed', state: BehaviorCutoverState }

export type ChainBehavior = 'review-issue' | 'implement-issue' | 'publish-issue' | 'review-pr' | 'repair-pr' | 'approve-pr' | 'resolve-threads' | 'merge-pr' | 'rerun-grey-ci'
export interface ChainInvocation {
  id: string
  behavior: ChainBehavior
  basis: string
  actor: string
  model: string | null
  slot: string | null
  /** Memory/disk allowance held while this invocation is live, including its
   *  descendants. Null for quick native actions and admissions that predate
   *  resource budgets; those never count as free against a bounded budget. */
  reservation?: BehaviorResourceReservation | null
  admittedAt: number
  admissionSequence: number
  request: { command: 'agent-interface' | 'github-interface', argv: string[], cwd: string, nativeResources?: 2, resourceLimits?: BehaviorExecutionLimits,
    context?: { head: string, reviewRevision: string, queueRemoval?: string } }
  state: 'admitted' | 'started' | 'uncertain' | 'settled'
  callId: string | null
  outcome: string | null
  evidence: Record<string, unknown> | null
}
export interface BehaviorChain {
  id: string
  repository: string
  issue: number
  branch: string
  author: string
  reviewer: string
  sequence: number
  held: string | null
  waiting: string | null
  resumedAfterSequence: number
  mergeSha: string | null
  reviewPending?: boolean
  observation: Record<string, unknown> | null
  invocations: ChainInvocation[]
}
/** Admission payload: the reservation is optional so admissions that predate
 *  resource budgets and quick native actions without an agent stay valid. */
export type ChainAdmission = Omit<ChainInvocation, 'state' | 'callId' | 'outcome' | 'evidence' | 'admissionSequence' | 'reservation'> & { reservation?: BehaviorResourceReservation | null }
export type ChainEvent =
  | { type: 'chain.admitted', repository: string, issue: number, branch: string, author: string, reviewer: string }
  | { type: 'chain.observed', observation: Record<string, unknown> }
  | { type: 'chain.held', reason: string }
  | { type: 'chain.waiting', reason: string }
  | { type: 'chain.resumed' }
  | { type: 'chain.merged', mergeSha: string, evidence: Record<string, unknown> }
  | { type: 'invocation.admitted', invocation: ChainAdmission }
  | { type: 'invocation.started', invocationId: string }
  | { type: 'invocation.reconciled', invocationId: string, evidence: Record<string, unknown> }
  | { type: 'invocation.resources_reconciled', invocationId: string, evidence: Record<string, unknown> }
  | { type: 'invocation.uncertain', invocationId: string, reason: string }
  | { type: 'invocation.settled', invocationId: string, callId: string | null, outcome: string, evidence: Record<string, unknown> }

interface StoredEvent { sequence: number, chain_id: string, event_id: string, at: number, payload: string }
const SHA = /^[0-9a-f]{40}$/i
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/
const MAX_EVENT_BYTES = 256 * 1024

function recordObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resourceArtifact(prior: unknown, value: unknown): Record<string, unknown> {
  if (!recordObject(value)) throw new Error('resource reconciliation cannot erase a logical artifact')
  const original = recordObject(prior) ? prior : {}
  for (const [key, entry] of Object.entries(value)) {
    if (!['resource_error', 'resource_recovered_at'].includes(key) && chainBasis(entry) !== chainBasis(original[key] ?? null)) {
      throw new Error('resource reconciliation cannot change a logical artifact')
    }
  }
  return { ...original, ...value }
}
// Resource occupancy is derived from every original invocation, including
// contradictory historical releases. Index the projection so settled history
// cannot turn each capacity/observation read into a full journal scan.
const LIVE_MODEL_SQL = 'resource_pending = 1'
const ACTIVE_WORK_SQL = `CASE WHEN (json_extract(state, '$.mergeSha') IS NULL AND json_extract(state, '$.held') IS NULL)
  OR (${LIVE_MODEL_SQL}) THEN 1 ELSE 0 END`
const RECHECK_AT_SQL = `CASE
  WHEN json_extract(state, '$.mergeSha') IS NOT NULL AND json_extract(state, '$.reviewPending') IS NOT 1 THEN NULL
  WHEN (${ACTIVE_WORK_SQL}) = 1 THEN 0
  WHEN json_extract(state, '$.mergeSha') IS NOT NULL AND json_extract(state, '$.invocations[#-1].state') != 'settled'
    AND json_extract(state, '$.invocations[#-1].request.command') = 'github-interface'
    AND json_extract(state, '$.invocations[#-1].behavior') IN ('merge-pr', 'resolve-threads') THEN
      CASE WHEN json_type(state, '$.invocations[#-1].evidence.nativeActionReceipt') IS NULL THEN NULL ELSE 0 END
  WHEN json_extract(state, '$.observation.checkedAt') IS NULL THEN 0
  ELSE json_extract(state, '$.observation.checkedAt') + min(86400000, max(120000,
    json_extract(state, '$.observation.checkedAt') - coalesce(json_extract(state, '$.observation.pull.mergedAt'),
      json_extract(state, '$.invocations[0].admittedAt'), 0))) END`

export function chainIdentity(repository: string, issue: number): string {
  if (!REPOSITORY.test(repository) || !Number.isSafeInteger(issue) || issue < 1) throw new Error('invalid behavior chain target')
  return `${repository.toLowerCase()}#${issue}`
}

/** Every write advances this reducer. The current table is a disposable index,
 * never an independent source of admission, counters or ownership. */
export function reduceChain(current: BehaviorChain | null, event: ChainEvent, sequence: number, id: string): BehaviorChain {
  if (event.type === 'chain.admitted') {
    if (current || chainIdentity(event.repository, event.issue) !== id || !event.branch.startsWith('poise/')
      || !event.author || !event.reviewer || event.author.toLowerCase() === event.reviewer.toLowerCase()) throw new Error('invalid or duplicate behavior chain admission')
    return { id, repository: event.repository, issue: event.issue, branch: event.branch, author: event.author, reviewer: event.reviewer,
      sequence, held: null, waiting: null, resumedAfterSequence: 0, mergeSha: null, observation: null, invocations: [] }
  }
  if (!current) throw new Error('behavior chain has not been admitted')
  const next: BehaviorChain = { ...current, sequence, invocations: current.invocations.map((invocation) => ({ ...invocation })) }
  if (event.type === 'chain.observed') next.observation = event.observation
  else if (event.type === 'chain.waiting') next.waiting = event.reason
  else if (event.type === 'chain.held') {
    if (!event.reason.trim()) throw new Error('a behavior chain hold needs a reason')
    next.held = event.reason
  } else if (event.type === 'chain.resumed') { next.held = null; next.resumedAfterSequence = sequence }
  else if (event.type === 'chain.merged') {
    if (!SHA.test(event.mergeSha) || event.evidence.merged !== true || event.evidence.merge_sha !== event.mergeSha
      || event.evidence.repository !== next.repository || !Number.isSafeInteger(event.evidence.pull_number)
      || Number(event.evidence.pull_number) < 1) throw new Error('chain completion requires a verified GitHub merge artifact')
    if (event.evidence.review_complete !== false && next.invocations.some((invocation) => invocation.state !== 'settled')) throw new Error('cannot complete a chain with an unsettled invocation')
    if (next.mergeSha && next.mergeSha !== event.mergeSha) throw new Error('behavior chain merge evidence conflicts')
    next.mergeSha = event.mergeSha.toLowerCase()
    if (typeof event.evidence.review_complete === 'boolean') next.reviewPending = !event.evidence.review_complete
  } else if (event.type === 'invocation.admitted') {
    if (next.held || next.mergeSha) throw new Error('behavior chain does not admit invocations')
    const invocation = event.invocation
    if (!invocation.id || !invocation.basis || !invocation.actor || !Number.isSafeInteger(invocation.admittedAt)
      || invocation.admittedAt < 0 || next.invocations.some((prior) => prior.id === invocation.id)
      || next.invocations.some((prior) => prior.state !== 'settled')) throw new Error('behavior chain already owns an invocation or admission is invalid')
    const reservation = invocation.reservation ?? null
    if (reservation !== null && (!Number.isSafeInteger(reservation.memoryBytes) || reservation.memoryBytes < 0
      || !Number.isSafeInteger(reservation.diskBytes) || reservation.diskBytes < 0)) throw new Error('behavior invocation carries an invalid resource reservation')
    if (invocation.request.resourceLimits) {
      validateExecutionLimits(invocation.request.resourceLimits, reservation)
      if (invocation.request.command === 'agent-interface') {
        const argv = invocation.request.argv, index = argv.indexOf('--resource-limits-json')
        if (argv.filter(arg => arg === '--resource-limits-json').length !== 1
          || chainBasis(JSON.parse(argv[index + 1])) !== chainBasis(invocation.request.resourceLimits)) {
          throw new Error('native execution arguments differ from their original resource limits')
        }
      }
    } else if (invocation.request.command === 'agent-interface' && invocation.request.argv.includes('--resource-limits-json')) {
      throw new Error('native execution limits lack their original resource reservation')
    }
    next.invocations.push({ ...invocation, reservation, admissionSequence: sequence, state: 'admitted', callId: null, outcome: null, evidence: null })
    next.waiting = null
  } else {
    const invocation = next.invocations.find((candidate) => candidate.id === event.invocationId)
    if (!invocation) throw new Error('behavior invocation was not admitted')
    if (event.type === 'invocation.started') {
      if (invocation.state !== 'admitted') throw new Error('behavior invocation has already started')
      invocation.state = 'started'
    } else if (event.type === 'invocation.resources_reconciled') {
      if (!Object.keys(event.evidence).length || Object.keys(event.evidence).some(key => !['resource_ownership', 'resources_settled_at', 'artifact', 'publicationReceipt'].includes(key))) {
        throw new Error('resource reconciliation cannot change a behavior outcome')
      }
      const evidence = { ...event.evidence }
      if ('artifact' in evidence) evidence.artifact = resourceArtifact(invocation.evidence?.artifact, evidence.artifact)
      if ('publicationReceipt' in evidence) {
        const value = evidence.publicationReceipt
        if (!recordObject(value)) throw new Error('resource reconciliation cannot erase a publication receipt')
        const before = invocation.evidence?.publicationReceipt
        const original = recordObject(before) ? before : {}
        for (const [key, entry] of Object.entries(value)) {
          if (!['resource_ownership', 'resources_settled_at', 'artifact'].includes(key) && chainBasis(entry) !== chainBasis(original[key] ?? null)) {
            throw new Error('resource reconciliation cannot change a publication outcome')
          }
        }
        evidence.publicationReceipt = { ...original, ...value,
          ...('artifact' in value ? { artifact: resourceArtifact(original.artifact, value.artifact) } : {}) }
      }
      if (!resourceReleaseProven({ ...invocation.evidence, ...evidence }, true)) throw new Error('resource reconciliation requires positive original release proof')
      invocation.evidence = { ...invocation.evidence, ...evidence }
    } else if (event.type === 'invocation.reconciled') {
      if (invocation.state === 'settled' || !Object.keys(event.evidence).length) throw new Error('invalid invocation reconciliation')
      invocation.evidence = { ...invocation.evidence, ...event.evidence }
    } else if (event.type === 'invocation.uncertain') {
      if (invocation.state === 'settled' || !event.reason.trim()) throw new Error('invalid uncertain behavior invocation')
      invocation.state = 'uncertain'
      invocation.outcome = event.reason
    } else {
      if (invocation.state === 'settled' || !event.outcome.trim() || !Object.keys(event.evidence).length) throw new Error('behavior invocation settlement needs new native evidence')
      invocation.state = 'settled'
      invocation.callId = event.callId
      invocation.outcome = event.outcome
      invocation.evidence = event.evidence
    }
  }
  return next
}

/** Append-first authority for managed behavior chains. Storage failure refuses
 * the effect. Unlike the observational ledger, events are never dropped/pruned. */
export class BehaviorChainJournal {
  constructor(private readonly db: Database) {
    db.function('behavior_native_resources_pending', { deterministic: true }, encoded => {
      if (typeof encoded !== 'string') throw new Error('native capacity lacks its invocation receipt')
      const value: unknown = JSON.parse(encoded)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid native capacity invocation')
      return nativeResourcesPending(value as Record<string, unknown>) ? 1 : 0
    })
    db.exec(`CREATE TABLE IF NOT EXISTS behavior_chain_current (
      chain_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, state TEXT NOT NULL, merged INTEGER NOT NULL,
      resource_pending INTEGER NOT NULL DEFAULT 1)`)
    const columns = db.pragma('table_info(behavior_chain_current)') as { name: string }[]
    if (!columns.some(column => column.name === 'resource_pending')) {
      db.transaction(() => {
        db.exec('ALTER TABLE behavior_chain_current ADD COLUMN resource_pending INTEGER NOT NULL DEFAULT 1')
        db.exec(`UPDATE behavior_chain_current SET resource_pending = CASE WHEN EXISTS (
          SELECT 1 FROM json_each(state, '$.invocations') i WHERE behavior_native_resources_pending(i.value) = 1
        ) THEN 1 ELSE 0 END`)
      }).immediate()
    }
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'behavior_chain_reconciliation'")
      .get() as { sql: string } | undefined
    if (index && !index.sql.includes('resource_pending')) db.exec('DROP INDEX behavior_chain_reconciliation')
    db.exec(`
      CREATE TABLE IF NOT EXISTS behavior_chain_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, chain_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, payload TEXT NOT NULL, state_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS behavior_chain_history ON behavior_chain_events(chain_id, sequence);
      CREATE INDEX IF NOT EXISTS behavior_chain_event_kind ON behavior_chain_events(chain_id, json_extract(payload, '$.type'), sequence);
      CREATE TRIGGER IF NOT EXISTS behavior_chain_no_update BEFORE UPDATE ON behavior_chain_events
        BEGIN SELECT RAISE(ABORT, 'behavior chain events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS behavior_chain_no_delete BEFORE DELETE ON behavior_chain_events
        BEGIN SELECT RAISE(ABORT, 'behavior chain events are immutable'); END;
      CREATE TABLE IF NOT EXISTS behavior_chain_current (
        chain_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, state TEXT NOT NULL, merged INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS behavior_chain_active ON behavior_chain_current(merged, chain_id);
      CREATE INDEX IF NOT EXISTS behavior_chain_resource_pending ON behavior_chain_current(resource_pending, chain_id);
      CREATE INDEX IF NOT EXISTS behavior_chain_pull ON behavior_chain_current(
        lower(json_extract(state, '$.repository')), json_extract(state, '$.observation.publication.pull_number'));
      CREATE INDEX IF NOT EXISTS behavior_chain_branch ON behavior_chain_current(
        lower(json_extract(state, '$.repository')), merged, json_extract(state, '$.branch'));
      CREATE INDEX IF NOT EXISTS behavior_chain_reconciliation ON behavior_chain_current(
        merged, (${ACTIVE_WORK_SQL}), (${RECHECK_AT_SQL}), chain_id);
    `)
  }

  private durable(): void {
    // Set before admission's transaction, never during an ownership read
    // nested inside an existing Chat transaction.
    if (this.db.pragma('synchronous', { simple: true }) !== 2) {
      if (this.db.inTransaction) throw new Error('behavior journal requires FULL durability before a transaction starts')
      this.db.pragma('synchronous = FULL')
    }
  }

  cutover(): BehaviorCutoverState {
    const row = this.db.prepare('SELECT sequence, payload, state_hash FROM behavior_chain_events WHERE chain_id = ? ORDER BY sequence DESC LIMIT 1')
      .get(CUTOVER_ID) as { sequence: number, payload: string, state_hash: string } | undefined
    if (!row) return { sequence: 0, mode: 'v1', requestedAt: null, legacyPulls: [] }
    const event = JSON.parse(row.payload) as CutoverEvent
    if (event.type !== 'admission.changed' || event.state.sequence !== row.sequence || chainBasis(event.state) !== row.state_hash) throw new Error('behavior cutover journal is corrupt')
    return event.state
  }

  changeAdmission(expectedSequence: number, mode: BehaviorCutoverState['mode'], legacyPulls: string[] = [], at = Date.now(), commit?: () => void): BehaviorCutoverState {
    this.durable()
    return this.db.transaction(() => {
      const current = this.cutover()
      if (current.sequence !== expectedSequence) throw new Error('behavior cutover changed; reload its current state')
      if (!((current.mode === 'v1' && mode === 'draining') || (current.mode === 'draining' && (mode === 'v1' || mode === 'v2')))) throw new Error('invalid behavior cutover transition')
      if (!Number.isSafeInteger(at) || at < 0 || legacyPulls.some((target) => !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(target))) throw new Error('invalid behavior cutover evidence')
      const sequence = (this.db.prepare('SELECT coalesce(max(sequence), 0) + 1 AS next FROM behavior_chain_events').get() as { next: number }).next
      const state: BehaviorCutoverState = { sequence, mode, requestedAt: mode === 'v1' ? null : current.requestedAt ?? at,
        legacyPulls: mode === 'v2' ? [...new Set(legacyPulls.map((target) => target.toLowerCase()))].sort() : [] }
      const payload = JSON.stringify({ type: 'admission.changed', state } satisfies CutoverEvent)
      if (Buffer.byteLength(payload) > MAX_EVENT_BYTES) throw new Error('legacy ownership boundary exceeds the journal event limit; cutover remains draining')
      this.db.prepare('INSERT INTO behavior_chain_events(sequence, chain_id, event_id, at, payload, state_hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sequence, CUTOVER_ID, `admission:${sequence}`, at, payload, chainBasis(state))
      commit?.()
      return state
    }).immediate()
  }

  read(id: string): BehaviorChain | null {
    const row = this.db.prepare(`SELECT c.state, c.sequence, e.state_hash,
      (SELECT max(sequence) FROM behavior_chain_events WHERE chain_id = c.chain_id) AS latest
      FROM behavior_chain_current c JOIN behavior_chain_events e ON e.sequence = c.sequence WHERE c.chain_id = ?`).get(id) as
      { state: string, sequence: number, state_hash: string, latest: number } | undefined
    if (!row) {
      if (this.db.prepare('SELECT 1 FROM behavior_chain_events WHERE chain_id = ? LIMIT 1').get(id)) throw new Error('behavior projection is missing; rebuild it before continuing')
      return null
    }
    if (row.sequence !== row.latest || chainBasis(JSON.parse(row.state)) !== row.state_hash) throw new Error('behavior projection disagrees with the authoritative event journal')
    return JSON.parse(row.state) as BehaviorChain
  }

  append(id: string, eventId: string, expectedSequence: number, event: ChainEvent, at = Date.now()): BehaviorChain {
    this.durable()
    const payload = JSON.stringify(event)
    if (!id || !eventId || id.length > 256 || eventId.length > 512 || !Number.isSafeInteger(at) || at < 0
      || Buffer.byteLength(payload) > MAX_EVENT_BYTES) throw new Error('invalid or oversized behavior chain event')
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT chain_id, payload FROM behavior_chain_events WHERE event_id = ?').get(eventId) as { chain_id: string, payload: string } | undefined
      if (prior) {
        if (prior.chain_id !== id || prior.payload !== payload) throw new Error('behavior event identity conflicts with its durable record')
        const existing = this.read(id)
        if (!existing) throw new Error('behavior projection is missing; rebuild it before continuing')
        return existing
      }
      const current = this.read(id)
      if (event.type === 'chain.admitted' && this.cutover().mode === 'draining') throw new Error('behavior admissions are draining')
      if ((current?.sequence ?? 0) !== expectedSequence) throw new Error('behavior chain changed before event admission')
      if (event.type === 'chain.admitted' && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_work_bindings'").get()
        && this.db.prepare('SELECT 1 FROM chat_work_bindings WHERE lower(target) = lower(?) LIMIT 1')
          .get(`https://github.com/${event.repository}/issues/${event.issue}`)) throw new Error('seed issue is already owned by an existing chat; active work cannot be migrated')
      const sequence = (this.db.prepare('SELECT coalesce(max(sequence), 0) + 1 AS next FROM behavior_chain_events').get() as { next: number }).next
      const next = reduceChain(current, event, sequence, id)
      this.db.prepare('INSERT INTO behavior_chain_events(sequence, chain_id, event_id, at, payload, state_hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sequence, id, eventId, at, payload, chainBasis(next))
      this.db.prepare(`INSERT INTO behavior_chain_current(chain_id, sequence, state, merged, resource_pending) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chain_id) DO UPDATE SET sequence=excluded.sequence, state=excluded.state, merged=excluded.merged,
          resource_pending=excluded.resource_pending`)
        .run(id, next.sequence, JSON.stringify(next), next.mergeSha && !next.reviewPending ? 1 : 0,
          next.invocations.some(invocation => nativeResourcesPending({ ...invocation })) ? 1 : 0)
      return next
    }).immediate()
  }

  active(after = '', limit = 100): BehaviorChain[] {
    return this.page(after, limit, false)
  }

  /** Ownership pages stay unchanged. Quiescent history cannot consume the
   * normal-work page, including when its scheduled recheck becomes due. */
  reconcilable(after: string, now: number, deferred: boolean, limit = 100): BehaviorChain[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(now) || now < 0) throw new Error('invalid behavior reconciliation page')
    const rows = this.db.prepare(`SELECT chain_id FROM behavior_chain_current WHERE merged = 0
      AND (${ACTIVE_WORK_SQL}) = ? AND (${RECHECK_AT_SQL}) <= ? AND chain_id > ? ORDER BY chain_id LIMIT ?`)
      .all(deferred ? 0 : 1, now, after, limit) as Array<{ chain_id: string }>
    return rows.map((row) => this.read(row.chain_id)!)
  }

  reconciliationAt(chain: BehaviorChain): number | null {
    const row = this.db.prepare(`SELECT CASE WHEN (${LIVE_MODEL_SQL}) AND (
      json_extract(state, '$.mergeSha') IS NOT NULL
      OR json_extract(state, '$.observation.pull.merged') = 1
      OR json_extract(state, '$.observation.pull.state') != 'open'
      OR (json_extract(state, '$.observation.issue.open') = 0
        AND json_extract(state, '$.invocations[#-1].behavior') IN ('review-issue', 'implement-issue', 'repair-pr')))
      THEN NULL ELSE (${RECHECK_AT_SQL}) END AS at FROM behavior_chain_current WHERE chain_id = ? AND sequence = ?`)
      .get(chain.id, chain.sequence) as { at: number | null } | undefined
    if (!row) throw new Error('behavior chain changed while reading its reconciliation schedule')
    return row.at
  }

  /** Original recorded context/panel, never today's settings or a later
   * observation of an already-merged target. Old history stays immutable. */
  preMergeObservation(id: string, mergedAt: number): Record<string, unknown> | null {
    if (!Number.isSafeInteger(mergedAt) || mergedAt < 0) return null
    const firstMerge = this.db.prepare(`SELECT sequence FROM behavior_chain_events
      WHERE chain_id = ? AND json_extract(payload, '$.type') = 'chain.merged' ORDER BY sequence LIMIT 1`)
      .get(id) as { sequence: number } | undefined
    const row = this.db.prepare(`SELECT payload FROM behavior_chain_events
      WHERE chain_id = ? AND json_extract(payload, '$.type') = 'chain.observed' AND sequence < ?
        AND at <= ? AND json_extract(payload, '$.observation.checkedAt') <= ?
        AND json_extract(payload, '$.observation.pull.merged') = 0
      ORDER BY sequence DESC LIMIT 1`).get(id, firstMerge?.sequence ?? Number.MAX_SAFE_INTEGER, mergedAt, mergedAt) as { payload: string } | undefined
    return row ? (JSON.parse(row.payload) as Extract<ChainEvent, { type: 'chain.observed' }>).observation : null
  }

  firstMergedObservation(id: string): Record<string, unknown> | null {
    const row = this.db.prepare(`SELECT payload FROM behavior_chain_events
      WHERE chain_id = ? AND json_extract(payload, '$.type') = 'chain.observed' AND sequence < (
        SELECT sequence FROM behavior_chain_events WHERE chain_id = ? AND json_extract(payload, '$.type') = 'chain.merged'
        ORDER BY sequence LIMIT 1) ORDER BY sequence DESC LIMIT 1`).get(id, id) as { payload: string } | undefined
    return row ? (JSON.parse(row.payload) as Extract<ChainEvent, { type: 'chain.observed' }>).observation : null
  }

  /** Bounded status lookup, including completed chains while the datastore
   * still lists their PR. The journal hash validates the selected projection. */
  forPull(repository: string, number: number, identity?: { headRef: string | null, headRepo: string | null }): BehaviorChain | null {
    let rows = this.db.prepare(`SELECT chain_id FROM behavior_chain_current
      WHERE lower(json_extract(state, '$.repository')) = lower(?)
        AND json_extract(state, '$.observation.publication.pull_number') = ? LIMIT 2`)
      .all(repository, number) as Array<{ chain_id: string }>
    if (!rows.length && identity?.headRef && identity.headRepo?.toLowerCase() === repository.toLowerCase()) {
      rows = this.db.prepare(`SELECT chain_id FROM behavior_chain_current
        WHERE merged = 0 AND lower(json_extract(state, '$.repository')) = lower(?) AND json_extract(state, '$.branch') = ? LIMIT 2`)
        .all(repository, identity.headRef) as Array<{ chain_id: string }>
    }
    if (rows.length > 1) throw new Error('multiple behavior chains claim the same pull request')
    if (!rows.length) return null
    const chain = this.read(rows[0].chain_id)!
    const publication = chain.observation?.publication as { pull_number?: number | null } | undefined
    if (publication?.pull_number != null && publication.pull_number !== number) throw new Error('native branch belongs to a different published pull request')
    return chain
  }

  page(after = '', limit = 100, merged: boolean | null = null): BehaviorChain[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('behavior chain page must contain 1 to 100 records')
    const rows = (merged === null
      ? this.db.prepare('SELECT chain_id FROM behavior_chain_current WHERE chain_id > ? ORDER BY chain_id LIMIT ?').all(after, limit)
      : this.db.prepare('SELECT chain_id FROM behavior_chain_current WHERE merged = ? AND chain_id > ? ORDER BY chain_id LIMIT ?').all(merged ? 1 : 0, after, limit)) as Array<{ chain_id: string }>
    return rows.map((row) => this.read(row.chain_id)!)
  }

  verifyProjection(): void {
    this.cutover()
    const missing = this.db.prepare(`SELECT 1 FROM behavior_chain_events e LEFT JOIN behavior_chain_current c ON c.chain_id=e.chain_id
      WHERE e.chain_id != ? AND (c.chain_id IS NULL OR c.sequence < e.sequence) LIMIT 1`).get(CUTOVER_ID)
    if (missing) { this.rebuild(); return }
    for (const row of this.db.prepare('SELECT chain_id FROM behavior_chain_current').iterate() as Iterable<{ chain_id: string }>) this.read(row.chain_id)
  }

  admitInvocation(chain: BehaviorChain, eventId: string, invocation: ChainAdmission, capacity: number, budget: BehaviorResourceBudget | null = null): BehaviorChain | null {
    this.durable()
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('native invocation capacity must be positive')
    return this.db.transaction(() => {
      if (this.cutover().mode === 'draining') return null
      if (chain.invocations.some(prior => nativeResourcesPending({ ...prior }))) return null
      if (invocation.model !== null && !this.modelCapacityAvailable(capacity)) return null
      if (budget && (budget.memoryBytes !== null || budget.diskBytes !== null)
        && (invocation.model !== null || invocation.request.nativeResources === 2)) {
        const reservation = invocation.reservation
        if (!reservation || !Number.isSafeInteger(reservation.memoryBytes) || reservation.memoryBytes < 0
          || !Number.isSafeInteger(reservation.diskBytes) || reservation.diskBytes < 0) throw new Error('behavior resource budget is configured but the admission carries no valid reservation')
        const reserved = this.reservedResources()
        // Unknown ownership never reads as free: a live invocation that
        // predates reservations blocks bounded admissions until it settles.
        if (reserved.unaccounted > 0 || budgetShortfall(budget, reserved, reservation)) return null
      }
      return this.append(chain.id, eventId, chain.sequence, { type: 'invocation.admitted', invocation })
    }).immediate()
  }

  modelCapacityAvailable(capacity: number): boolean {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('native invocation capacity must be positive')
    return this.liveModelInvocationCount() < capacity
  }

  liveModelInvocationCount(): number {
    const row = this.db.prepare(`SELECT count(*) AS count FROM behavior_chain_current c, json_each(c.state, '$.invocations') i
      WHERE c.resource_pending = 1 AND json_extract(i.value, '$.model') IS NOT NULL
        AND behavior_native_resources_pending(i.value) = 1`).get() as { count: number }
    return row.count
  }

  /** Includes held/merged historical admissions. It is a resource-only page,
   * independent of organization readiness and behavior admission controls. */
  pendingResourcePage(after: { chain: string, position: number }, limit = 16): { chain: BehaviorChain, invocation: ChainInvocation, position: number }[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 || !Number.isSafeInteger(after.position)) throw new Error('invalid pending resource page')
    const rows = this.db.prepare(`SELECT c.chain_id AS chain, CAST(i.key AS INTEGER) AS position
      FROM behavior_chain_current c, json_each(c.state, '$.invocations') i
      WHERE c.resource_pending = 1 AND behavior_native_resources_pending(i.value) = 1
        AND (c.chain_id > ? OR (c.chain_id = ? AND CAST(i.key AS INTEGER) > ?))
      ORDER BY c.chain_id, CAST(i.key AS INTEGER) LIMIT ?`).all(after.chain, after.chain, after.position, limit) as { chain: string, position: number }[]
    return rows.map(row => { const chain = this.read(row.chain)!; return { chain, invocation: chain.invocations[row.position], position: row.position } })
  }

  capacitySnapshot() {
    return this.db.transaction(() => ({ modelInvocations: this.liveModelInvocationCount(), reservations: this.reservedResources() }))()
  }

  /** Resource allowances held by live native invocations, over the same
   *  scope as the count check: verified settlement releases a reservation
   *  exactly once, while cleanup uncertainty retains it. `unaccounted`
   *  counts live invocations admitted without a reservation. */
  reservedResources(): BehaviorResourceReservation & { unaccounted: number } {
    const row = this.db.prepare(`SELECT coalesce(sum(json_extract(i.value, '$.reservation.memoryBytes')), 0) AS memory,
      coalesce(sum(json_extract(i.value, '$.reservation.diskBytes')), 0) AS disk,
      coalesce(sum(CASE WHEN json_extract(i.value, '$.reservation.memoryBytes') IS NULL
        OR json_extract(i.value, '$.reservation.diskBytes') IS NULL THEN 1 ELSE 0 END), 0) AS unaccounted
      FROM behavior_chain_current c, json_each(c.state, '$.invocations') i
      WHERE c.resource_pending = 1 AND behavior_native_resources_pending(i.value) = 1`).get() as
      { memory: number, disk: number, unaccounted: number }
    if (!Number.isSafeInteger(row.memory) || row.memory < 0 || !Number.isSafeInteger(row.disk) || row.disk < 0
      || !Number.isSafeInteger(row.unaccounted) || row.unaccounted < 0) throw new Error('behavior resource reservations are corrupt')
    return { memoryBytes: row.memory, diskBytes: row.disk, unaccounted: row.unaccounted }
  }

  history(id: string, after = 0, limit = 100): StoredEvent[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid behavior event page')
    return this.db.prepare('SELECT * FROM behavior_chain_events WHERE chain_id = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(id, after, limit) as StoredEvent[]
  }

  rebuild(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM behavior_chain_current').run()
      const states = new Map<string, BehaviorChain>()
      for (const row of this.db.prepare('SELECT * FROM behavior_chain_events ORDER BY sequence').iterate() as Iterable<StoredEvent>) {
        if (row.chain_id === CUTOVER_ID) {
          const event = JSON.parse(row.payload) as CutoverEvent
          if (event.type !== 'admission.changed' || event.state.sequence !== row.sequence || chainBasis(event.state) !== (row as StoredEvent & { state_hash: string }).state_hash) throw new Error('behavior cutover journal is corrupt')
          continue
        }
        const event = JSON.parse(row.payload) as ChainEvent
        const next = reduceChain(states.get(row.chain_id) ?? null, event, row.sequence, row.chain_id)
        const hash = (row as StoredEvent & { state_hash: string }).state_hash
        if (chainBasis(next) !== hash && event.type === 'invocation.admitted' && !Object.hasOwn(event.invocation, 'reservation')) {
          // Pre-resource admissions omitted this property in both payload
          // and state. Resource-era payloads may also omit it but hash null.
          // Only the original immutable hash selects the historical form.
          delete next.invocations[next.invocations.length - 1].reservation
        }
        if (chainBasis(next) !== hash) throw new Error('behavior journal state hash is invalid')
        states.set(row.chain_id, next)
      }
      const save = this.db.prepare('INSERT INTO behavior_chain_current(chain_id, sequence, state, merged, resource_pending) VALUES (?, ?, ?, ?, ?)')
      for (const state of states.values()) save.run(state.id, state.sequence, JSON.stringify(state), state.mergeSha && !state.reviewPending ? 1 : 0,
        state.invocations.some(invocation => nativeResourcesPending({ ...invocation })) ? 1 : 0)
    }).immediate()
  }
}

export function chainBasis(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
