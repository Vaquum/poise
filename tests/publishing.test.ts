import { describe, expect, it } from 'vitest'
import {
  PublishConfigError,
  PublishValueError,
  documentParts,
  fillPost,
  matchesPattern,
  parsePost,
  parsePublishConfig,
  reconcile,
  renderPost,
  sha256,
  slugFromTitle,
  suggestionsFrom,
  today,
  type FillContext,
  type Place,
} from '../server/publishing'

// mikkokotila.com's description, as docs/Publishing.md shows it.
const MIKKO = `# How a writing tool publishes to mikkokotila.com
version: 1
site: mikkokotila.com
sections:
  - name: Writing
    path: src/content/writing/{slug}.md
    url: https://mikkokotila.com/writing/{slug}/
    slug: "^[a-z0-9]+(?:-[a-z0-9]+)*$"
    first_line: title
    fields:
      type:        { kind: choice, choices: [essay, note], default: essay }
      title:       { kind: text, required: true, max: 220 }
      description: { kind: text, lines: many, max: 420 }
      date:        { kind: date, required: true, default: today }
      origins:     { kind: places, self: { venue: mikkokotila.com }, item: { venue: "{site}", url: "{url}" } }
      tags:        { kind: list, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", suggest: "content/writing.yaml#topics[].tag" }
`

const OTHER = `version: 1
site: Other Journal
branch: published
sections:
  - name: Posts
    path: _posts/{date}-{slug}.md
    url: https://other.example/{year}/{month}/{slug}/
    slug: "^[a-z0-9-]+$"
    fields:
      layout: { kind: text, value: post }
      title:  { kind: text, required: true }
      canonical_url: { kind: canonical }
      syndicated: { kind: places, item: "{url}" }
`

const mikko = parsePublishConfig(MIKKO)
const writing = mikko.sections[0]
const self: Place = { key: 'mikkokotila/mikkokotila-com#Writing', site: 'mikkokotila.com', url: 'https://mikkokotila.com/writing/a-better-question/' }
const elsewhere: Place = { key: 'acme/journal#Posts', site: 'Other Journal', url: 'https://other.example/2026/10/a-better-question/' }

function context(over: Partial<FillContext> = {}): FillContext {
  return { title: 'A better question', today: '2026-10-17', places: [self], self, ...over }
}

function configError(source: string): string {
  try {
    parsePublishConfig(source)
  } catch (error) {
    expect(error).toBeInstanceOf(PublishConfigError)
    return (error as Error).message
  }
  throw new Error('the description was accepted')
}

function valueProblems(run: () => unknown): string[] {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(PublishValueError)
    return (error as PublishValueError).problems
  }
  throw new Error('the values were accepted')
}

describe('publish.yaml', () => {
  it('reads a site with its sections and fields in order', () => {
    expect(mikko.site).toBe('mikkokotila.com')
    expect(mikko.branch).toBeUndefined()
    expect(writing).toMatchObject({ name: 'Writing', path: 'src/content/writing/{slug}.md', firstLine: 'title' })
    expect(writing.fields.map((f) => `${f.name}:${f.kind}`)).toEqual([
      'type:choice', 'title:text', 'description:text', 'date:date', 'origins:places', 'tags:list',
    ])
    expect(writing.fields[5].suggest).toEqual({ file: 'content/writing.yaml', path: 'topics[].tag' })
    expect(parsePublishConfig(OTHER).branch).toBe('published')
  })

  it('names the key that is wrong', () => {
    const swap = (from: string, to: string) => MIKKO.replace(from, to)
    expect(configError(`${MIKKO}\nextra: 1\n`)).toBe('publish.yaml: unknown key extra (allowed: version, site, branch, sections)')
    expect(configError(swap('version: 1', 'version: 2'))).toBe('version: must be 1')
    expect(configError(swap('path: src/content/writing/{slug}.md', 'path: src/content/writing/post.md'))).toBe('sections[0].path: include {slug}')
    expect(configError(swap('path: src/content/writing/{slug}.md', 'path: ../{slug}.md'))).toBe('sections[0].path: a file path inside the repository')
    expect(configError(swap('path: src/content/writing/{slug}.md', 'path: "{title}/{slug}.md"'))).toMatch(/^sections\[0\]\.path: \{title\} is not a placeholder here/)
    expect(configError(swap('"^[a-z0-9]+(?:-[a-z0-9]+)*$"\n    first_line', '"(unclosed"\n    first_line'))).toMatch(/^sections\[0\]\.slug: not a valid regular expression/)
    expect(configError(swap('first_line: title', 'first_line: date'))).toBe('sections[0].first_line: name a text field of this section')
    expect(configError(swap('default: essay', 'default: poem'))).toBe('sections[0].fields.type.default: one of the choices')
    expect(configError(swap('default: today', 'default: yesterday'))).toBe('sections[0].fields.date.default: a date as YYYY-MM-DD, or today')
    expect(configError(swap('kind: places, self', 'kind: places, required: true, self'))).toBe('sections[0].fields.origins: unknown key required (allowed: kind, self, item)')
    expect(configError(swap('{ kind: places, self: { venue: mikkokotila.com }, item: { venue: "{site}", url: "{url}" } }', '{ kind: places }'))).toBe('sections[0].fields.origins.item: say how each place is written')
    expect(configError(swap('kind: list', 'kind: tags'))).toBe('sections[0].fields.tags.kind: one of text, choice, list, date, boolean, places, canonical')
    expect(configError(swap('content/writing.yaml#topics[].tag', 'topics'))).toMatch(/^sections\[0\]\.fields\.tags\.suggest:/)
    expect(configError(swap('url: https://mikkokotila.com', 'url: ftp://mikkokotila.com'))).toBe('sections[0].url: an address starting with https://')
    expect(configError(`version: 1\nsite: x\nbranch: "a..b"\nsections: []\n`)).toBe('branch: a branch name')
    expect(configError(`version: 1\nsite: x\nsections: []\n`)).toBe('sections: a list of one to twenty sections')
    expect(configError(`${MIKKO}  - name: writing\n    path: "{slug}.md"\n    slug: "x"\n`)).toBe('sections: each section needs a name of its own')
    expect(configError('version: 1\nversion: 1\n')).toMatch(/^not valid YAML: Map keys must be unique/)
    expect(configError('- just\n- a list\n')).toBe('describe the site with version, site and sections')
    expect(configError(`${MIKKO}#${'x'.repeat(64 * 1024)}`)).toBe('publish.yaml is larger than 64 KB')
  })

  it('stops a pattern that backtracks without end', () => {
    const start = Date.now()
    expect(() => matchesPattern('^(a+)+$', `${'a'.repeat(40)}b`)).toThrow(PublishValueError)
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(matchesPattern('^[a-z]+$', 'fine')).toBe(true)
  })
})

describe('a document as a post', () => {
  it('takes the first line as the title and the rest as the text', () => {
    expect(documentParts('\n# A **better** question\n\n\nFirst paragraph.\n\n## A section\n\n')).toEqual({
      title: 'A better question',
      rest: 'First paragraph.\n\n## A section',
      whole: '# A **better** question\n\n\nFirst paragraph.\n\n## A section',
    })
    expect(documentParts('  \n\n')).toEqual({ title: '', rest: '', whole: '' })
  })

  it('suggests a slug from the title', () => {
    expect(slugFromTitle('A Better Question')).toBe('a-better-question')
    expect(slugFromTitle('Ääkköset & Co. — 2026')).toBe('aakkoset-co-2026')
    expect(slugFromTitle("Don't panic!")).toBe('dont-panic')
    const long = slugFromTitle('word '.repeat(40))
    expect(long.length).toBeLessThanOrEqual(80)
    expect(long).toMatch(/^word(?:-word)+$/)
  })

  it('fills the section in its order, with the title, today and this site', () => {
    const post = fillPost(writing, 'a-better-question', { description: '  One line.\nTwo lines.  ', tags: ['ad-fraud', 'advertising', 'ad-fraud'] }, context())
    expect(post.path).toBe('src/content/writing/a-better-question.md')
    expect(post.url).toBe('https://mikkokotila.com/writing/a-better-question/')
    expect(Object.keys(post.frontmatter)).toEqual(['type', 'title', 'description', 'date', 'origins', 'tags'])
    expect(post.frontmatter).toEqual({
      type: 'essay',
      title: 'A better question',
      description: 'One line.\nTwo lines.',
      date: '2026-10-17',
      origins: [{ venue: 'mikkokotila.com' }],
      tags: ['ad-fraud', 'advertising'],
    })
  })

  it('names every place the piece is published, and the original on the copies', () => {
    const here = fillPost(writing, 'a-better-question', {}, context({ places: [self, elsewhere] }))
    expect(here.frontmatter.origins).toEqual([
      { venue: 'mikkokotila.com' },
      { venue: 'Other Journal', url: 'https://other.example/2026/10/a-better-question/' },
    ])
    // Without first_line, the title is a value like any other.
    const other = parsePublishConfig(OTHER).sections[0]
    const titled = { title: 'A better question' }
    const there = fillPost(other, 'a-better-question', titled, context({ places: [self, elsewhere], self: elsewhere }))
    expect(there.path).toBe('_posts/2026-10-17-a-better-question.md')
    expect(there.frontmatter).toEqual({
      layout: 'post',
      title: 'A better question',
      canonical_url: 'https://mikkokotila.com/writing/a-better-question/',
      syndicated: ['https://mikkokotila.com/writing/a-better-question/', 'https://other.example/2026/10/a-better-question/'],
    })
    const original = fillPost(other, 'a-better-question', titled, context({ places: [elsewhere, self], self: elsewhere }))
    expect(original.frontmatter).not.toHaveProperty('canonical_url')
  })

  it('says everything that is wrong at once', () => {
    expect(valueProblems(() => fillPost(writing, 'A-Better', { type: 'poem', tags: ['Ad Fraud'], date: '2026-02-30' }, context({ title: 'x'.repeat(221) })))).toEqual([
      'The slug "A-Better" does not match the site\'s pattern ^[a-z0-9]+(?:-[a-z0-9]+)*$.',
      'type must be one of essay, note.',
      'title is longer than 220 characters.',
      'date must be a date as YYYY-MM-DD.',
      'tags: "Ad Fraud" does not match the site\'s pattern ^[a-z0-9]+(?:-[a-z0-9]+)*$.',
    ])
    expect(valueProblems(() => fillPost(writing, '../escape', {}, context()))).toEqual([
      'The slug must be letters, digits, dots, hyphens and underscores, up to 120.',
    ])
    expect(valueProblems(() => fillPost(writing, 'untitled', {}, context({ title: '' })))).toEqual(['title is required.'])
  })

  it('writes quoted frontmatter, then the text', () => {
    const post = fillPost(writing, 'a-better-question', { tags: ['ad-fraud'] }, context())
    expect(renderPost(post.frontmatter, '\n\nFirst paragraph.\n\n## A section\n\n')).toBe([
      '---',
      'type: "essay"',
      'title: "A better question"',
      'date: "2026-10-17"',
      'origins:',
      '  - venue: "mikkokotila.com"',
      'tags:',
      '  - "ad-fraud"',
      '---',
      '',
      'First paragraph.',
      '',
      '## A section',
      '',
    ].join('\n'))
    expect(renderPost({}, 'Only text')).toBe('Only text\n')
  })

  it('reads a post back as the site has it', () => {
    const file = renderPost({ title: 'A "quoted" title', date: '2026-10-17', tags: ['a'] }, 'Text.\n')
    expect(parsePost(file)).toEqual({ data: { title: 'A "quoted" title', date: '2026-10-17', tags: ['a'] }, body: 'Text.' })
    expect(parsePost('No frontmatter here.\n')).toEqual({ data: {}, body: 'No frontmatter here.' })
    expect(parsePost('---\n---\nBody\n')).toEqual({ data: {}, body: 'Body' })
    expect(parsePost('---\ntitle: a---\nstill frontmatter: yes\n---\nBody')).toEqual({ data: { title: 'a---', 'still frontmatter': 'yes' }, body: 'Body' })
  })
})

describe('publishing again', () => {
  const base = { data: { title: 'T', tags: ['a'], date: '2026-10-17' }, bodySha: sha256('Old text.') }

  it('keeps what only the site changed, and what only this document changed', () => {
    const merged = reconcile(base,
      { data: { title: 'New title', tags: ['a'], date: '2026-10-17' }, body: 'Old text.' },
      { data: { title: 'T', tags: ['a', 'b'], date: '2026-10-17', draft: false }, body: 'Old text, edited on the site.' })
    expect(merged).toEqual({
      data: { title: 'New title', tags: ['a', 'b'], date: '2026-10-17', draft: false },
      body: 'Old text, edited on the site.',
      conflicts: [],
    })
  })

  it('respects a field the site removed', () => {
    const merged = reconcile(base, { data: { title: 'T', tags: ['a'], date: '2026-10-17' }, body: 'New text.' }, { data: { title: 'T', date: '2026-10-17' }, body: 'Old text.' })
    expect(merged).toEqual({ data: { title: 'T', date: '2026-10-17' }, body: 'New text.', conflicts: [] })
  })

  it('reports the same field, and the text, changed on both sides', () => {
    const merged = reconcile(base,
      { data: { title: 'T', tags: ['c'], date: '2026-10-17' }, body: 'Mine.' },
      { data: { title: 'T', tags: ['b'], date: '2026-10-17' }, body: 'Theirs.' })
    expect(merged.conflicts).toEqual(['tags', 'the text'])
    expect(merged.data.tags).toEqual(['c'])
    expect(merged.body).toBe('Mine.')
  })
})

describe('suggestions and dates', () => {
  it('reads the words a site offers from a file in its repository', () => {
    const writingYaml = 'topics:\n  - tag: machine-intelligence\n    name: Machine intelligence\n  - tag: ad-fraud\n  - name: no tag\n'
    expect(suggestionsFrom(writingYaml, 'topics[].tag')).toEqual(['machine-intelligence', 'ad-fraud'])
    expect(suggestionsFrom('{"tags": ["a", "b", "a"]}', 'tags[]')).toEqual(['a', 'b'])
    expect(suggestionsFrom('a: {b: [x]}', 'a.b[]')).toEqual(['x'])
    expect(() => suggestionsFrom('a: [', 'a')).toThrow(PublishConfigError)
  })

  it('takes today in the time zone set, and refuses one it does not know', () => {
    const instant = new Date('2026-10-16T22:30:00Z')
    expect(today('Europe/Helsinki', instant)).toBe('2026-10-17')
    expect(today('America/New_York', instant)).toBe('2026-10-16')
    expect(() => today('Mars/Olympus', instant)).toThrow('The time zone in Settings → General, Mars/Olympus, is not one this computer knows.')
  })
})
