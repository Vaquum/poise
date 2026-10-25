import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import globalSetup from './e2e/global-setup'
import {
  acquireE2ERunLock,
  currentE2ELockHolder,
  E2E_LOCK_FILENAME,
  e2eLockDirectory,
  releaseE2ERunLock,
} from './fixtures/e2e-run-lock.mjs'

const directories: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'poise-e2e-lock-'))
  directories.push(dir)
  return dir
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('acquires and releases, calling onWait only when it waits', async () => {
  const dir = freshDir()
  const onWait = vi.fn()
  const lock = await acquireE2ERunLock({ dir, onWait })
  expect(lock).toMatchObject({ dir, path: join(dir, E2E_LOCK_FILENAME) })
  expect(onWait).not.toHaveBeenCalled()
  const holder = JSON.parse(readFileSync(lock.path, 'utf8')) as { pid: number, token: string }
  expect(holder).toMatchObject({ pid: process.pid, token: lock.token })
  expect(readdirSync(dir).filter((entry) => entry.endsWith('.claim'))).toEqual([])

  releaseE2ERunLock(lock)
  expect(existsSync(lock.path)).toBe(false)
  expect(readdirSync(dir)).toEqual([])
})

it('waits for a live holder, then times out naming it', async () => {
  const dir = freshDir()
  const held = await acquireE2ERunLock({ dir })
  try {
    const onWait = vi.fn()
    const error = await acquireE2ERunLock({ dir, timeoutMs: 150, pollMs: 10, onWait }).then(
      () => null,
      (failure) => failure as Error,
    )
    expect(error?.message).toContain('Timed out after 150ms')
    expect(error?.message).toContain(`held by pid ${process.pid}`)
    expect(error?.message).toContain(E2E_LOCK_FILENAME)
    expect(onWait).toHaveBeenCalledTimes(1)
    expect(onWait).toHaveBeenCalledWith(process.pid)
    expect(existsSync(held.path)).toBe(true)
  } finally {
    releaseE2ERunLock(held)
  }
})

it('releases only the lock its own token holds', async () => {
  const dir = freshDir()
  const lock = await acquireE2ERunLock({ dir })
  releaseE2ERunLock({ ...lock, token: 'not-ours' })
  expect(existsSync(lock.path)).toBe(true)
  releaseE2ERunLock(lock)
  expect(existsSync(lock.path)).toBe(false)
  releaseE2ERunLock(lock)
  expect(existsSync(lock.path)).toBe(false)
})

it('steals a lock whose holder is dead and one it cannot read', async () => {
  const dir = freshDir()
  const dead = spawnSync(process.execPath, ['--version']).pid!
  writeFileSync(join(dir, E2E_LOCK_FILENAME), JSON.stringify({ pid: dead, startTime: null, token: 'dead', createdAt: 'then' }))
  const stolen = await acquireE2ERunLock({ dir })
  expect(JSON.parse(readFileSync(stolen.path, 'utf8'))).toMatchObject({ pid: process.pid, token: stolen.token })
  releaseE2ERunLock(stolen)

  writeFileSync(join(dir, E2E_LOCK_FILENAME), 'half-written{')
  const replaced = await acquireE2ERunLock({ dir })
  expect(JSON.parse(readFileSync(replaced.path, 'utf8'))).toMatchObject({ pid: process.pid })
  releaseE2ERunLock(replaced)
})

it('excludes a separate process while held and admits it after release', async () => {
  const dir = freshDir()
  const lock = await acquireE2ERunLock({ dir })
  const attempt = (claim: string): string => {
    writeFileSync(claim, 'child')
    return execFileSync(process.execPath, ['--eval', `
      const { linkSync } = require('node:fs')
      try {
        linkSync(process.env.LOCK_CLAIM, process.env.LOCK_PATH)
        console.log('linked')
      } catch (error) {
        console.log(error.code)
        if (error.code !== 'EEXIST') process.exit(1)
      }
    `], { encoding: 'utf8', env: { ...process.env, LOCK_CLAIM: claim, LOCK_PATH: lock.path } }).trim()
  }
  try {
    expect(attempt(join(dir, 'child-a.claim'))).toBe('EEXIST')
  } finally {
    releaseE2ERunLock(lock)
  }
  expect(attempt(join(dir, 'child-b.claim'))).toBe('linked')
})

it('removes stale claims of dead processes and keeps live ones', async () => {
  const dir = freshDir()
  const dead = spawnSync(process.execPath, ['--version']).pid!
  const stale = join(dir, `.browser-e2e.${dead}.abcdef0123456789.claim`)
  const live = join(dir, `.browser-e2e.${process.pid}.abcdef0123456789.claim`)
  writeFileSync(stale, 'stale')
  writeFileSync(live, 'live')
  const lock = await acquireE2ERunLock({ dir })
  try {
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(live)).toBe(true)
  } finally {
    releaseE2ERunLock(lock)
  }
})

it('resolves the lock directory from POISE_LOCK_DIR or the home folder', () => {
  vi.stubEnv('POISE_LOCK_DIR', '/tmp/poise-locks-test')
  expect(e2eLockDirectory()).toBe('/tmp/poise-locks-test')
  vi.stubEnv('POISE_LOCK_DIR', '')
  expect(e2eLockDirectory()).toBe(join(homedir(), '.poise', 'locks'))
})

it('reports the current holder only while the lock is held', async () => {
  const dir = freshDir()
  expect(currentE2ELockHolder(dir)).toBeNull()
  const lock = await acquireE2ERunLock({ dir })
  try {
    expect(currentE2ELockHolder(dir)).toMatchObject({ pid: process.pid, token: lock.token })
  } finally {
    releaseE2ERunLock(lock)
  }
  expect(currentE2ELockHolder(dir)).toBeNull()
})

it('leaves a wrapper-held lock to the wrapper and contends with any other', async () => {
  const dir = freshDir()
  vi.stubEnv('POISE_LOCK_DIR', dir)
  const ci = process.env.CI
  delete process.env.CI
  const lock = await acquireE2ERunLock({ dir })
  try {
    vi.stubEnv('POISE_E2E_LOCK_ID', lock.token)
    const adopted = await globalSetup()
    expect(typeof adopted).toBe('function')
    await adopted!()
    expect(currentE2ELockHolder(dir)?.token).toBe(lock.token)

    vi.stubEnv('POISE_E2E_LOCK_ID', 'not-this-run')
    vi.stubEnv('POISE_E2E_LOCK_TIMEOUT_MS', '150')
    await expect(globalSetup()).rejects.toThrow(/Timed out after 150ms/)
    expect(currentE2ELockHolder(dir)?.token).toBe(lock.token)
  } finally {
    if (ci === undefined) delete process.env.CI
    else process.env.CI = ci
    releaseE2ERunLock(lock)
  }
})

it('skips the lock on CI and takes it locally, releasing on teardown', async () => {
  const dir = freshDir()
  vi.stubEnv('POISE_LOCK_DIR', dir)
  vi.stubEnv('CI', 'true')
  await expect(globalSetup()).resolves.toBeUndefined()
  expect(existsSync(join(dir, E2E_LOCK_FILENAME))).toBe(false)

  const ci = process.env.CI
  delete process.env.CI
  try {
    const teardown = await globalSetup()
    expect(typeof teardown).toBe('function')
    expect(existsSync(join(dir, E2E_LOCK_FILENAME))).toBe(true)
    await teardown!()
    expect(existsSync(join(dir, E2E_LOCK_FILENAME))).toBe(false)
  } finally {
    if (ci === undefined) delete process.env.CI
    else process.env.CI = ci
  }
})
