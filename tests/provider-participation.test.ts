// Provider participation: which providers a model check maintains, and which
// sign-in alerts it may raise. The eligibility rule, its evidence, and the
// manual, scheduled and standalone entry points agreeing on it.

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  EligibilityError, SKIP_REASON, decideEligibility, parseClaudeSignIn, parseCodexSignIn,
  parseEvidence, readAccountLogins, recordObservedParticipation, resolveEligibility, sameEligibility,
} from '../scripts/provider-participation.mjs'
import { STATUS, fakeCalls, script, setScript, writeFakeClis, type Script } from './fixtures/accounts/fake-clis'
import type { AccountId } from '../server/accounts/types'
import { invalidateAccounts } from '../server/accounts'
import { setMeta } from '../server/db'
import { refreshModelCatalog } from '../server/models-refresh'
import { DailyModelRefresh } from '../server/service/model-refresh'
import { modelRefreshSummary } from '../src/model-refresh'

const AT = '2026-10-20T06:00:00.000Z'

// Every eligible fake answers its updater as well as --version; versions are
// static, so an update verifies as current.
const UPDATES: Partial<Record<AccountId, Script>> = {
  claude: { 'install latest': { stdout: '2.1.300 (Claude Code)\n' } },
  codex: { update: { stdout: 'codex-cli 0.161.0\n' } },
  grok: { update: { stdout: 'grok 1.0.47 (2765805b9442)\n' } },
  antigravity: { update: { stdout: '1.2.15\n' } },
}
const withUpdates = (id: AccountId, answers: Script): Script => ({ ...answers, ...UPDATES[id] })

function seedDb(path: string, logins: Record<string, string>): void {
  const db = new Database(path)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run('account_logins', JSON.stringify(logins))
  } finally {
    db.close()
  }
}

function dbLogins(path: string): Record<string, string> {
  const db = new Database(path, { readonly: true })
  try {
    return JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'account_logins'").get() as { value: string }).value)
  } finally {
    db.close()
  }
}

describe('the eligibility rule', () => {
  it('takes part when configured, or when the live status verifies a sign-in', () => {
    const recorded: string[] = []
    const record = (provider: string) => { recorded.push(provider) }
    expect(decideEligibility({ claude: AT }, { claude: false, codex: false }, record)).toEqual({
      eligible: ['claude'], skipped: { codex: SKIP_REASON, grok: SKIP_REASON, antigravity: SKIP_REASON, muse: SKIP_REASON },
    })
    expect(recorded).toEqual([])
    expect(decideEligibility({}, { claude: false, codex: true }, record)).toMatchObject({ eligible: ['codex'] })
    expect(recorded).toEqual(['codex'])
  })

  it('skips an unconfigured provider whether its CLI is installed, signed out or missing', () => {
    for (const live of [{ claude: false, codex: false }, { claude: 'missing', codex: 'missing' }]) {
      const { eligible, skipped } = decideEligibility({}, live as { claude: boolean, codex: boolean }, () => { throw new Error('no observation to remember') })
      expect(eligible).toEqual([])
      expect(skipped).toEqual({ claude: SKIP_REASON, codex: SKIP_REASON, grok: SKIP_REASON, antigravity: SKIP_REASON, muse: SKIP_REASON })
    }
  })

  it('fails unknown eligibility instead of reading it as unconfigured', () => {
    expect(() => decideEligibility({}, { claude: null, codex: false })).toThrow(EligibilityError)
    expect(() => decideEligibility({}, { claude: false, codex: undefined })).toThrow(/codex eligibility is unknown/)
    // A record stands whatever the live status says.
    expect(decideEligibility({ codex: AT }, { claude: false, codex: null })).toMatchObject({ eligible: ['codex'] })
  })

  it('reads Claude as signed in only on a subscription, like the server probe', () => {
    expect(parseClaudeSignIn(STATUS.claudeSubscription.stdout!)).toBe(true)
    expect(parseClaudeSignIn(STATUS.claudeConsole.stdout!)).toBe(false)
    expect(parseClaudeSignIn(STATUS.claudeSignedOut.stdout!)).toBe(false)
    expect(parseClaudeSignIn('not json')).toBeNull()
    expect(parseClaudeSignIn('{"loggedIn":"yes"}')).toBeNull()
  })

  it('reads the Codex answer from either stream, and nothing else as an answer', () => {
    expect(parseCodexSignIn(`${STATUS.codexChatGpt.stderr}\n`)).toBe(true)
    expect(parseCodexSignIn(`${STATUS.codexApiKey.stderr}\n`)).toBe(true)
    expect(parseCodexSignIn(`${STATUS.codexSignedOut.stderr}\n`)).toBe(false)
    expect(parseCodexSignIn('1.0.0\n')).toBeNull()
    expect(parseCodexSignIn('')).toBeNull()
  })

  it('accepts only well-formed server evidence', () => {
    expect(parseEvidence(JSON.stringify({ logins: { codex: AT }, live: { claude: false, codex: null } }))).toEqual({
      logins: { codex: AT }, live: { claude: false, codex: null },
    })
    for (const raw of ['not json', '{"logins":{}}', '{"live":{"claude":false,"codex":null}}',
      JSON.stringify({ logins: { codex: 7 }, live: { claude: false, codex: null } }),
      JSON.stringify({ logins: {}, live: { claude: 'yes', codex: null } }),
      JSON.stringify({ logins: {}, live: { claude: false } }),
    ]) expect(() => parseEvidence(raw)).toThrow(EligibilityError)
    // A CLI the server found missing skips; only a failed read is unknown.
    expect(parseEvidence(JSON.stringify({ logins: {}, live: { claude: 'missing', codex: false } }))).toEqual({
      logins: {}, live: { claude: 'missing', codex: false },
    })
    expect(decideEligibility({}, { claude: 'missing', codex: 'missing' }).eligible).toEqual([])
  })

  it('reuses an overlapping report only when its participation context still matches', () => {
    expect(sameEligibility(['codex', 'claude'], ['claude', 'codex'])).toBe(true)
    expect(sameEligibility(['claude'], ['claude', 'codex'])).toBe(false)
    // Reports from before participation checks updated every provider.
    expect(sameEligibility(undefined, ['claude', 'codex', 'grok', 'antigravity', 'muse'])).toBe(true)
    expect(sameEligibility(undefined, ['claude'])).toBe(false)
  })
})

describe('the durable record', () => {
  let root = ''
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'poise-participation-db-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('reads the record, and an empty one when the server has not initialized it', () => {
    expect(readAccountLogins(join(root, 'missing.db'))).toEqual({})
    seedDb(join(root, 'cache.db'), { codex: AT, grok: AT })
    expect(readAccountLogins(join(root, 'cache.db'))).toEqual({ codex: AT, grok: AT })
    new Database(join(root, 'empty.db')).close()
    expect(readAccountLogins(join(root, 'empty.db'))).toEqual({})
  })

  it('fails corrupt or unreadable state instead of reading it as unconfigured', () => {
    seedDb(join(root, 'cache.db'), { codex: AT })
    const db = new Database(join(root, 'cache.db'))
    try {
      db.prepare("UPDATE meta SET value = 'not json' WHERE key = 'account_logins'").run()
    } finally {
      db.close()
    }
    expect(() => readAccountLogins(join(root, 'cache.db'))).toThrow(/corrupt/)
    const garbage = join(root, 'garbage.db')
    writeFileSync(garbage, 'not a database')
    expect(() => readAccountLogins(garbage)).toThrow(/could not be read/)
  })

  it('remembers a positive observation once, and never invents a database', () => {
    const path = join(root, 'cache.db')
    recordObservedParticipation(path, 'codex')
    expect(existsSync(path)).toBe(false)
    seedDb(path, {})
    recordObservedParticipation(path, 'codex')
    expect(dbLogins(path).codex).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    seedDb(path, { codex: AT })
    recordObservedParticipation(path, 'codex')
    expect(dbLogins(path)).toEqual({ codex: AT })
    recordObservedParticipation(path, 'grok')
    expect(dbLogins(path)).toEqual({ codex: AT })
  })

  it('keeps a login that finishes while the memo holds the database', async () => {
    const path = join(root, 'cache.db')
    seedDb(path, {})
    // Another process takes the write lock first and records a login like
    // the server would; the memo must wait for it, not overwrite it.
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const Database = require('better-sqlite3');
      const db = new Database(process.env.POISE_TEST_DB);
      db.exec('BEGIN IMMEDIATE');
      fs.writeFileSync(process.env.POISE_TEST_DB + '.ready', 'held');
      setTimeout(() => {
        db.prepare("INSERT INTO meta (key, value) VALUES ('account_logins', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
          .run(JSON.stringify({ codex: '${AT}' }));
        db.exec('COMMIT');
        db.close();
      }, 1500);
    `], { cwd: resolve('.'), env: { ...process.env, POISE_TEST_DB: path }, stdio: 'ignore' })
    const closed = new Promise((resolve, reject) => holder.once('close', code => (code === 0 ? resolve(code) : reject(new Error(`holder exited ${code}`)))))
    try {
      for (let i = 0; i < 100 && !existsSync(path + '.ready'); i++) await new Promise(resolve => setTimeout(resolve, 100))
      expect(existsSync(path + '.ready')).toBe(true)
      recordObservedParticipation(path, 'claude')
      await closed
      expect(dbLogins(path)).toEqual({ codex: AT, claude: expect.any(String) })
    } finally {
      holder.kill()
    }
  }, 30_000)
})

describe('standalone eligibility', () => {
  let root = '', bin = '', home = '', dbPath = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-participation-'))
    bin = join(root, 'bin')
    home = join(root, 'home')
    dbPath = join(root, 'cache.db')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const env = () => ({ HOME: home, PATH: bin, POISE_DB: dbPath })

  it('probes only unrecorded Claude/Codex, and remembers a verified sign-in', async () => {
    seedDb(dbPath, { codex: AT })
    await writeFakeClis(bin, home, {
      claude: withUpdates('claude', script('claude', STATUS.claudeSignedOut)),
      codex: withUpdates('codex', script('codex', STATUS.codexChatGpt)),
      grok: withUpdates('grok', script('grok')),
      muse: script('muse'),
      antigravity: withUpdates('antigravity', script('antigravity')),
    })
    const { eligible, skipped, source } = await resolveEligibility(env())
    expect(source).toBe('standalone')
    expect(eligible).toEqual(['codex'])
    expect(skipped).toEqual({ claude: SKIP_REASON, grok: SKIP_REASON, antigravity: SKIP_REASON, muse: SKIP_REASON })
    const calls = await fakeCalls(home)
    // Claude was probed through the wrapper and found signed out; the
    // recorded Codex was taken part without a status probe.
    expect(calls.filter(call => call.name === 'claude' && call.args.join(' ') === 'auth status --json')).toHaveLength(1)
    expect(calls.some(call => call.name === 'codex' && call.args.join(' ') === 'login status')).toBe(false)
  })

  it('an externally verified sign-in participates and is remembered; its later loss fails', async () => {
    seedDb(dbPath, {})
    await writeFakeClis(bin, home, {
      claude: withUpdates('claude', script('claude', STATUS.claudeSubscription)),
      codex: withUpdates('codex', script('codex', STATUS.codexChatGpt)),
      grok: withUpdates('grok', script('grok')),
      muse: script('muse'),
      antigravity: withUpdates('antigravity', script('antigravity')),
    })
    expect((await resolveEligibility(env())).eligible).toEqual(['claude', 'codex'])
    expect(dbLogins(dbPath)).toMatchObject({ claude: expect.any(String), codex: expect.any(String) })
    await setScript(home, 'claude', withUpdates('claude', script('claude', STATUS.claudeSignedOut)))
    await setScript(home, 'codex', withUpdates('codex', script('codex', STATUS.codexSignedOut)))
    // Recorded, so still participating despite the lost sign-in.
    expect((await resolveEligibility(env())).eligible).toEqual(['claude', 'codex'])
  })

  it('an unrecorded provider whose CLI is missing is skipped, not failed', async () => {
    seedDb(dbPath, { claude: AT })
    await writeFakeClis(bin, home, {
      claude: withUpdates('claude', script('claude', STATUS.claudeSignedOut)),
      grok: withUpdates('grok', script('grok')),
      muse: script('muse'),
      antigravity: withUpdates('antigravity', script('antigravity')),
    })
    expect(await resolveEligibility(env())).toMatchObject({ eligible: ['claude'], source: 'standalone' })
  })

  it('an unrecorded Claude whose CLI is missing is skipped without asking the wrapper', async () => {
    seedDb(dbPath, { grok: AT })
    await writeFakeClis(bin, home, {
      codex: withUpdates('codex', script('codex', STATUS.codexSignedOut)),
      grok: withUpdates('grok', script('grok')),
      muse: script('muse'),
      antigravity: withUpdates('antigravity', script('antigravity')),
    })
    // No claude launcher: the wrapper would only report its own failure.
    const { eligible, skipped } = await resolveEligibility(env())
    expect(eligible).toEqual(['grok'])
    expect(skipped.claude).toBe(SKIP_REASON)
    expect((await fakeCalls(home)).some(call => call.name === 'claude')).toBe(false)
  })

  it('an unreadable status answer or a silent CLI fails eligibility', async () => {
    seedDb(dbPath, {})
    await writeFakeClis(bin, home, {
      claude: withUpdates('claude', script('claude', STATUS.claudeSignedOut)),
      codex: { ...withUpdates('codex', script('codex')), 'login status': { stdout: '1.0.0\n' } },
      grok: withUpdates('grok', script('grok')),
      muse: script('muse'),
      antigravity: withUpdates('antigravity', script('antigravity')),
    })
    await expect(resolveEligibility(env())).rejects.toThrow(/codex eligibility is unknown/)
  })

  it('a status probe that never answers fails eligibility', async () => {
    seedDb(dbPath, {})
    await writeFakeClis(bin, home, {
      claude: withUpdates('claude', script('claude', STATUS.claudeSignedOut)),
      grok: withUpdates('grok', script('grok')),
      muse: script('muse'),
      antigravity: withUpdates('antigravity', script('antigravity')),
    })
    await writeFile(join(bin, 'codex'), `#!${process.execPath}\nconsole.log('codex-cli 0.160.0');\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 })
    await expect(resolveEligibility(env())).rejects.toThrow(/did not answer within 10 seconds/)
  }, 30_000)
})

interface ScriptCase {
  root: string
  home: string
  calls: () => Promise<Array<{ name: string, args: string[] }>>
  discoveries: () => Promise<string[][]>
  run: (extraEnv?: NodeJS.ProcessEnv) => Promise<{ code: number | null, report: any, stderr: string }>
}

async function scriptCase(scripts: Partial<Record<AccountId, Script>>, options: { evidence?: unknown, db?: Record<string, string> } = {}): Promise<ScriptCase> {
  const root = await mkdtemp(join(tmpdir(), 'poise-participation-run-'))
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  const callerBin = join(root, 'caller-bin')
  await mkdir(callerBin, { recursive: true })
  await writeFakeClis(bin, home, scripts)
  const dbPath = join(root, 'cache.db')
  if (options.db) seedDb(dbPath, options.db)
  await writeFile(join(callerBin, 'agent-interface'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.HOME + '/called.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
const sleep = Number(process.env.FAKE_CALLER_SLEEP_MS || 0);
if (sleep) await new Promise(resolve => setTimeout(resolve, sleep));
const args = process.argv.slice(2);
if (process.env.FAKE_CALLER_MODE === 'usage-error' && args.includes('--families')) {
  process.stderr.write('error: unexpected arguments\\n\\nusage: agent-interface BEHAVIOR ...\\n');
  process.exit(2);
}
let families = ['claude', 'codex', 'grok', 'antigravity', 'muse'];
const at = args.indexOf('--families');
if (at !== -1) families = args[at + 1] === '' ? [] : args[at + 1].split(',');
const down = process.env.FAKE_CALLER_DOWN === 'codex' ? ['codex'] : [];
console.log(JSON.stringify({ checked_at: new Date().toISOString(), families: Object.fromEntries(families.map(family => [family,
  down.includes(family) ? { status: 'unavailable', error: 'codex models cache is empty' } : { status: 'ok' }])) }));
`, { mode: 0o700 })
  const base: NodeJS.ProcessEnv = {
    HOME: home, PATH: bin, POISE_DB: dbPath,
    CALLER_BIN_ROOT: callerBin, AGENT_INTERFACE_ROOT: root, POISE_MODEL_CATALOG_REPORT: join(root, 'report.json'),
  }
  if (options.evidence !== undefined) base.POISE_PROVIDER_EVIDENCE = JSON.stringify(options.evidence)
  return {
    root, home,
    calls: () => fakeCalls(home),
    discoveries: async () => {
      try {
        return (await readFile(join(home, 'called.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      } catch {
        return []
      }
    },
    run: async (extraEnv = {}) => {
      const child = spawn(process.execPath, [resolve('scripts/refresh-models.mjs'), '--json'], {
        env: { ...base, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      child.stdout?.on('data', chunk => { stdout += chunk })
      child.stderr?.on('data', chunk => { stderr += chunk })
      const code = await new Promise<number | null>(resolveCode => child.once('close', resolveCode))
      return { code, report: stdout ? JSON.parse(stdout) : null, stderr }
    },
  }
}

const EVIDENCE = (logins: Record<string, string>, live: { claude: boolean | 'missing' | null, codex: boolean | 'missing' | null }) => ({ logins, live })

describe('the refresh script', () => {
  let cases: ScriptCase[] = []
  afterEach(async () => {
    for (const scriptCase of cases) await rm(scriptCase.root, { recursive: true, force: true })
    cases = []
    vi.unstubAllEnvs()
  })
  const prepare = async (...args: Parameters<typeof scriptCase>): Promise<ScriptCase> => {
    const prepared = await scriptCase(...args)
    cases.push(prepared)
    return prepared
  }
  const connectedClaudeCodex = () => ({
    claude: withUpdates('claude', script('claude', STATUS.claudeSignedOut)),
    codex: withUpdates('codex', script('codex', STATUS.codexChatGpt)),
    grok: withUpdates('grok', script('grok')),
    muse: script('muse'),
    antigravity: withUpdates('antigravity', script('antigravity')),
  })

  it('skips an absent CLI and an installed never-configured provider without failing', async () => {
    const { run, calls, discoveries } = await prepare({
      claude: withUpdates('claude', script('claude', STATUS.claudeSubscription)),
      codex: withUpdates('codex', script('codex', STATUS.codexChatGpt)),
      // grok has no fake: its CLI is absent. muse is installed, never configured.
      muse: script('muse'),
      antigravity: withUpdates('antigravity', script('antigravity')),
    }, { evidence: EVIDENCE({ claude: AT, codex: AT, antigravity: AT }, { claude: null, codex: null }) })
    const { code, report, stderr } = await run()
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(report.eligible).toEqual(['claude', 'codex', 'antigravity'])
    for (const id of ['grok', 'muse']) {
      expect(report.cli_updates[id]).toMatchObject({ status: 'skipped', reason: SKIP_REASON })
      expect(report.families[id]).toMatchObject({ status: 'skipped', reason: SKIP_REASON })
    }
    expect(report.families.claude).toMatchObject({ status: 'ok' })
    expect(modelRefreshSummary(report)).toMatchObject({ level: 'ok' })
    // Scoped discovery: the bare all-provider call is kept for full checks.
    expect(await discoveries()).toEqual([['--refresh-models', '--families', 'claude,codex,antigravity']])
    const names = (await calls()).map(call => call.name)
    expect(names).toContain('claude')
    expect(names).not.toContain('grok')
    expect(names).not.toContain('muse')
  })

  it('checks on when the server found Claude and Codex not installed', async () => {
    const { run } = await prepare({
      grok: withUpdates('grok', script('grok')),
      muse: script('muse'),
      antigravity: withUpdates('antigravity', script('antigravity')),
    }, { evidence: EVIDENCE({ grok: AT }, { claude: 'missing', codex: 'missing' }) })
    const { code, report } = await run()
    expect(code).toBe(0)
    expect(report.eligible).toEqual(['grok'])
    expect(report.families.grok).toMatchObject({ status: 'ok' })
    expect(report.families.claude).toMatchObject({ status: 'skipped', reason: SKIP_REASON })
    expect(report.families.codex).toMatchObject({ status: 'skipped', reason: SKIP_REASON })
  })

  it('keeps the bare all-provider Caller call when every provider participates', async () => {
    const { run, discoveries } = await prepare(connectedClaudeCodex(), {
      evidence: EVIDENCE({ claude: AT, codex: AT, grok: AT, antigravity: AT, muse: AT }, { claude: null, codex: null }),
    })
    const { code, report } = await run()
    expect(code).toBe(0)
    expect(report.eligible).toEqual(['claude', 'codex', 'grok', 'antigravity', 'muse'])
    expect(await discoveries()).toEqual([['--refresh-models']])
  })

  it('with no eligible providers says so, spawns no Caller and keeps the catalog', async () => {
    const { run, discoveries, root } = await prepare(connectedClaudeCodex(), {
      evidence: EVIDENCE({}, { claude: false, codex: false }),
    })
    const { code, report } = await run()
    expect(code).toBe(0)
    expect(report.eligible).toEqual([])
    expect(report.error).toBeUndefined()
    expect(Object.values(report.cli_updates)).toHaveLength(5)
    for (const item of Object.values(report.cli_updates) as Array<{ status: string }>) expect(item.status).toBe('skipped')
    expect(Object.values(report.families)).toHaveLength(5)
    for (const item of Object.values(report.families) as Array<{ status: string }>) expect(item.status).toBe('skipped')
    expect(await discoveries()).toHaveLength(0)
    expect(JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))).toEqual(report)
    expect(modelRefreshSummary(report)).toEqual({ text: 'No connected providers to check. Connect one in Settings → Accounts.', level: 'neutral' })
  })

  it('fails a recorded provider whose CLI is now missing, without calling it skipped', async () => {
    const { run } = await prepare({
      claude: withUpdates('claude', script('claude', STATUS.claudeSubscription)),
      grok: withUpdates('grok', script('grok')),
      muse: script('muse'),
      antigravity: withUpdates('antigravity', script('antigravity')),
    }, { evidence: EVIDENCE({ claude: AT, codex: AT }, { claude: null, codex: null }) })
    const { code, report } = await run()
    expect(code).toBe(1)
    expect(report.cli_updates.codex).toMatchObject({ status: 'unavailable', error: expect.stringContaining('not installed') })
    expect(report.families.codex.status).not.toBe('skipped')
    expect(modelRefreshSummary(report).level).toBe('error')
  })

  it('fails a recorded provider that signed out, when discovery says so', async () => {
    const { run } = await prepare(connectedClaudeCodex(), {
      evidence: EVIDENCE({ claude: AT, codex: AT }, { claude: null, codex: false }),
    })
    const { code, report } = await run({ FAKE_CALLER_DOWN: 'codex' })
    expect(code).toBe(1)
    expect(report.eligible).toEqual(['claude', 'codex'])
    expect(report.families.codex).toMatchObject({ status: 'unavailable', error: 'codex models cache is empty' })
    expect(modelRefreshSummary(report).text).toContain('Model check incomplete')
  })

  it('names an installed Caller that predates provider-scoped refresh', async () => {
    const { run } = await prepare(connectedClaudeCodex(), {
      evidence: EVIDENCE({ codex: AT }, { claude: false, codex: null }),
    })
    const { code, report } = await run({ FAKE_CALLER_MODE: 'usage-error' })
    expect(code).toBe(1)
    expect(report.error).toContain('Update Caller')
    expect(report.error).toContain('predates provider-scoped refresh')
  })

  it('shares an overlapping check only when its participation context still matches', async () => {
    const scripts = connectedClaudeCodex()
    const same = await prepare(scripts, { evidence: EVIDENCE({ claude: AT, codex: AT }, { claude: null, codex: null }) })
    const [first, second] = await Promise.all([same.run({ FAKE_CALLER_SLEEP_MS: '2500' }), same.run({ FAKE_CALLER_SLEEP_MS: '2500' })])
    expect(first.code).toBe(0)
    expect(second.code).toBe(0)
    expect(first.report.completed_at).toBe(second.report.completed_at)
    expect(await same.discoveries()).toHaveLength(1)

    // Same report path, so the runs overlap; different eligibility, so the
    // waiter must not reuse the winner's report.
    const narrow = await prepare(scripts, { evidence: EVIDENCE({ claude: AT, codex: AT }, { claude: null, codex: null }) })
    const wide = await prepare(scripts, { evidence: EVIDENCE({ claude: AT, codex: AT, grok: AT }, { claude: null, codex: null }) })
    const shared = join(narrow.root, 'shared.json')
    const runs = await Promise.all([
      narrow.run({ FAKE_CALLER_SLEEP_MS: '2500', POISE_MODEL_CATALOG_REPORT: shared }),
      wide.run({ FAKE_CALLER_SLEEP_MS: '2500', POISE_MODEL_CATALOG_REPORT: shared }),
    ])
    expect(runs.map(result => result.code)).toEqual([0, 0])
    expect((await narrow.discoveries()).length + (await wide.discoveries()).length).toBe(2)
    expect(runs[0].report.eligible).not.toEqual(runs[1].report.eligible)
  }, 60_000)

  it('fails unknown eligibility instead of a clean empty success', async () => {
    const { run } = await prepare(connectedClaudeCodex(), {
      evidence: EVIDENCE({ grok: AT }, { claude: null, codex: null }),
    })
    const { code, report } = await run()
    expect(code).toBe(1)
    expect(report.error).toContain('claude eligibility is unknown')
    expect(report.families).toEqual({})
  })
})

describe('the three entry points', () => {
  let root = '', bin = '', home = '', callerBin = ''
  beforeEach(async () => {
    setMeta('account_logins', JSON.stringify({ codex: AT }))
    invalidateAccounts()
    root = await mkdtemp(join(tmpdir(), 'poise-participation-entry-'))
    bin = join(root, 'bin')
    home = join(root, 'home')
    callerBin = join(root, 'caller-bin')
    await mkdir(callerBin, { recursive: true })
    await writeFakeClis(bin, home, {
      claude: withUpdates('claude', script('claude', STATUS.claudeSignedOut)),
      codex: withUpdates('codex', script('codex', STATUS.codexChatGpt)),
      grok: withUpdates('grok', script('grok')),
      muse: script('muse'),
      antigravity: withUpdates('antigravity', script('antigravity')),
    })
    await writeFile(join(callerBin, 'agent-interface'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.HOME + '/called.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
const args = process.argv.slice(2);
const at = args.indexOf('--families');
const families = at === -1 ? ['claude', 'codex', 'grok', 'antigravity', 'muse'] : args[at + 1].split(',');
console.log(JSON.stringify({ checked_at: new Date().toISOString(), families: Object.fromEntries(families.map(family => [family, { status: 'ok' }])) }));
`, { mode: 0o700 })
    seedDb(join(root, 'cache.db'), { codex: AT })
    vi.stubEnv('PATH', bin)
    vi.stubEnv('HOME', home)
    vi.stubEnv('CALLER_BIN_ROOT', callerBin)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it('manual, scheduled and standalone runs agree on participation', async () => {
    // Manual: the server route forwards its own observation to the script.
    vi.stubEnv('POISE_MODEL_CATALOG_REPORT', join(root, 'manual.json'))
    const manual = await refreshModelCatalog() as { eligible: string[], families: Record<string, { status: string }>, cli_updates: Record<string, { status: string }>, error?: string }
    // Scheduled: the service daily run checks through the same path.
    vi.stubEnv('POISE_MODEL_CATALOG_REPORT', join(root, 'scheduled.json'))
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
      const scheduled = await running! as typeof manual
      // Standalone: the launchd environment resolves eligibility itself, from
      // the same database and the same status commands.
      const standaloneCase = await scriptCase({
        claude: withUpdates('claude', script('claude', STATUS.claudeSignedOut)),
        codex: withUpdates('codex', script('codex', STATUS.codexChatGpt)),
        grok: withUpdates('grok', script('grok')),
        muse: script('muse'),
        antigravity: withUpdates('antigravity', script('antigravity')),
      }, { db: { codex: AT } })
      try {
        const standalone = await standaloneCase.run()
        expect(standalone.code).toBe(0)
        for (const report of [manual, scheduled, standalone.report]) {
          expect(report.error).toBeUndefined()
          expect(report.eligible).toEqual(['codex'])
          expect(report.families.codex).toMatchObject({ status: 'ok' })
          expect(report.cli_updates.codex.status).not.toBe('unavailable')
          for (const id of ['claude', 'grok', 'antigravity', 'muse']) {
            expect(report.families[id]).toMatchObject({ status: 'skipped', reason: SKIP_REASON })
            expect(report.cli_updates[id]).toMatchObject({ status: 'skipped', reason: SKIP_REASON })
          }
        }
        expect(standalone.report.cli_updates.codex.status).toBe(manual.cli_updates.codex.status)
      } finally {
        await rm(standaloneCase.root, { recursive: true, force: true })
      }
    } finally {
      schedule.stop()
    }
  }, 60_000)
})

