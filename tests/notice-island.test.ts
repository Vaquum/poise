// The page's side of the notices (src/notices.ts, src/views/notice-island.ts):
// reading the server's answer, which notice the island shows, and what it says.

import { describe, expect, it } from 'vitest'
import { NoticeFeed, noticesFrom, sendLatest, standingFor, type Notice } from '../src/notices'
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

describe('the notices this tab shows', () => {
  interface Call { url: string, method: string, answer: (body: unknown) => void, fail: (error: Error) => void }
  function server() {
    const calls: Call[] = []
    const request = ((url: string, init?: RequestInit) => new Promise((resolve, reject) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        answer: (body) => resolve({ ok: true, status: 200, json: async () => body }),
        fail: reject,
      })
    })) as unknown as typeof fetch
    return { calls, request }
  }
  const state = (...notices: Notice[]) => ({ enabled: true, notices })
  const ids = (feed: NoticeFeed) => feed.current.notices.map((item) => item.id)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const a = notice('a')
  const b = notice('b', { kind: 'behavior_held' })
  const c = notice('c', { kind: 'pr_ready', due: iso(15) })

  async function shown(...notices: Notice[]) {
    const { calls, request } = server()
    const feed = new NoticeFeed(request)
    const first = feed.read()
    calls[0].answer(state(...notices))
    await first
    return { calls, feed }
  }

  it('keeps a notice put away when a read sent before answers after', async () => {
    const { calls, feed } = await shown(a, b)
    const late = feed.read()
    const dismissed = feed.dismiss('a')
    expect(ids(feed)).toEqual(['b'])
    expect([calls[1].method, calls[2].method, calls[2].url]).toEqual(['GET', 'POST', '/api/notices/a/dismiss'])
    calls[2].answer(state(b))
    await dismissed
    calls[1].answer(state(a, b))
    await late
    expect(ids(feed)).toEqual(['b'])
  })

  it('keeps it away when a read sent meanwhile was answered before the server took it, until a later read', async () => {
    const { calls, feed } = await shown(a, b)
    const dismissed = feed.dismiss('a')
    const meanwhile = feed.read()
    calls[2].answer(state(a, b))
    await meanwhile
    expect(ids(feed)).toEqual(['b'])
    calls[1].answer(state(b))
    await dismissed
    expect(ids(feed)).toEqual(['b'])
    // Once a read sent after the server took it answers, the server alone decides.
    const after = feed.read()
    calls[3].answer(state(a, b))
    await after
    expect(ids(feed)).toEqual(['a', 'b'])
  })

  it('lets the later of two actions stand over the earlier one answered last', async () => {
    const { calls, feed } = await shown(a, b, c)
    const first = feed.dismiss('a')
    const second = feed.silence('b')
    expect(calls[2].url).toBe('/api/notices/b/silence')
    calls[2].answer(state(c))
    await second
    calls[1].answer(state(b, c))
    await first
    expect(ids(feed)).toEqual(['c'])
  })

  it('shows a notice again when putting it away failed', async () => {
    const { calls, feed } = await shown(a, b)
    const dismissed = feed.dismiss('a')
    expect(ids(feed)).toEqual(['b'])
    calls[1].fail(new Error('offline'))
    await settle()
    calls[2].answer(state(a, b))
    await dismissed
    expect(ids(feed)).toEqual(['a', 'b'])
  })

  it('reads anew after a change, never trusting a read sent before it', async () => {
    const { calls, feed } = await shown(a, b)
    const before = feed.read()
    const after = feed.refresh()
    expect(calls).toHaveLength(3)
    calls[2].answer({ enabled: false, notices: [] })
    await after
    calls[1].answer(state(a, b))
    await before
    expect(feed.current).toEqual({ enabled: false, notices: [] })
  })

  it('keeps a pull request being silenced hidden, even when its next reminder comes due meanwhile', async () => {
    const { calls, feed } = await shown(c)
    const silenced = feed.silence('c')
    const meanwhile = feed.read()
    calls[2].answer(state({ ...c, due: iso(30) }))
    await meanwhile
    expect(ids(feed)).toEqual([])
    calls[1].answer(state())
    await silenced
    expect(ids(feed)).toEqual([])
  })

  it('shows the next reminder of a pull request put away until then', async () => {
    const { calls, feed } = await shown(c)
    const dismissed = feed.dismiss('c')
    calls[1].answer(state())
    await dismissed
    const reminder = feed.read()
    calls[2].answer(state({ ...c, due: iso(30) }))
    await reminder
    expect(feed.current.notices.map((item) => [item.id, item.due])).toEqual([['c', iso(30)]])
  })
})

describe('saving a choice', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('sends one choice at a time, and of those waiting only the newest', async () => {
    const sent: number[] = []
    const done: Array<() => void> = []
    const save = sendLatest((value: number) => {
      sent.push(value)
      return new Promise<void>((resolve) => done.push(resolve))
    }, () => undefined)
    save(1)
    save(2)
    save(3)
    expect(sent).toEqual([1])
    done[0]()
    await settle()
    expect(sent).toEqual([1, 3])
    done[1]()
    await settle()
    save(4)
    expect(sent).toEqual([1, 3, 4])
  })

  it('reports a failure only when no newer choice replaces it', async () => {
    const failures: unknown[] = []
    const pending: Array<{ reject: (error: Error) => void }> = []
    const save = sendLatest((_value: number) => new Promise<void>((_resolve, reject) => pending.push({ reject })), (error, value) => failures.push([String(error), value]))
    save(1)
    save(2)
    pending[0].reject(new Error('first'))
    await settle()
    expect(failures).toEqual([])
    pending[1].reject(new Error('second'))
    await settle()
    expect(failures).toEqual([['Error: second', 2]])
  })
})
