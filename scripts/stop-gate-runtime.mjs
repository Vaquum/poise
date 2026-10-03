import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { callerVersions } from './caller.mjs'

function paths(home) {
  const root = join(home, '.local', 'share', 'caller-pr-stop-gate')
  return {
    root,
    python: join(root, 'bin', 'python'),
    agentInterface: join(root, 'bin', 'agent-interface'),
    githubInterface: join(root, 'bin', 'github-interface'),
    marker: join(root, 'release.json'),
  }
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** The Caller a gate is installed from: its source directory, the Poise
 *  commit that carries it and the package versions. */
export async function stopGateManifest({ callerRoot, commit }) {
  return { source: callerRoot, commit, packages: await callerVersions(callerRoot) }
}

function sameManifest(actual, expected) {
  return actual?.source === expected.source
    && actual?.commit === expected.commit
    && JSON.stringify(actual?.packages) === JSON.stringify(expected.packages)
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/

// Poise's saved settings, read from its database: the gate is configured
// while Poise may not be running.
async function savedSettings(home, run) {
  const database = join(home, '.poise', 'cache.db')
  // A first install precedes Poise's first start: nothing is saved yet.
  if (!await exists(database)) return {}
  const result = await run('/usr/bin/sqlite3', [
    '-json',
    database,
    "SELECT key, value FROM meta WHERE key IN ('org', 'me', 'agentAccount');",
  ], { capture: true })
  return Object.fromEntries(JSON.parse(result.stdout.trim() || '[]').map((row) => [row.key, row.value]))
}

function login(value, label) {
  const name = value?.trim()
  if (name && !GITHUB_LOGIN.test(name)) throw new Error(`Configured ${label} is invalid`)
  return name
}

async function gateEnvironment(home, run, environment = process.env) {
  const saved = await savedSettings(home, run)
  const organization = login(environment.POISE_GITHUB_ORG?.trim() || saved.org, 'GitHub organization')
  // The gate waits for the agent account saved in Settings; before Poise has
  // started, for the REVIEW_AGENT_USERNAME that will seed it.
  const agent = login('agentAccount' in saved ? saved.agentAccount : environment.REVIEW_AGENT_USERNAME, 'agent account')
  const me = login(saved.me, 'GitHub account')
  return {
    ...environment,
    ...(organization ? { CALLER_PR_GATE_SCOPE: `${organization}/*` } : {}),
    ...(agent ? { GITHUB_INTERFACE_AGENT_USER: agent } : {}),
    ...(me ? { CALLER_GITHUB_READER: me } : {}),
  }
}

export async function stopGateIsCurrent({ home, manifest }) {
  const hook = paths(home)
  try {
    const marker = JSON.parse(await readFile(hook.marker, 'utf8'))
    return sameManifest(marker, manifest)
      && await executable(hook.python)
      && await executable(hook.agentInterface)
      && await executable(hook.githubInterface)
  } catch {
    return false
  }
}

export async function configureStopGate({ home, run, environment = process.env }) {
  const hook = paths(home)
  if (!await executable(hook.agentInterface)) {
    throw new Error('Caller stop gate is not installed')
  }
  await run(hook.agentInterface, ['--install-pr-stop-gate'], {
    capture: true,
    env: await gateEnvironment(home, run, environment),
  })
}

export async function installStopGate({
  home,
  manifest,
  python,
  run,
  environment = process.env,
}) {
  const hook = paths(home)
  if (!await executable(hook.python)) {
    await mkdir(hook.root, { recursive: true, mode: 0o700 })
    await run(python, ['-m', 'venv', '--clear', hook.root])
  }
  await run(hook.python, ['-m', 'ensurepip', '--upgrade'], { capture: true })
  await run(hook.python, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--force-reinstall',
    join(manifest.source, 'github_interface'),
    join(manifest.source, 'agent_interface'),
  ])
  await configureStopGate({ home, run, environment })
  await writeFile(hook.marker, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await chmod(hook.marker, 0o600)
}
