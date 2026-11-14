import { lstat, mkdir, mkdtemp, writeFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The summary measurement must read wide directories incrementally: one
// readdir call would load and queue every child before either budget is
// checked again. The spy fails the test on exactly that shape.

const { readdirSizes, reads } = vi.hoisted(() => ({ readdirSizes: [] as number[], reads: { paths: [] as string[], fail: '' } }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const readdir = original.readdir as (...args: any[]) => Promise<any[]>
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const path = String(args[0])
      reads.paths.push(path)
      if (path === reads.fail) throw new Error(`${path}: injected read failure`)
      return original.lstat(...args)
    },
    readdir: async (...args: any[]) => {
      const names = await readdir(...args)
      readdirSizes.push(names.length)
      return names
    },
  }
})

let root = ''
let home = ''
let chatRoot = ''
let stateRoot = ''
let maintenance: typeof import('../server/storage-maintenance')
let database: typeof import('../server/db')

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'poise-storage-wide-dir-')))
  home = join(root, 'home')
  chatRoot = join(root, 'chat')
  stateRoot = join(root, 'state')
  await mkdir(home)
  for (const [key, path] of Object.entries({
    POISE_DB: join(root, 'cache.db'), PIP_CACHE_DIR: join(home, 'pip'), UV_CACHE_DIR: join(home, 'uv'),
    npm_config_cache: join(home, 'npm'), AGENT_INTERFACE_WORK_DIR: join(home, 'agent-work'),
    AGENT_INTERFACE_DATA_DIR: join(home, 'caller'), GITHUB_INTERFACE_MIRROR_DIR: join(home, 'mirrors'),
    POISE_LOCK_DIR: join(home, 'locks'), CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'),
    GROK_HOME: join(home, 'grok'), XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'),
  })) vi.stubEnv(key, path)
  reads.paths = []
  reads.fail = ''
  vi.resetModules()
  maintenance = await import('../server/storage-maintenance')
  database = await import('../server/db')
})

afterEach(async () => {
  reads.fail = ''
  await maintenance.runStorageMaintenance({ home, chatRoot, stateRoot, trim: async () => null, claims: () => [] })
  if (database.db.open) database.closeDatabase()
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

function readStorage(options: { fresh?: boolean, now?: number, timed?: boolean } = {}) {
  return maintenance.storageStatus({
    fresh: options.fresh ?? true, now: options.now ?? 1_000,
    breakdown: (scan) => {
      let ticks = 0
      return maintenance.storageBreakdown(home, chatRoot, stateRoot, {
        ...scan, maxEntries: options.timed ? 10_000 : 12, timeoutMs: options.timed ? 8 : 1_000,
        now: () => options.timed ? ticks++ : 1_000,
      })
    },
  })
}

async function wideFixture() {
  const pip = join(home, 'pip')
  await mkdir(pip)
  for (let i = 0; i < 40; i++) await writeFile(join(pip, `file-${i}`), 'x'.repeat(64 + i))
  return pip
}

async function finishStorage() {
  let status = await readStorage()
  for (let i = 0; i < 100 && !status.complete; i++) status = await readStorage()
  expect(status.complete).toBe(true)
  return status
}

describe('resumable storage status', () => {
  it.each([false, true])('finishes exact large-category totals across bounded retries (time bound: %s)', async (timed) => {
    const pip = await wideFixture()
    await mkdir(join(pip, 'nested'))
    await writeFile(join(pip, 'nested', 'payload'), 'nested bytes')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'excluded'), 'x'.repeat(10_000))
    await symlink(outside, join(pip, 'link'))
    await mkdir(join(home, 'uv'))
    await writeFile(join(home, 'uv', 'cache'), 'other category')
    const expected = new Map([
      ['pip', await maintenance.dirSize(pip)], ['uv', await maintenance.dirSize(join(home, 'uv'))],
    ])
    reads.paths = []
    readdirSizes.length = 0
    const [first, concurrent] = await Promise.all([readStorage({ timed }), readStorage({ timed })])
    expect(first).toBe(concurrent)
    expect(first.complete).toBe(false)
    expect(reads.paths.length).toBeLessThanOrEqual(15 + 12)
    reads.paths = []
    expect(await readStorage({ fresh: false, timed })).toBe(first)
    expect(reads.paths).toEqual([])
    let status = await readStorage({ fresh: false, now: 1_000 + maintenance.STORAGE_STATUS_TTL_MS + 1, timed })
    expect(reads.paths.length).toBeGreaterThan(0)
    expect(status.at).toBe(first.at)
    for (let i = 0; i < 100 && !status.complete; i++) {
      reads.paths = []
      const pair = await Promise.all([readStorage({ timed }), readStorage({ timed })])
      expect(pair[0]).toBe(pair[1])
      status = pair[0]
      expect(status.at).toBe(first.at)
      expect(reads.paths.length).toBeLessThanOrEqual(12)
    }
    expect(status.complete).toBe(true)
    for (const category of status.categories) {
      expect(category).toMatchObject({ status: 'ok', bytes: expected.get(category.key) ?? 0 })
    }
    expect(readdirSizes).toEqual([])
  })

  it('keeps category cursors independent when configured cache roots coincide', async () => {
    const pip = await wideFixture()
    vi.stubEnv('UV_CACHE_DIR', pip)
    const status = await finishStorage()
    const bytes = await maintenance.dirSize(pip)
    expect(status.categories.find(category => category.key === 'pip')?.bytes).toBe(bytes)
    expect(status.categories.find(category => category.key === 'uv')?.bytes).toBe(bytes)
  })

  it.each(['edit', 'replace'])('rejects a counted descendant %s until a successful reread', async (change) => {
    const pip = await wideFixture()
    const subtree = join(pip, 'container', 'subtree')
    const counted = join(subtree, 'payload')
    await mkdir(subtree, { recursive: true })
    await writeFile(counted, 'original descendant')
    for (let i = 0; i < 100 && !reads.paths.includes(counted); i++) {
      expect((await readStorage()).complete).toBe(false)
    }
    expect(reads.paths).toContain(counted)
    const before = await lstat(pip)
    if (change === 'edit') await writeFile(counted, 'changed descendant'.repeat(100))
    else {
      await rename(subtree, join(root, 'old-subtree'))
      await mkdir(subtree)
      await writeFile(join(subtree, 'new-payload'), 'replacement bytes')
    }
    expect((await lstat(pip)).mtimeMs).toBe(before.mtimeMs)
    let status = await readStorage()
    for (let i = 0; i < 100 && !status.categories.find(category => category.key === 'pip')?.error?.includes('changed'); i++) {
      expect(status.complete).toBe(false)
      status = await readStorage()
    }
    expect(status.complete).toBe(false)
    expect(status.categories.find(category => category.key === 'pip')?.error).toContain('changed during measurement')
    const retry = await readStorage()
    expect(retry.complete).toBe(false)
    expect(retry.categories.find(category => category.key === 'pip')?.error).toContain('changed during measurement')
    const complete = await finishStorage()
    expect(complete.categories.find(category => category.key === 'pip')).toMatchObject({
      status: 'ok', bytes: await maintenance.dirSize(pip), error: undefined,
    })
  })

  it('retains a read error across slices until the category has been successfully reread', async () => {
    const pip = await wideFixture()
    await readStorage()
    reads.fail = reads.paths.find(path => path.startsWith(`${pip}/file-`))!
    let status = await readStorage()
    for (let i = 0; i < 100 && !status.categories.find(category => category.key === 'pip')?.error?.includes('injected'); i++) {
      expect(status.complete).toBe(false)
      status = await readStorage()
    }
    expect(status.complete).toBe(false)
    expect(status.categories.find(category => category.key === 'pip')?.error).toContain('injected read failure')
    reads.fail = ''
    const retry = await readStorage()
    expect(retry.complete).toBe(false)
    expect(retry.categories.find(category => category.key === 'pip')?.error).toContain('injected read failure')
    const complete = await finishStorage()
    expect(complete.categories.find(category => category.key === 'pip')).toMatchObject({
      status: 'ok', bytes: await maintenance.dirSize(pip), error: undefined,
    })
  })

  it('discards unfinished progress when maintenance overtakes a pending read', async () => {
    const pip = await wideFixture()
    const first = await readStorage()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const pending = maintenance.storageStatus({ fresh: true, breakdown: async (scan) => {
      await gate
      return maintenance.storageBreakdown(home, chatRoot, stateRoot, scan)
    } })
    await maintenance.runStorageMaintenance({ home, chatRoot, stateRoot, trim: async () => null, claims: () => [] })
    await rm(pip, { recursive: true })
    await mkdir(pip)
    await writeFile(join(pip, 'replacement'), 'current tree')
    const replacement = await readStorage({ now: 2_000 })
    expect(replacement.at).not.toBe(first.at)
    release()
    expect(await pending).toMatchObject({ stale: true, complete: false, error: expect.stringContaining('maintenance') })
    expect(await readStorage({ now: 2_000, fresh: false })).toBe(replacement)
    const complete = await finishStorage()
    expect(complete.categories.find(category => category.key === 'pip')?.bytes).toBe(await maintenance.dirSize(pip))
  })
})

describe('wide directory reads', () => {
  it('measures a wide directory without one unbounded readdir', async () => {
    const wide = join(root, 'wide')
    await mkdir(wide, { recursive: true })
    for (let i = 0; i < 500; i++) await writeFile(join(wide, `file-${i}.bin`), 'x'.repeat(64))
    readdirSizes.length = 0
    const measured = await maintenance.measureDir(wide)
    expect(measured.status).toBe('ok')
    expect(measured.bytes).toBeGreaterThan(0)
    expect(readdirSizes).toEqual([])
  })

  it('stops a wide directory at the entry budget', async () => {
    const wide = join(root, 'wide')
    await mkdir(wide, { recursive: true })
    for (let i = 0; i < 500; i++) await writeFile(join(wide, `file-${i}.bin`), 'x'.repeat(64))
    const measured = await maintenance.measureDir(wide, { maxEntries: 100 })
    expect(measured.status).toBe('partial')
    expect(measured.entries).toBeLessThanOrEqual(100 + 64)
    expect(measured.bytes).toBeGreaterThan(0)
  })
})
