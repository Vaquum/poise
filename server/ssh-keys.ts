// SSH keys (Settings → Accounts → SSH keys): the public inventory of ~/.ssh.
// The server stats private key files and reads public .pub files only; it
// never opens a private key file, so private material cannot cross this API,
// its errors, logs or diagnostics.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One SSH identity in ~/.ssh, as GET /api/ssh-keys reports it. */
export interface SshKey {
  /** The private key's file name, or the public key's base name when the
   *  private file is absent. */
  name: string
  hasPrivateKey: boolean
  /** The private file's permission bits (e.g. '0600'), null when absent. */
  privateMode: string | null
  privateBytes: number | null
  /** The first line of <name>.pub, null when there is none or it is unreadable. */
  publicKey: string | null
  /** A <name>.pub exists but holds no readable public key line. */
  publicKeyInvalid: boolean
  /** The OpenSSH SHA256 fingerprint of the public key, null when there is none. */
  fingerprint: string | null
}

// Files in ~/.ssh that are never identities: configuration, host records and
// server-side authorization. The import terminal refuses these names, so
// skipping them hides no key.
const RESERVED = new Set(['config', 'known_hosts', 'known_hosts.old', 'authorized_keys', 'environment', 'rc'])

/** ~/.ssh under `home` (the process user's home by default). */
export function sshDir(home: string = homedir()): string {
  return join(home, '.ssh')
}

// `ssh-ed25519 AAAA…` with an optional trailing comment.
const PUBLIC_KEY_LINE = /^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+) ([A-Za-z0-9+/]+={0,3})( .*)?$/

/** An OpenSSH public blob starts with its own key type on the wire. */
function blobHasType(blob: Buffer, type: string): boolean {
  if (blob.length < 4) return false
  const length = blob.readUInt32BE(0)
  return blob.length >= 4 + length && blob.subarray(4, 4 + length).toString('ascii') === type
}

/** The OpenSSH SHA256 fingerprint of a public key line (`SHA256:…`), or null
 *  when the line holds no public key. Pure computation, no subprocess. */
export function sshFingerprint(publicKey: string): string | null {
  const line = publicKey.trim()
  // Real public keys are one line of a few hundred characters; anything
  // longer is not one.
  if (!line || line.length > 4096) return null
  const match = PUBLIC_KEY_LINE.exec(line)
  if (!match) return null
  const [, type, encoded] = match
  let blob: Buffer
  try {
    blob = Buffer.from(encoded, 'base64')
  } catch {
    return null
  }
  // Base64 decoding skips invalid characters; the round trip proves the text
  // was the blob, and the wire header proves the blob is this key type.
  if (!blob.length || blob.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return null
  if (!blobHasType(blob, type)) return null
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** The public key line of a .pub file, or null when it holds none. */
function readPublicKey(path: string): string | null {
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    return sshFingerprint(trimmed) ? trimmed : null
  }
  return null
}

/** Every SSH identity in `dir`: key pairs by their private file name, public
 *  keys without a private file marked as such. A missing directory holds no
 *  keys; anything else unreadable fails the read. */
export function listSshKeys(dir: string = sshDir()): SshKey[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`Could not read ${dir}: ${(error as Error).message}`)
  }
  const keys = new Map<string, SshKey>()
  const take = (name: string): SshKey => {
    let key = keys.get(name)
    if (!key) {
      key = { name, hasPrivateKey: false, privateMode: null, privateBytes: null, publicKey: null, publicKeyInvalid: false, fingerprint: null }
      keys.set(name, key)
    }
    return key
  }
  for (const entry of entries) {
    // Only regular files are considered: symlinks, sockets and directories
    // are never identities. Private candidates are stated, never opened.
    if (!entry.isFile() || entry.name.startsWith('.') || RESERVED.has(entry.name)) continue
    if (entry.name.endsWith('.pub')) {
      const base = entry.name.slice(0, -'.pub'.length)
      if (!base || base.startsWith('.') || RESERVED.has(base)) continue
      const key = take(base)
      key.publicKey = readPublicKey(join(dir, entry.name))
      key.publicKeyInvalid = key.publicKey === null
      continue
    }
    const key = take(entry.name)
    const stat = statSync(join(dir, entry.name))
    key.hasPrivateKey = true
    key.privateMode = (stat.mode & 0o777).toString(8).padStart(4, '0')
    key.privateBytes = stat.size
  }
  for (const key of keys.values()) {
    if (key.publicKey) key.fingerprint = sshFingerprint(key.publicKey)
  }
  return [...keys.values()].sort((a, b) => a.name.localeCompare(b.name))
}
