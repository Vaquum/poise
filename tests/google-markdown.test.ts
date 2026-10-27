import { describe, expect, it } from 'vitest'
import { readGoogleMarkdown, updateGoogleMarkdown } from '../server/google/markdown'

// Provider shape observed in the live 2026-10-20 proof; token and author redacted.
const suffix = '\n---\ngdoc_comments:\n  c1:\n    status: ACTIVE\n    token: redacted-provider-token\n    head:\n      author: Reviewer\n      time: "2026-10-20T08:12:04.779Z"\n      body: Please clarify &quot;this&quot;.\n      quote: The silver owl circles the\n---\n\n'
const body = '# Draft\n\n<!-- gdoc_comment_begin: c1 -->The silver owl circles the<!-- gdoc_comment_end: c1 --> old tower.\n'
const raw = body + suffix

describe('Google Markdown native comments', () => {
  it('extracts native comment text and exact offsets without exposing the opaque token', () => {
    const doc = readGoogleMarkdown(raw)
    expect(doc.text).toBe('# Draft\n\nThe silver owl circles the old tower.\n')
    expect(doc.comments).toEqual([{ id: 'c1', author: 'Reviewer', body: 'Please clarify "this".', quote: 'The silver owl circles the', resolved: false, replies: [], start: 9, end: 35 }])
    expect(JSON.stringify(doc.comments)).not.toContain('token')
    expect(updateGoogleMarkdown(raw, doc.text)).toBe(raw)
  })
  it('moves markers through insertions and preserves the metadata bytes verbatim', () => {
    const doc = readGoogleMarkdown(raw)
    const next = '# New title\n\nInserted paragraph.\n\nThe silver owl circles the old tower.\n'
    const updated = updateGoogleMarkdown(raw, next)
    expect(updated.endsWith(suffix)).toBe(true)
    expect(readGoogleMarkdown(updated).text).toBe(next)
    expect(readGoogleMarkdown(updated).comments[0].quote).toBe(doc.comments[0].quote)
    expect(readGoogleMarkdown(updated).comments[0].start).toBe(next.indexOf('The silver'))
  })
  it('refuses changed, removed or ambiguous passages instead of dropping anchors', () => {
    expect(() => updateGoogleMarkdown(raw, '# Draft\n\nThe amber fox.')).toThrow('Google-commented passage')
    expect(() => updateGoogleMarkdown(raw, 'The silver owl circles the\nThe silver owl circles the')).toThrow('ambiguous')
  })
  it('uses surrounding text to disambiguate repeated passages', () => {
    const text = readGoogleMarkdown(raw).text
    const next = text + '\nThe silver owl circles the other tower.'
    expect(readGoogleMarkdown(updateGoogleMarkdown(raw, next)).comments[0].start).toBe(9)
  })
  it('refuses broken metadata, orphaned markers, duplicate ids and injected provider syntax', () => {
    for (const value of [body, raw.replace('gdoc_comment_end: c1', 'gdoc_comment_end: c2'), raw.replace('gdoc_comments:', 'other:'), raw + 'Trailing body outside the block', raw.replace('  c1:', '  c2:')]) expect(() => readGoogleMarkdown(value)).toThrow()
    expect(() => updateGoogleMarkdown('', '<!-- gdoc_comment_begin: c1 -->Injected')).toThrow('reserved')
    expect(() => readGoogleMarkdown(raw.replace('    token:', '  c1: duplicate\n    token:'))).toThrow()
  })
  it('retains resolved and unanchored comments in the list', () => {
    const doc = readGoogleMarkdown('# Draft\n' + suffix.replace('status: ACTIVE', 'status: RESOLVED'))
    expect(doc.comments[0]).toMatchObject({ resolved: true, start: null, end: null })
  })
  it.each([' ', '\t'])('keeps unanchored footer tokens private with trailing header whitespace %j', whitespace => {
    const footer = suffix.replace('gdoc_comments:', `gdoc_comments:${whitespace}`)
    const doc = readGoogleMarkdown('# Draft\n' + footer)
    expect(doc.text).toBe('# Draft\n')
    expect(doc.comments[0]).toMatchObject({ start: null, end: null })
    expect(JSON.stringify({ text: doc.text, comments: doc.comments })).not.toContain('redacted-provider-token')
    expect(updateGoogleMarkdown('# Draft\n' + footer, '# Updated\n')).toBe('# Updated\n' + footer)
  })
  it('rejects unsupported footer boundaries before exposing provider metadata', () => {
    for (const header of ['  gdoc_comments:', 'gdoc_comments :', '"gdoc_comments":', "'gdoc_comments':"]) {
      const value = '# Draft\n' + suffix.replace('gdoc_comments:', header)
      expect(() => readGoogleMarkdown(value)).toThrow('unsupported')
      expect(() => updateGoogleMarkdown('', value)).toThrow('reserved')
    }
    expect(() => readGoogleMarkdown('gdoc_comments:\n  token: private')).toThrow('unsupported')
  })
  it('preserves Unicode offsets', () => {
    const value = raw.replace('# Draft', '# 🦉 Draft')
    const updated = updateGoogleMarkdown(value, readGoogleMarkdown(value).text.replace('# 🦉 Draft', '# 🦉 Longer draft'))
    expect(readGoogleMarkdown(updated).comments[0].start).toBe(19)
  })
})

it('reads the live native reply and resolution-event shape without exposing provider metadata', () => {
  const thread = raw.replace('      quote:', '    replies:\n    - author: Second reviewer\n      body: A reply &amp; clarification.\n    - author: Reviewer\n      action: RESOLVE\n    head_unused:\n      quote:').replace('status: ACTIVE', 'status: RESOLVED')
  const doc = readGoogleMarkdown(thread)
  expect(doc.comments[0]).toMatchObject({ resolved: true, replies: [{ author: 'Second reviewer', body: 'A reply & clarification.' }] })
  expect(updateGoogleMarkdown(thread, doc.text.replace('# Draft', '# Updated draft'))).toContain('action: RESOLVE')
  expect(() => readGoogleMarkdown(raw.replace('status: ACTIVE', 'status: UNKNOWN_NEW_FORMAT'))).toThrow('unsupported')
})
it('refuses to transfer a deleted or edited occurrence onto an originally separate copy', () => {
  const repeated = raw.replace(' old tower.\n', ' old tower.\n\nOther context: The silver owl circles the other tower.\n')
  const text = readGoogleMarkdown(repeated).text
  expect(() => updateGoogleMarkdown(repeated, text.replace('The silver owl circles the old tower.', 'A different first passage.'))).toThrow('ambiguous')
  expect(() => updateGoogleMarkdown(repeated, text.replace('The silver owl circles the old tower.\n', ''))).toThrow('ambiguous')
})
it('preserves crossing comment markers in their original relative order', () => {
  const overlapping = '# Draft\n\n<!-- gdoc_comment_begin: c1 -->The <!-- gdoc_comment_begin: c2 -->silver owl<!-- gdoc_comment_end: c1 --> circles<!-- gdoc_comment_end: c2 --> the tower.\n' + suffix.replace('---\n\n', '  c2:\n    status: ACTIVE\n    head:\n      author: Second reviewer\n      body: Second comment.\n---\n\n')
  const text = readGoogleMarkdown(overlapping).text
  const updated = updateGoogleMarkdown(overlapping, '# Inserted\n\n' + text)
  const comments = readGoogleMarkdown(updated).comments
  expect(comments.map(c => c.quote)).toEqual(['The silver owl', 'silver owl circles'])
  expect(updated.indexOf('gdoc_comment_begin: c1')).toBeLessThan(updated.indexOf('gdoc_comment_begin: c2'))
  expect(updated.indexOf('gdoc_comment_end: c1')).toBeLessThan(updated.indexOf('gdoc_comment_end: c2'))
})
