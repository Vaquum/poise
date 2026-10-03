import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CALLER_COMMANDS,
  CALLER_ROOT,
  agentInterfaceRoot,
  callerBinRoot,
  callerVersions,
  projectMetadata,
} from '../scripts/caller.mjs'
import { callerPython, setupCaller } from '../scripts/caller-setup.mjs'

const PACKAGES = { agent_interface: 'agent-interface', github_interface: 'github-interface', github_datastore: 'github-datastore' }

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'poise-caller-setup-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function callerTree(versions = {}) {
  for (const [directory, name] of Object.entries(PACKAGES)) {
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(join(root, directory, 'pyproject.toml'), [
      '[project]', `name = "${name}"`, `version = "${versions[name] || '1.2.3'}"`, '',
      '[project.scripts]', `${name} = "x:main"`, '',
    ].join('\n'))
  }
}

describe('the in-tree Caller', () => {
  it('lives in caller/ beside this repository and resolves its CLIs from caller/.venv', () => {
    expect(CALLER_ROOT).toBe(resolve('caller'))
    expect(CALLER_COMMANDS).toEqual(['agent-interface', 'github-interface', 'github-datastore'])
    expect(callerBinRoot({})).toBe(join(CALLER_ROOT, '.venv', 'bin'))
    expect(agentInterfaceRoot({})).toBe(join(CALLER_ROOT, 'agent_interface'))
  })

  it('lets explicit absolute paths name another Caller, and refuses relative ones', () => {
    expect(callerBinRoot({ CALLER_BIN_ROOT: '/opt/caller/bin' })).toBe('/opt/caller/bin')
    expect(agentInterfaceRoot({ AGENT_INTERFACE_ROOT: '/opt/caller/agent_interface' })).toBe('/opt/caller/agent_interface')
    expect(() => callerBinRoot({ CALLER_BIN_ROOT: 'caller/.venv/bin' })).toThrow('CALLER_BIN_ROOT must be an absolute path, got caller/.venv/bin')
    expect(() => agentInterfaceRoot({ AGENT_INTERFACE_ROOT: './agent_interface' })).toThrow('AGENT_INTERFACE_ROOT must be an absolute path')
  })

  it('reads each package version from the [project] table of its pyproject.toml', async () => {
    expect(projectMetadata('[project]\nname = "agent-interface"\nversion = \'0.3.0\'\n\n[project.scripts]\nversion = "9"\n'))
      .toEqual({ name: 'agent-interface', version: '0.3.0' })
    expect(() => projectMetadata('[tool.x]\nname = "a"\nversion = "1"\n')).toThrow('no [project] name and version')
    await callerTree({ 'github-interface': '0.2.0' })
    expect(await callerVersions(root)).toEqual({ 'agent-interface': '1.2.3', 'github-interface': '0.2.0', 'github-datastore': '1.2.3' })
    const shipped = await callerVersions()
    expect(Object.keys(shipped)).toEqual(CALLER_COMMANDS)
    for (const version of Object.values(shipped)) expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('fails naming the pyproject.toml that is missing or names another package', async () => {
    await callerTree()
    await rm(join(root, 'github_datastore', 'pyproject.toml'))
    await expect(callerVersions(root)).rejects.toThrow(`${join(root, 'github_datastore', 'pyproject.toml')}: ENOENT`)
    await callerTree()
    await writeFile(join(root, 'github_interface', 'pyproject.toml'), '[project]\nname = "other"\nversion = "1"\n')
    await expect(callerVersions(root)).rejects.toThrow(`${join(root, 'github_interface', 'pyproject.toml')} names other, expected github-interface`)
  })
})

describe('choosing Python 3.13', () => {
  async function fakePython(name, version) {
    const path = join(root, name)
    await writeFile(path, `#!/bin/sh\necho ${version}\n`)
    await chmod(path, 0o700)
    return path
  }

  it('uses POISE_PYTHON when it is 3.13 and fails loudly, naming it, when it is not', async () => {
    const good = await fakePython('good', '3.13')
    const old = await fakePython('old', '3.12')
    const fallback = await fakePython('fallback', '3.13')
    expect(await callerPython({ env: { POISE_PYTHON: good }, candidates: [] })).toBe(good)
    await expect(callerPython({ env: { POISE_PYTHON: old }, candidates: [fallback] }))
      .rejects.toThrow(`POISE_PYTHON=${old} is Python 3.12; Caller needs Python 3.13`)
    await expect(callerPython({ env: { POISE_PYTHON: join(root, 'missing') }, candidates: [fallback] }))
      .rejects.toThrow('is not a runnable Python')
  })

  it('otherwise takes the first 3.13 candidate, or says how to get one', async () => {
    const old = await fakePython('old', '3.12')
    const good = await fakePython('good', '3.13')
    expect(await callerPython({ env: {}, candidates: [join(root, 'missing'), old, good] })).toBe(good)
    await expect(callerPython({ env: {}, candidates: [old] }))
      .rejects.toThrow('Caller needs Python 3.13: install it (brew install python@3.13) or set POISE_PYTHON')
  })
})

describe('setting up caller/.venv', () => {
  // Stands in for python and pip: records every command and installs the
  // three CLIs when pip runs.
  function fakeRun({ venvVersion = null, installed = {} } = {}) {
    const calls = []
    const run = vi.fn(async (command, args) => {
      calls.push([command, ...args])
      if (args[0] === '-c' && args[1].includes('version_info')) {
        if (command === join(root, '.venv', 'bin', 'python') && venvVersion) return { stdout: `${venvVersion}\n`, stderr: '' }
        throw new Error(`${command}: not found`)
      }
      if (args[0] === '-m' && args[1] === 'pip') {
        for (const name of CALLER_COMMANDS) {
          const path = join(root, '.venv', 'bin', name)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, '#!/bin/sh\n')
          await chmod(path, 0o700)
        }
        return { stdout: '', stderr: '' }
      }
      if (args[0] === '-c') {
        const versions = Object.fromEntries(args.slice(2).map((name) => [name, installed[name] || '1.2.3']))
        return { stdout: JSON.stringify(versions), stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    return { run, calls }
  }

  it('creates the virtualenv and installs the three packages editable, with pytest', async () => {
    await callerTree()
    const { run, calls } = fakeRun()
    const log = vi.fn()
    expect(await setupCaller({ root, python: '/python3.13', run, log })).toEqual({
      venv: join(root, '.venv'),
      versions: { 'agent-interface': '1.2.3', 'github-interface': '1.2.3', 'github-datastore': '1.2.3' },
    })
    expect(calls).toContainEqual(['/python3.13', '-m', 'venv', '--clear', join(root, '.venv')])
    expect(calls).toContainEqual([join(root, '.venv', 'bin', 'python'), '-m', 'pip', 'install', '--disable-pip-version-check',
      '--editable', join(root, 'agent_interface'), '--editable', join(root, 'github_interface'), '--editable', join(root, 'github_datastore'), 'pytest'])
    expect(log).toHaveBeenCalledWith(`Caller is set up in ${join(root, '.venv')}: agent-interface 1.2.3, github-interface 1.2.3, github-datastore 1.2.3`)
  })

  it('keeps a Python 3.13 virtualenv and rebuilds one from another interpreter', async () => {
    await callerTree()
    const current = fakeRun({ venvVersion: '3.13' })
    await setupCaller({ root, python: '/python3.13', run: current.run, log: () => {} })
    expect(current.calls.some(([, ...args]) => args.includes('venv'))).toBe(false)
    const stale = fakeRun({ venvVersion: '3.12' })
    await setupCaller({ root, python: '/python3.13', run: stale.run, log: () => {} })
    expect(stale.calls).toContainEqual(['/python3.13', '-m', 'venv', '--clear', join(root, '.venv')])
  })

  it('fails when what pip installed is not the Caller in the tree', async () => {
    await callerTree()
    const { run } = fakeRun({ installed: { 'github-datastore': '0.1.0' } })
    await expect(setupCaller({ root, python: '/python3.13', run, log: () => {} }))
      .rejects.toThrow(`${join(root, '.venv')} has github-datastore 0.1.0, but caller/ is 1.2.3`)
  })

  it('fails when a CLI did not get installed', async () => {
    await callerTree()
    const { run } = fakeRun()
    const pip = run.getMockImplementation()
    run.mockImplementation(async (command, args, options) => {
      const result = await pip(command, args, options)
      if (args[1] === 'pip') await rm(join(root, '.venv', 'bin', 'github-interface'))
      return result
    })
    await expect(setupCaller({ root, python: '/python3.13', run, log: () => {} })).rejects.toThrow(/github-interface/)
  })
})

describe('npm run caller:setup', () => {
  it('runs the setup script', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    expect(manifest.scripts['caller:setup']).toBe('node scripts/caller-setup.mjs')
  })
})
