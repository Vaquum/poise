// The gh row of Settings → Connected accounts marks your GitHub account and
// the agent account (Settings → General) among the accounts gh holds, and
// says when gh cannot use either.

import { describe, expect, it } from 'vitest'
import type { ConnectedAccount, GhAccount } from '../server/accounts/types'
import { accountsHtml } from '../src/views/connected-accounts'

function gh(accounts: GhAccount[] | undefined, signedIn: boolean | null = accounts?.some((account) => account.signedIn) ?? null): ConnectedAccount {
  return {
    id: 'gh', installed: true, version: '2.92.0', signedIn, identity: accounts?.find((account) => account.active)?.login ?? null,
    detail: null, login: { label: 'gh auth login --hostname github.com --git-protocol https --web' },
    ...(accounts ? { accounts } : {}),
  }
}

const held = (login: string, active = false, signedIn = true): GhAccount => ({ login, active, signedIn, detail: signedIn ? null : 'HTTP 401: Bad credentials (https://api.github.com/)' })

function notes(html: string, login: string): string | null {
  const item = new RegExp(`data-login="${login}">([\\s\\S]*?)</li>`).exec(html)
  if (!item) throw new Error(`no gh account ${login} in the row`)
  return /<span class="st-gh-notes">([^<]*)<\/span>/.exec(item[1])?.[1] ?? null
}

function missing(html: string): string[] {
  return [...html.matchAll(/<div class="st-help st-help-error st-gh-missing">([^<]*)<\/div>/g)].map((match) => match[1])
}

describe('the gh row', () => {
  it('marks which held account is yours and which is the agent account', () => {
    const html = accountsHtml([gh([held('OctoCat', true), held('octo-agent'), held('someone-else')])], { me: 'octocat', agentAccount: 'Octo-Agent' }, false)
    expect(notes(html, 'OctoCat')).toBe('active · your GitHub account')
    expect(notes(html, 'octo-agent')).toBe('agent account')
    expect(notes(html, 'someone-else')).toBeNull()
    expect(missing(html)).toEqual([])
  })

  it('says when your account or the agent account is not signed in to gh', () => {
    const html = accountsHtml([gh([held('octocat', true)])], { me: 'octocat', agentAccount: 'octo-agent' }, false)
    expect(missing(html)).toEqual(['The agent account octo-agent is not signed in to gh.'])
    expect(missing(accountsHtml([gh([])], { me: 'octocat', agentAccount: 'octo-agent' }, false))).toEqual([
      'Your GitHub account octocat is not signed in to gh.',
      'The agent account octo-agent is not signed in to gh.',
    ])
  })

  it('counts an account gh holds but cannot use as not signed in', () => {
    const html = accountsHtml([gh([held('octocat', true), held('octo-agent', false, false)])], { me: 'octocat', agentAccount: 'octo-agent' }, false)
    expect(notes(html, 'octo-agent')).toBe('agent account')
    expect(html).toContain('HTTP 401: Bad credentials')
    expect(missing(html)).toEqual(['The agent account octo-agent is not signed in to gh.'])
  })

  it('says nothing about either account while gh\'s status is unknown, or when none is set', () => {
    expect(missing(accountsHtml([gh(undefined)], { me: 'octocat', agentAccount: 'octo-agent' }, false))).toEqual([])
    expect(missing(accountsHtml([gh([held('octocat', true)])], { me: '', agentAccount: '' }, false))).toEqual([])
  })

  it('escapes what it shows', () => {
    const html = accountsHtml([{ ...gh([held('octocat', true)]), detail: '<img src=x onerror=alert(1)>' }], { me: 'octocat', agentAccount: '' }, false)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})
