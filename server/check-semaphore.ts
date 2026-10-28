// One process-wide budget for heavy work. Poise-local agent turns and the
// agent runs background behaviors launch share these slots, so concurrent
// full builds and test suites cannot pile past the cap no matter which
// surface started them. Waiting is FIFO within a lane; the person lane goes
// first and keeps one slot free while the budget holds at least two, so an
// interactive turn never queues behind background work. Chat turns on the
// background lane leave one more slot for behavior runs while the
// background budget holds two, so worker load cannot starve the reviews
// and approvals that finish the workers' own work. Best-effort across
// processes: a second server during an update overlap holds its own budget.
export type CheckLane = 'person' | 'background' | 'behavior'

export const DEFAULT_CHECK_SLOT_CAP = 4

/** Background holdings stay this far below the cap while the cap holds two. */
const PERSON_RESERVE = 1

/** Chat-turn holdings stay this far below the background budget while that
 *  budget holds two, so a behavior run can always start. */
const BEHAVIOR_RESERVE = 1

export interface CheckSlotStats {
  cap: number
  running: number
  personRunning: number
  backgroundRunning: number
  behaviorRunning: number
  queued: number
  oldestQueueAgeMs: number
  maxWaitMs: number
}

export interface CheckSlotAcquireOptions {
  signal?: AbortSignal
  /** Runs synchronously when the caller parks; never on the fast path. */
  onQueued?: () => void
  /** Builds the rejection when the signal aborts a parked waiter. */
  abortError?: () => Error
}

interface CheckSlotWaiter {
  lane: CheckLane
  enqueuedAtMs: number
  signal?: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  onAbort: () => void
}

/** Fail-fast error when a behavior launch finds the shared budget full. */
export function checkSlotsBusyError(cap: number): Error {
  return new Error(`all ${cap} shared check slots are busy; will retry`)
}

export class CheckSemaphore {
  private holdings = 0
  private personHoldings = 0
  private backgroundHoldings = 0
  private behaviorHoldings = 0
  private readonly waiters: CheckSlotWaiter[] = []
  private readonly releaseListeners = new Set<() => void>()
  private maxWaitMs = 0

  constructor(private readonly capGetter: () => number) {}

  private liveCap(): number {
    const cap = Math.floor(this.capGetter())
    return Number.isSafeInteger(cap) && cap >= 1 ? cap : 1
  }

  private backgroundLimit(cap: number): number {
    return cap - (cap >= 2 ? PERSON_RESERVE : 0)
  }

  private chatTurnLimit(cap: number): number {
    const background = this.backgroundLimit(cap)
    return background - (background >= 2 ? BEHAVIOR_RESERVE : 0)
  }

  private fits(lane: CheckLane, cap: number): boolean {
    if (this.holdings >= cap) return false
    if (lane === 'person') return true
    if (this.backgroundHoldings + this.behaviorHoldings >= this.backgroundLimit(cap)) return false
    return lane === 'behavior' || this.backgroundHoldings < this.chatTurnLimit(cap)
  }

  private take(lane: CheckLane): () => void {
    this.holdings += 1
    if (lane === 'person') this.personHoldings += 1
    else if (lane === 'background') this.backgroundHoldings += 1
    else this.behaviorHoldings += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.holdings -= 1
      if (lane === 'person') this.personHoldings -= 1
      else if (lane === 'background') this.backgroundHoldings -= 1
      else this.behaviorHoldings -= 1
      this.grant()
      for (const listener of this.releaseListeners) listener()
    }
  }

  /** Runs the listener after a holding releases and parked waiters grant.
   *  Returns an unsubscribe. Releases arrive in bursts when turns settle
   *  together, so a listener that schedules work must coalesce. */
  onRelease(listener: () => void): () => void {
    this.releaseListeners.add(listener)
    return () => { this.releaseListeners.delete(listener) }
  }

  /** Lane ceiling for durable admissions that outlive this process. */
  laneCapacity(lane: CheckLane): number {
    const cap = this.liveCap()
    return lane === 'person' ? cap : lane === 'behavior' ? this.backgroundLimit(cap) : this.chatTurnLimit(cap)
  }

  /** True when the lane could take a slot now, after earlier waiters. */
  available(lane: CheckLane): boolean {
    this.grant()
    return this.fits(lane, this.liveCap())
  }

  /** Take a slot or return null; earlier waiters are granted first. */
  tryAcquire(lane: CheckLane): (() => void) | null {
    this.grant()
    if (!this.fits(lane, this.liveCap())) return null
    return this.take(lane)
  }

  /** Take a slot immediately, even past the cap: an adopted turn already
   *  runs, so admission control counts it but never parks it. Parked
   *  waiters keep waiting until releases converge back within the cap. */
  claim(lane: CheckLane): () => void {
    return this.take(lane)
  }

  /** Take a slot, parking in lane FIFO order when none fits. */
  acquire(lane: CheckLane, options: CheckSlotAcquireOptions = {}): Promise<() => void> {
    const { signal } = options
    this.grant()
    if (this.fits(lane, this.liveCap())) return Promise.resolve(this.take(lane))
    // A turn stopped before it reaches the queue must never park: its abort
    // already fired, so the waiter's listener below would never wake it again.
    signal?.throwIfAborted()
    return new Promise<() => void>((resolve, reject) => {
      const waiter: CheckSlotWaiter = {
        lane,
        enqueuedAtMs: Date.now(),
        signal,
        resolve,
        reject,
        onAbort: () => {
          const at = this.waiters.indexOf(waiter)
          if (at >= 0) {
            this.waiters.splice(at, 1)
            signal?.removeEventListener('abort', waiter.onAbort)
            reject(options.abortError?.() ?? new Error('check slot wait aborted'))
          }
        },
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      options.onQueued?.()
    })
  }

  /** Hand free slots to parked waiters, person lane first, FIFO per lane. */
  grant(): void {
    const cap = this.liveCap()
    for (const lane of ['person', 'behavior', 'background'] as const) {
      while (this.fits(lane, cap)) {
        const at = this.waiters.findIndex((waiter) => waiter.lane === lane)
        if (at < 0) break
        const [waiter] = this.waiters.splice(at, 1)
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
        const release = this.take(lane)
        this.maxWaitMs = Math.max(this.maxWaitMs, Date.now() - waiter.enqueuedAtMs)
        waiter.resolve(release)
      }
    }
  }

  stats(nowMs: number = Date.now()): CheckSlotStats {
    const cap = this.liveCap()
    const oldest = this.waiters.length === 0
      ? 0
      : Math.max(0, nowMs - Math.min(...this.waiters.map((waiter) => waiter.enqueuedAtMs)))
    return {
      cap,
      running: this.holdings,
      personRunning: this.personHoldings,
      backgroundRunning: this.backgroundHoldings,
      behaviorRunning: this.behaviorHoldings,
      queued: this.waiters.length,
      oldestQueueAgeMs: oldest,
      maxWaitMs: this.maxWaitMs,
    }
  }
}
