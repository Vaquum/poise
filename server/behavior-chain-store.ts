import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'

export type ChainBehavior = 'review-issue' | 'implement-issue' | 'publish-issue' | 'review-pr' | 'repair-pr' | 'approve-pr' | 'resolve-threads' | 'merge-pr' | 'rerun-grey-ci'
export interface ChainInvocation {
  id: string
  behavior: ChainBehavior
  basis: string
  actor: string
  model: string | null
  slot: string | null
  admittedAt: number
  admissionSequence: number
  request: { command: 'agent-interface' | 'github-interface', argv: string[], cwd: string, context?: { head: string, reviewRevision: string, queueRemoval?: string } }
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
  observation: Record<string, unknown> | null
  invocations: ChainInvocation[]
}
export type ChainEvent =
  | { type: 'chain.admitted', repository: string, issue: number, branch: string, author: string, reviewer: string }
  | { type: 'chain.observed', observation: Record<string, unknown> }
  | { type: 'chain.held', reason: string }
  | { type: 'chain.waiting', reason: string }
  | { type: 'chain.resumed' }
  | { type: 'chain.merged', mergeSha: string, evidence: Record<string, unknown> }
  | { type: 'invocation.admitted', invocation: Omit<ChainInvocation, 'state' | 'callId' | 'outcome' | 'evidence' | 'admissionSequence'> }
  | { type: 'invocation.started', invocationId: string }
  | { type: 'invocation.reconciled', invocationId: string, evidence: Record<string, unknown> }
  | { type: 'invocation.uncertain', invocationId: string, reason: string }
  | { type: 'invocation.settled', invocationId: string, callId: string | null, outcome: string, evidence: Record<string, unknown> }

interface StoredEvent { sequence: number, chain_id: string, event_id: string, at: number, payload: string }
const SHA = /^[0-9a-f]{40}$/i
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/
const MAX_EVENT_BYTES = 256 * 1024

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
    if (next.invocations.some((invocation) => invocation.state !== 'settled')) throw new Error('cannot complete a chain with an unsettled invocation')
    if (next.mergeSha && next.mergeSha !== event.mergeSha) throw new Error('behavior chain merge evidence conflicts')
    next.mergeSha = event.mergeSha.toLowerCase()
  } else if (event.type === 'invocation.admitted') {
    if (next.held || next.mergeSha) throw new Error('behavior chain does not admit invocations')
    const invocation = event.invocation
    if (!invocation.id || !invocation.basis || !invocation.actor || !Number.isSafeInteger(invocation.admittedAt)
      || invocation.admittedAt < 0 || next.invocations.some((prior) => prior.id === invocation.id)
      || next.invocations.some((prior) => prior.state !== 'settled')) throw new Error('behavior chain already owns an invocation or admission is invalid')
    next.invocations.push({ ...invocation, admissionSequence: sequence, state: 'admitted', callId: null, outcome: null, evidence: null })
    next.waiting = null
  } else {
    const invocation = next.invocations.find((candidate) => candidate.id === event.invocationId)
    if (!invocation) throw new Error('behavior invocation was not admitted')
    if (event.type === 'invocation.started') {
      if (invocation.state !== 'admitted') throw new Error('behavior invocation has already started')
      invocation.state = 'started'
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS behavior_chain_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, chain_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, payload TEXT NOT NULL, state_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS behavior_chain_history ON behavior_chain_events(chain_id, sequence);
      CREATE TRIGGER IF NOT EXISTS behavior_chain_no_update BEFORE UPDATE ON behavior_chain_events
        BEGIN SELECT RAISE(ABORT, 'behavior chain events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS behavior_chain_no_delete BEFORE DELETE ON behavior_chain_events
        BEGIN SELECT RAISE(ABORT, 'behavior chain events are immutable'); END;
      CREATE TABLE IF NOT EXISTS behavior_chain_current (
        chain_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, state TEXT NOT NULL, merged INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS behavior_chain_active ON behavior_chain_current(merged, chain_id);
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
      if ((current?.sequence ?? 0) !== expectedSequence) throw new Error('behavior chain changed before event admission')
      if (event.type === 'chain.admitted' && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_work_bindings'").get()
        && this.db.prepare('SELECT 1 FROM chat_work_bindings WHERE lower(target) = lower(?) LIMIT 1')
          .get(`https://github.com/${event.repository}/issues/${event.issue}`)) throw new Error('seed issue is already owned by an existing chat; active work cannot be migrated')
      const sequence = (this.db.prepare('SELECT coalesce(max(sequence), 0) + 1 AS next FROM behavior_chain_events').get() as { next: number }).next
      const next = reduceChain(current, event, sequence, id)
      this.db.prepare('INSERT INTO behavior_chain_events(sequence, chain_id, event_id, at, payload, state_hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sequence, id, eventId, at, payload, chainBasis(next))
      this.db.prepare(`INSERT INTO behavior_chain_current(chain_id, sequence, state, merged) VALUES (?, ?, ?, ?)
        ON CONFLICT(chain_id) DO UPDATE SET sequence=excluded.sequence, state=excluded.state, merged=excluded.merged`)
        .run(id, next.sequence, JSON.stringify(next), next.mergeSha ? 1 : 0)
      return next
    }).immediate()
  }

  active(after = '', limit = 100): BehaviorChain[] {
    return this.page(after, limit, false)
  }

  page(after = '', limit = 100, merged: boolean | null = null): BehaviorChain[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('behavior chain page must contain 1 to 100 records')
    const rows = (merged === null
      ? this.db.prepare('SELECT chain_id FROM behavior_chain_current WHERE chain_id > ? ORDER BY chain_id LIMIT ?').all(after, limit)
      : this.db.prepare('SELECT chain_id FROM behavior_chain_current WHERE merged = ? AND chain_id > ? ORDER BY chain_id LIMIT ?').all(merged ? 1 : 0, after, limit)) as Array<{ chain_id: string }>
    return rows.map((row) => this.read(row.chain_id)!)
  }

  verifyProjection(): void {
    const missing = this.db.prepare(`SELECT 1 FROM behavior_chain_events e LEFT JOIN behavior_chain_current c ON c.chain_id=e.chain_id
      WHERE c.chain_id IS NULL OR c.sequence < e.sequence LIMIT 1`).get()
    if (missing) { this.rebuild(); return }
    for (const row of this.db.prepare('SELECT chain_id FROM behavior_chain_current').iterate() as Iterable<{ chain_id: string }>) this.read(row.chain_id)
  }

  admitInvocation(chain: BehaviorChain, eventId: string, invocation: Extract<ChainEvent, { type: 'invocation.admitted' }>['invocation'], capacity: number): BehaviorChain | null {
    this.durable()
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('native invocation capacity must be positive')
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT count(*) AS count FROM behavior_chain_current c, json_each(c.state, '$.invocations') i
        WHERE c.merged = 0 AND json_extract(i.value, '$.state') != 'settled'
          AND json_type(i.value, '$.model') != 'null' AND json_extract(i.value, '$.evidence.resources_settled_at') IS NULL`).get() as { count: number }
      if (invocation.model !== null && row.count >= capacity) return null
      return this.append(chain.id, eventId, chain.sequence, { type: 'invocation.admitted', invocation })
    }).immediate()
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
        states.set(row.chain_id, reduceChain(states.get(row.chain_id) ?? null, JSON.parse(row.payload) as ChainEvent, row.sequence, row.chain_id))
        if (chainBasis(states.get(row.chain_id)) !== (row as StoredEvent & { state_hash: string }).state_hash) throw new Error('behavior journal state hash is invalid')
      }
      const save = this.db.prepare('INSERT INTO behavior_chain_current(chain_id, sequence, state, merged) VALUES (?, ?, ?, ?)')
      for (const state of states.values()) save.run(state.id, state.sequence, JSON.stringify(state), state.mergeSha ? 1 : 0)
    }).immediate()
  }
}

export function chainBasis(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
