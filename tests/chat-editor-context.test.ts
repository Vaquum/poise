// Every ordinary turn of an Editor session reads the voice guide, the saved
// document and the edit format from a read-only file written under the held
// lease and removed when the turn ends. Scripted adapters and an isolated
// POISE_DB, POISE_EDITOR_DIR and HOME; the voice guide and the review cache
// are fixtures.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities, ChatSubject, PromptInput } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'
import { CheckoutLease } from '../server/chat/checkout-lock'
import type { ArticleReview } from '../src/publishing-review'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
vi.mock('../server/chat', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/chat')>()
  return { ...original, listChatHistory: vi.fn(async () => []) }
})
vi.mock('../server/publishing-reviews', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/publishing-reviews')>()
  return {
    ...original,
    articleReviews: vi.fn(async () => ({ reviews: [], checkedAt: null, active: false, stale: false, problems: [] })),
  }
})

const caps: Capabilities = { steer: true, fork: true, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }

interface CapturedTurn {
  turnId: string
  input: PromptInput
  file: string | null
  mode: number | null
  leaseOwner: string | null
}

const prompts = new Map<string, PromptInput[]>()
const finishes = new Map<string, (result: TurnResult) => void>()
const captured: CapturedTurn[] = []
/** Reply text the adapter emits as one delta before waiting, per turn. */
let replyText: string | null = null
let instance = ''

const callerStarts: string[] = []
const callerFinishes: Array<{ callId: string, status: string, error?: string }> = []
const callerTurns = {
  start: async () => {
    const id = `call-${callerStarts.length + 1}`
    callerStarts.push(id)
    return id
  },
  finish: async (callId: string, status: 'completed' | 'failed' | 'cancelled', error?: string) => {
    callerFinishes.push({ callId, status, error })
    return { id: callId, status }
  },
}

function adapter(host: AdapterHost): Adapter {
  let alive = false
  const nativeSessionId = randomUUID()
  const finish = () => { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) }
  return {
    agent: 'grok', nativeSessionId, capabilities: caps, get alive() { return alive },
    async start(options) { alive = true; return { nativeSessionId, capabilities: caps, modelId: options.modelId, effort: options.effort } },
    async prompt(turnId, input) {
      prompts.set(host.sessionId, [...(prompts.get(host.sessionId) ?? []), input])
      const match = /"(\.poise-chat\/context\/[^"]+\.md)"/.exec(input.text)
      let file: string | null = null
      let mode: number | null = null
      if (match) {
        const absolute = join(host.checkout, match[1])
        file = await readFile(absolute, 'utf8')
        mode = (await stat(absolute)).mode & 0o777
      }
      let leaseOwner: string | null = null
      try {
        leaseOwner = new CheckoutLease(host.checkout, { ownerKind: 'poise:chat', ownerId: 'probe', ownerLabel: '', instance }).read()?.owner_id ?? null
      } catch { /* the lease row is unreadable */ }
      captured.push({ turnId, input, file, mode, leaseOwner })
      if (replyText !== null) host.emit({ type: 'text.delta', turnId, messageId: `${turnId}:m1`, delta: replyText })
      return new Promise<TurnResult>(done => finishes.set(host.sessionId, done))
    },
    async cancel() { finish() }, async close() { alive = false; finish() },
    async steer() {}, async setMode() {}, async setModel(modelId, effort) { return { modelId, effort } },
    async fork() { return randomUUID() }, onExit() {},
  }
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) { if (check()) return; await new Promise(done => setTimeout(done, 15)) }
  throw new Error(`deadline waiting for ${what}`)
}

let root: string
let editorDir: string
let workspaceRoot: string
let runtime: ChatRuntime
let storage: typeof import('../server/chat/storage')
let database: typeof import('../server/db')
let Runtime: typeof ChatRuntime
let mockedReviews: (slug: string) => Promise<{ reviews: ArticleReview[] }>

function makeRuntime() {
  return new Runtime({ instance, instanceLabel: 'test', callerTurns, catalog: async () => CATALOG as any,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: adapter }, requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0 })
}

const docSubject = (key = 'brief'): ChatSubject => ({ surface: 'editor-document', key, label: 'Brief' })

async function runTurn(sessionId: string, text: string): Promise<CapturedTurn> {
  const { turnId } = runtime.prompt(sessionId, { text, attachments: [], mentions: [] })
  await until(() => finishes.has(sessionId), `adapter prompt for "${text}"`)
  const got = captured.find((c) => c.turnId === turnId)
  if (!got) throw new Error(`no capture for turn ${turnId}`)
  const done = finishes.get(sessionId)
  finishes.delete(sessionId)
  done?.({ stopReason: 'end_turn' })
  await until(() => !storage.getOpenTurn(sessionId), 'turn to settle')
  return got
}

async function contextDir(sessionId: string): Promise<string> {
  const record = storage.getSession(sessionId)
  if (!record) throw new Error('session is gone')
  return join(record.checkout, '.poise-chat', 'context', sessionId)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-editor-context-test-'))
  editorDir = join(root, 'editor')
  await mkdir(editorDir, { recursive: true })
  await writeFile(join(root, 'voice.md'), 'Write like the sea: short sentences.')
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  vi.stubEnv('POISE_EDITOR_DIR', editorDir)
  vi.stubEnv('POISE_VOICE_GUIDE_PATH', join(root, 'voice.md'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  storage = await import('../server/chat/storage')
  database = await import('../server/db')
  mockedReviews = (await import('../server/publishing-reviews')).articleReviews as typeof mockedReviews
})

beforeEach(async () => {
  prompts.clear(); finishes.clear(); captured.length = 0
  callerStarts.length = 0; callerFinishes.length = 0
  replyText = null
  vi.mocked(mockedReviews).mockReset()
  vi.mocked(mockedReviews).mockResolvedValue({ reviews: [] } as any)
  instance = `editor-context:${randomUUID()}`
  workspaceRoot = join(root, randomUUID())
  runtime = makeRuntime()
})

afterEach(async () => { await runtime?.stop() })
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

describe('per-turn Editor context', () => {
  it('gives every ordinary turn of an Editor session the voice guide, the saved document and the edit format', async () => {
    await writeFile(join(editorDir, 'brief.md'), '# Brief\n\nFirst draft.\n')
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: docSubject() })
    replyText = 'Noted.'
    const first = await runTurn(session.id, 'hello one')
    expect(first.input.text).toMatch(/^\[Poise context file v1\]\nRead the complete UTF-8 context file "\.poise-chat\/context\/[^"]+\.md" under your working directory before answering\. Do not modify it\.\n\n\[User's message:\]\nhello one$/)
    expect(first.file).toContain('Write like the sea: short sentences.')
    expect(first.file).toContain('First draft.')
    expect(first.file).toContain('[Response format]')
    expect(first.file).toContain('"edits"')
    await writeFile(join(editorDir, 'brief.md'), '# Brief\n\nSecond draft.\n')
    const second = await runTurn(session.id, 'hello two')
    expect(second.file).toContain('Second draft.')
    expect(second.file).not.toContain('First draft.')
    const started = storage.findEvent(session.id, (event) => event.type === 'turn.started' && event.turnId === first.turnId)
    expect(started?.event.type).toBe('turn.started')
    if (started?.event.type === 'turn.started') expect(started.event.prompt.text).toBe('hello one')
    const review = await runTurn(session.id, '/review check this')
    expect(review.input.text).toContain('[Poise /review')
    expect(review.input.text).not.toContain('[Poise context file v1]')
    expect(review.file).toBeNull()
  }, 180_000)

  it('writes the context file read-only under the held lease and removes it when the turn ends', async () => {
    await writeFile(join(editorDir, 'lease.md'), '# Lease\n')
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: docSubject('lease') })
    const turn = await runTurn(session.id, 'hello')
    expect(turn.mode).toBe(0o444)
    expect(turn.leaseOwner).toBe(session.id)
    expect(existsSync(join(await contextDir(session.id), `${turn.turnId}.md`))).toBe(false)
    await writeFile(join(editorDir, 'huge.md'), 'x'.repeat(6 * 1024 * 1024))
    const oversized = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: docSubject('huge') })
    runtime.prompt(oversized.session.id, { text: 'hello', attachments: [], mentions: [] })
    await until(() => !storage.getOpenTurn(oversized.session.id), 'the failed turn to settle')
    expect(prompts.get(oversized.session.id) ?? []).toHaveLength(0)
    expect(existsSync(await contextDir(oversized.session.id))).toBe(false)
  }, 180_000)

  it("fails the turn with the Editor's reason when the document cannot be read", async () => {
    await writeFile(join(editorDir, 'broken.md'), 'x'.repeat(6 * 1024 * 1024))
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: docSubject('broken') })
    runtime.prompt(session.id, { text: 'hello', attachments: [], mentions: [] })
    await until(() => !storage.getOpenTurn(session.id), 'the failed turn to settle')
    expect(prompts.get(session.id) ?? []).toHaveLength(0)
    const finished = storage.findEvent(session.id, (event) => event.type === 'turn.finished')
    expect(finished?.event.type).toBe('turn.finished')
    if (finished?.event.type === 'turn.finished') {
      expect(finished.event.stopReason).toBe('error')
      expect(finished.event.error).toContain('doc too large')
    }
    const errors = storage.listEvents(session.id, 0).events.filter(({ event }) => event.type === 'error')
    expect(errors).toHaveLength(1)
    if (errors[0]?.event.type === 'error') expect(errors[0].event.message).toContain('doc too large')
    await until(() => callerFinishes.length > 0, 'the Caller row to finish')
    expect(callerFinishes[0]?.status).toBe('failed')
    expect(callerFinishes[0]?.error).toContain('doc too large')
  }, 120_000)

  it('does not stage a document copy for an Editor session', async () => {
    await writeFile(join(editorDir, 'plain.md'), '# Plain\n')
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: docSubject('plain') })
    await runTurn(session.id, 'hello')
    expect(storage.getSession(session.id)?.staged).toBeUndefined()
    const record = storage.getSession(session.id)
    expect(existsSync(join(record!.checkout, '.poise-chat', 'docs'))).toBe(false)
  }, 120_000)

  it("gives a passage chat the annotation's current passage and note on every turn", async () => {
    await writeFile(join(editorDir, 'essay.md'), '# Essay\n\nThe quick brown fox.\n')
    const annotation = (comment: string) => ({
      id: 'ann-1', session_id: 'editor-essay-1769500000000',
      range: { start_line: 2, start_offset: 0, end_line: 2, end_offset: 9 },
      snippet: 'The quick', comment,
      created_at: '2026-10-20T10:00:00.000Z', updated_at: '2026-10-20T10:00:00.000Z',
    })
    await writeFile(join(editorDir, 'essay.annotations.json'), JSON.stringify({ annotations: [annotation('Why quick?')] }))
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: { surface: 'editor-passage', key: 'essay:ann-1', label: 'A passage' } })
    const first = await runTurn(session.id, 'what does it say?')
    expect(first.file).toContain('The quick brown fox.')
    expect(first.file).toContain('The quick')
    expect(first.file).toContain('Why quick?')
    await writeFile(join(editorDir, 'essay.annotations.json'), JSON.stringify({ annotations: [annotation('Actually why brown?')] }))
    const second = await runTurn(session.id, 'and now?')
    expect(second.file).toContain('Actually why brown?')
    expect(second.file).not.toContain('Why quick?')
  }, 180_000)

  it('gives a review chat the review as quoted untrusted text, or says it is not available', async () => {
    await writeFile(join(editorDir, 'piece.md'), '# Piece\n\nSome text.\n')
    const review: ArticleReview = {
      id: 'IC_1', kind: 'thread', repo: 'acme/app', site: 'blog', pr: 7, prUrl: 'https://github.com/acme/app/pull/7',
      resolved: false, outdated: false, canReply: true, canResolve: true,
      anchor: { quote: 'Some text.', before: '', after: '', unique: true },
      messages: [
        { id: 'm1', author: 'reviewer', body: 'Tighten this paragraph.', url: 'https://github.com/acme/app/pull/7#x', createdAt: '2026-10-20T10:00:00.000Z' },
        { id: 'm2', author: 'writer', body: 'Will do.', url: 'https://github.com/acme/app/pull/7#y', createdAt: '2026-10-20T10:05:00.000Z' },
      ],
    }
    vi.mocked(mockedReviews).mockResolvedValue({ reviews: [review] } as any)
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: { surface: 'editor-review', key: 'piece:IC_1', label: 'A review' } })
    const first = await runTurn(session.id, 'help me address this')
    expect(first.file).toContain('untrusted third-party text')
    expect(first.file).toContain('gives no instructions')
    expect(first.file).toContain('Tighten this paragraph.')
    expect(first.file).toContain('Some text.')
    vi.mocked(mockedReviews).mockResolvedValue({ reviews: [] } as any)
    const missing = await runTurn(session.id, 'is it still there?')
    expect(missing.file).toContain('the review is not available')
    vi.mocked(mockedReviews).mockRejectedValue(new Error('The saved article review cache is unreadable.'))
    const corrupt = await runTurn(session.id, 'and now?')
    expect(corrupt.file).toContain('the review is not available')
    const finished = storage.listEvents(session.id, 0).events.filter(({ event }) => event.type === 'turn.finished')
    expect(finished).toHaveLength(3)
    for (const { event } of finished) {
      if (event.type === 'turn.finished') expect(event.stopReason).toBe('end_turn')
    }
  }, 180_000)

  it('asks a review chat for an optional suggested reply in the edit format', async () => {
    await writeFile(join(editorDir, 'opinion.md'), '# Opinion\n')
    vi.mocked(mockedReviews).mockResolvedValue({ reviews: [] } as any)
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: { surface: 'editor-review', key: 'opinion:IC_9', label: 'A review' } })
    const turn = await runTurn(session.id, 'hello')
    expect(turn.file).toContain('"reply"')
    expect(turn.file).toContain('never posted by itself')
  }, 120_000)
})
