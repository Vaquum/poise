import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withProcessLock } from '../server/process-lock'

it('drains mixed failures and cancellations in order without blocking independent work or leaking ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-stress-'))
  const path = join(root, 'shared.sqlite3')
  const receipts = join(root, 'receipts')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const holding = new Promise<void>((resolve) => { entered = resolve })
  const owner = withProcessLock({ path }, async () => { entered(); await gate })
  const controllers = Array.from({ length: 120 }, () => new AbortController())
  const executed: number[] = []
  let active = 0
  let peak = 0
  try {
    await holding
    const attempts = controllers.map((controller, index) => withProcessLock({
      // Equivalent path spellings share local admission as well as SQLite ownership.
      path: index % 2 ? `${root}/./shared.sqlite3` : path,
      signal: controller.signal,
      timeoutMs: index % 10 === 1 ? 50 : 5_000,
    }, async () => {
      active += 1
      peak = Math.max(peak, active)
      executed.push(index)
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (index % 11 === 0) throw new Error(`callback ${index} failed`)
        await appendFile(receipts, `${index}\n`)
        return index
      } finally { active -= 1 }
    }))
    // Observe rejections immediately, including waiters that expire before release.
    const settled = Promise.allSettled(attempts)
    const failedFactory = expect(withProcessLock({ path, timeoutMs: 25,
      errorFactory: () => { throw new Error('failure reporter threw') },
    }, async () => 'unreachable')).rejects.toThrow('failure reporter threw')
    for (let index = 0; index < controllers.length; index += 7) controllers[index]!.abort(new Error('cancelled waiter'))
    await expect(withProcessLock({ path: join(root, 'independent.sqlite3'), timeoutMs: 1_000 }, async () => 'independent'))
      .resolves.toBe('independent')
    await expect(attempts[1]).rejects.toThrow('timed out waiting for process lock')
    await failedFactory
    release()
    await owner
    const results = await settled
    const admitted = controllers.flatMap((_, index) => index % 7 !== 0 && index % 10 !== 1 ? [index] : [])
    expect(executed).toEqual(admitted)
    expect(peak).toBe(1)
    expect(active).toBe(0)
    const committed = admitted.filter((index) => index % 11 !== 0)
    expect((await readFile(receipts, 'utf8')).trim().split('\n').map(Number)).toEqual(committed)
    expect(results.flatMap((result, index) => result.status === 'fulfilled' ? [index] : [])).toEqual(committed)
    await expect(withProcessLock({ path, timeoutMs: 1_000 }, async () => 'recovered')).resolves.toBe('recovered')
  } finally {
    release()
    await owner
    await rm(root, { recursive: true, force: true })
  }
})
