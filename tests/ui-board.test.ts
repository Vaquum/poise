import { describe, expect, it } from 'vitest'
import { blockerState, canAssign, dwell, phaseOf, sortItems, toItem, type BlockerId, type GhRecord, type Item, type PrStatus } from '../src/ui/places/board/model'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()
const record = (patch: Partial<GhRecord> = {}): GhRecord => ({
  kind: 'pr', repo: 'acme/site', number: 7, state: 'open', title: 'Fix the header', url: 'https://github.com/acme/site/pull/7',
  created_at: iso(600), updated_at: iso(30), merged_at: null, ...patch,
})
const status = (id: BlockerId, sinceMinutes = 20): PrStatus => ({
  repository: 'acme/site', number: 7, blocker: { id, line: `${id} line`, since: iso(sinceMinutes), sinceRestart: false, details: [] },
})
const item = (patch: Partial<Parameters<typeof toItem>[0]> = {}): Item => toItem({ record: record(), status: null, chain: null, run: null, labelled: false, closing: null, ...patch })

describe('Board puts every live item in the seven states', () => {
  it('maps each of main’s pull request blockers to one state', () => {
    const expected: Record<BlockerId, string | null> = {
      review_running: 'running', ci_pending: 'waiting', in_queue: 'waiting', behind: 'blocked', ci_failing: 'failed',
      conflicting: 'blocked', blocked: 'blocked', held: 'blocked', awaiting_review: 'waiting', awaiting_author: 'waiting',
      unresolved_threads: 'waiting', approved_not_enqueued: 'waiting', not_eligible: 'idle', unknown: null,
    }
    for (const [id, state] of Object.entries(expected)) expect(blockerState(id as BlockerId)).toBe(state)
  })

  it('shows an explicit request for the owner’s review independently of the behavior status', () => {
    expect(item({ status: status('awaiting_review'), record: record({ reviewRequested: false }) }).state).toBe('waiting')
    expect(item({ status: undefined, record: record({ reviewRequested: true }) })).toMatchObject({
      state: 'needs-you', detail: 'GitHub requested your review',
    })
    expect(item({ record: record({ state: 'closed', reviewRequested: true }) }).state).toBe('idle')
  })

  it('reads a pull request’s blocker as its state, with the blocker’s words and since', () => {
    const it = item({ status: status('ci_failing') })
    expect(it).toMatchObject({ state: 'failed', detail: 'ci_failing line' })
    expect(it.since).toBe(Date.parse(iso(20)))
  })

  it('says merged work and closed issues are Done, a closed pull request Idle, and a run going on it Running', () => {
    expect(item({ record: record({ state: 'merged', merged_at: iso(5) }) })).toMatchObject({ state: 'done', detail: 'merged' })
    expect(item({ record: record({ kind: 'issue', state: 'closed' }) })).toMatchObject({ state: 'done', detail: 'closed' })
    expect(item({ record: record({ state: 'closed' }) })).toMatchObject({ state: 'idle', detail: 'closed' })
    // A pull request whose status could not be read has no state word.
    expect(item({ status: undefined })).toMatchObject({ state: null, detail: '' })
    expect(item({ run: { name: 'Review', since: 1_000 }, status: status('awaiting_review') })).toMatchObject({ state: 'running', since: 1_000, who: { kind: 'run', tag: 'Review' } })
  })

  it('marks the chain’s label as Poise, and an open issue nobody has as Idle', () => {
    expect(item({ record: record({ kind: 'issue' }), labelled: true }).who).toMatchObject({ kind: 'poise' })
    expect(item({ record: record({ kind: 'issue' }) })).toMatchObject({ state: 'idle', who: null })
  })

  it('gives an item no state word while the runs have never been read, rather than Idle', () => {
    expect(item({ record: record({ kind: 'issue' }), run: undefined })).toMatchObject({ state: null, detail: '' })
    expect(item({ record: record({ kind: 'issue' }), run: null })).toMatchObject({ state: 'idle' })
  })
})

describe('Board says how long, and marks what has stood still', () => {
  it('says how long something has run, or how long it has waited, marked after 15 minutes', () => {
    expect(dwell(item({ status: status('ci_pending', 8) }), NOW)).toEqual({ text: 'for 8m', stuck: false })
    expect(dwell(item({ status: status('ci_pending', 36) }), NOW)).toEqual({ text: 'the same for 36m', stuck: true })
    expect(dwell(item({ record: record({ kind: 'issue', updated_at: iso(150) }) }), NOW)).toEqual({ text: 'no change for 2h', stuck: false })
    expect(dwell(item({ record: record({ state: 'merged' }) }), NOW).text).toBe('')
  })
})

describe('Board’s phase, order and Assign', () => {
  it('reads a phase from the blocker for work outside the chain', () => {
    expect(phaseOf(item({ record: record({ kind: 'issue' }) })).word).toBe('Intake')
    expect(phaseOf(item({ status: status('ci_failing') })).word).toBe('Repair')
    expect(phaseOf(item({ status: status('approved_not_enqueued') })).word).toBe('Merge')
    expect(phaseOf(item({ status: status('awaiting_review') })).word).toBe('PR review')
    expect(phaseOf(item({ record: record({ state: 'merged' }) })).word).toBe('Merged')
  })

  it('orders by attention: Needs you first, then Blocked, Failed, Running, Waiting, Idle, Done', () => {
    const a = item({ status: status('ci_pending') }), b = item({ status: status('held') }), c = item({ record: record({ reviewRequested: true }) })
    expect(sortItems([a, b, c], 'attention').map((x) => x.state)).toEqual(['needs-you', 'blocked', 'waiting'])
  })

  it('offers Assign only on an open issue nobody has, once the intake is read', () => {
    const issue = item({ record: record({ kind: 'issue' }) })
    expect(canAssign(issue, true, false)).toBe(true)
    expect(canAssign(issue, false, false)).toBe(false)
    expect(canAssign(issue, true, true)).toBe(false)
    expect(canAssign({ ...issue, labelled: true }, true, false)).toBe(false)
    expect(canAssign(item(), true, false)).toBe(false)
  })
})
