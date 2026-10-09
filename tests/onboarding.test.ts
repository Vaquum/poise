import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFileOptions } from '../server/process'

// First-run setup's server side (server/service/onboarding.ts): whether a
// workspace opens setup, where it resumes, the logins it counts, and the
// GitHub check that proves an account gh holds actually works.

const TOKEN = 'gho_secretsecretsecret'

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  ready: [] as Array<{ login: string }>,
  runFile: vi.fn(),
  setSettings: vi.fn(),
}))

vi.mock('../server/db', () => ({
  getMeta: (key: string) => mocks.store.get(key) ?? null,
  setMeta: (key: string, value: string) => { mocks.store.set(key, value) },
}))
vi.mock('../server/organizations', () => ({ readyOrganizations: () => mocks.ready }))
vi.mock('../server/process', async (original) => ({ ...(await original<typeof import('../server/process')>()), runFile: mocks.runFile }))
vi.mock('../server/settings', () => ({
  setSettings: (partial: Record<string, string>) => {
    mocks.setSettings(partial)
    for (const [key, value] of Object.entries(partial)) mocks.store.set(key, value)
  },
}))

const { accountLogins, checkGitHubAccount, connectGitHubAccount, markLogin, onboardingState, recordLogin, updateOnboarding } = await import('../server/service/onboarding')

type Call = { args: readonly string[], env: NodeJS.ProcessEnv | undefined }
let calls: Call[] = []

/** gh as the check runs it: `auth token --user`, then `api user --include` with that token. */
function gh(answers: {
  tokens?: Record<string, string>
  user?: (token: string) => { login: string, scopes?: string } | 'reject'
  fail?: (args: readonly string[]) => string | null
}) {
  mocks.runFile.mockImplementation(async (command: string, args: readonly string[], options: RunFileOptions = {}) => {
    expect(command).toBe('gh')
    calls.push({ args, env: options.env })
    const failure = answers.fail?.(args)
    if (failure) throw Object.assign(new Error('gh failed'), { stderr: `${failure}\n` })
    if (args[0] === 'auth' && args[1] === 'token') {
      const token = answers.tokens?.[String(args[args.indexOf('--user') + 1])]
      if (!token) throw Object.assign(new Error('exit 1'), { stderr: 'no oauth token found for github.com account\n' })
      return { stdout: `${token}\n`, stderr: '' }
    }
    if (args[0] === 'api') {
      const user = answers.user?.(String(options.env?.GH_TOKEN)) ?? 'reject'
      if (user === 'reject') throw Object.assign(new Error('exit 1'), { stderr: 'HTTP 401: Bad credentials\n' })
      const scopes = user.scopes === undefined ? '' : `X-Oauth-Scopes: ${user.scopes}\r\n`
      return { stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${scopes}\r\n${JSON.stringify({ login: user.login, id: 1 })}`, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

beforeEach(() => {
  mocks.store.clear()
  mocks.ready = []
  mocks.runFile.mockReset()
  mocks.setSettings.mockReset()
  calls = []
})

describe('whether a workspace opens setup', () => {
  it('opens it in a new workspace and remembers that, so adding accounts during setup does not end it', () => {
    expect(onboardingState()).toEqual({ status: 'pending', step: 'theme', completedAt: null })
    mocks.ready = [{ login: 'acme' }]
    expect(onboardingState().status).toBe('pending')
  })

  it('never opens it in a workspace that already reads a GitHub account', () => {
    mocks.ready = [{ login: 'acme' }]
    expect(onboardingState()).toMatchObject({ status: 'done' })
    mocks.ready = []
    expect(onboardingState()).toMatchObject({ status: 'done' })
  })

  it('resumes at the step it reached, finishes, and can start again', () => {
    expect(updateOnboarding({ step: 'models' })).toMatchObject({ status: 'pending', step: 'models' })
    expect(onboardingState().step).toBe('models')
    const done = updateOnboarding({ done: true })
    expect(done).toMatchObject({ status: 'done', step: 'finish' })
    expect(Date.parse(done.completedAt ?? '')).not.toBeNaN()
    expect(updateOnboarding({ restart: true })).toMatchObject({ status: 'pending', step: 'theme', completedAt: done.completedAt })
  })

  it('refuses a step it does not know', () => {
    expect(() => updateOnboarding({ step: 'admin' })).toThrow(/step must be one of theme, github/)
    expect(() => updateOnboarding(null)).toThrow()
    expect(() => updateOnboarding([])).toThrow()
  })
})

describe('the logins setup counts', () => {
  it('records a CLI\'s login when its terminal exits cleanly, and nothing else', () => {
    recordLogin('grok', 0)
    recordLogin('muse', 1)
    recordLogin('shell', 0)
    recordLogin('not-a-cli', 0)
    expect(Object.keys(accountLogins())).toEqual(['grok'])
    expect(Date.parse(accountLogins().grok ?? '')).not.toBeNaN()
  })

  it('never counts Antigravity\'s exit, since its terminal runs the app itself', () => {
    recordLogin('antigravity', 0)
    expect(accountLogins()).toEqual({})
  })

  it('takes the person\'s word for a CLI that reports no sign-in, both ways', () => {
    markLogin('antigravity', true)
    recordLogin('grok', 0)
    expect(Object.keys(accountLogins()).sort()).toEqual(['antigravity', 'grok'])
    expect(updateOnboarding({ account: 'grok', signedIn: false })).toEqual(onboardingState())
    expect(Object.keys(accountLogins())).toEqual(['antigravity'])
    // The CLIs with a status command say for themselves.
    expect(() => markLogin('claude', true)).toThrow(/grok, muse, antigravity/)
    expect(() => markLogin('antigravity', 'yes')).toThrow(/signedIn/)
    expect(() => updateOnboarding({ account: 'nobody', signedIn: true })).toThrow(/account must be one of/)
  })

  it('ignores a stored record it cannot read', () => {
    mocks.store.set('account_logins', 'not json')
    expect(accountLogins()).toEqual({})
    mocks.store.set('account_logins', JSON.stringify({ grok: '2026-10-09T06:00:00Z', nobody: 'x', muse: 5 }))
    expect(accountLogins()).toEqual({ grok: '2026-10-09T06:00:00Z' })
  })
})

describe('the GitHub check', () => {
  it('passes when the token gh holds for the account answers as that account with the scopes Poise needs', async () => {
    gh({ tokens: { octocat: TOKEN }, user: () => ({ login: 'OctoCat', scopes: 'gist, read:org, repo, workflow' }) })
    expect(await checkGitHubAccount('octocat')).toEqual({ ok: true, login: 'OctoCat', scopes: ['gist', 'read:org', 'repo', 'workflow'] })
    // The stored account, never a token from the environment, and the token only in gh's environment.
    expect(calls[0]).toMatchObject({ args: ['auth', 'token', '--hostname', 'github.com', '--user', 'octocat'], env: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined } })
    expect(calls[1]).toMatchObject({ args: ['api', 'user', '--include'], env: { GH_TOKEN: TOKEN, GH_HOST: 'github.com' } })
    expect(calls[1].args.join(' ')).not.toContain(TOKEN)
  })

  it('says what to do when gh holds no sign-in, GitHub refuses it, or it is someone else\'s', async () => {
    gh({ tokens: {} })
    expect(await checkGitHubAccount('octocat')).toMatchObject({ ok: false, reason: 'not-signed-in', message: expect.stringContaining('Connect it while signed in to GitHub as octocat') })
    gh({ tokens: { octocat: TOKEN }, user: () => 'reject' })
    expect(await checkGitHubAccount('octocat')).toMatchObject({ ok: false, reason: 'rejected' })
    gh({ tokens: { octocat: TOKEN }, user: () => ({ login: 'octo-agent', scopes: 'repo, read:org' }) })
    expect(await checkGitHubAccount('octocat')).toMatchObject({ ok: false, reason: 'other-account', message: expect.stringContaining('belongs to octo-agent') })
  })

  it('refuses a sign-in without the repo and read:org scopes, and accepts a token that carries no scope header', async () => {
    gh({ tokens: { octocat: TOKEN }, user: () => ({ login: 'octocat', scopes: 'gist' }) })
    expect(await checkGitHubAccount('octocat')).toMatchObject({ ok: false, reason: 'scopes', message: expect.stringContaining('repo and read:org') })
    gh({ tokens: { octocat: TOKEN }, user: () => ({ login: 'octocat' }) })
    expect(await checkGitHubAccount('octocat')).toEqual({ ok: true, login: 'octocat', scopes: null })
  })

  it('never puts the token into what it returns', async () => {
    gh({ tokens: { octocat: TOKEN }, user: () => ({ login: 'someone-else', scopes: 'repo' }) })
    const results = [await checkGitHubAccount('octocat')]
    gh({ tokens: { octocat: TOKEN }, user: () => 'reject' })
    results.push(await checkGitHubAccount('octocat'))
    expect(JSON.stringify(results)).not.toContain(TOKEN)
  })
})

describe('connecting an account in setup', () => {
  it('makes a working account your GitHub account and sets git up to sign in through gh', async () => {
    gh({ tokens: { octocat: TOKEN }, user: () => ({ login: 'OctoCat', scopes: 'repo, read:org' }) })
    expect(await connectGitHubAccount({ role: 'me', login: 'octocat' })).toEqual({ ok: true, login: 'OctoCat', scopes: ['repo', 'read:org'] })
    expect(mocks.setSettings).toHaveBeenCalledWith({ me: 'OctoCat' })
    expect(calls.map((call) => call.args.join(' ')).at(-1)).toBe('auth setup-git --hostname github.com')
  })

  it('makes a working agent account the agent and your own account gh\'s active one again', async () => {
    mocks.store.set('me', 'octocat')
    gh({ tokens: { 'octo-agent': TOKEN }, user: () => ({ login: 'octo-agent', scopes: 'repo, read:org' }) })
    expect(await connectGitHubAccount({ role: 'agent', login: 'octo-agent' })).toMatchObject({ ok: true, login: 'octo-agent' })
    expect(mocks.setSettings).toHaveBeenCalledWith({ agentAccount: 'octo-agent' })
    expect(calls.map((call) => call.args.join(' ')).at(-1)).toBe('auth switch --hostname github.com --user octocat')
  })

  it('says so when gh could not be set up, without failing a working account', async () => {
    mocks.store.set('me', 'octocat')
    gh({
      tokens: { 'octo-agent': TOKEN },
      user: () => ({ login: 'octo-agent', scopes: 'repo, read:org' }),
      fail: (args) => args[1] === 'switch' ? 'no account octocat' : null,
    })
    expect(await connectGitHubAccount({ role: 'agent', login: 'octo-agent' })).toMatchObject({
      ok: true, note: 'gh could not make octocat its active account again (no account octocat).',
    })
  })

  it('saves nothing for an account that does not work, and refuses what is not a GitHub login', async () => {
    gh({ tokens: {} })
    expect(await connectGitHubAccount({ role: 'agent', login: 'octo-agent' })).toMatchObject({ ok: false })
    expect(mocks.setSettings).not.toHaveBeenCalled()
    mocks.runFile.mockClear()
    await expect(connectGitHubAccount({ role: 'me', login: 'https://github.com/octocat' })).rejects.toThrow(/GitHub login/)
    await expect(connectGitHubAccount({ role: 'admin', login: 'octocat' })).rejects.toThrow(/role/)
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
})
