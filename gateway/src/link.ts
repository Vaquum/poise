import type { IncomingMessage, ServerResponse } from 'node:http'
import { pagePrincipal } from './auth.js'
import type { Context, Principal } from './context.js'
import { header, HttpError, readBody, redirect, sendJson } from './http.js'
import { deviceState, normalizeUserCode, type Device } from './store.js'

export const DEVICE_CODE_TTL_SECONDS = 15 * 60
export const DEVICE_POLL_INTERVAL_SECONDS = 5
// RFC 8628 section 3.5: every slow_down adds five seconds to the polling interval.
const SLOW_DOWN_STEP_SECONDS = 5
const LABEL_MAX_LENGTH = 200
// User codes are short enough to guess, so each sign-in may try only a few.
const CODE_ATTEMPTS_PER_WINDOW = 10
const CODE_ATTEMPT_WINDOW_MS = 15 * 60_000
/** Where Settings shows Poise Link: pairing and the paired devices. */
export const LINK_SETTINGS_PATH = '/?settings=link'

/**
 * Counts a code submission; returns the seconds to wait when the sign-in has used up its attempts. A
 * workspace session counts against the apex session it came from, so the limit holds across hosts.
 */
function codeAttemptWait(ctx: Context, principal: Principal): number {
  const key = principal.session.parentHash ?? principal.session.idHash
  const now = ctx.deps.now()
  for (const [entry, times] of ctx.codeAttempts) {
    if (times.every((time) => now - time >= CODE_ATTEMPT_WINDOW_MS)) ctx.codeAttempts.delete(entry)
  }
  const recent = (ctx.codeAttempts.get(key) ?? []).filter((time) => now - time < CODE_ATTEMPT_WINDOW_MS)
  if (recent.length >= CODE_ATTEMPTS_PER_WINDOW) {
    ctx.codeAttempts.set(key, recent)
    return Math.ceil((recent[0] + CODE_ATTEMPT_WINDOW_MS - now) / 1000)
  }
  recent.push(now)
  ctx.codeAttempts.set(key, recent)
  return 0
}

/** POST /link/device/code: starts an RFC 8628 device authorization. */
export async function deviceCode(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  await readBody(req, 16 * 1024)
  const label = header(req, 'user-agent').slice(0, LABEL_MAX_LENGTH) || null
  const { deviceCode, userCode } = ctx.deps.store.createDeviceCode(label, DEVICE_CODE_TTL_SECONDS * 1000, DEVICE_POLL_INTERVAL_SECONDS)
  ctx.deps.log.info('device.code.created', {})
  sendJson(res, 200, {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${ctx.apexOrigin}/link`,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  })
}

/** POST /link/device/token: the device's poll, answered with RFC 8628 errors until the person decides. */
export async function deviceToken(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { log, store } = ctx.deps
  const text = (await readBody(req, 16 * 1024)).toString('utf8')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  const code = body !== null && typeof body === 'object' ? (body as { device_code?: unknown }).device_code : undefined
  if (typeof code !== 'string' || !code) {
    sendJson(res, 400, { error: 'invalid_request', error_description: 'Send {"device_code": "..."} as JSON.' })
    return
  }
  const poll = store.pollDeviceCode(code, SLOW_DOWN_STEP_SECONDS)
  if (!poll.issued) {
    sendJson(res, 400, { error: poll.error })
    return
  }
  const user = store.getUser(poll.handle)
  if (!user) throw new Error(`the device was approved by ${poll.handle}, who is not a known user`)
  log.info('device.paired', { login: user.login })
  sendJson(res, 200, { access_token: poll.token, endpoint: ctx.workspaceOrigin(user.handle), login: user.login })
}

/**
 * GET /link and GET /link/devices: Poise Link opens /link to have a code approved, and approving and
 * listing devices happen in Settings. The person goes on to their workspace, signing in first if need be.
 */
export function toSettings(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const principal = pagePrincipal(ctx, req, res, url)
  if (!principal) return
  redirect(res, `${ctx.workspaceOrigin(principal.user.handle)}${LINK_SETTINGS_PATH}`)
}

export type PairOutcome =
  | { ok: true; decision: 'approve' | 'deny'; message: string }
  | { ok: false; status: 429; message: string; retryAfterSeconds: number }
  | { ok: false; status: 400; message: string }

/** Approves or denies a user code for the principal's own workspace. */
export function decideCode(ctx: Context, principal: Principal, userCodeInput: string, decision: string): PairOutcome {
  if (decision !== 'approve' && decision !== 'deny') throw new HttpError(400, 'Choose approve or deny.')
  const wait = codeAttemptWait(ctx, principal)
  if (wait > 0) {
    ctx.deps.log.warn('device.code.rate_limited', { login: principal.user.login })
    const minutes = Math.ceil(wait / 60)
    return { ok: false, status: 429, message: `Too many codes were tried. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, retryAfterSeconds: wait }
  }
  const userCode = normalizeUserCode(userCodeInput)
  if (!userCode || !ctx.deps.store.decideDeviceCode(userCode, principal.user.handle, decision === 'approve')) {
    return { ok: false, status: 400, message: 'That code is not valid or has expired. Start pairing again in Poise Link.' }
  }
  ctx.deps.log.info(decision === 'approve' ? 'device.approved' : 'device.denied', { login: principal.user.login })
  const host = new URL(ctx.workspaceOrigin(principal.user.handle)).host
  return {
    ok: true,
    decision,
    message: decision === 'approve'
      ? `Approved. Poise Link on that computer is now paired with ${host}.`
      : 'Denied. That computer will not be paired.',
  }
}

export interface DeviceView extends Device {
  state: 'active' | 'revoked' | 'expired'
  /** Its Poise Link holds the event stream open right now, so snippets and alerts reach it. */
  connected: boolean
}

export function listDevices(ctx: Context, handle: string): DeviceView[] {
  const now = ctx.deps.now()
  return ctx.deps.store.listDevices(handle).map((device) => {
    const state = deviceState(device, now)
    return { ...device, state, connected: state === 'active' && ctx.linkStreams.connected(device.id) }
  })
}

export function revokeDevice(ctx: Context, principal: Principal, id: string): void {
  if (!ctx.deps.store.revokeDevice(principal.user.handle, id)) throw new HttpError(404, 'There is no such paired device.')
  ctx.deps.log.info('device.revoked', { login: principal.user.login, device: id })
}
