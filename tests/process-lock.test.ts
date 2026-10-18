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

it('records monotonic lock wait independently of the wall-clock deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-evidence-'))
  const path = join(root, 'lock.sqlite3')
  const holder = new Database(path)
  holder.exec('BEGIN IMMEDIATE')
  const captured = vi.spyOn(logging, 'diagnosticFailure').mockReturnValue('fixture')
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(10_999.65).mockReturnValueOnce(10_000.25)
  const wall = vi.spyOn(Date, 'now').mockReturnValue(11_000).mockReturnValueOnce(10_000)
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
