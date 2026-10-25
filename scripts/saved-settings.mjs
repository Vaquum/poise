// Poise's saved Settings, read from its database by the processes the server
// never starts: the stop-gate installer, the production installer and the
// runtime reconciler. Every consumer resolves the same database the server
// opens (server/db.ts): POISE_DB when set, otherwise ~/.poise/cache.db.
import { access } from 'node:fs/promises'
import { join } from 'node:path'

export function settingsDatabasePath(home, environment = process.env) {
  const configured = environment.POISE_DB?.trim()
  return configured ? configured : join(home, '.poise', 'cache.db')
}

async function databasePresent(database) {
  // The in-memory database of tests has no file to read.
  if (database === ':memory:') return false
  try {
    await access(database)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

// The saved org, human account and agent account. `present` is false before
// Poise's first start, when nothing is saved yet; `settings` then is empty.
// A key a save cleared reads back as ''; a key never saved is absent, so a
// migration can tell the two apart and never restore a cleared value.
export async function readSavedSettings({ home, run, environment = process.env }) {
  const database = settingsDatabasePath(home, environment)
  if (!await databasePresent(database)) return { database, present: false, settings: {} }
  const result = await run('/usr/bin/sqlite3', [
    '-json',
    database,
    "SELECT key, value FROM meta WHERE key IN ('org', 'me', 'agentAccount');",
  ], { capture: true })
  const settings = Object.fromEntries(JSON.parse(result.stdout.trim() || '[]').map((row) => [row.key, row.value]))
  return { database, present: true, settings }
}

// A migration's explicit write to Settings. Callers validate the value as a
// GitHub login first; the quote escape keeps the statement honest anyway.
export async function writeSavedSetting({ run, database, key, value }) {
  if (!/^[A-Za-z]+$/.test(key)) throw new Error(`Cannot save unknown settings key: ${key}`)
  const quoted = String(value).replaceAll("'", "''")
  await run('/usr/bin/sqlite3', [
    database,
    `INSERT INTO meta(key, value) VALUES ('${key}', '${quoted}') ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
  ], { capture: true })
}
