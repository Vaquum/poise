// An expensive read shared by everyone asking at once, and answered from its
// last result while a fresh one takes longer than a reader should wait: the
// fresh result serves the next reader. A last result too old is never served,
// and after a refresh fails none is: the next reader waits for the real
// outcome, so a lasting failure reaches it.

export interface ServedRead<T> { running: Promise<T> | null, last: { value: T, at: number } | null, failed?: boolean }

export function servedRead<T>(state: ServedRead<T>, compute: () => Promise<T>,
  options: { waitMs: number, servedMs: number, freshMs?: number, now?: () => number }): Promise<T> {
  const now = options.now ?? Date.now
  // A last result younger than freshMs, which its owner keeps fresh off the
  // readers' path (refreshServed), answers at once without computing.
  const kept = state.last
  if (options.freshMs !== undefined && kept && !state.failed && now() - kept.at < options.freshMs) return Promise.resolve(kept.value)
  const running = state.running ??= compute()
    .then((value) => { state.last = { value, at: now() }; state.failed = false; return value },
      (error: unknown) => { state.failed = true; throw error })
    .finally(() => { state.running = null })
  // A reader answered from the last result no longer waits on this one; its
  // failure is kept in `failed` for the next reader.
  running.catch(() => undefined)
  const last = state.last
  // Served only while it stays younger than servedMs through the whole wait.
  if (!last || state.failed || now() - last.at + options.waitMs >= options.servedMs) return running
  return Promise.race([running, new Promise<T>((resolve) => { setTimeout(() => resolve(last.value), options.waitMs).unref?.() })])
}

/** Starts a fresh computation unless one is running, for an owner that keeps
 *  a read fresh in the background; a failure is kept in `failed`, so the next
 *  reader waits for the real outcome. */
export function refreshServed<T>(state: ServedRead<T>, compute: () => Promise<T>, now: () => number = Date.now): void {
  if (state.running) return
  void servedRead(state, compute, { waitMs: 0, servedMs: 0, now }).catch(() => undefined)
}
