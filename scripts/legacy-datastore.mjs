import { stat } from 'node:fs/promises'
import { join } from 'node:path'

// Existing installations keep their external Caller database and launchd
// jobs. A clean install has no legacy source: Settings creates managed org
// databases later, and the Poise runtime owns their synchronization.
export async function resolveLegacyDatastore({ home, configuredPath }, inspect = stat) {
  const explicit = configuredPath !== undefined
  if (explicit && (typeof configuredPath !== 'string' || !configuredPath.trim())) {
    throw new Error('POISE_DATASTORE_DB must name an existing github-datastore database, or be unset for organization setup in Settings')
  }
  const path = explicit ? configuredPath : join(home, 'dev', 'caller', 'github_datastore', 'github_datastore.sqlite')
  let metadata
  try {
    metadata = await inspect(path)
  } catch (error) {
    if (!explicit && error?.code === 'ENOENT') return null
    const reason = error?.code === 'ENOENT' ? 'does not exist' : 'could not be inspected'
    throw new Error(`POISE_DATASTORE_DB ${reason}: ${path}`, { cause: error })
  }
  if (!metadata.isFile()) {
    throw new Error(`POISE_DATASTORE_DB must point to an initialized github-datastore database: ${path}`)
  }
  return path
}

export function legacyDatastoreServices(databasePath, launchAgents) {
  if (!databasePath) return []
  return ['sync', 'reconcile', 'health'].map((kind) => {
    const label = `com.vaquum.github-datastore.${kind}`
    return { kind, label, path: join(launchAgents, `${label}.plist`) }
  })
}
