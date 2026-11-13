// @vitest-environment node
// Agents' test suites run on disposable test boxes: these run the real hooks, runner, relay and box
// script, with only Render itself replaced. docs/Operating.md, "Agents' test suites".
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { BOX_COMMAND, SETUP_COMMAND, TEST_RELAY_PATH, TestRelay, workspaceKey, type TestRelayDeps } from '../gateway/src/test-relay'
import { filesToSend, frameReader, testEnvironment } from '../scripts/test-offload/run.mjs'
import { BehaviorChainJournal, chainBasis, type ChainEvent } from '../server/behavior-chain-store'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { scrubbedChildEnvironment } from '../server/process'

const SOURCE = resolve('scripts/test-offload')
const { privateKey } = generateKeyPairSync('ed25519')
const KEY = workspaceKey(privateKey, 'alice')
const GNU_TAR = spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout?.startsWith('tar (GNU tar)')

const temporary: string[] = []
function temp(prefix = 'test-offload-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporary.push(dir)
  return dir
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('what counts as a test suite', () => {
  it('reaches every Python form agents use, and nothing else', () => {
    const cases: [string[], boolean][] = [
      [['-m', 'pytest', '-q'], true],
      [['-m', 'pytest', '-n', '10', '-m', 'not live'], true],
      [['-m', 'unittest', 'discover'], true],
      [['-W', 'ignore', '-m', 'pytest'], true],
      [['-X', 'dev', '-u', '-m', 'pytest'], true],
      [['/venv/bin/pytest', 'tests'], true],
      [['/venv/bin/py.test'], true],
      [['-m', 'pytest', '--version'], false],
      [['/venv/bin/pytest', '--help'], false],
      [['-c', 'import pytest'], false],
      [['-m', 'pip', 'install', 'pytest'], false],
      [['-m', 'canary.research_bundle'], false],
      [['scripts/pytest_helper.py'], false],
      [['-'], false],
      [[], false],
    ]
    // By its path: Python itself may already have imported a sitecustomize of its own.
    const program = `import importlib.util as u, json, sys; spec = u.spec_from_file_location('hook', sys.argv[1]); s = u.module_from_spec(spec); spec.loader.exec_module(s); print(json.dumps([s.test_command(a) for a in json.loads(sys.argv[2])]))`
    const answers = JSON.parse(execFileSync('python3', ['-c', program, join(SOURCE, 'sitecustomize.py'), JSON.stringify(cases.map(([args]) => args))]).toString())
    expect(answers).toEqual(cases.map(([, expected]) => expected))
  })

  it('reaches every Node form agents use, and nothing else', () => {
    const { testCommand } = createRequire(import.meta.url)(join(SOURCE, 'hook.cjs')) as { testCommand: (script: string, args: string[]) => boolean }
    const npm = '/usr/local/lib/node_modules/npm/bin/npm-cli.js'
    const cases: [string, string[], boolean][] = [
      [npm, ['test'], true],
      [npm, ['t'], true],
      [npm, ['run', 'check'], true],
      [npm, ['run', 'lint'], true],
      [npm, ['run', 'typecheck:tests'], true],
      [npm, ['run', 'test:e2e', '--', 'tests/e2e/smoke.spec.ts'], true],
      [npm, ['--prefix', 'deploy/ci', 'run', 'test'], true],
      [npm, ['-w', 'gateway', 'test'], true],
      ['/repo/node_modules/.bin/vitest', ['run'], true],
      ['/repo/node_modules/vitest/vitest.mjs', [], true],
      ['/repo/node_modules/.bin/tsc', ['-p', 'tsconfig.tests.json', '--noEmit'], true],
      ['/repo/node_modules/.bin/playwright', ['test', 'x.spec.ts'], true],
      ['/repo/node_modules/.bin/jest', [], true],
      // These leave files behind that what comes next needs, or serve something, or only ask.
      [npm, ['run', 'build'], false],
      [npm, ['run', 'dev'], false],
      [npm, ['run', 'start'], false],
      [npm, ['ci'], false],
      [npm, ['install', 'test'], false],
      ['/repo/node_modules/.bin/tsc', ['-p', 'tsconfig.json'], false],
      ['/repo/node_modules/.bin/vitest', ['--version'], false],
      ['/repo/node_modules/.bin/playwright', ['install', 'chromium'], false],
      ['/repo/scripts/chat-relay.mjs', [], false],
      ['/home/poise/.local/bin/codex', ['app-server'], false],
    ]
    expect(cases.map(([script, args]) => testCommand(script, args))).toEqual(cases.map(([, , expected]) => expected))
  })
})

describe('what reaches a test box', () => {
  it('forwards a suite its own settings, and no credential or agent setting', () => {
    const hooks = '/home/poise/.poise/test-offload'
    const env = testEnvironment({
      PATH: '/venv/bin:/usr/bin',
      HOME: '/home/poise',
      TMPDIR: '/run/tmp',
      CI: '1',
      FOO: 'bar',
      PYTEST_ADDOPTS: '-q',
      PYTHONPATH: `${hooks}:src`,
      NODE_OPTIONS: `--require "${hooks}/hook.cjs" --max-old-space-size=4096`,
      GH_TOKEN: 'x',
      GITHUB_TOKEN: 'x',
      GIT_CONFIG_VALUE_0: 'x',
      GIT_AUTHOR_NAME: 'x',
      ANTHROPIC_API_KEY: 'x',
      ANTHROPIC_BASE_URL: 'x',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'x',
      CLAUDECODE: '1',
      CODEX_HOME: 'x',
      AWS_REGION: 'x',
      OPENAI_API_KEY: 'x',
      POISE_NATIVE_CONTROL: 'x',
      POISE_TEST_RELAY_KEY: 'x',
      MY_PASSWORD: 'x',
      API_SECRET: 'x',
      WEBHOOK: 'https://user:hunter2@example.com/hook',
      INNOCENT: 'ghp_abcdef',
      BASH_DEFAULT_TIMEOUT_MS: '600000',
      GOMAXPROCS: '2',
      RIPGREP_CONFIG_PATH: 'x',
      OLDPWD: 'x',
      EMPTY: '',
    }, hooks)
    expect(env).toEqual({
      PATH: '/venv/bin:/usr/bin',
      HOME: '/home/poise',
      TMPDIR: '/run/tmp',
      CI: '1',
      FOO: 'bar',
      PYTEST_ADDOPTS: '-q',
      // The hooks stay here, and what else these held goes along.
      PYTHONPATH: 'src',
      NODE_OPTIONS: '--max-old-space-size=4096',
    })
  })

  it('leaves nothing of the hooks where they were all those variables held', () => {
    const hooks = '/h'
    expect(testEnvironment({ PYTHONPATH: hooks, NODE_OPTIONS: '--require "/h/hook.cjs"', CI: '1' }, hooks)).toEqual({ CI: '1' })
    expect(testEnvironment({ PYTHONPATH: 'src', NODE_OPTIONS: '--no-warnings' }, hooks)).toEqual({ PYTHONPATH: 'src', NODE_OPTIONS: '--no-warnings' })
  })

  function checkout(): string {
    const repo = temp()
    execFileSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n.venv/\ndist/\n*.pem\n')
    writeFileSync(join(repo, 'tracked.py'), 'x = 1\n')
    writeFileSync(join(repo, 'gone.py'), 'x = 1\n')
    execFileSync('git', ['-C', repo, 'add', '.'])
    rmSync(join(repo, 'gone.py'))
    writeFileSync(join(repo, 'untracked.py'), 'x = 1\n')
    writeFileSync(join(repo, '.env'), 'SECRET=1\n')
    writeFileSync(join(repo, 'server.pem'), 'SECRET\n')
    mkdirSync(join(repo, 'dist'))
    writeFileSync(join(repo, 'dist', 'bundle.js'), '1\n')
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), '1\n')
    mkdirSync(join(repo, 'sub', 'node_modules'), { recursive: true })
    mkdirSync(join(repo, '.venv', 'bin'), { recursive: true })
    return repo
  }

  it('sends the checkout and its dependencies, without what git ignores', () => {
    const repo = checkout()
    const paths = filesToSend(join(repo), [], {}, '/nowhere')
    expect(paths.every((path: string) => path.startsWith(repo))).toBe(true)
    const names = paths.map((path: string) => path.slice(repo.length + 1))
    expect(names.sort()).toEqual(['.git', '.gitignore', '.venv', 'node_modules', 'sub/node_modules', 'tracked.py', 'untracked.py'])
  })

  it('holds a repository inside the checkout to the same rule, ignored files and git configuration alike', () => {
    const repo = checkout()
    const nested = join(repo, 'nested')
    execFileSync('git', ['init', '-q', nested])
    writeFileSync(join(nested, '.gitignore'), '.env\n')
    writeFileSync(join(nested, 'kept.py'), 'x = 1\n')
    writeFileSync(join(nested, '.env'), 'SECRET=1\n')
    const names = filesToSend(repo, [], {}, '/nowhere').map((path: string) => path.slice(repo.length + 1))
    expect(names).toEqual(expect.arrayContaining(['nested/.gitignore', 'nested/kept.py', 'nested/.git']))
    expect(names).not.toContain('nested')
    expect(names).not.toContain('nested/.env')
    writeFileSync(join(nested, '.git', 'config'), `${readFileSync(join(nested, '.git', 'config'), 'utf8')}[http]\n\textraheader = AUTHORIZATION: basic abc\n`)
    expect(() => filesToSend(repo, [], {}, '/nowhere')).toThrow('holds a credential')
  })

  it('sends an interpreter that lives outside the checkout, unless it is the system\'s', () => {
    const repo = checkout()
    const elsewhere = temp()
    const venv = join(elsewhere, 'venv')
    const base = join(elsewhere, 'cpython-3.12.1')
    const link = join(elsewhere, 'cpython-3.12')
    mkdirSync(venv)
    mkdirSync(base)
    symlinkSync(base, link)
    const paths = filesToSend(repo, [venv, link, '/usr', '/usr/lib', '/usr/local'], {}, '/nowhere')
    expect(paths).toEqual(expect.arrayContaining([venv, link, base]))
    expect(paths.filter((path: string) => path.startsWith('/usr'))).toEqual([])
  })

  it('sends every link on the way to an interpreter, as a virtualenv\'s reaches its base through one', () => {
    const repo = checkout()
    const elsewhere = temp()
    const base = join(elsewhere, 'cpython-3.13.16')
    const link = join(elsewhere, 'cpython-3.13')
    mkdirSync(join(base, 'bin'), { recursive: true })
    writeFileSync(join(base, 'bin', 'python3.13'), '')
    symlinkSync('python3.13', join(base, 'bin', 'python3'))
    symlinkSync(base, link)
    const python = join(repo, '.venv', 'bin', 'python3')
    symlinkSync(join(link, 'bin', 'python3'), python)
    const paths = filesToSend(repo, [join(repo, '.venv'), base, python], {}, '/nowhere')
    expect(paths).toEqual(expect.arrayContaining([python, link, join(base, 'bin', 'python3'), join(base, 'bin', 'python3.13'), base]))
    // Through the link it would arrive as a folder of its own, and the link could not be made.
    expect(paths.filter((path: string) => path.startsWith(`${link}/`))).toEqual([])
  })

  it('sends a link to a whole folder, and follows a link before the `..` after it, as the system does', () => {
    const repo = checkout()
    const elsewhere = temp()
    mkdirSync(join(elsewhere, 'env', 'bin'), { recursive: true })
    writeFileSync(join(elsewhere, 'env', 'bin', 'python'), '')
    symlinkSync(join(elsewhere, 'env'), join(elsewhere, 'venv'))
    expect(filesToSend(repo, [join(elsewhere, 'venv', 'bin', 'python')], {}, '/nowhere')).toEqual(expect.arrayContaining([join(elsewhere, 'venv'), join(elsewhere, 'env', 'bin', 'python')]))
    mkdirSync(join(elsewhere, 'bin'))
    mkdirSync(join(elsewhere, 'libexec', 'nested'), { recursive: true })
    writeFileSync(join(elsewhere, 'libexec', 'python3.13'), '')
    symlinkSync('../libexec/nested', join(elsewhere, 'bin', 'alt'))
    symlinkSync('alt/../python3.13', join(elsewhere, 'bin', 'python3'))
    const paths = filesToSend(repo, [join(elsewhere, 'bin', 'python3')], {}, '/nowhere')
    expect(paths).toEqual(expect.arrayContaining([join(elsewhere, 'bin', 'python3'), join(elsewhere, 'bin', 'alt'), join(elsewhere, 'libexec', 'python3.13')]))
  })

  it('refuses to send an interpreter\'s folder with the home or the run\'s temporary files in it', () => {
    const repo = checkout()
    const home = temp()
    expect(() => filesToSend(repo, [home], {}, home)).toThrow('holds what must not reach a test box')
    expect(() => filesToSend(repo, [join(home, '..')], {}, home)).toThrow('holds what must not reach a test box')
    const tmp = join(home, 'tmp')
    mkdirSync(tmp)
    expect(() => filesToSend(repo, [home], { TMPDIR: tmp }, '/nowhere')).toThrow('holds what must not reach a test box')
  })

  it('refuses a checkout whose git configuration holds a credential', () => {
    for (const line of ['\turl = https://x-access-token:abc@github.com/a/b.git', '\textraheader = AUTHORIZATION: basic abc']) {
      const repo = checkout()
      writeFileSync(join(repo, '.git', 'config'), `${readFileSync(join(repo, '.git', 'config'), 'utf8')}[remote "origin"]\n${line}\n`)
      expect(() => filesToSend(repo, [], {}, '/nowhere')).toThrow('holds a credential')
    }
  })

  it('refuses to send a folder with the home or the run’s temporary files in it', () => {
    const home = temp()
    const tmp = join(home, 'run', 'tmp')
    mkdirSync(tmp, { recursive: true })
    expect(() => filesToSend(home, [], {}, home)).toThrow('run the suite from a checkout')
    expect(() => filesToSend(join(home, 'run'), [], { TMPDIR: tmp }, home)).toThrow('run the suite from a checkout')
    const scratch = join(tmp, 'scratch')
    mkdirSync(scratch)
    expect(filesToSend(scratch, [], { TMPDIR: tmp }, home)).toEqual([scratch])
  })
})

describe('installing it into a home volume', () => {
  const install = (home: string, env: Record<string, string> = {}) => execFileSync('sh', [join(SOURCE, 'install.sh')], { env: { PATH: process.env.PATH, HOME: home, ...env } })

  it('puts the hooks and the relay where they outlive a release, the key for its owner alone', () => {
    const home = temp()
    install(home, { POISE_TEST_RELAY_URL: 'https://alice.example/api/link/test-relay', POISE_TEST_RELAY_KEY: 'alice.signed' })
    const hooks = join(home, '.poise', 'test-offload')
    expect(readFileSync(join(hooks, 'relay'), 'utf8')).toBe('https://alice.example/api/link/test-relay\nalice.signed\n')
    expect(statSync(join(hooks, 'relay')).mode & 0o777).toBe(0o600)
    for (const file of ['hook.cjs', 'sitecustomize.py', 'run.mjs']) expect(readFileSync(join(hooks, file))).toEqual(readFileSync(join(SOURCE, file)))
    expect(readdirSync(hooks).sort()).toEqual(['hook.cjs', 'relay', 'run.mjs', 'sitecustomize.py'])
    // Ahead of a first start, whose entrypoint leaves a ~/.poise it finds as it is.
    expect(statSync(join(home, '.poise')).mode & 0o777).toBe(0o700)
  })

  it('turns off without removing what running agents point at', () => {
    const home = temp()
    install(home, { POISE_TEST_RELAY_URL: 'https://alice.example', POISE_TEST_RELAY_KEY: 'k' })
    install(home)
    expect(readdirSync(join(home, '.poise', 'test-offload')).sort()).toEqual(['hook.cjs', 'run.mjs', 'sitecustomize.py'])
  })

  it('leaves nothing behind where it was never on', () => {
    const home = temp()
    install(home)
    expect(existsSync(join(home, '.poise', 'test-offload'))).toBe(false)
  })
})

describe('the hooks at work', () => {
  function hooked(relay: boolean): { hooks: string; env: NodeJS.ProcessEnv } {
    const hooks = temp()
    for (const file of ['hook.cjs', 'sitecustomize.py', 'run.mjs']) copyFileSync(join(SOURCE, file), join(hooks, file))
    // Nothing listens there: a suite that reaches for its instance fails at once, and one that does not runs.
    if (relay) writeFileSync(join(hooks, 'relay'), 'http://127.0.0.1:9/api/link/test-relay\nk\n')
    // Without the npm script this very test may be running under.
    return { hooks, env: { ...process.env, npm_lifecycle_event: undefined, NODE_OPTIONS: `--require "${join(hooks, 'hook.cjs')}"` } }
  }
  const attempt = (args: string[], env: NodeJS.ProcessEnv, cwd: string) => spawnSync(process.execPath, args, { env, cwd, encoding: 'utf8' })

  it('take a Node test runner out of this machine, however it is reached, and it never runs here', () => {
    const { env, hooks } = hooked(true)
    writeFileSync(join(hooks, 'run.mjs'), `console.log(JSON.stringify(process.argv.slice(2)))
console.error('[poise] fixture sender: relay unavailable')
process.exitCode = 125`)
    const repo = temp()
    execFileSync('git', ['init', '-q', repo])
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true })
    const marker = join(repo, 'ran-here')
    writeFileSync(join(repo, 'node_modules', '.bin', 'vitest'), `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`)
    const result = attempt([join(repo, 'node_modules', '.bin', 'vitest'), 'run'], env, repo)
    expect(result.status).toBe(125)
    const args = JSON.parse(result.stdout) as string[]
    expect(args.slice(args.indexOf('--') + 1)).toEqual([process.execPath, join(repo, 'node_modules', '.bin', 'vitest'), 'run'])
    expect(result.stderr).toContain('[poise] fixture sender: relay unavailable')
    expect(existsSync(marker)).toBe(false)
  })

  it('send the Node that started a suite by name, never the folder it lives in, which can be the home', () => {
    const { env, hooks } = hooked(true)
    // Says what it was asked to send and run, in the place of the real sender.
    writeFileSync(join(hooks, 'run.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))')
    const repo = temp()
    writeFileSync(join(repo, 'vitest'), '')
    const result = attempt([join(repo, 'vitest'), 'run'], env, repo)
    const args = JSON.parse(result.stdout) as string[]
    const prefix = dirname(dirname(process.execPath))
    const also = args.slice(0, args.indexOf('--')).filter((arg) => arg !== '--also')
    expect(also).toEqual(['bin/node', 'bin/npm', 'bin/npx', 'lib/node_modules/npm', 'lib/node_modules/corepack'].map((path) => join(prefix, path)))
    expect(args.slice(args.indexOf('--') + 1)).toEqual([process.execPath, join(repo, 'vitest'), 'run'])
  })

  it('leave everything else alone', () => {
    const { env } = hooked(true)
    const result = attempt(['-e', 'console.log("ran here")'], env, temp())
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('ran here\n')
  })

  it('do nothing once the relay is gone, for agents still holding them', () => {
    const { env } = hooked(false)
    const repo = temp()
    writeFileSync(join(repo, 'vitest'), 'console.log("ran here")')
    const result = attempt([join(repo, 'vitest'), 'run'], env, repo)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('ran here\n')
  })

  it('leave the steps of an npm script that stays here, as `npm run build` runs its typecheck, and take npx\'s', () => {
    const { env } = hooked(true)
    const repo = temp()
    execFileSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, 'tsc'), 'console.log("ran here")')
    const result = attempt([join(repo, 'tsc'), '--noEmit'], { ...env, npm_lifecycle_event: 'build' }, repo)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('ran here\n')
    expect(attempt([join(repo, 'tsc'), '--noEmit'], { ...env, npm_lifecycle_event: 'npx' }, repo).status).toBe(125)
    expect(attempt([join(repo, 'tsc'), '--noEmit'], { ...env, npm_lifecycle_event: 'check' }, repo).status).toBe(125)
  })

  it('take a Python test runner out of this machine, from any interpreter, and it never runs here', () => {
    const { hooks } = hooked(true)
    const repo = temp()
    execFileSync('git', ['init', '-q', repo])
    const marker = join(repo, 'ran-here')
    mkdirSync(join(repo, 'pytest'))
    writeFileSync(join(repo, 'pytest', '__main__.py'), `open(${JSON.stringify(marker)}, 'w')`)
    const result = spawnSync('python3', ['-m', 'pytest', '-q'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PYTHONPATH: hooks } })
    expect(result.status).toBe(125)
    expect(result.stderr).toContain('[poise]')
    expect(existsSync(marker)).toBe(false)
  })

  it('send the Python that started a suite with its prefixes, so the links a virtualenv\'s takes to its base go too', () => {
    const { hooks } = hooked(true)
    // Says what it was asked to send, in the place of the real sender.
    writeFileSync(join(hooks, 'run.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))')
    const env = { ...process.env, PYTHONPATH: hooks }
    const result = spawnSync('python3', ['-m', 'pytest', '-q'], { cwd: temp(), encoding: 'utf8', env })
    const args = JSON.parse(result.stdout) as string[]
    // Asked with the same PYTHONPATH: a sitecustomize of Python's own, as Homebrew's, can change these.
    const python = JSON.parse(execFileSync('python3', ['-c', 'import json, sys; print(json.dumps([sys.prefix, sys.base_prefix, sys.executable]))'], { env }).toString()) as string[]
    expect(args.slice(0, args.indexOf('--')).filter((arg) => arg !== '--also')).toEqual(python)
  })
})

describe('the Claude wrapper', () => {
  function wrapped(env: Record<string, string>): Record<string, string | undefined> {
    const bin = temp()
    const home = temp()
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const status = process.argv.includes('auth') && process.argv.includes('status')
process.stdout.write(JSON.stringify(status ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' } : process.env))
`, { mode: 0o700 })
    const hooks = join(home, '.poise', 'test-offload')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'hook.cjs'), '')
    const result = spawnSync(process.execPath, [resolve('scripts/claude-subscription.mjs'), '--print', 'x'], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replace('HOOKS', hooks)])) },
    })
    return JSON.parse(result.stdout) as Record<string, string | undefined>
  }

  it('passes the hooks on, so that agents on Claude get them', () => {
    const seen = wrapped({ PYTHONPATH: 'HOOKS:src', NODE_OPTIONS: '--require "HOOKS/hook.cjs"', BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '3600000' })
    expect(seen.PYTHONPATH).toMatch(/\.poise\/test-offload:src$/)
    expect(seen.NODE_OPTIONS).toMatch(/--require ".*\.poise\/test-offload\/hook\.cjs"$/)
    expect(seen.BASH_DEFAULT_TIMEOUT_MS).toBe('600000')
    expect(seen.BASH_MAX_TIMEOUT_MS).toBe('3600000')
  })

  it('still keeps out what those variables carry without the hooks', () => {
    const seen = wrapped({ PYTHONPATH: 'src', NODE_OPTIONS: '--inspect', BASH_DEFAULT_TIMEOUT_MS: '5' })
    for (const key of ['PYTHONPATH', 'NODE_OPTIONS', 'BASH_DEFAULT_TIMEOUT_MS']) expect(seen[key]).toBeUndefined()
  })
})

describe('Poise', () => {
  beforeEach(() => { vi.stubEnv('PYTHONPATH', undefined); vi.stubEnv('NODE_OPTIONS', undefined) })

  it('starts everything with the hooks once the gateway installed them', () => {
    const home = temp()
    vi.stubEnv('HOME', home)
    const hooks = join(home, '.poise', 'test-offload')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'relay'), 'https://relay.example.com\nkey\n')
    const env = scrubbedChildEnvironment('agent-interface', { PYTHONPATH: 'src', NODE_OPTIONS: '--no-warnings' })
    expect(env.PYTHONPATH).toBe(`${hooks}:src`)
    expect(env.NODE_OPTIONS).toBe(`--require "${join(hooks, 'hook.cjs')}" --no-warnings`)
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('600000')
    expect(env.BASH_MAX_TIMEOUT_MS).toBe('3600000')
    expect(scrubbedChildEnvironment('agent-interface', { BASH_DEFAULT_TIMEOUT_MS: '5' }).BASH_DEFAULT_TIMEOUT_MS).toBe('5')
  })

  it('changes nothing without them, as on a personal computer', () => {
    vi.stubEnv('HOME', temp())
    const env = scrubbedChildEnvironment('agent-interface')
    for (const name of ['PYTHONPATH', 'NODE_OPTIONS', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS']) expect(env[name]).toBeUndefined()
  })
})

describe('a suite on a test box', () => {
  interface Box { id: string; plan: string; group: string; snapshotName: string | null; timeoutSeconds: number; idleTimeoutSeconds: number; createdAt: string; status: string; child: ChildProcess | null; dir: string }
  interface Snapshot { id: string; name: string; status: string; expiresAt: string; sandboxGroupId: string }
  interface Job { id: string; service: string; startCommand: string; planId: string; status: string; child: ChildProcess | null }
  let render: Server
  let jobs: Map<string, Job>
  let renderOrigin: string
  let boxes: Map<string, Box>
  let snapshots: Map<string, Snapshot>
  let groups: string[]
  let terminated: string[]
  let setups: number
  let setupExit: number
  let setupMs: number
  let listLagMs: number
  let runBoxes: boolean
  let runJobs: boolean
  let warnings: Record<string, unknown>[]
  let events: Record<string, unknown>[]
  let runners: { child: ChildProcess; done: Promise<unknown> }[]
  let relay: TestRelay
  let relayServer: Server
  let relayOrigin: string
  let relayUrl: string
  let hooks: string
  let unpacked: string
  let uploads: { path: string; bytes: number }[]

  async function listen(server: Server, port = 0): Promise<number> {
    await new Promise<void>((done) => { server.listen(port, '127.0.0.1', done) })
    return (server.address() as { port: number }).port
  }

  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

  function serveRelay(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://relay')
    const part = url.pathname.split('/').at(-1)
    if (req.method === 'POST' && (part === 'tree' || part === 'dependency')) {
      uploads.push({ path: part, bytes: Number(req.headers['content-length'] ?? 0) })
    }
    void relay.handle(req, res, url)
  }

  // What a box's command does here: the real box script over what was uploaded, or a stand-in for the setup.
  function runOnBox(box: Box, command: string, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    if (command === SETUP_COMMAND) {
      setups += 1
      expect(readFileSync(join(box.dir, 'tmp/poise-setup.sh'))).toEqual(readFileSync('gateway/src/test-box-setup.sh'))
      setTimeout(() => {
        event('output', { data: 'set up\n', stream: 'stdout' })
        event('exit', { exit_code: setupExit })
        res.end()
      }, setupMs)
      return
    }
    expect(command).toBe(BOX_COMMAND)
    const [, script, spec, tree] = command.split(' ')
    const inBox = (path: string) => join(box.dir, path)
    if (!runBoxes) return
    const child = spawn(process.execPath, [inBox(script), inBox(spec), inBox(tree), unpacked], { stdio: ['ignore', 'pipe', 'pipe'] })
    box.child = child
    child.stdout?.on('data', (chunk) => { event('output', { data: chunk.toString(), stream: 'stdout' }) })
    child.stderr?.on('data', (chunk) => { event('output', { data: chunk.toString(), stream: 'stderr' }) })
    child.on('close', (code) => {
      if (box.status === 'running') event('exit', { exit_code: code })
      res.end()
    })
  }

  // A job runs the real instance script, fetched as its start command fetches it, and unpacks where these tests look.
  function startJob(job: Job): void {
    if (!runJobs) return
    const [, code, url, run, token] = / node -e (\S+) (\S+) (\S+) (\S+)$/.exec(job.startCommand) ?? []
    job.child = spawn(process.execPath, ['-e', code, url, run, token, unpacked], { stdio: ['ignore', 'ignore', 'inherit'] })
    job.child.on('exit', () => { if (job.status === 'running') job.status = 'succeeded' })
  }

  // Render, as far as the relay sees it.
  function startRender(): Server {
    return createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://render')
      const path = url.pathname
      if (path.startsWith('/connect/upload/')) {
        const box = boxes.get(path.split('/')[3])
        const file = join(box?.dir ?? '', url.searchParams.get('path') ?? '')
        mkdirSync(dirname(file), { recursive: true })
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        writeFileSync(file, Buffer.concat(chunks))
        res.writeHead(200).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const text = Buffer.concat(chunks).toString()
      const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>
      if (path.startsWith('/connect/run/')) {
        runOnBox(boxes.get(path.split('/')[3]) as Box, body.command as string, res)
        return
      }
      if (req.headers.authorization !== 'Bearer render-key') { res.writeHead(401).end('no such key'); return }
      const [, service, jobId, jobAction] = /^\/v1\/services\/([^/]+)\/jobs\/?([^/]*)\/?(.*)$/.exec(path) ?? []
      if (service && req.method === 'GET') {
        const listed = [...jobs.values()].filter((job) => job.service === service && job.status === 'running')
        json(res, 200, listed.map(({ id, startCommand }) => ({ cursor: 'c', job: { id, startCommand } })))
        return
      }
      if (service && !jobId) {
        const job: Job = { id: `job-${jobs.size + 1}`, service, startCommand: body.startCommand as string, planId: body.planId as string, status: 'running', child: null }
        jobs.set(job.id, job)
        startJob(job)
        json(res, 201, { id: job.id })
        return
      }
      if (service && jobAction === 'cancel') {
        const job = jobs.get(jobId)
        if (job) {
          job.status = 'canceled'
          job.child?.kill('SIGKILL')
        }
        res.writeHead(job ? 200 : 404).end()
        return
      }
      const [, id, action, operation] = /^\/v1\/sandboxes\/([^/]+)\/?([^/]*)\/?(.*)$/.exec(path) ?? []
      const box = id ? boxes.get(id) : undefined
      if (path === '/v1/sandbox-groups' && req.method === 'GET') json(res, 200, groups.map((name, index) => ({ cursor: 'c', sandboxGroup: { id: `sbg-${index}`, name } })))
      else if (path === '/v1/sandbox-groups') { groups.push(body.name as string); json(res, 201, { id: `sbg-${groups.length - 1}`, name: body.name }) }
      else if (/^\/v1\/sandbox-groups\/[^/]+\/snapshots$/.test(path)) json(res, 200, [...snapshots.values()].filter((item) => item.status === 'available').map((snapshot) => ({ cursor: 'c', snapshot })))
      else if (/^\/v1\/sandbox-groups\/[^/]+\/snapshots\//.test(path)) json(res, 200, snapshots.get(path.split('/').at(-1) as string))
      else if (path === '/v1/sandboxes' && req.method === 'GET') {
        // Render's list can lag behind a box that was just created.
        const listed = [...boxes.values()].filter((item) => item.status === 'running' && item.group === url.searchParams.get('sandboxGroupId') && Date.now() - Date.parse(item.createdAt) >= listLagMs)
        json(res, 200, listed.map((sandbox) => ({ cursor: 'c', sandbox: { id: sandbox.id, createdAt: sandbox.createdAt } })))
      }
      else if (path === '/v1/sandboxes') {
        const name = body.snapshotName as string | undefined
        if (name && ![...snapshots.values()].some((item) => item.name === name)) { res.writeHead(404).end('no such snapshot'); return }
        const created: Box = {
          id: `sbx-${boxes.size + 1}`, plan: body.plan as string, group: body.sandboxGroupId as string, snapshotName: name ?? null, timeoutSeconds: body.timeoutSeconds as number,
          idleTimeoutSeconds: body.idleTimeoutSeconds as number, createdAt: new Date().toISOString(), status: 'running', child: null, dir: temp('test-box-'),
        }
        boxes.set(created.id, created)
        json(res, 201, { id: created.id, status: 'creating' })
      } else if (box && action === 'terminate') {
        terminated.push(box.id)
        box.status = 'terminated'
        box.child?.kill('SIGKILL')
        res.writeHead(204).end()
      } else if (box && action === 'files' && operation === 'upload/token') json(res, 200, { uri: `${renderOrigin}/connect/upload/${box.id}?path=${encodeURIComponent(url.searchParams.get('path') ?? '')}`, method: 'PUT', token: 't' })
      else if (box && action === 'runs' && operation === 'stream/token') json(res, 200, { uri: `${renderOrigin}/connect/run/${box.id}`, method: 'POST', token: 't' })
      else if (box && action === 'snapshots') {
        const snapshot: Snapshot = { id: `snp-${snapshots.size + 1}`, name: body.name as string, status: 'available', expiresAt: body.expiresAt as string, sandboxGroupId: box.group }
        snapshots.set(snapshot.id, snapshot)
        json(res, 201, snapshot)
      } else if (box) json(res, 200, { id: box.id, status: box.status })
      else res.writeHead(404).end('nothing here')
    })
  }

  async function startAll(overrides: Partial<TestRelayDeps['config']> & Partial<TestRelayDeps> = {}): Promise<void> {
    const { renderApiKey = 'render-key', limitSeconds = 3600, maxRuns = 5, deployment = 'poise.example.com', baseService = null, jobPlan = 'plan-crn-005', ...deps } = overrides
    renderOrigin = `http://127.0.0.1:${await listen(render)}`
    relay = new TestRelay({
      config: { renderApiKey, workspace: 'tea-test', deployment, plan: '1c-2g', baseService, jobPlan, limitSeconds, maxRuns },
      privateKey,
      origin: () => relayOrigin,
      log: { info: (event: string, fields: Record<string, unknown>) => { events.push({ event, ...fields }) }, warn: (_event: string, fields: Record<string, unknown>) => { warnings.push({ event: _event, ...fields }) }, error: () => {} } as unknown as TestRelayDeps['log'],
      now: Date.now,
      isWorkspace: (handle) => handle === 'alice' || handle === 'bob',
      renderApi: `${renderOrigin}/v1`,
      sweepMs: 50,
      renderSweepMs: 100,
      leaseMs: 60_000,
      listGraceMs: 500,
      pollMs: 10,
      ...deps,
    })
    relayServer = createServer(serveRelay)
    relayOrigin = `http://127.0.0.1:${await listen(relayServer)}`
    relayUrl = `${relayOrigin}${TEST_RELAY_PATH}`
    relay.start()
    hooks = temp()
    for (const file of ['run.mjs', 'hook.cjs', 'sitecustomize.py']) copyFileSync(join(SOURCE, file), join(hooks, file))
    writeFileSync(join(hooks, 'relay'), `${relayUrl}\n${KEY}\n`)
    unpacked = temp()
  }

  beforeEach(() => {
    boxes = new Map()
    jobs = new Map()
    snapshots = new Map()
    groups = []
    terminated = []
    setups = 0
    setupExit = 0
    setupMs = 0
    listLagMs = 0
    warnings = []
    events = []
    uploads = []
    runners = []
    runBoxes = true
    runJobs = true
    render = startRender()
    relayServer = undefined as unknown as Server
  })

  afterEach(async () => {
    for (const runner of runners) if (runner.child.exitCode === null) runner.child.kill('SIGTERM')
    await Promise.all(runners.map((runner) => runner.done))
    for (const box of boxes.values()) box.child?.kill('SIGKILL')
    for (const job of jobs.values()) job.child?.kill('SIGKILL')
    relay?.stop()
    for (const server of [relayServer, render]) {
      server?.closeAllConnections()
      await new Promise((done) => { server?.close(done) })
    }
  })

  function suite(cwd: string, args: string[], env: Record<string, string> = {}): { child: ChildProcess; done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
    const child = spawn(process.execPath, [join(hooks, 'run.mjs'), '--', ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => { child.on('close', (code) => { done({ code, stdout, stderr }) }) })
    runners.push({ child, done })
    return { child, done }
  }

  function repository(): string {
    const repo = temp()
    execFileSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    writeFileSync(join(repo, 'tracked.txt'), 'checked out\n')
    writeFileSync(join(repo, '.env'), 'SECRET=1\n')
    return repo
  }

  async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
    const start = Date.now()
    while (!condition()) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting: ${what}`)
      await new Promise((done) => setTimeout(done, 25))
    }
  }

  const runBox = () => [...boxes.values()].find((box) => box.snapshotName !== null) as Box
  const suiteBoxes = () => [...boxes.values()].filter((box) => box.snapshotName !== null)

  function committed(): string {
    const repo = repository()
    execFileSync('git', ['-C', repo, 'add', '.'])
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'first'])
    return repo
  }

  it('starts a suite on a job of the base service, which costs less, and gives the agent its output and exit code', async () => {
    await startAll({ baseService: 'crn-test' })
    const repo = repository()
    const script = 'console.log("on a job " + process.cwd()); console.error("to stderr"); process.exit(3)'
    const { code, stdout, stderr } = await suite(repo, [process.execPath, '-e', script]).done
    expect(code).toBe(3)
    expect(stdout).toBe(`on a job ${repo}\n`)
    expect(stderr).toContain('to stderr\n')
    expect(readFileSync(join(unpacked, repo, 'tracked.txt'), 'utf8')).toBe('checked out\n')
    const [job] = jobs.values()
    expect(job).toMatchObject({ service: 'crn-test', planId: 'plan-crn-005' })
    // Render splits a start command at spaces and mangles quotes.
    expect(job.startCommand).toMatch(/^tini -- timeout -k 10 3660 node -e \S+ \S+\/instance [0-9a-f]{32} [0-9a-f]{64}$/)
    expect(suiteBoxes()).toEqual([])
    await until(() => relay.runs.size === 0, 'the run to end')
    expect(events).toContainEqual(expect.objectContaining({ event: 'test_relay.run.finished', jobId: job.id, exit: 3 }))
  })

  it('moves a suite that reaches for the Docker socket to a sandbox, and sends that checkout\'s next suite there at once', async () => {
    await startAll({ baseService: 'crn-test' })
    const repo = committed()
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    mkdirSync(join(repo, 'node_modules'))
    writeFileSync(join(repo, 'node_modules', 'fixture'), 'dependency')
    // On a job, DOCKER_HOST names the job's stand-in; a sandbox's Docker needs none.
    const script = `const host = process.env.DOCKER_HOST
      if (!host) { console.log('with Docker'); process.exit(0) }
      require('net').connect(host.replace(/^unix:\\/\\//, '')).on('error', () => {})
      setTimeout(() => process.exit(9), 30_000)`
    const first = await suite(repo, [process.execPath, '-e', script], { DOCKER_HOST: '' }).done
    expect(first.code).toBe(0)
    expect(first.stdout).toBe('with Docker\n')
    expect(first.stderr).toContain('reached for Docker')
    expect(jobs.size).toBe(1)
    expect(suiteBoxes()).toHaveLength(1)
    expect(warnings.filter((warning) => warning.event === 'test_relay.run.failed')).toEqual([])
    if (GNU_TAR) {
      const dependencyPosts = uploads.filter(({ path }) => path === 'dependency')
      expect(dependencyPosts.map(({ bytes }) => bytes > 0)).toEqual([false, true, false])
    }
    const second = await suite(repo, [process.execPath, '-e', script], { DOCKER_HOST: '' }).done
    expect(second).toMatchObject({ code: 0, stdout: 'with Docker\n' })
    expect(second.stderr).not.toContain('reached for Docker')
    expect(jobs.size).toBe(1)
    expect(suiteBoxes()).toHaveLength(2)
  })

  it('moves a suite whose Docker socket the agent\'s environment named, which a job has not either', async () => {
    await startAll({ baseService: 'crn-test' })
    // A sandbox runs it with the agent's value; a job, with its own stand-in.
    const script = `const path = process.env.DOCKER_HOST.replace(/^unix:\\/\\//, '')
      if (path === '/nonexistent/docker.sock') { console.log('with Docker'); process.exit(0) }
      require('net').connect(path).on('error', () => {})
      setTimeout(() => process.exit(9), 30_000)`
    const { code, stdout, stderr } = await suite(repository(), [process.execPath, '-e', script], { DOCKER_HOST: 'unix:///nonexistent/docker.sock' }).done
    expect(code).toBe(0)
    expect(stdout).toBe('with Docker\n')
    expect(stderr).toContain('reached for Docker')
  })

  it('takes a job\'s output once, though a post whose answer was lost comes again', async () => {
    runJobs = false
    await startAll({ baseService: 'crn-test' })
    const created = await fetch(`${relayUrl}/runs`, { method: 'POST', body: '{"argv":["x"],"cwd":"/","env":{}}', headers: { authorization: `Bearer ${KEY}` } })
    const { id } = await created.json() as { id: string }
    const output = await fetch(`${relayUrl}/runs/${id}/output`, { headers: { authorization: `Bearer ${KEY}` } })
    await until(() => jobs.size === 1, 'the job to be created')
    const token = (/ ([0-9a-f]{64})$/.exec([...jobs.values()][0].startCommand) ?? [])[1]
    const post = (query: string, body: Buffer) => fetch(`${relayUrl}/runs/${id}/output?${query}`, { method: 'POST', body: new Uint8Array(body), headers: { authorization: `Bearer ${token}` } })
    const said = Buffer.concat([Buffer.from([1, 0, 0, 0, 4]), Buffer.from('once')])
    expect((await post('seq=1', said)).status).toBe(204)
    expect((await post('seq=1', said)).status).toBe(204)
    expect((await post('end=1&exit=0&seq=2', Buffer.concat([Buffer.from([3, 0, 0, 0, 1]), Buffer.from('0')]))).status).toBe(204)
    const frames: [number, string][] = []
    const read = frameReader((type: number, payload: Buffer) => { frames.push([type, payload.toString()]) })
    for await (const chunk of output.body as unknown as AsyncIterable<Uint8Array>) read(Buffer.from(chunk))
    expect(frames.filter(([type]) => type === 1 || type === 3)).toEqual([[1, 'once'], [3, '0']])
  })

  it('ends a job of its own that no run wants, and leaves another deployment\'s on the same service alone', async () => {
    runJobs = false
    await startAll({ baseService: 'crn-test' })
    const job = (id: string, relay: string): Job => ({ id, service: 'crn-test', startCommand: `tini -- timeout -k 10 3660 node -e x ${relay}/instance ${'a'.repeat(32)} ${'b'.repeat(64)}`, planId: 'plan-crn-005', status: 'running', child: null })
    jobs.set('job-mine', job('job-mine', relayUrl))
    jobs.set('job-theirs', job('job-theirs', `https://alice.elsewhere.example${TEST_RELAY_PATH}`))
    await until(() => jobs.get('job-mine')?.status === 'canceled', 'its own orphan to be cancelled')
    await new Promise((done) => setTimeout(done, 300))
    expect(jobs.get('job-theirs')?.status).toBe('running')
  })

  it('moves a suite that runs docker to a sandbox', async () => {
    await startAll({ baseService: 'crn-test' })
    const script = `if (!process.env.DOCKER_HOST) { console.log('with Docker'); process.exit(0) }
      require('child_process').execFileSync('docker', ['info'], { stdio: 'inherit' })
      process.exit(9)`
    const { code, stdout, stderr } = await suite(repository(), [process.execPath, '-e', script], { DOCKER_HOST: '' }).done
    expect(code).toBe(0)
    expect(stdout).toBe('with Docker\n')
    expect(stderr).toContain('reached for Docker')
    await until(() => [...jobs.values()].every((job) => job.status !== 'running'), 'the job to end')
  })

  it('gives the agent the output and exit code, and the box ends with the suite', async () => {
    await startAll()
    const repo = repository()
    const script = 'console.log("to stdout " + process.cwd()); console.error("to stderr"); process.exit(7)'
    const { code, stdout, stderr } = await suite(repo, [process.execPath, '-e', script]).done
    expect(code).toBe(7)
    expect(stdout).toBe(`to stdout ${repo}\n`)
    expect(stderr).toContain('to stderr\n')
    expect(stderr).toContain('disposable test box')
    const box = runBox()
    // It ends at the time limit whatever else happens, and never sleeps through a quiet suite.
    expect(box).toMatchObject({ plan: '1c-2g', timeoutSeconds: 3660, idleTimeoutSeconds: 0 })
    await until(() => terminated.includes(box.id), 'the box to be terminated')
    expect(relay.runs.size).toBe(0)
  })

  it('runs the command exactly as it was typed, with nothing of this workspace\'s hooks', async () => {
    await startAll()
    const repo = repository()
    const runner = join(repo, 'vitest')
    writeFileSync(runner, 'console.log(JSON.stringify({ args: process.argv.slice(2), options: process.env.NODE_OPTIONS ?? null, path: process.env.PYTHONPATH ?? null }))')
    const hooked = { PYTHONPATH: hooks, NODE_OPTIONS: `--require "${join(hooks, 'hook.cjs')}"` }
    const { code, stdout } = await suite(repo, [process.execPath, runner, 'run', '--reporter=dot'], hooked).done
    expect(code).toBe(0)
    const seen = JSON.parse(stdout) as { args: string[]; options: string | null; path: string | null }
    expect(seen.args).toEqual(['run', '--reporter=dot'])
    expect(seen.options ?? '').not.toContain('hook.cjs')
    expect(seen.path).toBeNull()
  })

  it('unpacks the checkout, without what git ignores, at the same path', async () => {
    await startAll()
    const repo = repository()
    const { code } = await suite(repo, [process.execPath, '-e', 'process.exit(0)']).done
    expect(code).toBe(0)
    expect(readFileSync(join(unpacked, repo, 'tracked.txt'), 'utf8')).toBe('checked out\n')
    expect(existsSync(join(unpacked, repo, '.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(unpacked, repo, '.env'))).toBe(false)
  })

  it.skipIf(!GNU_TAR).each([null, 'crn-test'])('reuses verified dependency bytes with base service %s', async (baseService) => {
    await startAll({ baseService })
    const repo = committed()
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString()
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n')
    const deps = join(repo, 'node_modules')
    mkdirSync(deps)
    const file = join(deps, 'package.js')
    const when = new Date('2025-01-01T00:00:00Z')
    writeFileSync(file, 'first', { mode: 0o755 })
    utimesSync(file, when, when)
    linkSync(join(repo, 'tracked.txt'), join(deps, 'hard'))
    symlinkSync('package.js', join(deps, 'sym'))
    const script = `const fs = require('fs')
      const file = name => require('path').join(process.argv[1], name)
      const info = fs.statSync(file('node_modules/package.js'))
      console.log(JSON.stringify({
        text: fs.readFileSync(file('node_modules/sym'), 'utf8'),
        symlink: fs.readlinkSync(file('node_modules/sym')),
        hardlink: fs.statSync(file('node_modules/hard')).ino === fs.statSync(file('tracked.txt')).ino,
        mode: info.mode & 511, mtime: info.mtimeMs, ignored: fs.existsSync(file('.env'))
      }))
      process.exit(7)`
    const run = async (env: Record<string, string> = {}) => {
      uploads.length = 0
      unpacked = temp()
      return await suite(repo, [process.execPath, '-e', script, join(unpacked, repo)], env).done
    }
    const baseline = await run({ TAR_OPTIONS: '--format=gnu' })
    expect(baseline.code).toBe(7)
    const original = JSON.parse(baseline.stdout) as Record<string, unknown>
    expect(original).toEqual({ text: 'first', symlink: 'package.js', hardlink: true, mode: 0o755, mtime: when.getTime(), ignored: false })
    expect(uploads.filter(({ path }) => path === 'dependency')).toHaveLength(0)

    const cold = await run()
    expect({ code: cold.code, stdout: cold.stdout }).toEqual({ code: baseline.code, stdout: baseline.stdout })
    expect(uploads.some(({ path, bytes }) => path === 'dependency' && bytes > 0)).toBe(true)
    // Change where the dependency bytes begin in the full tar without touching those bytes.
    writeFileSync(join(repo, 'new-source.txt'), 'x'.repeat(4096))
    const warm = await run()
    expect({ code: warm.code, stdout: warm.stdout }).toEqual({ code: baseline.code, stdout: baseline.stdout })
    expect(uploads.filter(({ path }) => path === 'dependency')).toEqual([{ path: 'dependency', bytes: 0 }])

    writeFileSync(file, 'later')
    utimesSync(file, when, when)
    expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString()).toBe(head)
    const changed = await run()
    expect(changed.code).toBe(7)
    expect(JSON.parse(changed.stdout)).toEqual({ ...original, text: 'later' })
    expect(uploads.some(({ path, bytes }) => path === 'dependency' && bytes > 0)).toBe(true)
  })

  it.skipIf(!GNU_TAR)('replays dependency bytes captured on a hit after the relay restarts', async () => {
    await startAll()
    const repo = committed()
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    mkdirSync(join(repo, 'node_modules'))
    const dependency = join(repo, 'node_modules', 'fixture')
    writeFileSync(dependency, 'original')
    const script = "console.log(require('fs').readFileSync(process.argv[1], 'utf8')); setTimeout(() => {}, 300)"
    const command = [process.execPath, '-e', script, join(unpacked, repo, 'node_modules', 'fixture')]
    expect((await suite(repo, command).done).code).toBe(0)
    uploads.length = 0
    const run = suite(repo, command)
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    expect(uploads.filter(({ path }) => path === 'dependency')).toEqual([{ path: 'dependency', bytes: 0 }])
    writeFileSync(dependency, 'replaced')
    relay.stop()
    await startAll2()
    const { code, stdout, stderr } = await run.done
    expect(code).toBe(0)
    expect(stdout).toBe('original\noriginal\n')
    expect(stderr).toContain('relay recovered; rerunning candidate')
    expect(uploads.some(({ path, bytes }) => path === 'dependency' && bytes > 0)).toBe(true)
  })

  it('rejects a false dependency digest and only reuses bytes within the authenticated workspace', async () => {
    await startAll()
    const start = async (key: string) => {
      const headers = { authorization: `Bearer ${key}` }
      const created = await fetch(`${relayUrl}/runs`, {
        method: 'POST', headers, body: JSON.stringify({ argv: ['true'], cwd: '/', env: {} }),
      })
      const { id } = await created.json() as { id: string }
      const output = await fetch(`${relayUrl}/runs/${id}/output`, { headers })
      await until(() => relay.runs.get(id)?.ready === true, 'box ready')
      return { id, output, headers }
    }
    const alice = await start(KEY)
    const bob = await start(workspaceKey(privateKey, 'bob'))
    try {
      const raw = Buffer.from('dependency')
      const compressed = gzipSync(raw)
      const digest = createHash('sha256').update(raw).digest('hex')
      const post = (run: typeof alice, body?: Buffer, digestOverride = digest) =>
        fetch(`${relayUrl}/runs/${run.id}/dependency?sha256=${digestOverride}`, {
          method: 'POST', headers: run.headers, body: body ? new Uint8Array(body) : undefined,
        })
      expect((await post(alice, compressed, '0'.repeat(64))).status).toBe(422)
      expect((await post(alice, Buffer.concat([compressed, Buffer.alloc(512)]))).status).toBe(422)
      expect((await post(alice)).status).toBe(404)
      expect((await post(alice, compressed)).status).toBe(204)
      expect((await post(bob)).status).toBe(404)
      expect((await post(alice)).status).toBe(204)
      expect(readdirSync(join(runBox().dir, 'tmp/poise-tree'))).toEqual(['000000', '000001'])
    } finally {
      await alice.output.body?.cancel()
      await bob.output.body?.cancel()
    }
  })

  it('leaves the agent’s temporary folder behind, which can be too long for a Unix socket', async () => {
    await startAll()
    const script = 'console.log(process.env.TMPDIR, process.env.TMP, process.env.TEMP)'
    const folder = join(temp(), 'agent-tmp'.repeat(16))
    mkdirSync(folder)
    const tmp = { TMPDIR: folder, TMP: folder, TEMP: folder }
    const { code, stdout } = await suite(repository(), [process.execPath, '-e', script], tmp).done
    expect(code).toBe(0)
    expect(stdout).toBe('undefined undefined undefined\n')
  })

  it('gets large output through whole and in order', async () => {
    await startAll()
    const lines = 40_000
    const script = `for (let i = 0; i < ${lines}; i += 1) console.log('line ' + i + ' ' + 'x'.repeat(80))`
    const { code, stdout } = await suite(repository(), [process.execPath, '-e', script]).done
    expect(code).toBe(0)
    const received = stdout.trimEnd().split('\n')
    expect(received).toHaveLength(lines)
    expect(received.every((line, index) => line.startsWith(`line ${index} `))).toBe(true)
  })

  it('does not wait forever for what a suite left running with its output open', async () => {
    await startAll()
    const script = 'require("child_process").spawn("sleep", ["1000"], { stdio: "inherit", detached: true }).unref(); console.log("done"); process.exit(5)'
    const { code, stdout } = await suite(repository(), [process.execPath, '-e', script]).done
    expect(code).toBe(5)
    expect(stdout).toBe('done\n')
  })

  it('answers with the exit status of a suite that was killed', async () => {
    await startAll()
    const { code } = await suite(repository(), [process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")']).done
    expect(code).toBe(137)
  })

  it('says so when the command cannot start', async () => {
    await startAll()
    const { code, stderr } = await suite(repository(), ['/no/such/command']).done
    expect(code).toBe(127)
    expect(stderr).toContain('cannot start /no/such/command')
  })

  it.each([false, true])('retains observed output before a relay timeout (test failure: %s)', async (failed) => {
    await startAll({ limitSeconds: 2 })
    const started = Date.now()
    const assertion = `try { require('node:assert/strict').equal(1, 2) } catch (error) { console.error('FAIL fixture.validation::test_first_failure\\n' + error.stack) }; `
    const script = (failed ? assertion : '') + 'setInterval(() => {}, 1000)'
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', script]).done
    expect(code).toBe(124)
    expect(stderr).toContain('no test result: this suite is too big for its test box: it passed the 2 s time limit')
    expect(stderr).toContain('says nothing about your code. Skip local tests for this work')
    expect(stderr).toContain('let CI run the tests')
    const admission = /\[poise\] candidate ([a-f0-9]{64}), suite .*, run ([a-f0-9]{32})/.exec(stderr)
    expect(admission).not.toBeNull()
    expect(warnings).toContainEqual(expect.objectContaining({ event: 'test_relay.run.failed', id: admission![2] }))
    if (failed) {
      const failure = 'FAIL fixture.validation::test_first_failure\nAssertionError'
      expect(stderr).toContain(failure)
      expect(stderr.indexOf(admission![0])).toBeLessThan(stderr.indexOf(failure))
      expect(stderr.indexOf('AssertionError')).toBeLessThan(stderr.indexOf('no test result:'))
    } else expect(stderr).not.toContain('AssertionError')
    expect(Date.now() - started).toBeLessThan(10_000)
    const box = runBox()
    await until(() => terminated.includes(box.id), 'the box to be terminated')
  })

  it('destroys the box when the agent’s side is killed outright', async () => {
    await startAll()
    const { child, done } = suite(repository(), [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'])
    child.stdout?.once('data', () => { child.kill('SIGKILL') })
    await done
    const box = runBox()
    await until(() => terminated.includes(box.id), 'the box to be terminated')
    expect(relay.runs.size).toBe(0)
  })

  it('destroys the box when the agent’s side goes quiet with its connection open', async () => {
    await startAll({ leaseMs: 300 })
    const { child, done } = suite(repository(), [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'])
    child.stdout?.once('data', () => { child.kill('SIGSTOP') })
    await until(() => boxes.size > 0 && terminated.includes(runBox()?.id), 'the box to be terminated')
    child.kill('SIGKILL')
    await done
  })

  it('stops the run at once when the agent stops it, with no word of a failure', async () => {
    await startAll()
    const { child, done } = suite(repository(), [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'])
    child.stdout?.once('data', () => { child.kill('SIGTERM') })
    const { code, stderr } = await done
    expect(code).toBe(143)
    expect(stderr).not.toContain('no test result')
    expect(terminated).toContain(runBox().id)
  })

  it('recovers a mid-suite relay replacement with the captured input and continues through the existing chain gates', async () => {
    await startAll()
    const repo = repository()
    execFileSync('git', ['-C', repo, 'add', 'tracked.txt'])
    execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'])
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim()
    writeFileSync(join(repo, 'tracked.txt'), 'authorized uncommitted input\n')
    const db = new Database(':memory:')
    try {
      const journal = new BehaviorChainJournal(db)
      const reviewer = { slot: 'primary', model: 'fixture-model', recovery: 'fixture-model' }
      const now = Date.now(), context = 'c'.repeat(64)
      let chain = journal.append('example/repo#951', 'seed', 0, { type: 'chain.admitted', repository: 'Example/Repo', issue: 951,
        branch: 'poise/issue-951', author: 'author', reviewer: 'reviewer' }, now)
      const append = (event: ChainEvent) => { chain = journal.append(chain.id, `event-${chain.sequence}`, chain.sequence, event, now) }
      const obs: ChainObservation = { checkedAt: now, existingPulls: [],
        prerequisites: { wait: null, base: head, evidence: [] },
        issue: { open: true, eligible: true, revision: 'seed', commentIds: [] }, issueReviewers: [], prReviewers: [reviewer],
        implementer: reviewer, repairer: reviewer, approver: reviewer,
        publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null }, pull: null }
      expect(decideBehaviorChain(chain, obs, now)).toMatchObject({ kind: 'invoke', behavior: 'implement-issue' })
      append({ type: 'invocation.admitted', invocation: { id: 'implementation', behavior: 'implement-issue', basis: chainBasis(['issue', 'seed']),
        actor: 'author', model: reviewer.model, slot: reviewer.slot, admittedAt: now, request: { command: 'agent-interface', argv: [], cwd: repo } } })
      append({ type: 'invocation.started', invocationId: 'implementation' })

      const input = join(unpacked, repo, 'tracked.txt')
      const script = `console.log(JSON.stringify({ input: require('fs').readFileSync(process.argv[1], 'utf8'), cwd: process.cwd(), option: process.env.SUITE_OPTION })); setTimeout(() => console.log('complete'), 300)`
      const run = suite(repo, [process.execPath, '-e', script, input], { SUITE_OPTION: 'authorized' })
      await new Promise((done) => { run.child.stdout?.once('data', done) })
      const interrupted = runBox()
      const originalId = [...relay.runs.keys()][0]
      writeFileSync(join(repo, 'tracked.txt'), 'changed under the same HEAD\n')
      expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim()).toBe(head)
      expect(decideBehaviorChain(chain, obs, now)).toMatchObject({ kind: 'wait', reason: expect.stringContaining('started') })
      relay.stop()
      await startAll2()
      const { code, stdout, stderr } = await run.done
      expect(code).toBe(0)
      const line = JSON.stringify({ input: 'authorized uncommitted input\n', cwd: repo, option: 'authorized' })
      expect(stdout).toBe(`${line}\n${line}\ncomplete\n`)
      expect(stderr).toMatch(new RegExp(`interrupted validation: candidate [a-f0-9]{64}, suite .*run ${originalId}: no test result: the gateway restarted`))
      expect(stderr).toContain('retrying this captured suite once')
      expect(stderr).not.toContain('Skip local tests')
      const attempts = [...boxes.values()].filter((box) => box.snapshotName !== null)
      expect(attempts).toHaveLength(2)
      const uploaded = (box: Box) => Buffer.concat(readdirSync(join(box.dir, 'tmp/poise-tree')).sort().map((part) => readFileSync(join(box.dir, 'tmp/poise-tree', part))))
      expect(uploaded(attempts[1])).toEqual(uploaded(interrupted))
      expect(readFileSync(join(attempts[1].dir, 'tmp/poise-spec.json'))).toEqual(readFileSync(join(interrupted.dir, 'tmp/poise-spec.json')))
      expect(events.filter((event) => event.event === 'test_relay.run.finished')).toEqual([expect.objectContaining({ exit: 0 })])
      expect(events).toContainEqual(expect.objectContaining({ event: 'test_relay.run.killed', id: originalId, error: 'the gateway restarted' }))
      expect(terminated).toContain(interrupted.id)

      // Model publication/remote observations only after the real runner's fresh complete result.
      append({ type: 'invocation.settled', invocationId: 'implementation', callId: 'implementation', outcome: 'published',
        evidence: { status: 'completed', action: 'published', head_sha: head } })
      obs.publication = { pull_number: 21, head_sha: head, head_invocation: 'implementation', state: 'open', merged: false, merge_sha: null }
      obs.pull = { number: 21, head, headSince: now, state: 'open', draft: false, merged: false, mergeSha: null,
        queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
        reviewIds: [], reviewContext: context, reviewReceipts: [], reviewRevision: 'review', greyRuns: [], pending: true, failing: [], conflict: false, behind: false }
      expect(decideBehaviorChain(chain, obs, now)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
      const callId = '1'.repeat(32)
      const response = { repository: 'Example/Repo', pull_number: 21, head_sha: head, context_sha: context, invocation_id: callId,
        reviewer: 'reviewer', model: reviewer.model, completed_at: now,
        assessment: { verdict: 'Fixture candidate passes review.', reviewed_context: 'Fixture exact-head diff.', limitations: 'No live GitHub actions.' } }
      append({ type: 'invocation.admitted', invocation: { id: 'review', behavior: 'review-pr', basis: chainBasis(['pr', head, context]),
        actor: 'reviewer', model: reviewer.model, slot: reviewer.slot, admittedAt: now, request: { command: 'agent-interface', argv: [], cwd: repo } } })
      append({ type: 'invocation.settled', invocationId: 'review', callId, outcome: 'clean', evidence: { status: 'completed', action: 'reviewed_clean',
        review_id: 27, head_sha: head, completedAt: now, artifact: { review_response: response } } })
      obs.pull.reviewIds = [27]
      obs.pull.reviewReceipts = [{ id: 27, head, state: 'COMMENTED', invocation: callId, submittedAt: now, response }]
      expect(decideBehaviorChain(chain, obs, now)).toEqual({ kind: 'wait', reason: 'exact-head CI is still running' })
      obs.pull.pending = false
      expect(decideBehaviorChain(chain, obs, now)).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
      obs.pull.approved = true
      expect(decideBehaviorChain(chain, obs, now)).toEqual({ kind: 'wait', reason: 'native repository readiness gates are not satisfied' })
      obs.pull.ready = true
      expect(decideBehaviorChain(chain, obs, now)).toMatchObject({ kind: 'invoke', behavior: 'merge-pr' })
      obs.pull.head = 'd'.repeat(40)
      expect(decideBehaviorChain(chain, obs, now)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
      obs.pull.head = head
      append({ type: 'chain.observed', observation: structuredClone(obs) })
      obs.pull.merged = true; obs.pull.state = 'closed'; obs.pull.mergeSha = 'e'.repeat(40); obs.pull.mergedAt = now
      expect(decideBehaviorChain(chain, obs, now)).toEqual({ kind: 'complete', mergeSha: obs.pull.mergeSha })
      expect(chain.held).toBeNull()
      expect(db.prepare("SELECT count(*) AS count FROM behavior_chain_events WHERE json_extract(payload, '$.type') = 'chain.resumed'").get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it.each([7, 125])('returns a genuine suite exit %s without retrying, even if its output names a gateway restart', async (status) => {
    await startAll()
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', `console.error('the gateway restarted'); process.exit(${status})`]).done
    expect(code).toBe(status)
    expect(stderr).not.toContain('interrupted validation')
    expect([...boxes.values()].filter((box) => box.snapshotName !== null)).toHaveLength(1)
  })

  it('preserves a genuine failing result from the fresh suite after recovery', async () => {
    await startAll()
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setTimeout(() => process.exit(125), 300)'])
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    relay.stop()
    await startAll2()
    const { code, stdout, stderr } = await run.done
    expect(code).toBe(125)
    expect(stdout).toBe('started\nstarted\n')
    expect(stderr).toContain('interrupted validation')
    expect(stderr).not.toContain('Skip local tests')
    expect(events.filter((event) => event.event === 'test_relay.run.finished')).toEqual([expect.objectContaining({ exit: 125 })])
  })

  it('does not recover a dropped output stream without an explicit restart frame', async () => {
    await startAll()
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setInterval(() => {}, 1000)'])
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    relayServer.closeAllConnections()
    const { code, stderr } = await run.done
    expect(code).toBe(125)
    expect(stderr).toContain('the connection to the test relay broke')
    expect(stderr).not.toContain('interrupted validation')
    expect([...boxes.values()].filter((box) => box.snapshotName !== null)).toHaveLength(1)
  })

  it('refuses recovery when the workspace no longer owns relay access', async () => {
    await startAll()
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setInterval(() => {}, 1000)'])
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    relay.stop()
    await startAll2({ isWorkspace: () => false })
    const { code, stderr } = await run.done
    expect(code).toBe(125)
    expect(stderr).toContain('HTTP 401')
    expect(relay.runs.size).toBe(0)
    expect([...boxes.values()].filter((box) => box.snapshotName !== null)).toHaveLength(1)
  })

  it('cancels while waiting for recovery without starting another run', async () => {
    await startAll()
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setInterval(() => {}, 1000)'])
    let notices = ''
    run.child.stderr?.on('data', (chunk) => { notices += chunk })
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    relay.stop()
    await new Promise((done) => { relayServer.close(done) })
    await until(() => notices.includes('waiting up to 30 s'), 'the recovery wait')
    run.child.kill('SIGTERM')
    const { code, stderr } = await run.done
    expect(code).toBe(143)
    expect(stderr).not.toContain('Skip local tests')
    await startAll2()
    await new Promise((done) => setTimeout(done, 1100))
    expect(relay.runs.size).toBe(0)
    expect([...boxes.values()].filter((box) => box.snapshotName !== null)).toHaveLength(1)
  })

  it('does not retry a second gateway restart', async () => {
    await startAll()
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setInterval(() => {}, 1000)'])
    let starts = 0
    run.child.stdout?.on('data', () => { starts += 1 })
    await until(() => starts === 1, 'the first suite to start')
    relay.stop()
    await startAll2()
    await until(() => starts === 2, 'the fresh suite to start')
    relay.stop()
    const { code, stderr } = await run.done
    expect(code).toBe(125)
    expect(stderr.match(/interrupted validation:/g)).toHaveLength(2)
    expect(stderr).toContain("don't retry")
    expect(events.filter((event) => event.event === 'test_relay.run.finished')).toEqual([])
    expect([...boxes.values()].filter((box) => box.snapshotName !== null)).toHaveLength(2)
  })

  it('keeps the recovery wait within the original command budget', async () => {
    await startAll()
    const started = Date.now()
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setInterval(() => {}, 1000)'], { BASH_DEFAULT_TIMEOUT_MS: '2500' })
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    relay.stop()
    await new Promise((done) => { relayServer.close(done) })
    const { code, stderr } = await run.done
    expect(code).toBe(124)
    expect(stderr).toContain('no test result: the test offload exhausted its total time budget')
    expect(Date.now() - started).toBeLessThan(4500)
    expect([...boxes.values()].filter((box) => box.snapshotName !== null)).toHaveLength(1)
  })

  it('keeps the full rerun within the remaining command budget', async () => {
    await startAll()
    const started = Date.now()
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setTimeout(() => console.log("complete"), 2500)'], { BASH_DEFAULT_TIMEOUT_MS: '3500' })
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    await new Promise((done) => setTimeout(done, 500))
    relay.stop()
    await startAll2()
    const { code, stdout, stderr } = await run.done
    expect(code).toBe(124)
    expect(stdout).toBe('started\nstarted\n')
    expect(stderr).toContain('total time budget')
    expect(Date.now() - started).toBeLessThan(5500)
    expect(events.filter((event) => event.event === 'test_relay.run.finished')).toEqual([])
    await until(() => relay.runs.size === 0, 'the timed-out run to be retired')
  })

  it('gives up when the relay never recovers', async () => {
    await startAll()
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setInterval(() => {}, 1000)'])
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    const started = Date.now()
    relay.stop()
    await new Promise((done) => { relayServer.close(done) })
    const { code, stderr } = await run.done
    expect(code).toBe(125)
    expect(stderr).toContain('the test relay did not recover within 30 s')
    expect(stderr).toContain("don't retry")
    expect(Date.now() - started).toBeLessThan(35_000)
    expect(events.filter((event) => event.event === 'test_relay.run.finished')).toEqual([])
  }, 40_000)

  it('recovers mid-suite when only one suite may run', async () => {
    await startAll({ maxRuns: 1 })
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setTimeout(() => console.log("complete"), 300)'])
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    relay.stop()
    await startAll2({ maxRuns: 1 })
    const { code, stdout, stderr } = await run.done
    expect(code).toBe(0)
    expect(stdout).toBe('started\nstarted\ncomplete\n')
    expect(stderr).toContain('interrupted validation')
    expect(stderr).not.toContain('with HTTP 429:')
    expect(stderr).not.toContain('Skip local tests')
    expect(relay.runs.size).toBe(0)
    expect([...boxes.values()].filter((box) => box.snapshotName !== null)).toHaveLength(2)
  })

  it('sends no second admission after a lost admission response', async () => {
    await startAll({ maxRuns: 1 })
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setInterval(() => {}, 1000)'])
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    relay.stop()
    await startAll2({ maxRuns: 1 })
    let admissions = 0
    const inner = relayServer.listeners('request').slice()
    relayServer.removeAllListeners('request')
    relayServer.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://relay')
      if (req.method === 'POST' && url.pathname === `${TEST_RELAY_PATH}/runs`) {
        admissions += 1
        if (admissions === 1) {
          // The run is admitted, but its response never reaches the runner.
          res.end = ((() => { res.destroy(); return res }) as typeof res.end)
          void relay.handle(req, res, url).then(() => res.destroy(), () => res.destroy())
          return
        }
      }
      for (const listener of inner) (listener as (req: IncomingMessage, res: ServerResponse) => void)(req, res)
    })
    const { code, stderr } = await run.done
    expect(code).toBe(125)
    expect(admissions).toBe(1)
    expect(relay.runs.size).toBe(1)
    expect(stderr).toContain('interrupted validation')
    expect(stderr.match(/interrupted validation:/g)).toHaveLength(1)
    expect(stderr).not.toContain('with HTTP 429:')
  })

  it('sends no second admission after a 502 admission response that already created a run', async () => {
    await startAll({ maxRuns: 1 })
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setInterval(() => {}, 1000)'])
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    relay.stop()
    await startAll2({ maxRuns: 1 })
    let admissions = 0
    const inner = relayServer.listeners('request').slice()
    relayServer.removeAllListeners('request')
    relayServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://relay')
      if (req.method === 'POST' && url.pathname === `${TEST_RELAY_PATH}/runs`) {
        admissions += 1
        if (admissions === 1) {
          // A proxy surfaces the created run as 502: the run exists, but the runner must not retry.
          const writeHead = res.writeHead.bind(res)
          res.writeHead = ((status: number, ...args: unknown[]) => {
            if (status === 201) return (writeHead as (...a: unknown[]) => ServerResponse)(502, ...args)
            return (writeHead as (...a: unknown[]) => ServerResponse)(status, ...args)
          }) as typeof res.writeHead
        }
      }
      for (const listener of inner) (listener as (req: IncomingMessage, res: ServerResponse) => void)(req, res)
    })
    const { code, stderr } = await run.done
    expect(code).toBe(125)
    expect(admissions).toBe(1)
    expect(relay.runs.size).toBe(1)
    expect(stderr).toContain('interrupted validation')
    expect(stderr.match(/interrupted validation:/g)).toHaveLength(1)
    expect(stderr).toContain('with HTTP 502:')
    // Include a fixed candidate so a bare '429' matcher fails deterministically.
    const diagnostic = `[poise] candidate 3130f072cc429ca49bddbe2d94e0cbbd8ba976a23e83aa221c696923f4741878
${stderr}`
    expect(diagnostic).not.toContain('with HTTP 429:')
  })

  it('recovers when the restart reaches the upload before its fail frame is read', async () => {
    await startAll()
    const repo = repository()
    let held: { req: IncomingMessage; res: ServerResponse } | null = null
    let heldOnce = false
    let failFrame: Buffer | null = null
    let failEnd = false
    const releaser: { release: (() => void) | null } = { release: null }
    const inner = relayServer.listeners('request').slice()
    relayServer.removeAllListeners('request')
    relayServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://relay')
      if (req.method === 'GET' && url.pathname.endsWith('/output')) {
        const write = res.write.bind(res)
        const end = res.end.bind(res)
        res.write = ((chunk: any, ...args: any[]) => {
          if (Buffer.isBuffer(chunk) && chunk.length > 0 && chunk[0] === 4) {
            failFrame = chunk
            return true
          }
          return (write as (...a: any[]) => boolean)(chunk, ...args)
        }) as typeof res.write
        res.end = ((...args: any[]) => {
          if (failFrame) { failEnd = true; return res }
          return (end as (...a: any[]) => ServerResponse)(...args)
        }) as typeof res.end
        releaser.release = () => {
          if (failFrame) (write as (c: Buffer) => void)(failFrame)
          failFrame = null
          if (failEnd) (end as () => void)()
          failEnd = false
        }
      } else if (req.method === 'POST' && url.pathname.endsWith('/tree') && !heldOnce) {
        heldOnce = true
        held = { req, res }
        req.resume()
        return
      }
      for (const listener of inner) (listener as (req: IncomingMessage, res: ServerResponse) => void)(req, res)
    })
    const run = suite(repo, [process.execPath, '-e', 'console.log("started"); setTimeout(() => console.log("complete"), 300)'])
    await until(() => held !== null, 'the upload to start')
    relay.stop()
    await until(() => failFrame !== null, 'the restart frame to be queued')
    const pending = held as unknown as { req: IncomingMessage; res: ServerResponse }
    held = null
    pending.res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' }).end('this run is over')
    pending.req.resume()
    // Let the runner process the upload 410 before the restart frame arrives: the old code
    // aborts the output here and never recovers.
    await new Promise((done) => setTimeout(done, 200))
    releaser.release?.()
    await startAll2()
    const { code, stdout, stderr } = await run.done
    expect(code).toBe(0)
    expect(stdout).toBe('started\ncomplete\n')
    expect(stderr).toContain('interrupted validation')
    expect(stderr).toContain('no test result: the gateway restarted')
    expect(stderr).not.toContain('Skip local tests')
    expect([...boxes.values()].filter((box) => box.snapshotName !== null)).toHaveLength(2)
  })

  it('says nothing of memory when a suite that mentions it passes', async () => {
    await startAll()
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', `console.log('cannot allocate memory, as this test expected')`]).done
    expect(code).toBe(0)
    expect(stderr).not.toContain('no test result')
  })

  it('leaves a failing suite\'s exit code alone, whatever it says about memory', async () => {
    await startAll()
    // The background sweep can warn before the run fails.
    warnings.push({ event: 'test_relay.sweep.failed', error: 'unrelated sweep failure' })
    const script = `console.log('cannot allocate memory: heap out of memory, as this test expected'); process.exit(7)`
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', script]).done
    expect(code).toBe(7)
    expect(stderr).not.toContain('no test result')
    expect(warnings.filter(({ event }) => event === 'test_relay.run.failed')).toEqual([])
  })

  it('tells a suite too big for its memory from one that failed, and sends the agent to CI', async () => {
    await startAll()
    // The background sweep can warn before the run fails.
    warnings.push({ event: 'test_relay.sweep.failed', error: 'unrelated sweep failure' })
    const script = `console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'); process.exit(134)`
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', script]).done
    expect(code).toBe(125)
    expect(stderr).toContain('no test result: this suite is too big for its test box: it ran out of memory')
    expect(stderr).toContain('says nothing about your code. Skip local tests for this work')
    expect(stderr).toContain('let CI run the tests')
    // Choosing tests is no job of an agent's.
    expect(stderr).not.toContain('name a')
    // Poise hears of it too, with what it needs to find the suite.
    const [warning] = warnings.filter(({ event }) => event === 'test_relay.run.failed')
    expect(warning.event).toBe('test_relay.run.failed')
    expect(warning.error).toContain('this suite is too big for its test box: it ran out of memory')
    expect(warning.error).toContain('workspace alice')
    expect(warning.error).toContain('command node -e')
  })

  it('fails loud when the box dies without a word', async () => {
    await startAll()
    const { child, done } = suite(repository(), [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'])
    child.stdout?.once('data', () => {
      const box = runBox()
      box.status = 'errored'
      box.child?.kill('SIGKILL')
    })
    const { code, stderr } = await done
    expect(code).toBe(125)
    expect(stderr).toContain('no test result')
    expect(stderr).toContain('says nothing about your code')
  })

  it('keeps a healthy run whose box took long to get, however far Render\'s list lags', async () => {
    setupMs = 800
    listLagMs = 400
    await startAll({ listGraceMs: 600 })
    const { code, stdout } = await suite(repository(), [process.execPath, '-e', 'console.log("up"); setTimeout(() => {}, 300)']).done
    expect(code).toBe(0)
    expect(stdout).toBe('up\n')
  })

  it('builds once for suites that wait together, and all hear when that fails', async () => {
    setupExit = 1
    setupMs = 200
    await startAll()
    const runs = await Promise.all([1, 2, 3].map(() => suite(repository(), [process.execPath, '-e', 'process.exit(0)']).done))
    for (const { code, stderr } of runs) {
      expect(code).toBe(125)
      expect(stderr).toContain('setting up the test box failed')
    }
    // The one the relay began on starting, and then the one all three waited on.
    expect(setups).toBeLessThanOrEqual(2)
    expect(groups).toHaveLength(1)
  })

  it('leaves alone the boxes of another deployment in the same Render workspace', async () => {
    await startAll({ deployment: 'a.example.com' })
    await until(() => groups.length === 1, 'the group to exist')
    boxes.set('sbx-99', { id: 'sbx-99', plan: 'p', group: 'sbg-other', snapshotName: 'x', timeoutSeconds: 1, idleTimeoutSeconds: 0, createdAt: '2020-01-01T00:00:00Z', status: 'running', child: null, dir: temp() })
    await new Promise((resolved) => setTimeout(resolved, 300))
    expect(terminated).not.toContain('sbx-99')
  })

  it('terminates a box no live run owns, as a restart leaves behind', async () => {
    await startAll()
    await until(() => relay !== undefined && groups.length === 1, 'the group to exist')
    boxes.set('sbx-99', { id: 'sbx-99', plan: 'p', group: 'sbg-0', snapshotName: 'x', timeoutSeconds: 1, idleTimeoutSeconds: 0, createdAt: '2020-01-01T00:00:00Z', status: 'running', child: null, dir: temp() })
    await until(() => terminated.includes('sbx-99'), 'the orphan to be terminated')
  })

  it('keeps a box whose run does not know its id yet', async () => {
    await startAll()
    await until(() => groups.length === 1, 'the group to exist')
    boxes.set('sbx-99', { id: 'sbx-99', plan: 'p', group: 'sbg-0', snapshotName: 'x', timeoutSeconds: 1, idleTimeoutSeconds: 0, createdAt: new Date().toISOString(), status: 'running', child: null, dir: temp() })
    await new Promise((resolved) => setTimeout(resolved, 300))
    expect(terminated).not.toContain('sbx-99')
  })

  it('fails loud when Render refuses, and never runs the suite here', async () => {
    await startAll({ renderApiKey: 'wrong' })
    const repo = repository()
    const marker = join(repo, 'ran-here')
    const { code, stderr } = await suite(repo, [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`]).done
    expect(code).toBe(125)
    expect(stderr).toContain('no test result: no test box could start')
    expect(existsSync(marker)).toBe(false)
  })

  it('fails loud at the limit on suites at once', async () => {
    await startAll({ maxRuns: 1 })
    const first = suite(repository(), [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'])
    await until(() => relay.runs.size === 1, 'the first run')
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', 'process.exit(0)']).done
    expect(code).toBe(125)
    expect(stderr).toContain('1 suites are already running')
    expect(stderr).toContain('with HTTP 429:')
    expect(() => expect(stderr).not.toContain('with HTTP 429:')).toThrow()
    first.child.kill('SIGKILL')
    await first.done
  })

  it('builds what boxes start from once, in their own group, and reuses it', async () => {
    await startAll()
    expect((await suite(repository(), [process.execPath, '-e', 'process.exit(0)']).done).code).toBe(0)
    expect((await suite(repository(), [process.execPath, '-e', 'process.exit(0)']).done).code).toBe(0)
    expect(setups).toBe(1)
    expect(groups).toEqual([expect.stringMatching(/^poise-test-boxes-[0-9a-f]{16}$/)])
    expect(snapshots.size).toBe(1)
    const [snapshot] = snapshots.values()
    expect(snapshot.name).toMatch(/^box-[0-9a-f]{32}$/)
    const builder = [...boxes.values()].find((box) => box.snapshotName === null) as Box
    expect(terminated).toContain(builder.id)
    expect(Date.parse(snapshot.expiresAt)).toBeGreaterThan(Date.now() + 300 * 24 * 3_600_000)
    // A restart finds it, and a snapshot about to expire gets replaced.
    relay.stop()
    await startAll2()
    await until(() => relay.runs !== undefined && groups.length === 1, 'the relay')
    expect((await suite(repository(), [process.execPath, '-e', 'process.exit(0)']).done).code).toBe(0)
    expect(setups).toBe(1)
    expect(groups).toHaveLength(1)
    snapshot.expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    relay.stop()
    await startAll2()
    await until(() => setups === 2, 'the snapshot to be built again')
  })

  // Another gateway, of the same Render workspace.
  async function startAll2(overrides: Partial<TestRelayDeps['config']> & Partial<TestRelayDeps> = {}): Promise<void> {
    const { maxRuns = 5, ...deps } = overrides
    const port = Number(new URL(relayUrl).port)
    await new Promise((done) => { relayServer.close(done) })
    relay = new TestRelay({
      config: { renderApiKey: 'render-key', workspace: 'tea-test', deployment: 'poise.example.com', plan: '1c-2g', baseService: null, jobPlan: 'plan-crn-005', limitSeconds: 3600, maxRuns },
      privateKey,
      origin: () => relayOrigin,
      log: { info: (event: string, fields: Record<string, unknown>) => { events.push({ event, ...fields }) }, warn: () => {}, error: () => {} } as unknown as TestRelayDeps['log'],
      now: Date.now,
      isWorkspace: (handle) => handle === 'alice' || handle === 'bob',
      renderApi: `${renderOrigin}/v1`,
      sweepMs: 50,
      renderSweepMs: 100,
      pollMs: 10,
      ...deps,
    })
    relayServer = createServer(serveRelay)
    relayUrl = `http://127.0.0.1:${await listen(relayServer, port)}${TEST_RELAY_PATH}`
    relay.start()
    writeFileSync(join(hooks, 'relay'), `${relayUrl}\n${KEY}\n`)
  }

  it('builds it again after a setup that failed, and says why until then', async () => {
    setupExit = 1
    await startAll()
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', 'process.exit(0)']).done
    expect(code).toBe(125)
    expect(stderr).toContain('setting up the test box failed with exit code 1: set up')
    expect(snapshots.size).toBe(0)
    setupExit = 0
    expect((await suite(repository(), [process.execPath, '-e', 'process.exit(0)']).done).code).toBe(0)
    expect(snapshots.size).toBe(1)
  })

  it('accepts only a workspace\'s key, and each workspace only its own run', async () => {
    runBoxes = false
    await startAll()
    const post = (path: string, authorization?: string, body = '{"argv":["x"],"cwd":"/","env":{}}') => fetch(`${relayUrl}${path}`, { method: 'POST', body, headers: authorization ? { authorization } : {} })
    const forged = workspaceKey(generateKeyPairSync('ed25519').privateKey, 'alice')
    expect((await post('/runs')).status).toBe(401)
    expect((await post('/runs', `Bearer ${forged}`)).status).toBe(401)
    expect((await post('/runs', 'Bearer alice.')).status).toBe(401)
    expect((await post('/runs', `Bearer ${workspaceKey(privateKey, 'carol')}`)).status).toBe(401)
    const created = await post('/runs', `Bearer ${KEY}`)
    expect(created.status).toBe(201)
    const { id } = await created.json() as { id: string }
    // Another workspace's key opens nothing of this one's.
    const bob = `Bearer ${workspaceKey(privateKey, 'bob')}`
    expect((await post(`/runs/${id}/lease`, bob)).status).toBe(403)
    expect((await post(`/runs/${id}/tree`, bob)).status).toBe(403)
    expect((await fetch(`${relayUrl}/runs/${id}/output`, { headers: { authorization: bob } })).status).toBe(403)
    expect((await fetch(`${relayUrl}/runs/${id}`, { method: 'DELETE', headers: { authorization: bob } })).status).toBe(403)
    expect((await post(`/runs/${id}/lease`)).status).toBe(401)
    expect((await post('/runs', `Bearer ${KEY}`, '{"argv":[]}')).status).toBe(400)
    // A workspace's key reads nothing a job reads, and with no jobs there is no job's script either.
    expect((await fetch(`${relayUrl}/runs/${id}/spec`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(410)
    expect((await fetch(`${relayUrl}/instance`)).status).toBe(404)
  })

  it('answers a job\'s requests only with that job\'s token, and serves its scripts where jobs run', async () => {
    runBoxes = false
    await startAll({ baseService: 'crn-test' })
    const created = await fetch(`${relayUrl}/runs`, { method: 'POST', body: '{"argv":["x"],"cwd":"/","env":{}}', headers: { authorization: `Bearer ${KEY}` } })
    const { id } = await created.json() as { id: string }
    for (const authorization of [`Bearer ${KEY}`, `Bearer ${'0'.repeat(64)}`, '']) {
      expect((await fetch(`${relayUrl}/runs/${id}/spec`, { headers: { authorization } })).status).toBe(410)
      expect((await fetch(`${relayUrl}/runs/${id}/docker`, { method: 'POST', headers: { authorization } })).status).toBe(410)
    }
    expect(relay.runs.has(id)).toBe(true)
    expect((await fetch(`${relayUrl}/instance`)).status).toBe(200)
    expect(await (await fetch(`${relayUrl}/instance/box`)).text()).toBe(readFileSync('gateway/src/test-box.cjs', 'utf8'))
  })
})

describe('a job unpacking', () => {
  // A job is the workspace image, whose tar is GNU's; elsewhere its flags mean nothing.
  const gnuTar = spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU tar') ?? false

  it.runIf(gnuTar)('unpacks with flags GNU tar takes, and leaves what is already there', () => {
    const { JOB_UNPACK } = createRequire(import.meta.url)('../gateway/src/test-box.cjs') as { JOB_UNPACK: string[] }
    const from = temp()
    const to = temp()
    mkdirSync(join(from, 'dir'))
    writeFileSync(join(from, 'dir', 'new'), 'sent')
    writeFileSync(join(from, 'dir', 'kept'), 'sent')
    execFileSync('tar', ['-czf', join(from, 'tree.tgz'), '-C', from, 'dir'])
    mkdirSync(join(to, 'dir'))
    writeFileSync(join(to, 'dir', 'kept'), 'the image\'s')
    const result = spawnSync('tar', ['-xzf', join(from, 'tree.tgz'), '-C', to, '--no-same-owner', ...JOB_UNPACK], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(readFileSync(join(to, 'dir', 'new'), 'utf8')).toBe('sent')
    expect(readFileSync(join(to, 'dir', 'kept'), 'utf8')).toBe('the image\'s')
  })

  // Root may write anywhere, so only another user meets a folder it may not write.
  it.runIf(gnuTar && process.getuid?.() !== 0)('leaves what the image\'s folders hold to the image, and fails on anything else', () => {
    const { JOB_UNPACK, onlyImageFolders } = createRequire(import.meta.url)('../gateway/src/test-box.cjs') as { JOB_UNPACK: string[]; onlyImageFolders: (code: number | null, errors: string, into: string) => boolean }
    const from = temp()
    const to = temp()
    mkdirSync(join(from, 'image', 'lib', 'newer'), { recursive: true })
    writeFileSync(join(from, 'image', 'lib', 'newer', 'file'), 'sent')
    symlinkSync('newer/file', join(from, 'image', 'lib', 'link'))
    mkdirSync(join(from, 'checkout'))
    writeFileSync(join(from, 'checkout', 'file'), 'sent')
    execFileSync('tar', ['-czf', join(from, 'tree.tgz'), '-C', from, 'image', 'checkout'])
    mkdirSync(join(to, 'image', 'lib'), { recursive: true })
    chmodSync(join(to, 'image', 'lib'), 0o555)
    try {
      const result = spawnSync('tar', ['-xzf', join(from, 'tree.tgz'), '-C', to, '--no-same-owner', ...JOB_UNPACK], { encoding: 'utf8' })
      expect(result.status).toBe(2)
      expect(onlyImageFolders(result.status, result.stderr, to)).toBe(true)
      expect(readFileSync(join(to, 'checkout', 'file'), 'utf8')).toBe('sent')
      const [allowed, end] = [result.stderr.trim().split('\n').slice(0, -1).join('\n'), 'tar: Exiting with failure status due to previous errors']
      expect(onlyImageFolders(2, `${allowed}\ntar: checkout/other: Cannot write: No space left on device\n${end}\n`, to)).toBe(false)
      expect(onlyImageFolders(2, `tar: checkout/x: Cannot open: Permission denied\n${end}\n`, to)).toBe(false)
      // A tar stopped by a signal, or before its last word, has not gone through the archive.
      expect(onlyImageFolders(null, result.stderr, to)).toBe(false)
      expect(onlyImageFolders(2, `${allowed}\n`, to)).toBe(false)
    } finally {
      chmodSync(join(to, 'image', 'lib'), 0o755)
    }
  })
})

describe('what a box starts from', () => {
  it('has the Chromium this repository\'s Playwright expects', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version: string }> }
    expect(readFileSync('gateway/src/test-box-setup.sh', 'utf8')).toContain(`playwright@${lock.packages['node_modules/@playwright/test'].version} install`)
  })
})

describe('the frame reader', () => {
  it('reads frames whatever pieces they arrive in', () => {
    const frames: [number, string][] = []
    const read = frameReader((type: number, payload: Buffer) => { frames.push([type, payload.toString()]) })
    const encode = (type: number, text: string) => {
      const header = Buffer.alloc(5)
      header[0] = type
      header.writeUInt32BE(Buffer.byteLength(text), 1)
      return Buffer.concat([header, Buffer.from(text)])
    }
    const stream = Buffer.concat([encode(1, 'hello'), encode(0, ''), encode(2, 'wörld')])
    for (const byte of stream) read(Buffer.from([byte]))
    expect(frames).toEqual([[1, 'hello'], [0, ''], [2, 'wörld']])
  })
})
