// The gateway's own API on this workspace host (gateway/src/workspace-api.ts,
// docs/Service-architecture.md): Poise Link pairing, the paired devices and,
// for admins, who may sign in and every workspace. The gateway answers these
// itself; Poise's server never sees them, and they exist only in service mode.

export interface GatewayAccount {
  login: string
  handle: string
  isAdmin: boolean
  workspaceHost: string
  apexOrigin: string
  link: { installer: string, releases: string }
}

export interface PairedDevice {
  id: string
  /** What the device called itself when it paired: Poise Link's user agent. */
  label: string | null
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
  state: 'active' | 'revoked' | 'expired'
}

export interface AdminUser {
  handle: string
  login: string
  admin: boolean
  /** How they get in today, or who disabled them. */
  access: string
  lastLoginAt: number
  disabled: boolean
  /** null while the Docker Engine cannot be asked; `dockerError` says why. */
  workspace: { state: string, image: string | null } | null
  lastError: string | null
}

export interface AdminOverview {
  users: AdminUser[]
  allowed: Array<{ handle: string, source: 'env' | 'admin', addedBy: string | null, addedAt: number }>
  admins: string[]
  allowedOrgs: string[]
  dockerError: string | null
}

export type AdminChange =
  | 'allow' | 'allow/remove'
  | 'workspaces/start' | 'workspaces/stop' | 'workspaces/restart'
  | 'users/disable' | 'users/enable'

export class GatewayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GatewayError'
  }
}

async function call<T>(path: string, body?: Record<string, string>): Promise<T> {
  const res = await fetch(`/_poise/api/${path}`, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let data: unknown = null
  try { data = await res.json() } catch { /* reported below */ }
  const message = data !== null && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
    ? (data as { message: string }).message
    : null
  if (!res.ok) throw new GatewayError(message ?? `The gateway answered HTTP ${res.status}.`, res.status)
  if (data === null || typeof data !== 'object') throw new GatewayError('The gateway sent an answer Poise cannot read.', res.status)
  return data as T
}

export function fetchGatewayAccount(): Promise<GatewayAccount> {
  return call<GatewayAccount>('account')
}

export async function fetchDevices(): Promise<PairedDevice[]> {
  return (await call<{ devices: PairedDevice[] }>('devices')).devices
}

export function decidePairing(userCode: string, decision: 'approve' | 'deny'): Promise<{ decision: 'approve' | 'deny', message: string }> {
  return call('devices/pair', { userCode, decision })
}

export async function revokeDevice(id: string): Promise<PairedDevice[]> {
  return (await call<{ devices: PairedDevice[] }>('devices/revoke', { id })).devices
}

export function fetchAdmin(): Promise<AdminOverview> {
  return call<AdminOverview>('admin')
}

export function changeAdmin(change: AdminChange, body: { login: string } | { handle: string }): Promise<AdminOverview> {
  return call<AdminOverview>(`admin/${change}`, body)
}
