import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

const require = createRequire(import.meta.url)
const { root, observerBundle, workerBundle, sqliteModule } = JSON.parse(process.argv[2])
const { BehaviorLedgerObserver } = require(observerBundle)
const Database = require(sqliteModule)
const databasePath = join(root, 'ledger.db')
const entered = join(root, 'native-entered')
const instrumentedWorker = join(root, 'native-worker.cjs')
// Only the fixture extends SQLite's busy wait. Production keeps timeout=0.
// This makes cancellation during a real native call deterministic.
writeFileSync(instrumentedWorker, `
const Database = require(${JSON.stringify(sqliteModule)});
const {parentPort} = require('node:worker_threads');
const {writeFileSync} = require('node:fs');
const transaction = Database.prototype.transaction;
let database;
Database.prototype.transaction = function (...args) {
  if (!database) {
    database = this;
    database.pragma('busy_timeout=5000');
  }
  return transaction.apply(this, args);
};
parentPort.on('message', request => {
  if(request.operation==='capture' && request.observation?.type==='admit') {
    writeFileSync(${JSON.stringify(entered)}, 'active');
  }
});
require(${JSON.stringify(workerBundle)});
`)
const observer = new BehaviorLedgerObserver({ path: databasePath, workerPath: instrumentedWorker })
const originalTerminate = Worker.prototype.terminate
let terminateCalls = 0
Worker.prototype.terminate = function () {
  terminateCalls++
  return originalTerminate.call(this)
}
await observer.start()
assert.equal((await observer.read({ operation: 'health' })).body.health.status, 'ok')
const holder = new Database(databasePath)
holder.exec('BEGIN EXCLUSIVE')
let locked = true
const unlock = () => {
  if (!locked) return
  locked = false
  holder.exec('ROLLBACK')
  holder.close()
}
let releaseTimer
try {
  const admission = { type: 'admit', admissionKey: 'active', nativeId: 'active', behavior: 'review-new-prs',
    source: 'poise:review-new-prs', owner: 'owner', actor: 'agent', repository: 'owner/repo', number: 1,
    head: 'a'.repeat(40), slot: 'primary', plannedSlots: ['primary'] }
  observer.capture(admission)
  const deadline = Date.now() + 5000
  while (!existsSync(entered)) {
    assert.ok(Date.now() < deadline, 'native capture was not entered')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  observer.capture({ ...admission, admissionKey: 'queued', nativeId: 'queued' })
  const worker = observer.worker
  assert.ok(worker)
  const exited = observer.waitForExit()
  // Keep the lock through SQLite's error path, then allow health/close to finish.
  releaseTimer = setTimeout(unlock, 6500)
  const started = performance.now()
  await observer.stop()
  const callerMs = performance.now() - started
  assert.equal(terminateCalls, 0, 'stop must not terminate an active native request')
  assert.ok(callerMs >= 1800 && callerMs < 3500, `stop budget: ${callerMs}`)
  assert.equal(observer.worker, worker, 'active worker must stay tracked after the caller deadline')
  assert.notEqual(worker.threadId, -1, 'the native request must remain alive')
  assert.equal(existsSync(instrumentedWorker), true)
  const pending = (await observer.read({ operation: 'health' })).body.health
  assert.equal(pending.pending, 1)
  assert.equal(pending.dropped, 1, 'only undispatched capture is lost at the deadline')
  await exited
  assert.equal(terminateCalls, 0, 'native work must settle without forced termination')
  assert.equal(observer.worker, null, 'worker is released only on actual exit')
  const journal = JSON.parse(readFileSync(databasePath + '.coverage.json', 'utf8'))
  assert.equal(journal.closed, true)
  assert.equal(journal.health.dropped, 2, 'queued capture and failed native capture must both be accounted')
  assert.ok(journal.health.gaps.some(gap => gap.reason === 'capture_loss'))
  console.log(JSON.stringify({ callerMs, naturalExit: true, trackedUntilExit: true, dropped: journal.health.dropped }))
} finally {
  clearTimeout(releaseTimer)
  unlock()
  await observer.stop()
  await observer.waitForExit()
  Worker.prototype.terminate = originalTerminate
}
