import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const unescape = value => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>')

/** Fixture browser completes the real gateway consent flow through the fake GitHub identity provider. */
export async function connectPoise(endpoint, login, fetcher = fetch) {
  let clientInformation, tokens, verifier, authorizationUrl
  const state = `fixture-${login}`
  const provider = {
    redirectUrl: 'http://127.0.0.1:19876/callback',
    clientMetadata: { redirect_uris: ['http://127.0.0.1:19876/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'poise:read' },
    clientInformation: () => clientInformation, saveClientInformation: value => { clientInformation = value },
    tokens: () => tokens, saveTokens: value => { tokens = value },
    codeVerifier: () => verifier, saveCodeVerifier: value => { verifier = value },
    state: () => state, redirectToAuthorization: value => { authorizationUrl = value },
  }
  const client = new Client({ name: 'poise-service-acceptance', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: provider, fetch: fetcher })
  await assert.rejects(client.connect(transport), UnauthorizedError)
  assert.ok(authorizationUrl, 'SDK discovery and registration must reach owner authorization')
  const cookies = new Map()
  const browser = async (target, init = {}) => {
    const url = new URL(target)
    if (url.pathname === '/login/oauth/authorize') url.searchParams.set('login', login)
    const stored = cookies.get(url.host) ?? new Map()
    const response = await fetcher(url, { ...init, redirect: 'manual', headers: { ...init.headers,
      cookie: [...stored].map(([name, value]) => `${name}=${value}`).join('; ') } })
    for (const line of response.headers.getSetCookie()) {
      const [entry] = line.split(';'), at = entry.indexOf('=')
      stored.set(entry.slice(0, at), entry.slice(at + 1))
    }
    cookies.set(url.host, stored)
    return response
  }
  let current = new URL(authorizationUrl)
  let response
  for (let hop = 0; hop < 8; hop++) {
    response = await browser(current)
    if (response.status === 200) break
    assert.equal(response.status, 302)
    current = new URL(response.headers.get('location'), current)
  }
  assert.equal(response?.status, 200)
  const consent = await response.text()
  const csrf = /name="csrf" value="([^"]+)"/.exec(consent)?.[1]
  const request = /name="request" value="([^"]+)"/.exec(consent)?.[1]
  assert.ok(csrf && request, 'owner consent must name the workspace and carry its browser proof')
  const approved = await browser(new URL('/mcp/authorize', endpoint), { method: 'POST', headers: {
    origin: new URL(endpoint).origin, 'content-type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ csrf: unescape(csrf), request: unescape(request), decision: 'approve' }) })
  assert.equal(approved.status, 303)
  const callback = new URL(approved.headers.get('location'))
  assert.equal(callback.searchParams.get('state'), state)
  const code = callback.searchParams.get('code')
  assert.ok(code)
  await transport.finishAuth(code)
  await transport.close()
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: provider, fetch: fetcher }))
  assert.ok(tokens?.access_token && tokens.refresh_token)
  return { client, tokens, provider }
}

export async function tool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, JSON.stringify(result))
  assert.ok(Array.isArray(result.content) && result.content[0]?.type === 'text')
  return JSON.parse(result.content[0].text)
}

async function acceptance(endpoint) {
  const alice = await connectPoise(endpoint, 'alice'), bob = await connectPoise(endpoint, 'bob')
  try {
    const description = await tool(alice.client, 'poise_describe')
    assert.equal(description.workspace, 'alice')
    assert.deepEqual(description.capabilities.tools, ['poise_describe', 'poise_work'])
    assert.equal((await tool(bob.client, 'poise_describe')).workspace, 'bob')
    const selector = { repository: 'fixtures/work', label: 'poise', limit: 2 }
    // Bob's home is newly provisioned. Alice's restored live backup can
    // correctly retain a prior ledger gap, which cannot establish absence.
    const { work: page } = await tool(bob.client, 'poise_work', selector)
    assert.equal(page.coverage.issues.status, 'fresh')
    assert.deepEqual(page.items.map(row => [row.issue, row.stage]), [[1, 'not_recorded'], [2, 'delayed']],
      JSON.stringify(page.items.map(row => ({ issue: row.issue, coverage: row.coverage, ledger: row.ledger.map(source => source.health) }))))
    assert.equal(page.items[0].author, 'third-party')
    assert.equal(page.items[0].chain, null)
    assert.deepEqual(page.items[0].receipts, [])
    assert.match(page.items[1].blocker, /capacity/)
    assert.ok(page.nextCursor)
    const continuation = { ...selector, cursor: page.nextCursor }
    const { work: next } = await tool(bob.client, 'poise_work', continuation)
    assert.deepEqual(next.items.map(row => row.issue), [3, 4])
    assert.deepEqual(next.items.map(row => [row.github.mergeSha, row.reviewStatus]), [['b'.repeat(40), 'complete'], ['b'.repeat(40), 'pending']])
    assert.equal(next.items[1].stage, 'merged_review_pending')
    const { work: missing } = await tool(bob.client, 'poise_work', { repository: 'fixtures/work', issue: 5 })
    assert.equal(missing.items[0].coverage.receipts.status, 'partial')
    assert.equal(missing.items[0].receipts[0].coverage, 'not-recorded')
    await assert.rejects(alice.client.callTool({ name: 'poise_work', arguments: continuation }))
    console.log('MCP discovery, OAuth, initialize, both tools, two owners and native work-trail evidence passed')
  } finally { await Promise.all([alice.client.close(), bob.client.close()]) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const endpoint = process.argv[2]
  assert.ok(endpoint, 'Usage: node deploy/ci/mcp-client.mjs ENDPOINT')
  if (process.argv[3] === '--stale') {
    const connection = await connectPoise(endpoint, 'bob')
    try {
      const { work } = await tool(connection.client, 'poise_work', { repository: 'fixtures/work', issue: 1 })
      assert.equal(work.coverage.issues.status, 'stale')
      assert.equal(work.items[0].stage, 'unknown')
      assert.notEqual(work.items[0].coverage.receipts.status, 'stale')
      console.log('Stale GitHub mirror remains separate from native Caller coverage')
    } finally { await connection.client.close() }
  } else {
    const directory = process.argv[3]
    assert.ok(directory, 'acceptance requires the generated private plugin directory')
    const plugin = resolve(directory, 'plugins/poise')
    const manifest = JSON.parse(await readFile(resolve(plugin, 'plugin.json'), 'utf8'))
    assert.equal(manifest.name, 'poise')
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
    const mcp = JSON.parse(await readFile(resolve(plugin, 'mcp.json'), 'utf8'))
    const url = new URL(endpoint); url.protocol = 'https:'
    assert.deepEqual(mcp, { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { poise: { type: 'streamable-http', url: url.href } } })
    assert.match(await readFile(resolve(plugin, 'skills/poise-manager/SKILL.md'), 'utf8'), /name: poise-manager/)
    await acceptance(endpoint)
  }
}
