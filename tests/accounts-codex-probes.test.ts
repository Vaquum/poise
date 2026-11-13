import { chmod, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as logins from '../server/accounts/logins'
import { probeAccount, type RunCommand } from '../server/accounts/status'
import { setMeta } from '../server/db'
import { loggingRuntime, startLogging, stopLogging } from '../server/logging'
import { runFile } from '../server/process'
import { STATUS, fakeCalls, script, setScript, writeFakeClis } from './fixtures/accounts/fake-clis'

let root: string
let bin: string
let home: string
let codex: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-codex-probes-'))
  bin = join(root, 'bin')
  home = join(root, 'home')
  codex = join(bin, 'codex')
  vi.stubEnv('HOME', home)
  vi.stubEnv('PATH', bin)
  vi.stubEnv('CODEX_CLI', '')
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.stubEnv('POISE_WORKSPACE_HANDLE', 'local')
  vi.stubEnv('CALLER_BIN_ROOT', bin)
  setMeta('account_logins', '{}')
  await writeFakeClis(bin, home, { codex: script('codex', STATUS.codexChatGpt) })
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  startLogging()
})

afterEach(async () => {
  await stopLogging()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

function events() {
  loggingRuntime()!.flush()
  return loggingRuntime()!.query(db => db.query({ workspace: 'local', operator: false }, { source: 'poise' })).events
}

function expectFailure(operation: string, executable = 'codex') {
  expect(events()).toEqual([expect.objectContaining({ severity: 'error', operation,
    context: expect.objectContaining({ executable, purpose: expect.stringContaining('Connected accounts') }) })])
}

it('keeps confirmed absence of unused Codex as account status without a Logging Error', async () => {
  await rm(codex)
  expect(await probeAccount('codex', runFile)).toMatchObject({ installed: false, signedIn: null,
    detail: 'codex is not installed: Poise cannot find it on its PATH.' })
  expect(events()).toEqual([])
})

it('reports a missing configured Codex once with its probe purpose and executable', async () => {
  setMeta('account_logins', JSON.stringify({ codex: '2026-11-13T06:00:00Z' }))
  await rm(codex)
  expect(await probeAccount('codex', runFile)).toMatchObject({ installed: false, signedIn: null })
  expectFailure('codex.version')
  expect(events()[0].context).toMatchObject({ code: 'ENOENT' })
})

it.each(['corrupt', 'unreadable'])('does not infer unused Codex from a %s configuration record', async kind => {
  await rm(codex)
  if (kind === 'corrupt') setMeta('account_logins', 'not json')
  else vi.spyOn(logins, 'accountLoginsStrict').mockImplementationOnce(() => { throw new Error('provider record could not be read') })
  await probeAccount('codex', runFile)
  expectFailure('codex.version')
  expect(events()[0].context.configurationError).toMatch(kind === 'corrupt' ? /corrupt/ : /could not be read/)
})

it('reports an existing launcher with a missing interpreter even without configuration', async () => {
  await writeFile(codex, '#!/no-such-poise-codex-interpreter\n')
  await probeAccount('codex', runFile)
  expectFailure('codex.version')
  expect(events()[0].context.code).toBe('ENOENT')
})

it('reports a dangling launcher instead of declaring optional absence', async () => {
  await rm(codex)
  await symlink(join(root, 'missing-codex'), codex)
  await probeAccount('codex', runFile)
  expectFailure('codex.version')
  expect(events()[0].context.code).toBe('ENOENT')
})

it('uses an override for both probes without bare codex, keeping its credential location and proxy environment', async () => {
  const launcher = join(bin, 'custom codex launcher')
  await rename(codex, launcher)
  await writeFile(launcher, '#!/bin/sh\nprintf "%s\\n" "$CODEX_HOME" "$HTTPS_PROXY" "${OPENAI_API_KEY-unset}" > "$HOME/probe-env"\nexec node "${0%/*}/fake-cli.cjs" codex "$@"\n')
  vi.stubEnv('CODEX_CLI', launcher)
  vi.stubEnv('CODEX_HOME', join(home, 'custom-codex-home'))
  vi.stubEnv('HTTPS_PROXY', 'http://proxy.test:8080')
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key-must-not-be-inherited')
  expect(await probeAccount('codex', runFile)).toMatchObject({ installed: true, version: '0.160.0', signedIn: true,
    detail: 'Signed in with ChatGPT', login: { label: 'codex login --device-auth' } })
  expect((await fakeCalls(home)).map(call => call.args)).toEqual([['--version'], ['login', 'status']])
  expect(await readFile(join(home, 'probe-env'), 'utf8')).toBe(`${process.env.CODEX_HOME}\nhttp://proxy.test:8080\nunset\n`)
  expect(events()).toEqual([])
})

it.each(['missing', 'broken'])('does not fall back from a %s override to working PATH codex', async kind => {
  const launcher = join(bin, 'configured-codex')
  if (kind === 'broken') await writeFile(launcher, '#!/no-such-poise-codex-interpreter\n', { mode: 0o755 })
  vi.stubEnv('CODEX_CLI', launcher)
  expect(await probeAccount('codex', runFile)).toMatchObject({ signedIn: null })
  expectFailure('codex.version', launcher)
  expect(await fakeCalls(home)).toEqual([])
})

it('keeps a version probe permission failure visible', async () => {
  await chmod(codex, 0o644)
  await probeAccount('codex', runFile)
  expectFailure('codex.version')
  expect(events()[0].context.code).toBe('EACCES')
})

it.each(['--version', 'login status'])('keeps an unexpected exit from %s visible with stderr', async args => {
  await setScript(home, 'codex', { ...script('codex', STATUS.codexChatGpt), [args]: { stderr: 'broken Codex configuration\n', code: 2 } })
  expect(await probeAccount('codex', runFile)).toMatchObject({ signedIn: null, detail: expect.stringContaining('broken Codex configuration') })
  expectFailure(args === '--version' ? 'codex.version' : 'codex.login.status')
  expect(events()[0]).toMatchObject({ exitCode: 2, stderr: 'broken Codex configuration\n' })
})

it.each(['--version', 'login status'])('keeps a timeout from %s visible', async args => {
  await writeFile(codex, `#!/bin/sh\nif [ "$*" = '${args}' ]; then exec /bin/sleep 30; fi\necho 'codex-cli 0.160.0'\n`)
  const run: RunCommand = (command, argv, options) => runFile(command, argv, {
    ...options, ...(argv.join(' ') === args ? { timeoutMs: 500 } : {}),
  })
  expect(await probeAccount('codex', run)).toMatchObject({ signedIn: null, detail: expect.stringContaining('did not answer within 0.5 seconds') })
  expectFailure(args === '--version' ? 'codex.version' : 'codex.login.status')
  expect(events()[0].context.killed).toBe(true)
})

it('reports disappearance between version and login status even for previously unused Codex', async () => {
  const run: RunCommand = async (command, args, options) => {
    const result = await runFile(command, args, options)
    if (args[0] === '--version') await rm(codex)
    return result
  }
  expect(await probeAccount('codex', run)).toMatchObject({ installed: true, version: '0.160.0', signedIn: null })
  expectFailure('codex.login.status')
  expect(events()[0].context.code).toBe('ENOENT')
})

it.each([0, 1])('reports unreadable login status with exit %i', async code => {
  await setScript(home, 'codex', script('codex', { stderr: 'Unrecognized login state\n', code }))
  expect(await probeAccount('codex', runFile)).toMatchObject({ signedIn: null })
  expectFailure('codex.login.status')
})

it.each([STATUS.codexChatGpt, STATUS.codexApiKey, STATUS.codexSignedOut])('preserves recognized sign-in results without Logging Errors: %j', async status => {
  await setScript(home, 'codex', script('codex', status))
  expect(await probeAccount('codex', runFile)).toMatchObject({ installed: true, version: '0.160.0',
    signedIn: status !== STATUS.codexSignedOut })
  expect(events()).toEqual([])
})
