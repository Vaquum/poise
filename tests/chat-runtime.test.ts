import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_STDOUT } from './model-catalog-fixture'
import type { QuarantinedAgentLog } from '../server/agent'

const mocks = vi.hoisted(() => ({
  fetchAgentLogs: vi.fn(),
  fetchAgentLogWatermark: vi.fn(),
  fetchAgentLogsSince: vi.fn(),
  quarantined: [] as QuarantinedAgentLog[],
  runFile: vi.fn(),
  spawnDetached: vi.fn(),
  authStatus: 'authenticated',
  catalogStdout: '',
  requireAuth: vi.fn(),
  observeAuthFailure: vi.fn(),
}))

vi.mock('../server/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('../server/agent')>(),
  fetchAgentLogs: mocks.fetchAgentLogs,
  fetchRunningAgentLogs: mocks.fetchAgentLogs,
  fetchAgentLogWatermark: mocks.fetchAgentLogWatermark,
  fetchAgentLogsSince: async (...args: unknown[]) => ({ entries: await mocks.fetchAgentLogsSince(...args), quarantined: mocks.quarantined }),
  fetchAgentLogSnapshot: async () => ({ entries: await mocks.fetchAgentLogs(), quarantined: mocks.quarantined }),
  fetchRunningAgentLogSnapshot: async () => ({ entries: await mocks.fetchAgentLogs(), quarantined: mocks.quarantined }),
  fetchAgentResponse: vi.fn(),
}))
vi.mock('../server/process', () => ({
  MAX_PROCESS_ARG_BYTES: 64 * 1024,
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
  claudeSubscriptionEnvironment: () => ({
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CLI: '/poise/claude-subscription',
  }),
}))
vi.mock('../server/claude-auth', () => ({
  claudeAuth: {
    snapshot: () => ({ status: mocks.authStatus }),
    requireReady: mocks.requireAuth,
    observeProcessFailure: mocks.observeAuthFailure,
  },
}))

let root = ''
let database: typeof import('../server/db') | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-runtime-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  mocks.fetchAgentLogs.mockReset().mockResolvedValue([])
  mocks.fetchAgentLogWatermark.mockReset().mockResolvedValue('42')
  mocks.fetchAgentLogsSince.mockReset().mockResolvedValue([])
  mocks.quarantined = []
  mocks.catalogStdout = CATALOG_STDOUT
  mocks.runFile.mockReset().mockImplementation(async (command: string, args: string[]) => {
    if (command === 'agent-interface' && args[0] === '--models') return { stdout: mocks.catalogStdout, stderr: '' }
    throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
  })
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  mocks.authStatus = 'authenticated'
  mocks.requireAuth.mockReset().mockImplementation(() => {
    if (mocks.authStatus !== 'authenticated') throw new Error('Claude authentication required')
  })
  mocks.observeAuthFailure.mockReset()
  vi.resetModules()
})

afterEach(async () => {
  if (database?.db.open) database.closeDatabase()
  database = null
  for (const key of [
    'POISE_DB',
    'POISE_EDITOR_DIR',
    'AGENT_INTERFACE_ROOT',
  ]) delete process.env[key]
  vi.restoreAllMocks()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

describe('chat runtime hardening', () => {
  it('passes the admitted Codex launcher through debate workers', async () => {
    const providers = await import('../server/provider-clis')
    vi.mocked(providers.prepareModelClis).mockResolvedValueOnce({ CODEX_CLI: '/verified/codex.js' })
    const chat = await import('../server/chat')
    database = await import('../server/db')
    mocks.runFile.mockImplementation(async (_command, args) => ({ stdout: args[0] === '--models'
      ? mocks.catalogStdout : JSON.stringify({ response: JSON.stringify({ synthesis: 'Comparison', rounds: [] }) }), stderr: '' }))
    await chat.runDebate('Compare the providers')
    expect(mocks.runFile.mock.calls.find(call => call[1][0] === '--debate')?.[2].env).toMatchObject({ CODEX_CLI: '/verified/codex.js' })
  })

  it('keeps chat history available when unrelated review logs are malformed', async () => {
    const chat = await import('../server/chat')
    database = await import('../server/db')
    mocks.fetchAgentLogs.mockResolvedValue([{
      id: 'a'.repeat(32), behavior: 'chat', session_id: 'session',
      prompt: 'hello', status: 'completed',
    }])
    mocks.quarantined = ['pr_review', 'issue_review'].map((behavior, index) => ({
      index, error: 'invalid review result', id: null, correlationId: null,
      repo: 'owner/repo', prId: '12', behavior, sessionId: null,
    }))

    await expect(chat.listChatHistory('session')).resolves.toMatchObject([{ prompt: 'hello' }])
    expect(mocks.fetchAgentLogs).toHaveBeenCalledOnce()
  })

  it.each(['chat', 'author_content', null])('holds chat history for potentially matching %s corruption', async (behavior) => {
    const chat = await import('../server/chat')
    database = await import('../server/db')
    mocks.quarantined = [{
      index: 0, error: 'invalid transcript result', id: null, correlationId: null,
      repo: null, prId: null, behavior, sessionId: null,
    }]
    await expect(chat.listChatHistory('session')).rejects.toThrow('invalid transcript result')
  })

  it('rejects conflicting call identities even when malformed review routing contradicts the transcript', async () => {
    const chat = await import('../server/chat')
    database = await import('../server/db')
    mocks.fetchAgentLogs.mockResolvedValue([{
      id: 'a'.repeat(32), behavior: 'chat', session_id: 'session',
      prompt: 'hello', status: 'completed',
    }])
    mocks.quarantined = [{
      index: 0, error: 'duplicate corrupt result', id: 'a'.repeat(32), correlationId: null,
      repo: 'owner/repo', prId: '12', behavior: 'pr_review', sessionId: null,
    }]
    await expect(chat.listChatHistory('session')).rejects.toThrow('duplicate corrupt result')
  })

  it('runs a debate with no Claude participants while Claude is signed out', async () => {
    const catalog = JSON.parse(CATALOG_STDOUT)
    catalog.behaviors.debate_moderator = 'gpt-6-astra-ultra'
    catalog.debate_participants = ['gpt-6-astra-ultra', 'grok-4.6-xhigh']
    mocks.catalogStdout = JSON.stringify(catalog)
    mocks.authStatus = 'reauth_required'
    const result = { synthesis: 'Provider comparison', rounds: [] }
    mocks.runFile.mockImplementation(async (_command, args) => ({
      stdout: args[0] === '--models'
        ? mocks.catalogStdout
        : JSON.stringify({ response: JSON.stringify(result) }),
      stderr: '',
    }))
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.runDebate('Compare providers')).resolves.toEqual(result)

    expect(mocks.requireAuth).not.toHaveBeenCalled()
    expect(mocks.runFile).toHaveBeenCalledWith('agent-interface', ['--debate', 'Compare providers', '--rounds', '1'], expect.any(Object))
  })

  it.each(['moderator', 'participant'])('keeps a debate gated when its %s requires Claude', async (role) => {
    const catalog = JSON.parse(CATALOG_STDOUT)
    catalog.behaviors.debate_moderator = role === 'moderator' ? 'opus-5-max' : 'gpt-6-astra-ultra'
    catalog.debate_participants = role === 'participant' ? ['opus-5-max'] : ['grok-4.6-xhigh']
    mocks.catalogStdout = JSON.stringify(catalog)
    mocks.authStatus = 'reauth_required'
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.runDebate('Compare providers')).rejects.toThrow(/Claude authentication required/)

    expect(mocks.requireAuth).toHaveBeenCalledOnce()
    expect(mocks.runFile).toHaveBeenCalledOnce()
    expect(mocks.runFile.mock.calls[0][1]).toEqual(['--models'])
  })

  it('never reports a debate failure to the Claude gate, unattributable across providers', async () => {
    const failure = new Error('401 invalid API key')
    // The CLI-maintenance preflight reads the catalogue first; fail the debate itself.
    mocks.runFile.mockImplementation(async (_command, args) => {
      if (args[0] === '--models') return { stdout: mocks.catalogStdout, stderr: '' }
      throw failure
    })
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.runDebate('Compare the providers')).rejects.toBe(failure)

    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
  })

  it('strips the legacy context wrapper so the import quotes what the person wrote', async () => {
    const chat = await import('../server/chat')
    database = await import('../server/db')
    mocks.fetchAgentLogs.mockResolvedValue([{
      id: 'a'.repeat(32),
      behavior: 'chat',
      session_id: 'editor-brief-123',
      prompt: '[Poise context file v1]\nRead the complete UTF-8 context file ".poise-context/request-1.md" under your working directory before answering. Do not modify it.\n\n[User\'s message:]\nReview this draft.',
      started_at: '2026-07-14T10:00:00.000Z',
      status: 'completed',
      response: 'abcd1234',
      error: '',
    }])
    await expect(chat.listChatHistory('editor-brief-123')).resolves.toMatchObject([
      { prompt: 'Review this draft.' },
    ])
  })

  it('returns typed size failures before spawning oversized direct arguments', async () => {
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.runDebate('x'.repeat(64 * 1024 + 1)))
      .rejects.toMatchObject({ statusCode: 413 })
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it.each(['direct', 'durable'])('discovers %s non-Claude content completed before its first poll while Claude is signed out', async (path) => {
    const catalog = JSON.parse(CATALOG_STDOUT)
    catalog.behaviors.author_content = 'gpt-6-astra-ultra'
    mocks.catalogStdout = JSON.stringify(catalog)
    mocks.authStatus = 'reauth_required'
    const callId = 'a'.repeat(32)
    mocks.fetchAgentLogsSince.mockResolvedValueOnce([{
      id: callId,
      behavior: 'author_content',
      session_id: 'content-session',
      prompt: 'Independent article',
      started_at: new Date().toISOString(),
      status: 'completed',
    }])
    const chat = await import('../server/chat')
    database = await import('../server/db')
    const jobs = await import('../server/content-jobs')

    const result = path === 'direct'
      ? chat.startAuthorContent('Independent article', 'content-session')
      : jobs.launchAndEnqueueContentJob('Independent article', 'content-session')
    await expect(result).resolves.toMatchObject({ call_id: callId })

    expect(mocks.requireAuth).not.toHaveBeenCalled()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.fetchAgentLogWatermark).toHaveBeenCalledOnce()
    expect(mocks.fetchAgentLogsSince).toHaveBeenCalledWith('42', { session: 'content-session', behavior: 'author_content', prompt: 'Independent article' }, { fresh: true })
    if (path === 'durable') expect(jobs.getContentJobResponse(callId)).toMatchObject({ status: 'pending' })
  })

  it.each(['direct', 'durable'])('keeps %s Claude content gated before launch', async (path) => {
    mocks.authStatus = 'reauth_required'
    const chat = await import('../server/chat')
    database = await import('../server/db')
    const jobs = await import('../server/content-jobs')

    const result = path === 'direct'
      ? chat.startAuthorContent('Claude article', 'content-session')
      : jobs.launchAndEnqueueContentJob('Claude article', 'content-session')
    await expect(result).rejects.toThrow(/Claude authentication required/)

    expect(mocks.requireAuth).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(mocks.fetchAgentLogs).not.toHaveBeenCalled()
    expect(database.db.prepare('SELECT count(*) AS count FROM content_launches').get()).toEqual({ count: 0 })
  })

  it('retains ambiguous terminal launch candidates instead of choosing one', async () => {
    mocks.fetchAgentLogsSince.mockResolvedValue(['a', 'b'].map(letter => ({
      id: letter.repeat(32), behavior: 'author_content', session_id: 'ambiguous-session',
      prompt: 'Same topic', started_at: new Date().toISOString(), status: 'completed',
    })))
    const chat = await import('../server/chat')
    database = await import('../server/db')
    await expect(chat.startAuthorContent('Same topic', 'ambiguous-session')).rejects.toMatchObject({
      code: 'AUTHOR_CONTENT_DISCOVERY_TIMEOUT',
      message: 'multiple matching author-content calls registered; correlation remains pending',
    })
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('marks a post-spawn log lookup failure as recoverable discovery state', async () => {
    const lookupError = new Error('agent logs temporarily unavailable')
    mocks.fetchAgentLogsSince.mockRejectedValueOnce(lookupError)
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.startAuthorContent('Durable topic', 'durable-session'))
      .rejects.toMatchObject({
        name: 'AuthorContentDiscoveryUnavailableError',
        code: 'AUTHOR_CONTENT_DISCOVERY_UNAVAILABLE',
        cause: lookupError,
      })
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.fetchAgentLogWatermark).toHaveBeenCalledOnce()
    expect(mocks.fetchAgentLogsSince).toHaveBeenCalledOnce()
    expect(mocks.requireAuth).toHaveBeenCalledTimes(2)
  })

  it('keeps a pre-spawn log lookup failure definite', async () => {
    const lookupError = new Error('initial agent logs unavailable')
    mocks.fetchAgentLogWatermark.mockRejectedValueOnce(lookupError)
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.startAuthorContent('Definite topic', 'definite-session'))
      .rejects.toBe(lookupError)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('keeps a rejected spawn definite without entering discovery', async () => {
    const spawnError = new Error('agent-interface executable missing')
    mocks.spawnDetached.mockRejectedValueOnce(spawnError)
    const chat = await import('../server/chat')
    database = await import('../server/db')

    await expect(chat.startAuthorContent('Definite topic', 'definite-session'))
      .rejects.toBe(spawnError)
    expect(mocks.fetchAgentLogWatermark).toHaveBeenCalledOnce()
    expect(mocks.fetchAgentLogsSince).not.toHaveBeenCalled()
  })
})
