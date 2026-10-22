import { monitorEventLoopDelay } from 'node:perf_hooks'

// How much main-thread stall one behavior tick's CLI fan-out costs, measured
// where it happens: the event loop. The histogram resets every minute so a
// lifetime percentile can't hide top-of-minute spikes.
const WINDOW_MS = 60_000

export interface EventLoopDelayStats {
  p50Ms: number
  p99Ms: number
  maxMs: number
  meanMs: number
  samples: number
}

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null
let windowStartedAtMs = 0

export function eventLoopDelayStats(nowMs = Date.now()): EventLoopDelayStats {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
  }
  if (nowMs - windowStartedAtMs >= WINDOW_MS) {
    histogram.reset()
    windowStartedAtMs = nowMs
  }
  const samples = Number(histogram.count)
  // An empty histogram reports bucket edges, not measurements.
  if (samples === 0) return { p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0, samples: 0 }
  return {
    p50Ms: histogram.percentile(50) / 1e6,
    p99Ms: histogram.percentile(99) / 1e6,
    maxMs: Number(histogram.max) / 1e6,
    meanMs: Number(histogram.mean) / 1e6,
    samples,
  }
}

/** Tests reset the window they measured. */
export function resetEventLoopDelayWindow(nowMs = Date.now()): void {
  histogram?.reset()
  windowStartedAtMs = nowMs
}
