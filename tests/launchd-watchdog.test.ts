import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assess, CATALOG_LABEL, catalogRetirementEnabled, createLaunchdWatchdog, graceMs, isNotLoaded, parseLaunchctlPrint,
  retireCatalogJob, startLaunchdWatchdog, watchdogLabels,
} from '../server/launchd-watchdog'

// What execFile rejects with: `launchctl print` exits 113 for a job that is not
// loaded; a timeout kills the child and leaves no exit code.
const notLoaded = () => Object.assign(new Error('Could not find service'), { code: 113 })
const timedOut = () => Object.assign(new Error('Command failed: /bin/launchctl print'), { killed: true, signal: 'SIGTERM', code: null })

// The shape `launchctl print gui/501/<label>` prints, trimmed. Nested blocks
// repeat `state =` one tab deeper, and must not be read as the service's own.
function printed({ state = 'not running', runs = 3876, interval = 60 }: { state?: string, runs?: number, interval?: number | null } = {}): string {
  return [
    'gui/501/com.vaquum.poise.caller-update = {',
    '\tactive count = 0',
    '\tpath = /Users/me/Library/LaunchAgents/com.vaquum.poise.caller-update.plist',
    `\tstate = ${state}`,
    '',
    '\tprogram = /opt/homebrew/opt/node@22/bin/node',
    `\truns = ${runs}`,
    '\tpended nondemand spawn = interval',
    '\tlast exit code = 0',
    '\tevent triggers = {',
    '\t\tcom.vaquum.poise.caller-update.interval = {',
    '\t\t\tstate = active',
    '\t\t}',
    '\t}',
    '\tendpoints = {',
    '\t\tstate = active',
    '\t}',
    ...(interval === null ? [] : [`\trun interval = ${interval} seconds`]),
    '}',
  ].join('\n')
}

const MIN = 60_000

describe('reading launchctl print', () => {
  it('reads the service state, run count and interval, not the nested blocks', () => {
    expect(parseLaunchctlPrint(printed())).toEqual({ running: false, runs: 3876, intervalSeconds: 60 })
    expect(parseLaunchctlPrint(printed({ state: 'running', runs: 2 }))).toEqual({ running: true, runs: 2, intervalSeconds: 60 })
  })

  it('accepts a job without an interval and rejects output that is not a service', () => {
    expect(parseLaunchctlPrint(printed({ interval: null }))?.intervalSeconds).toBeNull()
    expect(parseLaunchctlPrint('Could not find service "x" in domain for user gui: 501')).toBeNull()
  })
})

describe('deciding a job has gone quiet', () => {
  const job = { running: false, runs: 10, intervalSeconds: 60 }

  it('waits three intervals, and never less than three minutes', () => {
    expect(graceMs(job)).toBe(3 * MIN)
    expect(graceMs({ ...job, intervalSeconds: 120 })).toBe(6 * MIN)
    expect(graceMs({ ...job, intervalSeconds: 10 })).toBe(3 * MIN)
  })

  it('takes the first sighting as a baseline, not as silence', () => {
    expect(assess(undefined, job, 0)).toEqual({ next: { runs: 10, aliveAt: 0 }, kick: false })
  })

  it('treats a new run, a reset count or a running job as alive', () => {
    const quiet = { runs: 10, aliveAt: 0 }
    expect(assess(quiet, { ...job, runs: 11 }, 10 * MIN).kick).toBe(false)
    expect(assess(quiet, { ...job, runs: 0 }, 10 * MIN).kick).toBe(false)
    expect(assess(quiet, { ...job, running: true }, 10 * MIN)).toEqual({ next: { runs: 10, aliveAt: 10 * MIN }, kick: false })
  })

  it('starts a job that has not run for the grace period, then restarts the clock', () => {
    const quiet = { runs: 10, aliveAt: 0 }
    expect(assess(quiet, job, 3 * MIN - 1).kick).toBe(false)
    expect(assess(quiet, job, 3 * MIN)).toEqual({ next: { runs: 10, aliveAt: 3 * MIN }, kick: true })
  })
})

describe('the watchdog pass', () => {
  function harness(jobs: Record<string, { state?: string, runs?: number } | null | Error | string>) {
    let now = 0
    const calls: string[][] = []
    const logs: string[] = []
    const pass = createLaunchdWatchdog({
      labels: Object.keys(jobs),
      domain: 'gui/501',
      now: () => now,
      log: (message) => logs.push(message),
      run: async (args) => {
        calls.push(args)
        if (args[0] === 'kickstart') return ''
        const job = jobs[args[1].slice('gui/501/'.length)]
        if (job === null) throw notLoaded()
        if (job instanceof Error) throw job
        if (typeof job === 'string') return job
        return printed(job)
      },
    })
    return {
      pass, calls, logs, jobs,
      at: (ms: number) => { now = ms },
      // One more completed run, as launchd's counter would show it.
      ran: (label: string) => {
        const job = jobs[label]
        if (job && typeof job === 'object' && !(job instanceof Error)) job.runs = (job.runs ?? 0) + 1
      },
      kicks: () => calls.filter((args) => args[0] === 'kickstart').map((args) => args[1]),
    }
  }

  it('starts only the job whose timer stopped, and only once per grace period', async () => {
    const h = harness({
      'com.vaquum.poise.caller-update': { runs: 3876 },
      'com.vaquum.poise.health': { runs: 5 },
    })
    await h.pass()
    for (let minute = 1; minute <= 3; minute += 1) {
      h.at(minute * MIN)
      h.ran('com.vaquum.poise.health')
      await h.pass()
    }
    expect(h.kicks()).toEqual(['gui/501/com.vaquum.poise.caller-update'])
    expect(h.logs.join('\n')).toContain('com.vaquum.poise.caller-update runs every 60s but has not run for 3m')
    const tick = async (minute: number) => {
      h.at(minute * MIN)
      h.ran('com.vaquum.poise.health')
      await h.pass()
    }
    await tick(4)
    await tick(5)
    expect(h.kicks()).toHaveLength(1)
    await tick(6)
    expect(h.kicks()).toEqual(['gui/501/com.vaquum.poise.caller-update', 'gui/501/com.vaquum.poise.caller-update'])
  })

  it('leaves a job alone once a kick gets it running again', async () => {
    const h = harness({ 'com.vaquum.poise.caller-update': { runs: 1 } })
    await h.pass()
    h.at(3 * MIN)
    await h.pass()
    h.ran('com.vaquum.poise.caller-update')
    for (let minute = 4; minute <= 10; minute += 1) {
      h.at(minute * MIN)
      h.ran('com.vaquum.poise.caller-update')
      await h.pass()
    }
    expect(h.kicks()).toHaveLength(1)
  })

  it('skips a job that is not loaded and baselines it afresh when it returns', async () => {
    const h = harness({ 'com.vaquum.github-datastore.sync': null })
    await h.pass()
    h.at(10 * MIN)
    await h.pass()
    h.jobs['com.vaquum.github-datastore.sync'] = { runs: 0 }
    await h.pass()
    h.at(12 * MIN)
    await h.pass()
    expect(h.kicks()).toEqual([])
    h.at(13 * MIN)
    await h.pass()
    expect(h.kicks()).toEqual(['gui/501/com.vaquum.github-datastore.sync'])
  })

  it('keeps the baseline through a launchctl timeout, so a stall is still caught on time', async () => {
    const label = 'com.vaquum.poise.caller-update'
    const h = harness({ [label]: { runs: 3876 } })
    await h.pass()
    h.jobs[label] = timedOut()
    for (const minute of [1, 2]) {
      h.at(minute * MIN)
      await h.pass()
    }
    expect(h.logs).toEqual([`[launchd-watchdog] ${label}: could not read its launchd state (launchctl timed out after 10s); still watching`])
    h.jobs[label] = { runs: 3876 }
    h.at(3 * MIN)
    await h.pass()
    expect(h.kicks()).toEqual([`gui/501/${label}`])
  })

  it('says once when it cannot understand a job, and watches it again when it can', async () => {
    const label = 'com.vaquum.poise.health'
    const h = harness({ [label]: 'gui/501/com.vaquum.poise.health = {\n\tsomething new = 1\n}' })
    for (const minute of [0, 1, 2, 3, 4]) {
      h.at(minute * MIN)
      await h.pass()
    }
    expect(h.logs).toEqual([`[launchd-watchdog] ${label}: launchctl print output was not understood; this job is not watched until it is`])
    expect(h.kicks()).toEqual([])
    h.jobs[label] = { runs: 7 }
    await h.pass()
    h.at(7 * MIN)
    await h.pass()
    expect(h.kicks()).toEqual([`gui/501/${label}`])
    h.jobs[label] = 'unreadable again'
    await h.pass()
    expect(h.logs.filter((line) => line.includes('not understood'))).toHaveLength(2)
  })

  it('reports a failed kick and carries on with the other jobs', async () => {
    const logs: string[] = []
    let now = 0
    const kicked: string[] = []
    const pass = createLaunchdWatchdog({
      labels: ['a.one', 'a.two'],
      domain: 'gui/501',
      now: () => now,
      log: (message) => logs.push(message),
      run: async (args) => {
        if (args[0] === 'print') return printed()
        kicked.push(args[1])
        if (args[1].endsWith('a.one')) throw new Error('kickstart failed')
        return ''
      },
    })
    await pass()
    now = 3 * MIN
    await pass()
    expect(kicked).toEqual(['gui/501/a.one', 'gui/501/a.two'])
    expect(logs.some((line) => line.includes('could not start a.one: kickstart failed'))).toBe(true)
  })
})

describe('telling a missing job from a failed read', () => {
  it('treats only launchctl exit 113 as not loaded', () => {
    expect(isNotLoaded(notLoaded())).toBe(true)
    expect(isNotLoaded(timedOut())).toBe(false)
    expect(isNotLoaded(Object.assign(new Error('x'), { code: 5 }))).toBe(false)
    expect(isNotLoaded(null)).toBe(false)
  })
})

describe('enabling the watchdog', () => {
  it('accepts only well-formed labels', () => {
    expect(watchdogLabels('com.vaquum.poise.caller-update, com.vaquum.poise.health,,bad label,$(x)'))
      .toEqual(['com.vaquum.poise.caller-update', 'com.vaquum.poise.health'])
    expect(watchdogLabels(undefined)).toEqual([])
  })

  it('stays off unless the installer named the jobs', () => {
    expect(startLaunchdWatchdog({})).toBeNull()
    expect(startLaunchdWatchdog({ POISE_LAUNCHD_WATCHDOG: '' })).toBeNull()
  })
})

describe('retiring the legacy model-catalog job', () => {
  const domain = 'gui/501'
  const target = `${domain}/${CATALOG_LABEL}`

  it('stays off unless the installer named launchd jobs', () => {
    expect(catalogRetirementEnabled({})).toBe(false)
    expect(catalogRetirementEnabled({ POISE_LAUNCHD_WATCHDOG: '' })).toBe(false)
    expect(catalogRetirementEnabled({ POISE_LAUNCHD_WATCHDOG: 'com.vaquum.poise.health' })).toBe(process.platform === 'darwin')
  })

  it('unloads the job and removes its plist from an isolated home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poise-catalog-retire-'))
    try {
      const launchAgentsDir = join(root, 'Library', 'LaunchAgents')
      const calls: string[][] = []
      const removed: string[] = []
      const retired = await retireCatalogJob({
        domain,
        launchAgentsDir,
        run: async (args) => { calls.push(args); return '' },
        remove: async (path) => { removed.push(path) },
      })
      expect(retired).toEqual({ unloaded: true })
      expect(calls).toEqual([['bootout', target]])
      expect(removed).toEqual([join(launchAgentsDir, `${CATALOG_LABEL}.plist`)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes a real plist with the default remover and nothing loaded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poise-catalog-retire-'))
    try {
      const launchAgentsDir = join(root, 'Library', 'LaunchAgents')
      await mkdir(launchAgentsDir, { recursive: true })
      await writeFile(join(launchAgentsDir, `${CATALOG_LABEL}.plist`), 'legacy')
      const retired = await retireCatalogJob({
        domain,
        launchAgentsDir,
        run: async () => { throw notLoaded() },
      })
      expect(retired).toEqual({ unloaded: false })
      await expect(readFile(join(launchAgentsDir, `${CATALOG_LABEL}.plist`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails loudly when the old job is still loaded', async () => {
    const removed: string[] = []
    const failure = await retireCatalogJob({
      domain,
      run: async (args) => {
        if (args[0] === 'bootout') throw Object.assign(new Error('Operation not permitted'), { code: 1 })
        return printed({ state: 'running', runs: 12 })
      },
      remove: async (path) => { removed.push(path) },
    }).then(() => null, (error: unknown) => error as Error)
    expect(failure?.message).toContain(`could not unload the legacy ${CATALOG_LABEL} job`)
    expect(failure?.message).toContain('a second model-check scheduler')
    expect(removed).toEqual([])
  })

  it('fails when launchd itself cannot be read', async () => {
    const removed: string[] = []
    const failure = await retireCatalogJob({
      domain,
      run: async (args) => {
        if (args[0] === 'bootout') throw notLoaded()
        throw timedOut()
      },
      remove: async (path) => { removed.push(path) },
    }).then(() => null, (error: unknown) => error as Error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toContain('launchctl print')
    expect(removed).toEqual([])
  })
})
