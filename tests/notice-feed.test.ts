// The page's side of the notices (src/notices.ts): reading the server's
// answer and keeping this tab's notices in step with it.

import { describe, expect, it, vi } from 'vitest'
import { NoticeFeed, noticesFrom, sendLatest, standingFor, type Notice } from '../src/notices'
import { noticeMeta } from '../src/notification-items'

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
  it('is read as the state the rail lists', () => {
    const ready = notice('a-2', { kind: 'pr_ready', silenceable: true, target: { pullRequest: 'https://github.com/acme/api/pull/7' } })
    const held = notice('a-3', { kind: 'behavior_held', target: { swarm: 'failed-call' } })
    expect(noticesFrom({ enabled: true, notices: [notice('a-1'), ready, held] })).toEqual({ enabled: true, notices: [notice('a-1'), ready, held] })
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
    for (const swarm of ['', 'a b', '<img>', 'a'.repeat(201), 7, null]) {
      const malformed = { ...notice('a-5'), target: { swarm } }
      expect(noticesFrom({ enabled: true, notices: [malformed] })!.notices).toEqual([])
    }
  })

  it("keeps a failed behavior's subject, and leaves out one it cannot read or that names anything else", () => {
    const held = notice('a-1', { kind: 'behavior_held', target: { swarm: 'failed-call' }, subject: { behavior: 'review-new-prs', target: 'acme/api#9' } })
    expect(noticesFrom({ enabled: true, notices: [held] })!.notices).toEqual([held])
    for (const subject of [null, 'acme/api#9', {}, { behavior: '', target: 'acme/api#9' }, { behavior: 'review-new-prs' }, { behavior: 'review-new-prs', target: 9 }, { behavior: 'a', target: 'b', extra: 1 }]) {
      expect(noticesFrom({ enabled: true, notices: [{ ...held, subject }] })!.notices, JSON.stringify(subject)).toEqual([])
    }
    const waiting = { ...notice('a-2'), subject: { behavior: 'review-new-prs', target: 'acme/api#9' } }
    expect(noticesFrom({ enabled: true, notices: [waiting] })!.notices).toEqual([])
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

  it('says whether the server has answered yet', async () => {
    const { calls, request } = server()
    const feed = new NoticeFeed(request)
    expect(feed.answered).toBe(false)
    const first = feed.read()
    calls[0].answer({ not: 'an answer' })
    await first
    expect(feed.answered).toBe(false)
    const second = feed.read()
    calls[1].answer(state())
    await second
    expect(feed.answered).toBe(true)
  })

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

it('shares browser read failures across sources, dismisses locally, clears on recovery and keeps faults accessible with popups off', async () => {
  let enabled = true
  const request = vi.fn(async () => new Response(JSON.stringify({ enabled, notices: [] }), { status: 200 }))
  const feed = new NoticeFeed(request)
  await feed.read()
  const failure = { key: 'account:vaquum', title: 'GitHub data for vaquum is unavailable', body: 'totalCount changed: 109 to 110' }
  feed.reportReadErrors('day', [failure])
  feed.reportReadErrors('history', [failure])
  expect(feed.current.notices).toHaveLength(1)
  const first = feed.current.notices[0].id
  await feed.read()
  expect(feed.current.notices[0].body).toBe(failure.body)
  await feed.dismiss(first)
  expect(feed.current.notices).toEqual([])
  feed.reportReadErrors('day', [failure])
  expect(feed.current.notices).toEqual([])
  expect(request).toHaveBeenCalledTimes(2)
  feed.reportReadErrors('day', [])
  feed.reportReadErrors('history', [])
  feed.reportReadErrors('day', [failure])
  expect(feed.current.notices[0].id).not.toBe(first)
  enabled = false
  await feed.read()
  expect(feed.current.enabled).toBe(false)
  expect(feed.current.notices).toHaveLength(1)
  enabled = true
  await feed.read()
  expect(feed.current.notices).toHaveLength(1)
  feed.reportReadErrors('day', [])
  expect(feed.current.notices).toEqual([])
})


it('keeps local action feedback independent of read recovery, retains dismissal, and resurfaces changed failures', async () => {
  const feed = new NoticeFeed(vi.fn())
  const failure = { key: 'save', title: 'Editor save failed', body: 'Disk full', kind: 'action_failed' as const }
  feed.reportLocalNotices('editor', [failure])
  const first = feed.current.notices[0]
  expect(first.kind).toBe('action_failed')
  feed.reportReadErrors('analytics', [{ key: 'quota', title: 'Quota unavailable', body: 'Offline' }])
  feed.reportReadErrors('analytics', [])
  expect(feed.current.notices).toEqual([first])
  await feed.dismiss(first.id)
  feed.reportLocalNotices('editor', [failure])
  expect(feed.current.notices).toEqual([])
  feed.reportLocalNotices('editor', [{ ...failure, body: 'Changed elsewhere', kind: 'action_needed' }])
  expect(feed.current.notices).toHaveLength(1)
  expect(feed.current.notices[0]).toMatchObject({ body: 'Changed elsewhere', kind: 'action_needed' })
  expect(feed.current.notices[0].id).not.toBe(first.id)
  feed.reportLocalNotices('editor', [])
  expect(feed.current.notices).toEqual([])
})
