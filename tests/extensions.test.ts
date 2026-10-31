// Extensions on the server: definitions, write-only secrets, what a chat
// receives, the registry mirror built from real registry entries, and the
// API the view uses. Nothing here starts a server's command or reaches the
// network: checks are replaced and the registry is a local fake.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../server/db'
import { createServer as addServer, addEvent, deleteServer, listEvents, listServers, redactSecrets, secretValues, serverView, setDefault, setWorkspace, updateServer, writeSecret } from '../server/extensions/store'
import { extensionsFor, recordDelivery, scrubEvent } from '../server/extensions/delivery'
import { FEATURED, directoryEntry, directoryEntryByName, directoryStatus, installSpec, searchDirectory, syncDirectory } from '../server/extensions/registry'
import { REMOTE_DESKTOP_COMMANDER } from '../server/extensions/builtin'
import { createExtensionsApi } from '../server/extensions/http'
import { forAcp, forClaude, forCodex, forMuse, parseImport, reaches, validateSpec, workspaceOf, type ServerSpec } from '../server/extensions/types'

const SAMPLE = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/extensions/registry-sample.json'), 'utf8')) as Array<{ server: { name: string } }>
const raw = (name: string) => SAMPLE.find((entry) => entry.server.name === name)!

function local(name: string, extra: Partial<ServerSpec> = {}): ServerSpec {
  return validateSpec({ name, title: name, source: 'custom', transport: 'stdio', command: process.execPath, args: ['server.mjs'], env: [{ name: 'PLAIN', value: 'visible' }, { name: 'TOKEN', secret: true }], ...extra })
}
const everywhere = { default: true, workspaces: {} }

function reset(): void {
  db.exec('DELETE FROM extension_servers; DELETE FROM extension_directory')
  db.prepare("DELETE FROM meta WHERE key = 'extension_directory_sync'").run()
}

describe('server definitions', () => {
  it('accepts a local command and a remote URL, and refuses what would break an agent or leak a secret', () => {
    expect(validateSpec({ name: 'ops', title: 'Ops', source: 'custom', transport: 'http', url: 'https://ops.example.test/mcp', headers: [{ name: 'Authorization', secret: true }] }))
      .toEqual({ name: 'ops', title: 'Ops', source: 'custom', transport: 'http', auth: 'none', url: 'https://ops.example.test/mcp', headers: [{ name: 'Authorization', secret: true }] })
    const refused = (input: Record<string, unknown>) => () => validateSpec({ name: 'ops', source: 'custom', transport: 'stdio', command: 'npx', ...input })
    expect(refused({ name: 'Ops Tools' })).toThrow(/lowercase letters/)
    expect(refused({ command: 'npx\nrm -rf /' })).toThrow(/single line/)
    expect(refused({ env: [{ name: '1BAD', value: 'x' }] })).toThrow(/not a valid environment variable name/)
    expect(refused({ env: [{ name: 'A', value: 'x' }, { name: 'A', value: 'y' }] })).toThrow(/listed twice/)
    expect(refused({ transport: 'http', url: 'https://user:pass@example.test/mcp' })).toThrow(/not in the URL/)
    expect(refused({ transport: 'http', url: 'ftp://example.test' })).toThrow(/https:\/\/ or http/)
    expect(refused({ auth: 'oauth' })).toThrow(/OAuth sign-in is for remote servers/)
    expect(refused({ transport: 'http', headers: [{ name: 'X-Key', value: 'a\r\nInjected: 1' }], url: 'https://example.test' })).toThrow(/single line/)
  })

  it('maps one server set to each agent\'s own shape, and says which agents cannot take SSE', () => {
    const servers = [
      { id: '1', name: 'probe', title: 'Probe', transport: 'stdio' as const, command: 'node', args: ['p.mjs'], env: {} },
      { id: '2', name: 'legacy', title: 'Legacy', transport: 'sse' as const, url: 'https://legacy.test/sse', headers: { 'X-Key': 'k' } },
    ]
    expect(forClaude(servers)).toEqual({ probe: { type: 'stdio', command: 'node', args: ['p.mjs'] }, legacy: { type: 'sse', url: 'https://legacy.test/sse', headers: { 'X-Key': 'k' } } })
    expect(forCodex(servers)).toEqual({ config: { 'mcp_servers.probe': { command: 'node', args: ['p.mjs'], startup_timeout_sec: 60 } }, skipped: [{ name: 'Legacy', reason: 'Codex takes local commands and Streamable HTTP servers, not SSE' }] })
    expect(forMuse(servers).skipped).toEqual([{ name: 'Legacy', reason: 'Muse takes local commands and Streamable HTTP servers, not SSE' }])
    expect(forAcp(servers, { http: true }).skipped).toEqual([{ name: 'Legacy', reason: 'this Grok does not accept SSE MCP servers' }])
    expect(reaches('sse').filter((reach) => !reach.ok).map((reach) => reach.agent)).toEqual(['codex', 'muse'])
    expect(workspaceOf({ repo: '' })).toBe('local')
    expect(workspaceOf({ repo: 'acme/app' })).toBe('acme/app')
  })

  it('reads a pasted mcpServers block, keeping credentials as secrets', () => {
    const [remote, command] = parseImport(JSON.stringify({ mcpServers: {
      Docs: { type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer abcdefgh12345' } },
      sentry: { command: 'npx', args: ['-y', '@sentry/mcp-server'], env: { SENTRY_ACCESS_TOKEN: 'sntrys_abc', SENTRY_HOST: 'sentry.io' } },
    } }))
    expect(remote.spec).toMatchObject({ name: 'docs', title: 'Docs', transport: 'http', headers: [{ name: 'Authorization', secret: true }] })
    expect(remote.secrets).toEqual({ 'header:Authorization': 'Bearer abcdefgh12345' })
    expect(command.spec.env).toEqual([{ name: 'SENTRY_ACCESS_TOKEN', secret: true }, { name: 'SENTRY_HOST', value: 'sentry.io', secret: false }])
    expect(command.secrets).toEqual({ 'env:SENTRY_ACCESS_TOKEN': 'sntrys_abc' })
    expect(() => parseImport('{"mcpServers": {}}')).toThrow(/empty/)
    expect(() => parseImport('not json')).toThrow(/not JSON/)
  })
})

describe('the store', () => {
  beforeEach(reset)

  it('keeps secrets out of every view and needs a value for each', () => {
    expect(() => addServer(local('probe'), {}, everywhere)).toThrow(/Enter a value for TOKEN/)
    const view = addServer(local('probe'), { 'env:TOKEN': 'tok-abcdef-123456' }, everywhere)
    expect(view.env).toEqual([{ name: 'PLAIN', value: 'visible', secret: false }, { name: 'TOKEN', secret: true, set: true }])
    expect(JSON.stringify(listServers())).not.toContain('tok-abcdef-123456')
    expect(() => addServer(local('probe'), { 'env:TOKEN': 'x' }, everywhere)).toThrow(/already exists/)
    expect(() => addServer(local('other'), { 'env:TOKEN': 'x', 'env:NOPE': 'y' }, everywhere)).toThrow(/not a secret of this server/)
  })

  it('keeps an omitted secret on edit, replaces a typed one, and erases one the definition dropped', () => {
    const view = addServer(local('probe'), { 'env:TOKEN': 'first-secret-value' }, everywhere)
    updateServer(view.id, local('probe', { title: 'Renamed' }), {})
    expect(secretValues()).toContain('first-secret-value')
    updateServer(view.id, local('probe'), { 'env:TOKEN': 'second-secret-value' })
    expect(secretValues()).toEqual(['second-secret-value'])
    updateServer(view.id, local('probe', { env: [] }), {})
    expect(secretValues()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM extension_secrets').get()).toEqual({ n: 0 })
  })

  it('forgets an OAuth sign-in when a remote server moves', () => {
    const remote = (url: string) => validateSpec({ name: 'linear', source: 'custom', transport: 'http', url, auth: 'oauth' })
    const view = addServer(remote('https://mcp.linear.app/mcp'), {}, everywhere)
    writeSecret(view.id, 'oauth:tokens', JSON.stringify({ tokens: { access_token: 'access-token-123', token_type: 'Bearer' }, obtainedAt: Date.now(), redirectUrl: 'http://localhost/extensions/oauth' }))
    updateServer(view.id, validateSpec({ name: 'linear-2', source: 'custom', transport: 'http', url: 'https://mcp.linear.app/mcp', auth: 'oauth' }), {})
    expect(serverView(view.id).signedIn).toBe(true)
    updateServer(view.id, remote('https://elsewhere.example.test/mcp'), {})
    expect(serverView(view.id).signedIn).toBe(false)
  })

  it('switches per workspace, and a new default leaves the workspaces already shown as they were', () => {
    const view = addServer(local('probe'), { 'env:TOKEN': 'secret-value-1' }, { default: false, workspaces: {} })
    setWorkspace(view.id, 'acme/app', true)
    const after = setDefault(view.id, true, ['acme/app', 'acme/web', 'local'])
    expect(after.enabled).toEqual({ default: true, workspaces: { 'acme/app': true, 'acme/web': false, local: false } })
  })

  it('erases every secret with the server, and scrubs them from text and events', () => {
    const view = addServer(local('probe'), { 'env:TOKEN': 'sk-quote"and\\\\slash' }, everywhere)
    expect(redactSecrets('value sk-quote"and\\\\slash here')).toBe('value [redacted] here')
    expect(redactSecrets(JSON.stringify({ text: 'sk-quote"and\\\\slash' }))).toBe('{"text":"[redacted]"}')
    const event = scrubEvent({ type: 'text.delta', turnId: 't', messageId: 'm', delta: 'token sk-quote"and\\\\slash' })
    expect(event).toEqual({ type: 'text.delta', turnId: 't', messageId: 'm', delta: 'token [redacted]' })
    addEvent(view.id, 'error', 'failed with sk-quote"and\\\\slash')
    expect(listEvents(view.id)[0].text).not.toContain('sk-quote')
    deleteServer(view.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM extension_secrets').get()).toEqual({ n: 0 })
    expect(secretValues()).toEqual([])
  })

  it('keeps the last 100 activity lines', () => {
    const view = addServer(local('probe'), { 'env:TOKEN': 'secret-value-1' }, everywhere)
    for (let n = 0; n < 105; n++) addEvent(view.id, 'info', `line ${n}`)
    const events = listEvents(view.id)
    expect(events).toHaveLength(100)
    expect(events[0].text).toBe('line 104')
  })
})

describe('what a chat receives', () => {
  beforeEach(reset)

  it('gives a workspace its switched-on servers with secrets filled in', async () => {
    const probe = addServer(local('probe'), { 'env:TOKEN': 'secret-value-1' }, { default: false, workspaces: { 'acme/app': true } })
    addServer(local('elsewhere'), { 'env:TOKEN': 'secret-value-2' }, { default: false, workspaces: { 'acme/web': true } })
    const set = await extensionsFor({ repo: 'acme/app' })
    expect(set.servers).toEqual([{ id: probe.id, name: 'probe', title: 'probe', transport: 'stdio', command: process.execPath, args: ['server.mjs'], env: { PLAIN: 'visible', TOKEN: 'secret-value-1' } }])
    expect(set.notices).toEqual([])
    expect((await extensionsFor({ repo: '' })).servers).toEqual([])
    const before = set.fingerprint
    setWorkspace(probe.id, 'acme/app', false)
    expect((await extensionsFor({ repo: 'acme/app' })).fingerprint).not.toBe(before)
  })

  it('tells the chat about a server that needs a sign-in instead of sending it without one', async () => {
    addServer(validateSpec({ name: 'linear', title: 'Linear', source: 'custom', transport: 'http', url: 'https://mcp.linear.app/mcp', auth: 'oauth' }), {}, everywhere)
    const set = await extensionsFor({ repo: 'acme/app' })
    expect(set.servers).toEqual([])
    expect(set.notices).toEqual(['Extensions: Linear needs a sign-in, so this chat runs without it. Sign in in Extensions; the next turn picks it up.'])
  })

  it('records each delivery on the server\'s activity', async () => {
    const probe = addServer(local('probe'), { 'env:TOKEN': 'secret-value-1' }, everywhere)
    const set = await extensionsFor({ repo: 'acme/app' })
    recordDelivery({ title: 'Fix the build', repo: 'acme/app', agent: 'codex' }, set, [])
    recordDelivery({ title: 'Plan', repo: '', agent: 'muse' }, set, [{ name: 'probe', reason: 'Muse refused it' }])
    expect(listEvents(probe.id).map((event) => event.text)).toEqual(['Not delivered to Muse chat “Plan” in Poise · local: Muse refused it', 'Delivered to Codex chat “Fix the build” in acme/app'])
  })
})

describe('the directory', () => {
  let registry: Server
  let pages: unknown[][] = []
  let failures = 0
  let requests: string[] = []
  const savedPath = process.env.PATH

  beforeAll(async () => {
    registry = createServer((req, res) => {
      const url = new URL(req.url!, 'http://registry.test')
      requests.push(url.search)
      if (failures > 0) { failures--; res.statusCode = 500; return res.end('{}') }
      const index = Number(url.searchParams.get('cursor') ?? 0)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ servers: pages[index] ?? [], metadata: index + 1 < pages.length ? { nextCursor: String(index + 1) } : {} }))
    })
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve))
    process.env.POISE_MCP_REGISTRY_URL = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`
  })
  afterAll(async () => { delete process.env.POISE_MCP_REGISTRY_URL; await new Promise((resolve) => registry.close(resolve)) })
  beforeEach(() => { reset(); pages = [SAMPLE.slice(0, 6), SAMPLE.slice(6)]; failures = 0; requests = [] })
  afterEach(() => { process.env.PATH = savedPath })

  it('maps real registry entries: remotes with headers and variables, packages with environment, and what Poise cannot run', () => {
    expect(directoryEntry(raw('ai.exa/exa'))).toMatchObject({ title: 'exa', publisher: 'exa.ai', options: [{ id: 'remote-0', kind: 'remote', transport: 'http', summary: 'https://mcp.exa.ai/mcp', inputs: [] }] })
    expect(directoryEntry(raw('ai.avaloncompany/web-content-url-tools'))!.options[0].inputs).toMatchObject([{ key: 'header:Authorization:apify_token', required: true, secret: true }])
    expect(directoryEntry(raw('ai.autorfp/mcp'))!.options[0].inputs).toMatchObject([{ key: 'url:api_host', required: true, choices: ['api.autorfp.ai', 'api.eu.autorfp.ai', 'api.us.autorfp.ai'] }])
    const npm = directoryEntry(raw('ai.2kw/mcp-server'))!.options[0]
    expect(npm).toMatchObject({ kind: 'package', command: 'npx', args: ['-y', '@2kw/ai-mcp-server@7.3.2'], summary: 'npx -y @2kw/ai-mcp-server@7.3.2' })
    expect(npm.inputs.map((input) => [input.key, input.required, input.secret])).toEqual([['env:AI_2KW_API_KEY', true, true], ['env:AI_2KW_BASE_URL', false, false], ['env:AI_2KW_MEMORY', false, false]])
    expect(directoryEntry(raw('ai.kaiv/postgres'))!.options[0].unsupported).toMatch(/secret on its command line/)
    expect(directoryEntry(raw('ai.aliengiraffe/spotdb'))!.options[0].unsupported).toMatch(/does not run oci packages/)
    expect(directoryEntry(raw('ai.1court.state/court-directory'))!.options.map((option) => option.transport)).toEqual(['http', 'sse'])
    expect(directoryEntry(SAMPLE.at(-1))).toBeNull()
  })

  it('keeps only HTTPS links from the registry, which the page renders', () => {
    const exa = raw('ai.exa/exa') as { server: Record<string, unknown> }
    const hostile = { ...exa, server: { ...exa.server, websiteUrl: 'javascript:alert(document.cookie)', repository: { url: 'data:text/html,<script>alert(1)</script>' } } }
    const entry = directoryEntry(hostile)!
    expect(entry.websiteUrl).toBeUndefined()
    expect(entry.repositoryUrl).toBeUndefined()
    expect(directoryEntry({ ...exa, server: { ...exa.server, websiteUrl: 'https://exa.ai' } })!.websiteUrl).toBe('https://exa.ai')
  })

  it('turns an option and the entered values into a definition and its secrets', () => {
    const header = installSpec(directoryEntry(raw('ai.avaloncompany/web-content-url-tools'))!, 'remote-0', { 'header:Authorization:apify_token': 'apify_api_123' }, 'web-tools')
    expect(header.spec).toMatchObject({ name: 'web-tools', source: 'directory', transport: 'http', headers: [{ name: 'Authorization', secret: true }], registry: { name: 'ai.avaloncompany/web-content-url-tools', option: 'remote-0' } })
    expect(header.secrets).toEqual({ 'header:Authorization': 'Bearer apify_api_123' })
    expect(installSpec(directoryEntry(raw('ai.autorfp/mcp'))!, 'remote-0', { 'url:api_host': 'api.eu.autorfp.ai' }, 'rfp').spec.url).toBe('https://api.eu.autorfp.ai/mcp')
    const npm = installSpec(directoryEntry(raw('ai.2kw/mcp-server'))!, 'package-0', { 'env:AI_2KW_API_KEY': 'k-123', 'env:AI_2KW_MEMORY': 'true' }, '2kw')
    expect(npm.spec).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@2kw/ai-mcp-server@7.3.2'], env: [{ name: 'AI_2KW_API_KEY', secret: true }, { name: 'AI_2KW_MEMORY', value: 'true', secret: false }] })
    expect(npm.secrets).toEqual({ 'env:AI_2KW_API_KEY': 'k-123' })
    expect(() => installSpec(directoryEntry(raw('ai.2kw/mcp-server'))!, 'package-0', {}, '2kw')).toThrow(/Enter AI_2KW_API_KEY/)
    // An optional secret header left empty is not sent at all.
    expect(installSpec(directoryEntry(raw('academy.apexai/apex-ai-academy'))!, 'remote-0', {}, 'apex').spec.headers).toEqual([])
  })

  it('crawls every page, retries a failing one, and replaces the catalog with the new crawl', async () => {
    failures = 2
    await syncDirectory({ force: true })
    expect(directoryStatus()).toMatchObject({ count: 10, syncing: false })
    expect(directoryStatus().completedAt).toBeTruthy()
    expect(requests.filter((query) => !query.includes('cursor')).length).toBe(3)
    pages = [SAMPLE.slice(1, 6)]
    await syncDirectory({ force: true })
    expect(directoryStatus().count).toBe(5)
    expect(() => directoryEntryByName('ai.exa/exa')).toThrow(/not in the directory/)
  })

  it('keeps what it has and resumes from the page that failed', async () => {
    failures = 4
    pages = [SAMPLE.slice(0, 6), SAMPLE.slice(6)]
    // The first page's three attempts fail; nothing is lost and the error is kept.
    await expect(syncDirectory({ force: true })).rejects.toThrow(/did not answer after 3 attempts/)
    expect(directoryStatus()).toMatchObject({ count: 0, error: expect.stringContaining('500') })
    // Opening the view right after a failure does not hammer the registry again.
    await syncDirectory()
    expect(requests.length).toBe(3)
    requests = []
    await syncDirectory({ force: true })
    expect(requests[0]).toBe('?limit=100&version=latest')
    expect(directoryStatus()).toMatchObject({ count: 10 })
    expect(directoryStatus().error).toBeUndefined()
  })

  it('searches its own copy, built-in and featured servers first, by kind', async () => {
    await syncDirectory({ force: true })
    const first = searchDirectory('', 'any', 3, 0)
    expect(first.featured).toBe(true)
    expect(first.entries.map((entry) => entry.name)).toEqual([REMOTE_DESKTOP_COMMANDER.name, ...FEATURED.filter((name) => ['app.linear/linear', 'ai.exa/exa'].includes(name))])
    expect(searchDirectory('linear', 'any', 10, 0).entries[0].name).toBe('app.linear/linear')
    expect(searchDirectory('', 'local', 50, 0).entries.every((entry) => entry.options.some((option) => option.kind === 'package'))).toBe(true)
    expect(searchDirectory('court directory', 'remote', 10, 0).total).toBe(1)
  })

  it('builds Remote Desktop Commander in: listed with no crawl, searchable, and installable like a directory server', () => {
    // No crawl ran here: the mirror is empty, yet the built-in is listed.
    expect(directoryStatus().count).toBe(0)
    const builtin = directoryEntryByName(REMOTE_DESKTOP_COMMANDER.name)
    expect(builtin).toMatchObject({ title: 'Remote Desktop Commander', builtin: true, options: [{ id: 'remote-0', kind: 'remote', transport: 'http', url: 'https://mcp.desktopcommander.app/mcp', inputs: [] }] })
    expect(searchDirectory('', 'any', 10, 0).entries[0].name).toBe(builtin.name)
    expect(searchDirectory('remote desktop', 'any', 10, 0).entries[0].name).toBe(builtin.name)
    expect(searchDirectory('', 'local', 10, 0).entries).toEqual([])
    const plan = installSpec(builtin, 'remote-0', {}, 'remote-desktop-commander')
    expect(plan.spec).toMatchObject({ name: 'remote-desktop-commander', source: 'directory', transport: 'http', url: 'https://mcp.desktopcommander.app/mcp', registry: { name: builtin.name, option: 'remote-0' } })
    expect(plan.secrets).toEqual({})
  })

  it('prefers the built-in to a mirror row of the same name', () => {
    db.prepare('INSERT INTO extension_directory (name, entry, generation) VALUES (?, ?, 1)').run(REMOTE_DESKTOP_COMMANDER.name, JSON.stringify({ ...REMOTE_DESKTOP_COMMANDER, title: 'Impostor', builtin: false }))
    expect(directoryEntryByName(REMOTE_DESKTOP_COMMANDER.name).title).toBe('Remote Desktop Commander')
    expect(searchDirectory('', 'any', 50, 0).entries.filter((entry) => entry.name === REMOTE_DESKTOP_COMMANDER.name)).toHaveLength(1)
  })

  it('marks a package Poise cannot launch on this host', async () => {
    await syncDirectory({ force: true })
    const bin = mkdtempSync(join(tmpdir(), 'poise-ext-bin-'))
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'npx'), 0o755)
    process.env.PATH = bin
    const armor = directoryEntryByName('ai.anomalyarmor/armor-mcp')
    expect(armor.options.find((option) => option.kind === 'package')?.unsupported).toBe('uvx is not installed where Poise runs.')
    expect(directoryEntryByName('ai.2kw/mcp-server').options[0].unsupported).toBeUndefined()
  })
})

describe('/api/extensions', () => {
  let http: Server
  let base = ''
  const checked: string[] = []
  const handler = createExtensionsApi({ recentWorkspaces: () => ['acme/app', 'acme/app', 'acme/web'], check: (id) => { checked.push(id) } })

  beforeAll(async () => {
    http = createServer(async (req, res) => { if (!(await handler(req, res, req.url!))) { res.statusCode = 404; res.end('{}') } })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  })
  afterAll(async () => { await new Promise((resolve) => http.close(resolve)) })
  beforeEach(() => { reset(); checked.length = 0 })

  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() as any }
  }
  const custom = { spec: { name: 'probe', title: 'Probe', source: 'custom', transport: 'stdio', command: 'node', args: ['probe.mjs'], env: [{ name: 'TOKEN', secret: true }] }, secrets: { 'env:TOKEN': 'api-secret-value-1' } }

  it('adds a custom server, checks it, and never sends a secret back', async () => {
    const created = await call('/api/extensions/servers', 'POST', { ...custom, enabled: { default: false, workspaces: { 'acme/app': true } } })
    expect(created.status).toBe(201)
    expect(created.body.env).toEqual([{ name: 'TOKEN', secret: true, set: true }])
    expect(checked).toEqual([created.body.id])
    const list = await call('/api/extensions')
    expect(JSON.stringify(list.body)).not.toContain('api-secret-value-1')
    expect(list.body.workspaces).toEqual([{ id: 'acme/app', label: 'acme/app' }, { id: 'acme/web', label: 'acme/web' }, { id: 'local', label: 'Poise · local' }])
    expect((await call('/api/extensions/servers', 'POST', { ...custom, secrets: {} })).body.error).toMatch(/already exists|Enter a value/)
  })

  it('lets an OAuth server move to a token', async () => {
    const id = (await call('/api/extensions/servers', 'POST', { spec: { name: 'ops', source: 'custom', transport: 'http', url: 'https://ops.example.test/mcp', auth: 'oauth' } })).body.id as string
    const edited = await call(`/api/extensions/servers/${id}`, 'PUT', { spec: { name: 'ops', source: 'custom', transport: 'http', url: 'https://ops.example.test/mcp', auth: 'none', headers: [{ name: 'Authorization', secret: true }] }, secrets: { 'header:Authorization': 'Bearer ops-token-123' } })
    expect(edited.body).toMatchObject({ auth: 'none', headers: [{ name: 'Authorization', secret: true, set: true }] })
  })

  it('shows the twelve most recently used workspaces, and any with a switch of its own', async () => {
    const many = createExtensionsApi({ recentWorkspaces: () => Array.from({ length: 20 }, (_, n) => `acme/repo-${n}`), check: () => undefined })
    const created = addServer(local('probe'), { 'env:TOKEN': 'secret-value-1' }, { default: false, workspaces: { 'acme/repo-19': true } })
    const res = { statusCode: 0, headers: {} as Record<string, string>, body: '', setHeader(name: string, value: string) { this.headers[name] = value }, end(text: string) { this.body = text } }
    await many({ method: 'GET', url: '/api/extensions' } as any, res as any, '/api/extensions')
    const ids = (JSON.parse(res.body).workspaces as Array<{ id: string }>).map((workspace) => workspace.id)
    expect(ids).toEqual([...Array.from({ length: 12 }, (_, n) => `acme/repo-${n}`), 'local', 'acme/repo-19'])
    deleteServer(created.id)
  })

  it('edits, switches, removes, and answers for a server that is gone', async () => {
    const id = (await call('/api/extensions/servers', 'POST', custom)).body.id as string
    const edited = await call(`/api/extensions/servers/${id}`, 'PUT', { spec: { ...custom.spec, title: 'Probe 2' } })
    expect(edited.body).toMatchObject({ title: 'Probe 2', env: [{ name: 'TOKEN', set: true }] })
    expect((await call(`/api/extensions/servers/${id}/enabled`, 'PUT', { workspace: 'acme/web', on: true })).body.enabled.workspaces).toEqual({ 'acme/web': true })
    expect((await call(`/api/extensions/servers/${id}/enabled`, 'PUT', { default: true })).body.enabled).toEqual({ default: true, workspaces: { 'acme/web': true, 'acme/app': false, local: false } })
    expect((await call(`/api/extensions/servers/${id}/enabled`, 'PUT', { workspace: 'not a repo', on: true })).status).toBe(400)
    expect((await call(`/api/extensions/servers/${id}`, 'DELETE')).status).toBe(200)
    expect((await call(`/api/extensions/servers/${id}`, 'DELETE')).status).toBe(404)
    expect((await call('/api/extensions')).body.servers).toEqual([])
  })

  it('refuses a directory server sent as custom, and a definition it cannot accept', async () => {
    expect((await call('/api/extensions/servers', 'POST', { spec: { ...custom.spec, source: 'directory' } })).status).toBe(400)
    expect((await call('/api/extensions/servers', 'POST', { spec: { ...custom.spec, name: 'Bad Name' } })).body.error).toMatch(/lowercase/)
    expect((await call('/api/extensions/servers', 'POST', { install: { entry: 'ai.exa/exa', option: 'remote-0' } })).status).toBe(404)
  })

  it('imports a pasted configuration with unique names', async () => {
    await call('/api/extensions/servers', 'POST', { ...custom, spec: { ...custom.spec, name: 'docs' } })
    const imported = await call('/api/extensions/import', 'POST', { json: JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example.test/mcp', headers: { 'X-Api-Key': 'docs-key-123456' } } } }) })
    expect(imported.status).toBe(201)
    expect(imported.body.servers[0]).toMatchObject({ name: 'docs-2', headers: [{ name: 'X-Api-Key', secret: true, set: true }] })
    expect(JSON.stringify(imported.body)).not.toContain('docs-key-123456')
  })

  it('installs from the directory with the values entered, leaving the command to the registry', async () => {
    db.prepare('INSERT INTO extension_directory (name, entry, generation) VALUES (?, ?, 1)').run('ai.exa/exa', JSON.stringify(directoryEntry(raw('ai.exa/exa'))))
    const created = await call('/api/extensions/servers', 'POST', { install: { entry: 'ai.exa/exa', option: 'remote-0', values: {} } })
    expect(created.body).toMatchObject({ name: 'exa', source: 'directory', transport: 'http', url: 'https://mcp.exa.ai/mcp', registry: { name: 'ai.exa/exa' } })
    const edited = await call(`/api/extensions/servers/${created.body.id}`, 'PUT', { spec: { ...created.body, url: 'https://evil.example.test/mcp', title: 'Exa search' } })
    expect(edited.body).toMatchObject({ title: 'Exa search', url: 'https://mcp.exa.ai/mcp' })
  })
})
