import { describe, expect, it } from 'vitest'
import { durationMs } from '../src/ui/css-duration'

// The tooltip's delay comes from a duration token. The production build writes
// `500ms` as `.5s`, which a bare parseFloat read as half a millisecond (#1378).
describe('duration tokens in milliseconds', () => {
  it('reads the unit, as written and as the build minifies it', () => {
    expect(durationMs('500ms', 0)).toBe(500)
    expect(durationMs('.5s', 0)).toBe(500)
    expect(durationMs(' 0.16s ', 0)).toBe(160)
    expect(durationMs('1s', 0)).toBe(1000)
  })

  it('falls back on anything that is not a duration', () => {
    expect(durationMs('', 500)).toBe(500)
    expect(durationMs('500', 500)).toBe(500)
    expect(durationMs('auto', 500)).toBe(500)
  })
})
