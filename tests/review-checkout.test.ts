import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withProcessLock } from '../server/process-lock'
import { pruneReviewCheckouts, resolveReviewCheckout, REVIEW_CHECKOUT_RETENTION_MS } from '../server/review-checkout'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile }))
const owner = 'autonomio', repo = 'autonomio', actor = 'bit-mis', head = 'a'.repeat(40)
const remote = `https://github.com/${owner}/${repo}.git`
let root: string
let wrongHead = false
let dirty = false
let failedFetch = false
const resolveCheckout = (signal?: AbortSignal) => resolveReviewCheckout(owner, repo, 146, actor, head, signal)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-review-checkout-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  wrongHead = dirty = failedFetch = false
  mocks.runFile.mockReset().mockImplementation(async (command: string, args: string[]) => {
    if (command === 'github-interface' && args[0] === '--local-checkout-path') {
      throw Object.assign(new Error('Command failed (1): github-interface'), {
        code: 1, stderr: `error: checkout not found under /dev: ${owner}/${repo}\n`,
      })
    }
    if (command === 'github-interface' && args[0] === '--checkout-repo') {
      if (failedFetch) throw new Error('reviewer cannot read repository')
      await mkdir(args[3], { recursive: true })
      return { stdout: JSON.stringify({ action: 'checkout_repo', repository: `${owner}/${repo}`, path: args[3] }), stderr: '' }
    }
    if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') return { stdout: remote, stderr: '' }
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: wrongHead ? 'b'.repeat(40) : head, stderr: '' }
    if (command === 'git' && args[0] === 'status') return { stdout: dirty ? ' M file.ts' : '', stderr: '' }
    return { stdout: '', stderr: '' }
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
describe('review checkout provisioning through Caller', () => {
  it('uses an existing user checkout without changing it', async () => {
    mocks.runFile.mockResolvedValueOnce({ stdout: JSON.stringify({ action: 'local_checkout_path', repository: `${owner}/${repo}`, path: root }), stderr: '' })
    expect(await resolveCheckout()).toBe(root)
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
  })
  it('coalesces concurrent provisioning, pins the head and uses only the reviewer identity', async () => {
    const paths = await Promise.all([resolveCheckout(), resolveCheckout(), resolveCheckout()])
    expect(new Set(paths).size).toBe(1)
    expect(paths[0]).toBe(join(root, 'review-checkouts', head, owner, repo))
    const fetches = mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--checkout-repo')
    expect(fetches).toHaveLength(1)
    expect(fetches[0][1].slice(0, 3)).toEqual(['--checkout-repo', `${owner}/${repo}`, '--path'])
    expect(fetches[0][1].slice(4)).toEqual(['--token-user', actor])
    expect(mocks.runFile).toHaveBeenCalledWith('git', ['checkout', '--quiet', '--detach', head], expect.any(Object))
    expect(mocks.runFile.mock.calls.some(([command]) => command === 'gh')).toBe(false)
  })
  it.each(['head changed', 'denied access', 'dirty checkout'] as const)('does not publish or retain staging after %s', async (cause) => {
    wrongHead = cause === 'head changed'
    failedFetch = cause === 'denied access'
    dirty = cause === 'dirty checkout'
    await expect(resolveCheckout()).rejects.toThrow()
    expect(await readdir(join(root, 'review-checkouts', head, owner))).toEqual([`${repo}.lock`])
  })
  it('does not overwrite a managed checkout that was subsequently changed', async () => {
    const path = await resolveCheckout()
    await writeFile(join(path, 'user-work'), 'keep')
    dirty = true
    await expect(resolveCheckout()).rejects.toThrow('local changes')
    expect(await readFile(join(path, 'user-work'), 'utf8')).toBe('keep')
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--checkout-repo')).toHaveLength(1)
  })
  it.each(['timeout', 'GitHub 404', 'malformed response'] as const)('does not provision on %s', async (cause) => {
    if (cause === 'malformed response') mocks.runFile.mockResolvedValueOnce({ stdout: 'null', stderr: '' })
    else mocks.runFile.mockRejectedValueOnce(Object.assign(new Error(cause), { code: 1, stderr: cause }))
    await expect(resolveCheckout()).rejects.toThrow()
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
  })
  it('provisions as whichever agent account reviews, named to Caller', async () => {
    expect(await resolveReviewCheckout(owner, repo, 146, 'other-reviewer', head)).toBe(join(root, 'review-checkouts', head, owner, repo))
    const fetches = mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--checkout-repo')
    expect(fetches.map(([, args]) => args.slice(4))).toEqual([['--token-user', 'other-reviewer']])
  })
  it('rejects path traversal before invoking any process', async () => {
    await expect(resolveReviewCheckout(owner, '..', 146, actor, head)).rejects.toThrow('Invalid review')
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
})
describe('review checkout retention', () => {
  const day = REVIEW_CHECKOUT_RETENTION_MS
  const checkouts = () => join(root, 'review-checkouts')
  // What review-checkouts holds besides the lock a review marks its head
  // under, and the journal SQLite keeps beside it.
  const entries = async () => (await readdir(checkouts())).filter((name) => !name.startsWith('.lock')).sort()
  // A head's checkout as provisioning leaves it, last resolved `age` ago.
  const provisioned = async (name: string, age: number): Promise<void> => {
    const headPath = join(checkouts(), name)
    await mkdir(join(headPath, owner, repo, '.git'), { recursive: true })
    await writeFile(join(headPath, owner, repo, 'README.md'), 'checkout')
    await writeFile(join(headPath, owner, `${repo}.lock`), '')
    const when = new Date(Date.now() - age)
    await utimes(headPath, when, when)
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

  it('removes a head a day after a review last resolved it, and keeps one resolved since', async () => {
    await provisioned('b'.repeat(40), day + 60_000)
    await provisioned('c'.repeat(40), day - 60_000)
    expect(await pruneReviewCheckouts(root)).toEqual(['b'.repeat(40)])
    expect(await entries()).toEqual(['c'.repeat(40)])
  })

  it('finishes what an interrupted prune left, and leaves what is not a head alone', async () => {
    await mkdir(join(checkouts(), `.removing-${'d'.repeat(40)}-1`, owner, repo), { recursive: true })
    await mkdir(join(checkouts(), 'notes'))
    await writeFile(join(checkouts(), 'README'), 'mine')
    expect(await pruneReviewCheckouts(root, Date.now() + 2 * day)).toEqual([])
    expect(await entries()).toEqual(['README', 'notes'])
  })

  it('has nothing to remove before any review provisioned a checkout', async () => {
    expect(await pruneReviewCheckouts(root)).toEqual([])
  })

  it('counts a day from the last review that resolved the head', async () => {
    const path = await resolveCheckout()
    const headPath = join(checkouts(), head)
    const old = new Date(Date.now() - 2 * day)
    await utimes(headPath, old, old)
    expect(await resolveCheckout()).toBe(path)
    expect(Date.now() - (await stat(headPath)).mtimeMs).toBeLessThan(60_000)
    expect(await pruneReviewCheckouts(root)).toEqual([])
    expect(await entries()).toEqual([head])
  })

  it('judges a head again under the lock, so it keeps one a review marked while the prune waited', async () => {
    await provisioned('b'.repeat(40), 2 * day)
    let pruning: Promise<string[]> | undefined
    await withProcessLock({ path: join(checkouts(), '.lock') }, async () => {
      pruning = pruneReviewCheckouts(root)
      await settle()
      // What a review does under this lock: mark its head used.
      const now = new Date()
      await utimes(join(checkouts(), 'b'.repeat(40)), now, now)
    })
    expect(await pruning).toEqual([])
    expect(await entries()).toEqual(['b'.repeat(40)])
  })

  it('marks its head only under the lock a prune judges heads under', async () => {
    let resolving: Promise<string> | undefined
    let whileLocked: string[] = []
    await withProcessLock({ path: join(checkouts(), '.lock') }, async () => {
      resolving = resolveCheckout()
      await settle()
      whileLocked = await entries()
    })
    expect(await resolving).toBe(join(checkouts(), head, owner, repo))
    expect(whileLocked).toEqual([])
    expect(await entries()).toEqual([head])
  })

  it('prunes in the background when a review resolves a checkout, at most once an hour', async () => {
    await provisioned('b'.repeat(40), 2 * day)
    await resolveCheckout()
    await vi.waitFor(async () => expect(await entries()).toEqual([head]))
    await provisioned('c'.repeat(40), 2 * day)
    await resolveCheckout()
    await settle()
    expect(await entries()).toEqual([head, 'c'.repeat(40)].sort())
  })
})
