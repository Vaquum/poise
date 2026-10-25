import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OWNER = 'Poise local Chat workspace v1\n'
const DAY = 24 * 60 * 60_000

let root = ''
let chatRoot = ''
let stateRoot = ''
let home = ''
let maintenance: typeof import('../server/storage-maintenance')
let database: typeof import('../server/db') | null = null

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function makeWorkspace(id: string, options: { marker?: boolean } = {}): Promise<string> {
  const dir = join(chatRoot, 'workers', id, 'workspace')
  await mkdir(dir, { recursive: true })
  git(dir, 'init', '--quiet', '-b', 'main')
  git(dir, 'config', 'user.name', 'Poise test')
  git(dir, 'config', 'user.email', 'poise-test@example.invalid')
  git(dir, 'config', 'commit.gpgSign', 'false')
  await mkdir(join(dir, '.git', 'info'), { recursive: true })
  await writeFile(join(dir, '.git', 'info', 'exclude'), '.poise-workspace-owner\n')
  await writeFile(join(dir, 'note.txt'), 'hello\n')
  git(dir, 'add', 'note.txt')
  git(dir, 'commit', '--quiet', '--no-gpg-sign', '-m', 'first')
  if (options.marker !== false) await writeFile(join(dir, '.poise-workspace-owner'), OWNER)
  return dir
}

async function age(path: string, ms: number): Promise<void> {
  const at = new Date(Date.now() - ms)
  await utimes(path, at, at)
}

async function ageTree(path: string, ms: number): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await ageTree(join(path, entry.name), ms)
    else await age(join(path, entry.name), ms)
  }
  await age(path, ms)
}

function claimsFor(status: string, updatedAt: string, extra: Partial<{ openTurn: boolean, queued: boolean }> = {}) {
  return () => [{ sessionId: 'session-1', status, updatedAt, openTurn: false, queued: false, ...extra }]
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'poise-storage-maintenance-')))
  chatRoot = join(root, 'chat')
  stateRoot = join(root, 'state')
  home = join(root, 'home')
  await mkdir(home, { recursive: true })
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.stubEnv('PIP_CACHE_DIR', join(home, 'pip'))
  vi.stubEnv('UV_CACHE_DIR', join(home, 'uv'))
  vi.stubEnv('npm_config_cache', join(home, 'npm'))
  vi.stubEnv('AGENT_INTERFACE_WORK_DIR', join(home, 'agent-work'))
  vi.stubEnv('GITHUB_INTERFACE_MIRROR_DIR', join(home, 'mirrors'))
  vi.resetModules()
  maintenance = await import('../server/storage-maintenance')
  database = await import('../server/db')
})

afterEach(async () => {
  if (database?.db.open) database.closeDatabase()
  database = null
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

describe('chat worker workspace retention', () => {
  it('removes a closed, pushed workspace after the grace period', async () => {
    const id = '11111111-1111-1111-1111-111111111111'
    const checkout = await makeWorkspace(id)
    const remote = join(root, 'remote.git')
    git(root, 'init', '--quiet', '--bare', remote)
    git(checkout, 'remote', 'add', 'origin', remote)
    git(checkout, 'push', '--quiet', '-u', 'origin', 'main')
    await age(checkout, 2 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: claimsFor('closed', new Date(Date.now() - 2 * DAY).toISOString()),
    })
    expect(report.removed.map((item) => item.path)).toContain(checkout)
    expect(report.reclaimedBytes).toBeGreaterThan(0)
    await expect(lstat(join(chatRoot, 'workers', id))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('holds a closed workspace with uncommitted changes, with the reason', async () => {
    const id = '22222222-2222-2222-2222-222222222222'
    const checkout = await makeWorkspace(id)
    await writeFile(join(checkout, 'draft.txt'), 'unsaved\n')
    await age(checkout, 2 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: claimsFor('closed', new Date(Date.now() - 2 * DAY).toISOString()),
    })
    expect(report.removed).toHaveLength(0)
    expect(report.held).toHaveLength(1)
    expect(report.held[0].path).toBe(checkout)
    expect(report.held[0].reason).toMatch(/uncommitted/)
    await expect(readFile(join(checkout, 'draft.txt'), 'utf8')).resolves.toBe('unsaved\n')
  })

  it('holds a closed workspace with unpushed commits', async () => {
    const id = '33333333-3333-3333-3333-333333333333'
    const checkout = await makeWorkspace(id)
    const remote = join(root, 'remote.git')
    git(root, 'init', '--quiet', '--bare', remote)
    git(checkout, 'remote', 'add', 'origin', remote)
    git(checkout, 'push', '--quiet', '-u', 'origin', 'main')
    await writeFile(join(checkout, 'more.txt'), 'local only\n')
    git(checkout, 'add', 'more.txt')
    git(checkout, 'commit', '--quiet', '--no-gpg-sign', '-m', 'local only')
    await age(checkout, 2 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: claimsFor('closed', new Date(Date.now() - 2 * DAY).toISOString()),
    })
    expect(report.removed).toHaveLength(0)
    expect(report.held).toHaveLength(1)
    expect(report.held[0].reason).toMatch(/unpushed/)
  })

  it('removes a closed workspace whose branch merged', async () => {
    const id = '44444444-4444-4444-4444-444444444444'
    const checkout = await makeWorkspace(id)
    const remote = join(root, 'remote.git')
    git(root, 'init', '--quiet', '--bare', remote)
    git(checkout, 'remote', 'add', 'origin', remote)
    git(checkout, 'push', '--quiet', '-u', 'origin', 'main')
    git(checkout, 'checkout', '--quiet', '-b', 'feature')
    await writeFile(join(checkout, 'feature.txt'), 'done\n')
    git(checkout, 'add', 'feature.txt')
    git(checkout, 'commit', '--quiet', '--no-gpg-sign', '-m', 'feature')
    git(checkout, 'checkout', '--quiet', 'main')
    git(checkout, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'merge feature')
    git(checkout, 'push', '--quiet', 'origin', 'main')
    // The merged branch has no upstream of its own, as after a squash-merge.
    await age(checkout, 2 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: claimsFor('closed', new Date(Date.now() - 2 * DAY).toISOString()),
    })
    expect(report.removed.map((item) => item.path)).toContain(checkout)
  })

  it('holds a closed workspace inside the grace period', async () => {
    const id = '55555555-5555-5555-5555-555555555555'
    const checkout = await makeWorkspace(id)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: claimsFor('closed', new Date(Date.now() - 60_000).toISOString()),
    })
    expect(report.removed).toHaveLength(0)
    expect(report.held[0].reason).toMatch(/grace/)
    await expect(lstat(checkout)).resolves.toBeDefined()
  })

  it('keeps unproven artifacts and source in an open idle session', async () => {
    const id = '66666666-6666-6666-6666-666666666666'
    const checkout = await makeWorkspace(id)
    await mkdir(join(checkout, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(join(checkout, 'node_modules', 'left-pad', 'index.js'), 'module.exports={}\n')
    await mkdir(join(checkout, 'dist'), { recursive: true })
    await writeFile(join(checkout, 'dist', 'app.js'), 'bundle\n')
    await mkdir(join(checkout, 'src'), { recursive: true })
    await writeFile(join(checkout, 'src', 'keep.ts'), 'export {}\n')
    await age(checkout, 4 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: claimsFor('idle', new Date(Date.now() - 4 * DAY).toISOString()),
    })
    expect(report.removed).toHaveLength(0)
    expect(report.pruned).toHaveLength(0)
    expect(report.held.some((item) => /generator provenance/.test(item.reason))).toBe(true)
    await expect(readFile(join(checkout, 'node_modules', 'left-pad', 'index.js'), 'utf8')).resolves.toBe('module.exports={}\n')
    await expect(readFile(join(checkout, 'dist', 'app.js'), 'utf8')).resolves.toBe('bundle\n')
    await expect(readFile(join(checkout, 'src', 'keep.ts'), 'utf8')).resolves.toBe('export {}\n')
    await expect(lstat(join(checkout, '.git'))).resolves.toBeDefined()
    await expect(lstat(join(chatRoot, 'workers', id, '.poise-maintenance.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['tracked', 'untracked', 'ignored'])('keeps %s source under artifact-shaped names', async (kind) => {
    const checkout = await makeWorkspace('abababab-abab-abab-abab-abababababab')
    for (const name of ['dist', 'build', 'out', '.venv']) {
      await mkdir(join(checkout, name), { recursive: true })
      await writeFile(join(checkout, name, 'unique.txt'), `only copy: ${kind}\n`)
    }
    if (kind === 'tracked') {
      git(checkout, 'add', 'dist', 'build', 'out', '.venv')
      git(checkout, 'commit', '--quiet', '--no-gpg-sign', '-m', 'source directories')
      await writeFile(join(checkout, 'dist', 'unique.txt'), 'uncommitted source edit\n')
    } else if (kind === 'ignored') {
      await writeFile(join(checkout, '.git', 'info', 'exclude'), '.poise-workspace-owner\ndist/\nbuild/\nout/\n.venv/\n')
    }
    await age(checkout, 4 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: claimsFor('idle', new Date(Date.now() - 4 * DAY).toISOString()),
    })
    expect(report.pruned).toEqual([])
    for (const name of ['dist', 'build', 'out', '.venv']) {
      await expect(readFile(join(checkout, name, 'unique.txt'), 'utf8')).resolves.toBe(
        kind === 'tracked' && name === 'dist' ? 'uncommitted source edit\n' : `only copy: ${kind}\n`)
    }
  })

  it('rechecks claims after taking the lease before tidying an idle workspace', async () => {
    const checkout = await makeWorkspace('acacacac-acac-acac-acac-acacacacacac')
    await age(checkout, 4 * DAY)
    const process = await import('../server/process')
    const run = vi.spyOn(process, 'runFile')
    let reads = 0
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: () => [{ sessionId: 'session-1', status: 'idle', updatedAt: new Date(Date.now() - 4 * DAY).toISOString(), openTurn: ++reads > 1, queued: false }],
    })
    expect(report.held.some((item) => /started or queued/.test(item.reason))).toBe(true)
    expect(run.mock.calls.some(([command, args]) => command === 'git' && args[0] === 'gc')).toBe(false)
    run.mockRestore()
  })

  it('keeps idle workspace artifacts while another writer holds its lease', async () => {
    const checkout = await makeWorkspace('adadadad-adad-adad-adad-adadadadadad')
    await mkdir(join(checkout, 'node_modules'), { recursive: true })
    await writeFile(join(checkout, 'node_modules', 'unique.txt'), 'in use\n')
    await age(checkout, 4 * DAY)
    const { CheckoutLease, canonicalCheckout } = await import('../server/chat/checkout-lock')
    const lease = new CheckoutLease(canonicalCheckout(checkout), {
      ownerKind: 'poise:chat', ownerId: 'other-worker', ownerLabel: 'Other worker', instance: 'storage-test',
    })
    expect(lease.tryAcquire().acquired).toBe(true)
    try {
      const report = await maintenance.runStorageMaintenance({
        now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
        claims: claimsFor('idle', new Date(Date.now() - 4 * DAY).toISOString()),
      })
      expect(report.pruned).toEqual([])
      expect(report.held.some((item) => /lease is busy/.test(item.reason))).toBe(true)
      await expect(readFile(join(checkout, 'node_modules', 'unique.txt'), 'utf8')).resolves.toBe('in use\n')
    } finally {
      lease.release()
    }
  })

  it.each([
    { name: 'a running turn', extra: { openTurn: true } },
    { name: 'a queued turn', extra: { queued: true } },
  ])('leaves a session with $name untouched', async ({ extra }) => {
    const id = '77777777-7777-7777-7777-777777777777'
    const checkout = await makeWorkspace(id)
    await mkdir(join(checkout, 'node_modules'), { recursive: true })
    await writeFile(join(checkout, 'node_modules', 'blob.js'), 'x\n')
    await age(checkout, 4 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: claimsFor('idle', new Date(Date.now() - 4 * DAY).toISOString(), extra),
    })
    expect(report.removed).toHaveLength(0)
    expect(report.pruned).toHaveLength(0)
    expect(report.held[0].reason).toMatch(/running or queued/)
    await expect(lstat(join(checkout, 'node_modules', 'blob.js'))).resolves.toBeDefined()
    await expect(lstat(join(chatRoot, 'workers', id, '.poise-maintenance.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a deleted session workspace past the grace period', async () => {
    const id = '88888888-8888-8888-8888-888888888888'
    const checkout = await makeWorkspace(id)
    const remote = join(root, 'remote.git')
    git(root, 'init', '--quiet', '--bare', remote)
    git(checkout, 'remote', 'add', 'origin', remote)
    git(checkout, 'push', '--quiet', '-u', 'origin', 'main')
    await age(checkout, 2 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null, claims: () => [],
    })
    expect(report.removed.map((item) => item.path)).toContain(checkout)
  })

  it('holds a workspace with an invalid owner marker', async () => {
    const id = '99999999-9999-9999-9999-999999999999'
    const checkout = await makeWorkspace(id, { marker: false })
    await age(checkout, 2 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null, claims: () => [],
    })
    expect(report.removed).toHaveLength(0)
    expect(report.held[0].reason).toMatch(/marker/)
  })

  it('reports unpushed branches: ahead, merged, and remote-less', async () => {
    const dir = await makeWorkspace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    // The local commit is the only copy until a remote has it.
    expect(await maintenance.unpushedBranches(dir)).toEqual(['main'])
    const remote = join(root, 'remote.git')
    git(root, 'init', '--quiet', '--bare', remote)
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'push', '--quiet', '-u', 'origin', 'main')
    expect(await maintenance.unpushedBranches(dir)).toEqual([])
    await writeFile(join(dir, 'ahead.txt'), 'ahead\n')
    git(dir, 'add', 'ahead.txt')
    git(dir, 'commit', '--quiet', '--no-gpg-sign', '-m', 'ahead')
    expect(await maintenance.unpushedBranches(dir)).toEqual(['main'])
  })

  it.each(['closed', 'deleted'])('holds committed remote-less work after its session is %s', async (status) => {
    const checkout = await makeWorkspace('dddddddd-dddd-dddd-dddd-dddddddddddd')
    await age(checkout, 2 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: status === 'deleted' ? () => [] : claimsFor('closed', new Date(Date.now() - 2 * DAY).toISOString()),
    })
    expect(report.removed).toHaveLength(0)
    expect(report.held[0].reason).toMatch(/unpushed commits on main/)
    await expect(readFile(join(checkout, 'note.txt'), 'utf8')).resolves.toBe('hello\n')
  })

  it('holds unpublished work on a valid branch whose name contains a pipe', async () => {
    const checkout = await makeWorkspace('12121212-1212-1212-1212-121212121212')
    const remote = join(root, 'remote.git')
    git(root, 'init', '--quiet', '--bare', remote)
    git(checkout, 'remote', 'add', 'origin', remote)
    git(checkout, 'push', '--quiet', '-u', 'origin', 'main')
    git(checkout, 'checkout', '--quiet', '-b', 'work|main')
    await writeFile(join(checkout, 'local.txt'), 'only on the pipe branch\n')
    git(checkout, 'add', 'local.txt')
    git(checkout, 'commit', '--quiet', '--no-gpg-sign', '-m', 'local work')
    git(checkout, 'checkout', '--quiet', 'main')
    expect(await maintenance.unpushedBranches(checkout)).toEqual(['work|main'])
    await age(checkout, 2 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: claimsFor('closed', new Date(Date.now() - 2 * DAY).toISOString()),
    })
    expect(report.removed).toHaveLength(0)
    expect(report.held[0].reason).toContain('unpushed commits on work|main')
    expect(git(checkout, 'show', 'work|main:local.txt')).toBe('only on the pipe branch')
  })

  it.each(['gone upstream', 'detached HEAD'])('holds an unpublished branch with %s', async (mode) => {
    const checkout = await makeWorkspace('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')
    const remote = join(root, 'remote.git')
    git(root, 'init', '--quiet', '--bare', remote)
    git(checkout, 'remote', 'add', 'origin', remote)
    git(checkout, 'push', '--quiet', '-u', 'origin', 'main')
    git(checkout, 'checkout', '--quiet', '-b', 'feature')
    git(checkout, 'push', '--quiet', '-u', 'origin', 'feature')
    await writeFile(join(checkout, 'local.txt'), 'only here\n')
    git(checkout, 'add', 'local.txt')
    git(checkout, 'commit', '--quiet', '--no-gpg-sign', '-m', 'local work')
    if (mode === 'gone upstream') git(checkout, 'push', '--quiet', 'origin', '--delete', 'feature')
    else git(checkout, 'checkout', '--quiet', '--detach', 'origin/main')
    await age(checkout, 2 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: claimsFor('closed', new Date(Date.now() - 2 * DAY).toISOString()),
    })
    expect(report.removed).toHaveLength(0)
    expect(report.held[0].reason).toMatch(/unpushed commits on feature/)
    expect(git(checkout, 'show', 'feature:local.txt')).toBe('only here')
  })

  it('a dry run classifies like the real run without deleting', async () => {
    const gone = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const held = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const goneCheckout = await makeWorkspace(gone)
    const heldCheckout = await makeWorkspace(held)
    const remote = join(root, 'remote.git')
    git(root, 'init', '--quiet', '--bare', remote)
    git(goneCheckout, 'remote', 'add', 'origin', remote)
    git(goneCheckout, 'push', '--quiet', '-u', 'origin', 'main')
    await writeFile(join(heldCheckout, 'draft.txt'), 'unsaved\n')
    await age(goneCheckout, 2 * DAY)
    await age(heldCheckout, 2 * DAY)
    const old = new Date(Date.now() - 2 * DAY).toISOString()
    const shared = { now: Date.now(), chatRoot, stateRoot, home, trim: async () => null, claims: claimsFor('closed', old) }
    const dry = await maintenance.runStorageMaintenance({ ...shared, dryRun: true })
    await expect(lstat(goneCheckout)).resolves.toBeDefined()
    const real = await maintenance.runStorageMaintenance(shared)
    expect(dry.dryRun).toBe(true)
    expect(dry.removed).toEqual(real.removed)
    expect(dry.pruned).toEqual(real.pruned)
    expect(dry.held).toEqual(real.held)
    expect(dry.reclaimedBytes).toBe(real.reclaimedBytes)
    await expect(lstat(goneCheckout)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('bounded caches', () => {
  async function seed(dir: string, files: Array<{ name: string, bytes: number, ageMs: number }>): Promise<void> {
    await mkdir(dir, { recursive: true })
    for (const file of files) {
      const path = join(dir, file.name)
      await writeFile(path, 'x'.repeat(file.bytes))
      const at = new Date(Date.now() - file.ageMs)
      await utimes(path, at, at)
    }
  }

  it('caps a cache by evicting the least recently used files first', async () => {
    const pip = join(home, 'pip')
    await seed(pip, [
      { name: 'old', bytes: 100, ageMs: 2 * DAY },
      { name: 'new', bytes: 100, ageMs: 10 * 60_000 },
    ])
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: () => [], caps: { pip: 150, uv: 1, npm: 1, mirrors: 1 },
    })
    expect(report.caches).toHaveLength(1)
    expect(report.caches[0]).toMatchObject({ path: pip, bytes: 100 })
    await expect(lstat(join(pip, 'old'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(pip, 'new'))).resolves.toBeDefined()
  })

  it('never evicts fresh cache files', async () => {
    const pip = join(home, 'pip')
    await seed(pip, [{ name: 'hot', bytes: 100, ageMs: 1_000 }])
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null,
      claims: () => [], caps: { pip: 1, uv: 1, npm: 1, mirrors: 1 },
    })
    expect(report.caches).toHaveLength(0)
    expect(report.held.some((item) => item.path === pip && /in use/.test(item.reason))).toBe(true)
    await expect(lstat(join(pip, 'hot'))).resolves.toBeDefined()
  })

  it.each([false, true])('delegates mirror eviction and reports to its configured Caller (dryRun=%s)', async (dryRun) => {
    const mirrors = join(home, 'mirrors')
    const owner = join(mirrors, 'owner')
    await mkdir(owner, { recursive: true })
    const stale = join(owner, 'stale.git')
    const fresh = join(owner, 'fresh.git')
    git(root, 'init', '--quiet', '--bare', stale)
    git(root, 'init', '--quiet', '--bare', fresh)
    await ageTree(stale, 2 * DAY)
    await ageTree(fresh, 2 * DAY)
    await writeFile(join(fresh, 'objects', 'pack', 'recent'), 'active fetch\n')
    await age(fresh, 2 * DAY)
    const lock = join(owner, 'stale.lock')
    await writeFile(lock, 'original lock inode\n')
    const inode = (await lstat(lock)).ino
    const bin = join(root, 'caller-bin')
    const argumentsPath = join(root, 'caller-arguments.json')
    await mkdir(bin)
    const callerReport = {
      removed: [{ path: stale, bytes: 100 }],
      held: [{ path: fresh, reason: 'mirror was recently written' }],
    }
    // The Node suite isolates Caller. Its Python suite proves actual locked
    // eviction; this boundary proves that Node delegates and only reports.
    await writeFile(join(bin, 'github-interface'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(${JSON.stringify(JSON.stringify(callerReport))})
`, { mode: 0o700 })
    vi.stubEnv('CALLER_BIN_ROOT', bin)
    const now = Date.now()
    const report = await maintenance.runStorageMaintenance({
      now, dryRun, chatRoot, stateRoot, home, trim: async () => null,
      claims: () => [], caps: { pip: 1, uv: 1, npm: 1, mirrors: 1 },
    })
    expect(report.errors).toEqual([])
    expect(JSON.parse(await readFile(argumentsPath, 'utf8'))).toEqual([
      '--prune-mirrors', mirrors, '--cap-bytes', '1', '--now-ms', String(now), '--fresh-ms', '300000',
      ...(dryRun ? ['--dry-run'] : []),
    ])
    expect(report.caches.map((item) => item.path)).toEqual([stale])
    expect(report.reclaimedBytes).toBe(100)
    expect(report.held).toContainEqual(callerReport.held[0])
    await expect(lstat(stale)).resolves.toBeDefined()
    await expect(readFile(join(fresh, 'objects', 'pack', 'recent'), 'utf8')).resolves.toBe('active fetch\n')
    expect((await lstat(lock)).ino).toBe(inode)
    await expect(readFile(lock, 'utf8')).resolves.toBe('original lock inode\n')
    await expect(lstat(owner)).resolves.toBeDefined()
  })
})

describe('snapshot expiry', () => {
  it('expires incident snapshots unless pinned with KEEP', async () => {
    const snapshots = join(stateRoot, 'incident-recovery')
    await mkdir(join(snapshots, 'old'), { recursive: true })
    await writeFile(join(snapshots, 'old', 'dump'), 'x\n')
    await mkdir(join(snapshots, 'pinned'), { recursive: true })
    await writeFile(join(snapshots, 'pinned', 'KEEP'), '\n')
    await mkdir(join(snapshots, 'recent'), { recursive: true })
    await age(join(snapshots, 'old'), 31 * DAY)
    await age(join(snapshots, 'pinned'), 31 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null, claims: () => [],
    })
    expect(report.removed.map((item) => item.path)).toContain(join(snapshots, 'old'))
    expect(report.held.find((item) => item.path === join(snapshots, 'pinned'))?.reason).toMatch(/KEEP/)
    await expect(lstat(join(snapshots, 'old'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(snapshots, 'pinned', 'KEEP'))).resolves.toBeDefined()
    await expect(lstat(join(snapshots, 'recent'))).resolves.toBeDefined()
  })

  it('expires only old hex issue-review runs', async () => {
    const work = join(home, 'agent-work')
    const stale = join(work, 'a'.repeat(32))
    const fresh = join(work, 'b'.repeat(32))
    await mkdir(stale, { recursive: true })
    await mkdir(fresh, { recursive: true })
    await mkdir(join(work, 'notes'), { recursive: true })
    await age(stale, 8 * DAY)
    await age(join(work, 'notes'), 8 * DAY)
    const report = await maintenance.runStorageMaintenance({
      now: Date.now(), chatRoot, stateRoot, home, trim: async () => null, claims: () => [],
    })
    expect(report.removed.map((item) => item.path)).toContain(stale)
    await expect(lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(fresh)).resolves.toBeDefined()
    await expect(lstat(join(work, 'notes'))).resolves.toBeDefined()
  })
})

describe('disk pressure', () => {
  it('runs maintenance and alerts past the threshold, and resolves below the clear line', async () => {
    const alerts = await import('../server/alerts/store')
    let runs = 0
    const run = async () => {
      runs += 1
      return maintenance.runStorageMaintenance({ now: Date.now(), chatRoot, stateRoot, home, trim: async () => null, claims: () => [] })
    }
    const high = await maintenance.checkWorkspacePressure(home, async () => ({ blocks: 100, bsize: 1024, bavail: 15 }), run)
    expect(high).toMatchObject({ ran: true })
    expect(runs).toBe(1)
    expect(high.usedPercent).toBeCloseTo(85, 5)
    expect(alerts.openAlerts().some((alert) => alert.dedupeKey === 'workspace-storage-pressure')).toBe(true)
    // Cooldown: still pressured, but no second run.
    const again = await maintenance.checkWorkspacePressure(home, async () => ({ blocks: 100, bsize: 1024, bavail: 15 }), run)
    expect(again.ran).toBe(false)
    expect(runs).toBe(1)
    const low = await maintenance.checkWorkspacePressure(home, async () => ({ blocks: 100, bsize: 1024, bavail: 30 }), run)
    expect(low.ran).toBe(false)
    expect(alerts.openAlerts().some((alert) => alert.dedupeKey === 'workspace-storage-pressure')).toBe(false)
  })
})

describe('storage breakdown', () => {
  it('reports per-category sizes and disk totals', async () => {
    const checkout = await makeWorkspace('dddddddd-dddd-dddd-dddd-dddddddddddd')
    await writeFile(join(checkout, 'payload.bin'), 'x'.repeat(4096))
    const pip = join(home, 'pip')
    await mkdir(pip, { recursive: true })
    await writeFile(join(pip, 'wheel'), 'y'.repeat(2048))
    const breakdown = await maintenance.storageBreakdown(home, chatRoot, stateRoot)
    const byKey = new Map(breakdown.categories.map((category) => [category.key, category]))
    expect(byKey.get('chat-workers')!.status).toBe('ok')
    expect(byKey.get('chat-workers')!.bytes).toBeGreaterThanOrEqual(4096)
    expect(byKey.get('pip')!.status).toBe('ok')
    expect(byKey.get('pip')!.bytes).toBeGreaterThanOrEqual(2048)
    expect(byKey.get('review-checkouts')).toMatchObject({ status: 'ok', bytes: 0 })
    expect(breakdown.complete).toBe(true)
    expect(breakdown.disk.totalBytes).toBeGreaterThan(0)
    expect(breakdown.disk.usedPercent).toBeGreaterThanOrEqual(0)
  })
})

describe('bounded storage reads', () => {
  it('measures missing directories as zero and completes', async () => {
    const breakdown = await maintenance.storageBreakdown(home, chatRoot, stateRoot)
    expect(breakdown.categories).toHaveLength(8)
    for (const category of breakdown.categories) {
      expect(category).toMatchObject({ status: 'ok', bytes: 0 })
    }
    expect(breakdown.complete).toBe(true)
  })

  it('measures a single file path as its own size', async () => {
    const file = join(home, 'lone.bin')
    await writeFile(file, 'x'.repeat(1024))
    await expect(maintenance.measureDir(file)).resolves.toMatchObject({ status: 'ok', bytes: expect.any(Number) })
    expect((await maintenance.measureDir(file)).bytes).toBeGreaterThanOrEqual(1024)
  })

  it.skipIf(process.getuid?.() === 0)('reports an unreadable category as unavailable, not zero', async () => {
    const pip = join(home, 'pip')
    await mkdir(pip, { recursive: true })
    await writeFile(join(pip, 'wheel'), 'y'.repeat(2048))
    await chmod(pip, 0o000)
    try {
      const breakdown = await maintenance.storageBreakdown(home, chatRoot, stateRoot)
      const byKey = new Map(breakdown.categories.map((category) => [category.key, category]))
      expect(byKey.get('pip')!.status).toBe('unavailable')
      expect(byKey.get('pip')!.bytes).toBeNull()
      expect(byKey.get('pip')!.error).toMatch(/permission|EACCES|EPERM/i)
      expect(byKey.get('review-checkouts')).toMatchObject({ status: 'ok', bytes: 0 })
      expect(breakdown.complete).toBe(false)
    } finally {
      await chmod(pip, 0o755)
    }
  })

  it.skipIf(process.getuid?.() === 0)('reports a partially unreadable category as partial with measured bytes', async () => {
    const pip = join(home, 'pip')
    await mkdir(join(pip, 'dark'), { recursive: true })
    await writeFile(join(pip, 'wheel'), 'y'.repeat(2048))
    await writeFile(join(pip, 'dark', 'hidden'), 'z'.repeat(2048))
    await chmod(join(pip, 'dark'), 0o000)
    try {
      const measured = await maintenance.measureDir(pip)
      expect(measured.status).toBe('partial')
      expect(measured.bytes).toBeGreaterThanOrEqual(2048)
      expect(measured.error).toMatch(/permission|EACCES|EPERM/i)
    } finally {
      await chmod(join(pip, 'dark'), 0o755)
    }
  })

  it('stops a large category at the entry budget while other categories complete', async () => {
    const pip = join(home, 'pip')
    await mkdir(pip, { recursive: true })
    for (let i = 0; i < 200; i++) await writeFile(join(pip, `wheel-${i}`), 'y'.repeat(64))
    const measured = await maintenance.measureDir(pip, { maxEntries: 50 })
    expect(measured.status).toBe('partial')
    expect(measured.entries).toBeLessThanOrEqual(51)
    expect(measured.bytes).toBeGreaterThan(0)
    const breakdown = await maintenance.storageBreakdown(home, chatRoot, stateRoot, { maxEntries: 50 })
    const byKey = new Map(breakdown.categories.map((category) => [category.key, category]))
    expect(byKey.get('pip')!.status).toBe('partial')
    expect(byKey.get('review-checkouts')).toMatchObject({ status: 'ok', bytes: 0 })
    expect(breakdown.complete).toBe(false)
  })

  it('stops at the time deadline instead of walking on', async () => {
    const pip = join(home, 'pip')
    await mkdir(pip, { recursive: true })
    for (let i = 0; i < 200; i++) await writeFile(join(pip, `wheel-${i}`), 'y'.repeat(64))
    let ticks = 0
    const measured = await maintenance.measureDir(pip, { timeoutMs: 1_000, now: () => (ticks++ < 10 ? 1_000 : 1_000 + 1_001) })
    expect(measured.status).toBe('partial')
    expect(measured.entries).toBeLessThan(200)
    expect(measured.error).toMatch(/timed out/)
    const expired = await maintenance.storageBreakdown(home, chatRoot, stateRoot, { timeoutMs: 0, now: () => 1_000 })
    expect(expired.complete).toBe(false)
    expect(expired.categories.every((category) => category.status !== 'ok' || category.bytes === 0)).toBe(true)
  })
})

describe('storage status cache', () => {
  function scriptedBreakdown(results: Array<{ categories?: Array<{ key: string, bytes: number | null }> } | Error>): { calls: () => number, breakdown: () => Promise<import('../server/storage-maintenance').StorageBreakdown> } {
    let calls = 0
    const breakdown = async (): Promise<import('../server/storage-maintenance').StorageBreakdown> => {
      const next = results[Math.min(calls, results.length - 1)]
      calls += 1
      if (next instanceof Error) throw next
      return {
        at: new Date(1_000 + calls).toISOString(),
        categories: (next.categories ?? [{ key: 'pip', bytes: 10 }]).map((category) => ({
          key: category.key, label: category.key, path: `/tmp/${category.key}`,
          bytes: category.bytes, status: category.bytes === null ? 'unavailable' as const : 'ok' as const,
        })),
        disk: { path: '/tmp', totalBytes: 100, freeBytes: 50, usedPercent: 50 },
        complete: true,
      }
    }
    return { calls: () => calls, breakdown }
  }

  it('reuses one scan across repeated and concurrent reads', async () => {
    const scripted = scriptedBreakdown([{}])
    const now = 10_000
    const first = await maintenance.storageStatus({ now, breakdown: scripted.breakdown })
    const second = await maintenance.storageStatus({ now, breakdown: scripted.breakdown })
    expect(second).toBe(first)
    const [a, b] = await Promise.all([
      maintenance.storageStatus({ now: now + maintenance.STORAGE_STATUS_TTL_MS + 1, breakdown: scripted.breakdown }),
      maintenance.storageStatus({ now: now + maintenance.STORAGE_STATUS_TTL_MS + 1, breakdown: scripted.breakdown }),
    ])
    expect(a).toBe(b)
    expect(scripted.calls()).toBe(2)
  })

  it('rescans after the TTL and serves the fresh observation', async () => {
    const scripted = scriptedBreakdown([{}, {}])
    const now = 20_000
    const first = await maintenance.storageStatus({ now, breakdown: scripted.breakdown })
    const second = await maintenance.storageStatus({ now: now + maintenance.STORAGE_STATUS_TTL_MS + 1, breakdown: scripted.breakdown })
    expect(scripted.calls()).toBe(2)
    expect(second).not.toBe(first)
    expect(second.stale).toBe(false)
  })

  it('serves the last observation as stale when a refresh fails, without keeping the failure', async () => {
    const scripted = scriptedBreakdown([{}, new Error('disk walk blew up'), {}])
    const now = 30_000
    const first = await maintenance.storageStatus({ now, breakdown: scripted.breakdown })
    const stale = await maintenance.storageStatus({ now: now + maintenance.STORAGE_STATUS_TTL_MS + 1, breakdown: scripted.breakdown })
    expect(stale.stale).toBe(true)
    expect(stale.error).toMatch(/disk walk blew up/)
    expect(stale.categories).toEqual(first.categories)
    const recovered = await maintenance.storageStatus({ now: now + maintenance.STORAGE_STATUS_TTL_MS + 1, breakdown: scripted.breakdown })
    expect(recovered.stale).toBe(false)
    expect(scripted.calls()).toBe(3)
  })

  it('fails the first read loudly when nothing was ever measured', async () => {
    const scripted = scriptedBreakdown([new Error('no walk today')])
    await expect(maintenance.storageStatus({ now: 40_000, breakdown: scripted.breakdown })).rejects.toThrow('no walk today')
  })

  it('measures afresh on demand even with a live cache entry', async () => {
    const scripted = scriptedBreakdown([{}, {}])
    const now = 50_000
    await maintenance.storageStatus({ now, breakdown: scripted.breakdown })
    const fresh = await maintenance.storageStatus({ now, fresh: true, breakdown: scripted.breakdown })
    expect(scripted.calls()).toBe(2)
    expect(fresh.stale).toBe(false)
  })

  it('drops the cached summary when maintenance changes what it measures', async () => {
    const scripted = scriptedBreakdown([{}, {}])
    const now = 60_000
    await maintenance.storageStatus({ now, breakdown: scripted.breakdown })
    await maintenance.runStorageMaintenance({ now, dryRun: true, chatRoot, stateRoot, home, trim: async () => null, claims: () => [] })
    await maintenance.storageStatus({ now, breakdown: scripted.breakdown })
    expect(scripted.calls()).toBe(1)
    await maintenance.runStorageMaintenance({ now, chatRoot, stateRoot, home, trim: async () => null, claims: () => [] })
    await maintenance.storageStatus({ now, breakdown: scripted.breakdown })
    expect(scripted.calls()).toBe(2)
  })

  it('does not let a scan overtaken by maintenance repopulate the cache', async () => {
    const scripted = scriptedBreakdown([{}, {}])
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const now = 70_000
    const pending = maintenance.storageStatus({ now, breakdown: () => gate.then(scripted.breakdown) })
    await maintenance.runStorageMaintenance({ now, chatRoot, stateRoot, home, trim: async () => null, claims: () => [] })
    release()
    const first = await pending
    expect(first.stale).toBe(false)
    const second = await maintenance.storageStatus({ now, breakdown: scripted.breakdown })
    expect(second).not.toBe(first)
    expect(scripted.calls()).toBe(2)
  })

  it('does not join a pre-maintenance scan for reads issued after maintenance', async () => {
    const scripted = scriptedBreakdown([{}, {}])
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const now = 80_000
    const before = maintenance.storageStatus({ now, breakdown: () => gate.then(scripted.breakdown) })
    await maintenance.runStorageMaintenance({ now, chatRoot, stateRoot, home, trim: async () => null, claims: () => [] })
    const after = maintenance.storageStatus({ now, breakdown: scripted.breakdown })
    release()
    const [first, second] = await Promise.all([before, after])
    expect(second).not.toBe(first)
    expect(second.stale).toBe(false)
    expect(scripted.calls()).toBe(2)
  })
})

describe('artifact restore', () => {
  it('reinstalls pruned node_modules with the lockfile installer', async () => {
    const id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    const checkout = await makeWorkspace(id)
    await writeFile(join(checkout, 'package.json'), '{"name":"x"}\n')
    await writeFile(join(checkout, 'package-lock.json'), '{"lockfileVersion":3}\n')
    await writeFile(join(chatRoot, 'workers', id, '.poise-maintenance.json'), JSON.stringify({ prunedAt: new Date().toISOString(), pruned: ['node_modules'] }))
    const calls: Array<{ command: string, args: readonly string[] }> = []
    const restored = await maintenance.restorePrunedArtifacts(checkout, chatRoot, async (command, args) => {
      calls.push({ command, args })
      return { stdout: '' }
    })
    expect(restored).toEqual(['node_modules'])
    expect(calls).toEqual([{ command: 'npm', args: ['ci', '--no-audit', '--no-fund'] }])
    await expect(lstat(join(chatRoot, 'workers', id, '.poise-maintenance.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('drops the marker even when reinstall fails', async () => {
    const id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    const checkout = await makeWorkspace(id)
    await writeFile(join(checkout, 'package.json'), '{"name":"x"}\n')
    await writeFile(join(chatRoot, 'workers', id, '.poise-maintenance.json'), JSON.stringify({ prunedAt: new Date().toISOString(), pruned: ['node_modules'] }))
    const restored = await maintenance.restorePrunedArtifacts(checkout, chatRoot, async () => { throw new Error('offline') })
    expect(restored).toEqual([])
    await expect(lstat(join(chatRoot, 'workers', id, '.poise-maintenance.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ignores checkouts outside workers/<id>/workspace', async () => {
    const dir = join(root, 'elsewhere')
    await mkdir(dir, { recursive: true })
    await expect(maintenance.restorePrunedArtifacts(dir, chatRoot, async () => { throw new Error('must not run') })).resolves.toEqual([])
  })
})

describe('session claims', () => {
  it('reads claims from the session table without parsing records', async () => {
    const storage = await import('../server/chat/storage')
    const checkout = await makeWorkspace('00000000-0000-0000-0000-000000000000')
    storage.insertSession({
      id: 'session-1', agent: 'codex', model: 'x', modelId: 'y', effort: 'medium', repo: '', checkout,
      branch: { name: 'chat/x', origin: 'new', provisional: true }, title: 't', instance: 'test',
      createdAt: new Date(Date.now() - 2 * DAY).toISOString(), updatedAt: new Date(Date.now() - 2 * DAY).toISOString(), status: 'closed',
    } as unknown as import('../server/chat/protocol').SessionRecord)
    expect(maintenance.claimsForCheckout(checkout)).toEqual([{
      sessionId: 'session-1', status: 'closed', updatedAt: expect.any(String), openTurn: false, queued: false,
    }])
    expect(await readdir(join(chatRoot, 'workers'))).toContain('00000000-0000-0000-0000-000000000000')
  })
})
