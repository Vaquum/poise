import { createServer } from 'node:http'
import { afterAll, expect, it, vi } from 'vitest'
import { closeDatabase, db } from '../server/db'
import { behaviorChainJournal } from '../server/behavior-chain-journal'
import { bindWork } from '../server/chat/control-store'
import '../server/chat/storage'
import { chainBasis } from '../server/behavior-chain-store'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'

vi.mock('../server/native-cleanup-support', () => ({
  nativeCleanupSupport: () => ({ status: 'supported', error: null }),
  requireNativeCleanup: async () => {},
}))
vi.mock('../server/behaviors', () => ({ getBehaviorChainRuntimeHealth: () => [],
  getBehaviorChainCapacity: () => ({ status: 'available', reservedModelInvocations: 0, modelInvocationLimit: 3,
    enabled: false, intake: { seedMode: 'label', label: 'poise' } }) }))
const { handleBehaviorChains } = await import('../server/behavior-chain-api')
afterAll(() => closeDatabase())

it('uses a fresh linked PR and its bound Chat without changing the held chain or its next work decision', async () => {
  const now = 2_000_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const journal = behaviorChainJournal()
  const repository = 'fixture/ownership'
  const issue = 7
  const id = repository + '#' + issue
  const pull = 'https://github.com/fixture/ownership/pull/22'
  const session = 'existing-owner'
  const instance = 'test-workspace'
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const observation: ChainObservation = { checkedAt: now, issue: { open: true, eligible: true, revision: 'seed', commentIds: [] },
    issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer, existingPulls: [],
    publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null }, pull: null }
  let chain = journal.append(id, 'owner-seed', 0, { type: 'chain.admitted', repository, issue,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, now)
  chain = journal.append(id, 'owner-hold', chain.sequence, { type: 'chain.held', reason: 'Required validation is unresolved' }, now)
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/', instance) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const read = async () => {
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/behavior-chains?state=active')
    const payload = await response.json()
    expect(response.status, payload.error).toBe(200)
    return payload.attention.find((entry: { id: string }) => entry.id === id)
  }
  try {
    expect((await read()).nudge).toMatchObject({ kind: 'unknown', work: null })
    clock.mockReturnValue(now + 10_000)
    const linked = { ...observation, checkedAt: Date.now(), existingPulls: [pull] }
    chain = journal.append(id, 'owner-pr', chain.sequence, { type: 'chain.observed', observation: linked }, Date.now())
    const before = journal.history(id)
    const hash = chainBasis(chain)
    const decision = decideBehaviorChain(chain, linked, Date.now())
    expect(decision).toMatchObject({ kind: 'wait', reason: chain.held })
    expect((await read()).nudge.work).toEqual({ kind: 'pull', url: pull })

    const stamp = new Date(now).toISOString()
    db.prepare(`INSERT INTO chat_sessions(id, record, agent, repo, checkout, branch, status, title, instance, created_at, updated_at)
      VALUES (?, '{}', 'fixture', ?, '/isolated', 'has-pr', 'idle', 'Existing owner', ?, ?, ?)`).run(session, repository, instance, stamp, stamp)
    bindWork(instance, session, pull)
    clock.mockReturnValue(now + 20_000)
    expect((await read()).nudge.work).toEqual({ kind: 'chat', session, manager: false })
    expect(chainBasis(journal.read(id))).toBe(hash)
    expect(journal.history(id)).toEqual(before)
    expect(decideBehaviorChain(journal.read(id)!, linked, Date.now())).toEqual(decision)
    expect(journal.read(id)!.invocations).toEqual([])

    clock.mockReturnValue(now + 150_000)
    expect((await read()).nudge.work).toBeNull()
  } finally {
    clock.mockRestore()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('shares a list read’s chains and attention between identical reads for a few seconds, and a change clears them', async () => {
  const journal = behaviorChainJournal()
  const pages = vi.spyOn(journal, 'page')
  const clock = vi.spyOn(Date, 'now')
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  try {
    clock.mockReturnValue(1_000_000)
    const first = await (await fetch(`${base}?state=active`)).json()
    const computed = pages.mock.calls.length
    expect(computed).toBeGreaterThan(0)
    expect(first).toHaveProperty('attention')
    // Within the window: the same read, and a read of another state, compute no attention again.
    clock.mockReturnValue(1_009_000)
    expect(await (await fetch(`${base}?state=active`)).json()).toEqual(first)
    expect(pages.mock.calls.length).toBe(computed)
    await (await fetch(base)).json()
    expect(pages.mock.calls.length).toBe(computed + 1)
    // Past the window it is computed afresh.
    clock.mockReturnValue(1_010_000)
    await (await fetch(`${base}?state=active`)).json()
    expect(pages.mock.calls.length).toBeGreaterThan(computed + 1)
    // A change made through the API clears it at once, even within the window.
    const settled = pages.mock.calls.length
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'hold' }) })
    expect(response.status).toBe(400)
    await (await fetch(`${base}?state=active`)).json()
    expect(pages.mock.calls.length).toBeGreaterThan(settled)
    // Any state value reads as one of the three it can mean, and windows that ended are dropped.
    const before = pages.mock.calls.length
    for (const state of ['x', 'y', 'z']) await (await fetch(`${base}?state=${state}`)).json()
    expect(pages.mock.calls.length).toBe(before + 1)
  } finally {
    clock.mockRestore()
    pages.mockRestore()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('clears what was shared after a change is made, so a read made meanwhile never outlasts it', async () => {
  const journal = behaviorChainJournal()
  const pages = vi.spyOn(journal, 'page')
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  try {
    // A change whose body arrives slowly; a list read lands while it waits.
    const http = await import('node:http')
    const slow = new Promise<number>((resolve, reject) => {
      const request = http.request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => { response.resume(); resolve(response.statusCode ?? 0) })
      request.on('error', reject)
      request.write('{"operation":"hold"')
      setTimeout(() => request.end('}'), 300)
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await (await fetch(`${base}?state=active`)).json()
    expect(await slow).toBe(400)
    const counted = pages.mock.calls.length
    await (await fetch(`${base}?state=active`)).json()
    expect(pages.mock.calls.length).toBeGreaterThan(counted)
  } finally {
    pages.mockRestore()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
