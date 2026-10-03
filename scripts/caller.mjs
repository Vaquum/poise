// The in-tree Caller: the three Python packages under caller/ and the
// virtualenv `npm run caller:setup` builds at caller/.venv. Poise runs
// Caller's CLIs from there; CALLER_BIN_ROOT and AGENT_INTERFACE_ROOT name
// another installation instead (the workspace image sets both).
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// One level below the repository root both here and in the dist/server.js
// bundle that inlines this module.
export const CALLER_ROOT = fileURLToPath(new URL('../caller', import.meta.url))

// Each package installs the CLI of its own name.
export const CALLER_PACKAGES = [
  { directory: 'agent_interface', name: 'agent-interface' },
  { directory: 'github_interface', name: 'github-interface' },
  { directory: 'github_datastore', name: 'github-datastore' },
]
export const CALLER_COMMANDS = CALLER_PACKAGES.map((pkg) => pkg.name)

function configuredPath(name, env) {
  const value = env[name]
  if (!value) return null
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path, got ${value}`)
  return value
}

/** agent-interface's project root; its CLI runs with this as the working directory. */
export function agentInterfaceRoot(env = process.env) {
  return configuredPath('AGENT_INTERFACE_ROOT', env) || join(CALLER_ROOT, 'agent_interface')
}

/** The directory Caller's three CLIs run from. */
export function callerBinRoot(env = process.env) {
  return configuredPath('CALLER_BIN_ROOT', env) || join(CALLER_ROOT, '.venv', 'bin')
}

/** `name` and `version` from the [project] table of a pyproject.toml. */
export function projectMetadata(text) {
  const project = {}
  let inProject = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inProject = line === '[project]'
      continue
    }
    const field = inProject && /^(name|version)\s*=\s*(["'])([^"']+)\2$/.exec(line)
    if (field) project[field[1]] = field[3]
  }
  if (!project.name || !project.version) throw new Error('no [project] name and version')
  return project
}

/** Each package's version, read from caller/<package>/pyproject.toml. */
export async function callerVersions(root = CALLER_ROOT) {
  const versions = {}
  for (const pkg of CALLER_PACKAGES) {
    const path = join(root, pkg.directory, 'pyproject.toml')
    let project
    try {
      project = projectMetadata(await readFile(path, 'utf8'))
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    if (project.name !== pkg.name) throw new Error(`${path} names ${project.name}, expected ${pkg.name}`)
    versions[pkg.name] = project.version
  }
  return versions
}
