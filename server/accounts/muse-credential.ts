// Which credential Muse would use, read from its auth file's non-secret
// fields only. Muse has no status command; this is what the Accounts row
// shows instead. Only the kind leaves this module, never a key or token.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MuseCredential } from './types'

/** Where Muse keeps its auth file: `$XDG_CONFIG_HOME/muse/auth.json`, or
 *  `$HOME/.config/muse/auth.json`, the same path its launcher resolves. */
export function museAuthPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'muse', 'auth.json')
  if (env.HOME) return join(env.HOME, '.config', 'muse', 'auth.json')
  return null
}

/** The credential `providers.meta` names: the account login when its
 *  mechanism says `oauth` (a stale API key beside it is not active), else the
 *  API key when one is stored. Null when the file is missing, unreadable, or
 *  names neither. */
export function readMuseCredential(env: NodeJS.ProcessEnv = process.env): MuseCredential | null {
  const path = museAuthPath(env)
  if (!path) return null
  let document: unknown
  try {
    document = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null
  const providers = (document as Record<string, unknown>).providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return null
  const meta = (providers as Record<string, unknown>).meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const fields = meta as Record<string, unknown>
  if (fields.mechanism === 'oauth') return 'account-login'
  if (typeof fields.api_key === 'string' && fields.api_key) return 'api-key'
  return null
}
