// @vitest-environment node
// Agents' test suites run on disposable test boxes: these run the real hooks, runner, relay and box
// script, with only Render itself replaced. docs/Operating.md, "Agents' test suites".
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOX_COMMAND, SETUP_COMMAND, TEST_RELAY_PATH, TestRelay, workspaceKey, type TestRelayDeps } from '../gateway/src/test-relay'
import { filesToSend, frameReader, testEnvironment } from '../scripts/test-offload/run.mjs'
import { scrubbedChildEnvironment } from '../server/process'

const SOURCE = resolve('scripts/test-offload')
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
  let render: Server
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
  let warnings: Record<string, unknown>[]
  let relay: TestRelay
  let relayServer: Server
  let relayUrl: string
  let hooks: string
  let unpacked: string

  async function listen(server: Server): Promise<number> {
    await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done) })
    return (server.address() as { port: number }).port
  }

  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

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
    const { renderApiKey = 'render-key', limitSeconds = 3600, maxRuns = 5, deployment = 'poise.example.com', ...deps } = overrides
    renderOrigin = `http://127.0.0.1:${await listen(render)}`
    relay = new TestRelay({
      config: { renderApiKey, workspace: 'tea-test', deployment, plan: '1c-2g', limitSeconds, maxRuns },
      privateKey,
      log: { info: () => {}, warn: (_event: string, fields: Record<string, unknown>) => { warnings.push({ event: _event, ...fields }) }, error: () => {} } as unknown as TestRelayDeps['log'],
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
    relayServer = createServer((req, res) => { void relay.handle(req, res, new URL(req.url ?? '/', 'http://relay')) })
    relayUrl = `http://127.0.0.1:${await listen(relayServer)}${TEST_RELAY_PATH}`
    relay.start()
    hooks = temp()
    for (const file of ['run.mjs', 'hook.cjs', 'sitecustomize.py']) copyFileSync(join(SOURCE, file), join(hooks, file))
    writeFileSync(join(hooks, 'relay'), `${relayUrl}\n${KEY}\n`)
    unpacked = temp()
  }

  beforeEach(() => {
    boxes = new Map()
    snapshots = new Map()
    groups = []
    terminated = []
    setups = 0
    setupExit = 0
    setupMs = 0
    listLagMs = 0
    warnings = []
    runBoxes = true
    render = startRender()
    relayServer = undefined as unknown as Server
  })

  afterEach(async () => {
    for (const box of boxes.values()) box.child?.kill('SIGKILL')
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

  const runBox = () => [...boxes.values()].find((box) => box.snapshotName !== null) as Box

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

  it('leaves the agent’s temporary folder behind, which can be too long for a Unix socket', async () => {
    await startAll()
    const script = 'console.log(process.env.TMPDIR, process.env.TMP, process.env.TEMP)'
    const tmp = { TMPDIR: '/run/agent/tmp', TMP: '/run/agent/tmp', TEMP: '/run/agent/tmp' }
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

  it('destroys the box of a suite too slow for it at the time limit, and sends the agent to CI', async () => {
    await startAll({ limitSeconds: 2 })
    const started = Date.now()
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', 'setInterval(() => {}, 1000)']).done
    expect(code).toBe(124)
    expect(stderr).toContain('no test result: this suite is too big for its test box: it passed the 2 s time limit')
    expect(stderr).toContain('says nothing about your code. Skip local tests for this work')
    expect(stderr).toContain('let CI run the tests')
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

  it('says nothing of memory when a suite that mentions it passes', async () => {
    await startAll()
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', `console.log('cannot allocate memory, as this test expected')`]).done
    expect(code).toBe(0)
    expect(stderr).not.toContain('no test result')
  })

  it('leaves a failing suite\'s exit code alone, whatever it says about memory', async () => {
    await startAll()
    const script = `console.log('cannot allocate memory: heap out of memory, as this test expected'); process.exit(7)`
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', script]).done
    expect(code).toBe(7)
    expect(stderr).not.toContain('no test result')
    expect(warnings).toEqual([])
  })

  it('tells a suite too big for its memory from one that failed, and sends the agent to CI', async () => {
    await startAll()
    const script = `console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'); process.exit(134)`
    const { code, stderr } = await suite(repository(), [process.execPath, '-e', script]).done
    expect(code).toBe(125)
    expect(stderr).toContain('no test result: this suite is too big for its test box: it ran out of memory')
    expect(stderr).toContain('says nothing about your code. Skip local tests for this work')
    expect(stderr).toContain('let CI run the tests')
    // Choosing tests is no job of an agent's.
    expect(stderr).not.toContain('name a')
    // Poise hears of it too, with what it needs to find the suite.
    const [warning] = warnings
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
  async function startAll2(): Promise<void> {
    relayServer.closeAllConnections()
    await new Promise((done) => { relayServer.close(done) })
    relay = new TestRelay({
      config: { renderApiKey: 'render-key', workspace: 'tea-test', deployment: 'poise.example.com', plan: '1c-2g', limitSeconds: 3600, maxRuns: 5 },
      privateKey,
      log: { info: () => {}, warn: () => {}, error: () => {} } as unknown as TestRelayDeps['log'],
      now: Date.now,
      isWorkspace: (handle) => handle === 'alice' || handle === 'bob',
      renderApi: `${renderOrigin}/v1`,
      sweepMs: 50,
      renderSweepMs: 100,
      pollMs: 10,
    })
    relayServer = createServer((req, res) => { void relay.handle(req, res, new URL(req.url ?? '/', 'http://relay')) })
    relayUrl = `http://127.0.0.1:${await listen(relayServer)}${TEST_RELAY_PATH}`
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
    expect((await fetch(`${relayUrl}/instance`)).status).toBe(404)
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
