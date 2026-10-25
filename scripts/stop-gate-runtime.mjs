import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { callerVersions } from './caller.mjs'
import { readSavedSettings } from './saved-settings.mjs'

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

// Identity the gate fixes into hooks comes only from saved Settings, or from
// the seed the first start writes there. Inherited identity variables are
// removed without being read: a cleared account must fail, never borrow the
// installer's shell. Kept in step with CALLER_ACCOUNT_ENV (server/process.ts)
// and the hook's own CALLER_PR_REVIEWER / CALLER_GITHUB_READER.
const INHERITED_IDENTITY_ENV = [
  'CALLER_PR_GATE_SCOPE',
  'CALLER_PR_REVIEWER',
  'GITHUB_INTERFACE_USER',
  'GITHUB_INTERFACE_AGENT_USER',
  'CALLER_GITHUB_READER',
]

function withoutInheritedIdentity(environment) {
  const scrubbed = { ...environment }
  for (const key of Object.keys(scrubbed)) {
    if (INHERITED_IDENTITY_ENV.some((name) => name.toLowerCase() === key.toLowerCase())) delete scrubbed[key]
  }
  return scrubbed
}

function login(value, label) {
  const name = value?.trim()
  if (name && !GITHUB_LOGIN.test(name)) throw new Error(`Configured ${label} is invalid`)
  return name
}

async function gateEnvironment(home, run, environment = process.env) {
  // The gate is configured while Poise may not be running, so Settings is
  // read from its database, the same one the server opens.
  const { present, settings: saved } = await readSavedSettings({ home, run, environment })
  const organization = login(saved.org, 'GitHub organization')
  const me = login(saved.me, 'GitHub account')
  let agent
  if (present) {
    // Settings decides, cleared included.
    agent = login(saved.agentAccount, 'agent account')
    if (!agent) throw new Error('No agent account is saved. Set the agent account in Settings → General: the stop gate waits for its approval.')
  } else {
    // A first install precedes Poise's first start: the gate waits for the
    // REVIEW_AGENT_USERNAME that start will seed Settings with.
    agent = login(environment.REVIEW_AGENT_USERNAME, 'agent account')
    if (!agent) throw new Error('No agent account is saved. Set REVIEW_AGENT_USERNAME so the first start seeds it, then install again.')
  }
  return {
    ...withoutInheritedIdentity(environment),
    ...(organization ? { CALLER_PR_GATE_SCOPE: `${organization}/*` } : {}),
    GITHUB_INTERFACE_AGENT_USER: agent,
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
