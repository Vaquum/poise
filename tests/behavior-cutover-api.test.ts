import { createServer } from 'node:http'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { db, getMeta, setMeta, closeDatabase } from '../server/db'
import { behaviorChainJournal } from '../server/behavior-chain-journal'
import type { BehaviorChain, ChainEvent } from '../server/behavior-chain-store'
import { behaviorChainSummary, behaviorChainWorkImpact } from '../server/behavior-chain-summary'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { chainSummaryFixture, mergedReviewFixture, type MergedReviewCase } from './fixtures/behavior-chain-summary'
import { loggingWorkFixture } from './fixtures/logging-work-impact'
import { parseProcessDiagnostic } from '../server/process-diagnostic'
import { eventWords, readChain, readJournalPage, taskState, timelineLines } from '../src/ui/places/observe/chains'
import { readFrom } from '../src/ui/places/observe/journal'

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

it('projects confirmed merges without obsolete queue waits while retaining original evidence and refusing admission controls', async () => {
  const journal = behaviorChainJournal()
  const queueWait = 'native merge queue owns entry MQE_original'
  let pending = journal.append('api/repo#7', 'pending-seed', 0, { type: 'chain.admitted', repository: 'api/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  pending = journal.append(pending.id, 'pending-original', pending.sequence, { type: 'invocation.admitted', invocation: {
    id: 'pending-original', behavior: 'repair-pr', actor: pending.author, model: 'fixture', slot: 'primary', basis: 'original',
    admittedAt: Date.now(), request: { command: 'agent-interface', cwd: '/fixture', argv: [], nativeResources: 2 } } })
  pending = journal.append(pending.id, 'pending-uncertain', pending.sequence, { type: 'invocation.uncertain',
    invocationId: 'pending-original', reason: 'original response missing' })
  pending = journal.append(pending.id, 'pending-queue', pending.sequence, { type: 'chain.waiting', reason: queueWait })
  pending = journal.append(pending.id, 'pending-hold', pending.sequence, { type: 'chain.held', reason: 'original evidence missing' })
  let complete = journal.append('api/repo#8', 'complete-seed', 0, { type: 'chain.admitted', repository: 'api/repo', issue: 8,
    branch: 'poise/issue-8', author: 'author', reviewer: 'reviewer' })
  complete = journal.append(complete.id, 'complete-queue', complete.sequence, { type: 'chain.waiting', reason: queueWait })
  complete = journal.append(complete.id, 'complete-merge', complete.sequence, { type: 'chain.merged', mergeSha: 'b'.repeat(40),
    evidence: { repository: complete.repository, pull_number: 18, merged: true, merge_sha: 'b'.repeat(40) } })
  const historical = journal.history(complete.id)
  journal.rebuild()
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  const clearSharedLists = () => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  try {
    const queued = await (await fetch(`${base}?state=active`)).json()
    const queuedDetail = await (await fetch(`${base}?id=${encodeURIComponent(pending.id)}`)).json()
    expect(queued.chains).toEqual([expect.objectContaining({ id: pending.id, waiting: queueWait, mergeSha: null })])
    expect(queuedDetail.chain).toMatchObject({ waiting: queueWait, mergeSha: null })
    pending = journal.append(pending.id, 'pending-merge', pending.sequence, { type: 'chain.merged', mergeSha: 'a'.repeat(40),
      evidence: { repository: pending.repository, pull_number: 17, merged: true, merge_sha: 'a'.repeat(40), review_complete: false } })
    const before = journal.history(pending.id)
    await clearSharedLists()
    const active = await (await fetch(`${base}?state=active`)).json()
    expect(active.chains).toEqual([expect.objectContaining({ id: pending.id, waiting: null, mergeSha: 'a'.repeat(40), reviewPending: true })])
    expect(active.attention).toEqual([expect.objectContaining({ id: pending.id, nextAction:
      'Reconcile original pre-merge review evidence; no new invocation can start after merge' })])
    const merged = await (await fetch(`${base}?state=merged`)).json()
    expect(merged.chains).toEqual([expect.objectContaining({ id: complete.id, waiting: null, mergeSha: 'b'.repeat(40), reviewPending: null, reviewStatus: 'not-recorded' })])
    const historicalDetail = await (await fetch(`${base}?id=${encodeURIComponent(complete.id)}`)).json()
    expect(historicalDetail.chain).toEqual(merged.chains[0])
    expect(journal.read(complete.id)).not.toHaveProperty('reviewPending')
    const detail = await (await fetch(`${base}?id=${encodeURIComponent(pending.id)}`)).json()
    expect(detail.chain).toEqual(active.chains[0])
    expect(detail.chain).toMatchObject({ waiting: null, held: pending.held, reviewPending: true, reviewStatus: 'pending',
      reconciliation: { waitingForResourceRelease: true },
      invocations: [{ id: 'pending-original', state: 'uncertain', outcome: 'original response missing' }] })
    expect(detail.events).toContainEqual(expect.objectContaining({ type: 'chain.waiting', reason: queueWait }))
    expect(detail.chain.reviewPending).toBe(true)
    const pendingPage = readJournalPage(detail)
    const pendingMerge = pendingPage.events.find(event => event.type === 'chain.merged')!
    expect(pendingMerge.reviewComplete).toBe(false)
    expect(eventWords(pendingMerge, new Map()).text).toBe('Merged')
    expect(taskState(pendingPage.chain!)).toEqual({ state: 'waiting', reason: 'Merged as aaaaaaa · review evidence pending' })
    const legacy = await (await fetch(`${base}?id=${encodeURIComponent(complete.id)}`)).json()
    expect(legacy.events.at(-1).evidence).not.toHaveProperty('review_complete')
    const legacyPage = readJournalPage(legacy)
    expect(legacyPage.chain).toMatchObject({ reviewPending: null, reviewStatus: 'not-recorded' })
    expect(legacyPage.events.at(-1)).not.toHaveProperty('reviewComplete')
    expect(eventWords(legacyPage.events.at(-1)!, new Map()).text).toBe('Merged')
    const canonical = journal.read(pending.id)!
    expect(canonical).toEqual(pending)
    expect(detail.chain).toEqual(behaviorChainSummary(canonical, { at: journal.reconciliationAt(canonical) }))
    for (const operation of ['hold', 'resume']) {
      const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pending.id, sequence: pending.sequence, operation }) })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toContain('original receipt reconciliation only')
    }
    journal.rebuild()
    expect(journal.read(pending.id)).toEqual(pending)
    expect(journal.read(complete.id)).toEqual(complete)
    expect(journal.history(pending.id)).toEqual(before)
    expect(journal.history(complete.id)).toEqual(historical)
    complete = journal.append(complete.id, 'complete-review', complete.sequence, { type: 'chain.merged', mergeSha: complete.mergeSha!,
      evidence: { repository: complete.repository, pull_number: 18, merged: true, merge_sha: complete.mergeSha, review_complete: true } })
    const resourceWait = 'Invocation pending-original has contradictory resource-release evidence; ownership remains held'
    pending = journal.append(pending.id, 'pending-resource', pending.sequence, { type: 'chain.waiting', reason: resourceWait })
    const resources = journal.history(pending.id)
    await clearSharedLists()
    const resourceList = await (await fetch(`${base}?state=active`)).json()
    const resourceDetail = await (await fetch(`${base}?id=${encodeURIComponent(pending.id)}`)).json()
    expect(resourceDetail.chain).toEqual(resourceList.chains[0])
    expect(resourceDetail.chain).toMatchObject({ waiting: resourceWait, held: pending.held, reviewPending: true,
      reconciliation: detail.chain.reconciliation, invocations: detail.chain.invocations })
    const reviewedList = await (await fetch(`${base}?state=merged`)).json()
    const reviewedDetail = await (await fetch(`${base}?id=${encodeURIComponent(complete.id)}`)).json()
    expect(reviewedDetail.chain).toEqual(reviewedList.chains[0])
    expect(reviewedDetail.chain).toMatchObject({ waiting: null, reviewPending: false, reviewStatus: 'complete' })
    expect(journal.read(pending.id)).toEqual(pending)
    expect(journal.read(complete.id)).toEqual(complete)
    expect(journal.history(pending.id)).toEqual(resources)
    await clearSharedLists()
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

it('retains unmet native clearance on completed merged list/detail reads across expiry and rebuild, without rewriting receipts', async () => {
  const journal = behaviorChainJournal()
  const cases: MergedReviewCase[] = ['requested-changes', 'clean', 'native-approval', 'late-native-approval', 'late-review',
    'missing-basis', 'changed-context', 'changed-head', 'missing-panel', 'incomplete-panel']
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const chains = cases.map((mode, index) => mergedReviewFixture(journal, 1635 + index, mode))
  for (const [index, chain] of chains.entries()) {
    if (!['requested-changes', 'clean', 'native-approval', 'late-native-approval'].includes(cases[index])) continue
    const observation = chain.observation as ChainObservation
    expect(decideBehaviorChain(chain, observation, observation.checkedAt, {
      before: journal.preMergeObservation(chain.id, observation.pull!.mergedAt!) as ChainObservation | null,
      firstMerged: journal.firstMergedObservation(chain.id) as ChainObservation | null,
    })).toEqual({ kind: 'complete', mergeSha: 'c'.repeat(40) })
  }
  const history = db.prepare('SELECT * FROM behavior_chain_events ORDER BY sequence').all()
  journal.rebuild()
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  try {
    for (const time of [now + 10_001, now + 120_001]) {
      clock.mockReturnValue(time)
      const merged = await (await fetch(`${base}?state=merged`)).json()
      for (const [index, chain] of chains.entries()) {
        expect(journal.read(chain.id)).toEqual(chain)
        expect(merged.attention.map((entry: { id: string }) => entry.id)).not.toContain(chain.id)
        const listed = merged.chains.find((entry: { id: string }) => entry.id === chain.id)
        const detail = await (await fetch(`${base}?id=${encodeURIComponent(chain.id)}`)).json()
        expect(listed).toBeDefined()
        expect(detail.chain).toEqual(listed)
        expect(listed).toMatchObject({ mergeSha: 'c'.repeat(40), reviewPending: false, reviewStatus: 'complete', invocationCount: chain.invocations.length })
        expect(listed.invocations).toHaveLength(20)
        expect(listed.invocations.every((entry: { behavior: string }) => entry.behavior === 'repair-pr')).toBe(true)
        const warning = listed.mergedReviewWarning
        if (cases[index] === 'requested-changes' || cases[index] === 'late-native-approval') {
          expect(warning).toMatchObject({ head: 'a'.repeat(40), reviews: [{ id: 91, head: 'a'.repeat(40), submittedAt: now - 7000,
            verdict: 'Changes requested: retain the original native review clearance after merge.',
            url: `https://github.com/acme/repo/pull/${chain.issue + 1}#pullrequestreview-91` }],
          githubApproval: { id: 93, head: 'a'.repeat(40), submittedAt: now - 4000,
            url: `https://github.com/acme/repo/pull/${chain.issue + 1}#pullrequestreview-93`, client: 'unknown' } })
          expect(taskState(readChain(listed))).toEqual({ state: 'done', reason: 'Merged as ccccccc · native review clearance unmet' })
        } else expect(warning).toBeNull()
      }
    }
    journal.rebuild()
    expect(db.prepare('SELECT * FROM behavior_chain_events ORDER BY sequence').all()).toEqual(history)
    for (const chain of chains) expect(journal.read(chain.id)).toEqual(chain)
  } finally {
    await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    clock.mockRestore()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('retains the original failed native Call and diagnostic in list and History without rewriting uncertainty', async () => {
  const journal = behaviorChainJournal()
  const diagnostic = parseProcessDiagnostic({ version: 1, source: 'caller', severity: 'error', operation: 'merge_if_ready',
    phase: 'native_action', outcome: 'unknown', submission: 'uncertain', refusal: null,
    stderr: 'Queue response lost after possible submission', stderr_truncated: false })
  let chain = journal.append('api/failed#7', 'failed-seed', 0, { type: 'chain.admitted', repository: 'api/failed', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  chain = journal.append(chain.id, 'failed-admit', chain.sequence, { type: 'invocation.admitted', invocation: {
    id: 'failed-merge', behavior: 'merge-pr', actor: 'reviewer', model: null, slot: null, basis: 'original', admittedAt: Date.now(),
    request: { command: 'github-interface', cwd: '/isolated', argv: ['--merge-if-ready', '21'] } } })
  chain = journal.append(chain.id, 'failed-receipt', chain.sequence, { type: 'invocation.reconciled', invocationId: 'failed-merge',
    evidence: { nativeCallId: 'c'.repeat(32), diagnostic, artifact: { private: 'not returned' } } })
  chain = journal.append(chain.id, 'failed-uncertain', chain.sequence, { type: 'invocation.uncertain', invocationId: 'failed-merge', reason: 'original effect unknown' })
  const before = journal.history(chain.id)
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/behavior-chains?id=${encodeURIComponent(chain.id)}`)
    expect(response.status).toBe(200)
    const detail = await response.json()
    expect(detail.chain.invocations[0]).toMatchObject({ state: 'uncertain', callId: 'c'.repeat(32), evidence: { diagnostic } })
    expect(detail.events.find((event: { type: string }) => event.type === 'invocation.reconciled'))
      .toMatchObject({ callId: 'c'.repeat(32), evidence: { diagnostic } })
    expect(JSON.stringify(detail)).not.toContain('not returned')
    expect(journal.read(chain.id)!.invocations[0].callId).toBeNull()
    expect(journal.history(chain.id)).toEqual(before)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

it('excludes closed seeds only after PR, execution, resource and review obligations are settled', async () => {
  const journal = behaviorChainJournal()
  const record = (chain: BehaviorChain, event: ChainEvent) => journal.append(chain.id, `${chain.id}:${chain.sequence}`, chain.sequence, event)
  const closed = { checkedAt: Date.now(), issue: { open: false }, existingPulls: [], pull: null,
    publication: { pull_number: null, state: null, merged: false, merge_sha: null } }
  const closedPull = { ...closed, publication: { pull_number: 17, state: 'closed', merged: false, merge_sha: null },
    pull: { number: 17, state: 'closed', merged: false, mergeSha: null } }
  const closing = 'https://github.com/closed/repo/pull/1260'
  const externallyClosed = { ...closedPull, existingPulls: [closing],
    publication: { ...closedPull.publication, merge_sha: '307c8a031acceae31843add8e66d97ce93ef5e13' },
    externalMerge: { pull_number: 1260, merge_sha: 'd'.repeat(40) } }
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
      pull: { ...closedPull.pull, merged: true, mergeSha: 'd'.repeat(40) } }),
    seed(15, { ...externallyClosed, externalMerge: undefined }),
    seed(16, { ...externallyClosed, existingPulls: [closing, 'https://github.com/closed/repo/pull/1261'] }),
    seed(17, { ...externallyClosed, externalMerge: { pull_number: 1260 } })]
  for (const [index, state] of ['admitted', 'started', 'uncertain', 'settled'].entries()) {
    let chain = seed(20 + index, externallyClosed)
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
  let publication = seed(24, externallyClosed)
  publication = record(publication, { type: 'chain.resumed' })
  publication = record(publication, { type: 'invocation.admitted', invocation: { id: publication.id, behavior: 'publish-issue', basis: 'seed',
    actor: publication.author, model: null, slot: null, admittedAt: Date.now(),
    request: { command: 'github-interface', argv: ['--fixture'], cwd: '/fixture' } } })
  publication = record(publication, { type: 'invocation.settled', invocationId: publication.id, callId: 'b'.repeat(32),
    outcome: 'published', evidence: { publicationResume: { correlation: 'original-publication' } } })
  retained.push(publication)
  let pending = seed(30, externallyClosed)
  pending = record(pending, { type: 'chain.merged', mergeSha: 'd'.repeat(40), evidence: {
    repository: pending.repository, pull_number: 17, merged: true, merge_sha: 'd'.repeat(40), review_complete: false } })
  retained.push(pending)
  let held = journal.append('closed/repo#1251', 'competing-seed', 0, { type: 'chain.admitted', repository: 'closed/repo', issue: 1251,
    branch: 'poise/issue-1251', author: 'author', reviewer: 'reviewer' })
  for (const [index, behavior] of (['review-issue', 'implement-issue'] as const).entries()) {
    held = record(held, { type: 'invocation.admitted', invocation: { id: `competing-${index}`, behavior, basis: 'original',
      actor: index ? held.author : held.reviewer, model: 'fixture', slot: 'primary', admittedAt: Date.now(),
      request: { command: 'agent-interface', argv: ['--fixture'], cwd: '/fixture', nativeResources: 2 } } })
    held = record(held, { type: 'invocation.settled', invocationId: `competing-${index}`, callId: String(index + 1).repeat(32),
      outcome: 'completed', evidence: { status: 'completed', resources_settled_at: new Date().toISOString(),
        resource_ownership: { version: 1, roots: [], errors: [] } } })
  }
  const heldClosed = { ...externallyClosed, publication: { ...externallyClosed.publication, pull_number: 1259 },
    pull: { ...externallyClosed.pull, number: 1259 } }
  held = record(held, { type: 'chain.observed', observation: { ...heldClosed, issue: { open: true }, externalMerge: undefined } })
  held = record(held, { type: 'chain.held', reason: `seed issue already belongs to existing work: ${closing}` })
  expect(journal.page('closed/', 100, false)).toContainEqual(held)
  held = record(held, { type: 'chain.observed', observation: heldClosed })
  quiescent.push(held)
  const before = quiescent.map(chain => journal.history(chain.id))
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  // The API shares identical list reads for ten seconds; a rejected POST clears
  // that cache so this test reads fresh data and leaves none for the next.
  const clearSharedLists = () => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  try {
    await clearSharedLists()
    const active = await (await fetch(`${base}?state=active&after=closed/`)).json()
    expect(active.chains.map((chain: { id: string }) => chain.id).sort()).toEqual(retained.map(chain => chain.id).sort())
    const attention = (await (await fetch(`${base}?state=active`)).json()).attention.map((chain: { id: string }) => chain.id)
    for (const chain of quiescent) expect(attention).not.toContain(chain.id)
    const all = await (await fetch(`${base}?after=closed/`)).json()
    const merged = await (await fetch(`${base}?state=merged&after=closed/`)).json()
    for (const [index, chain] of quiescent.entries()) {
      expect(all.chains).toContainEqual(expect.objectContaining({ id: chain.id, mergeSha: null, reviewStatus: 'not-recorded' }))
      expect(merged.chains.map((row: { id: string }) => row.id)).not.toContain(chain.id)
      const detail = await (await fetch(`${base}?id=${encodeURIComponent(chain.id)}`)).json()
      expect(detail.chain).toEqual(behaviorChainSummary(chain, { at: journal.reconciliationAt(chain) }))
      expect(detail.events.map((event: { type: string }) => event.type)).toEqual(before[index].map(row => JSON.parse(row.payload).type))
      expect(journal.read(chain.id)).toEqual(chain)
      expect(journal.history(chain.id)).toEqual(before[index])
    }
    journal.rebuild()
    const rebuilt = await (await fetch(`${base}?state=active&after=closed/`)).json()
    expect(rebuilt).toEqual(active)
    expect(journal.forPull('closed/repo', 16)).toEqual(quiescent[1])
    expect(journal.forPull('closed/repo', 1259)).toEqual(held)
    expect(journal.forPull('closed/repo', 1260)).toBeNull()
    expect(journal.history(held.id)).toEqual(before.at(-1))
    expect((await (await fetch(`${base}?state=active`)).json()).attention.map((chain: { id: string }) => chain.id)).toEqual(attention)
    await clearSharedLists()
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

it('batches exact work-impact lookups through the existing classifier without changing journal evidence', async () => {
  const journal = behaviorChainJournal()
  const at = Date.now() - 10_000
  const call = '4'.repeat(32), correlation = '5'.repeat(32), other = '6'.repeat(32)
  const fixture = loggingWorkFixture(journal, 'api/impact', 7, correlation, call, at)
  const completed = loggingWorkFixture(journal, 'api/impact', 8, other, other, at)
  completed.append({ type: 'chain.merged', mergeSha: 'c'.repeat(40), evidence: { repository: 'api/impact', pull_number: 108,
    merged: true, merge_sha: 'c'.repeat(40), review_complete: true } }, at + 4000)
  const before = [journal.history(fixture.chain.id), journal.history(completed.chain.id)]
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  try {
    const params = new URLSearchParams({ batch: '1' })
    for (const [callId, correlationId] of [[call, correlation], ['', other], ['7'.repeat(32), ''], [call, other]]) {
      params.append('callId', callId); params.append('correlationId', correlationId)
    }
    const batchLookup = vi.spyOn(journal, 'forInvocations')
    const singleLookup = vi.spyOn(journal, 'forInvocation')
    const response = await fetch(`${base}?${params}`)
    expect(response.status).toBe(200)
    expect(batchLookup).toHaveBeenCalledTimes(1)
    expect(singleLookup).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({ impacts: [behaviorChainWorkImpact(journal, call, correlation),
      behaviorChainWorkImpact(journal, null, other), null, null] })
    const single = await (await fetch(`${base}?callId=${call}&correlationId=${correlation}`)).json()
    expect(single).toEqual({ impact: behaviorChainWorkImpact(journal, call, correlation) })
    for (const query of ['batch=1', `batch=1&callId=${call}`, 'batch=1&callId=&correlationId=',
      `batch=1&callId=${call}&correlationId=invalid`, `batch=invalid&callId=${call}`]) {
      expect((await fetch(`${base}?${query}`)).status).toBe(400)
    }
    const bounded = new URLSearchParams({ batch: '1' })
    for (let index = 0; index < 100; index++) {
      bounded.append('callId', index ? index.toString(16).padStart(32, '0') : call)
      bounded.append('correlationId', '')
    }
    const full = await fetch(`${base}?${bounded}`)
    expect(full.status).toBe(200)
    expect((await full.json()).impacts).toEqual([behaviorChainWorkImpact(journal, call, null), ...Array(99).fill(null)])
    bounded.append('callId', call); bounded.append('correlationId', '')
    expect((await fetch(`${base}?${bounded}`)).status).toBe(400)
    expect([journal.history(fixture.chain.id), journal.history(completed.chain.id)]).toEqual(before)
    const appendedId = '8'.repeat(32)
    fixture.append({ type: 'invocation.admitted', invocation: { ...fixture.chain.invocations[0], id: appendedId, admittedAt: at + 5000 } }, at + 5000)
    fixture.append({ type: 'invocation.reconciled', invocationId: appendedId,
      evidence: { nativeCallId: '7'.repeat(32), callId: '7'.repeat(32) } }, at + 6000)
    const withInvocation = await (await fetch(`${base}?${params}`)).json()
    expect(withInvocation.impacts[2]).toMatchObject({ invocationId: appendedId, stage: 'repair-pr: admitted' })
    expect(withInvocation.impacts[2]).toEqual(behaviorChainWorkImpact(journal, '7'.repeat(32), null))
    fixture.append({ type: 'chain.held', reason: 'independent hold' }, at + 7000)
    const afterAppend = journal.history(fixture.chain.id)
    const refreshed = await (await fetch(`${base}?${params}`)).json()
    expect(refreshed.impacts[0]).toMatchObject({ impact: 'blocked', nextAction: expect.stringContaining('independent hold') })
    expect(refreshed.impacts[0]).toEqual(behaviorChainWorkImpact(journal, call, correlation))
    expect([journal.history(fixture.chain.id), journal.history(completed.chain.id)]).toEqual([afterAppend, before[1]])
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

it('keeps merge confirmation and original review completion distinct across history pages and settlement links', async () => {
  const journal = behaviorChainJournal()
  const at = Date.now() - 60_000
  let chain = journal.append('api/history#1564', 'history-seed', 0, { type: 'chain.admitted', repository: 'api/history', issue: 1564,
    branch: 'poise/issue-1564', author: 'author', reviewer: 'reviewer' }, at)
  for (let index = 0; index < 18; index++) chain = journal.append(chain.id, `history-wait-${index}`, chain.sequence,
    { type: 'chain.waiting', reason: 'exact-head CI is still running' }, at + index + 1)
  const evidence = { repository: chain.repository, pull_number: 1565, merged: true, merge_sha: 'd'.repeat(40), callId: 'c'.repeat(32) }
  const merged = journal.append(chain.id, 'history-merge', chain.sequence, { type: 'chain.merged', mergeSha: evidence.merge_sha,
    evidence: { ...evidence, review_complete: false } }, at + 1000)
  chain = journal.append(chain.id, 'history-review-complete', merged.sequence, { type: 'chain.merged', mergeSha: evidence.merge_sha,
    evidence: { ...evidence, review_complete: true } }, at + 1324)
  const before = journal.history(chain.id)
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains?id=${encodeURIComponent(chain.id)}`
  const read = async (after: number) => {
    const response = await fetch(`${base}&after=${after}`)
    expect(response.status).toBe(200)
    return readJournalPage(await response.json())
  }
  try {
    const first = await read(0)
    expect(first.events).toHaveLength(20)
    expect(first.next).toBe(merged.sequence)
    expect(first.events.at(-1)).toMatchObject({ type: 'chain.merged', reviewComplete: false })
    // The latest summary already knows completion; the earlier event must still say Merged.
    expect(first.chain).toMatchObject({ mergeSha: evidence.merge_sha, reviewPending: false, reviewStatus: 'complete' })
    const second = await read(first.next!)
    expect(second.next).toBeNull()
    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({ type: 'chain.merged', reviewComplete: true })
    const lines = timelineLines([...first.events, ...second.events], null).filter(line => line.event.type === 'chain.merged')
    expect(lines.map(({ event, folded }) => ({ sequence: event.sequence, at: event.at, folded, ...eventWords(event, new Map()) }))).toEqual([
      { sequence: chain.sequence, at: at + 1324, folded: 1, kind: 'event', text: 'Original review evidence complete', call: evidence.callId },
      { sequence: merged.sequence, at: at + 1000, folded: 1, kind: 'event', text: 'Merged', call: evidence.callId },
    ])
    const linked = await readFrom(read, merged.sequence)
    expect(linked.events).toEqual(second.events)
    expect(eventWords(linked.events[0], new Map()).text).toBe('Original review evidence complete')
    expect(journal.history(chain.id)).toEqual(before)
    expect(journal.read(chain.id)).toEqual(chain)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
