// Retiring the legacy personal-install model-catalog calendar job: the daily
// check runs inside the production server now, so the old job must be
// unloaded and its plist removed — never installed, unloaded or triggered
// for real here.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOG_LABEL, catalogPlistPath, retireCatalogJob } from '../scripts/model-catalog-job.mjs'

let root
let launchAgents
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-catalog-job-'))
  launchAgents = join(root, 'Library', 'LaunchAgents')
  await mkdir(launchAgents, { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function legacyPlist() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<plist version="1.0"><dict><key>Label</key><string>${CATALOG_LABEL}</string>`,
    '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>',
    '</dict></plist>',
    '',
  ].join('\n')
}

describe('retiring the legacy model-catalog launchd job', () => {
  it('unloads the job and removes its plist, leaving other jobs alone', async () => {
    const calls = []
    await writeFile(catalogPlistPath(launchAgents), legacyPlist())
    const neighbor = join(launchAgents, 'com.vaquum.poise.health.plist')
    await writeFile(neighbor, 'health')
    await retireCatalogJob({
      launchAgents,
      domain: 'gui/501',
      run: async (command, args, options) => { calls.push([command, ...args]) },
    })
    expect(calls).toEqual([['/bin/launchctl', 'bootout', `gui/501/${CATALOG_LABEL}`]])
    await expect(readFile(catalogPlistPath(launchAgents), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(neighbor, 'utf8')).resolves.toBe('health')
  })

  it('still removes the plist when there is nothing to unload', async () => {
    await writeFile(catalogPlistPath(launchAgents), legacyPlist())
    await retireCatalogJob({
      launchAgents,
      domain: 'gui/501',
      run: async () => { throw new Error('Could not find service') },
    })
    await expect(readFile(catalogPlistPath(launchAgents), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is a no-op on a first install', async () => {
    const calls = []
    await retireCatalogJob({
      launchAgents,
      domain: 'gui/501',
      run: async (command, args, options) => { calls.push([command, ...args]); throw new Error('Could not find service') },
    })
    expect(calls).toEqual([['/bin/launchctl', 'bootout', `gui/501/${CATALOG_LABEL}`]])
  })
})
