import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalize } from '../src/diagnostics/contract.js'
import { DEFAULT_LOG_POLICY, DiagnosticStore } from '../src/diagnostics/store.js'

it('measures representative operational evidence against the default bounded storage policy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-log-volume-'))
  const path = join(directory, 'logging.db')
  const store = new DiagnosticStore(path)
  try {
    const cases = [
      { source: 'caller', operation: 'git.fetch', level: 'error', message: 'Git fetch failed', stderr: 'fatal: unable to access repository: connection reset\n' },
      { source: 'poise', operation: 'datastore.sync', level: 'error', message: 'Database is locked', context: { account: 'fixture', phase: 'incremental_sync', retryCount: 1, nextRetryAt: Date.now() + 60000 } },
      { source: 'docker', operation: 'container.oom', level: 'critical', message: 'Docker reported a container OOM kill', resources: { memoryLimitBytes: 536870912, oomKilled: true } },
      { source: 'kernel', operation: 'kernel.diagnostic', level: 'warning', message: 'filesystem pressure: free inodes below configured limit', resources: { freeInodes: 500, totalInodes: 100000 } },
      { source: 'ingress', operation: 'proxy.failed', level: 'error', message: 'dial tcp: connection refused', context: { method: 'GET', route: '/api/service', durationMs: 12 } },
    ]
    const events = cases.flatMap((input, index) => Array.from({ length: 20 }, (_, occurrence) => normalize({ ...input, id: `${index}:${occurrence}`, workspace: 'fixture' })!))
    expect(store.append(events)).toBe(100)
    for (let i = 0; i < 1000; i++) expect(normalize({ source: 'poise', operation: 'routine', level: 'info', message: 'routine observation' })).toBeNull()
    const reader = new Database(path, { readonly: true })
    const usage = reader.prepare('SELECT SUM(bytes) AS bytes,COUNT(*) AS events FROM log_events').get() as { bytes: number; events: number }
    reader.close()
    const averageAccountedBytes = Math.ceil(usage.bytes / usage.events)
    const capacityAtFixtureSize = Math.floor(DEFAULT_LOG_POLICY.maxBytes / averageAccountedBytes)
    expect(capacityAtFixtureSize).toBeGreaterThan(10000)
    expect(usage.events).toBe(100)
    console.info('Logging fixture calibration', JSON.stringify({ events: usage.events, accountedBytes: usage.bytes, averageAccountedBytes, capacityAtFixtureSize, sqliteAllocatedBytes: [path, path + '-wal', path + '-shm'].reduce((bytes, file) => bytes + (existsSync(file) ? statSync(file).size : 0), 0), sourceCount: cases.length, routineEventsExcluded: 1000 }))
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
