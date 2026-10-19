import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BehaviorLedgerObserver } from '../server/behavior-ledger'
import type { LedgerAdmission, LedgerHealth } from '../server/behavior-ledger-contract'

const health: LedgerHealth = {
  status: 'ok', coverageStart: '2026-10-19T00:00:00.000Z', observedAt: '2026-10-19T00:00:00.000Z',
  callerObservedAt: null, pending: 0, dropped: 0, gaps: [], generation: 'fixture', retainedFrom: null,
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
  await writeFile(workerPath, `import { parentPort as port } from 'node:worker_threads';\nconst health=${JSON.stringify(health)};\n${body}`)
  const observer = new BehaviorLedgerObserver({ workerPath, ...options })
  observers.push(observer)
  await observer.start()
  return observer
}
afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('bounded behavior ledger transport', () => {
  it('drops newest overflow, reserves a durable loss marker and never throws into work', async () => {
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
    expect(() => { observer.capture(admission); observer.capture({ ...admission, nativeId: 'dropped' }) }).not.toThrow()
    const reply = await observer.read({ operation: 'health' })
    expect(reply.status).toBe(200)
    expect(reply.body.health.dropped).toBe(1)
    expect(reply.body.health.pending).toBe(0)
    expect(reply.body.health.status).toBe('incomplete')
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
    expect(await first).toMatchObject({ status: 200, body: { health: { status: 'unavailable' } } })
    expect(() => observer.capture(admission)).not.toThrow()
    await vi.waitFor(async () => {
      expect(await observer.read({ operation: 'health' })).toMatchObject({ status: 200, body: { health: { status: 'ok', pending: 0, dropped: 0 } } })
    }, { timeout: 1500, interval: 25 })
  })

  it('keeps a failed startup observational and health readable', async () => {
    const observer = await fixture('throw new Error("fixture failed startup");')
    expect(() => observer.capture(admission)).not.toThrow()
    expect((await observer.read({ operation: 'get', id: 'a'.repeat(64) })).status).toBe(503)
    expect((await observer.read({ operation: 'health' })).body.health.status).toBe('unavailable')
  })
})
