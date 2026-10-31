// Real production Accounts/terminal wiring, confined to fake CLIs and an
// isolated durable HOME. Browser tests restart this process against the same DB.
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { getMeta, setMeta } from '../../../server/db'
import { createProductionServer, shutdownProductionServer } from '../../../server/production'
import { createAuthenticatedClaudeAuth } from '../../claude-auth-fixture'
import { fakePresetCommand } from './fake-presets'

const fakes = process.env.FAKE_CLI_BIN
if (!fakes) throw new Error('FAKE_CLI_BIN must name the directory of fake CLIs')

// Existing setup is complete; login history must not change that state.
if (!getMeta('onboarding')) setMeta('onboarding', JSON.stringify({ status: 'done', step: 'finish', completedAt: '2026-10-09T07:00:00Z' }))
if (!getMeta('account_logins') && process.env.ACCOUNTS_SEED) setMeta('account_logins', process.env.ACCOUNTS_SEED)
setMeta('me', 'octocat')
setMeta('agentAccount', 'octo-agent')

const server = createProductionServer({
  staticDir: resolve('dist/client'),
  claudeAuth: createAuthenticatedClaudeAuth(),
  terminalCommand: fakePresetCommand(fakes),
})
server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: (server.address() as AddressInfo).port }))
})
process.once('SIGTERM', () => { void shutdownProductionServer(server).then(() => process.exit(0)) })
