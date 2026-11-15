import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BehaviorLedgerObserver, captureBehaviorAdmission, captureBehaviorOutcome, readBehaviorLedger, startBehaviorLedger, stopBehaviorLedger } from '../server/behavior-ledger'
import { handleBehaviorLedger } from '../server/behavior-ledger-http'
import { BehaviorLedgerStore } from '../server/behavior-ledger-store'
import * as logging from '../server/logging'
import type { LogEntry } from '../server/agent'
import { DEFAULT_LEDGER_POLICY, type LedgerAdmission, type LedgerHealth, type LedgerRecord, type LedgerReply } from '../server/behavior-ledger-contract'

const health: LedgerHealth = {
  status: 'ok', unavailableReason: null, coverageStart: '2026-10-19T00:00:00.000Z', observedAt: '2026-10-19T00:00:00.000Z',
  callerObservedAt: null, pending: 0, dropped: 0, gaps: [], detailFloor: null, generation: 'fixture', retainedFrom: null,
  changeLowerBound: 0, lastSequence: 0, instances: 0, changes: 0,
}
const admission: LedgerAdmission = { type: 'admit', admissionKey: 'panel', nativeId: 'native',
  behavior: 'review-new-prs', source: 'poise:review-new-prs', owner: 'owner', actor: 'agent',
  repository: 'owner/repo', number: 1, head: 'a'.repeat(40), slot: 'primary', plannedSlots: ['primary'] }
const observers: BehaviorLedgerObserver[] = []
const directories: string[] = []
async function fixture(body: string, options: ConstructorParameters<typeof BehaviorLedgerObserver>[0] = {}): Promise<BehaviorLedgerObserver> {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-transport-'))
  directories.push(directory)
  const workerPath = join(directory, 'worker.mjs')
  await writeFile(workerPath, `import { parentPort as port } from 'node:worker_threads';\nconst health=${JSON.stringify(health)};\n${body}\nport.on('message',request=>{if(request.operation==='close')port.close()});`)
  const observer = new BehaviorLedgerObserver({ lossDiagnostic: (event) => { logging.diagnostic(event) }, workerPath, ...options })
  observers.push(observer)
  await observer.start()
  return observer
}
/** The caller's two-second start and stop budgets at a tenth: these tests only need them to run out. */
function shortCallerBudgets() {
  const realSetTimeout = setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms: number, ...rest: []) => realSetTimeout(run, ms === 2_000 ? 200 : ms, ...rest)) as never)
}
const workerTiming = { totalMs: 7, readMs: 2, pendingMs: 3, encodeMs: 1, budgetScanMs: .5 }
function blockedWorker(operation: 'capture' | 'read'): string {
  return `
    import { appendFileSync, existsSync, watch } from 'node:fs';
    const timing=${JSON.stringify(workerTiming)};
    let blocked=false;
    port.postMessage({ready:true,health,pending:[]});
    port.on('message',request=>{
      appendFileSync(new URL('./operations',import.meta.url),
        (request.operation==='read'?request.request.operation:request.operation)+'\\n');
      const reply=()=>port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[],
        ...(request.operation==='read'?{timing}:{})});
      if(request.operation!==${JSON.stringify(operation)}||blocked) { reply(); return; }
      blocked=true;
      const release=new URL('./release',import.meta.url);
      let released=false;
      const watcher=watch(new URL('.',import.meta.url),()=>check());
      function check() {
        if(released||!existsSync(release)) return;
        released=true; watcher.close(); reply();
      }
      check();
    });`
}
afterEach(async () => {
  await Promise.all(observers.splice(0).map(async (observer) => {
    // stop bounds its caller; fixture files belong to the worker until exit.
    await observer.stop()
    await observer.waitForExit()
  }))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('bounded behavior ledger transport', () => {
  it('terminates a protocol-failed idle worker instead of leaking its live event loop', async () => {
    const sent = vi.spyOn(Worker.prototype, 'postMessage')
    const terminated = vi.spyOn(Worker.prototype, 'terminate')
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const observer = await fixture(`
        port.postMessage({ready:true,health,pending:[]});
        port.on('message',request=>{
          if(request.operation!=='read') return;
          port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});
          setImmediate(()=>{
            port.postMessage({pending:[],invalid:true});
            while(true) {}
          });
        });`)
      expect((await observer.read({ operation: 'health' })).status).toBe(200)
      worker = sent.mock.contexts.find((value): value is Worker => value instanceof Worker)
      expect(worker).toBeDefined()
      const exited = await Promise.race([
        observer.waitForExit().then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000) }),
      ])
      expect(exited).toBe(true)
      expect(terminated).toHaveBeenCalledExactlyOnceWith()
      expect((await observer.read({ operation: 'health' })).body.health.status).toBe('unavailable')
    } finally {
      clearTimeout(timer)
      // Only this fixture's pure-JS worker is forcibly settled on guard failure.
      if (worker && worker.threadId !== -1) await worker.terminate()
      sent.mockRestore()
      terminated.mockRestore()
    }
  })

  it('queues newest overflow while the worker drains and never throws into work', async () => {
    const observer = await fixture(`
      port.postMessage({ready:true,health,pending:[]});
      port.on('message', request => {
        const reply=()=> {
          if(request.observation?.type==='loss') health.dropped+=request.observation.count;
          if(health.dropped) health.status='incomplete';
          port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});
        };
        setTimeout(reply,request.operation==='capture'?10:0);
      });`, { captureLimit: 1 })
    expect(() => { observer.capture(admission); observer.capture({ ...admission, nativeId: 'second' }) }).not.toThrow()
    const reply = await observer.read({ operation: 'health' })
    expect(reply.status).toBe(200)
    expect(reply.body.health.dropped).toBe(0)
    expect(reply.body.health.pending).toBe(1)
    expect(reply.body.health.status).toBe('incomplete')
    expect((await observer.read({ operation: 'health' })).body.health).toMatchObject({
      pending: 0, dropped: 0, status: 'ok',
    })
  })

  it('persists spill loss before acknowledgement and retains it after reopening', async () => {
    const diagnostic = vi.spyOn(logging, 'diagnostic')
    const directory = await mkdtemp(join(tmpdir(), 'ledger-overflow-'))
    directories.push(directory)
    const path = join(directory, 'ledger.db')
    const observer = new BehaviorLedgerObserver({ path, lossDiagnostic: (event) => { logging.diagnostic(event) } })
    observers.push(observer)
    await observer.start()
    observer.capture(admission)
    observer.capture({ ...admission, nativeId: 'oversized', admissionKey: 'x'.repeat(4097) })
    expect(diagnostic).not.toHaveBeenCalled()
    const prefix = await observer.read({ operation: 'list' })
    expect(prefix).toMatchObject({ status: 200, body: { health: { status: 'incomplete', dropped: 1 } } })
    observer.capture({ ...admission, nativeId: 'oversized-again', admissionKey: 'y'.repeat(4097) })
    expect((await observer.read({ operation: 'health' })).body.health).toMatchObject({ pending: 1, dropped: 2 })
    const retained = { pending: 0, dropped: 2, generation: prefix.body.health.generation,
      gaps: expect.arrayContaining([expect.objectContaining({ reason: 'capture_loss' })]) }
    expect((await observer.read({ operation: 'health' })).body.health).toMatchObject(retained)
    const journal = JSON.parse(await readFile(path + '.coverage.json', 'utf8')) as { health: LedgerHealth }
    expect(journal.health).toMatchObject(retained)
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'behavior-ledger.capture_loss',
      context: expect.objectContaining({ reason: 'capture_oversized', count: 1 }) })))
    await observer.stop()
    const reopened = new BehaviorLedgerObserver({ path })
    observers.push(reopened)
    await reopened.start()
    expect(await reopened.read({ operation: 'health' })).toMatchObject({ status: 200,
      body: { health: { ...retained, status: 'incomplete' } } })
  })

  it('serves queued reads between captures while preserving capture, read and close order', async () => {
    const observer = await fixture(`
      import { appendFileSync, existsSync, watch } from 'node:fs';
      const order=new URL('./order',import.meta.url);
      port.postMessage({ready:true,health,pending:[]});
      port.on('message',request=>{
        const label=request.operation==='capture'?request.observation.nativeId
          :request.operation==='read'?request.request.operation:request.operation;
        appendFileSync(order,label+'\\n');
        const reply=()=>{
          if(request.operation==='capture') health.instances++;
          port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});
        };
        if(label!=='second') { reply(); return; }
        const release=new URL('./release',import.meta.url);
        let released=false;
        const watcher=watch(new URL('.',import.meta.url),()=>check());
        function check() {
          if(released||!existsSync(release)) return;
          released=true; watcher.close(); reply();
        }
        check();
      });`)
    const directory = directories.at(-1)!
    for (const nativeId of ['first', 'second', 'third']) observer.capture({ ...admission, nativeId })
    const first = observer.read({ operation: 'list' })
    const second = observer.read({ operation: 'health' })
    try {
      expect(await first).toMatchObject({ status: 200, body: { health: { status: 'incomplete', instances: 1, pending: 2 } } })
      const stopping = observer.stop()
      observer.capture({ ...admission, nativeId: 'late' })
      expect(await observer.read({ operation: 'list' })).toMatchObject({ status: 503, body: { health: { status: 'stopped' } } })
      await writeFile(join(directory, 'release'), '')
      expect(await second).toMatchObject({ status: 200, body: { health: { instances: 2, pending: 1 } } })
      await stopping
      expect((await readFile(join(directory, 'order'), 'utf8')).trim().split('\n')).toEqual([
        'first', 'list', 'second', 'health', 'third', 'close',
      ])
    } finally { await writeFile(join(directory, 'release'), '') }
  })

  it('bounds read admission and recovers after a queued health-read deadline', async () => {
    const observer = await fixture(`
      port.postMessage({ready:true,health,pending:[]});
      let delayed=true;
      port.on('message',request=>{
        const reply=()=>port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});
        if(request.operation==='capture') setTimeout(reply,40);
        else if(request.operation==='read'&&delayed) { delayed=false; setTimeout(reply,40); }
        else reply();
      });`,
      { readLimit: 1, readTimeoutMs: 50 })
    observer.capture(admission)
    const first = observer.read({ operation: 'health' })
    expect((await observer.read({ operation: 'list' })).status).toBe(429)
    expect(await first).toMatchObject({ status: 200, body: { health: { status: 'unavailable', unavailableReason: 'read_timeout' } } })
    expect(() => observer.capture(admission)).not.toThrow()
    await vi.waitFor(async () => {
      expect(await observer.read({ operation: 'health' })).toMatchObject({ status: 200, body: { health: { status: 'ok', pending: 0, dropped: 0 } } })
    }, { timeout: 1500, interval: 25 })
  })

  it('reports a queued timeout with only the blocking capture kind and elapsed time', async () => {
    const observer = await fixture(blockedWorker('capture'), { readLimit: 1, readTimeoutMs: 200 })
    const directory = directories.at(-1)!
    const release = join(directory, 'release')
    observer.capture(admission)
    try {
      const reply = await observer.read({ operation: 'list' })
      expect(reply).toMatchObject({ status: 503, body: { error: 'ledger_read_timeout', health: { status: 'unavailable', unavailableReason: 'read_timeout' } } })
      expect(reply.timing).toEqual({ queueMs: expect.any(Number), timeout: 'queued',
        blocking: { kind: 'admit', elapsedMs: expect.any(Number) } })
      expect(reply.timing!.queueMs).toBeGreaterThanOrEqual(0)
      expect(reply.timing!.blocking!.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(reply.body).not.toHaveProperty('timing')
      const next = observer.read({ operation: 'health' })
      expect((await observer.read({ operation: 'list' })).status).toBe(429)
      await writeFile(release, '')
      expect((await next).status).toBe(200)
      expect((await readFile(join(directory, 'operations'), 'utf8')).trim().split('\n')).toEqual(['capture', 'health'])
    } finally { await writeFile(release, '') }
  })

  it('reports an active timeout and retains its slot until the late acknowledgement without changing timing', async () => {
    const observer = await fixture(blockedWorker('read'), { readLimit: 1, readTimeoutMs: 30 })
    const release = join(directories.at(-1)!, 'release')
    const settled = vi.fn()
    try {
      const reply = await observer.read({ operation: 'list' }).then((value) => { settled(value); return value })
      expect(reply).toMatchObject({ status: 503, body: { error: 'ledger_read_timeout', health: { status: 'unavailable', unavailableReason: 'read_timeout' } } })
      expect(reply.timing).toEqual({ queueMs: expect.any(Number), activeMs: expect.any(Number), timeout: 'active' })
      expect(reply.timing!.queueMs).toBeGreaterThanOrEqual(0)
      expect(reply.timing!.activeMs!).toBeGreaterThanOrEqual(0)
      const timing = JSON.stringify(reply.timing)
      expect((await observer.read({ operation: 'health' })).status).toBe(429)
      await writeFile(release, '')
      await vi.waitFor(async () => {
        expect(await observer.read({ operation: 'health' })).toMatchObject({ status: 200,
          body: { health: { status: 'ok' } }, timing: { worker: workerTiming } })
      }, { timeout: 1500, interval: 25 })
      expect(settled).toHaveBeenCalledExactlyOnceWith(reply)
      expect(JSON.stringify(reply.timing)).toBe(timing)
      expect(reply.timing).not.toHaveProperty('worker')
      expect(reply.body).not.toHaveProperty('timing')
    } finally { await writeFile(release, '') }
  })

  it('reports successful queue, active and optional worker timings outside the response body', async () => {
    const observer = await fixture(`
      port.postMessage({ready:true,health,pending:[]});
      port.on('message',request=>port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[],
        ...(request.operation==='read'?{timing:${JSON.stringify(workerTiming)}}:{})}));`)
    const reply = await observer.read({ operation: 'health' })
    expect(reply.body).toEqual({ version: 1, health })
    expect(reply.timing).toEqual({ queueMs: expect.any(Number), activeMs: expect.any(Number), worker: workerTiming })
    expect(reply.timing!.queueMs).toBeGreaterThanOrEqual(0)
    expect(reply.timing!.activeMs!).toBeGreaterThanOrEqual(0)
  })

  it('emits each Caller projection once per change instead of once per snapshot', async () => {
    const observer = await fixture(`
      const pending=[{nativeId:'native',callId:null}];
      port.postMessage({ready:true,health,pending});
      port.on('message',request=>port.postMessage({id:request.id,status:200,body:{version:1,health},pending}));`)
    const snapshot = { entries: [], quarantined: [] }
    observer.observe(snapshot)
    observer.observe(snapshot)
    observer.observe(snapshot)
    expect((await observer.read({ operation: 'health' })).body.health.pending).toBe(0)
  })

  it('re-emits Caller projections on change without refreshing running ones', async () => {
    const observer = await fixture(`
      import { appendFileSync } from 'node:fs';
      const pending=[{nativeId:'idle',callId:null},{nativeId:'busy',callId:null}];
      port.postMessage({ready:true,health,pending});
      port.on('message',request=>{
        if(request.operation==='capture') appendFileSync(new URL('./captures',import.meta.url),'capture\\n');
        port.postMessage({id:request.id,status:200,body:{version:1,health},pending});
      });`)
    const captures = async (): Promise<number> => (await readFile(join(directories.at(-1)!, 'captures'), 'utf8')).trim().split('\n').length
    const flush = async (): Promise<void> => {
      await vi.waitFor(async () => {
        expect((await observer.read({ operation: 'health' })).body.health.pending).toBe(0)
      }, { timeout: 1500, interval: 25 })
    }
    const row: LogEntry = { id: 'b'.repeat(32), pr_id: '9', repo: 'example/project', actor: 'octobot', model: 'fixture',
      behavior: 'pr_review', session_id: null, prompt: '', started_at: new Date().toISOString(), time_elapsed: '0',
      status: 'running', outcome: null, head_sha: null, expected_head: null, source: 'poise:review-new-prs',
      correlation_id: 'busy', action: null, response: null, error: '' }
    const absent = { entries: [], quarantined: [] }
    const running = { entries: [row], quarantined: [] }
    observer.observe(absent)
    await flush()
    expect(await captures()).toBe(2)
    observer.observe(absent)
    await flush()
    expect(await captures()).toBe(2)
    observer.observe(running)
    await flush()
    expect(await captures()).toBe(3)
    observer.observe(running)
    await flush()
    expect(await captures()).toBe(3)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    observer.observe(running)
    await flush()
    expect(await captures()).toBe(3)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    observer.observe(absent)
    await flush()
    expect(await captures()).toBe(4)
  })

  it('forgets Caller projections that leave the pending set', async () => {
    const observer = await fixture(`
      import { appendFileSync } from 'node:fs';
      let seen=0;
      const pendingFor=()=>seen<1?[{nativeId:'native',callId:null}]:seen<2?[]:[{nativeId:'native',callId:null}];
      port.postMessage({ready:true,health,pending:pendingFor()});
      port.on('message',request=>{
        seen++;
        if(request.operation==='capture') appendFileSync(new URL('./captures',import.meta.url),'capture\\n');
        port.postMessage({id:request.id,status:200,body:{version:1,health},pending:pendingFor()});
      });`)
    const captures = async (): Promise<number> => (await readFile(join(directories.at(-1)!, 'captures'), 'utf8')).trim().split('\n').length
    const snapshot = { entries: [], quarantined: [] }
    observer.observe(snapshot)
    await vi.waitFor(async () => {
      expect((await observer.read({ operation: 'health' })).body.health.pending).toBe(0)
    }, { timeout: 1500, interval: 25 })
    expect(await captures()).toBe(1)
    observer.observe(snapshot)
    await vi.waitFor(async () => {
      expect((await observer.read({ operation: 'health' })).body.health.pending).toBe(0)
    }, { timeout: 1500, interval: 25 })
    expect(await captures()).toBe(2)
  })

  it('drains a burst larger than the queue cap without dropping while storage is healthy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-burst-'))
    directories.push(directory)
    const observer = new BehaviorLedgerObserver({ path: join(directory, 'ledger.db'), captureLimit: 25 })
    observers.push(observer)
    await observer.start()
    expect((await observer.read({ operation: 'health' })).body.health.status).toBe('ok')
    for (let index = 0; index < 75; index++) {
      observer.capture({ ...admission, admissionKey: `burst-${index}`, nativeId: `burst-${index}` })
    }
    expect((await observer.read({ operation: 'health' })).body.health.dropped).toBe(0)
    await vi.waitFor(async () => {
      expect((await observer.read({ operation: 'health' })).body.health).toMatchObject({ pending: 0, dropped: 0 })
    }, { timeout: 9000, interval: 50 })
    expect((await observer.read({ operation: 'health' })).body.health).toMatchObject({ status: 'ok', gaps: [] })
    const page = await observer.read({ operation: 'list', limit: 100 })
    expect(page.status).toBe(200)
    expect(page.body.records!.length).toBeGreaterThan(0)
  })

  it('holds a burst past the default queue cap without dropping while storage is healthy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-burst-cap-'))
    directories.push(directory)
    const observer = new BehaviorLedgerObserver({ path: join(directory, 'ledger.db') })
    observers.push(observer)
    await observer.start()
    for (let index = 0; index < 1050; index++) {
      observer.capture({ ...admission, admissionKey: `burst-${index}`, nativeId: `burst-${index}` })
    }
    const held = (await observer.read({ operation: 'health' })).body.health
    expect(held.dropped).toBe(0)
    expect(held.pending).toBeGreaterThan(1000)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const after = (await observer.read({ operation: 'health' })).body.health
    expect(after.dropped).toBe(0)
    expect(after.pending).toBeLessThan(held.pending)
  })

  it('closes on the worker when a stop outlasts the drain budget', async () => {
    // Ten captures at 400ms each can never drain inside the stop budget, so
    // close must be shed forward and dispatched instead of the worker being
    // terminated with the queue still full.
    shortCallerBudgets()
    const observer = await fixture(`
      import { appendFileSync } from 'node:fs';
      const order=new URL('./order',import.meta.url);
      port.postMessage({ready:true,health,pending:[]});
      port.on('message',request=>{
        appendFileSync(order,(request.operation==='capture'?'capture':request.operation)+'\\n');
        const reply=()=>port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});
        if(request.operation==='capture') setTimeout(reply,400);
        else reply();
      });`)
    for (let index = 0; index < 10; index++) {
      observer.capture({ ...admission, admissionKey: `slow-${index}`, nativeId: `slow-${index}` })
    }
    await observer.stop()
    // The stop budget bounds the caller, not the worker: close still lands
    // on the worker after the active capture settles.
    await vi.waitFor(async () => {
      const order = (await readFile(join(directories.at(-1)!, 'order'), 'utf8')).trim().split('\n')
      expect(order.at(-1)).toBe('close')
    }, { timeout: 5000, interval: 50 })
  })

  it('emits shutdown-timeout loss synchronously before logging stops', async () => {
    // Slow captures outlast the stop budget, so queued arrivals are shed as
    // shutdown_timeout. stopPoiseRuntime stops logging without yielding to
    // the event loop when no query pool or Caller pass is outstanding, which
    // would discard a deferred diagnostic before DiagnosticRuntime.ingest.
    shortCallerBudgets()
    const diagnostic = vi.spyOn(logging, 'diagnostic')
    diagnostic.mockClear()
    const observer = await fixture(`
      port.postMessage({ready:true,health,pending:[]});
      port.on('message',request=>{
        const reply=()=>port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});
        if(request.operation==='capture') setTimeout(reply,400);
        else reply();
      });`)
    for (let index = 0; index < 10; index++) {
      observer.capture({ ...admission, admissionKey: `shutdown-${index}`, nativeId: `shutdown-${index}` })
    }
    await observer.stop()
    // No waitFor: a setImmediate-deferred emit would still be queued here.
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'behavior-ledger.capture_loss',
      context: expect.objectContaining({ reason: 'shutdown_timeout' }) }))
  })

  it('diagnoses a single in-flight failure when stop waits for worker exit', async () => {
    // One capture in flight and nothing queued at the stop deadline: the
    // worker reply arrives after stop() resolved. stopBehaviorLedger waits for
    // exit so logging (stopped after it in stopPoiseRuntime) still ingests the
    // shutdown_timeout diagnostic. Without the wait the reply lands after
    // logging stopped and the loss is never diagnosed.
    shortCallerBudgets()
    const diagnostic = vi.spyOn(logging, 'diagnostic')
    diagnostic.mockClear()
    const directory = await mkdtemp(join(tmpdir(), 'ledger-single-shutdown-'))
    directories.push(directory)
    const workerPath = join(directory, 'worker.mjs')
    await writeFile(workerPath, `import { parentPort as port } from 'node:worker_threads';\nconst health=${JSON.stringify(health)};\nport.postMessage({ready:true,health,pending:[]});\nport.on('message',request=>{\nif(request.operation==='close'){port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});port.close();return;}\nif(request.operation==='capture'&&request.observation?.type!=='loss'){setTimeout(()=>port.postMessage({id:request.id,status:500,body:{version:1,health,error:'boom'},pending:[]}),400);return;}\nport.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});\n});`)
    await stopBehaviorLedger().catch(() => {})
    await startBehaviorLedger({ path: join(directory, 'ledger.db'), workerPath,
      lossDiagnostic: (event) => { logging.diagnostic(event) } })
    try {
      captureBehaviorAdmission({ admissionKey: 'single-shutdown', nativeId: 'single-shutdown', behavior: admission.behavior,
        source: admission.source, owner: admission.owner, actor: admission.actor, repository: admission.repository,
        number: admission.number, head: admission.head, slot: admission.slot, plannedSlots: admission.plannedSlots })
      await stopBehaviorLedger()
      // No waitFor: without waiting for exit the failing reply (400ms) lands
      // after the shortened stop budget (200ms) and logging would already be stopped.
      expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'behavior-ledger.capture_loss',
        context: expect.objectContaining({ reason: 'shutdown_timeout' }) }))
    } finally {
      await stopBehaviorLedger().catch(() => {})
    }
  })

  it('diagnoses worker failure during shutdown synchronously before logging stops', async () => {
    // An in-flight capture held past the stop budget while the worker then
    // exits: fail() sheds it as worker_failed in the exit handler that also
    // resolves waitForExit(). stopPoiseRuntime stops logging right after that
    // wait without yielding, so a deferred emit would be discarded by ingest.
    shortCallerBudgets()
    const diagnostic = vi.spyOn(logging, 'diagnostic')
    diagnostic.mockClear()
    const observer = await fixture(`
      port.postMessage({ready:true,health,pending:[]});
      port.on('message',request=>{
        if(request.operation==='capture'){ setTimeout(()=>process.exit(1),300); return; }
      });`)
    observer.capture(admission)
    await observer.stop()
    await observer.waitForExit()
    // No waitFor: a setImmediate-deferred emit would still be queued here.
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'behavior-ledger.capture_loss',
      context: expect.objectContaining({ reason: 'worker_failed', count: 1 }) }))
  })

  it('holds captures through a storage outage and recovers to ok with the list answering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-outage-'))
    directories.push(directory)
    const blocked = join(directory, 'ledger.db')
    await mkdir(blocked)
    const observer = new BehaviorLedgerObserver({ path: blocked })
    observers.push(observer)
    await observer.start()
    expect((await observer.read({ operation: 'health' })).body.health)
      .toMatchObject({ status: 'unavailable', unavailableReason: 'store_unavailable' })
    expect((await observer.read({ operation: 'list' })).status).toBe(503)
    observer.capture(admission)
    await rmdir(blocked)
    await vi.waitFor(async () => {
      expect((await observer.read({ operation: 'health' })).body.health).toMatchObject({ status: 'ok', pending: 0, dropped: 0 })
    }, { timeout: 9000, interval: 50 })
    const page = await observer.read({ operation: 'list', limit: 100 })
    expect(page.status).toBe(200)
    expect(page.body.records!.some((record) => record.target.number === 1)).toBe(true)
  })

  it('retries a rolled-back 503 capture batch in order without splitting or loss', async () => {
    const observer = await fixture(`
      import { appendFileSync, existsSync, watch } from 'node:fs';
      let first=true, rejected=false;
      port.postMessage({ready:true,captureBatch:true,health,pending:[]});
      port.on('message',request=>{
        const reply=(status=200)=>port.postMessage({id:request.id,status,body:{version:1,health,
          ...(status===503?{error:'ledger_unavailable'}:{})},pending:[]});
        if(request.operation!=='capture') { reply(); return; }
        const observations=request.observations??[request.observation];
        appendFileSync(new URL('./dispatches',import.meta.url),observations.length+'\\n');
        if(observations.length>1&&!rejected) { rejected=true; reply(503); return; }
        const accept=()=>{
          for(const observation of observations) {
            if(observation.type==='loss') health.dropped+=observation.count;
            else {
              appendFileSync(new URL('./accepted',import.meta.url),observation.nativeId+'\\n');
              health.instances++;
            }
          }
          reply();
        };
        if(!first) { accept(); return; }
        first=false;
        const release=new URL('./release',import.meta.url);
        let released=false;
        const watcher=watch(new URL('.',import.meta.url),()=>check());
        function check() {
          if(released||!existsSync(release)) return;
          released=true; watcher.close(); accept();
        }
        check();
      });`)
    const directory = directories.at(-1)!
    const release = join(directory, 'release')
    const nativeIds = Array.from({ length: 25 }, (_, index) => `retry-${index}`)
    try {
      for (const nativeId of nativeIds) observer.capture({ ...admission, nativeId, admissionKey: nativeId })
      expect(observer.snapshot().pending).toBe(25)
      await writeFile(release, '')
      await vi.waitFor(() => {
        expect(observer.snapshot()).toMatchObject({ pending: 0, unreportedLoss: 0,
          health: { status: 'ok', pending: 0, dropped: 0, instances: 25, gaps: [] } })
      }, { timeout: 5000, interval: 25 })
      expect((await readFile(join(directory, 'dispatches'), 'utf8')).trim().split('\n').map(Number)).toEqual([1, 24, 24])
      expect((await readFile(join(directory, 'accepted'), 'utf8')).trim().split('\n')).toEqual(nativeIds)
    } finally { await writeFile(release, '') }
  })

  it('queues overflow while the worker drains and spills only once the queue stalls', async () => {
    const observer = await fixture(`
      import { existsSync, watch } from 'node:fs';
      let blocked=false;
      port.postMessage({ready:true,health,pending:[]});
      port.on('message',request=>{
        const reply=()=>{
          if(request.observation?.type==='loss') health.dropped+=request.observation.count;
          if(health.dropped) health.status='incomplete';
          port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});
        };
        if(request.operation!=='capture'||blocked) { reply(); return; }
        blocked=true;
        const release=new URL('./release',import.meta.url);
        let released=false;
        const watcher=watch(new URL('.',import.meta.url),()=>check());
        function check() {
          if(released||!existsSync(release)) return;
          released=true; watcher.close(); reply();
        }
        check();
      });`, { captureLimit: 1, stallTimeoutMs: 60, readTimeoutMs: 100 })
    const release = join(directories.at(-1)!, 'release')
    observer.capture(admission)
    observer.capture({ ...admission, nativeId: 'second' })
    try {
      expect((await observer.read({ operation: 'health' })).body.health).toMatchObject({ pending: 2, dropped: 0 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      observer.capture({ ...admission, nativeId: 'third' })
      const stalled = (await observer.read({ operation: 'health' })).body.health
      expect(stalled.dropped).toBe(1)
      expect(stalled.pending).toBeGreaterThanOrEqual(2)
      await writeFile(release, '')
      await vi.waitFor(async () => {
        expect((await observer.read({ operation: 'health' })).body.health).toMatchObject({ pending: 0, dropped: 1, status: 'incomplete' })
      }, { timeout: 1500, interval: 25 })
    } finally { await writeFile(release, '') }
  })

  it('spills sustained overload after the stall budget even while captures succeed', async () => {
    const diagnostic = vi.spyOn(logging, 'diagnostic')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const observer = await fixture(`
        port.postMessage({ready:true,health,pending:[]});
        port.on('message', request => {
          const reply=()=>{
            if(request.observation?.type==='loss') health.dropped+=request.observation.count;
            if(health.dropped) health.status='incomplete';
            port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});
          };
          setTimeout(reply,request.operation==='capture'?10:0);
        });`, { captureLimit: 1, stallTimeoutMs: 60 })
      observer.capture(admission)
      observer.capture({ ...admission, nativeId: 'second' })
      // The first capture succeeds after the second was queued: progress
      // must not exempt that remaining backlog from its age limit.
      clock.mockReturnValue(1_000_001)
      expect((await observer.read({ operation: 'health' })).body.health)
        .toMatchObject({ pending: 1, dropped: 0 })
      clock.mockReturnValue(1_000_061)
      observer.capture({ ...admission, nativeId: 'third' })
      await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'behavior-ledger.capture_loss',
        context: expect.objectContaining({ reason: 'queue_saturated', pending: 1, queueAgeMs: 61,
          captureLimit: 1, stallBudgetMs: 60, queuedBytes: expect.any(Number) }) })))
      expect((await observer.read({ operation: 'health' })).body.health.dropped).toBe(1)
    } finally { clock.mockRestore() }
  })

  it('sheds invalid captures with loss accounting instead of retrying them', async () => {
    const diagnostic = vi.spyOn(logging, 'diagnostic')
    const directory = await mkdtemp(join(tmpdir(), 'ledger-poison-'))
    directories.push(directory)
    const observer = new BehaviorLedgerObserver({ path: join(directory, 'ledger.db'), lossDiagnostic: (event) => { logging.diagnostic(event) } })
    observers.push(observer)
    await observer.start()
    observer.capture(admission)
    observer.capture({ ...admission, nativeId: 'before-poison', admissionKey: 'before-poison' })
    observer.capture({ ...admission, nativeId: 'poison', admissionKey: 'x'.repeat(1025) })
    observer.capture({ ...admission, nativeId: 'after-poison', admissionKey: 'after-poison' })
    await vi.waitFor(() => {
      expect(observer.snapshot()).toMatchObject({ pending: 0, health: { dropped: 1, instances: 6 } })
    }, { timeout: 5000, interval: 25 })
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'behavior-ledger.capture_loss',
      context: expect.objectContaining({ reason: 'capture_rejected', rejection: 'invalid_observation', count: 1 }) })))
    const page = await observer.read({ operation: 'list', limit: 100 })
    expect(page.body.records!.flatMap(record => record.refs).filter(ref => ref.kind === 'correlation').map(ref => ref.identity).sort())
      .toEqual(['after-poison', 'before-poison', 'native'])
    expect((await observer.read({ operation: 'health' })).body.health.gaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'capture_loss' })]))
  })

  it('defers the worker-failed diagnostic on the hot capture path', async () => {
    // After an idle worker failure the next capture() must stay memory-only:
    // logging may journal its own overflow with filesystem I/O, so the
    // diagnostic stays deferred while no stop is in progress.
    const diagnostic = vi.spyOn(logging, 'diagnostic')
    const observer = await fixture('throw new Error("fixture failed startup");')
    diagnostic.mockClear()
    expect(() => observer.capture(admission)).not.toThrow()
    expect(diagnostic).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'behavior-ledger.capture_loss',
      context: expect.objectContaining({ reason: 'worker_failed', count: 1 }) })))
  })

  it('keeps a failed startup observational and health readable', async () => {
    const diagnostic = vi.spyOn(logging, 'diagnostic')
    const observer = await fixture('throw new Error("fixture failed startup");')
    expect(() => observer.capture(admission)).not.toThrow()
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: 'behavior-ledger.capture_loss',
      context: expect.objectContaining({ reason: 'worker_failed', count: 1 }) })))
    expect((await observer.read({ operation: 'get', id: 'a'.repeat(64) })).status).toBe(503)
    expect((await observer.read({ operation: 'health' })).body.health.status).toBe('unavailable')
  })

  it('upgrades a populated store and serves sparse target HTTP reads under writes at the retention caps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-caps-'))
    directories.push(directory)
    const path = join(directory, 'ledger.db')
    // Bulk-load representative settled history at the default caps in one
    // transaction; write-path seeding would take minutes in per-capture
    // commits, while this acceptance is about reads. Row byte accounting
    // mirrors the store; the store suite pins that formula.
    const setup = new BehaviorLedgerStore(path)
    setup.close()
    // Longest supported repository identity also bounds the new index's keys.
    const repository = `${'A'.repeat(39)}/${'P'.repeat(100)}`
    const load = new Database(path)
    try {
      const now = new Date().toISOString()
      const head = 'a'.repeat(40)
      const insertInstance = load.prepare(`INSERT INTO ledger_instances
        (creation_seq,id,parent_id,admission_key,native_id,payload,updated_at,source_at,bytes,terminal,no_write)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      const insertChange = load.prepare('INSERT INTO ledger_changes(seq,id,op,payload,created_at,bytes) VALUES(?,?,?,?,?,?)')
      load.transaction(() => {
        for (let index = 0; index < 5000; index++) {
          const root: LedgerRecord = { id: randomBytes(32).toString('hex'), kind: 'firing', parentId: null, behavior: 'review-new-prs',
            source: 'poise:review-new-prs', owner: 'acme', actor: 'review-bot', target: { repository, number: index + 1 },
            head, slot: null, plannedSlots: ['primary'], state: 'completed', stateSource: 'native', activity: 'settled', outcome: 'clean',
            createdAt: now, startedAt: now, completedAt: now, observedAt: now, revision: 1, refs: [], replayOf: null, omittedAttempts: 0 }
          const attempt: LedgerRecord = { ...root, id: randomBytes(32).toString('hex'), kind: 'attempt', parentId: root.id,
            slot: 'primary', plannedSlots: [], refs: [{ kind: 'correlation', identity: `caps-${index}`, availability: 'available' }] }
          for (const [seq, record, admissionKey, nativeId] of [
            [index * 2 + 1, root, `caps-key-${index}`, null],
            [index * 2 + 2, attempt, null, `caps-${index}`],
          ] as const) {
            const payload = JSON.stringify(record)
            insertInstance.run(seq, record.id, record.parentId, admissionKey, nativeId, payload, now, now, Buffer.byteLength(payload) + 512, 1, 0)
          }
        }
        for (let seq = 1; seq <= 30000; seq++) {
          const id = randomBytes(32).toString('hex')
          const payload = JSON.stringify({ sequence: seq, op: 'remove', id, revision: seq })
          insertChange.run(seq, id, 'remove', payload, now, Buffer.byteLength(payload) + 256)
        }
      })()
    } finally { load.close() }
    const legacy = new BehaviorLedgerStore(path)
    const before = new Database(path)
    let target: LedgerReply
    let listing: LedgerReply
    let coverage: LedgerHealth
    let identities: { creation_seq: number; id: string; payload: string }[]
    let metadata: { key: string; value: string }[]
    try {
      // An existing store has already issued these cursors without the index.
      before.exec('DROP INDEX IF EXISTS ledger_target')
      before.exec('VACUUM')
      expect(before.prepare("SELECT 1 FROM sqlite_master WHERE name='ledger_target'").get()).toBeUndefined()
      legacy.capture({ type: 'loss', count: 3 })
      target = legacy.read({ operation: 'list', repository: repository.toLowerCase(), number: 2500, limit: 1 }).body
      listing = legacy.read({ operation: 'list', limit: 1 }).body
      coverage = legacy.health()
      identities = before.prepare<unknown[], { creation_seq: number; id: string; payload: string }>(
        'SELECT creation_seq,id,payload FROM ledger_instances WHERE creation_seq>64 ORDER BY creation_seq').all()
      metadata = before.prepare<unknown[], { key: string; value: string }>(
        "SELECT key,value FROM ledger_meta WHERE key IN ('version','generation','cursor_key') ORDER BY key").all()
    } finally { before.close(); legacy.close() }
    expect(target.nextCursor).toEqual(expect.any(String))
    expect(listing.nextCursor).toEqual(expect.any(String))
    const originalBytes = statSync(path).size
    let peakJournalBytes = 0
    const monitor = setInterval(() => {
      peakJournalBytes = Math.max(peakJournalBytes, statSync(path + '-journal', { throwIfNoEntry: false })?.size ?? 0)
    }, 1)
    const server = createServer((req, res) => { void handleBehaviorLedger(req, res, req.url!) })
    try {
      const starting = startBehaviorLedger({ path })
      // Captures queued during index creation must drain without new loss.
      for (let index = 0; index < 32; index++) {
        const nativeId = `during-upgrade-${index}`
        captureBehaviorAdmission({ ...admission, admissionKey: nativeId, nativeId, repository, number: 6000 + index })
        captureBehaviorOutcome({ nativeId, state: 'completed', activity: 'settled', outcome: 'clean', completedAt: new Date().toISOString() })
      }
      await starting
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Ledger HTTP fixture did not bind')
      const durations: number[] = []
      const read = async (query: string): Promise<LedgerReply> => {
        const startedAt = performance.now()
        const response = await fetch(`http://127.0.0.1:${address.port}/api/behavior-ledger?${query}`, { signal: AbortSignal.timeout(2000) })
        const body = await response.json() as LedgerReply
        durations.push(performance.now() - startedAt)
        expect(response.status).toBe(200)
        expect(durations.at(-1)).toBeLessThan(2000)
        return body
      }
      const selector = `repository=${encodeURIComponent(repository.toLowerCase())}`
      const page = await read(`${selector}&number=2500&limit=2`)
      expect(page.records).toHaveLength(2)
      expect(page.records![0]).toEqual(target.records![0])
      expect(page.nextCursor).toBeNull()
      for (const query of [`${selector}&number=9999&limit=2`, 'repository=missing/project&number=2500&limit=2']) {
        expect((await read(query)).records).toEqual([])
      }
      expect((await read(`${selector}&number=2500&cursor=${encodeURIComponent(target.nextCursor!)}&limit=2`)).records)
        .toEqual(page.records!.slice(1))
      expect((await read(`${selector}&number=2500&parent=${target.records![0].id}`)).records).toEqual(page.records!.slice(1))
      expect((await read(`cursor=${encodeURIComponent(listing.nextCursor!)}&limit=50`)).records!.map(record => record.id))
        .toEqual(identities.slice(0, 50).map(record => record.id))
      await vi.waitFor(async () => {
        expect((await readBehaviorLedger({ operation: 'health' })).body.health.pending).toBe(0)
      }, { timeout: 5000 })
      const health = (await readBehaviorLedger({ operation: 'health' })).body.health
      expect(health).toMatchObject({ status: 'incomplete', pending: 0, dropped: coverage.dropped, gaps: coverage.gaps,
        coverageStart: coverage.coverageStart, generation: coverage.generation, detailFloor: coverage.detailFloor })
      expect(health.instances).toBe(10000)
      expect(health.changes).toBe(30000)
      for (const number of [6000, 6031]) {
        const captured = await read(`${selector}&number=${number}&limit=2`)
        expect(captured.records).toHaveLength(2)
        expect(captured.records!.every(record => record.state === 'completed' && record.activity === 'settled')).toBe(true)
      }
      const check = new Database(path, { readonly: true })
      try {
        expect(check.prepare('SELECT creation_seq,id,payload FROM ledger_instances WHERE creation_seq>64 AND creation_seq<=10000 ORDER BY creation_seq').all()).toEqual(identities)
        expect(check.prepare("SELECT key,value FROM ledger_meta WHERE key IN ('version','generation','cursor_key') ORDER BY key").all()).toEqual(metadata)
        expect(check.prepare("SELECT 1 FROM sqlite_master WHERE name='ledger_target'").get()).toBeDefined()
        expect(check.pragma('journal_mode', { simple: true })).toBe('delete')
      } finally { check.close() }
      const databaseBytes = statSync(path).size
      expect(databaseBytes).toBeLessThanOrEqual(DEFAULT_LEDGER_POLICY.maxPagesBytes)
      expect(databaseBytes).toBeGreaterThan(originalBytes)
      expect(databaseBytes - originalBytes).toBeLessThan(4 * 1024 * 1024)
      expect(peakJournalBytes).toBeGreaterThan(0)
      expect(peakJournalBytes).toBeLessThanOrEqual(65 * 1024 * 1024)
      expect(statSync(path + '-journal', { throwIfNoEntry: false })).toBeUndefined()
      expect(statSync(path + '-wal', { throwIfNoEntry: false })).toBeUndefined()
      expect(statSync(path + '.coverage.json').size).toBeLessThanOrEqual(8192)
      console.info('ledger retention-cap upgrade', { databaseBytes, databaseGrowthBytes: databaseBytes - originalBytes, peakJournalBytes, httpMs: durations })
    } finally {
      clearInterval(monitor)
      await stopBehaviorLedger()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 60000)

  it('accepts late readiness after the startup budget without losing queued capture', async () => {
    shortCallerBudgets()
    const observer = await fixture(`
      import { existsSync, watch } from 'node:fs';
      const release=new URL('./release',import.meta.url);
      let ready=false;
      const watcher=watch(new URL('.',import.meta.url),()=>check());
      function check() {
        if(ready||!existsSync(release)) return;
        ready=true; watcher.close();
        port.postMessage({ready:true,health,pending:[]});
      }
      port.on('message',request=>{
        if(request.observation?.type==='admit') health.instances++;
        port.postMessage({id:request.id,status:200,body:{version:1,health},pending:[]});
      });
      check();`, { readTimeoutMs: 30 })
    observer.capture(admission)
    expect(await observer.read({ operation: 'health' })).toMatchObject({
      status: 200, body: { health: { status: 'unavailable', unavailableReason: 'worker_unavailable', pending: 1, dropped: 0 } },
    })
    expect((await observer.read({ operation: 'list' })).status).toBe(503)
    await writeFile(join(directories.at(-1)!, 'release'), '')
    await vi.waitFor(async () => {
      expect(await observer.read({ operation: 'health' })).toMatchObject({
        status: 200, body: { health: { status: 'ok', pending: 0, dropped: 0, instances: 1 } },
      })
    }, { timeout: 1500, interval: 25 })
  })
})
