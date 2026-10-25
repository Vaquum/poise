import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readSavedSettings, writeSavedSetting } from './saved-settings.mjs'

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/

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

const NO_SAVED_ACCOUNT = 'No GitHub account is saved. Set Your GitHub account in Settings → General, then install again.'

// The GitHub user the legacy sync jobs authenticate as: your account saved in
// Settings, never gh's active account. POISE_GITHUB_USER only migrates a
// never-saved value into Settings explicitly; a cleared value stays cleared
// and fails naming the setting.
export async function resolveLegacySyncUser({ home, run, environment = process.env }) {
  const first = await readSavedSettings({ home, run, environment })
  if (!first.present) throw new Error(NO_SAVED_ACCOUNT)
  if ('me' in first.settings) return savedSyncUser(first.settings.me)
  const migrated = environment.POISE_GITHUB_USER?.trim() || ''
  if (!migrated) throw new Error(NO_SAVED_ACCOUNT)
  if (!GITHUB_LOGIN.test(migrated)) throw new Error('POISE_GITHUB_USER must be a GitHub username')
  await writeSavedSetting({ run, database: first.database, key: 'me', value: migrated })
  // A Settings save that landed after the read wins over the migration: the
  // write only inserts when the key is still absent, so what is read now is
  // what the jobs authenticate as.
  const current = await readSavedSettings({ home, run, environment })
  return savedSyncUser(current.settings.me, migrated)
}

function savedSyncUser(value, migrated = undefined) {
  const me = value?.trim() || ''
  if (!me) throw new Error(NO_SAVED_ACCOUNT)
  if (!GITHUB_LOGIN.test(me)) throw new Error('The GitHub account in Settings → General is not a GitHub username')
  return { user: me, migrated: migrated !== undefined && me === migrated }
}
