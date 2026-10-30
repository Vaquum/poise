// A Chat turn's footer duration (fmtDuration in src/views/chat-transcript.ts):
// whole seconds rounded before the minutes are taken, so a turn never
// shows 60 seconds.

import { describe, expect, it } from 'vitest'
import { fmtDuration } from '../src/views/chat-transcript'

describe("a Chat turn's duration", () => {
  it('carries rounded-up seconds into the minutes, never showing 60s', () => {
    expect(fmtDuration(779_600)).toBe('13m 0s')
    expect(fmtDuration(3_599_600)).toBe('60m 0s')
    expect(fmtDuration(3_599_600)).not.toBe('59m 60s')
    expect(fmtDuration(3_599_600)).not.toBe('60m')
  })

  it('shows a minute, not 60 seconds, past the minute boundary', () => {
    expect(fmtDuration(59_600)).toBe('1m 0s')
  })

  it('renders durations away from a boundary exactly as before', () => {
    expect(fmtDuration(4_200)).toBe('4.2s')
    expect(fmtDuration(31_500)).toBe('32s')
    expect(fmtDuration(42_800)).toBe('43s')
    expect(fmtDuration(90_000)).toBe('1m 30s')
    expect(fmtDuration(754_000)).toBe('12m 34s')
    expect(fmtDuration(3_600_000)).toBe('60m 0s')
  })
})
