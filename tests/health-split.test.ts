import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

// The health split runs in phase order in one file: a healthy ledger, then a
// wedged one, then a dead one, against a single server. Each phase leaves the
// ledger for the next; nothing here restarts the server itself.
const ledgerReads = vi.hoisted(() => ({ count: 0 }))
vi.mock('../server/behavior-ledger', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/behavior-ledger')>()
  const readBehaviorLedger = ((request: Parameters<typeof mod.readBehaviorLedger>[0]) => {
    ledgerReads.count++
    return mod.readBehaviorLedger(request)
  }) as typeof mod.readBehaviorLedger
  return { ...mod, readBehaviorLedger }
})

let root = ''
let staticDir = ''
let callerBin = ''
let server: Server | undefined
let baseUrl = ''
let ledger: typeof import('../server/behavior-ledger')
const auth = createAuthenticatedClaudeAuth()
const STUB = fileURLToPath(new URL('./fixtures/behavior-ledger-stub-worker.mjs', import.meta.url))

async function health(): Promise<{ status: number, body: any }> {
  const response = await fetch(`${baseUrl}/api/health`)
  return { status: response.status, body: await response.json() }
}

async function live(): Promise<{ status: number, body: any }> {
  const response = await fetch(`${baseUrl}/api/health/live`)
  return { status: response.status, body: await response.json() }
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-health-split-'))
  staticDir = join(root, 'assets', 'client')
  await mkdir(join(staticDir, 'assets'), { recursive: true })
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Poise test</title>')
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent')
  process.env.POISE_PRODUCTION_UPDATE_REPORT = join(root, 'production-update.json')
  callerBin = join(root, 'caller-bin')
  await Promise.all([mkdir(callerBin), mkdir(join(root, 'agent'))])
  for (const command of ['agent-interface', 'github-datastore', 'github-interface']) {
    const path = join(callerBin, command)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o700)
  }
  vi.stubEnv('CALLER_BIN_ROOT', callerBin)
  vi.resetModules()
  ledger = await import('../server/behavior-ledger')
  const production = await import('../server/production')
  const started = production.createProductionServer({ staticDir, claudeAuth: auth, reviewAgentUsername: 'bit-mis' })
  server = started
  await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve))
  const address = started.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
}, 120_000)

afterAll(async () => {
  const { stopBehaviorsRuntime } = await import('../server/behaviors')
  const { closeDatabase } = await import('../server/db')
  // If the dead-worker phase never ran, its stub would outlive the file.
  await writeFile(join(root, 'stub-exit'), 'exit').catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 300))
  await stopBehaviorsRuntime()
  const closing = server
  if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()))
  closeDatabase()
  for (const key of [
    'POISE_DB',
    'POISE_EDITOR_DIR',
    'POISE_CHAT_ATTACHMENTS_DIR',
    'POISE_ESPANSO_MATCH_DIR',
    'AGENT_INTERFACE_ROOT',
    'POISE_PRODUCTION_UPDATE_REPORT',
  ]) delete process.env[key]
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
}, 120_000)

describe('health split', () => {
  it('answers liveness from memory alone', async () => {
    const before = ledgerReads.count
    for (let i = 0; i < 5; i++) {
      const started = performance.now()
      const answer = await live()
      expect(performance.now() - started).toBeLessThan(250)
      expect(answer.status).toBe(200)
      expect(answer.body).toMatchObject({ status: 'ok', mode: 'local' })
      expect(typeof answer.body.uptimeMs).toBe('number')
      expect(answer.body.build).toHaveProperty('sha')
    }
    expect(ledgerReads.count).toBe(before)
  })

  it('reports dependencies and history without changing the health contract', async () => {
    const before = ledgerReads.count
    const answer = await health()
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({
      status: 'ok',
      scheduler: { status: 'ok' },
      liveness: { status: 'ok' },
      readiness: { status: 'ok', degraded: [] },
      dependencies: {
        ledger: { status: 'ok', reason: null },
        datastore: [{ org: null, status: 'unknown' }],
        githubQuota: [{ login: 'bit-mis', status: 'unknown', reason: 'no_observation' }],
        collectors: { status: 'ok' },
      },
    })
    expect(answer.body.history.ledger).toMatchObject({ dropped: 0, gaps: [] })
    // The release judge and the browser watcher read these as before.
    expect(answer.body.build).toHaveProperty('sha')
    expect(ledgerReads.count).toBe(before)
  })

  it('keeps historical loss in history while readiness stays ok', async () => {
    // An observation past the 4 KiB capture bound is lost without queueing.
    ledger.captureBehaviorAdmission({
      admissionKey: 'x'.repeat(5000), nativeId: 'oversized-admission', behavior: 'merge-prs',
      source: 'poise:merge-prs', owner: null, actor: null, repository: 'example/project', number: 1, head: null,
    })
    // The oversize admission only records unreported loss; without a further
    // capture nothing pumps its loss marker to the worker, so the test would
    // wait on the next minute-boundary heartbeat. Pump it explicitly.
    ledger.behaviorLedgerHeartbeat()
    let answer = await health()
    await waitFor('the loss marker to commit', async () => {
      answer = await health()
      return answer.body.history.ledger.dropped >= 1 && answer.body.dependencies.ledger.status === 'ok'
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({
      status: 'ok',
      readiness: { status: 'ok', degraded: [] },
      dependencies: { ledger: { status: 'ok' } },
    })
    expect(answer.body.history.ledger.dropped).toBeGreaterThanOrEqual(1)
  })

  it('marks a wedged ledger degraded while liveness and the status contract hold', async () => {
    await ledger.stopBehaviorLedger()
    vi.stubEnv('POISE_LEDGER_STUB_EXIT', join(root, 'stub-exit'))
    await ledger.startBehaviorLedger({ workerPath: STUB, stallTimeoutMs: 200 })
    for (let i = 0; i < 25; i++) ledger.behaviorLedgerHeartbeat()
    let answer = await health()
    await waitFor('the queue to outwait the stall budget', async () => {
      answer = await health()
      return answer.body.dependencies.ledger.status === 'degraded'
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({
      status: 'ok',
      scheduler: { status: 'ok' },
      liveness: { status: 'ok' },
      readiness: { status: 'degraded', degraded: ['ledger'] },
      dependencies: {
        ledger: { status: 'degraded', reason: 'queue_stalled', stallBudgetMs: 200 },
      },
    })
    expect(answer.body.dependencies.ledger.queueAgeMs).toBeGreaterThan(200)
    expect(answer.body.dependencies.ledger.pending).toBeGreaterThanOrEqual(25)
    expect(answer.body.build).toHaveProperty('sha')
    const liveAnswer = await live()
    expect(liveAnswer.status).toBe(200)
    expect(liveAnswer.body).toMatchObject({ status: 'ok' })
  }, 30_000)

  it('stays cheap with the ledger wedged: p95 under 250 ms, never waiting on the worker', async () => {
    const reads = async (path: string, samples: number): Promise<number[]> => {
      const durations: number[] = []
      for (let i = 0; i < samples; i++) {
        const started = performance.now()
        const response = await fetch(`${baseUrl}${path}`)
        const body = await response.json()
        durations.push(performance.now() - started)
        expect(response.status).toBe(200)
        if (path === '/api/health') {
          expect(body.dependencies.ledger).toMatchObject({ status: 'degraded', reason: 'queue_stalled' })
          expect(body.readiness).toMatchObject({ status: 'degraded' })
        } else {
          expect(body).toMatchObject({ status: 'ok' })
        }
      }
      return durations.sort((a, b) => a - b)
    }
    const before = ledgerReads.count
    const p95 = (durations: number[]): number => durations[Math.ceil(durations.length * 0.95) - 1]!
    expect(p95(await reads('/api/health/live', 50))).toBeLessThan(250)
    expect(p95(await reads('/api/health', 50))).toBeLessThan(250)
    // A single worker round trip would have taken 2 s and blown the bound;
    // the count proves the health path never queued one.
    expect(ledgerReads.count).toBe(before)
  }, 120_000)

  it('marks a dead ledger worker unavailable while liveness stays ok', async () => {
    await writeFile(join(root, 'stub-exit'), 'exit')
    let answer = await health()
    await waitFor('the observer to fail', async () => {
      answer = await health()
      return answer.body.dependencies.ledger.status === 'unavailable'
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({
      status: 'ok',
      scheduler: { status: 'ok' },
      liveness: { status: 'ok' },
      readiness: { status: 'degraded', degraded: ['ledger'] },
      dependencies: { ledger: { status: 'unavailable', reason: 'worker_unavailable' } },
    })
    const liveAnswer = await live()
    expect(liveAnswer.status).toBe(200)
    expect(liveAnswer.body).toMatchObject({ status: 'ok' })
  }, 30_000)
})
