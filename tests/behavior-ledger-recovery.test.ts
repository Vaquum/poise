import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { BehaviorLedgerObserver, type BehaviorLedgerSnapshot } from '../server/behavior-ledger'
import { runBehaviorLedgerCli } from '../server/behavior-ledger-cli'
import { BehaviorLedgerStore } from '../server/behavior-ledger-store'
import { ledgerHistory } from '../server/health'
import type { LedgerAdmission, LedgerHealth } from '../server/behavior-ledger-contract'

const execute = promisify(execFile)
const roots: string[] = []
const stores: BehaviorLedgerStore[] = []
const observers: BehaviorLedgerObserver[] = []
const asyncRoots: string[] = []
let clock = Date.parse('2026-10-19T00:00:00.000Z')
const head = 'a'.repeat(40)
const stamp = () => new Date(clock).toISOString()
function store(path?: string): BehaviorLedgerStore {
  if (!path) {
    const root = mkdtempSync(join(tmpdir(), 'poise-ledger-recovery-'))
    roots.push(root)
    path = join(root, 'behavior-ledger.db')
  }
  const value = new BehaviorLedgerStore(path, {}, () => clock)
  stores.push(value)
  return value
}
function admission(nativeId = 'claim-1', extra: Partial<LedgerAdmission> = {}): LedgerAdmission {
  return { type: 'admit', nativeId, admissionKey: `native-panel:${nativeId}`, behavior: 'review-new-prs', source: 'poise:review-new-prs',
    owner: 'acme', actor: 'review-bot', repository: 'acme/project', number: 7, head,
    slot: 'primary', plannedSlots: ['primary'], startedAt: stamp(), ...extra }
}
/** Crash the epoch without touching the store: the next open must treat it as unclean. */
function crash(path: string): void {
  const journal = JSON.parse(readFileSync(path + '.coverage.json', 'utf8')) as { closed: boolean }
  journal.closed = false
  writeFileSync(path + '.coverage.json', JSON.stringify(journal))
}

afterEach(async () => {
  await Promise.all(observers.splice(0).map(async (observer) => {
    await observer.stop()
    await observer.waitForExit()
  }))
  await Promise.all(asyncRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  for (const db of stores.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  clock = Date.parse('2026-10-19T00:00:00.000Z')
})

function oversized(nativeId: string): LedgerAdmission {
  return admission(nativeId, { admissionKey: nativeId + '-key-' + 'x'.repeat(4097) })
}

const fixtureHealth = `const health=${JSON.stringify({ status: 'ok', unavailableReason: null, coverageStart: null,
  observedAt: new Date().toISOString(), callerObservedAt: null, pending: 0, dropped: 0, gaps: [], detailFloor: null,
  generation: 'fixture', retainedFrom: null, changeLowerBound: 0, lastSequence: 0, instances: 0, changes: 0 })};`
async function fixtureObserver(body: string): Promise<{ observer: BehaviorLedgerObserver, directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-recovery-'))
  asyncRoots.push(directory)
  await writeFile(join(directory, 'worker.mjs'),
    `import { parentPort as port } from 'node:worker_threads';\nimport { appendFileSync, existsSync, watch } from 'node:fs';\n${fixtureHealth}\n${body}`)
  const observer = new BehaviorLedgerObserver({ workerPath: join(directory, 'worker.mjs') })
  observers.push(observer)
  await observer.start()
  return { observer, directory }
}

describe('ledger recovery boundaries', () => {
  it('keeps two restart gaps separate across a healthy capture with checkpoint endpoints', () => {
    const db = store()
    db.capture(admission())
    const checkpoint = stamp()
    const path = db.path
    db.close()
    crash(path)
    clock = Date.parse('2026-10-19T01:00:00.000Z')
    const reopened = store(path)
    clock = Date.parse('2026-10-19T02:00:00.000Z')
    reopened.capture(admission('claim-2'))
    const recovery = stamp()
    reopened.close()
    crash(path)
    clock = Date.parse('2026-10-19T03:00:00.000Z')
    const third = store(path)
    expect(third.health()).toMatchObject({ status: 'incomplete', dropped: 0, detailFloor: null })
    expect(third.health().gaps).toEqual([
      { since: checkpoint, until: '2026-10-19T01:00:00.000Z', reason: 'unclean_restart' },
      { since: recovery, until: '2026-10-19T03:00:00.000Z', reason: 'unclean_restart' },
    ])
  })

  it('preserves recovery by event order when a capture lands on the old gap endpoint', () => {
    const db = store()
    db.loss(1)
    db.capture(admission())
    db.loss(1)
    expect(db.health()).toMatchObject({ dropped: 2 })
    expect(db.health().gaps).toEqual([
      { since: stamp(), until: stamp(), reason: 'capture_loss' },
      { since: stamp(), until: stamp(), reason: 'capture_loss' },
    ])
  })

  it('merges consecutive losses without an observed recovery between them', () => {
    const db = store()
    clock += 60_000
    db.capture({ type: 'loss', count: 1, since: '2026-10-19T00:00:30.000Z' })
    clock += 60_000
    db.capture({ type: 'loss', count: 2 })
    expect(db.health()).toMatchObject({ dropped: 3 })
    expect(db.health().gaps).toEqual([
      { since: '2026-10-19T00:00:30.000Z', until: '2026-10-19T00:02:00.000Z', reason: 'capture_loss' },
    ])
  })

  it('leaves restart uncertainty open across failed initialization and closes it at recovery', () => {
    const db = store()
    db.capture(admission())
    clock += 30 * 60_000
    db.loss(1)
    const path = db.path
    db.close()
    crash(path)
    clock = Date.parse('2026-10-19T01:00:00.000Z')
    rmSync(path)
    mkdirSync(path)
    const down = store(path)
    expect(down.health()).toMatchObject({ status: 'unavailable', unavailableReason: 'store_unavailable' })
    expect(down.health().gaps).toEqual([
      { since: '2026-10-19T00:30:00.000Z', until: '2026-10-19T00:30:00.000Z', reason: 'capture_loss' },
      { since: '2026-10-19T00:30:00.000Z', until: null, reason: 'unclean_restart' },
    ])
    const journal = JSON.parse(readFileSync(path + '.coverage.json', 'utf8')) as { health: LedgerHealth }
    expect(journal.health.gaps.at(-1)).toMatchObject({ reason: 'unclean_restart', until: null })
    rmdirSync(path)
    clock = Date.parse('2026-10-19T03:00:00.000Z')
    expect(down.health()).toMatchObject({ status: 'incomplete', dropped: 1 })
    expect(down.health().gaps).toEqual([
      { since: '2026-10-19T00:30:00.000Z', until: '2026-10-19T00:30:00.000Z', reason: 'capture_loss' },
      { since: '2026-10-19T00:30:00.000Z', until: '2026-10-19T03:00:00.000Z', reason: 'unclean_restart' },
      { since: '2026-10-19T03:00:00.000Z', until: '2026-10-19T03:00:00.000Z', reason: 'unavailable' },
    ])
  })

  it('lets failed captures neither seal episodes nor close uncertainty', () => {
    const db = store()
    db.loss(1)
    const blocking = new Database(db.path)
    blocking.pragma('busy_timeout = 0')
    blocking.exec('BEGIN EXCLUSIVE')
    try {
      expect(() => db.capture(admission())).toThrow()
    } finally { blocking.exec('ROLLBACK'); blocking.close() }
    db.loss(1)
    expect(db.health()).toMatchObject({ dropped: 2 })
    expect(db.health().gaps).toEqual([{ since: stamp(), until: stamp(), reason: 'capture_loss' }])
    db.capture(admission())
    clock += 1000
    db.loss(1)
    expect(db.health().gaps).toHaveLength(2)
  })

  it('keeps legacy envelopes coarse from the cutover while new episodes stay precise', () => {
    const db = store()
    db.capture(admission())
    const path = db.path
    db.close()
    const journal = JSON.parse(readFileSync(path + '.coverage.json', 'utf8')) as
      { closed: boolean, health: LedgerHealth }
    const legacy = { ...journal.health, dropped: 5,
      gaps: [{ since: '2026-10-15T00:00:00.000Z', until: '2026-10-18T00:00:00.000Z', reason: 'unclean_restart' }] }
    delete (legacy as Partial<LedgerHealth>).detailFloor
    writeFileSync(path + '.coverage.json', JSON.stringify({ version: 1, epoch: 'legacy', closed: true, health: legacy }))
    clock = Date.parse('2026-10-19T06:00:00.000Z')
    const cutover = stamp()
    const migrated = store(path)
    expect(migrated.health()).toMatchObject({ status: 'incomplete', dropped: 5, detailFloor: cutover })
    expect(migrated.health().gaps).toEqual(legacy.gaps)
    clock = Date.parse('2026-10-19T07:00:00.000Z')
    migrated.capture(admission('legacy-2'))
    const recovery = stamp()
    migrated.close()
    crash(path)
    clock = Date.parse('2026-10-19T08:00:00.000Z')
    const restarted = store(path)
    expect(restarted.health()).toMatchObject({ status: 'incomplete', dropped: 5, detailFloor: cutover })
    expect(restarted.health().gaps).toEqual([
      ...legacy.gaps,
      { since: recovery, until: '2026-10-19T08:00:00.000Z', reason: 'unclean_restart' },
    ])
  })

  it('floors compacted episodes while recent boundaries stay precise', () => {
    const db = store()
    for (let episode = 0; episode < 20; episode++) {
      clock = Date.parse('2026-10-19T00:00:00.000Z') + episode * 3_600_000
      db.loss(1)
      clock += 60_000
      db.capture({ type: 'heartbeat' })
    }
    expect(db.health()).toMatchObject({ status: 'incomplete', dropped: 20, detailFloor: '2026-10-19T03:00:00.000Z' })
    expect(db.health().gaps).toHaveLength(16)
    expect(db.health().gaps[0]).toEqual({ since: '2026-10-19T04:00:00.000Z', until: '2026-10-19T04:00:00.000Z', reason: 'capture_loss' })
    expect(db.health().gaps.at(-1)).toEqual({ since: '2026-10-19T19:00:00.000Z', until: '2026-10-19T19:00:00.000Z', reason: 'capture_loss' })
    expect(statSync(db.path + '.coverage.json').size).toBeLessThanOrEqual(8192)
    const path = db.path
    db.close()
    clock += 3_600_000
    const reopened = store(path)
    expect(reopened.health()).toMatchObject({ dropped: 20, detailFloor: '2026-10-19T03:00:00.000Z' })
    expect(reopened.health().gaps).toHaveLength(16)
    for (let episode = 20; episode < 25; episode++) {
      clock = Date.parse('2026-10-19T00:00:00.000Z') + episode * 3_600_000
      reopened.loss(1)
      clock += 60_000
      reopened.capture({ type: 'heartbeat' })
    }
    expect(reopened.health()).toMatchObject({ dropped: 25, detailFloor: '2026-10-19T08:00:00.000Z' })
    expect(reopened.health().gaps).toHaveLength(16)
    expect(reopened.health().gaps[0]).toEqual({ since: '2026-10-19T09:00:00.000Z', until: '2026-10-19T09:00:00.000Z', reason: 'capture_loss' })
    expect(statSync(path + '.coverage.json').size).toBeLessThanOrEqual(8192)
  })

  it('attributes spilled loss from the loss time across a pump delay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-loss-timing-'))
    asyncRoots.push(directory)
    const path = join(directory, 'ledger.db')
    const observer = new BehaviorLedgerObserver({ path })
    observers.push(observer)
    await observer.start()
    observer.capture(oversized('spilled-1'))
    const lostAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const pumpedAt = Date.now()
    observer.capture({ type: 'heartbeat' })
    await vi.waitFor(async () => {
      expect((await observer.read({ operation: 'health' })).body.health).toMatchObject({ pending: 0, dropped: 1 })
    }, { timeout: 5000, interval: 25 })
    const journal = JSON.parse(await readFile(path + '.coverage.json', 'utf8')) as { health: LedgerHealth }
    expect(journal.health.gaps).toHaveLength(1)
    const [gap] = journal.health.gaps
    expect(gap.reason).toBe('capture_loss')
    expect(Date.parse(gap.since)).toBeLessThanOrEqual(lostAt)
    expect(Date.parse(gap.until!)).toBeGreaterThanOrEqual(pumpedAt)
  })

  it('keeps bounds and counts exact for losses arriving while a marker is in flight', async () => {
    const { observer, directory } = await fixtureObserver(`
      let holdLoss = true;
      port.postMessage({ ready: true, health, pending: [] });
      port.on('message', request => {
        if (request.operation === 'close') {
          port.postMessage({ id: request.id, status: 200, body: { version: 1, health }, pending: [] });
          port.close();
          return;
        }
        if (request.observation?.type === 'loss') {
          appendFileSync(new URL('./markers', import.meta.url), JSON.stringify(request.observation) + '\\n');
        }
        const reply = () => {
          if (request.observation?.type === 'loss') {
            health.dropped += request.observation.count;
            health.status = 'incomplete';
          }
          port.postMessage({ id: request.id, status: 200, body: { version: 1, health }, pending: [] });
        };
        if (request.observation?.type !== 'loss' || !holdLoss) { reply(); return; }
        holdLoss = false;
        const release = new URL('./release', import.meta.url);
        const watcher = watch(new URL('.', import.meta.url), () => {
          if (!existsSync(release)) return;
          watcher.close(); reply();
        });
      });`)
    observer.capture(oversized('inflight-1'))
    observer.capture({ type: 'heartbeat' })
    await vi.waitFor(async () => {
      expect(await readFile(join(directory, 'markers'), 'utf8')).toContain('"type":"loss"')
    }, { timeout: 5000, interval: 25 })
    observer.capture(oversized('inflight-2'))
    observer.capture(oversized('inflight-3'))
    await writeFile(join(directory, 'release'), '')
    await vi.waitFor(async () => {
      expect((await observer.read({ operation: 'health' })).body.health).toMatchObject({ pending: 0, dropped: 3 })
    }, { timeout: 5000, interval: 25 })
    const markers = (await readFile(join(directory, 'markers'), 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { type: string, count: number, since: string })
    expect(markers).toHaveLength(2)
    expect(markers[0]).toMatchObject({ type: 'loss', count: 1 })
    expect(markers[1]).toMatchObject({ type: 'loss', count: 2 })
    expect(Date.parse(markers[1].since)).toBeGreaterThanOrEqual(Date.parse(markers[0].since))
  })

  it('attributes losses spilled while the worker is blocked from the spill time', async () => {
    const { observer, directory } = await fixtureObserver(`
      let holdCapture = true;
      port.postMessage({ ready: true, health, pending: [] });
      port.on('message', request => {
        if (request.operation === 'close') {
          port.postMessage({ id: request.id, status: 200, body: { version: 1, health }, pending: [] });
          port.close();
          return;
        }
        appendFileSync(new URL('./operations', import.meta.url), request.operation + '\\n');
        if (request.observation?.type === 'loss') {
          appendFileSync(new URL('./markers', import.meta.url), JSON.stringify(request.observation) + '\\n');
        }
        const reply = () => {
          if (request.observation?.type === 'loss') {
            health.dropped += request.observation.count;
            health.status = 'incomplete';
          }
          port.postMessage({ id: request.id, status: 200, body: { version: 1, health }, pending: [] });
        };
        if (request.operation !== 'capture' || request.observation?.type === 'loss' || !holdCapture) { reply(); return; }
        holdCapture = false;
        const release = new URL('./release', import.meta.url);
        const check = () => {
          if (!existsSync(release)) return;
          watcher.close(); reply();
        };
        const watcher = watch(new URL('.', import.meta.url), check);
        check();
      });`)
    observer.capture(admission('blocked-1'))
    await vi.waitFor(async () => {
      expect(await readFile(join(directory, 'operations'), 'utf8')).toContain('capture')
    }, { timeout: 5000, interval: 25 })
    observer.capture(oversized('blocked-spill'))
    const spilledAt = Date.now()
    await writeFile(join(directory, 'release'), '')
    await vi.waitFor(async () => {
      expect((await observer.read({ operation: 'health' })).body.health).toMatchObject({ pending: 0, dropped: 1 })
    }, { timeout: 5000, interval: 25 })
    const markers = (await readFile(join(directory, 'markers'), 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { type: string, count: number, since: string })
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ type: 'loss', count: 1 })
    expect(Date.parse(markers[0].since)).toBeLessThanOrEqual(spilledAt)
  })

  it('carries the coarse floor through ledger health and the history projection', () => {
    const db = store()
    for (let episode = 0; episode < 17; episode++) {
      clock = Date.parse('2026-10-19T00:00:00.000Z') + episode * 3_600_000
      db.loss(1)
      clock += 60_000
      db.capture({ type: 'heartbeat' })
    }
    const health = db.health()
    expect(health.detailFloor).toBe('2026-10-19T00:00:00.000Z')
    const snapshot: BehaviorLedgerSnapshot = { ready: true, failed: false, stopping: false, queueAgeMs: null,
      pending: 0, unreportedLoss: 0, stallBudgetMs: 10_000, health }
    expect(ledgerHistory(snapshot)).toMatchObject({ dropped: 17, detailFloor: '2026-10-19T00:00:00.000Z' })
    expect(ledgerHistory(snapshot).gaps).toHaveLength(16)
  })

  it('treats a coarse floor as incomplete in the JSON-emitting CLI', async () => {
    let floor: string | null = '2026-10-19T00:00:00.000Z'
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ version: 1,
        health: { status: 'ok', pending: 0, dropped: 0, gaps: [], detailFloor: floor } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('stub server did not bind')
    const base = `http://127.0.0.1:${address.port}`
    try {
      const silent = () => undefined
      expect(await runBehaviorLedgerCli(['health', '--base-url', base], silent, silent)).toBe(1)
      floor = null
      expect(await runBehaviorLedgerCli(['health', '--base-url', base], silent, silent)).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('records restart uncertainty across an actual SIGKILL and none across a clean exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ledger-abrupt-'))
    asyncRoots.push(root)
    const path = join(root, 'behavior-ledger.db')
    const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3')
    const storeBundle = join(root, 'store.cjs')
    await build({ entryPoints: ['server/behavior-ledger-store.ts'], outfile: storeBundle, bundle: true,
      platform: 'node', format: 'cjs', packages: 'external',
      alias: { 'better-sqlite3': sqliteModule }, external: [sqliteModule], logLevel: 'silent' })
    const child = resolve('tests/fixtures/behavior-ledger-abrupt-exit.mjs')
    await execute(process.execPath, [child, JSON.stringify({ storeBundle, path, mode: 'unclean' })], { timeout: 15_000 })
      .then(() => { throw new Error('the unclean child should have died on SIGKILL') },
        (error: unknown) => { expect((error as { signal?: unknown }).signal).toBe('SIGKILL') })
    const journal = JSON.parse(await readFile(path + '.coverage.json', 'utf8')) as { closed: boolean, health: LedgerHealth }
    expect(journal.closed).toBe(false)
    const reopened = new BehaviorLedgerStore(path)
    stores.push(reopened)
    expect(reopened.health().gaps).toEqual([
      { since: journal.health.observedAt, until: expect.any(String), reason: 'unclean_restart' },
    ])
    expect(Date.parse(reopened.health().gaps[0].until!)).toBeGreaterThanOrEqual(Date.parse(journal.health.observedAt!))
    reopened.close()
    await execute(process.execPath, [child, JSON.stringify({ storeBundle, path, mode: 'clean' })], { timeout: 15_000 })
    const clean = new BehaviorLedgerStore(path)
    stores.push(clean)
    expect(clean.health().gaps).toHaveLength(1)
  }, 30_000)
})

const invalidJournals: Array<[string, (health: LedgerHealth) => void]> = [
  ['an unparseable gap endpoint', (health) => {
    health.gaps = [{ since: 'not-a-date', until: '2026-10-19T23:00:00.000Z', reason: 'capture_loss' }]
  }],
  ['reversed gap endpoints', (health) => {
    health.gaps = [{ since: '2026-10-19T23:00:00.000Z', until: '2026-10-19T22:00:00.000Z', reason: 'capture_loss' }]
  }],
  ['an unknown gap reason', (health) => {
    health.gaps = [{ since: stamp(), until: stamp(), reason: 'no-such-reason' } as unknown as LedgerHealth['gaps'][number]]
  }],
  ['a non-string gap endpoint', (health) => {
    health.gaps = [{ since: stamp(), until: 12345, reason: 'capture_loss' } as unknown as LedgerHealth['gaps']]
  }],
  ['an invalid detail floor', (health) => { health.detailFloor = 'bogus' }],
]

describe('ledger journal validation', () => {
  it.each(invalidJournals)('rejects a journal with %s', (_label, mutate) => {
    const db = store()
    db.capture(admission())
    const path = db.path
    db.close()
    const journal = JSON.parse(readFileSync(path + '.coverage.json', 'utf8')) as { health: LedgerHealth }
    mutate(journal.health)
    writeFileSync(path + '.coverage.json', JSON.stringify(journal))
    const reopened = store(path)
    expect(reopened.health()).toMatchObject({ status: 'incomplete', dropped: 0, detailFloor: null })
    expect(reopened.health().gaps).toEqual([{ since: stamp(), until: stamp(), reason: 'unavailable' }])
  })
})
