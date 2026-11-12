import { parentPort } from 'node:worker_threads'
import { serializeError, startWorkerCall, type ChildOutcome, type ProcessWorkerReply, type ProcessWorkerRequest, type SerializedError } from './process-child'

// runFile's children, started off the main thread. On Linux, spawning forks the
// server and waits for the child to exec; under CPU contention that wait held
// the event loop (server/process.ts, runFile).

const port = parentPort
if (!port) throw new Error('process-worker runs only as a worker thread')

const aborts = new Map<number, () => void>()
const reply = (message: ProcessWorkerReply) => port.postMessage(message)

function cloneable(outcome: ChildOutcome): ChildOutcome<SerializedError> {
  const { termination, ...rest } = outcome
  if (!termination) return rest
  return { ...rest, termination: termination.kind === 'error' ? { kind: 'error', error: serializeError(termination.error) } : termination }
}

port.on('message', (message: ProcessWorkerRequest) => {
  if (message.type === 'abort') {
    aborts.get(message.id)?.()
    return
  }
  const { id, request, slot } = message
  const child = startWorkerCall(request, slot)
  if (!child) {
    // The main thread aborted the call before it started: its child never runs.
    reply({ type: 'done', id, outcome: { code: null, signal: null, stdout: '', stderr: '', termination: { kind: 'abort' } } })
    return
  }
  aborts.set(id, child.abort)
  void child.outcome.then((outcome) => {
    aborts.delete(id)
    reply({ type: 'done', id, outcome: cloneable(outcome) })
  })
})

reply({ type: 'ready' })
