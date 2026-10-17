import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFileOptions } from '../server/process'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...(await original<typeof import('../server/process')>()),
  runFile: mocks.runFile,
}))

/* ---------------------------------------------------------------- a GitHub in memory, as gh api answers */

interface Pull { number: number, state: 'open' | 'closed', merged: boolean, head: string, headRepo: string, base: string, title: string, body: string, mergedSha?: string }
interface Repo { fullName: string, owner: string, defaultBranch: string, push: boolean, branches: Map<string, string>, pulls: Map<number, Pull> }

let repos: Map<string, Repo>
let commits: Map<string, Map<string, string>>
let commitCount = 0
let calls: Array<{ args: string[], env: NodeJS.ProcessEnv | undefined, input: any }>
let ghFailure: string | null
/** An HTTP status to answer a request with instead, by method and endpoint. */
let failOn: ((method: string, endpoint: string) => number | null) | null
/** Runs once, just before the next commit is applied: a merge, or a look at what holds meanwhile. */
let beforeCommit: (() => Promise<void> | void) | null
/** Runs once, just after the next commit is applied. */
let afterCommit: (() => void) | null

function commit(files: Map<string, string>): string {
  const sha = (++commitCount).toString(16).padStart(40, '0')
  commits.set(sha, files)
  return sha
}

function addRepo(fullName: string, files: Record<string, string>, push = true): Repo {
  const repo: Repo = { fullName, owner: fullName.split('/')[0], defaultBranch: 'main', push, branches: new Map(), pulls: new Map() }
  repo.branches.set('main', commit(new Map(Object.entries(files))))
  repos.set(fullName.toLowerCase(), repo)
  return repo
}

function fileOn(fullName: string, branch: string, path: string): string | undefined {
  const repo = repos.get(fullName.toLowerCase())!
  return commits.get(repo.branches.get(branch)!)!.get(path)
}

/** An edit made on the site itself (the tagger, a maintainer in review). */
function editOnSite(fullName: string, branch: string, path: string, edit: (text: string) => string): void {
  const repo = repos.get(fullName.toLowerCase())!
  const files = new Map(commits.get(repo.branches.get(branch)!)!)
  files.set(path, edit(files.get(path)!))
  repo.branches.set(branch, commit(files))
}

function close(fullName: string, number: number): void {
  Object.assign(repos.get(fullName.toLowerCase())!.pulls.get(number)!, { state: 'closed', merged: false })
}

function merge(fullName: string, number: number): void {
  const repo = repos.get(fullName.toLowerCase())!
  const pull = repo.pulls.get(number)!
  const from = repos.get(pull.headRepo.toLowerCase())!
  repo.branches.set(pull.base, from.branches.get(pull.head)!)
  Object.assign(pull, { state: 'closed', merged: true, mergedSha: from.branches.get(pull.head)! })
}

const http = (status: number, body?: unknown) => `HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n\r\n${body === undefined ? '' : JSON.stringify(body)}`

function answer(status: number, body?: unknown) {
  const stdout = http(status, body)
  if (status >= 400) throw Object.assign(new Error('Command failed (1): gh'), { code: 1, stdout, stderr: `gh: HTTP ${status}` })
  return { stdout, stderr: '' }
}

const pullJson = (repo: Repo, pull: Pull) => ({
  number: pull.number, state: pull.state, merged: pull.merged, html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  head: { ref: pull.head, sha: pull.mergedSha ?? repos.get(pull.headRepo.toLowerCase())!.branches.get(pull.head) ?? '' },
})

async function gh(command: string, args: string[], options: RunFileOptions = {}) {
  expect(command).toBe('gh')
  if (args[0] === 'auth') {
    expect(args).toEqual(['auth', 'token', '--hostname', 'github.com', '--user', 'octocat'])
    return { stdout: 'tok-octocat\n', stderr: '' }
  }
  const inputAt = args.indexOf('--input')
  const input = inputAt >= 0 ? JSON.parse(readFileSync(args[inputAt + 1], 'utf8')) : undefined
  calls.push({ args, env: options.env, input })
  if (ghFailure) throw Object.assign(new Error('Command failed (1): gh'), { code: 1, stdout: '', stderr: ghFailure })
  const [endpoint, method] = [args[1], args[args.indexOf('--method') + 1]]
  const failure = failOn?.(method, endpoint)
  if (failure) return answer(failure, { message: 'Server Error' })
  if (endpoint === 'graphql') {
    if (beforeCommit) {
      const hook = beforeCommit
      beforeCommit = null
      await hook()
    }
    const change = input.variables.input
    const repo = repos.get(change.branch.repositoryNameWithOwner.toLowerCase())!
    const head = repo.branches.get(change.branch.branchName)
    if (head !== change.expectedHeadOid) return answer(200, { errors: [{ message: `Expected branch to point to "${change.expectedHeadOid}" but it did not` }] })
    const files = new Map(commits.get(head!)!)
    for (const addition of change.fileChanges.additions) files.set(addition.path, Buffer.from(addition.contents, 'base64').toString('utf8'))
    const oid = commit(files)
    repo.branches.set(change.branch.branchName, oid)
    if (afterCommit) {
      const hook = afterCommit
      afterCommit = null
      hook()
    }
    return answer(200, { data: { createCommitOnBranch: { commit: { oid } } } })
  }
  const match = /^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(endpoint.split('?')[0])!
  const repo = repos.get(match[1].toLowerCase())
  const rest = match[2] ?? ''
  const ref = new URLSearchParams(endpoint.split('?')[1] ?? '').get('ref')
  if (!repo) return answer(404, { message: 'Not Found' })
  if (!rest && method === 'GET') {
    return answer(200, { full_name: repo.fullName, owner: { login: repo.owner }, default_branch: repo.defaultBranch, permissions: { push: repo.push } })
  }
  if (rest.startsWith('contents/') && method === 'GET') {
    const sha = repo.branches.get(ref!)
    const text = sha ? commits.get(sha)!.get(decodeURIComponent(rest.slice('contents/'.length))) : undefined
    if (text === undefined) return answer(404, { message: 'Not Found' })
    return answer(200, { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), sha: `blob-${sha}` })
  }
  if (rest.startsWith('git/ref/heads/') && method === 'GET') {
    const sha = repo.branches.get(rest.slice('git/ref/heads/'.length).split('/').map(decodeURIComponent).join('/'))
    return sha ? answer(200, { object: { sha } }) : answer(404, { message: 'Not Found' })
  }
  if (rest === 'git/refs' && method === 'POST') {
    const name = input.ref.replace(/^refs\/heads\//, '')
    if (repo.branches.has(name)) return answer(422, { message: 'Reference already exists' })
    if (!commits.has(input.sha)) return answer(422, { message: 'Object does not exist' })
    repo.branches.set(name, input.sha)
    return answer(201, { ref: input.ref, object: { sha: input.sha } })
  }
  if (rest === 'pulls' && method === 'POST') {
    const [owner, branch] = input.head.includes(':') ? input.head.split(':') : [repo.owner, input.head]
    const headRepo = [...repos.values()].find((r) => r.owner === owner && r.branches.has(branch))!
    const pull: Pull = { number: 100 + repo.pulls.size + 1, state: 'open', merged: false, head: branch, headRepo: headRepo.fullName, base: input.base, title: input.title, body: input.body }
    repo.pulls.set(pull.number, pull)
    return answer(201, pullJson(repo, pull))
  }
  const pullMatch = /^pulls\/(\d+)$/.exec(rest)
  if (pullMatch && method === 'GET') return answer(200, pullJson(repo, repo.pulls.get(Number(pullMatch[1]))!))
  if (rest === 'forks' && method === 'POST') {
    const name = `octocat/${repo.fullName.split('/')[1]}`
    if (!repos.has(name)) {
      const copy: Repo = { fullName: name, owner: 'octocat', defaultBranch: repo.defaultBranch, push: true, branches: new Map([[repo.defaultBranch, repo.branches.get(repo.defaultBranch)!]]), pulls: new Map() }
      repos.set(name, copy)
    }
    return answer(202, { full_name: name })
  }
  throw new Error(`unexpected gh api call: ${method} ${endpoint}`)
}

/* ---------------------------------------------------------------- the sites */

const MIKKO_YAML = `version: 1
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
const JOURNAL_YAML = `version: 1
site: Other Journal
sections:
  - name: Posts
    path: _posts/{date}-{slug}.md
    url: https://journal.example/{year}/{slug}/
    slug: "^[a-z0-9-]+$"
    fields:
      layout: { kind: text, value: post }
      title: { kind: text, required: true }
      canonical_url: { kind: canonical }
`
// A site with a long text field and no limit of its own.
const NOTES_YAML = `version: 1
site: Notes
sections:
  - name: Notes
    path: notes/{slug}.md
    slug: "^[a-z0-9-]+$"
    first_line: title
    fields:
      title: { kind: text, required: true }
      note: { kind: text, lines: many }
      words: { kind: list }
`
// A site whose address, not its path, carries the date.
const DATED_YAML = `version: 1
site: Dated
sections:
  - name: Posts
    path: posts/{slug}.md
    url: https://dated.example/{year}/{slug}/
    slug: "^[a-z0-9-]+$"
    first_line: title
    fields:
      title: { kind: text, required: true }
      date: { kind: date, required: true }
`
const WRITING_YAML = 'topics:\n  - tag: machine-intelligence\n  - tag: ad-fraud\n'
const POST = 'src/content/writing/a-better-question.md'

let root = ''
let server: Server | undefined
let base = ''
let database: typeof import('../server/db') | undefined
let editor: typeof import('../server/editor') | undefined
let release: typeof import('../server/release-background') | undefined
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

async function request(path: string, method = 'GET', body?: unknown): Promise<{ status: number, body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await response.json() }
}

async function writeDocument(slug: string, content: string): Promise<void> {
  await editor!.writeDoc(slug, content)
}

const DOC = 'draft-1'
const TEXT = '# A better question\n\nThe opening paragraph.\n\n## A section\n\nMore.\n'

function writing(values: Record<string, unknown> = {}, slug = 'a-better-question') {
  return { repo: 'mikkokotila/mikkokotila-com', section: 'Writing', slug, values: { type: 'essay', date: '2026-10-17', tags: ['ad-fraud'], ...values } }
}

async function publish(destinations: unknown[], replace = false) {
  return request(`/api/editor/doc/${DOC}/publish`, 'POST', { destinations, ...(replace ? { replace } : {}) })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-publishing-api-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  repos = new Map()
  commits = new Map()
  calls = []
  ghFailure = null
  failOn = null
  beforeCommit = null
  afterCommit = null
  addRepo('mikkokotila/mikkokotila-com', { 'publish.yaml': MIKKO_YAML, 'content/writing.yaml': WRITING_YAML })
  mocks.runFile.mockReset().mockImplementation(gh)
  vi.resetModules()
  database = await import('../server/db')
  database.setMeta('me', 'octocat')
  database.setMeta('agentAccount', 'octo-agent')
  database.setMeta('timezone', 'Europe/Helsinki')
  editor = await import('../server/editor')
  release = await import('../server/release-background')
  const { handlePublishingApi } = await import('../server/publishing-api')
  server = createServer((req, res) => {
    void handlePublishingApi(req, res, req.url!).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end('{}') }
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  if (database?.db.open) database.closeDatabase()
  database = undefined
  editor = undefined
  server = undefined
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

describe('Settings → Publishing', () => {
  it('adds a site by its repository and shows what a writer fills in', async () => {
    expect(await request('/api/publishing/sites')).toEqual({ status: 200, body: { sites: [] } })
    const added = await request('/api/publishing/sites', 'POST', { repo: 'https://github.com/mikkokotila/mikkokotila-com.git/' })
    expect(added.status).toBe(200)
    expect(added.body.site).toEqual({
      repo: 'mikkokotila/mikkokotila-com',
      state: 'ready',
      source: 'repository',
      site: 'mikkokotila.com',
      sections: [{
        name: 'Writing',
        url: 'https://mikkokotila.com/writing/{slug}/',
        firstLine: 'title',
        fields: [
          { name: 'type', kind: 'choice', required: false, default: 'essay', choices: ['essay', 'note'] },
          { name: 'title', kind: 'text', required: true, max: 220 },
          { name: 'description', kind: 'text', required: false, max: 420, lines: 'many' },
          { name: 'date', kind: 'date', required: true, default: 'today' },
          { name: 'tags', kind: 'list', required: false, suggestions: ['machine-intelligence', 'ad-fraud'] },
        ],
      }],
    })
    expect((await request('/api/publishing/sites')).body.sites).toHaveLength(1)
    expect((await request('/api/publishing/sites', 'POST', { repo: 'MikkoKotila/mikkokotila-com' })).status).toBe(409)
    // Every read is as the writer's own account.
    expect(calls.every((call) => call.env?.GH_TOKEN === 'tok-octocat')).toBe(true)
  })

  it('says what is wrong with a site, and takes a description for a repository without one', async () => {
    addRepo('acme/journal', {})
    addRepo('acme/broken', { 'publish.yaml': MIKKO_YAML.replace('version: 1', 'version: 2') })
    expect((await request('/api/publishing/sites', 'POST', { repo: 'acme/nowhere' }))).toEqual({
      status: 404, body: { error: 'acme/nowhere does not exist, or octocat cannot see it' },
    })
    expect((await request('/api/publishing/sites', 'POST', { repo: 'not a repository' })).status).toBe(400)
    const missing = (await request('/api/publishing/sites', 'POST', { repo: 'acme/journal' })).body.site
    expect(missing).toEqual({ repo: 'acme/journal', state: 'missing', source: null, problem: 'acme/journal has no publish.yaml. Add one to the repository, or describe the site here.' })
    const broken = (await request('/api/publishing/sites', 'POST', { repo: 'acme/broken' })).body.site
    expect(broken).toMatchObject({ state: 'invalid', source: 'repository', problem: 'publish.yaml in acme/broken: version: must be 1' })

    const refused = await request('/api/publishing/sites/acme/journal/description', 'PUT', { description: 'version: 1\nsite: x\n' })
    expect(refused).toEqual({ status: 400, body: { error: 'sections: a list of one to twenty sections' } })
    expect((await request('/api/publishing/sites')).body.sites[0].state).toBe('missing')

    const described = await request('/api/publishing/sites/acme/journal/description', 'PUT', { description: JOURNAL_YAML })
    expect(described.body.site).toMatchObject({ state: 'ready', source: 'settings', site: 'Other Journal', description: JOURNAL_YAML })
    expect(described.body.site.sections[0].fields).toEqual([{ name: 'title', kind: 'text', required: true }])

    expect((await request('/api/publishing/sites/acme/broken', 'DELETE')).body).toEqual({ ok: true })
    expect((await request('/api/publishing/sites')).body.sites.map((s: any) => s.repo)).toEqual(['acme/journal'])
  })

  it('keeps both sites when two are added at once', async () => {
    addRepo('acme/one', { 'publish.yaml': MIKKO_YAML })
    addRepo('acme/two', { 'publish.yaml': MIKKO_YAML })
    const added = await Promise.all(['acme/one', 'acme/two'].map((repo) => request('/api/publishing/sites', 'POST', { repo })))
    expect(added.map((a) => a.status)).toEqual([200, 200])
    expect((await request('/api/publishing/sites')).body.sites.map((s: any) => s.repo).sort()).toEqual(['acme/one', 'acme/two'])
  })

  it('asks for your GitHub account before reading any site', async () => {
    database!.setMeta('me', '')
    expect(await request('/api/publishing/sites', 'POST', { repo: 'mikkokotila/mikkokotila-com' })).toEqual({
      status: 400, body: { error: 'Set your GitHub account in Settings → General before publishing.' },
    })
  })
})

describe('publishing a document', () => {
  beforeEach(async () => {
    await request('/api/publishing/sites', 'POST', { repo: 'mikkokotila/mikkokotila-com' })
    await writeDocument(DOC, TEXT)
  })

  it('opens a pull request with the file, as your account, and remembers it', async () => {
    const before = await request(`/api/editor/doc/${DOC}/publishing`)
    expect(before.body).toEqual({ title: 'A better question', slug: 'a-better-question', today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), publications: [] })

    const published = await publish([writing({ description: 'An opening.' })])
    expect(published.status).toBe(200)
    expect(published.body.results).toEqual([expect.objectContaining({
      repo: 'mikkokotila/mikkokotila-com', section: 'Writing', ok: true,
      publication: expect.objectContaining({
        path: POST, url: 'https://mikkokotila.com/writing/a-better-question/',
        pullRequest: { number: 101, url: 'https://github.com/mikkokotila/mikkokotila-com/pull/101', state: 'open' }, changed: false,
      }),
    })])
    expect(fileOn('mikkokotila/mikkokotila-com', 'publish/a-better-question', POST)).toBe([
      '---',
      'type: "essay"',
      'title: "A better question"',
      'description: "An opening."',
      'date: "2026-10-17"',
      'origins:',
      '  - venue: "mikkokotila.com"',
      'tags:',
      '  - "ad-fraud"',
      '---',
      '',
      'The opening paragraph.',
      '',
      '## A section',
      '',
      'More.',
      '',
    ].join('\n'))
    expect(fileOn('mikkokotila/mikkokotila-com', 'main', POST)).toBeUndefined()
    const pull = repos.get('mikkokotila/mikkokotila-com')!.pulls.get(101)!
    expect(pull).toMatchObject({ title: 'A better question', head: 'publish/a-better-question', base: 'main', state: 'open' })
    expect(pull.body).toContain(`- File: \`${POST}\``)
    // One commit, through GraphQL, and never as the automation account.
    expect(calls.filter((call) => call.args[1] === 'graphql')).toHaveLength(1)
    expect(calls.every((call) => call.env?.GH_TOKEN === 'tok-octocat' && call.env?.GITHUB_TOKEN === undefined)).toBe(true)

    const after = await request(`/api/editor/doc/${DOC}/publishing`)
    expect(after.body.publications).toEqual([expect.objectContaining({ slug: 'a-better-question', changed: false, pullRequest: expect.objectContaining({ state: 'open' }) })])
    await writeDocument(DOC, `${TEXT}\nA new ending.\n`)
    expect((await request(`/api/editor/doc/${DOC}/publishing`)).body.publications[0].changed).toBe(true)
  })

  it('updates the same pull request while it is open, then opens an update once it is merged', async () => {
    await publish([writing()])
    await writeDocument(DOC, `${TEXT}\nA second thought.\n`)
    const again = await publish([writing()])
    expect(again.body.results[0]).toMatchObject({ ok: true, publication: { pullRequest: { number: 101, state: 'open' } } })
    expect(repos.get('mikkokotila/mikkokotila-com')!.pulls.size).toBe(1)
    expect(fileOn('mikkokotila/mikkokotila-com', 'publish/a-better-question', POST)).toContain('A second thought.')

    merge('mikkokotila/mikkokotila-com', 101)
    // On the site, the tagger adds a tag after the merge.
    editOnSite('mikkokotila/mikkokotila-com', 'main', POST, (text) => text.replace('  - "ad-fraud"', '  - "ad-fraud"\n  - "machine-intelligence"'))
    await writeDocument(DOC, `${TEXT}\nA third thought.\n`)
    const update = await publish([writing()])
    expect(update.body.results[0]).toMatchObject({ ok: true, publication: { pullRequest: { number: 102, state: 'open' } } })
    const pull = repos.get('mikkokotila/mikkokotila-com')!.pulls.get(102)!
    expect(pull).toMatchObject({ title: 'Update: A better question', head: 'publish/a-better-question-2', base: 'main' })
    const updated = fileOn('mikkokotila/mikkokotila-com', 'publish/a-better-question-2', POST)!
    expect(updated).toContain('A third thought.')
    expect(updated).toContain('  - "machine-intelligence"')
  })

  it('refuses the text changed on both sides until told to replace it', async () => {
    await publish([writing()])
    editOnSite('mikkokotila/mikkokotila-com', 'publish/a-better-question', POST, (text) => text.replace('More.', 'More, said the editor.'))
    await writeDocument(DOC, TEXT.replace('More.', 'More, said the writer.'))
    const refused = await publish([writing()])
    expect(refused.body.results[0]).toEqual({
      repo: 'mikkokotila/mikkokotila-com', section: 'Writing', ok: false, conflicts: ['the text'],
      error: 'Changed on mikkokotila.com since you published: the text. Publish again to replace it with this document\'s version.',
    })
    expect(fileOn('mikkokotila/mikkokotila-com', 'publish/a-better-question', POST)).toContain('said the editor')

    const replaced = await publish([writing()], true)
    expect(replaced.body.results[0].ok).toBe(true)
    expect(fileOn('mikkokotila/mikkokotila-com', 'publish/a-better-question', POST)).toContain('said the writer')
  })

  it('keeps a change made on the site at every later publication, not only the next', async () => {
    await publish([writing()])
    // In review, a maintainer adds a tag and edits the text.
    editOnSite('mikkokotila/mikkokotila-com', 'publish/a-better-question', POST, (text) => text
      .replace('  - "ad-fraud"', '  - "ad-fraud"\n  - "machine-intelligence"').replace('More.', 'More, said the editor.'))
    for (const description of ['A first description.', 'A second description.']) {
      expect((await publish([writing({ description })])).body.results[0]).toMatchObject({ ok: true })
      const file = fileOn('mikkokotila/mikkokotila-com', 'publish/a-better-question', POST)!
      expect(file).toContain(`description: "${description}"`)
      expect(file).toContain('  - "machine-intelligence"')
      expect(file).toContain('More, said the editor.')
    }
    // The text changed here as well, after the editor's change: a conflict, never a silent replacement.
    await writeDocument(DOC, TEXT.replace('More.', 'More, said the writer.'))
    expect((await publish([writing({ description: 'A second description.' })])).body.results[0]).toMatchObject({ ok: false, conflicts: ['the text'] })
  })

  it('keeps the date in a path when a section without a date field is published again another day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-17T10:00:00Z'))
      addRepo('acme/journal', {})
      await request('/api/publishing/sites', 'POST', { repo: 'acme/journal' })
      await request('/api/publishing/sites/acme/journal/description', 'PUT', { description: JOURNAL_YAML })
      const journal = { repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }
      expect((await publish([journal])).body.results[0].ok).toBe(true)
      vi.setSystemTime(new Date('2027-01-05T10:00:00Z'))
      await writeDocument(DOC, `${TEXT}\nA later thought.\n`)
      expect((await publish([journal])).body.results[0]).toMatchObject({
        ok: true,
        publication: { path: '_posts/2026-10-17-a-better-question.md', url: 'https://journal.example/2026/a-better-question/', pullRequest: { number: 101 } },
      })
      expect(fileOn('acme/journal', 'publish/a-better-question', '_posts/2026-10-17-a-better-question.md')).toContain('A later thought.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a pull request closed unmerged as no publication, and never takes over a file someone added since', async () => {
    await publish([writing()])
    close('mikkokotila/mikkokotila-com', 101)
    expect((await request(`/api/editor/doc/${DOC}/publishing`)).body.publications[0].pullRequest.state).toBe('closed')
    const repo = repos.get('mikkokotila/mikkokotila-com')!
    const files = new Map(commits.get(repo.branches.get('main')!)!)
    files.set(POST, 'Someone else\'s piece.\n')
    repo.branches.set('main', commit(files))
    const refused = await publish([writing()], true)
    expect(refused.body.results[0]).toMatchObject({ ok: false, error: `${POST} is already in mikkokotila/mikkokotila-com, and this document did not publish it. Choose another slug.` })
    expect(fileOn('mikkokotila/mikkokotila-com', 'main', POST)).toBe('Someone else\'s piece.\n')
  })

  it('names no site whose values are refused, or whose publication is closed unmerged', async () => {
    addRepo('acme/journal', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/journal' })
    await request('/api/publishing/sites/acme/journal/description', 'PUT', { description: JOURNAL_YAML })
    const journal = { repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }
    // The original's values are refused: the copy names no original.
    const results = (await publish([writing({ type: 'poem' }), journal])).body.results
    expect(results.map((r: any) => r.ok)).toEqual([false, true])
    const copy = [...commits.get(repos.get('acme/journal')!.branches.get('publish/a-better-question')!)!.values()].join('\n')
    expect(copy).toContain('title: "A better question"')
    expect(copy).not.toContain('canonical_url')

    // A publication closed unmerged is named nowhere.
    close('acme/journal', 101)
    expect((await publish([writing()])).body.results[0].ok).toBe(true)
    expect(fileOn('mikkokotila/mikkokotila-com', 'publish/a-better-question', POST)).not.toContain('Other Journal')
  })

  it('publishes again, without it, a file that named a site which then failed', async () => {
    addRepo('acme/journal', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/journal' })
    await request('/api/publishing/sites/acme/journal/description', 'PUT', { description: JOURNAL_YAML })
    failOn = (method, endpoint) => (method === 'POST' && endpoint === 'repos/acme/journal/git/refs' ? 500 : null)
    const results = (await publish([writing(), { repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }])).body.results
    expect(results.map((r: any) => r.ok)).toEqual([true, false])
    expect(fileOn('mikkokotila/mikkokotila-com', 'publish/a-better-question', POST)).not.toContain('Other Journal')
    expect(calls.filter((call) => call.args[1] === 'graphql')).toHaveLength(2)
    expect(repos.get('mikkokotila/mikkokotila-com')!.pulls.size).toBe(1)
  })

  it('admits no publication while Poise installs an update, and counts one in progress', async () => {
    release!.pauseReleaseBackground()
    expect(await publish([writing()])).toEqual({ status: 503, body: { error: 'Poise is installing an update; nothing was published.' } })
    release!.resumeReleaseBackground()
    let busy = -1
    let lock = ''
    beforeCommit = async () => {
      busy = release!.releaseBackgroundBusy()
      // Another Poise sharing this Editor folder waits for the lock.
      lock = await editor!.withPublishLock(async () => 'free', 50).catch((error: Error) => error.message)
    }
    expect((await publish([writing()])).body.results[0].ok).toBe(true)
    expect(busy).toBe(1)
    expect(lock).toBe('Another Poise is publishing from this Editor folder; try again once it has finished.')
    expect(release!.releaseBackgroundBusy()).toBe(0)
  })

  it('opens a pull request of its own when the open one is merged while committing', async () => {
    await publish([writing()])
    await writeDocument(DOC, `${TEXT}\nA late thought.\n`)
    beforeCommit = () => merge('mikkokotila/mikkokotila-com', 101)
    const again = await publish([writing()])
    expect(again.body.results[0]).toMatchObject({ ok: true, publication: { pullRequest: { number: 102, state: 'open' } } })
    expect(repos.get('mikkokotila/mikkokotila-com')!.pulls.get(102)).toMatchObject({ title: 'Update: A better question', head: 'publish/a-better-question', base: 'main', state: 'open' })
    expect((await editor!.readPublishLedger(DOC)).records[0].pullRequest.number).toBe(102)
  })

  it('refuses before anything is written when the record would grow past 1 MB', async () => {
    addRepo('acme/notes', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/notes' })
    await request('/api/publishing/sites/acme/notes/description', 'PUT', { description: NOTES_YAML })
    const before = calls.length
    const refused = await publish([{ repo: 'acme/notes', section: 'Notes', slug: 'a-better-question', values: { note: 'x'.repeat(600_000) } }])
    expect(refused).toEqual({ status: 413, body: { error: 'The record of where this document is published would grow past 1 MB. Publish to fewer sites at once, or shorten the longest fields.' } })
    expect(calls.slice(before).filter((call) => call.args.includes('POST'))).toEqual([])
  })

  it('reports a site whose file cannot be read back, and publishes to the others', async () => {
    addRepo('acme/journal', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/journal' })
    await request('/api/publishing/sites/acme/journal/description', 'PUT', { description: JOURNAL_YAML })
    await publish([writing()])
    merge('mikkokotila/mikkokotila-com', 101)
    editOnSite('mikkokotila/mikkokotila-com', 'main', POST, (text) => text.replace('title: "A better question"', 'title: "unterminated'))
    await writeDocument(DOC, `${TEXT}\nA new ending.\n`)
    const published = await publish([writing(), { repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }])
    expect(published.status).toBe(200)
    expect(published.body.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/^The file on the site has frontmatter that is not valid YAML/) })
    expect(published.body.results[1].ok).toBe(true)
  })

  it('refuses a publication whose record would pass 1 MB on the way, not only at the end', async () => {
    for (const [repo, site] of [['acme/notes', 'Notes'], ['acme/more', 'More notes']]) {
      addRepo(repo, {})
      await request('/api/publishing/sites', 'POST', { repo })
      await request(`/api/publishing/sites/${repo}/description`, 'PUT', { description: NOTES_YAML.replace('site: Notes', `site: ${site}`) })
    }
    const note = (repo: string, text: string) => ({ repo, section: 'Notes', slug: 'a-better-question', values: { note: text } })
    expect((await publish([note('acme/notes', 'x'.repeat(400_000))])).body.results[0].ok).toBe(true)
    const before = calls.length
    // A new large record first, then a smaller one in place of the old: the end fits, the step between does not.
    const refused = await publish([note('acme/more', 'y'.repeat(400_000)), note('acme/notes', 'short')])
    expect(refused.status).toBe(413)
    expect(calls.slice(before).filter((call) => call.args.includes('POST'))).toEqual([])
  })

  it('corrects the original a copy names when the original fails to publish its new address', async () => {
    for (const [repo, yaml] of [['acme/dated', DATED_YAML], ['acme/journal', JOURNAL_YAML]]) {
      addRepo(repo, {})
      await request('/api/publishing/sites', 'POST', { repo })
      await request(`/api/publishing/sites/${repo}/description`, 'PUT', { description: yaml })
    }
    const dated = (date: string) => ({ repo: 'acme/dated', section: 'Posts', slug: 'a-better-question', values: { date } })
    expect((await publish([dated('2026-10-17')])).body.results[0].ok).toBe(true)
    await writeDocument(DOC, `${TEXT}\nAnother thought.\n`)
    // The copy goes first, naming the original's new address; the original then fails.
    let commitsSeen = 0
    failOn = (_method, endpoint) => (endpoint === 'graphql' && ++commitsSeen === 2 ? 500 : null)
    const results = (await publish([{ repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }, dated('2027-01-05')])).body.results
    expect(results.map((r: any) => r.ok)).toEqual([true, false])
    const copy = [...commits.get(repos.get('acme/journal')!.branches.get('publish/a-better-question')!)!.values()].join('\n')
    expect(copy).toContain('canonical_url: "https://dated.example/2026/a-better-question/"')
  })

  it("keeps the merged version this document's after a later update is closed unmerged", async () => {
    await publish([writing()])
    merge('mikkokotila/mikkokotila-com', 101)
    await writeDocument(DOC, `${TEXT}\nA second thought.\n`)
    expect((await publish([writing()])).body.results[0]).toMatchObject({ ok: true, publication: { pullRequest: { number: 102 } } })
    close('mikkokotila/mikkokotila-com', 102)
    const view = (await request(`/api/editor/doc/${DOC}/publishing`)).body.publications[0]
    expect(view).toMatchObject({ live: true, pullRequest: { number: 102, state: 'closed' } })
    await writeDocument(DOC, `${TEXT}\nA third thought.\n`)
    const again = await publish([writing()])
    expect(again.body.results[0]).toMatchObject({ ok: true, publication: { pullRequest: { number: 103 } } })
    expect(repos.get('mikkokotila/mikkokotila-com')!.pulls.get(103)).toMatchObject({ title: 'Update: A better question' })
    expect(fileOn('mikkokotila/mikkokotila-com', repos.get('mikkokotila/mikkokotila-com')!.pulls.get(103)!.head, POST)).toContain('A third thought.')
  })

  it('refuses a publication whose record could pass 1 MB if a site failed', async () => {
    for (const [repo, site] of [['acme/notes', 'Notes'], ['acme/more', 'More notes']]) {
      addRepo(repo, {})
      await request('/api/publishing/sites', 'POST', { repo })
      await request(`/api/publishing/sites/${repo}/description`, 'PUT', { description: NOTES_YAML.replace('site: Notes', `site: ${site}`) })
    }
    const note = (repo: string, text: string) => ({ repo, section: 'Notes', slug: 'a-better-question', values: { note: text } })
    expect((await publish([note('acme/notes', 'x'.repeat(400_000))])).body.results[0].ok).toBe(true)
    const before = calls.length
    // Shrinking first, then a large new record: it fits only if the shrinking succeeds.
    expect((await publish([note('acme/notes', 'short'), note('acme/more', 'y'.repeat(400_000))])).status).toBe(413)
    expect(calls.slice(before).filter((call) => call.args.includes('POST'))).toEqual([])
  })

  it("takes a site's new address even when the file is unchanged", async () => {
    addRepo('acme/journal', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/journal' })
    await request('/api/publishing/sites/acme/journal/description', 'PUT', { description: JOURNAL_YAML })
    const journal = { repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }
    expect((await publish([journal])).body.results[0].ok).toBe(true)
    await request('/api/publishing/sites/acme/journal/description', 'PUT', { description: JOURNAL_YAML.replace('journal.example', 'journal.example.org') })
    const again = (await publish([journal])).body.results[0]
    expect(again).toMatchObject({ ok: true, unchanged: true, publication: { url: expect.stringMatching(/^https:\/\/journal\.example\.org\//) } })
    expect((await editor!.readPublishLedger(DOC)).records[0].url).toMatch(/^https:\/\/journal\.example\.org\//)
  })

  it("counts the merged version a record keeps when it checks the record's size", async () => {
    addRepo('acme/notes', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/notes' })
    await request('/api/publishing/sites/acme/notes/description', 'PUT', { description: NOTES_YAML })
    const note = (text: string) => ({ repo: 'acme/notes', section: 'Notes', slug: 'a-better-question', values: { note: text } })
    expect((await publish([note('x'.repeat(300_000))])).body.results[0].ok).toBe(true)
    merge('acme/notes', 101)
    const before = calls.length
    // 400,000 characters as values and as frontmatter, and the 300,000 that landed, pass 1 MB together.
    expect((await publish([note('y'.repeat(400_000))])).status).toBe(413)
    expect(calls.slice(before).filter((call) => call.args.includes('POST'))).toEqual([])
  })

  it('names the address that landed, not a later update closed unmerged', async () => {
    for (const [repo, yaml] of [['acme/dated', DATED_YAML], ['acme/journal', JOURNAL_YAML]]) {
      addRepo(repo, {})
      await request('/api/publishing/sites', 'POST', { repo })
      await request(`/api/publishing/sites/${repo}/description`, 'PUT', { description: yaml })
    }
    const dated = (date: string) => ({ repo: 'acme/dated', section: 'Posts', slug: 'a-better-question', values: { date } })
    expect((await publish([dated('2026-10-17')])).body.results[0].ok).toBe(true)
    merge('acme/dated', 101)
    await writeDocument(DOC, `${TEXT}\nAnother thought.\n`)
    expect((await publish([dated('2027-01-05')])).body.results[0]).toMatchObject({ ok: true, publication: { pullRequest: { number: 102 } } })
    close('acme/dated', 102)
    expect((await publish([{ repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }])).body.results[0].ok).toBe(true)
    const copy = [...commits.get(repos.get('acme/journal')!.branches.get('publish/a-better-question')!)!.values()].join('\n')
    expect(copy).toContain('canonical_url: "https://dated.example/2026/a-better-question/"')
  })

  it("keeps what merged during a commit the document's when the new pull request is closed unmerged", async () => {
    await publish([writing()])
    await writeDocument(DOC, `${TEXT}\nA late thought.\n`)
    beforeCommit = () => merge('mikkokotila/mikkokotila-com', 101)
    expect((await publish([writing()])).body.results[0]).toMatchObject({ ok: true, publication: { pullRequest: { number: 102 } } })
    close('mikkokotila/mikkokotila-com', 102)
    await writeDocument(DOC, `${TEXT}\nA later thought.\n`)
    expect((await publish([writing()])).body.results[0]).toMatchObject({ ok: true, publication: { pullRequest: { number: 103 } } })
  })

  it('lets a merged long note be shortened, though it was long', async () => {
    addRepo('acme/notes', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/notes' })
    await request('/api/publishing/sites/acme/notes/description', 'PUT', { description: NOTES_YAML })
    const note = (text: string) => ({ repo: 'acme/notes', section: 'Notes', slug: 'a-better-question', values: { note: text } })
    expect((await publish([note('x'.repeat(400_000))])).body.results[0].ok).toBe(true)
    merge('acme/notes', 101)
    expect((await publish([note('y'.repeat(100_000))])).body.results[0].ok).toBe(true)
  })

  it('measures a record as it is written, where a long list outgrows a long text', async () => {
    addRepo('acme/notes', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/notes' })
    await request('/api/publishing/sites/acme/notes/description', 'PUT', { description: NOTES_YAML })
    const at = (values: Record<string, unknown>) => ({ repo: 'acme/notes', section: 'Notes', slug: 'a-better-question', values })
    expect((await publish([at({ note: 'x'.repeat(400_000) })])).body.results[0].ok).toBe(true)
    const before = calls.length
    // Smaller than the note as compact JSON, larger than 1 MB as the record writes it.
    const words = Array.from({ length: 40_000 }, (_, i) => `w${i}`)
    expect((await publish([at({ words })])).status).toBe(413)
    expect(calls.slice(before).filter((call) => call.args.includes('POST'))).toEqual([])
  })

  it('reconciles with the latest merged version, so a reversion to an earlier one is published', async () => {
    await publish([writing()])
    merge('mikkokotila/mikkokotila-com', 101)
    await writeDocument(DOC, TEXT.replace('More.', 'More, for a while.'))
    expect((await publish([writing()])).body.results[0].publication.pullRequest.number).toBe(102)
    merge('mikkokotila/mikkokotila-com', 102)
    // Back to the first version.
    await writeDocument(DOC, TEXT)
    const reverted = (await publish([writing()])).body.results[0]
    expect(reverted).toMatchObject({ ok: true, publication: { pullRequest: { number: 103 } } })
    expect(reverted.unchanged).toBeUndefined()
    const head = repos.get('mikkokotila/mikkokotila-com')!.pulls.get(103)!.head
    expect(fileOn('mikkokotila/mikkokotila-com', head, POST)).not.toContain('for a while')
  })

  it('corrects a merged, unchanged copy on the site, not on its gone pull request branch', async () => {
    for (const [repo, yaml] of [['acme/journal', JOURNAL_YAML], ['acme/dated', DATED_YAML]]) {
      addRepo(repo, {})
      await request('/api/publishing/sites', 'POST', { repo })
      await request(`/api/publishing/sites/${repo}/description`, 'PUT', { description: yaml })
    }
    const journal = { repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }
    expect((await publish([journal])).body.results[0].ok).toBe(true)
    merge('acme/journal', 101)
    repos.get('acme/journal')!.branches.delete('publish/a-better-question')
    // The journal is the original and has this version; the new site fails.
    failOn = (method, endpoint) => (method === 'POST' && endpoint === 'repos/acme/dated/git/refs' ? 500 : null)
    const results = (await publish([journal, { repo: 'acme/dated', section: 'Posts', slug: 'a-better-question', values: { date: '2026-10-17' } }])).body.results
    expect(results.map((r: any) => r.ok)).toEqual([true, false])
  })

  it("counts what a merge during the commit would add to an open publication's record", async () => {
    addRepo('acme/notes', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/notes' })
    await request('/api/publishing/sites/acme/notes/description', 'PUT', { description: NOTES_YAML })
    const note = (text: string) => ({ repo: 'acme/notes', section: 'Notes', slug: 'a-better-question', values: { note: text } })
    expect((await publish([note('x'.repeat(400_000))])).body.results[0].ok).toBe(true)
    const before = calls.length
    // Its open pull request could merge while the new 400,000 characters are committed.
    expect((await publish([note('y'.repeat(400_000))])).status).toBe(413)
    expect(calls.slice(before).filter((call) => call.args.includes('POST'))).toEqual([])
  })

  it('names the address a date changed on the site gives, as the file keeps that date', async () => {
    for (const [repo, yaml] of [['acme/dated', DATED_YAML], ['acme/journal', JOURNAL_YAML]]) {
      addRepo(repo, {})
      await request('/api/publishing/sites', 'POST', { repo })
      await request(`/api/publishing/sites/${repo}/description`, 'PUT', { description: yaml })
    }
    const dated = { repo: 'acme/dated', section: 'Posts', slug: 'a-better-question', values: { date: '2026-10-17' } }
    expect((await publish([dated])).body.results[0].ok).toBe(true)
    merge('acme/dated', 101)
    // A maintainer dates it earlier on the site.
    editOnSite('acme/dated', 'main', 'posts/a-better-question.md', (text) => text.replace('date: "2026-10-17"', 'date: "2025-03-01"'))
    const results = (await publish([dated, { repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }])).body.results
    expect(results[0]).toMatchObject({ ok: true, unchanged: true, publication: { url: 'https://dated.example/2025/a-better-question/' } })
    const copy = [...commits.get(repos.get('acme/journal')!.branches.get('publish/a-better-question')!)!.values()].join('\n')
    expect(copy).toContain('canonical_url: "https://dated.example/2025/a-better-question/"')
  })

  it("counts the larger of what landed and what is open when it checks the record's size", async () => {
    addRepo('acme/notes', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/notes' })
    await request('/api/publishing/sites/acme/notes/description', 'PUT', { description: NOTES_YAML })
    const note = (text: string) => ({ repo: 'acme/notes', section: 'Notes', slug: 'a-better-question', values: { note: text } })
    expect((await publish([note('short')])).body.results[0].ok).toBe(true)
    merge('acme/notes', 101)
    expect((await publish([note('x'.repeat(400_000))])).body.results[0].publication.pullRequest.number).toBe(102)
    const before = calls.length
    // Open with 400,000 characters over a short landed note: a merge during the commit would land the long one.
    expect((await publish([note('y'.repeat(400_000))])).status).toBe(413)
    expect(calls.slice(before).filter((call) => call.args.includes('POST'))).toEqual([])
  })

  it('takes a merge that included this commit as the update landing', async () => {
    await publish([writing()])
    await writeDocument(DOC, TEXT.replace('More.', 'More, merged at once.'))
    afterCommit = () => merge('mikkokotila/mikkokotila-com', 101)
    const landed = (await publish([writing()])).body.results[0]
    expect(landed).toMatchObject({ ok: true, publication: { pullRequest: { number: 101, state: 'merged' } } })
    expect(repos.get('mikkokotila/mikkokotila-com')!.pulls.size).toBe(1)
    // Back to the first version: a change of this document's, published.
    await writeDocument(DOC, TEXT)
    const reverted = (await publish([writing()])).body.results[0]
    expect(reverted).toMatchObject({ ok: true, publication: { pullRequest: { number: 102 } } })
    const head = repos.get('mikkokotila/mikkokotila-com')!.pulls.get(102)!.head
    expect(fileOn('mikkokotila/mikkokotila-com', head, POST)).not.toContain('merged at once')
  })

  it('corrects from what the first pass landed, so a failed site is not kept', async () => {
    addRepo('acme/journal', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/journal' })
    await request('/api/publishing/sites/acme/journal/description', 'PUT', { description: JOURNAL_YAML })
    await publish([writing()])
    merge('mikkokotila/mikkokotila-com', 101)
    await writeDocument(DOC, `${TEXT}\nA second thought.\n`)
    expect((await publish([writing()])).body.results[0].publication.pullRequest.number).toBe(102)
    // The update merges with its new commit in it; the journal then fails.
    await writeDocument(DOC, `${TEXT}\nA third thought.\n`)
    afterCommit = () => merge('mikkokotila/mikkokotila-com', 102)
    failOn = (method, endpoint) => (method === 'POST' && endpoint === 'repos/acme/journal/git/refs' ? 500 : null)
    const results = (await publish([writing(), { repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }])).body.results
    expect(results.map((r: any) => r.ok)).toEqual([true, false])
    const correction = repos.get('mikkokotila/mikkokotila-com')!.pulls.get(103)
    expect(correction).toBeDefined()
    expect(fileOn('mikkokotila/mikkokotila-com', correction!.head, POST)).not.toContain('Other Journal')
  })

  it('counts this new version as what a merge during the commit could land', async () => {
    addRepo('acme/notes', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/notes' })
    await request('/api/publishing/sites/acme/notes/description', 'PUT', { description: NOTES_YAML })
    const note = (text: string) => ({ repo: 'acme/notes', section: 'Notes', slug: 'a-better-question', values: { note: text } })
    expect((await publish([note('short')])).body.results[0].ok).toBe(true)
    const before = calls.length
    expect((await publish([note('x'.repeat(400_000))])).status).toBe(413)
    expect(calls.slice(before).filter((call) => call.args.includes('POST'))).toEqual([])
  })

  it('remembers the first line each publication was made with', async () => {
    await publish([writing({ title: 'A title typed in the panel' })])
    expect((await request(`/api/editor/doc/${DOC}/publishing`)).body.publications[0]).toMatchObject({
      docTitle: 'A better question', values: { title: 'A title typed in the panel' },
    })
  })

  it('weighs landed versions in bytes, as the record is written', async () => {
    const { largestOf } = await import('../server/publishing-api')
    const ascii = { data: { note: 'a'.repeat(150) }, bodySha: '', pullRequest: 1, url: '' }
    const cjk = { data: { note: '漢'.repeat(100) }, bodySha: '', pullRequest: 2, url: '' }
    expect(largestOf([ascii, cjk])).toBe(cjk)
  })

  it('says nothing changed when the site has this version already', async () => {
    await publish([writing()])
    const commitsBefore = calls.filter((call) => call.args[1] === 'graphql').length
    const again = await publish([writing()])
    expect(again.body.results[0]).toMatchObject({ ok: true, unchanged: true })
    expect(calls.filter((call) => call.args[1] === 'graphql')).toHaveLength(commitsBefore)
  })

  it('publishes from your fork where you cannot push', async () => {
    repos.get('mikkokotila/mikkokotila-com')!.push = false
    const published = await publish([writing()])
    expect(published.body.results[0].ok).toBe(true)
    expect(fileOn('octocat/mikkokotila-com', 'publish/a-better-question', POST)).toContain('The opening paragraph.')
    expect(repos.get('mikkokotila/mikkokotila-com')!.branches.has('publish/a-better-question')).toBe(false)
    expect(repos.get('mikkokotila/mikkokotila-com')!.pulls.get(101)).toMatchObject({ headRepo: 'octocat/mikkokotila-com', head: 'publish/a-better-question' })
  })

  it('never writes over a file the document did not publish, or under a new slug', async () => {
    const repo = repos.get('mikkokotila/mikkokotila-com')!
    const files = new Map(commits.get(repo.branches.get('main')!)!)
    files.set(POST, 'Someone else\'s piece.\n')
    repo.branches.set('main', commit(files))
    const refused = await publish([writing()])
    expect(refused.body.results[0]).toMatchObject({ ok: false, error: `${POST} is already in mikkokotila/mikkokotila-com, and this document did not publish it. Choose another slug.` })
    expect(fileOn('mikkokotila/mikkokotila-com', 'main', POST)).toBe('Someone else\'s piece.\n')

    expect((await publish([writing({}, 'another-name')])).body.results[0].ok).toBe(true)
    const renamed = await publish([writing({}, 'a-third-name')])
    expect(renamed.body.results[0]).toMatchObject({ ok: false, problems: ['This piece is published on mikkokotila.com as src/content/writing/another-name.md; publish it with slug another-name and its date unchanged.'] })
  })

  it('publishes to two sites at once, naming each in the other', async () => {
    addRepo('acme/journal', {})
    await request('/api/publishing/sites', 'POST', { repo: 'acme/journal' })
    await request('/api/publishing/sites/acme/journal/description', 'PUT', { description: JOURNAL_YAML })
    const published = await publish([writing(), { repo: 'acme/journal', section: 'Posts', slug: 'a-better-question', values: { title: 'A better question' } }])
    expect(published.body.results.map((r: any) => r.ok)).toEqual([true, true])
    // The journal has no date field: today, in Helsinki, dates its file and address.
    const { today } = await import('../server/publishing')
    const day = today('Europe/Helsinki')
    expect(fileOn('mikkokotila/mikkokotila-com', 'publish/a-better-question', POST)).toContain([
      'origins:',
      '  - venue: "mikkokotila.com"',
      '  - venue: "Other Journal"',
      `    url: "https://journal.example/${day.slice(0, 4)}/a-better-question/"`,
    ].join('\n'))
    const journal = commits.get(repos.get('acme/journal')!.branches.get('publish/a-better-question')!)!
    const [path, text] = [...journal.entries()].find(([p]) => p.startsWith('_posts/'))!
    expect(path).toBe(`_posts/${day}-a-better-question.md`)
    expect(text).toContain('layout: "post"')
    expect(text).toContain('canonical_url: "https://mikkokotila.com/writing/a-better-question/"')
    expect((await request(`/api/editor/doc/${DOC}/publishing`)).body.publications.map((p: any) => p.site)).toEqual(['mikkokotila.com', 'Other Journal'])
  })

  it('says what is wrong with the values, and publishes nothing', async () => {
    const result = await publish([writing({ type: 'poem', tags: ['Not A Tag'] })])
    expect(result.body.results[0]).toMatchObject({
      ok: false,
      problems: ['type must be one of essay, note.', 'tags: "Not A Tag" does not match the site\'s pattern ^[a-z0-9]+(?:-[a-z0-9]+)*$.'],
    })
    expect(repos.get('mikkokotila/mikkokotila-com')!.branches.has('publish/a-better-question')).toBe(false)
    expect((await publish([{ ...writing(), repo: 'acme/unknown' }])).status).toBe(404)
  })

  it('keeps the token out of every error', async () => {
    ghFailure = 'error connecting with tok-octocat: connection refused'
    const result = await publish([writing()])
    expect(JSON.stringify(result.body)).not.toContain('tok-octocat')
    expect(result.status).toBe(502)
    expect(result.body.error).toBe('mikkokotila/mikkokotila-com: GitHub could not be reached: error connecting with ***: connection refused')
  })

  it('takes the record with the document when it is deleted', async () => {
    await publish([writing()])
    expect((await editor!.readPublishLedger(DOC)).records).toHaveLength(1)
    await editor!.deleteDoc(DOC)
    expect((await editor!.readPublishLedger(DOC)).records).toEqual([])
  })
})
