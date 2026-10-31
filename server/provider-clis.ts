import { diagnostic } from './logging'
import { trackReleaseBackground } from './release-background'
import { ensureProviderCli, type Provider, type CliUpdate } from '../scripts/provider-cli-updates.mjs'
import type { Catalog } from './models'

/** Cancelling one startup must not cancel an update shared by another chat. */
export async function prepareProviderCli(provider: Provider, signal?: AbortSignal): Promise<CliUpdate> {
  signal?.throwIfAborted()
  const finished = trackReleaseBackground()
  const task = ensureProviderCli(provider).then((result) => {
    if (result.status === 'unavailable') diagnostic({ level: 'warning', component: provider, operation: 'provider.cli_update', phase: 'launcher_verification',
      message: result.error ?? 'Provider CLI update evidence is unavailable', stderr: result.diagnostic?.stderr ?? null, truncated: result.diagnostic?.truncated,
      exitCode: result.diagnostic?.exitCode ?? null, signal: result.diagnostic?.signal ?? null, errno: result.diagnostic?.errno ?? null,
      timeoutMs: result.diagnostic?.timeoutMs ?? null, context: { configuredExecutable: result.diagnostic?.configuredExecutable ?? result.configuredExecutable ?? result.path ?? null,
        resolvedExecutable: result.resolvedPath ?? null, launchExecutable: result.launchPath ?? null, elapsedMs: result.diagnostic?.elapsedMs ?? null } })
    return result
  }).finally(finished)
  if (!signal) return task
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new Error('CLI startup cancelled'))
    signal.addEventListener('abort', aborted, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    if (signal.aborted) aborted()
  })
}

/** Existing Caller-backed surfaces use the same maintenance as native Chat. */
export async function prepareModelClis(catalog: Catalog, identities: string[]): Promise<NodeJS.ProcessEnv> {
  const providers = new Set(identities.map(identity => catalog.models.find(row => row.identity === identity)?.provider).filter(Boolean) as Provider[])
  const env: NodeJS.ProcessEnv = {}
  await Promise.all([...providers].map(async provider => {
    const result = await prepareProviderCli(provider)
    if (result.status === 'unavailable') console.warn(`[models] ${provider}: latest CLI could not be verified — ${result.error}`)
    if (provider === 'codex' && !process.env.CODEX_CLI) {
      if (!result.launchPath) throw new Error(`Codex CLI has no verified launcher: ${result.error || 'version check failed'}`)
      env.CODEX_CLI = result.launchPath
    }
  }))
  return env
}
