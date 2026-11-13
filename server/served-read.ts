// An expensive read shared by everyone asking at once, and answered from its
// last result while a fresh one takes longer than a reader should wait: the
// fresh result serves the next reader. A last result too old is never served;
// the reader waits for the fresh one then.

export interface ServedRead<T> { running: Promise<T> | null, last: { value: T, at: number } | null }

export function servedRead<T>(state: ServedRead<T>, compute: () => Promise<T>,
  options: { waitMs: number, servedMs: number, now?: () => number }): Promise<T> {
  const now = options.now ?? Date.now
  const running = state.running ??= compute()
    .then((value) => { state.last = { value, at: now() }; return value })
    .finally(() => { state.running = null })
  // A reader answered from the last result no longer waits on this one.
  running.catch(() => undefined)
  const last = state.last
  if (!last || now() - last.at >= options.servedMs) return running
  return Promise.race([running, new Promise<T>((resolve) => { setTimeout(() => resolve(last.value), options.waitMs).unref?.() })])
}
