import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { behaviorDiagnosticGroups } from '../src/behavior-diagnostics'
import { notificationItems } from '../src/notification-items'
import { arrangeCli, fixture, loadModules, mocks, restartModules } from './behaviors-runtime-fixture'
import type { NativeChainHooks } from '../server/behavior-chain-native'

let logging: typeof import('../server/logging') | null = null
afterEach(async () => { await logging?.stopLogging(); logging = null; vi.unstubAllEnvs() })

type Probe = { code?: number, signal?: string, stdout: string, stderr?: string }
const probes: Record<string, Probe> = {}

function health(database: string, age = 150, lastSuccessAt = new Date(Date.now() - age * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')): Probe {
  return { code: age > 120 ? 1 : 0, stdout: JSON.stringify({ action: 'health', database,
    status: age > 120 ? 'stale' : 'healthy', healthy: age <= 120, max_age_seconds: 120,
    age_seconds: age, last_success_at: lastSuccessAt }),
    stderr: age > 120 ? `datastore health stale: last successful sync ${lastSuccessAt}; age ${age}s exceeds maximum 120s\n` : '' }
}

function saveProbe(database: string, probe: Probe): void {
  probes[database] = probe
  writeFileSync(join(fixture.tempRoot, 'health.json'), JSON.stringify(probes))
}

async function start() {
  for (const key of Object.keys(probes)) delete probes[key]
  arrangeCli(false)
  fixture.listedPrs = []
  const loaded = await loadModules()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_review_new_prs_keyver', '3')
  loaded.database.recordSeen('review-new-prs', '__snapshot_v3__')
  loaded.behaviors.startBehaviorsRuntime()
  for (const behavior of ['review_new_prs', 'approve_prs', 'resolve_unblocking']) {
    loaded.database.setMeta(`behavior_${behavior}_enabled`, '1')
  }
  const database = join(fixture.tempRoot, 'github.sqlite')
  const bin = join(fixture.tempRoot, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'github-datastore'), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
const database = args[0] === '--db' ? args[1] : ${JSON.stringify(database)};
const probe = JSON.parse(fs.readFileSync(${JSON.stringify(join(fixture.tempRoot, 'health.json'))}, 'utf8'))[database];
process.stdout.write(probe.stdout);
process.stderr.write(probe.stderr || '');
if (probe.signal) process.kill(process.pid, probe.signal);
else process.exitCode = probe.code || 0;
`, { mode: 0o700 })
  vi.stubEnv('CALLER_BIN_ROOT', bin)
  const original = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation((command: string, args: string[], options: import('../server/process').RunFileOptions) => {
    if (command === 'github-datastore' && args.includes('health')) return mocks.realRunFile!(command, args, options)
    if (command === 'agent-interface' && args[0] === '--diagnostics') return Promise.resolve({ stdout: JSON.stringify({ version: 1,
      streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '' })
    return original(command, args, options)
  })
  logging = await import('../server/logging')
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  logging.startLogging()
  saveProbe(database, health(database))
  return { ...loaded, path: database }
}

function events() {
  const runtime = logging!.loggingRuntime()!
  while (runtime.health().queued) expect(runtime.flush()).toBe(true)
  return runtime.query((store) => store.query({ workspace: 'local', operator: false }, { limit: 100 })).events
}

function episodes(database: typeof import('../server/db')) {
  return database.db.prepare("SELECT value FROM meta WHERE key LIKE 'datastore_stale:%'").all()
    .map((row) => JSON.parse((row as { value: string }).value)) as Array<{
      id: string, database: string, startedAt: string, first: { ageSeconds: number }, latest: { ageSeconds: number, lastSuccessAt: string }, behaviors: string[], recoveredAt: string | null,
    }>
}

it('reports concurrent refusals and changing ages once per mirror through the real process observer', async () => {
  const { database, behaviors, path } = await start()
  const beta = join(fixture.tempRoot, 'beta.sqlite')
  database.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
    VALUES ('beta', ?, 1, 'ready', 'ready', 'poise-user')`).run(beta)
  saveProbe(beta, health(beta, 160))
  await behaviors.runEnabledBehaviorsOnce()
  const first = episodes(database)
  expect(first).toHaveLength(2)
  for (const episode of first) expect(episode.behaviors.sort()).toEqual(['approve-prs', 'resolve-unblocking', 'review-new-prs'])
  expect(behaviors.getBehaviorsRuntimeHealth().failures).toHaveLength(6)
  const groups = behaviorDiagnosticGroups({ ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null })
  expect(groups).toHaveLength(2)
  expect(groups.every((group) => group.code === 'datastore_stale' && group.entries.length === 3)).toBe(true)
  expect(events()).toHaveLength(2)
  const items = notificationItems([], { ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null }, Date.now())
  expect(new Set(items.map((item) => item.id)).size).toBe(2)
  expect(events().every((event) => event.operation === 'github-datastore.stale' && event.phase === 'opened' && event.occurrences === 1)).toBe(true)
  saveProbe(path, health(path, 210, first.find((episode) => episode.database === path)!.latest.lastSuccessAt))
  saveProbe(beta, health(beta, 220, first.find((episode) => episode.database === beta)!.latest.lastSuccessAt))
  await behaviors.runEnabledBehaviorsOnce()
  expect(episodes(database).map((episode) => [episode.id, episode.startedAt, episode.first])).toEqual(first.map((episode) => [episode.id, episode.startedAt, episode.first]))
  expect(episodes(database).map((episode) => episode.latest.ageSeconds).sort()).toEqual([210, 220])
  expect(events()).toHaveLength(2)
  expect(behaviorDiagnosticGroups({ ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null })).toHaveLength(2)
  expect(notificationItems([], { ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null }, Date.now()).map((item) => item.id)).toEqual(items.map((item) => item.id))
  expect(mocks.runFile.mock.calls.some(([command, args]) => command === 'github-datastore' && args.includes('view'))).toBe(false)
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})

it('keeps one diagnostic and notification when a stale replay refreshes age between ticks', async () => {
  const { database, behaviors, path } = await start()
  await behaviors.runEnabledBehaviorsOnce()
  const [episode] = episodes(database)
  const before = behaviors.getBehaviorsRuntimeHealth()
  const [notice] = notificationItems([], { ...before, agentLogsError: null }, Date.now())
  expect(before.failures).toHaveLength(3)
  expect(before.failures.every(failure => failure.error?.includes('age 150s'))).toBe(true)

  saveProbe(path, health(path, 210, episode.latest.lastSuccessAt))
  await expect(behaviors.admitReplay('pr_review', 'Vaquum/poise-test', 17)).rejects.toThrow('age 210s exceeds 120s')
  const after = behaviors.getBehaviorsRuntimeHealth()
  expect(after.datastore).toMatchObject({ ageSeconds: 210, error: expect.stringContaining('age 210s') })
  expect(after.failures).toEqual(before.failures)
  expect(episodes(database)[0]).toMatchObject({ id: episode.id, latest: { ageSeconds: 210 }, recoveredAt: null })
  expect(behaviorDiagnosticGroups({ ...after, agentLogsError: null })).toEqual([
    expect.objectContaining({ code: 'datastore_stale', entries: expect.any(Array) }),
  ])
  expect(notificationItems([], { ...after, agentLogsError: null }, Date.now())).toEqual([
    expect.objectContaining({ id: notice.id }),
  ])
  expect(events()).toHaveLength(1)
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})

it('keeps a stale episode open across a crash and restart, and rearms only on validated health', async () => {
  let { database, behaviors, path } = await start()
  await behaviors.runEnabledBehaviorsOnce()
  const [first] = episodes(database)
  const [notice] = notificationItems([], { ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null }, Date.now())
  saveProbe(path, { ...health(path), signal: 'SIGTERM', stderr: 'datastore crashed' })
  await behaviors.runEnabledBehaviorsOnce()
  expect(episodes(database)[0]).toMatchObject({ id: first.id, recoveredAt: null })
  expect(events().filter((event) => event.operation === 'github-datastore.stale')).toHaveLength(1)
  expect(events().some((event) => event.signal === 'SIGTERM' && event.stderr === 'datastore crashed')).toBe(true)
  expect(behaviorDiagnosticGroups({ ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null }).filter((group) => group.code === 'datastore_stale')).toHaveLength(1)
  saveProbe(path, health(path, 240, first.latest.lastSuccessAt))
  await behaviors.runEnabledBehaviorsOnce()
  expect(events().filter((event) => event.operation === 'github-datastore.stale')).toHaveLength(1)
  await logging!.stopLogging()
  ;({ database, behaviors } = await restartModules())
  behaviors.startBehaviorsRuntime()
  logging = await import('../server/logging')
  logging.startLogging()
  await behaviors.runEnabledBehaviorsOnce()
  expect(episodes(database)[0].id).toBe(first.id)
  expect(events().filter((event) => event.operation === 'github-datastore.stale')).toHaveLength(1)
  const recoveredProbe = health(path, 1)
  saveProbe(path, recoveredProbe)
  await behaviors.runEnabledBehaviorsOnce()
  expect(episodes(database)[0].recoveredAt).not.toBeNull()
  expect(behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', failures: [] })
  const recovery = events().find((event) => event.phase === 'recovered')!
  expect(recovery).toMatchObject({ correlationId: first.id, context: { blockedBehaviors: expect.arrayContaining(first.behaviors) } })
  // Syncs stopping after recovery re-arms on the same last_success_at with a
  // grown age; an older sync generation would be an outdated overlapping
  // probe and must not reopen.
  saveProbe(path, health(path, 180, JSON.parse(recoveredProbe.stdout).last_success_at))
  await behaviors.runEnabledBehaviorsOnce()
  expect(episodes(database)[0].id).not.toBe(first.id)
  const [rearmedNotice] = notificationItems([], { ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null }, Date.now())
  expect(rearmedNotice.id).not.toBe(notice.id)
  const opened = events().filter((event) => event.operation === 'github-datastore.stale' && event.phase === 'opened')
  expect(opened).toHaveLength(2)
  expect(new Set(opened.map((event) => event.incidentId)).size).toBe(2)
  expect(recovery.incidentId).toBe(opened.find((event) => event.correlationId === first.id)!.incidentId)
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})

it('retains the latest evidence when stale and healthy observations arrive out of order', async () => {
  const { database, behaviors, path } = await start()
  const { runDatastoreHealth } = await import('../server/datastore-health')
  const org = (await import('../server/organizations')).readyOrganizations()[0]
  await behaviors.runEnabledBehaviorsOnce()
  const [first] = episodes(database)
  const [firstNotice] = notificationItems([], { ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null }, Date.now())
  const recoveredProbe = health(path, 1)
  const syncA = JSON.parse(recoveredProbe.stdout).last_success_at as string
  const syncB = new Date(Date.parse(syncA) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  saveProbe(path, recoveredProbe)
  await behaviors.runEnabledBehaviorsOnce()
  expect(episodes(database)[0]).toMatchObject({ id: first.id, recoveredAt: expect.any(String) })
  saveProbe(path, health(path, 0, syncB))
  await behaviors.runEnabledBehaviorsOnce()
  const [recovered] = episodes(database)
  expect(recovered.latest).toMatchObject({ lastSuccessAt: syncB, ageSeconds: 0 })
  // Sync A's stale reading arrives after the later healthy sync B.
  saveProbe(path, health(path, 150, syncA))
  await behaviors.runEnabledBehaviorsOnce()
  expect(episodes(database)).toEqual([recovered])
  expect(events()).toHaveLength(2)
  expect(behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', failures: [],
    datastore: { status: 'healthy', lastSuccessAt: syncB, ageSeconds: 0 } })
  expect(notificationItems([], { ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null }, Date.now())).toEqual([])

  saveProbe(path, health(path, 180, syncB))
  await behaviors.runEnabledBehaviorsOnce()
  const [second] = episodes(database)
  const [secondNotice] = notificationItems([], { ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null }, Date.now())
  expect(second.id).not.toBe(first.id)
  expect(secondNotice.id).not.toBe(firstNotice.id)
  // Neither an older sync nor an earlier healthy probe of this same sync
  // can close the new incident: delayed healthy probes reject with the open
  // episode so scans and replay stay refused. An older stale result also
  // keeps its ID.
  for (const delayed of [health(path, 1, syncA), health(path, 1, syncB), health(path, 150, syncB)]) {
    saveProbe(path, delayed)
    await expect(runDatastoreHealth(org)).rejects.toMatchObject({ episode: { id: second.id } })
    expect(episodes(database)).toEqual([second])
    expect(behaviors.getBehaviorsRuntimeHealth().datastore).toMatchObject({ status: 'unavailable', lastSuccessAt: syncB, ageSeconds: 180 })
  }
  // A delayed healthy probe from native discovery still records its blocked
  // behavior without replacing the retained evidence.
  saveProbe(path, health(path, 1, syncA))
  await expect(runDatastoreHealth(org, {}, ['review-new-issues'])).rejects.toMatchObject({ episode: { id: second.id } })
  expect(episodes(database)[0]).toMatchObject({ id: second.id, latest: { lastSuccessAt: syncB, ageSeconds: 180 } })
  expect(episodes(database)[0].behaviors).toEqual(expect.arrayContaining(['review-new-issues']))
  // An outdated stale probe still records a new blocked behavior without
  // replacing the retained evidence or opening another episode.
  saveProbe(path, health(path, 150, syncA))
  await expect(runDatastoreHealth(org, {}, ['approve-pr'])).rejects.toMatchObject({ episode: { id: second.id } })
  expect(episodes(database)).toHaveLength(1)
  expect(episodes(database)[0]).toMatchObject({ id: second.id, latest: { lastSuccessAt: syncB, ageSeconds: 180 } })
  expect(episodes(database)[0].behaviors).toEqual(expect.arrayContaining(['review-new-issues', 'approve-pr']))
  expect(events().filter((event) => event.phase === 'opened')).toHaveLength(2)
  // Outdated results through the normal freshness gate keep the retained
  // sync B evidence instead of overwriting it with older observations.
  for (const outdated of [health(path, 150, syncA), health(path, 1, syncA)]) {
    saveProbe(path, outdated)
    await behaviors.runEnabledBehaviorsOnce()
    expect(episodes(database)[0]).toMatchObject({ id: second.id, latest: { lastSuccessAt: syncB, ageSeconds: 180 } })
    expect(behaviors.getBehaviorsRuntimeHealth().datastore).toMatchObject({ status: 'unavailable', lastSuccessAt: syncB, ageSeconds: 180 })
  }
  expect(events().filter((event) => event.phase === 'opened')).toHaveLength(2)
  saveProbe(path, health(path, 210, syncB))
  await behaviors.runEnabledBehaviorsOnce()
  expect(episodes(database)[0]).toMatchObject({ id: second.id, recoveredAt: null, latest: { lastSuccessAt: syncB, ageSeconds: 210 } })
  expect(events().filter((event) => event.phase === 'opened')).toHaveLength(2)
  expect(events().filter((event) => event.phase === 'recovered')).toHaveLength(1)
  expect(events()).toHaveLength(3)
  expect(notificationItems([], { ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null }, Date.now())).toEqual([
    expect.objectContaining({ id: secondNotice.id }),
  ])
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})

it('reports a stale review scope through the open episode without new faults on retry', async () => {
  const { database, path } = await start()
  // Fresh module graph: the static bindings predate this test's POISE_DB.
  const { repairReportReviewScope } = await import('../server/behavior-chain-report')
  const { StaleDatastoreError } = await import('../server/datastore-health')
  database.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
    VALUES ('beta', ?, 1, 'ready', 'ready', 'poise-user')`).run(path)
  database.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('behavior_chain_repair_report:test',
    JSON.stringify({ source: 'beta/repo#7', issueNumber: 7 }))
  const chain = { repository: 'beta/repo', issue: 7 } as never
  saveProbe(path, health(path, 150))
  const first = await repairReportReviewScope(database.db, chain, 21).then(() => { throw new Error('scope was admitted') },
    (error: unknown) => error as InstanceType<typeof StaleDatastoreError>)
  expect(first).toBeInstanceOf(StaleDatastoreError)
  expect(first.episode.behaviors).toEqual(expect.arrayContaining(['review-pr', 'approve-pr']))
  const retry = await repairReportReviewScope(database.db, chain, 21).then(() => { throw new Error('scope was admitted') },
    (error: unknown) => error as InstanceType<typeof StaleDatastoreError>)
  expect(retry.episode.id).toBe(first.episode.id)
  expect(episodes(database)).toHaveLength(1)
  expect(events().filter((event) => event.operation === 'github-datastore.stale' && event.phase === 'opened')).toHaveLength(1)
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})

it.each(['unavailable', 'malformed', 'mismatched', 'wrong-limit', 'invalid-age', 'failed-healthy', 'stale-with-fault-stderr', 'stale-with-extra-stderr'] as const)(
  'keeps %s health failures separate while a stale episode is open', async (kind) => {
    const { database, behaviors, path } = await start()
    await behaviors.runEnabledBehaviorsOnce()
    const [first] = episodes(database)
    const data = JSON.parse(health(path).stdout)
    if (kind === 'unavailable') data.status = 'unavailable'
    if (kind === 'mismatched') {
      vi.stubEnv('POISE_DATASTORE_DB', path)
      data.database = '/different/account.sqlite'
    }
    if (kind === 'wrong-limit') data.max_age_seconds = 300
    if (kind === 'invalid-age') data.age_seconds = -1
    const probe = kind === 'failed-healthy' ? { ...health(path, 1), code: 1 }
      : { code: 1, stdout: kind === 'malformed' ? '{invalid' : JSON.stringify(data),
        stderr: (kind === 'stale-with-extra-stderr' ? health(path).stderr : '') + 'independent health fault' }
    saveProbe(path, probe)
    await behaviors.runEnabledBehaviorsOnce()
    expect(episodes(database)[0]).toMatchObject({ id: first.id, recoveredAt: null })
    expect(events().filter((event) => event.operation === 'github-datastore.stale')).toHaveLength(1)
    expect(events().some((event) => event.operation.startsWith('github-datastore') && event.exitCode === 1)).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  },
)

it('shares reporting with native discovery and cutover without admitting a failed probe', async () => {
  const { database, behaviors, path } = await start()
  const org = (await import('../server/organizations')).readyOrganizations()[0]
  const { nativeChainOperations } = await import('../server/behavior-chain-native')
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const hooks: NativeChainHooks = { existing: vi.fn(async () => new Set<string>()),
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => '', wake: () => {} }
  const native = nativeChainOperations(org, hooks)
  const [discovery] = await Promise.allSettled([native.discover(), behaviors.runEnabledBehaviorsOnce()])
  expect(discovery).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('Datastore stale') }) })
  expect(episodes(database)[0].behaviors.sort()).toEqual(['approve-prs', 'resolve-unblocking', 'review-new-issues', 'review-new-prs'])
  const journal = (await import('../server/behavior-chain-journal')).behaviorChainJournal()
  journal.changeAdmission(0, 'draining')
  await behaviors.runEnabledBehaviorsOnce()
  expect(journal.cutover().mode).toBe('draining')
  expect(behaviors.getBehaviorChainRuntimeHealth()).toEqual(expect.arrayContaining([expect.objectContaining({ organization: '@cutover', error: expect.stringContaining('Datastore stale') })]))
  expect(events()).toHaveLength(1)
  expect(hooks.existing).not.toHaveBeenCalled()
  // The real native sweep must not log its nested catches as new faults.
  database.setMeta('behavior_chain_settings', JSON.stringify({ enabled: true, seedMode: 'all', label: 'poise' }))
  journal.changeAdmission(journal.cutover().sequence, 'v2')
  await behaviors.runEnabledBehaviorsOnce()
  expect(events()).toHaveLength(1)
  expect(behaviorDiagnosticGroups({ ...behaviors.getBehaviorsRuntimeHealth(), agentLogsError: null })).toHaveLength(1)
  // Native intake historically admits by exit status. Bad successful output
  // reports its own fault, but cannot establish recovery of the stale episode.
  saveProbe(path, { code: 0, stdout: '{}' })
  await expect(native.discover()).resolves.toEqual([])
  expect(episodes(database)[0].recoveredAt).toBeNull()
  expect(events()).toHaveLength(2)
  expect(events().some((event) => event.operation === 'github-datastore.health' && event.exitCode === 0)).toBe(true)
  saveProbe(path, health(path, 1))
  await expect(native.discover()).resolves.toEqual([])
  expect(episodes(database)[0].recoveredAt).not.toBeNull()
  expect(behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', datastore: { status: 'healthy' }, failures: [], runtimeError: null })
  expect(events().filter((event) => event.phase === 'recovered')).toHaveLength(1)
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})

it('drops the stale episode from runtime health once its behaviors are disabled', async () => {
  const { database, behaviors } = await start()
  await behaviors.runEnabledBehaviorsOnce()
  expect(episodes(database)).toHaveLength(1)
  expect(behaviors.getBehaviorsRuntimeHealth().failures.length).toBeGreaterThan(0)
  for (const behavior of ['review-new-prs', 'approve-prs', 'resolve-unblocking'] as const) {
    await behaviors.setEnabled(behavior, false)
  }
  const health = behaviors.getBehaviorsRuntimeHealth()
  expect(health.failures).toEqual([])
  expect(health.status).toBe('ok')
  expect(episodes(database)[0].recoveredAt).toBeNull()
  expect(events()).toHaveLength(1)
})

it('retains a failed recovery command separately from the stale episode', async () => {
  const { database, behaviors } = await start()
  const recovery = await import('../server/legacy-datastore-recovery')
  vi.spyOn(recovery, 'recoverLegacyDatastore').mockRejectedValue(new Error('recovery command failed independently'))
  await behaviors.runEnabledBehaviorsOnce()
  expect(episodes(database)).toHaveLength(1)
  expect(events().filter((event) => event.operation === 'github-datastore.stale')).toHaveLength(1)
  expect(events().some((event) => event.message.includes('recovery command failed independently'))).toBe(true)
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})
