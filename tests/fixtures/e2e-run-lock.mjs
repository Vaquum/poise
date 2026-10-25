// One local browser run at a time per workspace: the lock
// scripts/with-e2e-lock.mjs takes around `npm run test:e2e`, and
// tests/e2e/global-setup.ts takes for a bare `npx playwright test` (whose
// webServer build starts before any setup runs, so the setup lock only
// covers what follows the build). CI shards run concurrently by design and
// never take it.
//
// The claim goes through link(2), which is atomic: the lock path always
// holds one complete holder record, so a concurrent acquirer never reads a
// half-written file and two acquirers never both succeed. A holder its
// process outlived — a killed run, a crashed runner — loses the lock to
// the next acquirer: liveness is the pid, plus its start time where the
// platform reports one, the same fail-closed rule as the checkout lease.

import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const E2E_LOCK_FILENAME = 'browser-e2e.lock'
export const E2E_LOCK_TIMEOUT_MS = 15 * 60_000
export const E2E_LOCK_POLL_MS = 250

/** The root the server's checkout leases share: one workspace, one lock. @returns {string} */
export function e2eLockDirectory() {
  return process.env.POISE_LOCK_DIR || join(homedir(), '.poise', 'locks')
}

/** Field 22 of /proc/<pid>/stat; null where the platform has no /proc. @param {number} pid @returns {string | null} */
function processStartTime(pid) {
  if (process.platform !== 'linux') return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}

/** @param {number} pid @returns {boolean} */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a live process we may not signal.
    return error?.code === 'EPERM'
  }
}

/** @param {{ pid: number, startTime: string | null }} holder @returns {boolean} */
function holderAlive(holder) {
  if (!pidAlive(holder.pid)) return false
  if (holder.startTime === null) return true
  const current = processStartTime(holder.pid)
  // An unreadable start time fails closed to the pid check.
  return current === null || current === holder.startTime
}

/** @param {string} path @returns {{ pid: number, startTime: string | null, token: string, createdAt: string } | null} */
function readHolder(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed?.pid !== 'number' || typeof parsed?.token !== 'string') return null
    return {
      pid: parsed.pid,
      startTime: typeof parsed.startTime === 'string' ? parsed.startTime : null,
      token: parsed.token,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : 'unknown',
    }
  } catch {
    return null
  }
}

/** The current holder of the workspace browser lock, if the lock is held. @param {string} [dir] @returns {{ pid: number, startTime: string | null, token: string, createdAt: string } | null} */
export function currentE2ELockHolder(dir = e2eLockDirectory()) {
  return readHolder(join(dir, E2E_LOCK_FILENAME))
}

const CLAIM_PATTERN = /^\.browser-e2e\.(\d+)\.[0-9a-f]+\.claim$/

/** Claims a violently killed run left behind: only dead pids are removed. @param {string} dir @returns {void} */
function removeStaleClaims(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const pid = Number(CLAIM_PATTERN.exec(entry)?.[1])
    if (Number.isInteger(pid) && !pidAlive(pid)) rmSync(join(dir, entry), { force: true })
  }
}

/** @returns {number | undefined} */
function envTimeoutMs() {
  const raw = process.env.POISE_E2E_LOCK_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** @param {{ dir?: string, timeoutMs?: number, pollMs?: number, onWait?: (holderPid: number) => void }} [options] @returns {Promise<{ dir: string, path: string, token: string }>} */
export async function acquireE2ERunLock(options = {}) {
  const dir = options.dir ?? e2eLockDirectory()
  const timeoutMs = options.timeoutMs ?? envTimeoutMs() ?? E2E_LOCK_TIMEOUT_MS
  const pollMs = options.pollMs ?? E2E_LOCK_POLL_MS
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  removeStaleClaims(dir)
  const path = join(dir, E2E_LOCK_FILENAME)
  const holder = {
    pid: process.pid,
    startTime: processStartTime(process.pid),
    token: randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
  }
  const claim = join(dir, `.browser-e2e.${process.pid}.${holder.token}.claim`)
  writeFileSync(claim, JSON.stringify(holder))
  try {
    const deadline = Date.now() + timeoutMs
    let waited = false
    for (;;) {
      try {
        linkSync(claim, path)
        return { dir, path, token: holder.token }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const current = readHolder(path)
      if (current === null || !holderAlive(current)) {
        // A stale or unreadable holder: the link below decides the steal
        // race, and the loser reads the winner's complete record.
        try {
          unlinkSync(path)
        } catch {
          /* lost the steal race; link again */
        }
        continue
      }
      if (!waited) {
        waited = true
        options.onWait?.(current.pid)
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for the workspace browser lock ${path} (held by pid ${current.pid} since ${current.createdAt}); remove it if the holder is gone.`)
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  } finally {
    rmSync(claim, { force: true })
  }
}

/** Releases a lock this process holds; any other holder's lock is untouched. @param {{ dir: string, path: string, token: string }} lock @returns {void} */
export function releaseE2ERunLock(lock) {
  if (readHolder(lock.path)?.token !== lock.token) return
  try {
    unlinkSync(lock.path)
  } catch {
    /* already gone */
  }
}
