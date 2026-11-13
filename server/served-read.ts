// An expensive read shared by everyone asking at once, and answered from its
// last result while a fresh one takes longer than a reader should wait: the
// fresh result serves the next reader. A last result too old is never served,
// and after a refresh fails none is: the next reader waits for the real
// outcome, so a lasting failure reaches it.

export interface ServedRead<T> { running: Promise<T> | null, last: { value: T, at: number } | null, failed?: boolean }

export function servedRead<T>(state: ServedRead<T>, compute: () => Promise<T>,
  options: { waitMs: number, servedMs: number, now?: () => number }): Promise<T> {
  const now = options.now ?? Date.now
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
