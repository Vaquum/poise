// An entry of the notification rail as it is laid out
// (src/views/notification-rail.ts): what it says, what it offers, and how old
// it reads.

import { describe, expect, it } from 'vitest'
import type { Notice } from '../src/notices'
import { notificationItems } from '../src/notification-items'
import { ago, itemHtml } from '../src/views/notification-rail'

const T0 = Date.parse('2026-10-17T10:00:00.000Z')
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

function notice(id: string, overrides: Partial<Notice> = {}): Notice {
  return { id, kind: 'chat_waiting', title: 'Claude Code is waiting for you', body: 'Allow it?', since: iso(0), due: iso(0), silenceable: false, target: { chat: 's1' }, ...overrides }
}
const item = (value: Notice) => notificationItems([value], null, T0 + 5 * 60_000)[0]

describe('an entry', () => {
  it('escapes what it says', () => {
    const html = itemHtml(item(notice('a', { title: '<img src=x onerror=alert(1)>', body: '"quoted" & <b>bold</b>' })), false, T0)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;')
  })

  it('opens and puts away a notice, and offers silence only for a ready pull request', () => {
    const chat = itemHtml(item(notice('a')), true, T0)
    expect(chat).toContain('data-action="open">Open the session</button>')
    expect(chat).toContain('data-action="dismiss"')
    expect(chat).not.toContain('data-action="silence"')

    const ready = itemHtml(item(notice('b', { kind: 'pr_ready', silenceable: true, target: { pullRequest: 'https://github.com/acme/api/pull/7' } })), true, T0)
    expect(ready).toContain('data-action="open">Open on GitHub</button>')
    expect(ready).toContain('data-action="silence"')

    const explained = itemHtml(item(notice('c', { kind: 'behavior_held', target: { view: 'behaviors' } })), true, T0)
    expect(explained).not.toContain('data-action="open"')
    expect(explained).toContain('data-action="dismiss"')
  })

  it('lists what happened, and offers nothing to do for a condition that clears itself', () => {
    const [diagnostic] = notificationItems([], {
      status: 'ok', agentLogsError: null,
      datastore: { status: 'healthy', checkedAt: '', ageSeconds: 1, lastSuccessAt: '', error: null },
      identity: { status: 'valid', actor: 'bit-mis', error: null }, failures: [],
      deadLetters: [{ id: 'd', behavior: 'review-new-prs', target: 'acme/api#9', error: 'head changed <script>', createdAt: '', attemptCount: 2, diagnostic: { severity: 'info', code: 'head_changed' } }],
    }, T0)
    const html = itemHtml(diagnostic, true, T0)
    expect(html).toContain('<ol class="nr-history"><li><span>review-new-prs acme/api#9: head changed &lt;script&gt; (2 attempts)</span></li></ol>')
    expect(html).not.toContain('data-action="open"')
    expect(html).not.toContain('data-action="dismiss"')
    expect(html).toContain('is-auto')
  })

  it('says whether it is expanded, and hides its details until it is', () => {
    const closed = itemHtml(item(notice('a')), false, T0)
    expect(closed).toContain('aria-expanded="false"')
    expect(closed).toMatch(/<div class="nr-details" id="nr-details-[0-9a-z]+" hidden>/)
    const open = itemHtml(item(notice('a')), true, T0)
    expect(open).toContain('aria-expanded="true"')
    expect(open).toMatch(/<div class="nr-details" id="nr-details-[0-9a-z]+">/)
    expect(open.match(/aria-controls="([^"]+)"/)![1]).toBe(open.match(/class="nr-details" id="([^"]+)"/)![1])
  })
})

describe('where an entry comes from', () => {
  it('names its source and scope once', () => {
    const [runtime] = notificationItems([], {
      status: 'degraded', runtimeError: 'The behavior scheduler is no longer responding.', agentLogsError: null,
      datastore: { status: 'healthy', checkedAt: '', ageSeconds: 1, lastSuccessAt: '', error: null },
      identity: { status: 'valid', actor: 'bit-mis', error: null }, failures: [], deadLetters: [],
    }, T0)
    expect(itemHtml(runtime, false, T0)).toContain('<span class="nr-card-meta">Behaviors</span>')
    const held = item(notice('h', { kind: 'behavior_held', target: { swarm: 'call' }, subject: { behavior: 'review-new-prs', target: 'acme/api#9' } }))
    expect(itemHtml(held, false, T0)).toContain('<span class="nr-card-meta">Behaviors · acme/api#9</span>')
  })
})

describe('how old an entry reads', () => {
  it('goes from now through minutes and hours to days', () => {
    expect(ago(iso(0), T0 + 30_000)).toBe('now')
    expect(ago(iso(0), T0 + 4 * 60_000)).toBe('4m')
    expect(ago(iso(0), T0 + 3 * 3_600_000)).toBe('3h')
    expect(ago(iso(0), T0 + 49 * 3_600_000)).toBe('2d')
  })
})
