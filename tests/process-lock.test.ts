import Database from 'better-sqlite3'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, it, vi } from 'vitest'
import * as logging from '../server/logging'
import { withProcessLock } from '../server/process-lock'

it('releases an empty reservation without falsely failing an already committed file write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-release-'))
  const path = join(root, 'lock.sqlite3')
  let observer: InstanceType<typeof Database> | undefined
  try {
    const result = withProcessLock({ path }, async () => {
      observer = new Database(path, { timeout: 0 })
      observer.exec('BEGIN')
      observer.prepare('SELECT name FROM sqlite_master').all()
      await writeFile(join(root, 'saved.txt'), 'durable result')
      return 'saved'
    })
    await expect(result).resolves.toBe('saved')
    expect(await readFile(join(root, 'saved.txt'), 'utf8')).toBe('durable result')
    await expect(withProcessLock({ path }, async () => 'next writer')).resolves.toBe('next writer')
  } finally {
    if (observer?.inTransaction) observer.exec('ROLLBACK')
    observer?.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('bounds a contender behind a delayed holder without invoking its callback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-contention-'))
  const path = join(root, 'lock.sqlite3')
  try {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holder = withProcessLock({ path }, async () => {
      await gate
      return 'held'
    })
    // The holder owns the reservation before the contender starts trying.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const began = performance.now()
    await expect(withProcessLock({ path, timeoutMs: 500 }, async () => 'unreachable'))
      .rejects.toThrow('timed out waiting for process lock')
    const waitedMs = performance.now() - began
    expect(waitedMs).toBeLessThan(5_000)
    release()
    await expect(holder).resolves.toBe('held')
    await expect(withProcessLock({ path, timeoutMs: 1000 }, async () => 'next writer')).resolves.toBe('next writer')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('releases the reservation when the holder callback fails or the wait is cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-release-'))
  const path = join(root, 'lock.sqlite3')
  try {
    await expect(withProcessLock({ path }, async () => { throw new Error('holder blew up') }))
      .rejects.toThrow('holder blew up')
    await expect(withProcessLock({ path, timeoutMs: 1000 }, async () => 'after failure')).resolves.toBe('after failure')
    const controller = new AbortController()
    const holder = withProcessLock({ path }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return 'held'
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const cancelled = withProcessLock({ path, timeoutMs: 30_000, signal: controller.signal }, async () => 'unreachable')
    controller.abort(new Error('tick superseded'))
    await expect(cancelled).rejects.toThrow('tick superseded')
    await expect(holder).resolves.toBe('held')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('fails fast on permanent errors and isolates unrelated lock paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-errors-'))
  try {
    await writeFile(join(root, 'blocker'), 'not a directory')
    const began = performance.now()
    await expect(withProcessLock({ path: join(root, 'blocker', 'lock.sqlite3'), timeoutMs: 5000 }, async () => 'unreachable'))
      .rejects.toThrow('process lock is unavailable')
    expect(performance.now() - began).toBeLessThan(5_000)
    await rm(join(root, 'blocker'))
    await expect(withProcessLock({ path: join(root, 'blocker', 'lock.sqlite3') }, async () => 'repaired'))
      .resolves.toBe('repaired')
    const first = join(root, 'a.sqlite3')
    const second = join(root, 'b.sqlite3')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holder = withProcessLock({ path: first }, async () => {
      await gate
      return 'held'
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(withProcessLock({ path: second, timeoutMs: 1000 }, async () => 'independent')).resolves.toBe('independent')
    release()
    await expect(holder).resolves.toBe('held')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('records monotonic lock wait independently of the wall-clock deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-evidence-'))
  const path = join(root, 'lock.sqlite3')
  const holder = new Database(path)
  holder.exec('BEGIN IMMEDIATE')
  const captured = vi.spyOn(logging, 'diagnosticFailure').mockReturnValue('fixture')
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(10_999.65).mockReturnValueOnce(10_000.25)
  const wall = vi.spyOn(Date, 'now').mockReturnValue(11_000).mockReturnValueOnce(10_000).mockReturnValueOnce(10_000)
  const operation = vi.fn(async () => 'unreachable')
  try {
    const attempt = withProcessLock({ path, timeoutMs: 1000 }, operation)
    await expect(attempt).rejects.toThrow('timed out waiting for process lock')
    expect(captured).toHaveBeenCalledWith('process_lock.acquire', expect.objectContaining({ code: 'SQLITE_BUSY' }),
      expect.objectContaining({ lockPath: path, phase: 'acquisition', waitLimitMs: 1000, holderPid: null, holderIdentityVerified: false }), { level: 'warning' })
    const context = captured.mock.calls[0][2]!
    expect(context.elapsedMs).toBe(999)
    expect(operation).not.toHaveBeenCalled()
  } finally { wall.mockRestore(); monotonic.mockRestore(); captured.mockRestore(); holder.exec('ROLLBACK'); holder.close(); await rm(root, { recursive: true, force: true }) }
})
