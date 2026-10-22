import { monitorEventLoopDelay } from 'node:perf_hooks'

// How much main-thread stall one behavior tick's CLI fan-out costs, measured
// where it happens: the event loop. One workspace-level monitor rotates on a
// fixed cadence, so every reader — service health, behavior diagnostics —
// sees the same bounded window, and a minute reset can't dilute an isolated
// multi-second stall out of p99. Maximum delay is the stall signal; p99
// alone would miss it.
const WINDOW_MS = 60_000

export interface EventLoopDelayStats {
  p50Ms: number
  p99Ms: number
  maxMs: number
  meanMs: number
  samples: number
  windowStartedAt: string
}

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null
let windowStartedAtMs = 0

function monitor(nowMs: number): ReturnType<typeof monitorEventLoopDelay> {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 20 })
    histogram.enable()
    windowStartedAtMs = nowMs
    const rotation = setInterval(() => {
      histogram?.reset()
      windowStartedAtMs = Date.now()
    }, WINDOW_MS)
    rotation.unref()
  }
  return histogram
}

export function eventLoopDelayStats(nowMs = Date.now()): EventLoopDelayStats {
  const active = monitor(nowMs)
  const samples = Number(active.count)
  const windowStartedAt = new Date(windowStartedAtMs).toISOString()
  // An empty histogram reports bucket edges, not measurements; zero samples
  // is missing coverage, distinct from a measured zero delay.
  if (samples === 0) return { p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0, samples: 0, windowStartedAt }
  return {
    p50Ms: active.percentile(50) / 1e6,
    p99Ms: active.percentile(99) / 1e6,
    maxMs: Number(active.max) / 1e6,
    meanMs: Number(active.mean) / 1e6,
    samples,
    windowStartedAt,
  }
}

/** Tests reset the window they measured. */
export function resetEventLoopDelayWindow(nowMs = Date.now()): void {
  monitor(nowMs)
  histogram?.reset()
  windowStartedAtMs = nowMs
}
