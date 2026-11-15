import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DiagnosticStore } from '../gateway/src/diagnostics/store'
import { normalize, type LogEvent } from '../gateway/src/diagnostics/contract'
import { callerDiagnostic } from '../gateway/src/diagnostics/sources'
import type { LoggingPage } from '../gateway/src/diagnostics/query-contract'
import { startHarness, workspaceHost, type Harness } from '../gateway/tests/harness'
import { db, closeDatabase } from '../server/db'
import { behaviorChainJournal } from '../server/behavior-chain-journal'
import { verifiedLoggingHandoffs } from '../server/logging-handoff'
import { enforceApiRequest } from '../server/http'
import { readServiceConfig } from '../server/service/config'
import { legacyHandoffFixture, reviewHandoffFixture } from './fixtures/logging-review-handoff'

const location = vi.hoisted(() => ({ path: '' }))
vi.mock('../server/logging', async original => ({ ...await original<typeof import('../server/logging')>(),
  loggingPath: () => location.path, loggingWorkspace: () => 'local' }))
vi.mock('../server/behaviors', () => ({ getBehaviorChainRuntimeHealth: () => [], getBehaviorChainCapacity: () => ({}) }))
const { localLogging, stopLoggingApi } = await import('../server/logging-api')
const { handleBehaviorChains } = await import('../server/behavior-chain-api')
const journal = behaviorChainJournal()
let directory: string
let h: Harness | undefined
let guard: ReturnType<typeof readServiceConfig> = null
const server = createServer((req, res) => {
  try {
    // The test transport is loopback; exercise the actual service policy as
    // the private gateway peer when it forwards its browser assertion.
    const checked = Object.create(req) as IncomingMessage
    Object.defineProperty(checked, 'socket', { value: { remoteAddress: guard ? '172.18.0.2' : '127.0.0.1' } })
    enforceApiRequest(checked, { service: guard })
    if (req.url?.startsWith('/api/behavior-chains')) void handleBehaviorChains(req, res, req.url)
    else void localLogging(req, res)
  } catch { res.writeHead(403); res.end() }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('server did not bind')
const port = address.port
const base = `http://127.0.0.1:${port}`

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'logging-severity-'))
  location.path = join(directory, 'logging.db')
  guard = null
})
afterEach(async () => {
  await h?.close(); h = undefined
  await stopLoggingApi()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  closeDatabase()
})

function retain(events: LogEvent[], path = location.path) {
  const store = new DiagnosticStore(path)
  try { store.append(events) } finally { store.close() }
}

it.each(['local', 'service'] as const)('classifies before both severity queries, totals, pages and resumed export through the %s routes', async mode => {
  const workspace = mode === 'local' ? 'local' : 'alice'
  const review = reviewHandoffFixture(journal, 'review-pr', workspace)
  const approval = reviewHandoffFixture(journal, 'approve-pr', workspace)
  expect(review.original.request.context).toBeUndefined()
  expect(approval.original.request.context).toBeUndefined()
  for (const fixture of [review, approval]) fixture.append({ type: 'invocation.admitted', invocation: fixture.successor }, fixture.at + 6000)
  const legacy = legacyHandoffFixture(db, workspace)
  const missing = reviewHandoffFixture(journal, 'review-pr', workspace)
  const failed = reviewHandoffFixture(journal, 'approve-pr', workspace)
  failed.append({ type: 'invocation.admitted', invocation: failed.successor }, failed.at + 6000)
  failed.append({ type: 'invocation.settled', invocationId: failed.successor.id, callId: 'f'.repeat(32), outcome: 'review_recovery_failed',
    evidence: { status: 'failed', error_code: 'review_recovery_failed', completedAt: failed.at + 7000 } }, failed.at + 7000)
  // These historical receipts have no typed no-submission evidence. Provider
  // wording and a later verdict cannot promote any of them to Warning.
  const historical = Array.from({ length: 4 }, (_, index) => normalize(callerDiagnostic({ ...missing.row,
    id: (90000 + index).toString(16).padStart(32, '0'), diagnostic: null }, workspace)!)!)
  const warnings = [review.event, approval.event, legacy.event]
  const errors = [missing.event, failed.event, ...historical]
  const foreign = normalize({ id: 'private', level: 'error', source: 'caller', operation: 'call.failed', workspace: 'bob', message: 'foreign private cause' })!
  let request: (suffix: string) => Promise<{ status: number; text: string }>
  if (mode === 'service') {
    h = await startHarness()
    const cookie = (await h.openWorkspace('Alice')).workspaceCookie
    guard = readServiceConfig({ POISE_MODE: 'service', POISE_WORKSPACE_HANDLE: 'alice', POISE_WORKSPACE_OWNER: 'Alice',
      POISE_PUBLIC_ORIGIN: 'https://' + workspaceHost('alice'), POISE_GATEWAY_PUBLIC_KEY: h.keys.publicKeyBase64 })
    vi.spyOn(h.context.deps, 'upstream').mockReturnValue({ host: '127.0.0.1', port })
    retain([...warnings, ...errors, foreign], join(h.config.dataDir, 'logging.db'))
    request = async suffix => {
      const reply = await h!.request({ host: workspaceHost('alice'), path: '/_poise/api/logging' + suffix,
        headers: { cookie, 'sec-fetch-site': 'same-origin' } })
      return { status: reply.status, text: reply.body }
    }
    expect((await h.request({ host: workspaceHost('alice'), path: '/_poise/api/logging', headers: {} })).status).toBe(401)
  } else {
    retain([...warnings, ...errors, foreign])
    request = async suffix => { const reply = await fetch(base + '/api/logging' + suffix); return { status: reply.status, text: await reply.text() } }
  }
  const page = async (suffix: string): Promise<LoggingPage> => {
    const response = await request(suffix)
    expect(response.status, response.text).toBe(200)
    expect(response.text).not.toContain('foreign private cause')
    return JSON.parse(response.text) as LoggingPage
  }
  const prior = new Map<string, { cursor: string; exportCursor: string; watermark: string }>()
  for (const [severity, expected] of [['warning', warnings], ['error', errors]] as const) {
    const query = '?severity=' + severity + '&limit=2'
    const first = await page(query)
    expect(first.total).toBe(expected.length)
    expect(first.events.every(event => event.severity === severity && event.sourceLevel === 'error')).toBe(true)
    const found = [...first.events]
    let cursor = first.nextCursor
    while (cursor) {
      const next = await page(query + '&cursor=' + encodeURIComponent(cursor))
      expect(next.total).toBe(expected.length)
      found.push(...next.events); cursor = next.nextCursor
    }
    expect(found.map(event => event.id).sort()).toEqual(expected.map(event => event.id).sort())
    let exportCursor: string | null = null
    const exported: LogEvent[] = []
    let firstExportCursor = ''
    do {
      const response = await request('/export' + query + (exportCursor ? '&cursor=' + encodeURIComponent(exportCursor) : ''))
      expect(response.status, response.text).toBe(200)
      const [metadata, ...lines] = response.text.trim().split('\n').map(line => JSON.parse(line))
      expect(metadata.total).toBe(expected.length)
      expect(metadata.exported).toBe(lines.length)
      exported.push(...lines.map(line => line.event as LogEvent))
      exportCursor = metadata.resumeCursor
      firstExportCursor ||= exportCursor ?? ''
    } while (exportCursor)
    expect(exported.map(event => event.id).sort()).toEqual(expected.map(event => event.id).sort())
    expect(exported.every(event => event.severity === severity && event.sourceLevel === 'error')).toBe(true)
    prior.set(severity, { cursor: first.nextCursor!, exportCursor: firstExportCursor, watermark: first.watermark })
  }
  const detail = await request('/events/' + review.event.id)
  expect(JSON.parse(detail.text).event).toMatchObject({ severity: 'warning', sourceLevel: 'error' })
  // Reclassification, without another diagnostic ingestion, invalidates both
  // page and export continuations in each severity query.
  review.append({ type: 'chain.held', reason: 'recovery exhausted' }, review.at + 7000)
  for (const severity of ['error', 'warning']) {
    const snapshot = prior.get(severity)!
    for (const suffix of [
      `?severity=${severity}&limit=2&cursor=${encodeURIComponent(snapshot.cursor)}`,
      `/export?severity=${severity}&limit=2&cursor=${encodeURIComponent(snapshot.exportCursor)}`,
      `?severity=${severity}&after=${encodeURIComponent(snapshot.watermark)}`,
    ]) {
      const stale = await request(suffix)
      expect(stale.status, stale.text).toBe(400)
      expect(stale.text).toContain('Refresh')
    }
  }
  expect((await page('?severity=warning')).total).toBe(warnings.length - 1)
  expect((await page('?severity=error')).total).toBe(errors.length + 1)
  const beforeSuccessor = await Promise.all(['error', 'warning'].map(async severity => ({ severity,
    page: await page(`?severity=${severity}&limit=1`) })))
  missing.append({ type: 'invocation.admitted', invocation: missing.successor }, missing.at + 6000)
  for (const snapshot of beforeSuccessor) {
    const stale = await request(`?severity=${snapshot.severity}&limit=1&cursor=${encodeURIComponent(snapshot.page.nextCursor!)}`)
    expect(stale.status, stale.text).toBe(400)
    expect(stale.text).toContain('Refresh')
  }
  expect((await page('?severity=warning')).total).toBe(warnings.length)
  expect((await page('?severity=error')).total).toBe(errors.length)
  const retained = new DiagnosticStore(mode === 'service' ? join(h!.config.dataDir, 'logging.db') : location.path)
  try { expect(retained.lookup({ workspace, operator: false }, review.event.id)).toMatchObject({ event: review.event }) }
  finally { retained.close() }
  if (h) {
    vi.spyOn(h.context.deps, 'upstream').mockReturnValue({ host: '127.0.0.1', port: 1 })
    expect((await page('?severity=warning')).total).toBe(0)
    expect((await page('?severity=error')).total).toBe(warnings.length + errors.length)
  }
})

it.each(['review-pr', 'approve-pr'] as const)('rejects conflicting admission heads and unrelated successors for %s', behavior => {
  for (const change of ['head', 'duplicate head', 'context head', 'slot', 'basis', 'target', 'actor', 'diagnostic head', 'completed head']) {
    const fixture = reviewHandoffFixture(journal, behavior)
    const successor = structuredClone(fixture.successor)
    if (change === 'head') successor.request.argv[successor.request.argv.indexOf('--expected-head') + 1] = 'c'.repeat(40)
    if (change === 'duplicate head') successor.request.argv.push('--expected-head', 'c'.repeat(40))
    if (change === 'context head') successor.request.context = { head: 'c'.repeat(40), reviewRevision: 'review' }
    if (change === 'slot') successor.slot = 'secondary'
    if (change === 'basis') successor.basis = 'another context'
    if (change === 'target') successor.request.argv[1] += '0'
    if (change === 'actor') successor.actor = 'another-reviewer'
    if (change === 'diagnostic head') fixture.candidate.head = 'c'.repeat(40)
    fixture.append({ type: 'invocation.admitted', invocation: successor }, fixture.at + 6000)
    if (change === 'completed head') fixture.append({ type: 'invocation.settled', invocationId: successor.id, callId: 'c'.repeat(32), outcome: 'reviewed_clean',
      evidence: { status: 'completed', head_sha: 'c'.repeat(40), completedAt: fixture.at + 7000 } }, fixture.at + 7000)
    expect(verifiedLoggingHandoffs([fixture.candidate], journal, db), change).toEqual([])
  }
})

it('requires an exact legacy approval target/context across separate fallback firings', () => {
  const fixture = legacyHandoffFixture(db)
  expect(verifiedLoggingHandoffs([fixture.candidate], journal, db)).toEqual([fixture.event.id])
  db.prepare("UPDATE behavior_seen SET target=target || '0' WHERE key='approve-prs' AND target=?").run(fixture.target)
  expect(verifiedLoggingHandoffs([fixture.candidate], journal, db)).toEqual([])
})

it.each(['review-pr', 'approve-pr'] as const)('retains a verified %s recovery, while refusing an uncertain successor', behavior => {
  const fixture = reviewHandoffFixture(journal, behavior)
  const { append, successor, observation, at } = fixture
  append({ type: 'invocation.admitted', invocation: successor }, at + 6000)
  const callId = fixture.successor.id.slice(0, 31) + 'f'
  const response = { repository: 'acme/repo', pull_number: observation.pull!.number, head_sha: observation.pull!.head,
    context_sha: observation.pull!.reviewContext, invocation_id: callId, reviewer: successor.actor,
    model: successor.model, completed_at: at + 8000, coverage: 'complete',
    assessment: { verdict: 'The changed validation has no remaining blocking defects.',
      reviewed_context: 'Inspected the immutable diff and affected callers.', limitations: 'No live provider calls.' } }
  const action = behavior === 'approve-pr' ? 'approved' : 'reviewed_clean'
  append({ type: 'invocation.settled', invocationId: successor.id, callId, outcome: action,
    evidence: { status: 'completed', action, head_sha: response.head_sha, review_id: 91,
      artifact: { review_response: response }, completedAt: at + 8000 } }, at + 8000)
  expect(verifiedLoggingHandoffs([fixture.candidate], journal, db)).toEqual([])
  append({ type: 'chain.observed', observation: { ...observation, checkedAt: at + 9000,
    pull: { ...observation.pull!, reviewIds: [91], reviewReceipts: [{ id: 91, head: response.head_sha,
      invocation: callId, state: behavior === 'approve-pr' ? 'APPROVED' : 'COMMENTED', response, submittedAt: at + 8000 }] } } }, at + 9000)
  expect(verifiedLoggingHandoffs([fixture.candidate], journal, db)).toEqual([fixture.event.id])
  append({ type: 'chain.held', reason: 'current recovery exhausted' }, at + 10000)
  expect(verifiedLoggingHandoffs([fixture.candidate], journal, db)).toEqual([])
  const uncertain = reviewHandoffFixture(journal, behavior)
  uncertain.append({ type: 'invocation.admitted', invocation: uncertain.successor }, uncertain.at + 6000)
  uncertain.append({ type: 'invocation.uncertain', invocationId: uncertain.successor.id, reason: 'publication uncertain' }, uncertain.at + 7000)
  expect(verifiedLoggingHandoffs([uncertain.candidate], journal, db)).toEqual([])
})

it.each(['review-pr', 'approve-pr'] as const)('keeps a verified %s recovery after the PR head moves on', behavior => {
  const fixture = reviewHandoffFixture(journal, behavior)
  const { append, successor, observation, at } = fixture
  append({ type: 'invocation.admitted', invocation: successor }, at + 6000)
  const callId = fixture.successor.id.slice(0, 31) + 'f'
  const response = { repository: 'acme/repo', pull_number: observation.pull!.number, head_sha: observation.pull!.head,
    context_sha: observation.pull!.reviewContext, invocation_id: callId, reviewer: successor.actor,
    model: successor.model, completed_at: at + 8000, coverage: 'complete',
    assessment: { verdict: 'The changed validation has no remaining blocking defects.',
      reviewed_context: 'Inspected the immutable diff and affected callers.', limitations: 'No live provider calls.' } }
  const action = behavior === 'approve-pr' ? 'approved' : 'reviewed_clean'
  append({ type: 'invocation.settled', invocationId: successor.id, callId, outcome: action,
    evidence: { status: 'completed', action, head_sha: response.head_sha, review_id: 91,
      artifact: { review_response: response }, completedAt: at + 8000 } }, at + 8000)
  const receipts = [{ id: 91, head: response.head_sha,
    invocation: callId, state: behavior === 'approve-pr' ? 'APPROVED' : 'COMMENTED', response, submittedAt: at + 8000 }]
  append({ type: 'chain.observed', observation: { ...observation, checkedAt: at + 9000,
    pull: { ...observation.pull!, reviewIds: [91], reviewReceipts: receipts } } }, at + 9000)
  expect(verifiedLoggingHandoffs([fixture.candidate], journal, db)).toEqual([fixture.event.id])
  // The PR moves on: new head, new review context. The historical recovery stands.
  append({ type: 'chain.observed', observation: { ...observation, checkedAt: at + 12000,
    pull: { ...observation.pull!, head: 'c'.repeat(40), reviewContext: 'd'.repeat(64),
      reviewIds: [91], reviewReceipts: receipts } } }, at + 12000)
  expect(verifiedLoggingHandoffs([fixture.candidate], journal, db)).toEqual([fixture.event.id])
})

it.each(['submitting', 'no submission proof', 'contradictory identity', 'submitted action'] as const)('keeps %s at source Error', change => {
  const fixture = reviewHandoffFixture(journal)
  fixture.append({ type: 'invocation.admitted', invocation: fixture.successor }, fixture.at + 6000)
  const row = structuredClone(fixture.row)
  if (change === 'submitting') Object.assign(row.diagnostic, { phase: 'submitting', outcome: 'timed_out', submission: 'uncertain' })
  if (change === 'no submission proof') row.diagnostic.submission = ''
  if (change === 'contradictory identity') row.diagnostic.call_id = 'e'.repeat(32)
  const event = normalize(callerDiagnostic({ ...row, ...(change === 'submitted action' ? { action: 'approved', outcome: 'approved' } : {}) }, 'local')!)!
  retain([event])
  const store = new DiagnosticStore(location.path)
  try { expect(store.handoffs({ workspace: 'local', operator: false }).candidates).toEqual([]) }
  finally { store.close() }
})
