import { describe, expect, it } from 'vitest'

import { stripMarkdownForTitle } from '../server/editor'

// The document title is a label — the switcher, the editor bar, the menu.
// It should read the way the line reads on the page. Only the leading `#`
// used to be removed, so `**Portfolio** is the entirety` surfaced as
// `**Portfolio **is the…` in the switcher.
describe('stripMarkdownForTitle', () => {
  it('drops heading markers', () => {
    expect(stripMarkdownForTitle('# My Heading')).toBe('My Heading')
    expect(stripMarkdownForTitle('### Deeper')).toBe('Deeper')
  })

  it('drops list markers', () => {
    expect(stripMarkdownForTitle('- a bullet')).toBe('a bullet')
    expect(stripMarkdownForTitle('1. first')).toBe('first')
    expect(stripMarkdownForTitle('12) twelfth')).toBe('twelfth')
  })

  it('unwraps bold, keeping the words', () => {
    expect(stripMarkdownForTitle('**Portfolio** is the entirety'))
      .toBe('Portfolio is the entirety')
  })

  it('unwraps inline code', () => {
    expect(stripMarkdownForTitle('the `prep_each_round` contract'))
      .toBe('the prep_each_round contract')
  })

  it('unwraps italic, keeping the words', () => {
    expect(stripMarkdownForTitle('*Hello*')).toBe('Hello')
    expect(stripMarkdownForTitle('_Hello_')).toBe('Hello')
    expect(stripMarkdownForTitle('*Hello* world')).toBe('Hello world')
    expect(stripMarkdownForTitle('*a* and *b*')).toBe('a and b')
    // Word-edge rule, as in the editor: identifiers stay literal.
    expect(stripMarkdownForTitle('some_variable_name')).toBe('some_variable_name')
  })

  it('unwraps links, dropping the URL', () => {
    expect(stripMarkdownForTitle('[My Doc](https://example.com/x)')).toBe('My Doc')
    expect(stripMarkdownForTitle('[not a link]')).toBe('[not a link]')
    expect(stripMarkdownForTitle('[empty]()')).toBe('[empty]()')
    // The URL stops at the first `)`, as in the editor.
    expect(stripMarkdownForTitle('[A](u)[B](v)')).toBe('AB')
    expect(stripMarkdownForTitle('([docs](https://x.com))')).toBe('(docs)')
  })

  it('leaves markup inside code spans alone — the editor shows it as written', () => {
    expect(stripMarkdownForTitle('Notes on `__init__`')).toBe('Notes on __init__')
    expect(stripMarkdownForTitle('`[x](y)`')).toBe('[x](y)')
  })

  it('handles the malformed bold that older documents already contain', () => {
    // Written by the pre-fix Cmd+B: the space migrated inside the closer.
    expect(stripMarkdownForTitle("**Portfolio **is the entirety of Velocin's patents."))
      .toBe("Portfolio is the entirety of Velocin's patents.")
    expect(stripMarkdownForTitle('**NOTE: **something')).toBe('NOTE: something')
  })

  it('handles several runs on one line', () => {
    expect(stripMarkdownForTitle('## **Bold** and `code` together'))
      .toBe('Bold and code together')
  })

  it('drops a fence marker and its language tag', () => {
    expect(stripMarkdownForTitle('```js')).toBe('')
    expect(stripMarkdownForTitle('```')).toBe('')
  })

  it('leaves unmatched delimiters alone — the editor renders those literally too', () => {
    expect(stripMarkdownForTitle('a ** dangling')).toBe('a ** dangling')
    expect(stripMarkdownForTitle('2 * 3 * 4')).toBe('2 * 3 * 4')
  })

  it('leaves ordinary prose untouched', () => {
    expect(stripMarkdownForTitle('Just a plain sentence.')).toBe('Just a plain sentence.')
  })

  it('collapses the whitespace an unwrapped run can leave behind', () => {
    expect(stripMarkdownForTitle('**a**   **b**')).toBe('a b')
  })
})
