// Runs Poise in a workspace and restarts it onto a newly installed release
// without stopping the container (docs/Service-architecture.md, "Updates in
// place"). The agent processes Poise starts are detached: they keep running
// through a restart, tini adopts and reaps them, and the next Poise reconciles
// them as it does after any restart.
//
// Releases live in ~/.poise/releases/<name>/ as poise/, venv/, base and
// installed; the gateway installs them there with install-release.sh from a
// newer image of the same base. `current` names the release this workspace
// runs and `next` the one a switch asked for; Poise exits with 75 to switch.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'

export const UPDATE_EXIT_CODE = 75
// A release that exits this soon after starting, other than to switch, is not run again.
export const FAILED_START_MS = 60_000
const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

function read(path) {
  try {
    return readFileSync(path, 'utf8').trim() || null
  } catch {
    return null
  }
}

function replace(path, text) {
  writeFileSync(`${path}.tmp`, `${text}\n`)
  renameSync(`${path}.tmp`, path)
}

export function supervisor({
  home = process.env.HOME,
  image = { name: read('/opt/poise/RELEASE'), poise: '/opt/poise', venv: '/opt/caller/venv' },
  base = read('/opt/poise-runtime/BASE'),
  env = process.env,
  start = (release, childEnv) => spawn(process.execPath, [join(release.poise, 'dist', 'server.js')], {
    cwd: release.poise, env: childEnv, stdio: 'inherit',
  }),
  now = Date.now,
  log = (line) => console.log(`poise-runtime: ${line}`),
} = {}) {
  const releases = join(home, '.poise', 'releases')
  let stopping = false
  let child = null

  const installed = (name) => ({ name, poise: join(releases, name, 'poise'), venv: join(releases, name, 'venv') })

  const usable = (name) => {
    if (!name || !RELEASE_NAME.test(name) || !base) return false
    const dir = join(releases, name)
    return existsSync(join(dir, 'installed')) && !existsSync(join(dir, 'failed')) && read(join(dir, 'base')) === base
  }

  /** The release a switch asked for, else the current one, else this image's own. */
  const choose = () => {
    const next = read(join(releases, 'next'))
    if (next !== null) {
      rmSync(join(releases, 'next'), { force: true })
      if (usable(next)) {
        replace(join(releases, 'current'), next)
        return installed(next)
      }
      log(`release ${next} is not installed for this base; staying on the current one`)
    }
    const current = read(join(releases, 'current'))
    if (current !== null && current !== image.name && usable(current)) return installed(current)
    return image
  }

  const childEnv = (release) => {
    const local = join(home, '.local', 'bin')
    const rest = (env.PATH ?? '').split(':').filter((entry) => entry && entry !== local && !entry.startsWith('/opt/caller/venv'))
    return {
      ...env,
      PATH: [local, join(release.venv, 'bin'), ...rest].join(':'),
      CALLER_BIN_ROOT: join(release.venv, 'bin'),
      AGENT_INTERFACE_ROOT: join(release.poise, 'caller', 'agent_interface'),
      POISE_RELEASE: release.name ?? '',
      POISE_BASE: base ?? '',
    }
  }

  const runOnce = (release) => new Promise((resolve) => {
    child = start(release, childEnv(release))
    child.once('error', (error) => {
      log(`Poise could not start: ${error.message}`)
      child = null
      resolve(1)
    })
    child.once('exit', (code, signal) => {
      child = null
      resolve(code ?? 128 + (constants.signals[signal] ?? 0))
    })
  })

  return {
    /** Forwards a signal to Poise; the container is stopping, so Poise is not started again. */
    stop(signal) {
      stopping = true
      child?.kill(signal)
    },
    /** Runs Poise until the container stops, and resolves with the exit code to stop with. */
    async run() {
      for (;;) {
        const release = choose()
        const startedAt = now()
        log(`starting Poise, release ${release.name ?? 'unnamed'}`)
        const code = await runOnce(release)
        if (stopping) return code
        if (code === UPDATE_EXIT_CODE || existsSync(join(releases, 'next'))) continue
        if (release !== image && now() - startedAt < FAILED_START_MS) {
          writeFileSync(join(releases, release.name, 'failed'), `exited with ${code} within a minute of starting\n`)
          rmSync(join(releases, 'current'), { force: true })
          log(`release ${release.name} exited with ${code} soon after starting; going back to this image's release`)
          continue
        }
        return code
      }
    },
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const instance = supervisor()
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => instance.stop(signal))
  process.exitCode = await instance.run()
}
