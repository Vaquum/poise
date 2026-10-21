// The time zone every Poise time is shown in (src/config.ts): the one saved in
// Settings when this browser knows it, and the browser's own otherwise, with
// an unknown saved one named so the page can say so.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectiveTimezone, getSettings, setLocalSettings, unknownSavedTimezone, type AppSettings } from '../src/config'

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
let saved: AppSettings

beforeEach(() => { saved = getSettings() })
afterEach(() => setLocalSettings(saved))

describe('the time zone times are shown in', () => {
  it('is the saved one when this browser knows it', () => {
    setLocalSettings({ org: '', me: '', timezone: 'Europe/Helsinki' })
    expect(effectiveTimezone()).toBe('Europe/Helsinki')
    expect(unknownSavedTimezone()).toBeNull()
  })

  it("is the browser's own when the saved one is unknown, which is named", () => {
    setLocalSettings({ org: '', me: '', timezone: 'Mars/Olympus' })
    expect(effectiveTimezone()).toBe(browserZone)
    expect(unknownSavedTimezone()).toBe('Mars/Olympus')
  })

  it("is the browser's own while none is saved, with nothing to name", () => {
    setLocalSettings({ org: '', me: '', timezone: '' })
    expect(effectiveTimezone()).toBe(browserZone)
    expect(unknownSavedTimezone()).toBeNull()
  })

  it('is the saved one as saved when Intl knows it in another letter case', () => {
    setLocalSettings({ org: '', me: '', timezone: 'europe/helsinki' })
    expect(effectiveTimezone()).toBe('europe/helsinki')
    expect(unknownSavedTimezone()).toBeNull()
  })

  it('names a saved zone with spaces around it, which Intl refuses, as saved', () => {
    setLocalSettings({ org: '', me: '', timezone: ' Europe/Helsinki ' })
    expect(effectiveTimezone()).toBe(browserZone)
    expect(unknownSavedTimezone()).toBe(' Europe/Helsinki ')
  })

  // Whether Intl knows a name is remembered per name; the browser's own zone
  // is read on every call.
  it('answers each name the same way as the saved one changes back and forth', () => {
    for (const zone of ['Mars/Olympus', 'Europe/Helsinki', 'Mars/Olympus', 'Europe/Helsinki']) {
      setLocalSettings({ org: '', me: '', timezone: zone })
      expect([effectiveTimezone(), unknownSavedTimezone()]).toEqual(zone === 'Mars/Olympus' ? [browserZone, 'Mars/Olympus'] : ['Europe/Helsinki', null])
    }
  })
})
