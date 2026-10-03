import type { IncomingMessage, ServerResponse } from 'node:http'
import { pagePrincipal, postPrincipal } from './auth.js'
import type { Context } from './context.js'
import { header, HttpError, readBody, readForm, redirect, sendHtml, sendJson } from './http.js'
import { devicesPage, linkPage } from './pages.js'
import { deviceState, normalizeUserCode } from './store.js'

export const DEVICE_CODE_TTL_SECONDS = 15 * 60
export const DEVICE_POLL_INTERVAL_SECONDS = 5
// RFC 8628 section 3.5: every slow_down adds five seconds to the polling interval.
const SLOW_DOWN_STEP_SECONDS = 5
const LABEL_MAX_LENGTH = 200
// User codes are short enough to guess, so each signed-in session may try only a few.
const CODE_ATTEMPTS_PER_WINDOW = 10
const CODE_ATTEMPT_WINDOW_MS = 15 * 60_000

/** Counts a code submission; returns the seconds to wait when the session has used up its attempts. */
function codeAttemptWait(ctx: Context, sessionHash: string): number {
  const now = ctx.deps.now()
  for (const [key, times] of ctx.codeAttempts) {
    if (times.every((time) => now - time >= CODE_ATTEMPT_WINDOW_MS)) ctx.codeAttempts.delete(key)
  }
  const recent = (ctx.codeAttempts.get(sessionHash) ?? []).filter((time) => now - time < CODE_ATTEMPT_WINDOW_MS)
  if (recent.length >= CODE_ATTEMPTS_PER_WINDOW) {
    ctx.codeAttempts.set(sessionHash, recent)
    return Math.ceil((recent[0] + CODE_ATTEMPT_WINDOW_MS - now) / 1000)
  }
  recent.push(now)
  ctx.codeAttempts.set(sessionHash, recent)
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

export function approvalPage(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const principal = pagePrincipal(ctx, req, res, url)
  if (!principal) return
  sendHtml(res, 200, linkPage(principal.session.csrf), ctx.pageHeaders)
}

export async function decide(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const principal = postPrincipal(ctx, req)
  const form = await readForm(req)
  ctx.verifyForm(req, form, principal.session, ctx.apexOrigin)
  const decision = form.get('decision')
  if (decision !== 'approve' && decision !== 'deny') throw new HttpError(400, 'Choose Approve or Deny.')
  const csrf = principal.session.csrf
  const wait = codeAttemptWait(ctx, principal.session.idHash)
  if (wait > 0) {
    ctx.deps.log.warn('device.code.rate_limited', { login: principal.user.login })
    const minutes = Math.ceil(wait / 60)
    sendHtml(res, 429, linkPage(csrf, {
      text: `Too many codes were tried. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      error: true,
    }), { ...ctx.pageHeaders, 'retry-after': String(wait) })
    return
  }
  const userCode = normalizeUserCode(form.get('user_code') ?? '')
  if (!userCode || !ctx.deps.store.decideDeviceCode(userCode, principal.user.handle, decision === 'approve')) {
    sendHtml(res, 400, linkPage(csrf, {
      text: 'That code is not valid or has expired. Start pairing again in Poise Link.',
      error: true,
    }), ctx.pageHeaders)
    return
  }
  ctx.deps.log.info(decision === 'approve' ? 'device.approved' : 'device.denied', { login: principal.user.login })
  const host = new URL(ctx.workspaceOrigin(principal.user.handle)).host
  sendHtml(res, 200, linkPage(csrf, {
    text: decision === 'approve'
      ? `Approved. Poise Link on that computer is now paired with ${host}.`
      : 'Denied. That computer will not be paired.',
    error: false,
  }), ctx.pageHeaders)
}

export function devices(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const principal = pagePrincipal(ctx, req, res, url)
  if (!principal) return
  const devices = ctx.deps.store.listDevices(principal.user.handle)
  sendHtml(res, 200, devicesPage(devices.map((device) => ({ ...device, state: deviceState(device, ctx.deps.now()) })), principal.session.csrf), ctx.pageHeaders)
}

export async function revoke(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const principal = postPrincipal(ctx, req)
  const form = await readForm(req)
  ctx.verifyForm(req, form, principal.session, ctx.apexOrigin)
  const id = form.get('id') ?? ''
  if (!ctx.deps.store.revokeDevice(principal.user.handle, id)) throw new HttpError(404, 'There is no such paired device.')
  ctx.deps.log.info('device.revoked', { login: principal.user.login, device: id })
  redirect(res, '/link/devices', 303)
}
