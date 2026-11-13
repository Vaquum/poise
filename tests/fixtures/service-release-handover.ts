// Real service/monitor modules under the release supervisor. Only the remote
// reads are stand-ins: the first release holds its first read until asked,
// and would hold subsequent reads indefinitely if it failed to yield.
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { ChatControl } from '../../server/chat/control'
import * as store from '../../server/chat/control-store'
import { ChatRuntime, emptyCapabilities } from '../../server/chat/runtime'
import { insertSession } from '../../server/chat/storage'
import { closeDatabase } from '../../server/db'
import { ServiceControl, handleServiceApi } from '../../server/service/control'
import { CATALOG } from '../model-catalog-fixture'

const runtime = new ChatRuntime({ instance: 'release-handover', instanceLabel: 'test', callerTurns: null,
  catalog: async () => CATALOG, localWorkspaceRoot: join(process.env.HOME!, 'chat'),
  adapters: { grok: () => { throw new Error('the monitor must never start an agent') } } })
let session = runtime.list()[0]
if (!session) {
  const now = new Date().toISOString()
  session = { id: randomUUID(), instance: runtime.instance, agent: 'grok', model: 'grok-4.6-xhigh',
    modelId: 'grok-4.6', effort: 'xhigh', repo: '', checkout: process.env.HOME!,
    branch: { name: 'main', origin: 'existing', provisional: false }, title: 'Monitor owner',
    createdAt: now, updatedAt: now, status: 'idle', capabilities: emptyCapabilities(), lastSeq: 0, pendingRequests: [] }
  insertSession(session)
}
const targets = [1, 2, 3].map(number => `https://github.com/monitor/handover/pull/${number}`)
for (const target of targets) if (!store.bindings(runtime.instance).some(binding => binding.target === target)) {
  store.bindWork(runtime.instance, session.id, target)
}
let finishRead: (() => void) | undefined
let reading = false
const control = new ChatControl(runtime, {
  targetStatus: async () => 'open', reviews: async () => null,
  ci: async target => {
    appendFileSync(join(process.env.HOME!, 'reads'), `${target.number}\n`)
    if (process.env.POISE_RELEASE === '0'.repeat(40)) {
      reading = true
      await new Promise<void>(resolve => { finishRead = resolve })
      reading = false
    }
    return { head: 'a'.repeat(40), failing: [] }
  },
})
const service = new ServiceControl(runtime, { drainTimeoutSeconds: 60, canRestart: () => true,
  restart: () => { setImmediate(() => { void stop(75) }); return true } })
const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/service/')) {
    void Promise.resolve(handleServiceApi(req, res, req.url, { kind: 'local' }, service))
    return
  }
  if (req.url === '/finish-read') finishRead?.()
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ reading, bindings: store.bindings(runtime.instance),
    observations: targets.map(target => store.observation(runtime.instance, `ci:${target}`)) }))
})
control.attach(server)
await new Promise<void>(resolve => server.listen(Number(process.env.POISE_PORT), '127.0.0.1', resolve))
control.start()
let stopping = false
async function stop(code: number): Promise<void> {
  if (stopping) return
  stopping = true
  await control.stop()
  await runtime.stop()
  service.reset()
  await new Promise<void>(resolve => server.close(() => resolve()))
  closeDatabase()
  process.exit(code)
}
process.on('SIGTERM', () => { void stop(0) })
