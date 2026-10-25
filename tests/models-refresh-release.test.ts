import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

const fixture = vi.hoisted(() => ({ wrapper: '' }))
vi.mock('../server/process', async (original) => ({
  ...await original<typeof import('../server/process')>(),
  get CLAUDE_SUBSCRIPTION_CLI() { return fixture.wrapper },
}))
import { refreshModelCatalog } from '../server/models-refresh'
import { runFile, scrubbedChildEnvironment, claudeSubscriptionEnvironment } from '../server/process'
import { setMeta } from '../server/db'
import { DailyModelRefresh } from '../server/service/model-refresh'

let root: string, poise: string, bin: string, reportPath: string, caller: string
const families = Object.fromEntries(['claude', 'codex', 'grok', 'antigravity', 'muse'].map(name => [name, { status: 'ok' }]))

beforeEach(async () => {
  // Every provider participates: these release tests cover the installed
  // Caller boundary, and provider-participation.test.ts covers eligibility.
  setMeta('account_logins', JSON.stringify(Object.fromEntries(['claude', 'codex', 'grok', 'antigravity', 'muse'].map(name => [name, '2026-10-20T06:00:00.000Z']))))
  root = await realpath(await mkdtemp(join(tmpdir(), 'poise model release ')))
  poise = join(root, 'release', 'poise')
  bin = join(root, 'release', 'venv', 'bin')
  reportPath = join(root, 'report.json')
  await mkdir(bin, { recursive: true })
  await mkdir(join(root, 'providers'))
  // A dropped override must land inside this fixture, never the real Caller.
  await cp(resolve('scripts'), join(poise, 'scripts'), { recursive: true })
  await cp(resolve('gateway/src/diagnostics'), join(poise, 'gateway/src/diagnostics'), { recursive: true })
  await symlink(resolve('node_modules'), join(poise, 'node_modules'), 'dir')
  fixture.wrapper = join(poise, 'scripts', 'claude-subscription.mjs')
  const provider = `#!${process.execPath}\nconsole.log('1.0.0')\n`
  for (const name of ['claude', 'codex', 'grok', 'agy', 'muse']) await writeFile(join(root, 'providers', name), provider, { mode: 0o700 })
  caller = `#!${process.execPath}
import fs from 'node:fs';
const keys = ['CALLER_BIN_ROOT', 'AGENT_INTERFACE_ROOT', 'AGENT_INTERFACE_DATA_DIR', 'CLAUDE_CLI', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'JEV_API_KEY'];
const env = Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
fs.writeFileSync(process.env.HOME + '/called.json', JSON.stringify({ executable: process.argv[1], args: process.argv.slice(2), env }));
console.log(JSON.stringify({ families: ${JSON.stringify(families)} }));
`
  await writeFile(join(bin, 'agent-interface'), caller, { mode: 0o700 })
  for (const [name, value] of Object.entries({
    HOME: root, CALLER_BIN_ROOT: bin, AGENT_INTERFACE_ROOT: poise,
    AGENT_INTERFACE_DATA_DIR: join(root, 'data'), POISE_MODEL_CATALOG_REPORT: reportPath,
    PATH: [join(root, 'providers'), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    ANTHROPIC_API_KEY: 'conflicting-api-key', ANTHROPIC_AUTH_TOKEN: 'conflicting-auth',
    ANTHROPIC_BASE_URL: 'https://conflicting.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'conflicting-oauth',
    JEV_API_KEY: 'unrelated-secret', OPENAI_API_KEY: 'allowed-model-key',
  })) vi.stubEnv(name, value)
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

async function assertCaller(report: Record<string, unknown>, selected = bin): Promise<void> {
  expect(report).toMatchObject({ families, caller_executable: join(selected, 'agent-interface') })
  expect(report).not.toHaveProperty('error')
  const called = JSON.parse(await readFile(join(root, 'called.json'), 'utf8'))
  expect(called).toMatchObject({ executable: join(selected, 'agent-interface'), args: ['--refresh-models'] })
  expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(report)
}

it('manual refresh reaches the installed release through the real scrubbed child boundary', async () => {
  expect(existsSync(join(poise, 'caller', '.venv'))).toBe(false)
  await assertCaller(await refreshModelCatalog())
  const { env } = JSON.parse(await readFile(join(root, 'called.json'), 'utf8'))
  expect(env).toMatchObject({ CALLER_BIN_ROOT: bin, AGENT_INTERFACE_ROOT: poise,
    AGENT_INTERFACE_DATA_DIR: join(root, 'data'), CLAUDE_CLI: fixture.wrapper, OPENAI_API_KEY: 'allowed-model-key' })
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'JEV_API_KEY']) expect(env).not.toHaveProperty(name)
})

it('the scheduled refresh uses the same installed Caller', async () => {
  let now = Date.parse('2026-10-20T06:59:59Z')
  let tick = () => {}
  let running: Promise<Record<string, unknown>> | undefined
  const schedule = new DailyModelRefresh({
    timeZone: () => 'UTC', paused: () => false,
    refresh: () => { running = refreshModelCatalog(); return running },
    clock: { now: () => now, setTimeout: callback => { tick = callback; return 1 }, clearTimeout: () => {} },
    log: () => {}, logError: () => {},
  })
  schedule.start()
  try {
    now += 1000
    tick()
    expect(running).toBeDefined()
    await assertCaller(await running!)
  } finally { schedule.stop() }
})

it('missing configured Caller fails with selected-path evidence and never tries defaults or PATH', async () => {
  const missing = join(root, 'missing bin')
  vi.stubEnv('CALLER_BIN_ROOT', missing)
  const fallback = join(poise, 'caller', '.venv', 'bin')
  await mkdir(fallback, { recursive: true })
  await writeFile(join(fallback, 'agent-interface'), caller, { mode: 0o700 })
  await writeFile(join(root, 'providers', 'agent-interface'), caller, { mode: 0o700 })
  const report = await refreshModelCatalog()
  expect(report).toMatchObject({ families: {}, caller_executable: join(missing, 'agent-interface'),
    diagnostic: { configuredExecutable: join(missing, 'agent-interface'), cwd: poise } })
  expect(report.error).toContain('ENOENT')
  expect(existsSync(join(root, 'called.json'))).toBe(false)
  expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(report)
})

it('direct script runs preserve the development default without an override', async () => {
  const fallback = join(poise, 'caller', '.venv', 'bin')
  await mkdir(fallback, { recursive: true })
  await writeFile(join(fallback, 'agent-interface'), caller, { mode: 0o700 })
  vi.stubEnv('CALLER_BIN_ROOT', undefined)
  const { stdout } = await runFile(process.execPath, [join(poise, 'scripts', 'refresh-models.mjs'), '--json'], {
    cwd: poise, env: { ...scrubbedChildEnvironment('agent-interface', claudeSubscriptionEnvironment()), POISE_MODEL_CATALOG_REPORT: reportPath,
      POISE_PROVIDER_EVIDENCE: JSON.stringify({ logins: Object.fromEntries(['claude', 'codex', 'grok', 'antigravity', 'muse'].map(name => [name, '2026-10-20T06:00:00.000Z'])), live: { claude: null, codex: null } }) },
  })
  await assertCaller(JSON.parse(stdout), fallback)
})
