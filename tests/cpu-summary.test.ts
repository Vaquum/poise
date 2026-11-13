import { describe, expect, it } from 'vitest'
import { captureCpuSummary, summariseProfile, type Profile } from '../server/cpu-summary'

describe('CPU summary', () => {
  it('splits a profile into idle, GC and program time, and each function by itself and with what it called', () => {
    // 100 hits over 100 ms: one millisecond each.
    const profile: Profile = { startTime: 0, endTime: 100_000, nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, hitCount: 0, children: [2, 3, 4, 5] },
      { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 }, hitCount: 40 },
      { id: 3, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 }, hitCount: 10 },
      { id: 4, callFrame: { functionName: '(program)', url: '', lineNumber: -1 }, hitCount: 5 },
      { id: 5, callFrame: { functionName: 'handleApi', url: 'file:///opt/poise/dist/server.js', lineNumber: 99 }, hitCount: 5, children: [6, 7] },
      { id: 6, callFrame: { functionName: 'projectAnalyticsHealth', url: 'file:///opt/poise/dist/server.js', lineNumber: 199 }, hitCount: 30, children: [8] },
      { id: 7, callFrame: { functionName: 'JSON.parse', url: '', lineNumber: -1 }, hitCount: 5 },
      // A recursive call is counted once in its function's total.
      { id: 8, callFrame: { functionName: 'projectAnalyticsHealth', url: 'file:///opt/poise/dist/server.js', lineNumber: 199 }, hitCount: 5 },
    ] }
    const summary = summariseProfile(profile)
    expect(summary).toMatchObject({ durationMs: 100, samples: 100, idleMs: 40, gcMs: 10, programMs: 5 })
    expect(summary.self[0]).toEqual({ fn: 'projectAnalyticsHealth', at: 'server.js:200', ms: 35 })
    expect(summary.total.find((entry) => entry.fn === 'handleApi')).toEqual({ fn: 'handleApi', at: 'server.js:100', ms: 45 })
    expect(summary.total.find((entry) => entry.fn === 'projectAnalyticsHealth')!.ms).toBe(35)
  })

  it('samples this process for the seconds asked, one capture at a time', async () => {
    const busy = () => { const end = Date.now() + 200; let n = 0; while (Date.now() < end) n += Math.sqrt(n + 1); return n }
    const capture = captureCpuSummary(1)
    await expect(captureCpuSummary(1)).rejects.toThrow('already being taken')
    setTimeout(busy, 100)
    const summary = await capture
    expect(summary.durationMs).toBeGreaterThanOrEqual(900)
    expect(summary.samples).toBeGreaterThan(0)
    expect(summary.self.length + summary.idleMs).toBeGreaterThan(0)
  }, 10_000)
})
