// Extensions OAuth end to end against the real server and a local registry,
// OAuth provider and remote MCP server. The directory entries are real.

import { expect, test, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { workspace } from './fixtures/workspace'

test.describe.configure({ mode: 'serial' })

const port = Number(process.env.POISE_E2E_PORT ?? 5566) + 3
const remote = `http://127.0.0.1:${port}`
// Real registry entries; Exa's endpoint is pointed at this spec's server.
const entries = (JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/extensions/registry-sample.json'), 'utf8')) as Array<{ server: { name: string, remotes?: Array<{ url: string }> } }>)
  .map((entry) => entry.server.name === 'ai.exa/exa' ? { ...entry, server: { ...entry.server, remotes: [{ type: 'streamable-http', url: `${remote}/mcp` }] } } : entry)
const grants = new Map<string, string>()
let server: Server

const body = (req: IncomingMessage) => new Promise<string>((resolve) => { let text = ''; req.on('data', (chunk) => { text += chunk }); req.on('end', () => resolve(text)) })

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, remote)
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/v0.1/servers') return json(200, { servers: entries, metadata: { count: entries.length } })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${remote}/mcp`, authorization_servers: [remote] })
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: remote, authorization_endpoint: `${remote}/authorize`, token_endpoint: `${remote}/token`, registration_endpoint: `${remote}/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
    }
    if (url.pathname === '/register') return json(201, { ...JSON.parse(await body(req)), client_id: 'poise-e2e' })
    if (url.pathname === '/authorize') {
      const code = randomUUID()
      grants.set(code, url.searchParams.get('code_challenge')!)
      const back = new URL(url.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', code); back.searchParams.set('state', url.searchParams.get('state')!)
      res.writeHead(302, { location: back.href }); return res.end()
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await body(req))
      const challenge = grants.get(form.get('code') ?? '')
      if (!challenge || challenge !== createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')) return json(400, { error: 'invalid_grant' })
      return json(200, { access_token: 'e2e-access-token', refresh_token: 'e2e-refresh-token', token_type: 'Bearer', expires_in: 3600 })
    }
    if (url.pathname === '/mcp') {
      if (req.headers.authorization !== 'Bearer e2e-access-token') return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${remote}/.well-known/oauth-protected-resource/mcp"` })
      const mcp = new McpServer({ name: 'exa', version: '1.0.0' })
      mcp.registerTool('web_search_exa', { description: 'Searches the web.' }, async () => ({ content: [{ type: 'text', text: 'results' }] }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await mcp.connect(transport)
      const text = await body(req)
      return transport.handleRequest(req, res, text ? JSON.parse(text) : undefined)
    }
    json(404, {})
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
})
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

async function removeAll(page: Page): Promise<void> {
  const servers = (await (await page.request.get('/api/extensions')).json()).servers as Array<{ id: string }>
  for (const { id } of servers) await page.request.delete(`/api/extensions/servers/${id}`)
}

test('adds a directory server and signs in to it through the browser, back to Settings → Extensions', async ({ page }) => {
  await workspace(page, 'current', undefined, { realExtensions: true, preserveOnReload: true })
  await page.goto('/index.html?view=settings&settings=extensions')
  await expect(page.locator('#view-extensions')).toBeVisible()
  await removeAll(page)
  await page.reload()
  await page.getByRole('tab', { name: 'Directory' }).click()
  await page.getByLabel('Search the directory').fill('exa')
  await expect(page.locator('.ext-directory-status')).toContainText(/updated (\d{1,2} [A-Z][a-z]{2,3} (\d{4} )?)?\d{2}:\d{2}\./)
  await page.locator('.ext-card[data-entry="ai.exa/exa"]').click()
  await page.getByRole('button', { name: 'Add to Poise' }).click()
  await page.getByRole('button', { name: 'Add exa' }).click()
  const row = page.locator('.ext-matrix tbody tr', { hasText: 'exa' })
  await expect(row.locator('.ext-state')).toHaveText('Needs sign-in', { timeout: 30_000 })

  await row.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => url.pathname === '/' && url.searchParams.get('settings') === 'extensions' && !url.search.includes('code='))
  await expect(page.locator('.toast')).toHaveText('Signed in to exa. Chats pick it up from their next turn.')
  await expect(page.locator('.ext-matrix tbody tr', { hasText: 'exa' }).locator('.ext-state')).toHaveText('Connected · 1 tool', { timeout: 30_000 })
  expect(await page.content()).not.toContain('e2e-access-token')
})
