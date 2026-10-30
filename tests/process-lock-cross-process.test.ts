import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { withProcessLock } from '../server/process-lock'

it.each(['release', 'crash'] as const)('retains cross-process exclusion and recovers after an external owner %s', async (outcome) => {
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-process-'))
  const path = join(root, 'lock.sqlite3')
  const child = spawn(process.execPath, ['-e', `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.send('held');
    process.on('message', (outcome) => {
      if (outcome === 'crash') process.exit(23);
      db.exec('ROLLBACK'); db.close(); process.exit(0);
    });
  `, path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const exited = once(child, 'exit')
  let attempt: Promise<string> | undefined
  try {
    expect((await once(child, 'message'))[0]).toBe('held')
    await expect(withProcessLock({ path, timeoutMs: 50 }, async () => 'unreachable'))
      .rejects.toThrow('timed out waiting for process lock')
    const callback = vi.fn(async () => 'acquired after external owner')
    attempt = withProcessLock({ path, timeoutMs: 2_000 }, callback)
    await expect(withProcessLock({ path: join(root, 'independent.sqlite3') }, async () => 'independent'))
      .resolves.toBe('independent')
    expect(callback).not.toHaveBeenCalled()
    child.send(outcome)
    await expect(attempt).resolves.toBe('acquired after external owner')
    expect(callback).toHaveBeenCalledOnce()
    expect((await exited)[0]).toBe(outcome === 'crash' ? 23 : 0)
  } finally {
    if (child.exitCode === null) child.kill()
    await exited
    await attempt?.catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
