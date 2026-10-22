import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CATALOG } from '../model-catalog-fixture'
import type { ChatRuntime } from '../../server/chat/runtime'
import type { ChatEvent } from '../../server/chat/protocol'
import type { Adapter, TurnResult } from '../../server/chat/adapters/types'
import { ensureLocalWorkspace } from '../../server/chat/local-workspace'

let root: string, outer: string, Runtime: typeof ChatRuntime, runtime: ChatRuntime
const resolveCheckout = vi.fn(async () => { throw new Error('must not look up a repository') })
function git(...args: string[]): string { return execFileSync('git', args, { cwd: outer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!check()) { if (Date.now() > deadline) throw new Error('local session deadline'); await new Promise(r => setTimeout(r, 25)) }
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-local-chat-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.db'))
  vi.stubEnv('POISE_EDITOR_DIR', join(root, 'editor'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../../server/chat/runtime'))
})
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
afterEach(async () => { await runtime?.stop() })
function fakeAdapter(): Adapter {
  let alive = false
  let finish: ((result: TurnResult) => void) | undefined
  const cancel = () => { finish?.({ stopReason: 'cancelled' }); finish = undefined }
  const capabilities = { steer: true, fork: true, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
  return { agent: 'grok', nativeSessionId: randomUUID(), capabilities, get alive() { return alive },
    async start(options) { alive = true; return { nativeSessionId: randomUUID(), capabilities, modelId: options.modelId, effort: options.effort } },
    async prompt() { return new Promise<TurnResult>(resolve => { finish = resolve }) },
    async cancel() { cancel() }, async close() { alive = false; cancel() }, async steer() {}, async setMode() {},
    async setModel(modelId, effort) { return { modelId, effort } }, async fork() { return randomUUID() }, onExit() {},
  }
}
beforeEach(async () => {
  outer = join(root, randomUUID()); await mkdir(outer)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null')
  await writeFile(join(outer, '.gitignore'), '/.poise-chat/\n')
  await writeFile(join(outer, 'source.ts'), 'original\n')
  git('add', '.gitignore', 'source.ts'); git('commit', '-qm', 'fixture')
  await writeFile(join(outer, 'source.ts'), 'uncommitted user work\n')
  resolveCheckout.mockClear()
  runtime = new Runtime({ instance: randomUUID(), instanceLabel: 'test', callerTurns: null,
    catalog: async () => CATALOG, resolveCheckout, localWorkspaceRoot: join(outer, '.poise-chat'),
    idleTimeoutMinutes: () => 0, adapters: { grok: fakeAdapter }, probeAgent: async () => ({ ok: true }) })
})
describe('Poise-local session storage', () => {
  it('does not look up a repository or touch the outer branch, index or dirty files', async () => {
    const head = git('rev-parse', 'HEAD'), status = git('status', '--porcelain'), index = git('diff', '--cached')
    const record = await runtime.create({ agent: 'grok', model: 'grok-4.6-high' })
    await until(() => runtime.get(record.id)?.status === 'idle')
    expect(record).toMatchObject({ repo: '', workspaceKind: 'poise-local' })
    expect(record.checkout).toContain('/.poise-chat/workers/')
    expect(resolveCheckout).not.toHaveBeenCalled()
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('branch', '--show-current')).toBe('main')
    expect(git('status', '--porcelain')).toBe(status)
    expect(git('diff', '--cached')).toBe(index)
    expect(await readFile(join(outer, 'source.ts'), 'utf8')).toBe('uncommitted user work\n')
    expect(git('check-ignore', '.poise-chat/workspace')).toBe('.poise-chat/workspace')
  }, 30_000)

  it('records the catalogue identity matching the selected effort', async () => {
    const record = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', effort: 'xhigh' })
    await until(() => runtime.get(record.id)?.status === 'idle')
    expect(record).toMatchObject({ model: 'grok-4.6-xhigh', effort: 'xhigh' })
    await expect(runtime.create({ agent: 'grok', model: 'grok-4.6-high', effort: 'max' })).rejects.toMatchObject({ code: 'invalid' })
  }, 30_000)

  it('refuses symlinked local storage instead of writing elsewhere', async () => {
    const outside = join(root, randomUUID()); await mkdir(outside)
    await symlink(outside, join(outer, '.poise-chat'))
    await expect(ensureLocalWorkspace(join(outer, '.poise-chat'))).rejects.toThrow(/plain directory/)
    expect(await readdir(outside)).toEqual([])
  })
  it('runs a second session while the first holds a turn, on its own workspace and lease', async () => {
    const first = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'First' })
    await until(() => runtime.get(first.id)?.status === 'idle')
    runtime.prompt(first.id, { text: 'hold this turn', attachments: [], mentions: [] })
    await until(() => runtime.get(first.id)?.status === 'running')
    const second = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'Second' })
    await until(() => runtime.get(second.id)?.status === 'idle')
    runtime.prompt(second.id, { text: 'work too', attachments: [], mentions: [] })
    await until(() => runtime.get(second.id)?.status === 'running')
    expect(runtime.get(first.id)?.status).toBe('running')
    expect(second.checkout).not.toBe(first.checkout)
    expect(second.branch.name).not.toBe(first.branch.name)
    const { CheckoutLease, checkoutLockPath } = await import('../../server/chat/checkout-lock')
    expect(checkoutLockPath(second.checkout)).not.toBe(checkoutLockPath(first.checkout))
    const owner = (id: string) => ({ ownerKind: 'test', ownerId: id, ownerLabel: id, instance: 'test' })
    const firstRow = new CheckoutLease(first.checkout, owner('first')).read()
    const secondRow = new CheckoutLease(second.checkout, owner('second')).read()
    expect(firstRow?.checkout).toBe(first.checkout)
    expect(secondRow?.checkout).toBe(second.checkout)
    expect(secondRow?.token).not.toBe(firstRow?.token)
    await runtime.cancel(first.id)
    await runtime.cancel(second.id)
    await until(() => runtime.get(second.id)?.status === 'idle')
    expect(git('branch', '--show-current')).toBe('main')
  }, 30_000)

  it('creates an isolated session through REST while another turn runs', async () => {
    const holding = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'Holding' })
    await until(() => runtime.get(holding.id)?.status === 'idle')
    runtime.prompt(holding.id, { text: 'hold this turn', attachments: [], mentions: [] })
    await until(() => runtime.get(holding.id)?.status === 'running')
    const { Readable } = await import('node:stream')
    const { handleChatApi } = await import('../../server/chat/transport')
    const req = Object.assign(Readable.from([JSON.stringify({ agent: 'grok', model: 'grok-4.6-high', title: 'Rest', repo: 'acme/evil', branch: { existing: 'main' }, path: '/tmp/evil' })]),
      { method: 'POST', headers: { 'content-type': 'application/json' } })
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }
    await handleChatApi(req as unknown as import('node:http').IncomingMessage, res as unknown as import('node:http').ServerResponse, '/api/chat/sessions', runtime)
    expect(res.statusCode).toBe(201)
    const created = JSON.parse(res.end.mock.calls[0][0]).session
    expect(created.repo).toBe('')
    expect(created.checkout).not.toBe(holding.checkout)
    await until(() => runtime.get(created.id)?.status === 'idle')
    runtime.prompt(created.id, { text: 'work too', attachments: [], mentions: [] })
    await until(() => runtime.get(created.id)?.status === 'running')
    expect(runtime.get(holding.id)?.status).toBe('running')
    await runtime.cancel(holding.id)
    await runtime.cancel(created.id)
  }, 30_000)

  it('keeps a fork in the source workspace and queues it behind the source turn', async () => {
    const source = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'Source' })
    await until(() => runtime.get(source.id)?.status === 'idle')
    const fork = await runtime.fork(source.id)
    await until(() => runtime.get(fork.id)?.status === 'idle')
    expect(fork.checkout).toBe(source.checkout)
    expect(fork.branch.name).toBe(source.branch.name)
    runtime.prompt(source.id, { text: 'hold this turn', attachments: [], mentions: [] })
    await until(() => runtime.get(source.id)?.status === 'running')
    runtime.prompt(fork.id, { text: 'work too', attachments: [], mentions: [] })
    await until(() => runtime.get(fork.id)?.status === 'queued')
    expect(runtime.get(fork.id)?.queuedBehind).toContain(`chat "hold this turn" on ${source.branch.name}`)
    await runtime.cancel(source.id)
    await until(() => runtime.get(fork.id)?.status === 'running')
    await runtime.cancel(fork.id)
    await until(() => runtime.get(fork.id)?.status === 'idle')
  }, 30_000)

  it('binds a handoff to the source checkout and serializes it with the source', async () => {
    const source = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'Origin' })
    await until(() => runtime.get(source.id)?.status === 'idle')
    await writeFile(join(source.checkout, 'hello.txt'), 'from the source\n')
    const handoff = await runtime.handoff(source.id, { agent: 'grok', model: 'grok-4.6-high' })
    expect(handoff.checkout).toBe(source.checkout)
    expect(handoff.branch.name).toBe(source.branch.name)
    await until(() => runtime.get(handoff.id)?.status === 'running')
    runtime.prompt(source.id, { text: 'after you', attachments: [], mentions: [] })
    await until(() => runtime.get(source.id)?.status === 'queued')
    expect(runtime.get(source.id)?.queuedBehind).toContain(handoff.branch.name)
    await runtime.cancel(handoff.id)
    await until(() => runtime.get(source.id)?.status === 'running')
    await runtime.cancel(source.id)
    await until(() => runtime.get(source.id)?.status === 'idle')
    await until(() => runtime.get(handoff.id)?.status === 'idle')
    // The handoff reads the source's files from the shared workspace.
    runtime.prompt(handoff.id, { text: 'read it', attachments: [], mentions: [{ path: 'hello.txt' }] })
    await until(() => runtime.get(handoff.id)?.status === 'running')
    await runtime.cancel(handoff.id)
  }, 30_000)

  it('resolves attachments, mentions and file listings per workspace', async () => {
    const a = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'A' })
    await until(() => runtime.get(a.id)?.status === 'idle')
    runtime.prompt(a.id, { text: 'hold this turn', attachments: [], mentions: [] })
    await until(() => runtime.get(a.id)?.status === 'running')
    const b = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'B' })
    await until(() => runtime.get(b.id)?.status === 'idle')
    // Uploading to B while A runs is immediate, not a 409.
    const attachment = await runtime.saveAttachment(b.id, 'note.txt', Buffer.from('for b'))
    expect(await readFile(join(b.checkout, attachment.path), 'utf8')).toBe('for b')
    await expect(stat(join(a.checkout, attachment.path))).rejects.toThrow()
    await writeFile(join(b.checkout, 'only-b.txt'), 'b\n')
    runtime.prompt(b.id, { text: 'use it', attachments: [{ id: attachment.id, name: attachment.name, path: attachment.path, size: attachment.size }], mentions: [{ path: 'only-b.txt' }] })
    await until(() => runtime.get(b.id)?.status === 'running')
    const { listFiles } = await import('../../server/chat/transport')
    expect(await listFiles(b.checkout, '')).toContain('only-b.txt')
    expect(await listFiles(a.checkout, '')).not.toContain('only-b.txt')
    await runtime.cancel(b.id)
    await until(() => runtime.get(b.id)?.status === 'idle')
    await runtime.cancel(a.id)
    await until(() => runtime.get(a.id)?.status === 'idle')
    // A's turn cannot resolve B's file.
    const { turnId } = runtime.prompt(a.id, { text: 'find it', attachments: [], mentions: [{ path: 'only-b.txt' }] }) as { turnId: string }
    await until(() => runtime.events(a.id, 0).events.some((e) => e.event.type === 'turn.finished' && e.event.turnId === turnId && e.event.stopReason === 'error'))
    const finished = runtime.events(a.id, 0).events.map((e) => e.event)
      .find((e): e is Extract<ChatEvent, { type: 'turn.finished' }> => e.type === 'turn.finished' && e.turnId === turnId)
    expect(finished?.error).toContain('not a file in the checkout')
  }, 30_000)

  it('stages Editor documents inside each session workspace', async () => {
    const editor = await import('../../server/editor')
    const slug = 'iso-doc'
    await editor.writeDoc(slug, '# Iso\n')
    const a = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'A' })
    await until(() => runtime.get(a.id)?.status === 'idle')
    const b = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'B', context: { kind: 'document', title: 'Iso', slug } })
    await until(() => runtime.get(b.id)?.status === 'idle')
    const stagedPath = runtime.get(b.id)?.staged?.path
    expect(stagedPath).toBe(`.poise-chat/docs/${b.id}/${slug}.md`)
    expect(await readFile(join(b.checkout, stagedPath!), 'utf8')).toContain('# Iso')
    await expect(stat(join(a.checkout, stagedPath!))).rejects.toThrow()
  }, 30_000)

  it('removes a clean unmoved workspace on delete, keeps the lock file, leaves the other session alone', async () => {
    const a = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'A' })
    await until(() => runtime.get(a.id)?.status === 'idle')
    const b = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'B' })
    await until(() => runtime.get(b.id)?.status === 'idle')
    const { checkoutLockPath } = await import('../../server/chat/checkout-lock')
    const lock = checkoutLockPath(b.checkout)
    const { workspaceRemoved } = await runtime.delete(b.id)
    expect(workspaceRemoved).toBe(true)
    await expect(stat(b.checkout)).rejects.toThrow()
    await expect(stat(dirname(b.checkout))).rejects.toThrow()
    await expect(stat(lock)).resolves.toBeDefined()
    expect((await stat(a.checkout)).isDirectory()).toBe(true)
    expect(runtime.get(a.id)?.title).toBe('A')
  }, 30_000)

  it('keeps a workspace with uncommitted work and never discards it', async () => {
    const b = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'B' })
    await until(() => runtime.get(b.id)?.status === 'idle')
    await writeFile(join(b.checkout, 'draft.txt'), 'uncommitted\n')
    const { workspaceRemoved } = await runtime.delete(b.id)
    expect(workspaceRemoved).toBe(false)
    expect(await readFile(join(b.checkout, 'draft.txt'), 'utf8')).toBe('uncommitted\n')
  }, 30_000)

  it('keeps a workspace whose branch moved', async () => {
    const b = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'B' })
    await until(() => runtime.get(b.id)?.status === 'idle')
    await writeFile(join(b.checkout, 'done.txt'), 'done\n')
    execFileSync('git', ['add', 'done.txt'], { cwd: b.checkout })
    execFileSync('git', ['commit', '-qm', 'agent work'], { cwd: b.checkout })
    const { workspaceRemoved } = await runtime.delete(b.id)
    expect(workspaceRemoved).toBe(false)
    await expect(stat(b.checkout)).resolves.toBeDefined()
  }, 30_000)

  it('reference-counts a workspace shared with a fork, in either delete order', async () => {
    for (const sourceFirst of [true, false]) {
      const s = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: `S${sourceFirst}` })
      await until(() => runtime.get(s.id)?.status === 'idle')
      const f = await runtime.fork(s.id)
      await until(() => runtime.get(f.id)?.status === 'idle')
      const first = sourceFirst ? s : f
      const last = sourceFirst ? f : s
      expect((await runtime.delete(first.id)).workspaceRemoved).toBe(false)
      await expect(stat(s.checkout)).resolves.toBeDefined()
      expect(() => execFileSync('git', ['rev-parse', '--verify', `refs/heads/${s.branch.name}`], { cwd: s.checkout, stdio: 'pipe' })).not.toThrow()
      expect((await runtime.delete(last.id)).workspaceRemoved).toBe(true)
      await expect(stat(s.checkout)).rejects.toThrow()
    }
  }, 60_000)

  it('keeps legacy shared-workspace sessions queueing in place and never removes their workspace', async () => {
    const shared = await ensureLocalWorkspace(join(outer, '.poise-chat'), 'test')
    execFileSync('git', ['branch', 'chat/legacy1', 'main'], { cwd: shared })
    execFileSync('git', ['branch', 'chat/legacy2', 'main'], { cwd: shared })
    const l1 = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', repo: '', branch: { existing: 'chat/legacy1' }, title: 'L1' })
    await until(() => runtime.get(l1.id)?.status === 'idle')
    const l2 = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', repo: '', branch: { existing: 'chat/legacy2' }, title: 'L2' })
    await until(() => runtime.get(l2.id)?.status === 'idle')
    expect(l1.checkout).toBe(shared)
    expect(l2.checkout).toBe(shared)
    runtime.prompt(l1.id, { text: 'hold this turn', attachments: [], mentions: [] })
    await until(() => runtime.get(l1.id)?.status === 'running')
    runtime.prompt(l2.id, { text: 'work too', attachments: [], mentions: [] })
    await until(() => runtime.get(l2.id)?.status === 'queued')
    expect(runtime.get(l2.id)?.queuedBehind).toContain('chat "hold this turn" on chat/legacy1')
    await runtime.cancel(l1.id)
    await until(() => runtime.get(l2.id)?.status === 'running')
    await runtime.cancel(l2.id)
    await until(() => runtime.get(l2.id)?.status === 'idle')
    expect((await runtime.delete(l2.id)).workspaceRemoved).toBe(false)
    expect((await runtime.delete(l1.id)).workspaceRemoved).toBe(false)
    await expect(stat(shared)).resolves.toBeDefined()
    expect(git('branch', '--show-current')).toBe('main')
  }, 30_000)

  it('queues a Poise-local turn past the cap with its own reason', async () => {
    const { DEFAULT_MAX_CONCURRENT_LOCAL_TURNS } = await import('../../server/chat/runtime')
    expect(DEFAULT_MAX_CONCURRENT_LOCAL_TURNS).toBe(4)
    const capped = new Runtime({ instance: randomUUID(), instanceLabel: 'test', callerTurns: null,
      catalog: async () => CATALOG, resolveCheckout, localWorkspaceRoot: join(outer, '.poise-chat'),
      idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => 1, adapters: { grok: fakeAdapter }, probeAgent: async () => ({ ok: true }) })
    try {
      const a = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'A' })
      await until(() => capped.get(a.id)?.status === 'idle')
      capped.prompt(a.id, { text: 'hold this turn', attachments: [], mentions: [] })
      await until(() => capped.get(a.id)?.status === 'running')
      const b = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'B' })
      await until(() => capped.get(b.id)?.status === 'idle')
      capped.prompt(b.id, { text: 'work too', attachments: [], mentions: [] })
      await until(() => capped.get(b.id)?.status === 'queued')
      expect(capped.get(b.id)?.queuedBehind).toBe('waiting for a free agent slot')
      // The capped turn waits before touching the checkout: no lease row.
      const { CheckoutLease } = await import('../../server/chat/checkout-lock')
      expect(new CheckoutLease(b.checkout, { ownerKind: 'test', ownerId: 'b', ownerLabel: 'b', instance: 'test' }).read()).toBeNull()
      await capped.cancel(a.id)
      await until(() => capped.get(b.id)?.status === 'running')
      await capped.cancel(b.id)
      await until(() => capped.get(b.id)?.status === 'idle')
    } finally {
      await capped.stop()
    }
  }, 30_000)

  it('lets Stop cancel a Poise-local turn waiting for a free agent slot', async () => {
    const prompted: string[] = []
    let next = ''
    const countingAdapter = () => {
      const tag = next
      const adapter = fakeAdapter()
      const inner = adapter.prompt
      adapter.prompt = (async (...args: Parameters<typeof inner>) => { prompted.push(tag); return inner(...args) }) as typeof inner
      return adapter
    }
    const capped = new Runtime({ instance: randomUUID(), instanceLabel: 'test', callerTurns: null,
      catalog: async () => CATALOG, resolveCheckout, localWorkspaceRoot: join(outer, '.poise-chat'),
      idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => 1, adapters: { grok: countingAdapter }, probeAgent: async () => ({ ok: true }) })
    try {
      next = 'A'
      const a = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'A' })
      await until(() => capped.get(a.id)?.status === 'idle')
      capped.prompt(a.id, { text: 'hold this turn', attachments: [], mentions: [] })
      await until(() => capped.get(a.id)?.status === 'running')
      next = 'B'
      const b = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'B' })
      await until(() => capped.get(b.id)?.status === 'idle')
      capped.prompt(b.id, { text: 'work too', attachments: [], mentions: [] })
      await until(() => capped.get(b.id)?.status === 'queued')
      expect(capped.get(b.id)?.queuedBehind).toBe('waiting for a free agent slot')
      next = 'C'
      const c = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'C' })
      await until(() => capped.get(c.id)?.status === 'idle')
      capped.prompt(c.id, { text: 'work three', attachments: [], mentions: [] })
      await until(() => capped.get(c.id)?.status === 'queued')
      // Stop on the first waiter ends it before it starts: idle, never running, nothing sent.
      await capped.cancel(b.id)
      await until(() => capped.get(b.id)?.status === 'idle')
      expect(prompted).not.toContain('B')
      const transcript = capped.events(b.id, 0).events.map((e) => e.event)
      expect(transcript.some((e) => e.type === 'turn.started')).toBe(true)
      expect(transcript.find((e) => e.type === 'turn.finished')).toMatchObject({ stopReason: 'cancelled' })
      // The surviving waiter keeps its place: stopping the running turn starts C, never B.
      await capped.cancel(a.id)
      await until(() => capped.get(c.id)?.status === 'running')
      expect(prompted).not.toContain('B')
      await capped.cancel(c.id)
      await until(() => capped.get(c.id)?.status === 'idle')
      await until(() => capped.get(a.id)?.status === 'idle')
    } finally {
      await capped.stop()
    }
  }, 60_000)

  it('never parks a turn that was stopped before it reached the slot queue', async () => {
    let gate = false
    let resolveCalls = 0
    let release!: () => void
    const gatePromise = new Promise<void>((r) => { release = r })
    const extensions = {
      resolve: async () => {
        resolveCalls++
        if (gate) await gatePromise
        return { servers: [], notices: [], fingerprint: '[]' }
      },
      delivered: () => {}, scrub: (event: ChatEvent) => event, redact: (text: string) => text,
    }
    const capped = new Runtime({ instance: randomUUID(), instanceLabel: 'test', callerTurns: null,
      catalog: async () => CATALOG, resolveCheckout, localWorkspaceRoot: join(outer, '.poise-chat'),
      idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => 1, adapters: { grok: fakeAdapter },
      probeAgent: async () => ({ ok: true }), extensions })
    try {
      const a = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'A' })
      await until(() => capped.get(a.id)?.status === 'idle')
      capped.prompt(a.id, { text: 'hold this turn', attachments: [], mentions: [] })
      await until(() => capped.get(a.id)?.status === 'running')
      const b = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'B' })
      await until(() => capped.get(b.id)?.status === 'idle')
      // Stop B while its turn is still starting, before it reaches the slot queue.
      gate = true
      const callsBefore = resolveCalls
      capped.prompt(b.id, { text: 'work too', attachments: [], mentions: [] })
      await until(() => resolveCalls > callsBefore)
      const stopping = capped.cancel(b.id)
      release()
      await stopping
      // A still holds the only slot: B is idle without any slot freeing.
      expect(capped.get(a.id)?.status).toBe('running')
      await until(() => capped.get(b.id)?.status === 'idle')
      await capped.cancel(a.id)
      await until(() => capped.get(a.id)?.status === 'idle')
    } finally {
      gate = false
      await capped.stop()
    }
  }, 60_000)

  it('starts waiting turns in queue order when the agent slot cap is raised', async () => {
    let cap = 1
    const capped = new Runtime({ instance: randomUUID(), instanceLabel: 'test', callerTurns: null,
      catalog: async () => CATALOG, resolveCheckout, localWorkspaceRoot: join(outer, '.poise-chat'),
      idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => cap, adapters: { grok: fakeAdapter }, probeAgent: async () => ({ ok: true }) })
    try {
      const a = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'A' })
      await until(() => capped.get(a.id)?.status === 'idle')
      capped.prompt(a.id, { text: 'hold this turn', attachments: [], mentions: [] })
      await until(() => capped.get(a.id)?.status === 'running')
      const waiters: string[] = []
      for (const title of ['B', 'C', 'D']) {
        const session = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title })
        await until(() => capped.get(session.id)?.status === 'idle')
        capped.prompt(session.id, { text: `work ${title}`, attachments: [], mentions: [] })
        await until(() => capped.get(session.id)?.status === 'queued')
        expect(capped.get(session.id)?.queuedBehind).toBe('waiting for a free agent slot')
        waiters.push(session.id)
      }
      const [b, c, d] = waiters as [string, string, string]
      // Raising the cap starts the earliest waiter; nothing else is prompted
      // and no running turn ends.
      cap = 2
      capped.localTurnCapChanged()
      await until(() => capped.get(b)?.status === 'running')
      expect(capped.get(a.id)?.status).toBe('running')
      expect(capped.get(c)?.status).toBe('queued')
      expect(capped.get(c)?.queuedBehind).toBe('waiting for a free agent slot')
      expect(capped.get(d)?.status).toBe('queued')
      // Each release hands the next waiter in order.
      await capped.cancel(a.id)
      await until(() => capped.get(c)?.status === 'running')
      expect(capped.get(d)?.status).toBe('queued')
      await capped.cancel(c)
      await until(() => capped.get(d)?.status === 'running')
      await capped.cancel(b)
      await capped.cancel(d)
      await until(() => capped.get(d)?.status === 'idle')
    } finally {
      await capped.stop()
    }
  }, 60_000)

  it('starts every waiter that fits when a release follows an unannounced raise', async () => {
    let cap = 1
    const capped = new Runtime({ instance: randomUUID(), instanceLabel: 'test', callerTurns: null,
      catalog: async () => CATALOG, resolveCheckout, localWorkspaceRoot: join(outer, '.poise-chat'),
      idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => cap, adapters: { grok: fakeAdapter }, probeAgent: async () => ({ ok: true }) })
    try {
      const a = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'A' })
      await until(() => capped.get(a.id)?.status === 'idle')
      capped.prompt(a.id, { text: 'hold this turn', attachments: [], mentions: [] })
      await until(() => capped.get(a.id)?.status === 'running')
      const b = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'B' })
      await until(() => capped.get(b.id)?.status === 'idle')
      capped.prompt(b.id, { text: 'work too', attachments: [], mentions: [] })
      await until(() => capped.get(b.id)?.status === 'queued')
      const c = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'C' })
      await until(() => capped.get(c.id)?.status === 'idle')
      capped.prompt(c.id, { text: 'work three', attachments: [], mentions: [] })
      await until(() => capped.get(c.id)?.status === 'queued')
      // Another process saved a higher cap to the shared database: this
      // runtime learns it only when it next reads the cap.
      cap = 3
      await capped.cancel(a.id)
      await until(() => capped.get(b.id)?.status === 'running')
      await until(() => capped.get(c.id)?.status === 'running')
      await capped.cancel(b.id)
      await capped.cancel(c.id)
      await until(() => capped.get(c.id)?.status === 'idle')
    } finally {
      await capped.stop()
    }
  }, 60_000)

  it('leaves running turns running when the agent slot cap is lowered', async () => {
    let cap = 3
    const capped = new Runtime({ instance: randomUUID(), instanceLabel: 'test', callerTurns: null,
      catalog: async () => CATALOG, resolveCheckout, localWorkspaceRoot: join(outer, '.poise-chat'),
      idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => cap, adapters: { grok: fakeAdapter }, probeAgent: async () => ({ ok: true }) })
    try {
      const running: string[] = []
      for (const title of ['A', 'B', 'C']) {
        const session = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title })
        await until(() => capped.get(session.id)?.status === 'idle')
        capped.prompt(session.id, { text: `work ${title}`, attachments: [], mentions: [] })
        await until(() => capped.get(session.id)?.status === 'running')
        running.push(session.id)
      }
      const [a, b, c] = running as [string, string, string]
      // Lowering the cap stops nothing; the save hook is a no-op while full.
      cap = 1
      capped.localTurnCapChanged()
      const d = await capped.create({ agent: 'grok', model: 'grok-4.6-high', title: 'D' })
      await until(() => capped.get(d.id)?.status === 'idle')
      capped.prompt(d.id, { text: 'work D', attachments: [], mentions: [] })
      await until(() => capped.get(d.id)?.status === 'queued')
      expect(capped.get(d.id)?.queuedBehind).toBe('waiting for a free agent slot')
      expect(capped.get(a)?.status).toBe('running')
      expect(capped.get(b)?.status).toBe('running')
      expect(capped.get(c)?.status).toBe('running')
      // One waiter per release, only once the count is back within the cap.
      await capped.cancel(a)
      await until(() => capped.get(a)?.status === 'idle')
      expect(capped.get(d.id)?.status).toBe('queued')
      await capped.cancel(b)
      await until(() => capped.get(b)?.status === 'idle')
      expect(capped.get(d.id)?.status).toBe('queued')
      await capped.cancel(c)
      await until(() => capped.get(d.id)?.status === 'running')
      await capped.cancel(d.id)
      await until(() => capped.get(d.id)?.status === 'idle')
    } finally {
      await capped.stop()
    }
  }, 60_000)
})

it('retains the initialization lease when a bootstrap worker cannot be verified stopped', async () => {
  const commands = await import('../../server/chat/git')
  const workers = await import('../../server/chat/worker')
  const held: { lease?: import('../../server/chat/checkout-lock').CheckoutLease } = {}
  const alive = vi.spyOn(workers, 'pgidAlive').mockReturnValue(true)
  const guarded = vi.spyOn(commands, 'runGuarded').mockImplementation(async lease => {
    held.lease = lease
    lease.registerWorker({ pid: 999999, pgid: 999999, ident: 'unsettled-fixture' })
    throw new Error('bootstrap worker did not settle')
  })
  try {
    await expect(ensureLocalWorkspace(join(outer, '.poise-chat'))).rejects.toThrow('did not settle')
    expect(held.lease?.held).toBe(true)
    expect(held.lease?.read()?.worker_pgid).toBe(999999)
  } finally {
    held.lease?.clearWorker()
    held.lease?.release()
    guarded.mockRestore()
    alive.mockRestore()
  }
})
