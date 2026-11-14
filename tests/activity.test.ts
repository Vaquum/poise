import { describe, expect, it, vi } from 'vitest'
import { ACTIVITY_PATH, ACTIVITY_REPORT_MS, reportActivity } from '../src/activity'

function page() {
  const listeners = new Map<string, () => void>()
  return {
    document: { visibilityState: 'visible' as DocumentVisibilityState },
    fetch: vi.fn(async () => new Response(null, { status: 204 })),
    addEventListener: vi.fn((type: string, listener: () => void) => { listeners.set(type, listener) }),
    removeEventListener: vi.fn((type: string) => { listeners.delete(type) }),
    input: (type: string) => listeners.get(type)?.(),
    listeners,
  }
}

describe('activity reports', () => {
  it('reports input at most once every half minute, and only from a visible page', () => {
    let now = 0
    const target = page()
    const stop = reportActivity(target as unknown as Parameters<typeof reportActivity>[0], () => now)
    target.input('pointerdown')
    target.input('keydown')
    expect(target.fetch).toHaveBeenCalledTimes(1)
    expect(target.fetch).toHaveBeenCalledWith(ACTIVITY_PATH, { method: 'POST', keepalive: true })
    now += ACTIVITY_REPORT_MS
    target.input('wheel')
    expect(target.fetch).toHaveBeenCalledTimes(2)
    now += ACTIVITY_REPORT_MS
    target.document.visibilityState = 'hidden'
    target.input('touchstart')
    expect(target.fetch).toHaveBeenCalledTimes(2)
    stop()
    expect(target.listeners.size).toBe(0)
  })
})
