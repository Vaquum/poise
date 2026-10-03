import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, loadConfig, type Config } from './config.js'
import { DockerClient } from './docker.js'
import { createGateway } from './gateway.js'
import { GitHubClient } from './github.js'
import { loadOrCreateKeys } from './keys.js'
import { createLogger, errorMessage } from './log.js'
import { Orchestrator, workspaceUpstream } from './orchestrator.js'
import { startPurgeLoop, Store } from './store.js'

const PURGE_INTERVAL_MS = 10 * 60_000

const log = createLogger((line) => process.stdout.write(`${line}\n`))

let config: Config
try {
  config = loadConfig(process.env)
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}

if (config.insecureHttp) {
  log.warn('config.insecure_http', {
    domain: config.domain,
    message: 'POISE_INSECURE_HTTP=1: session cookies travel over plain http without Secure. Use this only for local and CI end-to-end runs.',
  })
}

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
const now = () => Date.now()
const store = new Store(join(config.dataDir, 'gateway.db'), now)
store.syncEnvAllowList(config.allowedUsers)
const keys = loadOrCreateKeys(config.dataDir, log)
const docker = new DockerClient(config.dockerSocket)
const orchestrator = new Orchestrator({ config, docker, store, keys, log, now, upstream: workspaceUpstream })
const gateway = createGateway({
  config,
  store,
  keys,
  github: new GitHubClient(config),
  docker,
  orchestrator,
  log,
  now,
  upstream: workspaceUpstream,
})

gateway.server.listen(config.port, () => {
  log.info('gateway.listening', { port: config.port, domain: config.domain, image: config.runtimeImage })
})
const stopUpgrades = orchestrator.startUpgradeLoop()
const stopPurging = startPurgeLoop(store, log, PURGE_INTERVAL_MS)

function shutdown(signal: string): void {
  log.info('gateway.stopping', { signal })
  stopUpgrades()
  stopPurging()
  gateway.close().then(
    () => {
      store.close()
      process.exit(0)
    },
    (error: unknown) => {
      log.error('gateway.stop.failed', { error: errorMessage(error) })
      process.exit(1)
    },
  )
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
