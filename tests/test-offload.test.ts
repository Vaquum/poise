// @vitest-environment node
// Agents' test suites run on disposable test instances: these run the real hooks, runner, relay and
// instance script, with only Render itself replaced. docs/Operating.md, "Agents' test suites".
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_RELAY_PATH, TestRelay, workspaceKey, type TestRelayDeps } from '../gateway/src/test-relay'
import { changeBase, filesToSend, frameReader, testEnvironment } from '../scripts/test-offload/run.mjs'
import { scrubbedChildEnvironment } from '../server/process'

const SOURCE = resolve('scripts/test-offload')
const INSTANCE = resolve('gateway/src/test-instance.cjs')
// How test-relay.ts starts it, with the fetched script replaced by this checkout's.
const instanceArgs = (...args: string[]) => ['-e', `require(${JSON.stringify(INSTANCE)})`, ...args]
const { privateKey } = generateKeyPairSync('ed25519')
const KEY = workspaceKey(privateKey, 'alice')

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

describe('what reaches a test instance', () => {
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
    }, hooks, 'abc123')
    expect(env).toEqual({
      PATH: '/venv/bin:/usr/bin',
      HOME: '/home/poise',
      TMPDIR: '/run/tmp',
      CI: '1',
      FOO: 'bar',
      PYTEST_ADDOPTS: '-q',
      // The hooks go along, once each, and fit the suite to the instance there.
      PYTHONPATH: `${hooks}:src`,
      NODE_OPTIONS: `--require "${hooks}/hook.cjs" --max-old-space-size=4096`,
      POISE_TEST_INSTANCE: '1',
      POISE_TEST_CHANGED_SINCE: 'abc123',
    })
  })

  it('sets the hooks where a command replaced them, and says nothing of a change it cannot place', () => {
    const hooks = '/h'
    expect(testEnvironment({ PYTHONPATH: 'src', NODE_OPTIONS: '--no-warnings' }, hooks)).toEqual({
      PYTHONPATH: '/h:src',
      NODE_OPTIONS: '--require "/h/hook.cjs" --no-warnings',
      POISE_TEST_INSTANCE: '1',
    })
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
    // The hooks go along too, to fit the suite to the instance.
    expect(paths).toEqual(expect.arrayContaining([join(SOURCE, 'hook.cjs'), join(SOURCE, 'sitecustomize.py')]))
    const names = paths.filter((path: string) => path.startsWith(repo)).map((path: string) => path.slice(repo.length + 1))
    expect(names.sort()).toEqual(['.git', '.gitignore', '.venv', 'node_modules', 'sub/node_modules', 'tracked.py', 'untracked.py'])
  })

  it('sends an interpreter that lives outside the checkout, unless every instance has it', () => {
    const repo = checkout()
    const elsewhere = temp()
    const venv = join(elsewhere, 'venv')
    const base = join(elsewhere, 'cpython-3.12.1')
    const link = join(elsewhere, 'cpython-3.12')
    mkdirSync(venv)
    mkdirSync(base)
    symlinkSync(base, link)
    const paths = filesToSend(repo, [venv, link, '/opt/python/cpython-3.13-linux-x86_64-gnu', '/usr/lib/python3'], {}, '/nowhere')
    expect(paths).toEqual(expect.arrayContaining([venv, link, base]))
    expect(paths.filter((path: string) => path.startsWith('/opt/') || path.startsWith('/usr/'))).toEqual([])
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
    expect(filesToSend(scratch, [], { TMPDIR: tmp }, home)).toContain(scratch)
    expect(filesToSend(scratch, [], { TMPDIR: tmp }, home).filter((path: string) => !path.startsWith(SOURCE))).toEqual([scratch])
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
    const { env } = hooked(true)
    const repo = temp()
    execFileSync('git', ['init', '-q', repo])
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true })
    const marker = join(repo, 'ran-here')
    writeFileSync(join(repo, 'node_modules', '.bin', 'vitest'), `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`)
    const result = attempt([join(repo, 'node_modules', '.bin', 'vitest'), 'run'], env, repo)
    expect(result.status).toBe(125)
    expect(result.stderr).toContain('[poise]')
    expect(existsSync(marker)).toBe(false)
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
})

describe('on a test instance, a command for the whole suite', () => {
  function changed(files: Record<string, string>, later: Record<string, string>): { repo: string; since: string } {
    const repo = temp()
    execFileSync('git', ['init', '-q', repo])
    const write = (group: Record<string, string>) => {
      for (const [path, text] of Object.entries(group)) {
        mkdirSync(join(repo, path, '..'), { recursive: true })
        writeFileSync(join(repo, path), text)
      }
    }
    write(files)
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, ...args]).toString().trim()
    git('add', '.')
    git('commit', '-qm', 'base')
    const since = git('rev-parse', 'HEAD')
    write(later)
    return { repo, since }
  }
  const instanceEnv = (hooks: string, since: string | null): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, POISE_TEST_INSTANCE: '1', PYTHONPATH: hooks, NODE_OPTIONS: `--require "${join(hooks, 'hook.cjs')}"` }
    if (since) env.POISE_TEST_CHANGED_SINCE = since
    return env
  }
  // A runner that says what it was asked to run, as it would read it.
  const pytest = (repo: string, args: string[], since: string | null) => {
    writeFileSync(join(repo, 'pytest'), 'import json, os, sys\nprint(json.dumps({"args": sys.argv[1:], "nested": os.environ.get("POISE_TEST_INSTANCE")}))\n')
    const result = spawnSync('python3', ['pytest', ...args], { cwd: repo, encoding: 'utf8', env: instanceEnv(SOURCE, since) })
    return { status: result.status, stderr: result.stderr, seen: result.stdout ? JSON.parse(result.stdout) as { args: string[]; nested: string | null } : null }
  }
  const FILES = {
    'src/pricing.py': 'x = 1\n',
    'src/other.py': 'x = 1\n',
    'tests/test_pricing.py': 'from src import pricing\n',
    'tests/test_other.py': 'from src import other\n',
    'README.md': 'x\n',
  }

  it('runs the Python tests that touch the change, and only those', () => {
    const { repo, since } = changed(FILES, { 'src/pricing.py': 'x = 2\n' })
    const { status, stderr, seen } = pytest(repo, ['-q', '-m', 'not live'], since)
    expect(status).toBe(0)
    expect(seen?.args).toEqual(['-q', '-m', 'not live', 'tests/test_pricing.py'])
    expect(stderr).toContain('running only the 1 test files this change touches')
    expect(seen?.nested).toBeNull()
  })

  it('counts a changed test file and a new one, and leaves out a deleted one', () => {
    const { repo, since } = changed(FILES, { 'tests/test_other.py': 'x = 2\n', 'tests/test_new.py': 'x = 1\n' })
    rmSync(join(repo, 'tests/test_pricing.py'))
    expect(pytest(repo, [], since).seen?.args).toEqual(['tests/test_new.py', 'tests/test_other.py'])
  })

  it('answers at once when no test touches it', () => {
    const { repo, since } = changed(FILES, { 'README.md': 'y\n' })
    const { status, stderr, seen } = pytest(repo, ['-q'], since)
    expect(status).toBe(0)
    expect(seen).toBeNull()
    expect(stderr).toContain('no test touches this change')
  })

  it('stays whole when the change can touch anything', () => {
    const { repo, since } = changed(FILES, { 'conftest.py': 'x = 1\n' })
    expect(pytest(repo, ['-q'], since).seen?.args).toEqual(['-q'])
  })

  it('stays as asked when the command names its tests, or no change can be placed', () => {
    const { repo, since } = changed(FILES, { 'src/pricing.py': 'x = 2\n' })
    expect(pytest(repo, ['tests/test_other.py'], since).seen?.args).toEqual(['tests/test_other.py'])
    expect(pytest(repo, ['-q'], null).seen?.args).toEqual(['-q'])
  })

  it('runs with one worker however many were asked for', () => {
    const { repo, since } = changed(FILES, { 'README.md': 'y\n' })
    for (const [asked, fitted] of [[['-n', '10'], ['-n', '0']], [['-n', 'auto'], ['-n', '0']], [['-n4'], ['-n0']], [['-nauto'], ['-n0']], [['--numprocesses=8'], ['--numprocesses=0']], [['--numprocesses', '8'], ['--numprocesses', '0']]]) {
      expect(pytest(repo, [...asked, 'tests/test_other.py'], since).seen?.args).toEqual([...fitted, 'tests/test_other.py'])
    }
    expect(pytest(repo, ['--version'], since).seen?.args).toEqual(['--version'])
  })

  it('adds vitest\'s own flags to a vitest command for the whole suite, and one worker to any', () => {
    const { vitestFlags } = createRequire(import.meta.url)(join(SOURCE, 'hook.cjs')) as { vitestFlags: (args: string[], since?: string) => string[] }
    const whole = ['--maxWorkers=1', '--changed=abc', '--passWithNoTests']
    expect(vitestFlags(['run'], 'abc')).toEqual(whole)
    expect(vitestFlags([], 'abc')).toEqual(whole)
    expect(vitestFlags(['run', '--reporter', 'dot'], 'abc')).toEqual(whole)
    expect(vitestFlags(['run', 'tests/x.test.ts'], 'abc')).toEqual(['--maxWorkers=1'])
    expect(vitestFlags(['run', '--changed=other'], 'abc')).toEqual(['--maxWorkers=1'])
    expect(vitestFlags(['run', '--maxWorkers=2', 'tests/x.test.ts'], 'abc')).toEqual([])
    expect(vitestFlags(['run'])).toEqual(['--maxWorkers=1'])
  })

  it('changes a vitest process before it reads its arguments, and not what that process starts', () => {
    const { repo } = changed({ 'x.js': '1' }, {})
    const script = join(repo, 'vitest')
    writeFileSync(script, 'console.log(JSON.stringify({ args: process.argv.slice(2), nested: process.env.POISE_TEST_INSTANCE ?? null }))')
    const result = spawnSync(process.execPath, [script, 'run'], { cwd: repo, encoding: 'utf8', env: instanceEnv(SOURCE, 'abc') })
    expect(JSON.parse(result.stdout)).toEqual({ args: ['run', '--maxWorkers=1', '--changed=abc', '--passWithNoTests'], nested: null })
    expect(result.stderr).toContain('running only the tests this change touches')
  })

  it('skips a build, which is too big for an instance and whose files would go with it', () => {
    const { repo } = changed({ 'x.js': '1' }, {})
    const npm = join(repo, 'npm-cli.js')
    writeFileSync(npm, 'console.log("built here")')
    const build = spawnSync(process.execPath, [npm, 'run', 'build'], { cwd: repo, encoding: 'utf8', env: instanceEnv(SOURCE, 'abc') })
    expect(build.status).toBe(0)
    expect(build.stdout).toBe('')
    expect(build.stderr).toContain('skipping this build')
    expect(spawnSync(process.execPath, [npm, 'test'], { cwd: repo, encoding: 'utf8', env: instanceEnv(SOURCE, 'abc') }).stdout).toBe('built here\n')
  })

  it('takes its start from where the checkout leaves the default branch', () => {
    const { repo, since } = changed({ 'x.js': '1' }, {})
    expect(changeBase(repo)).toBeNull()
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', repo, ...args]).toString().trim()
    git('update-ref', 'refs/remotes/origin/main', since)
    git('checkout', '-qb', 'work')
    writeFileSync(join(repo, 'y.js'), '1')
    git('add', '.')
    git('commit', '-qm', 'work')
    expect(changeBase(repo)).toBe(since)
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

describe('a suite on a test instance', () => {
  interface Job { id: string; startCommand: string; planId: string; createdAt: string; child: ChildProcess | null; status: string }
  let render: Server
  let jobs: Map<string, Job>
  let cancels: string[]
  let relay: TestRelay
  let relayServer: Server
  let relayUrl: string
  let hooks: string
  let unpacked: string
  let startInstances: boolean

  async function listen(server: Server): Promise<number> {
    await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done) })
    return (server.address() as { port: number }).port
  }

  // Render, as far as the relay sees it. A job is the real instance script, and it ends when it ends.
  function startRender(): Server {
    return createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      if (req.headers.authorization !== 'Bearer render-key') { res.writeHead(401).end(); return }
      const cancel = /\/jobs\/(job-\d+)\/cancel$/.exec(req.url ?? '')
      if (req.method === 'POST' && cancel) {
        cancels.push(cancel[1])
        const job = jobs.get(cancel[1])
        if (job) { job.status = 'canceled'; job.child?.kill('SIGKILL') }
        res.writeHead(200).end('{}')
      } else if (req.method === 'POST') {
        const { startCommand, planId } = JSON.parse(Buffer.concat(chunks).toString()) as { startCommand: string; planId: string }
        const id = `job-${jobs.size + 1}`
        const job: Job = { id, startCommand, planId, createdAt: new Date().toISOString(), child: null, status: 'running' }
        jobs.set(id, job)
        if (startInstances) {
          const [, url, run, token] = / node -e \S+ (\S+) (\S+) (\S+)$/.exec(startCommand) ?? []
          job.child = spawn(process.execPath, instanceArgs(url, run, token, unpacked), { stdio: 'inherit' })
          job.child.on('exit', () => { if (job.status === 'running') job.status = 'succeeded' })
        }
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id, startCommand, planId }))
      } else {
        const listed = [...jobs.values()].filter((job) => job.status === 'running').map(({ id, startCommand }) => ({ job: { id, startCommand } }))
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(listed))
      }
    })
  }

  async function startAll(overrides: Partial<TestRelayDeps['config']> & Partial<TestRelayDeps> = {}): Promise<void> {
    const { renderApiKey = 'render-key', limitSeconds = 3600, maxRuns = 5, ...deps } = overrides
    const renderPort = await listen(render)
    const relayDeps: TestRelayDeps = {
      config: { renderApiKey, baseService: 'crn-test', plan: 'plan-crn-003', limitSeconds, maxRuns },
      privateKey,
      origin: () => '',
      log: { info: () => {}, warn: () => {}, error: () => {} } as unknown as TestRelayDeps['log'],
      now: Date.now,
      isWorkspace: (handle) => handle === 'alice' || handle === 'bob',
      renderApi: `http://127.0.0.1:${renderPort}/v1`,
      sweepMs: 50,
      renderSweepMs: 100,
      leaseMs: 60_000,
      listGraceMs: 500,
      ...deps,
    }
    relay = new TestRelay(relayDeps)
    relayServer = createServer((req, res) => { void relay.handle(req, res, new URL(req.url ?? '/', 'http://relay')) })
    const origin = `http://127.0.0.1:${await listen(relayServer)}`
    relayDeps.origin = () => origin
    relayUrl = `${origin}${TEST_RELAY_PATH}`
    relay.start()
    hooks = temp()
    for (const file of ['run.mjs', 'hook.cjs', 'sitecustomize.py']) copyFileSync(join(SOURCE, file), join(hooks, file))
    writeFileSync(join(hooks, 'relay'), `${relayUrl}\n${KEY}\n`)
    unpacked = temp()
  }

  beforeEach(() => {
    jobs = new Map()
    cancels = []
    startInstances = true
    render = startRender()
    relayServer = undefined as unknown as Server
  })

  afterEach(async () => {
    for (const job of jobs.values()) job.child?.kill('SIGKILL')
    relay?.stop()
    for (const server of [relayServer, render]) {
      server?.closeAllConnections()
      await new Promise((done) => { server?.close(done) })
    }
  })

  function suite(cwd: string, args: string[]): { child: ChildProcess; done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
    const child = spawn(process.execPath, [join(hooks, 'run.mjs'), '--', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    return { child, done: new Promise((done) => { child.on('close', (code) => { done({ code, stdout, stderr }) }) }) }
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

  it('gives the agent the output and exit code, and the instance ends with the suite', async () => {
    await startAll()
    const repo = repository()
    const script = 'console.log("to stdout " + process.cwd()); console.error("to stderr"); process.exit(7)'
    const { code, stdout, stderr } = await suite(repo, [process.execPath, '-e', script]).done
    expect(code).toBe(7)
    expect(stdout).toBe(`to stdout ${repo}\n`)
    expect(stderr).toContain('to stderr\n')
    expect(stderr).toContain('disposable test instance')
    const [job] = jobs.values()
    expect(job.planId).toBe('plan-crn-003')
    // Render splits this at spaces and mangles quotes.
    expect(job.startCommand).toMatch(/^timeout -k 10 3660 node -e \S+ \S+\/instance [0-9a-f]{32} [0-9a-f]{64}$/)
    expect(job.startCommand).not.toMatch(/['"]/)
    await until(() => job.status === 'succeeded', 'the instance process to end')
    expect(job.child?.exitCode).toBe(0)
    expect(relay.runs.size).toBe(0)
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

  it('destroys the instance of a suite that hangs when the time limit passes', async () => {
    await startAll({ limitSeconds: 2 })
    const started = Date.now()
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', 'setInterval(() => {}, 1000)']).done
    expect(code).toBe(124)
    expect(stderr).toContain('time limit')
    expect(Date.now() - started).toBeLessThan(10_000)
    const [job] = jobs.values()
    expect(cancels).toContain(job.id)
    await until(() => job.child?.exitCode !== null || job.child?.signalCode !== null, 'the instance to die')
  })

  it('destroys the instance when the agent’s side is killed outright', async () => {
    await startAll()
    const { child, done } = suite(repository(), [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'])
    await until(() => jobs.size === 1 && relay.runs.size === 1, 'the run to start')
    child.stdout?.once('data', () => { child.kill('SIGKILL') })
    await done
    const [job] = jobs.values()
    await until(() => cancels.includes(job.id), 'the job to be cancelled')
    await until(() => job.child?.signalCode === 'SIGKILL', 'the instance to die')
    expect(relay.runs.size).toBe(0)
  })

  it('destroys the instance when the agent’s side goes quiet with its connection open', async () => {
    await startAll({ leaseMs: 300 })
    const { child, done } = suite(repository(), [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'])
    await until(() => jobs.size === 1, 'the run to start')
    child.stdout?.once('data', () => { child.kill('SIGSTOP') })
    const [job] = jobs.values()
    await until(() => cancels.includes(job.id), 'the job to be cancelled')
    child.kill('SIGKILL')
    await done
  })

  it('stops the run at once when the agent stops it', async () => {
    await startAll()
    const { child, done } = suite(repository(), [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'])
    child.stdout?.once('data', () => { child.kill('SIGTERM') })
    const { code } = await done
    expect(code).toBe(143)
    const [job] = jobs.values()
    expect(cancels).toContain(job.id)
  })

  it('says so when a suite runs out of memory, and answers with its exit code', async () => {
    await startAll()
    const script = `console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'); process.exit(134)`
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', script]).done
    expect(code).toBe(134)
    expect(stderr).toContain('too big to run there. CI runs everything before merge')
    expect(jobs.size).toBe(1)
  })

  it('fails loud when the instance dies without a word', async () => {
    await startAll()
    const { child, done } = suite(repository(), [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'])
    child.stdout?.once('data', () => {
      const [job] = jobs.values()
      job.status = 'failed'
      job.child?.kill('SIGKILL')
    })
    const { code, stderr } = await done
    expect(code).toBe(125)
    expect(stderr).toContain('ended without reporting a result')
    expect(stderr).toContain('CI runs everything before merge')
    expect(jobs.size).toBe(1)
  })

  it('cancels a job no live run owns, as a restart leaves behind', async () => {
    await startAll()
    jobs.set('job-99', { id: 'job-99', startCommand: 'timeout 1 node -e x https://gone/instance 0123456789abcdef0123456789abcdef token', planId: 'p', createdAt: '', child: null, status: 'running' })
    await until(() => cancels.includes('job-99'), 'the orphan to be cancelled')
  })

  it('keeps a job whose run is still being created', async () => {
    startInstances = false
    await startAll()
    const repo = repository()
    const { child, done } = suite(repo, [process.execPath, '-e', 'process.exit(0)'])
    await until(() => jobs.size === 1, 'the job to exist')
    await new Promise((resolved) => setTimeout(resolved, 300))
    expect(cancels).toEqual([])
    child.kill('SIGKILL')
    await done
  })

  it('fails loud when Render refuses, and never runs the suite here', async () => {
    await startAll({ renderApiKey: 'wrong' })
    const repo = repository()
    const marker = join(repo, 'ran-here')
    const { code, stderr } = await suite(repo, [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`]).done
    expect(code).toBe(125)
    expect(stderr).toContain('Render refused the test instance')
    expect(existsSync(marker)).toBe(false)
  })

  it('fails loud at the limit on suites at once', async () => {
    await startAll({ maxRuns: 1 })
    const first = suite(repository(), [process.execPath, '-e', 'console.log("up"); setInterval(() => {}, 1000)'])
    await until(() => relay.runs.size === 1, 'the first run')
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', 'process.exit(0)']).done
    expect(code).toBe(125)
    expect(stderr).toContain('1 suites are already running')
    first.child.kill('SIGKILL')
    await first.done
  })

  it('accepts only a workspace\'s key, and each instance only its own run', async () => {
    startInstances = false
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
    const token = [...jobs.values()][0].startCommand.split(' ').at(-1)
    expect((await fetch(`${relayUrl}/runs/${id}/spec`)).status).toBe(410)
    expect((await fetch(`${relayUrl}/runs/${id}/spec`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(410)
    expect((await fetch(`${relayUrl}/runs/${id}/spec`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200)
    expect((await post(`/runs/${id}/lease`, `Bearer ${token}`)).status).toBe(401)
    expect((await fetch(`${relayUrl}/runs/${id}/output`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
    // Another workspace's key opens nothing of this one's.
    const bob = `Bearer ${workspaceKey(privateKey, 'bob')}`
    expect((await post(`/runs/${id}/lease`, bob)).status).toBe(403)
    expect((await fetch(`${relayUrl}/runs/${id}/output`, { headers: { authorization: bob } })).status).toBe(403)
    expect((await fetch(`${relayUrl}/runs/${id}`, { method: 'DELETE', headers: { authorization: bob } })).status).toBe(403)
    expect((await post('/runs', `Bearer ${KEY}`, '{"argv":[]}')).status).toBe(400)
    // Open to all, and it holds nothing that is not in this public repository.
    expect((await fetch(`${relayUrl}/instance`)).status).toBe(200)
  })

  it('serves an instance script its bootstrap can run', async () => {
    startInstances = false
    await startAll()
    const repo = repository()
    const { child, done } = suite(repo, [process.execPath, '-e', 'console.log("from the instance"); process.exit(4)'])
    await until(() => jobs.size === 1, 'the job to exist')
    // The start command exactly as Render gets it, past `timeout`, which a developer's Mac may not have.
    const [, code, url, run, token] = /^timeout -k 10 \d+ node -e (\S+) (\S+) (\S+) (\S+)$/.exec([...jobs.values()][0].startCommand) ?? []
    const instance = spawn(process.execPath, ['-e', code, url, run, token, unpacked], { stdio: 'ignore' })
    const { code: exit, stdout } = await done
    instance.kill('SIGKILL')
    expect(exit).toBe(4)
    expect(stdout).toBe('from the instance\n')
    child.kill('SIGKILL')
  })

  it('ends an instance whose run is over', async () => {
    startInstances = false
    await startAll()
    const instance = spawn(process.execPath, instanceArgs(`${relayUrl}/instance`, '0'.repeat(32), 'token', unpacked), { stdio: 'ignore' })
    const code = await new Promise((done) => { instance.on('exit', done) })
    expect(code).toBe(1)
  })

  it('ends an instance when the relay is gone', async () => {
    startInstances = false
    await startAll()
    const instance = spawn(process.execPath, instanceArgs('http://127.0.0.1:9/instance', '0'.repeat(32), 'token', unpacked), { stdio: 'ignore' })
    const code = await new Promise((done) => { instance.on('exit', done) })
    expect(code).toBe(1)
  }, 30_000)
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
