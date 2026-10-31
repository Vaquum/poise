export const E2E_LOCK_FILENAME: string
export const E2E_LOCK_TIMEOUT_MS: number
export const E2E_LOCK_POLL_MS: number
export interface E2ERunLock {
  dir: string
  path: string
  token: string
}
export interface E2ELockHolder {
  pid: number
  startTime: string | null
  token: string
  createdAt: string
}
export interface AcquireE2ERunLockOptions {
  dir?: string
  timeoutMs?: number
  pollMs?: number
  /** Called once, with the holder's pid, when this call has to wait. */
  onWait?: (holderPid: number) => void
}
export function e2eLockDirectory(): string
export function currentE2ELockHolder(dir?: string): E2ELockHolder | null
export function acquireE2ERunLock(options?: AcquireE2ERunLockOptions): Promise<E2ERunLock>
export function releaseE2ERunLock(lock: E2ERunLock): void
