// Connected accounts: each CLI's own status command, run against fakes that
// print what the real CLIs print. PATH holds only the fakes (and node), so a
// real CLI can never answer in a test.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountsCache, ACCOUNTS_CACHE_MS } from '../server/accounts'
import { probeAccounts, type RunCommand } from '../server/accounts/status'
import type { ConnectedAccount } from '../server/accounts/types'
import { runFile } from '../server/process'
import { STATUS, fakeCalls, script, writeFakeClis } from './fixtures/accounts/fake-clis'

let root = ''
let bin = ''
let home = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-accounts-'))
  bin = join(root, 'bin')
  home = join(root, 'home')
  vi.stubEnv('PATH', bin)
  vi.stubEnv('HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

const LABELS = {
  claude: 'claude auth login --claudeai',
  codex: 'codex login --device-auth',
  gh: 'gh auth login --hostname github.com --git-protocol https --web',
  grok: 'grok login --device-auth',
  muse: 'muse login',
  antigravity: 'agy',
}

const UNREPORTED = {
  grok: 'Grok\'s CLI has no command that reports whether it is signed in.',
  muse: 'Muse\'s CLI has no command that reports whether it is signed in.',
  antigravity: 'Antigravity\'s CLI has no command that reports whether it is signed in. It shows its sign-in screen when it starts signed out.',
}

function byId(accounts: ConnectedAccount[]): Record<string, ConnectedAccount> {
  return Object.fromEntries(accounts.map((account) => [account.id, account]))
}

describe('GET /api/accounts', () => {
  it('reports each CLI as its own status command does', async () => {
    await writeFakeClis(bin, home, {
      claude: script('claude', STATUS.claudeSubscription),
      codex: script('codex', STATUS.codexChatGpt),
      gh: script('gh', STATUS.ghTwoAccounts),
      grok: script('grok'),
      muse: script('muse'),
      antigravity: script('antigravity'),
    })

    expect(await probeAccounts(runFile)).toEqual([
      { id: 'claude', installed: true, version: '2.1.288', signedIn: true, identity: 'octocat@example.com', detail: 'Claude Max subscription', login: { label: LABELS.claude } },
      { id: 'codex', installed: true, version: '0.160.0', signedIn: true, identity: null, detail: 'Signed in with ChatGPT', login: { label: LABELS.codex } },
      {
        id: 'gh', installed: true, version: '2.92.0', signedIn: true, identity: 'octocat', detail: null, login: { label: LABELS.gh },
        accounts: [
          { login: 'octocat', active: true, signedIn: true, detail: null },
          { login: 'octo-agent', active: false, signedIn: true, detail: null },
        ],
      },
      { id: 'grok', installed: true, version: '1.0.46', signedIn: null, identity: null, detail: UNREPORTED.grok, login: { label: LABELS.grok } },
      { id: 'muse', installed: true, version: '1.4.2', signedIn: null, identity: null, detail: UNREPORTED.muse, login: { label: LABELS.muse } },
      { id: 'antigravity', installed: true, version: '1.2.14', signedIn: null, identity: null, detail: UNREPORTED.antigravity, login: { label: LABELS.antigravity } },
    ])
  })

  it('reports signed-out CLIs, which answer and exit non-zero, as signed out', async () => {
    await writeFakeClis(bin, home, {
      claude: script('claude', STATUS.claudeSignedOut),
      codex: script('codex', STATUS.codexSignedOut),
      gh: script('gh', STATUS.ghSignedOut),
    })

    const accounts = byId(await probeAccounts(runFile))
    expect(accounts.claude).toMatchObject({ installed: true, version: '2.1.288', signedIn: false, identity: null, detail: null })
    expect(accounts.codex).toMatchObject({ installed: true, version: '0.160.0', signedIn: false, identity: null, detail: null })
    expect(accounts.gh).toMatchObject({ installed: true, version: '2.92.0', signedIn: false, identity: null, detail: null, accounts: [] })
  })

  it('says which gh account cannot sign in, and that a Claude login without a subscription will not run Claude', async () => {
    await writeFakeClis(bin, home, {
      claude: script('claude', STATUS.claudeConsole),
      codex: script('codex', STATUS.codexApiKey),
      gh: script('gh', STATUS.ghExpiredAgent),
    })

    const accounts = byId(await probeAccounts(runFile))
    expect(accounts.claude).toMatchObject({
      signedIn: false, identity: null,
      detail: 'Claude Code is signed in, but not to a Claude subscription. Poise runs Claude only on a subscription; reconnect with your Claude account.',
    })
    expect(accounts.codex).toMatchObject({ signedIn: true, identity: null, detail: 'Signed in with an OpenAI API key' })
    expect(accounts.gh).toMatchObject({
      signedIn: true, identity: 'octocat',
      detail: 'gh cannot use octo-agent; reconnect that account.',
      accounts: [
        { login: 'octocat', active: true, signedIn: true, detail: null },
        { login: 'octo-agent', active: false, signedIn: false, detail: 'HTTP 401: Bad credentials (https://api.github.com/)' },
      ],
    })
  })

  it('returns the account name and never a key, an organisation or a credential\'s location', async () => {
    await writeFakeClis(bin, home, {
      claude: script('claude', STATUS.claudeSubscription),
      codex: script('codex', STATUS.codexApiKey),
      gh: script('gh', STATUS.ghTwoAccounts),
    })

    const answer = JSON.stringify(await probeAccounts(runFile))
    for (const secret of ['sk-proj', 'E1234', '7a1c0f2e', 'Organization', 'keyring', 'scopes', '/home/poise']) {
      expect(answer).not.toContain(secret)
    }
  })

  it('reads Claude through Poise\'s wrapper, gh\'s stored accounts and muse without updating it, and never starts a login', async () => {
    vi.stubEnv('GH_TOKEN', 'ghp_environment_token_never_used')
    await writeFakeClis(bin, home, {
      claude: script('claude', STATUS.claudeSubscription),
      codex: script('codex', STATUS.codexChatGpt),
      gh: script('gh', STATUS.ghTwoAccounts),
      muse: script('muse'),
    })

    await probeAccounts(runFile)
    const calls = await fakeCalls(home)
    expect(calls.find((call) => call.name === 'claude' && call.args.join(' ') === 'auth status --json')).toMatchObject({ settings: true })
    expect(calls.filter((call) => call.name === 'gh').map((call) => call.ghToken)).toEqual([null, null])
    expect(calls.find((call) => call.name === 'muse')).toMatchObject({ args: ['--version'], museNoAutoUpdate: '1' })
    expect(calls.map((call) => `${call.name} ${call.args.join(' ')}`).sort()).toEqual([
      'claude --version',
      'claude auth status --json',
      'codex --version',
      'codex login status',
      'gh --version',
      'gh auth status --json hosts --hostname github.com',
      'muse --version',
    ])
  })

  it('tells a CLI that is not installed apart from one that fails', async () => {
    await writeFakeClis(bin, home, {
      claude: script('claude', STATUS.claudeSubscription),
      codex: { '--version': { stderr: 'Error: cannot read /home/poise/.codex/config.toml\n', code: 2 } },
      gh: { '--version': { stdout: 'gh version 2.92.0 (2026-04-28)\n' }, 'auth status --json hosts --hostname github.com': { stderr: 'unknown flag: --json\n', code: 1 } },
    })

    const accounts = byId(await probeAccounts(runFile))
    for (const id of ['grok', 'muse'] as const) {
      expect(accounts[id]).toEqual({ id, installed: false, version: null, signedIn: null, identity: null, detail: `${id} is not installed: Poise cannot find it on its PATH.`, login: { label: LABELS[id] } })
    }
    expect(accounts.antigravity).toMatchObject({ installed: false, detail: 'agy is not installed: Poise cannot find it on its PATH.' })
    expect(accounts.codex).toEqual({
      id: 'codex', installed: true, version: null, signedIn: null, identity: null,
      detail: '`codex --version` exited with code 2: Error: cannot read /home/poise/.codex/config.toml',
      login: { label: LABELS.codex },
    })
    expect(accounts.gh).toMatchObject({ installed: true, version: '2.92.0', signedIn: null, detail: '`gh auth status` exited with code 1: unknown flag: --json' })
    expect(accounts.claude).toMatchObject({ signedIn: true })
  })

  it('says when a status command does not answer in time, and stops it', async () => {
    await writeFakeClis(bin, home, {})
    await writeFile(join(bin, 'codex'), `#!/bin/sh\nif [ "$1" = --version ]; then echo 'codex-cli 0.160.0'; exit 0; fi\necho $$ > "$HOME/codex.pid"\nexec /bin/sleep 30\n`)
    await chmod(join(bin, 'codex'), 0o755)
    const run: RunCommand = (command, args, options) => runFile(command, args, { ...options, timeoutMs: 500 })

    const accounts = byId(await probeAccounts(run))
    expect(accounts.codex).toMatchObject({ installed: true, version: '0.160.0', signedIn: null, detail: '`codex login status` did not answer within 0.5 seconds' })
    const pid = Number(await readFile(join(home, 'codex.pid'), 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('gives no answer it cannot read as an answer', async () => {
    await writeFakeClis(bin, home, {
      claude: { '--version': { stdout: '2.1.288 (Claude Code)\n' }, 'auth status --json': { stdout: 'Welcome to Claude Code\n' } },
      codex: { '--version': { stdout: 'codex-cli 0.160.0\n' }, 'login status': { stderr: 'Logged in somehow\n' } },
      gh: { '--version': { stdout: 'gh version 2.92.0\n' }, 'auth status --json hosts --hostname github.com': { stdout: '{"hosts":{"github.com":[{"login":"not a login!"}]}}\n' } },
    })

    const accounts = byId(await probeAccounts(runFile))
    expect(accounts.claude).toMatchObject({ signedIn: null, detail: '`claude auth status` gave no answer Poise can read.' })
    expect(accounts.codex).toMatchObject({ signedIn: null, detail: '`codex login status` gave no answer Poise can read.' })
    expect(accounts.gh).toMatchObject({ signedIn: null, detail: '`gh auth status` gave no answer Poise can read.' })
  })
})

describe('the accounts cache', () => {
  function counting() {
    let probes = 0
    let release: (() => void) | null = null
    let hold = false
    const probe = async (): Promise<ConnectedAccount[]> => {
      probes += 1
      if (hold) await new Promise<void>((resolve) => { release = resolve })
      return []
    }
    return { probe, probes: () => probes, hold: (value: boolean) => { hold = value }, release: () => release?.() }
  }

  it('answers from the last read for 15 seconds, then reads again', async () => {
    let now = 1_000
    const source = counting()
    const cache = new AccountsCache(source.probe, () => now)
    await cache.list()
    await cache.list()
    now += ACCOUNTS_CACHE_MS - 1
    await cache.list()
    expect(source.probes()).toBe(1)
    now += 1
    await cache.list()
    expect(source.probes()).toBe(2)
  })

  it('shares a read in progress and forgets everything when invalidated', async () => {
    const source = counting()
    const cache = new AccountsCache(source.probe, () => 0)
    source.hold(true)
    const first = cache.list()
    const second = cache.list()
    expect(source.probes()).toBe(1)
    // A terminal exits while the read runs: the next list must not get it.
    cache.invalidate()
    source.hold(false)
    const third = cache.list()
    expect(source.probes()).toBe(2)
    source.release()
    await Promise.all([first, second, third])
    await cache.list()
    expect(source.probes()).toBe(2)
  })

  it('does not keep a failed read', async () => {
    let fail = true
    let probes = 0
    const cache = new AccountsCache(async () => {
      probes += 1
      if (fail) throw new Error('probe failed')
      return []
    }, () => 0)
    await expect(cache.list()).rejects.toThrow('probe failed')
    fail = false
    await expect(cache.list()).resolves.toEqual([])
    expect(probes).toBe(2)
  })
})
