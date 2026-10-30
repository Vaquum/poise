// `npm run caller:setup` builds caller/.venv with Python 3.13 and installs
// Caller's three packages into it, editable, plus pytest for their suites.
// The production installer builds the same virtualenv in its checkout.
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CALLER_COMMANDS, CALLER_PACKAGES, CALLER_ROOT, callerVersions } from './caller.mjs'

const PYTHON_VERSION = '3.13'
// Homebrew's opt links before PATH: a virtualenv keeps the interpreter path
// it was created with, and a Cellar path disappears with the next patch.
export const PYTHON_CANDIDATES = [
  '/opt/homebrew/opt/python@3.13/bin/python3.13',
  '/usr/local/opt/python@3.13/bin/python3.13',
  'python3.13',
]

export function run(command, args, { capture = false, env = process.env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('close', (code, signal) => {
      if (code === 0) return resolveRun({ stdout, stderr })
      const reason = signal ? `signal ${signal}` : `exit ${code}`
      rejectRun(new Error(`${command} failed (${reason})${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

async function pythonVersion(python, runCommand) {
  try {
    const { stdout } = await runCommand(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { capture: true })
    return stdout.trim()
  } catch {
    // A missing or broken interpreter is an answer here, not a failure.
    return null
  }
}

/** The Python 3.13 Caller is built with: POISE_PYTHON when set, otherwise
 *  the first 3.13 among the candidates. */
export async function callerPython({ env = process.env, candidates = PYTHON_CANDIDATES, run: runCommand = run } = {}) {
  if (env.POISE_PYTHON) {
    const version = await pythonVersion(env.POISE_PYTHON, runCommand)
    if (version !== PYTHON_VERSION) {
      throw new Error(`POISE_PYTHON=${env.POISE_PYTHON} is ${version ? `Python ${version}` : 'not a runnable Python'}; Caller needs Python ${PYTHON_VERSION}`)
    }
    return env.POISE_PYTHON
  }
  for (const candidate of candidates) {
    if (await pythonVersion(candidate, runCommand) === PYTHON_VERSION) return candidate
  }
  throw new Error(`Caller needs Python ${PYTHON_VERSION}: install it (brew install python@3.13) or set POISE_PYTHON`)
}

/** Create caller/.venv when it is missing or not Python 3.13, then install
 *  the three packages into it and check what was installed. */
export async function setupCaller({ root = CALLER_ROOT, python, run: runCommand = run, log = console.log }) {
  const venv = join(root, '.venv')
  const venvPython = join(venv, 'bin', 'python')
  if (await pythonVersion(venvPython, runCommand) !== PYTHON_VERSION) {
    await runCommand(python, ['-m', 'venv', '--clear', venv])
  }
  await runCommand(venvPython, [
    '-m', 'pip', 'install', '--disable-pip-version-check',
    ...CALLER_PACKAGES.flatMap((pkg) => ['--editable', join(root, pkg.directory)]),
    'pytest',
  ])
  const versions = await callerVersions(root)
  const { stdout } = await runCommand(venvPython, ['-c', [
    'import importlib.metadata, json, sys',
    'print(json.dumps({name: importlib.metadata.version(name) for name in sys.argv[1:]}))',
  ].join('\n'), ...Object.keys(versions)], { capture: true })
  const installed = JSON.parse(stdout)
  for (const [name, version] of Object.entries(versions)) {
    if (installed[name] !== version) throw new Error(`${venv} has ${name} ${installed[name]}, but caller/ is ${version}`)
  }
  for (const command of CALLER_COMMANDS) await access(join(venv, 'bin', command), constants.X_OK)
  log(`Caller is set up in ${venv}: ${Object.entries(versions).map(([name, version]) => `${name} ${version}`).join(', ')}`)
  return { venv, versions }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await setupCaller({ python: await callerPython() })
}
