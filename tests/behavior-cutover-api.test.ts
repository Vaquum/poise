import { createServer } from 'node:http'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { db, getMeta, setMeta, closeDatabase } from '../server/db'
import { behaviorChainJournal } from '../server/behavior-chain-journal'
import type { BehaviorChain, ChainEvent } from '../server/behavior-chain-store'
import { behaviorChainSummary } from '../server/behavior-chain-summary'
import { chainSummaryFixture } from './fixtures/behavior-chain-summary'

const native = vi.hoisted(() => ({ support: { status: 'supported', error: null as string | null } }))
vi.mock('../server/native-cleanup-support', () => ({
  nativeCleanupSupport: () => native.support,
  requireNativeCleanup: async () => { if (native.support.status !== 'supported') throw new Error(native.support.error || 'Cleanup setup is unverified') },
}))
beforeEach(() => { native.support = { status: 'supported', error: null } })

vi.mock('../server/behaviors', () => ({ getBehaviorChainRuntimeHealth: () => [],
  getBehaviorChainCapacity: () => ({ status: 'available', reservedModelInvocations: 0, modelInvocationLimit: 3,
    enabled: false, intake: { seedMode: 'label', label: 'poise' } }) }))
const { handleBehaviorChains } = await import('../server/behavior-chain-api')
afterAll(() => closeDatabase())

it('refuses unsupported or unverified cleanup without leaving v1 or creating work', async () => {
  const accounts = ['me', 'agentAccount'].map(key => ({ key, value: getMeta(key) }))
  setMeta('me', 'author'); setMeta('agentAccount', 'reviewer')
  const journal = behaviorChainJournal()
  const before = journal.cutover()
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  try {
    for (const status of ['unsupported', 'unavailable', 'checking']) {
      native.support = { status, error: 'This setup has not proved safe v2 cleanup' }
      const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'switch-to-v2', sequence: before.sequence }) })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe(native.support.error)
      expect(journal.cutover()).toEqual(before)
      const read = await (await fetch(base)).json()
      expect(read.cutover.support).toEqual(native.support)
    }
    expect(db.prepare('SELECT count(*) AS n FROM behavior_chain_current').get()).toEqual({ n: 0 })
  } finally {
    for (const { key, value } of accounts) {
      if (value === null) db.prepare('DELETE FROM meta WHERE key = ?').run(key)
      else setMeta(key, value)
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('reports durable cutover through the real HTTP handler and refuses stale or invalid controls', async () => {
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  const post = (body: unknown) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    expect((await post({ operation: 'switch-to-v2', sequence: 0 })).status).toBe(409)
    setMeta('me', 'author'); setMeta('agentAccount', 'reviewer')
    expect((await post({ operation: 'switch-to-v2' })).status).toBe(400)
    const response = await post({ operation: 'switch-to-v2', sequence: 0 })
    expect(response.status).toBe(200)
    const drain = await response.json()
    expect(drain.cutover.mode).toBe('draining')
    expect((await post({ operation: 'cancel-cutover', sequence: 0 })).status).toBe(409)
    const read = await (await fetch(base)).json()
    expect(read.cutover.sequence).toBe(drain.cutover.sequence)
    expect((await post({ operation: 'cancel-cutover', sequence: drain.cutover.sequence })).status).toBe(200)
    expect(behaviorChainJournal().cutover().mode).toBe('v1')
    expect(db.prepare('SELECT count(*) AS n FROM behavior_chain_current').get()).toEqual({ n: 0 })
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})

it('keeps a confirmed merge with an open review obligation readable while refusing futile admission controls', async () => {
  const journal = behaviorChainJournal()
  let pending = journal.append('api/repo#7', 'pending-seed', 0, { type: 'chain.admitted', repository: 'api/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  pending = journal.append(pending.id, 'pending-merge', pending.sequence, { type: 'chain.merged', mergeSha: 'a'.repeat(40),
    evidence: { repository: pending.repository, pull_number: 17, merged: true, merge_sha: 'a'.repeat(40), review_complete: false } })
  let complete = journal.append('api/repo#8', 'complete-seed', 0, { type: 'chain.admitted', repository: 'api/repo', issue: 8,
    branch: 'poise/issue-8', author: 'author', reviewer: 'reviewer' })
  complete = journal.append(complete.id, 'complete-merge', complete.sequence, { type: 'chain.merged', mergeSha: 'b'.repeat(40),
    evidence: { repository: complete.repository, pull_number: 18, merged: true, merge_sha: 'b'.repeat(40) } })
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  try {
    const active = await (await fetch(`${base}?state=active`)).json()
    expect(active.chains).toEqual([expect.objectContaining({ id: pending.id, mergeSha: 'a'.repeat(40), reviewPending: true })])
    const merged = await (await fetch(`${base}?state=merged`)).json()
    expect(merged.chains).toEqual([expect.objectContaining({ id: complete.id, mergeSha: 'b'.repeat(40), reviewPending: null, reviewStatus: 'not-recorded' })])
    expect(journal.read(complete.id)).not.toHaveProperty('reviewPending')
    const detail = await (await fetch(`${base}?id=${encodeURIComponent(pending.id)}`)).json()
    expect(detail.chain.reviewPending).toBe(true)
    const canonical = journal.read(pending.id)!
    expect(detail.chain).toEqual(behaviorChainSummary(canonical, { at: journal.reconciliationAt(canonical) }))
    const before = journal.history(pending.id)
    for (const operation of ['hold', 'resume']) {
      const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pending.id, sequence: pending.sequence, operation }) })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('original receipt reconciliation only')
    }
    expect(journal.history(pending.id)).toEqual(before)
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})

it('preserves exact-sequence Hold and Resume for unmerged ownership', async () => {
  const journal = behaviorChainJournal()
  const chain = journal.append('api/repo#9', 'unmerged-seed', 0, { type: 'chain.admitted', repository: 'api/repo', issue: 9,
    branch: 'poise/issue-9', author: 'author', reviewer: 'reviewer' })
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const post = (operation: string, sequence: number) => fetch(`http://127.0.0.1:${address.port}/api/behavior-chains`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: chain.id, sequence, operation }) })
  try {
    const hold = await post('hold', chain.sequence)
    expect(hold.status).toBe(200)
    const held = (await hold.json()).chain
    expect(held.held).toBe('New invocations held by the person')
    expect((await post('resume', chain.sequence)).status).toBe(409)
    const resume = await post('resume', held.sequence)
    expect(resume.status).toBe(200)
    expect((await resume.json()).chain.held).toBeNull()
    expect(journal.read(chain.id)?.invocations).toEqual([])
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

it('shares the production summary and historical rebuild contract with browser payloads', () => {
  expect(chainSummaryFixture('pending-active').chains[0]).toMatchObject({ reviewStatus: 'pending', reviewPending: true,
    invocations: [{ behavior: 'repair-pr', state: 'uncertain' }] })
  expect(chainSummaryFixture('pending-no-invocation').chains[0]).toMatchObject({ reviewStatus: 'pending', reviewPending: true, invocations: [] })
  expect(chainSummaryFixture('complete').chains[0]).toMatchObject({ reviewStatus: 'complete', reviewPending: false })
  expect(chainSummaryFixture('historical').chains[0]).toMatchObject({ reviewStatus: 'not-recorded', reviewPending: null })
})

it('excludes closed seeds only after PR, execution, resource and review obligations are settled', async () => {
  const journal = behaviorChainJournal()
  const record = (chain: BehaviorChain, event: ChainEvent) => journal.append(chain.id, `${chain.id}:${chain.sequence}`, chain.sequence, event)
  const closed = { checkedAt: Date.now(), issue: { open: false }, existingPulls: [], pull: null,
    publication: { pull_number: null, state: null, merged: false, merge_sha: null } }
  const closedPull = { ...closed, publication: { pull_number: 17, state: 'closed', merged: false, merge_sha: null },
    pull: { number: 17, state: 'closed', merged: false, mergeSha: null } }
  const seed = (issue: number, observation: Record<string, unknown> | null = closed) => {
    let chain = journal.append(`closed/repo#${issue}`, `closed-seed-${issue}`, 0, { type: 'chain.admitted', repository: 'closed/repo', issue,
      branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' })
    if (observation) chain = record(chain, { type: 'chain.observed', observation })
    return record(chain, { type: 'chain.held', reason: 'Seed issue is closed' })
  }
  const quiescent = [seed(1), seed(2, { ...closedPull, publication: { ...closedPull.publication, pull_number: 16 },
    pull: { ...closedPull.pull, number: 16 } })]
  const retained = [seed(3, { ...closed, issue: { open: true } }), seed(4, { ...closed, issue: {} }), seed(5, null),
    seed(6, { ...closed, existingPulls: ['https://github.com/closed/repo/pull/18'] }),
    seed(7, { ...closedPull, publication: { ...closedPull.publication, state: 'open' }, pull: { ...closedPull.pull, state: 'open' } }),
    seed(8, { ...closed, existingPulls: undefined }), seed(9, { ...closed, publication: undefined }),
    seed(10, { ...closedPull, pull: null }), seed(11, { ...closedPull, pull: { ...closedPull.pull, state: 'unknown' } }),
    seed(12, { ...closedPull, publication: { ...closedPull.publication, state: 'open' } }),
    seed(13, { ...closedPull, pull: { ...closedPull.pull, number: 18 } }),
    seed(14, { ...closedPull, publication: { ...closedPull.publication, merged: true, merge_sha: 'd'.repeat(40) },
      pull: { ...closedPull.pull, merged: true, mergeSha: 'd'.repeat(40) } })]
  for (const [index, state] of ['admitted', 'started', 'uncertain', 'settled'].entries()) {
    let chain = seed(20 + index)
    // Resume only to admit the original invocation; closure never settles it.
    chain = record(chain, { type: 'chain.resumed' })
    chain = record(chain, { type: 'invocation.admitted', invocation: { id: chain.id, behavior: 'resolve-threads', basis: 'seed',
      actor: chain.reviewer, model: null, slot: null, admittedAt: Date.now(),
      request: { command: 'github-interface', argv: ['--fixture'], cwd: '/fixture', ...(state === 'settled' ? { nativeResources: 2 as const } : {}) } } })
    if (state !== 'admitted') chain = record(chain, { type: 'invocation.started', invocationId: chain.id })
    if (state === 'uncertain') chain = record(chain, { type: 'invocation.uncertain', invocationId: chain.id, reason: 'original result unknown' })
    if (state === 'settled') chain = record(chain, { type: 'invocation.settled', invocationId: chain.id,
      callId: 'c'.repeat(32), outcome: 'target_closed', evidence: { status: 'deferred', action: 'not_started' } })
    retained.push(chain)
  }
  let pending = seed(30)
  pending = record(pending, { type: 'chain.merged', mergeSha: 'd'.repeat(40), evidence: {
    repository: pending.repository, pull_number: 17, merged: true, merge_sha: 'd'.repeat(40), review_complete: false } })
  retained.push(pending)
  const before = quiescent.map(chain => journal.history(chain.id))
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  try {
    const active = await (await fetch(`${base}?state=active&after=closed/`)).json()
    expect(active.chains.map((chain: { id: string }) => chain.id).sort()).toEqual(retained.map(chain => chain.id).sort())
    const all = await (await fetch(`${base}?after=closed/`)).json()
    const merged = await (await fetch(`${base}?state=merged&after=closed/`)).json()
    for (const [index, chain] of quiescent.entries()) {
      expect(all.chains).toContainEqual(expect.objectContaining({ id: chain.id, mergeSha: null, reviewStatus: 'not-recorded' }))
      expect(merged.chains.map((row: { id: string }) => row.id)).not.toContain(chain.id)
      const detail = await (await fetch(`${base}?id=${encodeURIComponent(chain.id)}`)).json()
      expect(detail.chain).toEqual(behaviorChainSummary(chain, { at: journal.reconciliationAt(chain) }))
      expect(detail.events.map((event: { type: string }) => event.type)).toEqual(['chain.admitted', 'chain.observed', 'chain.held'])
      expect(journal.read(chain.id)).toEqual(chain)
      expect(journal.history(chain.id)).toEqual(before[index])
    }
    journal.rebuild()
    const rebuilt = await (await fetch(`${base}?state=active&after=closed/`)).json()
    expect(rebuilt).toEqual(active)
    expect(journal.forPull('closed/repo', 16)).toEqual(quiescent[1])
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

it('pages a 10,000-event chain and 100 admitted chains without losing the current reason', async () => {
  const journal = behaviorChainJournal()
  let long = journal.append('history/repo#1', 'long-history-seed', 0, { type: 'chain.admitted', repository: 'history/repo', issue: 1,
    branch: 'poise/issue-1', author: 'author', reviewer: 'reviewer' })
  db.transaction(() => {
    for (let event = 0; event < 10_000; event++) long = journal.append(long.id, `checkpoint-${event}`, long.sequence,
      { type: 'chain.waiting', reason: `checkpoint ${event}` })
    for (let issue = 2; issue <= 100; issue++) journal.append(`history/repo#${issue}`, `history-seed-${issue}`, 0,
      { type: 'chain.admitted', repository: 'history/repo', issue, branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' })
    for (let issue = 1; issue <= 100; issue++) {
      const chain = journal.append(`aaa-closed/repo#${issue}`, `page-closed-seed-${issue}`, 0,
        { type: 'chain.admitted', repository: 'aaa-closed/repo', issue, branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' })
      journal.append(chain.id, `page-closed-observed-${issue}`, chain.sequence, { type: 'chain.observed', observation: {
        checkedAt: Date.now(), issue: { open: false }, existingPulls: [], pull: null,
        publication: { pull_number: null, state: null, merged: false, merge_sha: null } } })
    }
  })()
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  try {
    const first = await (await fetch(`${base}?state=active`)).json()
    expect(first.chains).toHaveLength(100)
    expect(first.next).toBe(first.chains.at(-1).id)
    const second = await (await fetch(`${base}?state=active&after=${encodeURIComponent(first.next)}`)).json()
    const ids = [...first.chains, ...second.chains].map((chain: { id: string }) => chain.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id: string) => id.startsWith('history/repo#'))).toHaveLength(100)
    expect(ids.some((id: string) => id.startsWith('aaa-closed/'))).toBe(false)
    expect(second.next).toBeNull()
    const history = await (await fetch(`${base}?id=${encodeURIComponent(long.id)}`)).json()
    expect(history.chain.waiting).toBe('checkpoint 9999')
    expect(history.events).toHaveLength(20)
    const more = await (await fetch(`${base}?id=${encodeURIComponent(long.id)}&after=${history.next}`)).json()
    expect(more.events).toHaveLength(20)
    expect(more.events[0].sequence).toBeGreaterThan(history.events.at(-1).sequence)
    const latest = await (await fetch(`${base}?id=${encodeURIComponent(long.id)}&after=${long.sequence - 1}`)).json()
    expect(latest.events).toHaveLength(1)
    expect(latest.events[0]).toMatchObject({ type: 'chain.waiting', reason: 'checkpoint 9999' })
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})
