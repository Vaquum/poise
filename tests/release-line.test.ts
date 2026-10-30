// The words and link of the menu's first line (src/release.ts).

import { describe, expect, it } from 'vitest'
import { releaseLine } from '../src/release'

const COMMIT = '46815bfcaae2aace9e2534296639b872e34f8db1'
const NOW = Date.parse('2026-10-09T20:00:00Z')

describe("the menu's first line", () => {
  it('shows the short hash, linked to the commit on autonomio/poise, and when, in the person\'s timezone', () => {
    expect(releaseLine({ commit: COMMIT, since: '2026-10-09T18:40:00Z', repo: 'autonomio/poise' }, 'Europe/Helsinki', NOW)).toEqual({
      commit: '46815bf',
      href: `https://github.com/autonomio/poise/commit/${COMMIT}`,
      when: '9 Oct 21:40',
      label: 'Poise runs autonomio/poise@46815bf, since 9 October 2026 at 21:40',
    })
    expect(releaseLine({ commit: COMMIT, since: '2026-10-09T18:40:00Z', repo: 'autonomio/poise' }, 'UTC', NOW)!.when).toBe('9 Oct 18:40')
  })

  it('names the year only when it is not this one', () => {
    expect(releaseLine({ commit: COMMIT, since: '2025-12-31T23:05:00Z', repo: 'autonomio/poise' }, 'UTC', NOW)!.when).toBe('31 Dec 2025 23:05')
  })

  it('shows the hash alone when the time is not known', () => {
    expect(releaseLine({ commit: COMMIT, since: null, repo: 'autonomio/poise' }, 'UTC', NOW)).toEqual({
      commit: '46815bf',
      href: `https://github.com/autonomio/poise/commit/${COMMIT}`,
      when: null,
      label: 'Poise runs autonomio/poise@46815bf',
    })
  })

  it('attributes a fork to the release source the server names', () => {
    expect(releaseLine({ commit: COMMIT, since: '2026-10-09T18:40:00Z', repo: 'fork/poise' }, 'UTC', NOW)).toEqual({
      commit: '46815bf',
      href: `https://github.com/fork/poise/commit/${COMMIT}`,
      when: '9 Oct 18:40',
      label: 'Poise runs fork/poise@46815bf, since 9 October 2026 at 18:40',
    })
  })

  it('falls back to the official repository for a missing or malformed source', () => {
    for (const repo of [undefined, null, '', 'not a repo', 'a/b/c', 'https://github.com/fork/poise']) {
      const line = releaseLine({ commit: COMMIT, since: null, repo }, 'UTC', NOW)!
      expect(line.href, JSON.stringify(repo)).toBe(`https://github.com/autonomio/poise/commit/${COMMIT}`)
      expect(line.label, JSON.stringify(repo)).toBe('Poise runs autonomio/poise@46815bf')
    }
  })

  it('is absent without a commit to show', () => {
    for (const value of [null, {}, { commit: null, since: null }, { commit: 'main' }, { commit: '46815bf' }, 'x']) {
      expect(releaseLine(value, 'UTC', NOW), JSON.stringify(value)).toBeNull()
    }
  })
})
