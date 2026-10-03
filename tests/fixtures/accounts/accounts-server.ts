// Test-only server for Settings → Connected accounts: the real GET
// /api/accounts and the real /ws/terminal, Python helper included, with the
// fake CLIs (fake-clis.ts) as the only programs on its PATH. The page's
// assets come from Playwright's preview server; no request here reaches a
// real CLI, a real login or a running Poise.

import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { invalidateAccounts, listAccounts } from '../../../server/accounts'
import { enforceApiRequest, httpStatus } from '../../../server/http'
import { TerminalSocketServer } from '../../../server/terminal/server'
import { fakePresetCommand } from './fake-presets'

const assets = process.env.ACCOUNTS_ASSETS_URL!
const fakes = process.env.FAKE_CLI_BIN
if (!fakes) throw new Error('FAKE_CLI_BIN must name the directory of fake CLIs')

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(value))
}

// A Connect terminal starts only once its CLI resolves to the fake.
const terminals = new TerminalSocketServer({}, { command: fakePresetCommand(fakes) })
terminals.on('exit', () => invalidateAccounts())

const server = createServer((req, res) => {
  void (async () => {
    const path = (req.url || '/').split('?')[0]
    if (path.startsWith('/api/')) {
      enforceApiRequest(req)
      if (path === '/api/accounts') return json(res, 200, { accounts: await listAccounts() })
      if (path === '/api/settings') return json(res, 200, { org: 'acme', me: 'octocat', agentAccount: 'octo-agent', timezone: 'UTC', models: {} })
      if (path === '/api/claude-auth') {
        return json(res, 200, { status: 'authenticated', reason: null, checkedAt: null, verifiedAt: null, authMethod: 'claude.ai', subscriptionType: 'max', loginInProgress: false })
      }
      if (path === '/api/gh') return json(res, 200, { records: [], count: 0 })
      return json(res, 200, {})
    }
    const response = await fetch(new URL(req.url || '/', assets), { signal: AbortSignal.timeout(10_000) })
    res.statusCode = response.status
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream')
    res.end(Buffer.from(await response.arrayBuffer()))
  })().catch((error: unknown) => json(res, httpStatus(error, 500), { error: error instanceof Error ? error.message : String(error) }))
})
terminals.attach(server)
server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: (server.address() as AddressInfo).port }))
})
