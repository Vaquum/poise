import { describe, expect, it } from 'vitest'
import { eventLoopDelayStats, resetEventLoopDelayWindow } from '../server/event-loop-delay'

describe('event-loop delay monitor', () => {
  it('reports an isolated stall in maximum delay even when p99 stays low', async () => {
    resetEventLoopDelayWindow()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const start = Date.now()
    while (Date.now() - start < 200) {
      // Deliberate main-thread stall: sampling sees delayed observations.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const stats = eventLoopDelayStats()
    expect(stats.samples).toBeGreaterThan(50)
    expect(stats.maxMs).toBeGreaterThan(150)
    expect(stats.p99Ms).toBeLessThan(100)
    expect(stats.windowStartedAt).toEqual(expect.any(String))
  })

  it('reports missing coverage distinctly from a measured delay', () => {
    resetEventLoopDelayWindow()
    const stats = eventLoopDelayStats()
    expect(stats.samples).toBe(0)
    expect(stats.maxMs).toBe(0)
  })
})
