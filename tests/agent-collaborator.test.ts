import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  meta: new Map<string, string>(),
  orgs: [] as Array<{ login: string }>,
  repos: {} as Record<string, Array<{ full_name: string, archived?: boolean, disabled?: boolean, owner?: { login: string } }>>,
  collaboratorStatus: 201,
  invitations: [] as unknown[],
  acceptStatus: 204,
}))
vi.mock('../server/process', () => ({ runFile: mocks.runFile }))
vi.mock('../server/db', () => ({
  getMeta: (key: string) => mocks.meta.get(key) ?? null,
  setMeta: (key: string, value: string) => { mocks.meta.set(key, value) },
}))
vi.mock('../server/organizations', () => ({ readyOrganizations: () => mocks.orgs }))
import {
  reconcileAgentCollaborators, resetAgentCollaboratorFailures,
  startAgentCollaboratorRuntime, stopAgentCollaboratorRuntime,
} from '../server/agent-collaborator'

function http(status: number, body: unknown): string {
  const reason = status === 200 ? 'OK' : status === 201 ? 'Created' : status === 204 ? 'No Content' : status === 404 ? 'Not Found' : 'Error'
  return `HTTP/2.0 ${status} ${reason}\r\nContent-Type: application/json\r\n\r\n${body === null ? '' : JSON.stringify(body)}`
}

function invitation(id: number, owner: string, inviter: string) {
  return { id, repository: { full_name: `${owner}/site`, owner: { login: owner } }, inviter: { login: inviter } }
}

function calls(command: string, prefix?: string): string[][] {
  return mocks.runFile.mock.calls
    .filter(([name, args]) => name === command && (!prefix || args[1] === prefix || args[0] === prefix))
    .map(([, args]) => args)
}

beforeEach(() => {
  vi.useRealTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  resetAgentCollaboratorFailures()
  mocks.meta.clear()
  mocks.meta.set('me', 'octocat')
  mocks.meta.set('agentAccount', 'agent-x')
  mocks.orgs = [{ login: 'acme' }]
  mocks.repos = { acme: [{ full_name: 'acme/site', owner: { login: 'acme' } }] }
  mocks.collaboratorStatus = 201
  mocks.invitations = []
  mocks.acceptStatus = 204
  mocks.runFile.mockReset()
  mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'gh' && args[0] === 'auth') return { stdout: `${args[args.length - 1]}-token`, stderr: '' }
    if (command === 'github-interface') {
      return { stdout: JSON.stringify({ repos: mocks.repos[String(args[1]).toLowerCase()] ?? [] }), stderr: '' }
    }
    if (command === 'gh' && args[0] === 'api') {
      const endpoint = args[1]!
      if (endpoint.startsWith('user/repository_invitations?')) return { stdout: http(200, mocks.invitations), stderr: '' }
      if (endpoint.startsWith('user/repository_invitations/')) return { stdout: http(mocks.acceptStatus, null), stderr: '' }
      if (endpoint.includes('/collaborators/')) {
        return { stdout: http(mocks.collaboratorStatus, mocks.collaboratorStatus === 201 ? { id: 7 } : null), stderr: '' }
      }
    }
    throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
  })
})

afterEach(async () => {
  await stopAgentCollaboratorRuntime()
  vi.restoreAllMocks()
})

describe('reconcileAgentCollaborators', () => {
  it('invites the agent with push permission and records the confirmation', async () => {
    const result = await reconcileAgentCollaborators()
    expect(result).toEqual({ repos: 1, invited: ['acme/site'], accepted: [] })
    const invites = calls('gh').filter((args) => args[1].includes('/collaborators/'))
    expect(invites).toEqual([['api', 'repos/acme/site/collaborators/agent-x', '--method', 'PUT', '--include', '--field', 'permission=push']])
    const inviteCall = mocks.runFile.mock.calls.find(([, args]) => args[1]?.includes('/collaborators/'))
    expect(inviteCall?.[2].env).toMatchObject({ GH_HOST: 'github.com', GH_TOKEN: 'octocat-token' })
    expect(JSON.parse(mocks.meta.get('agent_collaborator_confirmed:acme')!)).toEqual(['acme/site'])
  })

  it('treats an existing collaborator as confirmed without a second write', async () => {
    mocks.collaboratorStatus = 204
    const result = await reconcileAgentCollaborators()
    expect(result.invited).toEqual(['acme/site'])
    mocks.runFile.mockClear()
    const again = await reconcileAgentCollaborators()
    expect(again.invited).toEqual([])
    expect(calls('gh').filter((args) => args[1]?.includes('/collaborators/'))).toEqual([])
  })

  it('skips archived and disabled repositories and prunes stale confirmations', async () => {
    mocks.repos = { acme: [
      { full_name: 'acme/site', owner: { login: 'acme' } },
      { full_name: 'acme/old', archived: true, owner: { login: 'acme' } },
      { full_name: 'acme/off', disabled: true, owner: { login: 'acme' } },
    ] }
    mocks.meta.set('agent_collaborator_confirmed:acme', JSON.stringify(['acme/site', 'acme/renamed-away']))
    const result = await reconcileAgentCollaborators()
    expect(result.invited).toEqual([])
    expect(calls('gh').filter((args) => args[1]?.includes('/collaborators/'))).toEqual([])
    expect(JSON.parse(mocks.meta.get('agent_collaborator_confirmed:acme')!)).toEqual(['acme/site'])
  })

  it('accepts only the person’s invitations under covered accounts and tolerates a vanished one', async () => {
    mocks.meta.set('agent_collaborator_confirmed:acme', JSON.stringify(['acme/site']))
    mocks.invitations = [
      invitation(11, 'acme', 'octocat'),
      invitation(12, 'acme', 'stranger'),
      invitation(13, 'elsewhere', 'octocat'),
      invitation(14, 'acme', 'octocat'),
    ]
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'auth') return { stdout: `${args[args.length - 1]}-token`, stderr: '' }
      if (command === 'github-interface') return { stdout: JSON.stringify({ repos: mocks.repos.acme }), stderr: '' }
      if (command === 'gh' && args[0] === 'api') {
        const endpoint = args[1]!
        if (endpoint.startsWith('user/repository_invitations?')) return { stdout: http(200, mocks.invitations), stderr: '' }
        if (endpoint === 'user/repository_invitations/14') return { stdout: http(404, { message: 'Not Found' }), stderr: '' }
        if (endpoint.startsWith('user/repository_invitations/')) return { stdout: http(204, null), stderr: '' }
      }
      throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
    })
    const result = await reconcileAgentCollaborators()
    expect(result.accepted).toEqual([11])
    const accepts = calls('gh').filter((args) => args[1]?.startsWith('user/repository_invitations/') && !args[1].includes('?'))
    expect(accepts.map((args) => args[1])).toEqual(['user/repository_invitations/11', 'user/repository_invitations/14'])
    const listCall = mocks.runFile.mock.calls.find(([, args]) => args[1]?.startsWith('user/repository_invitations?'))
    expect(listCall?.[2].env).toMatchObject({ GH_TOKEN: 'agent-x-token' })
  })

  it('stays inert while either account is missing, identical, or no account is ready', async () => {
    for (const setup of [
      () => mocks.meta.delete('me'),
      () => mocks.meta.delete('agentAccount'),
      () => mocks.meta.set('agentAccount', 'OctoCat'),
      () => { mocks.orgs = [] },
    ]) {
      mocks.meta.set('me', 'octocat')
      mocks.meta.set('agentAccount', 'agent-x')
      mocks.orgs = [{ login: 'acme' }]
      mocks.runFile.mockClear()
      setup()
      expect(await reconcileAgentCollaborators()).toEqual({ repos: 0, invited: [], accepted: [] })
      expect(mocks.runFile).not.toHaveBeenCalled()
    }
  })

  it('backs a failing invite off, keeps reconciling the rest, and retries after reset', async () => {
    mocks.repos = { acme: [
      { full_name: 'acme/denied', owner: { login: 'acme' } },
      { full_name: 'acme/site', owner: { login: 'acme' } },
    ] }
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'auth') return { stdout: `${args[args.length - 1]}-token`, stderr: '' }
      if (command === 'github-interface') return { stdout: JSON.stringify({ repos: mocks.repos.acme }), stderr: '' }
      if (command === 'gh' && args[0] === 'api') {
        const endpoint = args[1]!
        if (endpoint.startsWith('user/repository_invitations?')) return { stdout: http(200, []), stderr: '' }
        if (endpoint.includes('acme/denied')) {
          throw Object.assign(new Error('gh exited 1'), { code: 1, stdout: http(403, { message: 'octocat-token must be admin' }), stderr: '' })
        }
        if (endpoint.includes('/collaborators/')) return { stdout: http(201, { id: 7 }), stderr: '' }
      }
      throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
    })
    const result = await reconcileAgentCollaborators()
    expect(result.invited).toEqual(['acme/site'])
    expect(console.warn).toHaveBeenCalled()
    const warned = vi.mocked(console.warn).mock.calls.map((entry) => String(entry[0])).join('\n')
    expect(warned).toContain('***')
    expect(warned).not.toContain('octocat-token')
    mocks.runFile.mockClear()
    await reconcileAgentCollaborators()
    expect(calls('gh').filter((args) => args[1]?.includes('acme/denied'))).toEqual([])
    resetAgentCollaboratorFailures()
    mocks.runFile.mockClear()
    await reconcileAgentCollaborators()
    expect(calls('gh').filter((args) => args[1]?.includes('acme/denied'))).toHaveLength(1)
  })

  it('continues past an unreadable listing or invitation read', async () => {
    mocks.orgs = [{ login: 'acme' }, { login: 'beta' }]
    mocks.repos = { beta: [{ full_name: 'beta/site', owner: { login: 'beta' } }] }
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'auth') return { stdout: `${args[args.length - 1]}-token`, stderr: '' }
      if (command === 'github-interface' && String(args[1]).toLowerCase() === 'acme') throw new Error('no network')
      if (command === 'github-interface') return { stdout: JSON.stringify({ repos: mocks.repos.beta }), stderr: '' }
      if (command === 'gh' && args[0] === 'api') {
        const endpoint = args[1]!
        if (endpoint.startsWith('user/repository_invitations?')) throw new Error('no network')
        if (endpoint.includes('/collaborators/')) return { stdout: http(201, { id: 7 }), stderr: '' }
      }
      throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
    })
    const result = await reconcileAgentCollaborators()
    expect(result).toEqual({ repos: 1, invited: ['beta/site'], accepted: [] })
  })

  it('re-verifies every repository when the confirmed set is unreadable', async () => {
    mocks.meta.set('agent_collaborator_confirmed:acme', 'not json')
    const result = await reconcileAgentCollaborators()
    expect(result.invited).toEqual(['acme/site'])
    expect(JSON.parse(mocks.meta.get('agent_collaborator_confirmed:acme')!)).toEqual(['acme/site'])
  })

  it('waits for sign-in when a token is unavailable instead of failing', async () => {
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'auth') throw new Error('no credential')
      if (command === 'github-interface') return { stdout: JSON.stringify({ repos: mocks.repos.acme }), stderr: '' }
      throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
    })
    const result = await reconcileAgentCollaborators()
    expect(result).toEqual({ repos: 1, invited: [], accepted: [] })
    expect(mocks.meta.get('agent_collaborator_confirmed:acme')).toBe(JSON.stringify([]))
  })

  it('rejects a listing that names repositories outside the account', async () => {
    mocks.repos = { acme: [{ full_name: 'elsewhere/site', owner: { login: 'elsewhere' } }] }
    const result = await reconcileAgentCollaborators()
    expect(result).toEqual({ repos: 0, invited: [], accepted: [] })
    expect(calls('gh').filter((args) => args[1]?.includes('/collaborators/'))).toEqual([])
  })
})

describe('agent collaborator runtime', () => {
  it('passes on start and on the interval until stopped', async () => {
    vi.useFakeTimers()
    startAgentCollaboratorRuntime()
    startAgentCollaboratorRuntime()
    await vi.advanceTimersByTimeAsync(61_000)
    const listed = () => calls('github-interface').length
    expect(listed()).toBe(2)
    await stopAgentCollaboratorRuntime()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(listed()).toBe(2)
    vi.useRealTimers()
  })
})
