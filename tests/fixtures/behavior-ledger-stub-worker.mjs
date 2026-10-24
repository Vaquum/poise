// A ledger worker the health tests wedge on purpose: it reports ready,
// then answers nothing, so the observer's queue builds behind it. It still
// answers close (then exits), and it exits when the control file named by
// POISE_LEDGER_STUB_EXIT contains `exit`.
import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'

const health = {
  status: 'ok',
  unavailableReason: null,
  coverageStart: null,
  observedAt: new Date().toISOString(),
  callerObservedAt: null,
  pending: 0,
  dropped: 0,
  gaps: [],
  generation: 'stub',
  retainedFrom: null,
  changeLowerBound: null,
  lastSequence: null,
  instances: null,
  changes: null,
}
parentPort.postMessage({ ready: true, health, pending: [] })

const exitFile = process.env.POISE_LEDGER_STUB_EXIT
const poll = exitFile ? setInterval(() => {
  try {
    if (readFileSync(exitFile, 'utf8').trim() === 'exit') process.exit(0)
  } catch {
    // The control file is not written yet.
  }
}, 50) : null
parentPort.on('message', (request) => {
  // Captures and reads hang: the wedge. Only close is answered.
  if (request.operation !== 'close') return
  parentPort.postMessage({ id: request.id, status: 200, body: { version: 1, health }, pending: [] })
  if (poll) clearInterval(poll)
  parentPort.close()
})
