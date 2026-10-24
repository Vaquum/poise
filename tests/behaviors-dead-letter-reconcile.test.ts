import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let tempRoot = ''
let loaded: typeof import('../server/db') | null = null

async function loadIsolatedDb(path: string): Promise<typeof import('../server/db')> {
  process.env.POISE_DB = path
  vi.resetModules()
  loaded = await import('../server/db')
  return loaded
}

afterEach(async () => {
  vi.useRealTimers()
  if (loaded?.db.open) loaded.closeDatabase()
  loaded = null
  delete process.env.POISE_DB
  vi.resetModules()
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

async function loadStore() {
  tempRoot = await mkdtemp(join(tmpdir(), 'poise-dead-letter-reconcile-'))
  return loadIsolatedDb(join(tempRoot, 'cache.db'))
}

type Store = Awaited<ReturnType<typeof loadStore>>

// A failed launch with its dead letter, backdated to the incident: an old
// failure brought back today keeps the call's own time for the test.
async function failedLaunch(
  store: Store,
  key: string,
  target: string,
  repo: string,
  pr: number,
  error: string,
  createdAt: string,
  behavior: 'pr_review' | 'pr_approve' | 'issue_review' = 'pr_review',
) {
  const claimId = store.claimSeenOwned(key, target)!
  const requestedAt = new Date(Date.parse(createdAt) - 60_000).toISOString()
  expect(store.markBehaviorLaunchIntentOwned({
    key, target, claimId, launchBehavior: behavior, repo, pr,
    requestedAt, expectedHead: behavior === 'issue_review' ? '' : 'a'.repeat(40), actor: 'bit-mis',
    source: `poise:${key}`, correlationId: claimId,
  })).toBe(true)
  const callId = 'c'.repeat(32)
  expect(store.linkBehaviorLaunchCallOwned(key, target, claimId, callId)).toBe(true)
  const id = store.recordBehaviorDeadLetter(
    store.listBehaviorLaunchClaims(key).find((claim) => claim.target === target)!, error, callId)
  store.db.prepare('UPDATE behavior_dead_letters SET created_at = ? WHERE id = ?').run(createdAt, id)
  return { claimId, callId, id }
}

describe('dead-letter reconcile pass', () => {
  it('resolves rows a later completion settled, citing the completion', async () => {
    const store = await loadStore()
    await failedLaunch(store, 'approve-prs', 'Vaquum/repo#12@head=old', 'Vaquum/repo', 12,
      'Grok Build usage balance exhausted', '2026-10-17T10:00:00Z', 'pr_approve')
    // A later approval on the same pull request settles the old failure.
    const claimId = store.claimSeenOwned('approve-prs', 'Vaquum/repo#12@head=new')!
    store.markBehaviorLaunchIntentOwned({
      key: 'approve-prs', target: 'Vaquum/repo#12@head=new', claimId, launchBehavior: 'pr_approve',
      repo: 'Vaquum/repo', pr: 12, requestedAt: '2026-10-19T10:00:00Z',
      expectedHead: 'b'.repeat(40), actor: 'bit-mis', source: 'poise:approve-prs', correlationId: claimId,
    })
    store.linkBehaviorLaunchCallOwned('approve-prs', 'Vaquum/repo#12@head=new', claimId, 'd'.repeat(32))
    expect(store.completeBehaviorLaunchOwned({
      key: 'approve-prs', target: 'Vaquum/repo#12@head=new', claimId,
      outcome: 'approved', action: 'approved', completedAt: '2026-10-19T10:05:00Z', headSha: 'b'.repeat(40),
    })).toBe(true)

    const [result] = store.reconcileBehaviorDeadLetters(new Set(['Vaquum/repo#12']))
    expect(result).toMatchObject({ behavior: 'approve-prs', disposition: 'resolved' })
    expect(result.reason).toContain('2026-10-19T10:05:00Z')
    expect(store.listBehaviorDeadLetters()).toEqual([])
    expect(store.db.prepare(
      'SELECT resolution, resolution_evidence, resolved_at, retired_at FROM behavior_dead_letters',
    ).get()).toMatchObject({
      resolution: 'resolved',
      resolution_evidence: expect.stringContaining('2026-10-19T10:05:00Z'),
      resolved_at: expect.any(String),
      retired_at: expect.any(String),
    })
    // Resolving retires; it never deletes the audit row.
    expect(store.db.prepare('SELECT count(*) FROM behavior_dead_letters').pluck().get()).toBe(1)
  })

  it('supersedes closed targets and holds unreadable ones instead of guessing', async () => {
    const store = await loadStore()
    await failedLaunch(store, 'review-new-prs', 'Vaquum/repo#13', 'Vaquum/repo', 13,
      'Not signed in', '2026-10-20T10:00:00Z')
    await failedLaunch(store, 'review-new-prs', 'Vaquum/dark#1', 'Vaquum/dark', 1,
      'Not signed in', '2026-10-20T10:00:00Z')

    const results = store.reconcileBehaviorDeadLetters(
      new Set(['Vaquum/repo#12']), ['review-new-prs'], undefined, new Set(['Vaquum/dark']))
    expect(results).toHaveLength(2)
    const byTarget = Object.fromEntries(results.map((row) => [row.target, row]))
    expect(byTarget['Vaquum/repo#13'].disposition).toBe('superseded')
    expect(byTarget['Vaquum/repo#13'].reason).toContain('no longer open')
    expect(byTarget['Vaquum/dark#1'].disposition).toBe('held')
    expect(byTarget['Vaquum/dark#1'].reason).toContain('could not be listed')
    expect(store.listBehaviorDeadLetters().map((row) => row.target)).toEqual(['Vaquum/dark#1'])
    expect(store.db.prepare('SELECT count(*) FROM behavior_dead_letters').pluck().get()).toBe(2)
  })

  it('holds rows with no later run on open targets, recording the check', async () => {
    const store = await loadStore()
    await failedLaunch(store, 'approve-prs', 'Vaquum/repo#14@head=old', 'Vaquum/repo', 14,
      'No space left on device', '2026-10-22T10:00:00Z', 'pr_approve')

    const [result] = store.reconcileBehaviorDeadLetters(
      new Set(['Vaquum/repo#14']), ['review-new-prs', 'approve-prs'], undefined, undefined, 200,
      Date.parse('2026-10-22T12:00:00Z'))
    expect(result).toMatchObject({ disposition: 'held', reason: 'no later completion; target still open' })
    const row = store.listBehaviorDeadLetters()[0]
    expect(row).toMatchObject({ target: 'Vaquum/repo#14@head=old', resolution: 'held' })
    expect(JSON.parse(row.resolutionEvidence!)).toMatchObject({ open: true, checkedAt: '2026-10-22T12:00:00.000Z' })
    expect(row.resolvedAt).toBe('2026-10-22T12:00:00.000Z')
  })

  it('never resolves or supersedes quarantined rows', async () => {
    const store = await loadStore()
    const { claimId } = await failedLaunch(store, 'review-new-prs', 'Vaquum/repo#15', 'Vaquum/repo', 15,
      'agent log row quarantined', '2026-10-17T10:00:00Z')
    store.quarantineBehaviorLaunchOwned('review-new-prs', 'Vaquum/repo#15', claimId, 'unreadable', 'conflicting row', true)

    const [result] = store.reconcileBehaviorDeadLetters(new Set())
    expect(result).toMatchObject({ disposition: 'held', reason: 'quarantined claim outstanding' })
    expect(store.listBehaviorDeadLetters()).toHaveLength(1)
  })

  it('resolves issue rows only on a same-target completion', async () => {
    const store = await loadStore()
    await failedLaunch(store, 'review-new-issues', 'Vaquum/Origo#500', 'Vaquum/Origo', 500,
      'model capacity exceeded', '2026-10-17T10:00:00Z', 'issue_review')
    const claimId = store.claimSeenOwned('review-new-issues', 'Vaquum/Origo#501')!
    store.markBehaviorLaunchIntentOwned({
      key: 'review-new-issues', target: 'Vaquum/Origo#501', claimId, launchBehavior: 'issue_review',
      repo: 'Vaquum/Origo', pr: 501, requestedAt: '2026-10-19T10:00:00Z',
      expectedHead: '', actor: 'bit-mis', source: 'poise:review-new-issues', correlationId: claimId,
    })
    expect(store.completeIssueReviewLaunchOwned({
      key: 'review-new-issues', target: 'Vaquum/Origo#501', claimId, completedAt: '2026-10-19T10:05:00Z',
    })).toBe(true)

    // A sibling issue's review does not settle this one's incident.
    const [result] = store.reconcileBehaviorDeadLetters(
      new Set(['Vaquum/Origo#500', 'Vaquum/Origo#501']), ['review-new-issues'])
    expect(result).toMatchObject({ target: 'Vaquum/Origo#500', disposition: 'held' })
    expect(store.listBehaviorDeadLetters()).toHaveLength(1)
  })

  it('holds rows without repository identity instead of guessing their target', async () => {
    const store = await loadStore()
    store.db.prepare(`
      INSERT INTO behavior_dead_letters(id, behavior, target, error, created_at)
      VALUES ('legacy', 'review-new-prs', 'Vaquum/repo#16', 'old failure', '2026-10-12T10:00:00Z')
    `).run()

    const [result] = store.reconcileBehaviorDeadLetters(new Set())
    expect(result).toMatchObject({ id: 'legacy', disposition: 'held' })
    expect(result.reason).toContain('no repository identity')
    expect(store.listBehaviorDeadLetters()).toHaveLength(1)
  })

  it('revisits held rows at most hourly, so capped passes resume oldest-first', async () => {
    const store = await loadStore()
    for (const [target, pr, created] of [
      ['Vaquum/repo#21', 21, '2026-10-20T10:00:00Z'],
      ['Vaquum/repo#22', 22, '2026-10-21T10:00:00Z'],
      ['Vaquum/repo#23', 23, '2026-10-22T10:00:00Z'],
    ] as const) {
      await failedLaunch(store, 'review-new-prs', target, 'Vaquum/repo', pr, 'timeout', created)
    }
    const open = new Set(['Vaquum/repo#21', 'Vaquum/repo#22', 'Vaquum/repo#23'])
    const noon = Date.parse('2026-10-22T12:00:00Z')

    expect(store.reconcileBehaviorDeadLetters(open, ['review-new-prs'], undefined, undefined, 2, noon)
      .map((row) => row.target)).toEqual(['Vaquum/repo#21', 'Vaquum/repo#22'])
    expect(store.reconcileBehaviorDeadLetters(open, ['review-new-prs'], undefined, undefined, 2, noon)
      .map((row) => row.target)).toEqual(['Vaquum/repo#23'])
    expect(store.reconcileBehaviorDeadLetters(open, ['review-new-prs'], undefined, undefined, 2, noon)).toEqual([])
  })

  it('scopes the batch by behavior before limiting, so old rows cannot starve it', async () => {
    const store = await loadStore()
    for (const [target, pr, created] of [
      ['Vaquum/Origo#501', 501, '2026-10-17T10:00:00Z'],
      ['Vaquum/Origo#502', 502, '2026-10-18T10:00:00Z'],
    ] as const) {
      await failedLaunch(store, 'review-new-issues', target, 'Vaquum/Origo', pr, 'timeout', created, 'issue_review')
    }
    await failedLaunch(store, 'review-new-prs', 'Vaquum/repo#30', 'Vaquum/repo', 30,
      'timeout', '2026-10-22T10:00:00Z')

    const results = store.reconcileBehaviorDeadLetters(
      new Set(['Vaquum/repo#30']), ['review-new-prs'], undefined, undefined, 2)
    expect(results.map((row) => row.target)).toEqual(['Vaquum/repo#30'])
    expect(store.reconcileBehaviorDeadLetters(new Set(), [], undefined, undefined, 2)).toEqual([])
  })

  it('reconciles unseen rows before rechecks, least-recently rechecked first', async () => {
    const store = await loadStore()
    const now = Date.parse('2026-10-22T12:00:00Z')
    const seed = async (target: string, pr: number, created: string, resolved: string | null) => {
      const { id } = await failedLaunch(store, 'review-new-prs', target, 'Vaquum/repo', pr, 'timeout', created)
      if (resolved) {
        store.db.prepare(`UPDATE behavior_dead_letters
          SET resolution = 'held', resolution_evidence = '{}', resolved_at = ? WHERE id = ?`).run(resolved, id)
      }
    }
    await seed('Vaquum/repo#31', 31, '2026-10-17T10:00:00Z', '2026-10-22T10:00:00Z')
    await seed('Vaquum/repo#32', 32, '2026-10-22T11:00:00Z', null)
    await seed('Vaquum/repo#33', 33, '2026-10-20T10:00:00Z', '2026-10-22T09:00:00Z')
    const open = new Set(['Vaquum/repo#31', 'Vaquum/repo#32', 'Vaquum/repo#33'])

    const order: string[] = []
    for (let pass = 0; pass < 3; pass++) {
      order.push(...store.reconcileBehaviorDeadLetters(open, ['review-new-prs'], undefined, undefined, 1, now)
        .map((row) => row.target))
    }
    expect(order).toEqual(['Vaquum/repo#32', 'Vaquum/repo#33', 'Vaquum/repo#31'])
  })

  it('refuses an unbounded or empty reconcile batch', async () => {
    const store = await loadStore()
    expect(() => store.reconcileBehaviorDeadLetters(new Set(), ['review-new-prs'], undefined, undefined, 0))
      .toThrow('reconcile limit must be between 1 and 500')
    expect(() => store.reconcileBehaviorDeadLetters(new Set(), ['review-new-prs'], undefined, undefined, 501))
      .toThrow('reconcile limit must be between 1 and 500')
  })
})
