import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { loadConfig } from '../../gateway/src/config'
import { DockerClient } from '../../gateway/src/docker'
import { createGateway } from '../../gateway/src/gateway'
import { GitHubClient } from '../../gateway/src/github'
import { loadOrCreateKeys } from '../../gateway/src/keys'
import { createLogger } from '../../gateway/src/log'
import { Orchestrator } from '../../gateway/src/orchestrator'
import { Store } from '../../gateway/src/store'

test('submits MCP consent to a registered callback whose origin is also a font source', async ({ page, context, request, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium enforces form-action on the consent redirect.')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-consent-'))
  const config = loadConfig({ POISE_DOMAIN: 'poise.test', POISE_MCP_ENABLED: '1', POISE_GATEWAY_DATA: dir,
    POISE_GITHUB_CLIENT_ID: 'fixture', POISE_GITHUB_CLIENT_SECRET: 'fixture', POISE_ADMINS: 'alice',
    POISE_GITHUB_URL: 'https://github.poise.invalid', POISE_GITHUB_API_URL: 'https://github.poise.invalid',
    POISE_GATEWAY_CONTAINER: 'fixture-gateway', POISE_RUNTIME_IMAGE: 'fixture-runtime' })
  const log = createLogger(line => console.log(line))
  const store = new Store(join(dir, 'gateway.db'), Date.now)
  const keys = loadOrCreateKeys(dir, log)
  // Consent needs no workspace or Docker calls; neither client points at a live service.
  const docker = new DockerClient(join(dir, 'unused-docker.sock'))
  const upstream = () => ({ host: 'unused.poise.invalid', port: 5555 })
  const deps = { config, store, keys, docker, log, now: Date.now, upstream }
  const gateway = createGateway({ ...deps, github: new GitHubClient(config), orchestrator: new Orchestrator(deps) })
  const cdp = await context.newCDPSession(page)
  try {
    await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
    const local = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`
    const apex = 'https://poise.test'
    const callback = 'https://rsms.me/callback'
    store.saveSignIn({ handle: 'alice', login: 'Alice', githubId: 1001, accessOrg: null })
    const session = store.createApexSession('alice', 60_000)
    await context.addCookies([{ name: 'poise_gw', value: session.id, url: apex, httpOnly: true, secure: true, sameSite: 'Lax' }])
    // Playwright routes only the first request in a redirect chain. CDP also
    // isolates the callback while Chromium still enforces the real page's CSP.
    cdp.on('Fetch.requestPaused', async ({ requestId, request: incoming }) => {
      const url = new URL(incoming.url)
      if (url.origin === apex) {
        const response = await request.fetch(`${local}${url.pathname}${url.search}`, {
          method: incoming.method, headers: { ...incoming.headers, host: url.host },
          data: incoming.postData, maxRedirects: 0,
        })
        await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: response.status(),
          responseHeaders: response.headersArray(), body: (await response.body()).toString('base64') })
      } else if (`${url.origin}${url.pathname}` === callback) {
        await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/html' }],
          body: Buffer.from('<p>Registered callback reached</p>').toString('base64') })
      } else await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' })
    })
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    const registration = await request.post(`${local}/mcp/register`, { headers: { host: 'poise.test' },
      data: { redirect_uris: [callback], token_endpoint_auth_method: 'none' } })
    expect(registration.status()).toBe(201)
    const verifier = 'a'.repeat(43)
    const params = new URLSearchParams({ client_id: (await registration.json()).client_id, redirect_uri: callback,
      response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', resource: `${apex}/mcp`, scope: 'poise:read', state: 'collision-state' })
    const consent = await page.goto(`${apex}/mcp/authorize?${params}`)
    expect(consent?.headers()['content-security-policy']).toContain('font-src https://rsms.me;')
    await page.getByRole('button', { name: 'Allow read access' }).click()
    await expect(page.getByText('Registered callback reached', { exact: true })).toBeVisible()
    const arrived = new URL(page.url())
    expect(`${arrived.origin}${arrived.pathname}`).toBe(callback)
    expect(arrived.searchParams.get('state')).toBe('collision-state')
    expect(arrived.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  } finally {
    await page.close()
    await gateway.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
