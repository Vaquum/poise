import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { E2E_LOCK_FILENAME } from './fixtures/e2e-run-lock.mjs'

const WRAPPER = resolve('scripts/with-e2e-lock.mjs')
const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'poise-with-e2e-lock-'))
  directories.push(dir)
  return dir
}

/** The wrapper's environment without CI, so it takes the lock in `dir`. */
function lockEnv(dir: string): NodeJS.ProcessEnv {
  const rest = { ...process.env }
  delete rest.CI
  rest.POISE_LOCK_DIR = dir
  return rest
}

function lockPath(dir: string): string {
  return join(dir, E2E_LOCK_FILENAME)
}

it('holds the lock for its child and releases it after', () => {
  const dir = freshDir()
  const claim = join(dir, 'child.claim')
  const output = execFileSync(process.execPath, [WRAPPER, process.execPath, '--eval', `
    const { linkSync, writeFileSync } = require('node:fs')
    writeFileSync(process.env.CHILD_CLAIM, 'child')
    try {
      linkSync(process.env.CHILD_CLAIM, process.env.LOCK_PATH)
      console.log('linked')
    } catch (error) {
      console.log(error.code)
    }
    console.log(process.env.POISE_E2E_LOCK_ID ? 'has-lock-id' : 'no-lock-id')
  `], {
    encoding: 'utf8',
    env: { ...lockEnv(dir), CHILD_CLAIM: claim, LOCK_PATH: lockPath(dir) },
  })
  expect(output.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual(['EEXIST', 'has-lock-id'])
  expect(existsSync(claim)).toBe(true)
  expect(existsSync(lockPath(dir))).toBe(false)
})

it('passes the child exit code through and releases on failure', () => {
  const dir = freshDir()
  let status: number | null = null
  try {
    execFileSync(process.execPath, [WRAPPER, process.execPath, '--eval', 'process.exit(3)'], {
      encoding: 'utf8',
      env: lockEnv(dir),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    status = (error as { status?: number }).status ?? null
  }
  expect(status).toBe(3)
  expect(existsSync(lockPath(dir))).toBe(false)
})

it('steals a stale lock instead of waiting on it', () => {
  const dir = freshDir()
  writeFileSync(lockPath(dir), 'half-written{')
  const output = execFileSync(process.execPath, [WRAPPER, process.execPath, '--eval', 'console.log("ran")'], {
    encoding: 'utf8',
    env: lockEnv(dir),
  })
  expect(output.trim()).toBe('ran')
  expect(existsSync(lockPath(dir))).toBe(false)
})

it('skips the lock on CI', () => {
  const dir = freshDir()
  const output = execFileSync(process.execPath, [WRAPPER, process.execPath, '--eval', `
    console.log(process.env.POISE_E2E_LOCK_ID ? 'has-lock-id' : 'no-lock-id')
  `], {
    encoding: 'utf8',
    env: { ...lockEnv(dir), CI: 'true' },
  })
  expect(output.trim()).toBe('no-lock-id')
  expect(existsSync(lockPath(dir))).toBe(false)
})

it('refuses to run without a child command', () => {
  let status: number | null = null
  let stderr = ''
  try {
    execFileSync(process.execPath, [WRAPPER], { encoding: 'utf8', env: lockEnv(freshDir()) })
  } catch (error) {
    status = (error as { status?: number }).status ?? null
    stderr = String((error as { stderr?: unknown }).stderr ?? '')
  }
  expect(status).toBe(2)
  expect(stderr).toContain('usage:')
})

it('forwards signals to its child and releases the lock', async () => {
  const dir = freshDir()
  const pidFile = join(dir, 'child.pid')
  const child = spawn(process.execPath, [WRAPPER, process.execPath, '--eval', `
    require('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid))
    setTimeout(() => {}, 30000)
  `], {
    env: { ...lockEnv(dir), PID_FILE: pidFile },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 5000
  try {
    while (!existsSync(lockPath(dir)) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25))
    expect(existsSync(lockPath(dir))).toBe(true)
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25))
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    expect(Number.isInteger(grandchild)).toBe(true)
    child.kill('SIGTERM')
    const wrapperSignal = await Promise.race([
      new Promise((resolve) => child.on('exit', (_code, signal) => resolve(signal))),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ])
    expect(wrapperSignal).toBe('SIGTERM')
    let grandchildAlive = true
    while (Date.now() < deadline) {
      try {
        process.kill(grandchild, 0)
      } catch {
        grandchildAlive = false
        break
      }
      await new Promise((done) => setTimeout(done, 25))
    }
    expect(grandchildAlive).toBe(false)
    expect(existsSync(lockPath(dir))).toBe(false)
  } finally {
    child.kill('SIGKILL')
  }
}, 15_000)
