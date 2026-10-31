// Settings → Connected accounts → SSH keys: the public inventory of ~/.ssh
// (GET /api/ssh-keys), and the button that opens the import terminal.

import type { SshKey } from '../../server/ssh-keys'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export async function fetchSshKeys(): Promise<SshKey[]> {
  const res = await fetch('/api/ssh-keys', { cache: 'no-store' })
  let data: { keys?: unknown, error?: unknown } | null = null
  try { data = await res.json() } catch { /* reported below */ }
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`)
  if (!Array.isArray(data?.keys)) throw new Error('the answer is unreadable')
  return data.keys as SshKey[]
}

// ssh refuses a private key anyone else can read.
function modeTooOpen(mode: string | null): boolean {
  if (!mode) return false
  const bits = Number.parseInt(mode, 8)
  return Number.isSafeInteger(bits) && (bits & 0o077) !== 0
}

function keyHtml(key: SshKey): string {
  const name = escapeHtml(key.name)
  const state = !key.hasPrivateKey
    ? { text: 'Public key only', tone: 'unknown' }
    : key.fingerprint
      ? { text: key.fingerprint, tone: 'on' }
      : { text: 'No public key', tone: 'unknown' }
  // Built from the raw name and escaped once below, beside the markup.
  const detail = !key.hasPrivateKey
    ? 'There is no private file for this public key.'
    : key.publicKeyInvalid
      ? `Its ${key.name}.pub holds no readable public key.`
      : !key.publicKey
        ? `There is no ${key.name}.pub yet; derive it in a shell with ssh-keygen -y -f ~/.ssh/${key.name}.`
        : ''
  const permissions = key.hasPrivateKey && modeTooOpen(key.privateMode)
    ? `<div class="st-help st-help-warn">Permissions ${escapeHtml(key.privateMode ?? '')} are too open: ssh refuses keys others can read. Fix in a shell: chmod 600 ~/.ssh/${name}.</div>`
    : ''
  return `
    <div class="st-account" data-ssh-key="${name}">
      <div class="st-account-head">
        <span class="st-account-name">${name}</span>
      </div>
      <div class="st-account-state st-account-state-${state.tone}">${escapeHtml(state.text)}</div>
      ${detail ? `<div class="st-help st-help-info">${escapeHtml(detail)}</div>` : ''}
      ${permissions}
    </div>`
}

/** The section: the keys, or why there are none, and the import button.
 *  `keys` is null while the first read is in flight. */
export function sshKeysHtml(keys: SshKey[] | null, error: string | null, busy: boolean): string {
  const list = keys === null
    ? '<div class="st-help st-help-info">Checking for SSH keys…</div>'
    : keys.length === 0
      ? '<div class="st-help st-help-info">No SSH keys yet. Add one to reach your servers over SSH, including from chats when you ask for work there.</div>'
      : keys.map(keyHtml).join('')
  return `
    <h3 class="tp-group-label">SSH keys</h3>
    <div class="st-help st-help-info">Keys in ~/.ssh for servers you can reach. Poise lists public keys only and never reads a private key file.</div>
    ${list}
    ${error ? `<div class="st-help st-help-error">${escapeHtml(error)}</div>` : ''}
    <div class="st-account-actions">
      <button type="button" class="st-clear" data-connect="ssh-key" data-help="Opens a terminal that saves a pasted private key to ~/.ssh with 0600 and derives its public key." aria-label="Add an SSH key"${busy ? ' disabled' : ''}>Add an SSH key</button>
    </div>`
}
