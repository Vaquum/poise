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

const domain = 'gui/501'
const target = `${domain}/${CATALOG_LABEL}`
const plistMissing = async () => {
  await expect(readFile(catalogPlistPath(launchAgents), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('retiring the legacy model-catalog launchd job', () => {
  it('unloads the job and removes its plist, leaving other jobs alone', async () => {
    const calls = []
    await writeFile(catalogPlistPath(launchAgents), legacyPlist())
    const neighbor = join(launchAgents, 'com.vaquum.poise.health.plist')
    await writeFile(neighbor, 'health')
    const retired = await retireCatalogJob({
      launchAgents,
      domain,
      run: async (command, args, options) => { calls.push([command, ...args]) },
    })
    expect(retired).toEqual({ unloaded: true })
    expect(calls).toEqual([['/bin/launchctl', 'bootout', target]])
    await plistMissing()
    await expect(readFile(neighbor, 'utf8')).resolves.toBe('health')
  })

  it('still removes the plist when there is nothing to unload', async () => {
    const calls = []
    await writeFile(catalogPlistPath(launchAgents), legacyPlist())
    const retired = await retireCatalogJob({
      launchAgents,
      domain,
      run: async (command, args, options) => {
        calls.push([command, ...args])
        throw new Error(`Could not find service "${CATALOG_LABEL}" in domain for user ${domain}`)
      },
    })
    expect(retired).toEqual({ unloaded: false })
    expect(calls).toEqual([['/bin/launchctl', 'bootout', target], ['/bin/launchctl', 'print', target]])
    await plistMissing()
  })

  it('is a no-op on a first install', async () => {
    const retired = await retireCatalogJob({
      launchAgents,
      domain,
      run: async () => { throw Object.assign(new Error(`/bin/launchctl failed (exit 113)`), { code: 113 }) },
    })
    expect(retired).toEqual({ unloaded: false })
    await plistMissing()
  })

  it('reads every runner\'s not-loaded answer as absent', async () => {
    // The updater's runner reports the bare exit instead.
    const retired = await retireCatalogJob({
      launchAgents,
      domain,
      run: async () => { throw new Error('/bin/launchctl exited 113') },
    })
    expect(retired).toEqual({ unloaded: false })
  })

  it('fails the install when the old job is still loaded', async () => {
    await writeFile(catalogPlistPath(launchAgents), legacyPlist())
    const calls = []
    const failure = await retireCatalogJob({
      launchAgents,
      domain,
      run: async (command, args, options) => {
        calls.push(args[0])
        if (args[0] === 'bootout') throw new Error('/bin/launchctl failed (exit 1): Operation not permitted')
        return `${target} = {\n\tstate = running\n\truns = 12\n}`
      },
    }).then(() => null, (error) => error)
    expect(failure?.message).toContain(`Could not unload the legacy ${CATALOG_LABEL} launchd job`)
    expect(failure?.message).toContain('two model-check schedulers')
    expect(calls).toEqual(['bootout', 'print'])
    // The plist stays: removing it while the job is loaded would hide the
    // second scheduler, not stop it.
    await expect(readFile(catalogPlistPath(launchAgents), 'utf8')).resolves.toContain('StartCalendarInterval')
  })

  it('fails when launchd itself cannot be read', async () => {
    await writeFile(catalogPlistPath(launchAgents), legacyPlist())
    const failure = await retireCatalogJob({
      launchAgents,
      domain,
      run: async (command, args, options) => {
        if (args[0] === 'bootout') throw new Error('/bin/launchctl failed (exit 1)')
        throw new Error('/bin/launchctl failed (exit 1): Database error')
      },
    }).then(() => null, (error) => error)
    expect(failure?.message).toContain('Database error')
    await expect(readFile(catalogPlistPath(launchAgents), 'utf8')).resolves.toContain('StartCalendarInterval')
  })
})
