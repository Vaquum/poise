// Chat session auto-titles (src/chat-title.ts): an issue or PR reference
// names the chat after the item, otherwise the first sentence names it with
// delegation boilerplate removed, and a hand-set name is never overwritten.

import { describe, expect, it } from 'vitest'
import { deriveSessionTitle, parseIssueReference, shouldAutoName, stripTypePrefix } from '../src/chat-title'

describe('issue references', () => {
  it('finds a github.com issue URL, a pull URL and an owner/repo#number', () => {
    expect(parseIssueReference('see https://github.com/autonomio/poise/issues/446 for details'))
      .toMatchObject({ owner: 'autonomio', repo: 'poise', number: 446, kind: 'issue' })
    expect(parseIssueReference('see https://github.com/autonomio/poise/pull/12'))
      .toMatchObject({ owner: 'autonomio', repo: 'poise', number: 12, kind: 'pull' })
    expect(parseIssueReference('Task: continue autonomio/poise#446'))
      .toMatchObject({ owner: 'autonomio', repo: 'poise', number: 446, kind: 'unknown' })
  })

  it('resolves a bare #number against the session repository only', () => {
    expect(parseIssueReference('Fix #12', 'acme/app'))
      .toMatchObject({ owner: 'acme', repo: 'app', number: 12, kind: 'unknown' })
    expect(parseIssueReference('Fix #12')).toBeNull()
    expect(parseIssueReference('Fix #12', 'not-a-repo')).toBeNull()
  })

  it('takes the earliest reference and locates it for removal', () => {
    const ref = parseIssueReference('autonomio/other#5 then https://github.com/autonomio/poise/issues/446')!
    expect(ref.number).toBe(5)
    expect('autonomio/other#5 then https://github.com/autonomio/poise/issues/446'.slice(ref.index, ref.index + ref.length)).toBe('autonomio/other#5')
  })

  it('ignores lookalikes: hex colours, model names and mid-path segments', () => {
    expect(parseIssueReference('paint it #abc123')).toBeNull()
    expect(parseIssueReference('paint it #123abc')).toBeNull()
    expect(parseIssueReference('use C#12 features', 'acme/app')).toBeNull()
    expect(parseIssueReference('open x/y/z#1')).toBeNull()
  })
})

describe('type prefixes', () => {
  it('strips a Conventional Commits type, with scope and breaking mark', () => {
    expect(stripTypePrefix('feat: Let it land')).toBe('Let it land')
    expect(stripTypePrefix('fix(auth): stop the loop')).toBe('stop the loop')
    expect(stripTypePrefix('feat!: new API')).toBe('new API')
  })

  it('keeps ordinary words before a colon', () => {
    expect(stripTypePrefix('Note: keep this')).toBe('Note: keep this')
    expect(stripTypePrefix('no prefix here')).toBe('no prefix here')
  })
})

describe('title derivation', () => {
  it("names the chat after the referenced item's title without its type prefix", () => {
    expect(deriveSessionTitle('Task: continue autonomio/poise#446 (https://github.com/autonomio/poise/issues/446)',
      { issueTitle: 'feat: Let a pending Poise update land within a bounded pause' }))
      .toBe('#446 Let a pending Poise update land within a bounded pause')
    expect(deriveSessionTitle('Fix #12', { repo: 'acme/app', issueTitle: 'fix: broken logout' })).toBe('#12 broken logout')
  })

  it('keeps the number with the stripped sentence when the item is unknown', () => {
    expect(deriveSessionTitle('Task: continue autonomio/poise#446 (https://github.com/autonomio/poise/issues/446)')).toBe('#446')
    expect(deriveSessionTitle('check the flaky test, see autonomio/poise#446')).toBe('#446 check the flaky test, see')
  })

  it('strips delegation boilerplate, refs and URLs from the first sentence', () => {
    expect(deriveSessionTitle('Could you take this task? Implement the login fix')).toBe('the login fix')
    expect(deriveSessionTitle('Task: continue the migration')).toBe('the migration')
    expect(deriveSessionTitle('Implement the login fix. Then deploy.')).toBe('the login fix')
    expect(deriveSessionTitle('see https://example.com/spec for details')).toBe('see for details')
  })

  it('removes the whole unresolved issue or PR URL from its fallback title', () => {
    for (const reference of ['https://github.com/acme/app/issues/12', 'http://github.com/acme/app/pull/12', 'github.com/acme/app/issues/12']) {
      expect(deriveSessionTitle(reference)).toBe('#12')
      expect(deriveSessionTitle(`Task: continue (${reference})`)).toBe('#12')
      const ref = parseIssueReference(reference)!
      expect(reference.slice(ref.index, ref.index + ref.length)).toBe(reference)
    }
  })

  it('leaves an ordinary first line alone', () => {
    expect(deriveSessionTitle('hello there')).toBe('hello there')
    expect(deriveSessionTitle('Refactor the auth module')).toBe('Refactor the auth module')
    expect(deriveSessionTitle('line one\nline two')).toBe('line one')
    expect(deriveSessionTitle('Fix the login. Then deploy.')).toBe('Fix the login')
  })

  it('falls back to the raw line when stripping leaves nothing', () => {
    expect(deriveSessionTitle('Task:')).toBe('Task:')
    expect(deriveSessionTitle('')).toBe('')
  })
})

describe('hand-set names', () => {
  const record = { title: 'My name', contextResetSeq: 0 }
  it('are never overwritten', () => {
    expect(shouldAutoName({ ...record, titleManual: true }, true, false)).toBe(false)
    expect(shouldAutoName({ ...record, titleManual: true, title: 'New session' }, true, false)).toBe(false)
  })

  it('leaves the other guards untouched', () => {
    expect(shouldAutoName({ title: 'New session' }, false, false)).toBe(true)
    expect(shouldAutoName(record, true, false)).toBe(true)
    expect(shouldAutoName(record, false, false)).toBe(false)
    expect(shouldAutoName({ ...record, contextResetSeq: 7 }, true, false)).toBe(false)
    expect(shouldAutoName(record, true, false)).toBe(true)
    expect(shouldAutoName({ ...record, role: 'manager' }, true, false)).toBe(false)
    expect(shouldAutoName({ ...record, selfChangeId: 'c1' }, true, false)).toBe(false)
    expect(shouldAutoName(record, true, true)).toBe(false)
  })
})
