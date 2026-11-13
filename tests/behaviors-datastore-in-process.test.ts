import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CheckSemaphore } from '../server/check-semaphore'
import { mocks, pr, loadModules, arrangeCli, datastoreHealthOutput, fixture } from './behaviors-runtime-fixture'

// Behaviors read the datastore's views on the in-process reader's thread, as
// the Board does, rather than starting github-datastore for each read; the
// CLI answers only what the reader declines or fails.
const reader = vi.hoisted(() => ({ view: vi.fn() }))
vi.mock('../server/datastore-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/datastore-reader')>()),
  readDatastoreView: reader.view,
}))

const OPEN = ['view', 'pr', '--status', 'open', '--format', 'json']
const betaPr = { ...pr, repo: 'beta/poise-test', number: 17, url: 'https://github.com/beta/poise-test/pull/17' }

async function arrange() {
  arrangeCli(true)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  const { database: db } = loaded
  db.setMeta('me', 'poise-user')
  const betaPath = join(fixture.tempRoot, 'beta.sqlite')
  db.db.prepare(`
    INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
    VALUES ('beta', ?, 1, 'ready', 'ready', 'poise-user')
  `).run(betaPath)
  const original = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
    if (command !== 'github-datastore') return original(command, args, options)
    const explicit = args[0] === '--db'
    if ((explicit ? args[2] : args[0]) === 'health') {
      const response = datastoreHealthOutput()
      const health = JSON.parse(response.stdout)
      health.database = explicit ? args[1] : join(fixture.tempRoot, 'github.sqlite')
      return { ...response, stdout: JSON.stringify(health) }
    }
    return { stdout: JSON.stringify(explicit ? [betaPr] : [pr]), stderr: '' }
  })
  db.setMeta('behavior_approve_prs_enabled', '1')
  loaded.behaviors.startBehaviorsRuntime()
  loaded.behaviors.setBehaviorCheckSlots(new CheckSemaphore(() => 64))
  return { ...loaded, betaPath }
}

const datastoreViews = () => mocks.runFile.mock.calls.filter(([command, args]) =>
  command === 'github-datastore' && (args[0] === '--db' ? args[2] : args[0]) === 'view')

describe('behaviors read the datastore in-process', () => {
  it('answers an organization\'s open pull requests from the reader without starting the CLI', async () => {
    reader.view.mockReset()
    reader.view.mockImplementation((path: string) => path.endsWith('beta.sqlite') ? Promise.resolve([betaPr]) : null)
    const { behaviors: runtime, betaPath } = await arrange()

    await runtime.runEnabledBehaviorsOnce()

    expect(reader.view).toHaveBeenCalledWith(betaPath, OPEN)
    // Only the organization without a datastore file of its own asks the CLI.
    expect(datastoreViews().map(([, args]) => args[0])).toEqual(['view'])
  })

  it('asks the CLI when the reader fails, and says so once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    reader.view.mockReset()
    reader.view.mockImplementation((path: string) => path.endsWith('beta.sqlite') ? Promise.reject(new Error('no such table: prs')) : null)
    const { behaviors: runtime, betaPath } = await arrange()

    await runtime.runEnabledBehaviorsOnce()
    await runtime.runEnabledBehaviorsOnce()

    expect(datastoreViews().filter(([, args]) => args[0] === '--db')).toContainEqual(
      ['github-datastore', ['--db', betaPath, ...OPEN], expect.anything()])
    const reported = error.mock.calls.filter(([message]) => String(message).includes('in-process datastore read failed'))
    expect(reported).toHaveLength(1)
  })
})
