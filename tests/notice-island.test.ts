// The page's side of the notices (src/notices.ts, src/views/notice-island.ts):
// reading the server's answer, which notice the island shows, and what it says.

import { describe, expect, it } from 'vitest'
import { noticesFrom, standingFor, type Notice } from '../src/notices'
import { chooseShown, noticeHtml, noticeMeta } from '../src/views/notice-island'

const T0 = Date.parse('2026-10-09T10:00:00.000Z')
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

function notice(id: string, overrides: Partial<Notice> = {}): Notice {
  return {
    id,
    kind: 'chat_waiting',
    title: 'Claude Code is waiting for you',
    body: 'Allow it?',
    since: iso(0),
    due: iso(0),
    silenceable: false,
    target: { chat: 's1' },
    ...overrides,
  }
}

describe("the server's answer", () => {
  it('is read as the state the island shows', () => {
    const ready = notice('a-2', { kind: 'pr_ready', silenceable: true, target: { pullRequest: 'https://github.com/acme/api/pull/7' } })
    expect(noticesFrom({ enabled: true, notices: [notice('a-1'), ready] })).toEqual({ enabled: true, notices: [notice('a-1'), ready] })
    expect(noticesFrom({ enabled: false, notices: [notice('a-1')] })).toEqual({ enabled: false, notices: [] })
  })

  it('changes nothing when it is not an answer, and leaves out a notice the page cannot show', () => {
    for (const value of [null, {}, [], 'no', { enabled: true }, { enabled: 'yes', notices: [] }, { notices: [] }]) {
      expect(noticesFrom(value), JSON.stringify(value)).toBeNull()
    }
    const unknown = { ...notice('a-2'), kind: 'something_new' }
    const unsafe = notice('a-3', { kind: 'pr_ready', target: { pullRequest: 'javascript:alert(1)' } })
    const undated = { ...notice('a-4'), due: 'soon' }
    expect(noticesFrom({ enabled: true, notices: [notice('a-1'), unknown, unsafe, undated, null] })!.notices.map((n) => n.id)).toEqual(['a-1'])
  })
})

describe('how long a ready pull request has waited', () => {
  it('reads in minutes, then hours and minutes', () => {
    expect(standingFor(iso(0), T0 + 30_000)).toBe('0 min')
    expect(standingFor(iso(0), T0 + 31 * 60_000)).toBe('31 min')
    expect(standingFor(iso(0), T0 + 60 * 60_000)).toBe('1 h')
    expect(standingFor(iso(0), T0 + 125 * 60_000)).toBe('2 h 5 min')
  })

  it('shows only on a reminder, not when the pull request has just become ready', () => {
    const first = notice('a-1', { kind: 'pr_ready', since: iso(0), due: iso(0) })
    const reminder = { ...first, due: iso(15) }
    expect(noticeMeta(first, T0 + 2 * 60_000)).toBe('')
    expect(noticeMeta(reminder, T0 + 16 * 60_000)).toBe('for 16 min')
    expect(noticeMeta(notice('a-2', { due: iso(15) }), T0 + 16 * 60_000)).toBe('')
  })
})

describe('which notice the island shows', () => {
  const a = notice('a')
  const b = notice('b', { kind: 'behavior_held' })
  const c = notice('c', { kind: 'pr_ready', since: iso(0), due: iso(0) })

  it('is the first, until the person steps on', () => {
    expect(chooseShown([], [a, b, c], null)).toBe('a')
    expect(chooseShown([a, b, c], [a, b, c], 'c')).toBe('c')
    expect(chooseShown([a, b, c], [], 'c')).toBeNull()
  })

  it('is the next most pressing once the shown one is put away', () => {
    expect(chooseShown([a, b, c], [b, c], 'a')).toBe('b')
  })

  it('gives way to a more pressing notice that has just arrived or come due again', () => {
    expect(chooseShown([b, c], [a, b, c], 'c')).toBe('a')
    const reminded = { ...b, due: iso(15) }
    expect(chooseShown([a, b, c], [a, reminded, c], 'c')).toBe('b')
    // A less pressing arrival waits its turn.
    const later = notice('d', { kind: 'chat_turn_finished' })
    expect(chooseShown([a, b], [a, b, later], 'b')).toBe('b')
  })
})

describe("a notice's markup", () => {
  it('escapes what the notice says', () => {
    const html = noticeHtml(notice('a', { title: '<img src=x onerror=alert(1)>', body: '"quoted" & <b>bold</b>' }), 0, T0)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;')
  })

  it('opens its target, says where it goes, and offers silence only for a ready pull request', () => {
    const chat = noticeHtml(notice('a'), 2, T0)
    expect(chat).toContain('data-action="open"')
    expect(chat).toContain('aria-label="Claude Code is waiting for you. Allow it? Open the Chat session."')
    expect(chat).not.toContain('data-action="silence"')
    expect(chat).toContain('aria-label="Show the next notification, 2 more">+2</button>')
    expect(chat).toContain('data-action="dismiss"')

    const ready = noticeHtml(notice('b', { kind: 'pr_ready', title: 'acme/api#7 is ready to merge', body: 'Change 7', silenceable: true, target: { pullRequest: 'https://github.com/acme/api/pull/7' } }), 0, T0)
    expect(ready).toContain('data-action="silence"')
    expect(ready).toContain('Open the pull request on GitHub.')
    expect(ready).not.toContain('data-action="next"')
  })

  it('only informs when it has nowhere to go', () => {
    const html = noticeHtml(notice('a', { target: null }), 0, T0)
    expect(html).not.toContain('data-action="open"')
    expect(html).toContain('data-action="dismiss"')
  })
})
