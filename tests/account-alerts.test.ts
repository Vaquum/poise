// Sign-in alerts from Connected accounts: an installed CLI that says it is
// not signed in, and your GitHub account or the agent account that gh does
// not hold signed in, alert once until they are signed in again.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectedAccount, GhAccount } from '../server/accounts/types'

let root = ''
let producers: typeof import('../server/alerts/producers')
let database: typeof import('../server/db')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-account-alerts-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.resetModules()
  database = await import('../server/db')
  producers = await import('../server/alerts/producers')
})

beforeEach(() => {
  database.db.prepare('DELETE FROM alerts').run()
})

afterAll(async () => {
  database.closeDatabase()
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

const rows = () => database.db.prepare('SELECT kind, title, body, url, dedupe_key AS key, resolved_at AS resolved FROM alerts ORDER BY id').all() as Array<Record<string, unknown>>
const open = () => rows().filter((row) => row.resolved === null).map((row) => row.key)

function cli(id: ConnectedAccount['id'], signedIn: boolean | null, installed = true): ConnectedAccount {
  return { id, installed, version: installed ? '1.0.0' : null, signedIn, identity: null, detail: null, login: { label: id } }
}

function gh(accounts: GhAccount[] | undefined): ConnectedAccount {
  return { ...cli('gh', accounts ? accounts.some((account) => account.signedIn) : null), ...(accounts ? { accounts } : {}) }
}

const held = (login: string, signedIn = true): GhAccount => ({ login, active: false, signedIn, detail: signedIn ? null : 'HTTP 401: Bad credentials (https://api.github.com/)' })
const nobody = { me: '', agentAccount: '' }

describe('sign-in alerts from Connected accounts', () => {
  it('alert once for a CLI that says it is not signed in, until it says it is', () => {
    producers.accountsChecked([cli('codex', false)], nobody)
    expect(rows()).toEqual([{
      kind: 'sign_in_needed', key: 'sign-in:codex', resolved: null, url: '/?settings=accounts',
      title: 'Codex needs you to sign in',
      body: 'Codex is not signed in, so work that runs it cannot start. Connect it in Settings → Accounts.',
    }])
    producers.accountsChecked([cli('codex', false)], nobody)
    expect(rows()).toHaveLength(1)
    producers.accountsChecked([cli('codex', true)], nobody)
    expect(open()).toEqual([])
    producers.accountsChecked([cli('codex', false)], nobody)
    expect(rows()).toHaveLength(2)
    expect(open()).toEqual(['sign-in:codex'])
  })

  it('change nothing while a CLI cannot say, is not installed, or is Claude, which its monitor alerts for', () => {
    producers.accountsChecked([cli('codex', false)], nobody)
    for (const accounts of [
      [cli('codex', null)],
      [cli('codex', false, false)],
      [cli('grok', null), cli('muse', null), cli('antigravity', null)],
      [cli('claude', false), cli('claude', true)],
    ]) producers.accountsChecked(accounts, nobody)
    expect(open()).toEqual(['sign-in:codex'])
    expect(rows()).toHaveLength(1)
  })

  it('alert for your GitHub account and the agent account while gh does not hold them signed in', () => {
    const identities = { me: 'OctoCat', agentAccount: 'octo-agent' }
    producers.accountsChecked([gh([held('octo-agent', false)])], identities)
    expect(rows()).toEqual([
      {
        kind: 'sign_in_needed', key: 'sign-in:gh:you', resolved: null, url: '/?settings=accounts',
        title: 'Your GitHub account is not signed in to gh',
        body: 'Poise reads GitHub as OctoCat, which gh does not hold signed in. Connect GitHub in Settings → Accounts and sign in as OctoCat.',
      },
      {
        kind: 'sign_in_needed', key: 'sign-in:gh:agent', resolved: null, url: '/?settings=accounts',
        title: 'The agent account is not signed in to gh',
        body: 'Reviews and comments are posted as octo-agent, which gh does not hold signed in. Connect GitHub in Settings → Accounts and sign in as octo-agent.',
      },
    ])
    // GitHub logins are case-insensitive.
    producers.accountsChecked([gh([held('octocat'), held('octo-agent', false)])], identities)
    expect(open()).toEqual(['sign-in:gh:agent'])
    producers.accountsChecked([gh([held('octocat'), held('octo-agent')])], identities)
    expect(open()).toEqual([])
  })

  it('know nothing about either GitHub account without gh\'s answer, and nothing to alert for an account not set', () => {
    producers.accountsChecked([gh([])], { me: 'octocat', agentAccount: 'octo-agent' })
    expect(open()).toEqual(['sign-in:gh:you', 'sign-in:gh:agent'])
    producers.accountsChecked([gh(undefined)], nobody)
    producers.accountsChecked([{ ...gh([]), installed: false }], nobody)
    expect(open()).toEqual(['sign-in:gh:you', 'sign-in:gh:agent'])
    producers.accountsChecked([gh([])], nobody)
    expect(open()).toEqual([])
  })
})
