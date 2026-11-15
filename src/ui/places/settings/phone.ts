// Settings → Accounts → Sign in on your phone (#1373): a QR code for the phone's camera, the phone's
// request to approve or deny here, and the phones signed in this way, each with Sign out. The gateway
// signs the phone in (gateway/src/phone.ts, docs/Service-architecture.md); a code works once.
import { esc } from '../../dom'
import { qrCode, qrSvg } from '../../qr'
import { shortTime } from '../../../clock'
import { effectiveTimezone } from '../../../config'
import {
  decidePhone, fetchPhones, signOutPhone, startPhoneCode,
  type GatewayAccount, type PhoneCode, type SignedInPhone,
} from '../../../gateway-client'
import { stateHTML } from './rows'

export interface PhoneSection {
  readonly element: HTMLElement
  /** Reads the codes and phones again. */
  refresh(): Promise<void>
  dispose(): void
}

// While a code is shown or a phone is being decided on, its state is read this often.
const POLL_MS = 1_500
// A shown code is replaced this long before it expires, so the one on screen always works.
const RENEW_BEFORE_MS = 20_000
// After five codes, about ten minutes, the code stops renewing: a sign-in code is not left up unwatched.
const MAX_CODES = 5
const ARM_MS = 3_000

type Show =
  | { kind: 'idle' }
  | { kind: 'starting' }
  /** `until` is this browser's clock: when the code was received, plus its lifetime. */
  | { kind: 'code', code: PhoneCode, svg: string, until: number, count: number }
  | { kind: 'expired' }
  | { kind: 'failed', message: string }

function moment(ms: number): string {
  return shortTime(ms, effectiveTimezone(), Date.now())
}

export function phoneSection(account: GatewayAccount): PhoneSection {
  const element = document.createElement('div')
  element.className = 'ph'
  element.innerHTML = '<div class="ph-pair" aria-live="polite"></div><div class="ph-phones" aria-live="polite"></div>'
  const pairEl = element.querySelector<HTMLElement>('.ph-pair')!
  const phonesEl = element.querySelector<HTMLElement>('.ph-phones')!
  let show: Show = { kind: 'idle' }
  let codes: PhoneCode[] = []
  let phones: SignedInPhone[] | null = null
  let readError: string | null = null
  // The codes decided here, so this screen can say how each ended.
  const decided = new Map<string, 'approve' | 'deny'>()
  let deciding: string | null = null
  let decideError: { id: string, message: string } | null = null
  let signOutError: string | null = null
  const armed = new Map<string, number>()
  const signingOut = new Set<string>()
  let generation = 0
  let disposed = false

  const pending = (): PhoneCode | undefined => codes.find((code) => code.state === 'scanned')
  const ofMine = (state: PhoneCode['state']): PhoneCode | undefined =>
    codes.find((code) => decided.has(code.id) && code.state === state)
  /** A code on screen, or a phone being decided on: worth reading often. */
  const live = (): boolean => show.kind === 'code' || show.kind === 'starting' || !!pending() || !!ofMine('approved')

  const KINDS = { primary: 'btn btn-primary', line: 'btn btn-line', ghost: 'btn-ghost' }
  const button = (act: string, label: string, ref: string, kind: keyof typeof KINDS = 'ghost', busy = false, id = ''): string =>
    `<button type="button" class="${KINDS[kind]}" data-act="${act}" data-ref="${ref}"${id ? ` data-id="${esc(id)}"` : ''}${busy ? ' aria-disabled="true"' : ''}>${label}</button>`

  function requestHtml(code: PhoneCode): string {
    const busy = deciding === code.id
    const error = decideError?.id === code.id ? `<p class="fsub is-err">${esc(decideError.message)}</p>` : ''
    return `<div class="ph-request" data-ref="set.phone.request">
      <div class="ph-line"><span class="ph-lead"><b>${esc(code.device ?? 'A phone')}</b> wants to sign in as <b>${esc(account.login)}</b>.</span></div>
      <p class="fsub">It opened the code ${esc(moment(code.scannedAt ?? code.createdAt))}. Approve only a phone you are holding.</p>
      <div class="fbtns">
        ${button('approve', busy ? 'Approving…' : 'Approve', 'set.phone.approve', 'primary', busy, code.id)}
        ${button('deny', 'Deny', 'set.phone.deny', 'line', busy, code.id)}
      </div>
      ${error}
    </div>`
  }

  function pairHtml(): string {
    const waiting = pending()
    if (waiting) return requestHtml(waiting)
    const finishing = ofMine('approved')
    if (finishing) {
      return `<div class="ph-line">${stateHTML('running', 'Signing in…')}<span class="ph-lead"><b>${esc(finishing.device ?? 'The phone')}</b> is finishing its sign-in.</span></div>`
    }
    if (show.kind === 'idle') {
      const done = ofMine('signed_in')
      if (done) {
        return `<div class="ph-line">${stateHTML('done')}<span class="ph-lead"><b>${esc(done.device ?? 'The phone')}</b> is signed in as <b>${esc(account.login)}</b>.</span></div>
          <div class="fbtns">${button('show', 'Sign in another phone', 'set.phone.show')}</div>`
      }
      const denied = ofMine('denied')
      if (denied) {
        return `<p class="fsub">Denied: <b>${esc(denied.device ?? 'that phone')}</b> was not signed in.</p>
          <div class="fbtns">${button('show', 'Show a new code', 'set.phone.show')}</div>`
      }
      const late = codes.find((code) => decided.get(code.id) === 'approve' && code.state === 'expired')
      if (late) {
        return `<p class="fsub is-err">${esc(late.device ?? 'The phone')} did not finish signing in in time.</p>
          <div class="fbtns">${button('show', 'Show a new code', 'set.phone.show')}</div>`
      }
      return `<div class="fbtns">${button('show', 'Show the code', 'set.phone.show')}</div>`
    }
    if (show.kind === 'starting') return '<p class="fsub">Making a code…</p>'
    if (show.kind === 'expired') {
      return `<p class="fsub">The code expired.</p><div class="fbtns">${button('show', 'Show a new code', 'set.phone.show')}</div>`
    }
    if (show.kind === 'failed') {
      return `<p class="fsub is-err">Could not show a code: ${esc(show.message)}</p><div class="fbtns">${button('show', 'Try again', 'set.phone.show')}</div>`
    }
    return `<div class="ph-code">
      <div class="ph-qr" data-ref="set.phone.code">${show.svg}</div>
      <div class="ph-steps">
        <p class="ph-lead">Scan this with your phone’s camera.</p>
        <p class="fsub">Poise opens on the phone and asks you to approve it here. Then the phone is signed in as <b>${esc(account.login)}</b>.</p>
        <p class="fsub">The code changes every two minutes while it is shown.</p>
        <div class="fbtns">${button('hide', 'Hide the code', 'set.phone.hide')}</div>
      </div>
    </div>`
  }

  function phonesHtml(): string {
    const head = '<p class="ph-head" data-ref="set.phones">Phones signed in with a code</p>'
    const stale = readError !== null ? `<p class="fsub is-err">Could not read the phones: ${esc(readError)}</p>` : ''
    const failed = signOutError !== null ? `<p class="fsub is-err">${esc(signOutError)}</p>` : ''
    if (phones === null) return head + (stale || '<p class="fnone">Reading the phones…</p>')
    if (phones.length === 0) return `${head}${stale}<p class="fnone">No phone is signed in with a code.</p>`
    const now = Date.now()
    return `${head}${stale}<div class="flist">${phones.map((phone) => {
      const isArmed = (armed.get(phone.id) ?? 0) > now
      const busy = signingOut.has(phone.id)
      return `<div class="frow" data-item data-ref="set.phone.row" data-now="${esc(`${phone.device}, signed in ${moment(phone.createdAt)}`)}">
        <div class="fmain"><span class="name">${esc(phone.device)}</span><span class="fsub">Signed in ${esc(moment(phone.createdAt))}</span></div>
        <div class="facts"><button type="button" class="btn-ghost${isArmed ? ' is-armed' : ''}" data-act="sign-out" data-ref="set.phone.sign-out" data-id="${esc(phone.id)}"${busy ? ' aria-disabled="true"' : ''} aria-label="${isArmed ? `Confirm signing ${esc(phone.device)} out` : `Sign ${esc(phone.device)} out`}">${busy ? 'Signing out…' : isArmed ? 'Sure?' : 'Sign out'}</button></div>
      </div>`
    }).join('')}</div>${failed}`
  }

  // Drawn again only when something changed, so a reading every few seconds neither moves focus nor
  // makes a screen reader announce the same words again.
  const paint = (el: HTMLElement, html: string) => {
    if (el.dataset.drawn !== html) {
      el.innerHTML = html
      el.dataset.drawn = html
    }
  }
  const render = () => {
    if (disposed) return
    paint(pairEl, pairHtml())
    paint(phonesEl, phonesHtml())
  }

  // One read at a time, however slow, so a slow gateway still delivers every reading. A decision or a
  // sign-out made meanwhile (`generation`) discards the read it overlapped and asks for another.
  let reading = false
  let readAgain = false
  const refresh = async (after = false): Promise<void> => {
    if (reading) {
      if (after) readAgain = true
      return
    }
    reading = true
    try {
      do {
        readAgain = false
        const current = generation
        try {
          const next = await fetchPhones()
          if (disposed) return
          if (current !== generation) {
            readAgain = true
            continue
          }
          codes = next.codes
          phones = next.phones
          readError = null
        } catch (error) {
          if (disposed) return
          if (current === generation) readError = (error as Error).message
        }
        render()
      } while (readAgain && !disposed)
    } finally {
      reading = false
    }
  }

  // Each choice the person makes here (show, hide, decide) starts a new round; a code minted for an older
  // round, such as a renewal that lands after Hide, is not shown.
  let round = 0
  let renewing = false
  async function startCode(count: number): Promise<void> {
    const mine = round
    if (count === 1) show = { kind: 'starting' }
    renewing = true
    render()
    try {
      const { code, url } = await startPhoneCode()
      if (disposed || mine !== round) return
      show = { kind: 'code', code, svg: qrSvg(qrCode(url), 'QR code that signs your phone in to Poise'), until: Date.now() + (code.expiresAt - code.createdAt), count }
    } catch (error) {
      if (disposed || mine !== round) return
      // A code on screen keeps working until it expires; only a first code that failed says so at once.
      if (show.kind === 'code') show = { ...show, count: MAX_CODES }
      else show = { kind: 'failed', message: (error as Error).message }
    } finally {
      renewing = false
    }
    render()
  }

  async function decide(id: string, decision: 'approve' | 'deny'): Promise<void> {
    const code = codes.find((candidate) => candidate.id === id)
    if (!code || deciding) return
    deciding = id
    decideError = null
    render()
    try {
      const next = await decidePhone(code, decision)
      decided.set(id, decision)
      codes = codes.map((candidate) => (candidate.id === id ? next : candidate))
      // The decision ends this round; a new code is shown only when asked for.
      show = { kind: 'idle' }
      round++
      generation++
    } catch (error) {
      decideError = { id, message: (error as Error).message }
    } finally {
      deciding = null
    }
    render()
    void refresh(true)
  }

  async function signOut(id: string): Promise<void> {
    const phone = phones?.find((candidate) => candidate.id === id)
    if (!phone) return
    if ((armed.get(id) ?? 0) <= Date.now()) {
      armed.set(id, Date.now() + ARM_MS)
      render()
      window.setTimeout(() => { if (!disposed) render() }, ARM_MS + 50)
      return
    }
    armed.delete(id)
    signingOut.add(id)
    signOutError = null
    render()
    try {
      phones = await signOutPhone(phone)
      generation++
    } catch (error) {
      signOutError = `Could not sign ${phone.device} out: ${(error as Error).message}`
    } finally {
      signingOut.delete(id)
    }
    render()
  }

  element.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
    if (!target || target.getAttribute('aria-disabled') === 'true') return
    const id = target.dataset.id ?? ''
    switch (target.dataset.act) {
      case 'show':
        decided.clear()
        round++
        void startCode(1)
        break
      case 'hide':
        round++
        show = { kind: 'idle' }
        render()
        break
      case 'approve':
        void decide(id, 'approve')
        break
      case 'deny':
        void decide(id, 'deny')
        break
      case 'sign-out':
        void signOut(id)
        break
    }
  })

  // One clock for everything that moves: reading while something is live, replacing a code before it
  // expires, and marking it expired when it could not be replaced (the tab was hidden, or enough were shown).
  const timer = window.setInterval(() => {
    if (disposed) return
    const now = Date.now()
    if (show.kind === 'code') {
      if (now >= show.until) {
        show = { kind: 'expired' }
        render()
      } else if (now >= show.until - RENEW_BEFORE_MS && show.count < MAX_CODES && !renewing && !pending() && document.visibilityState === 'visible') {
        void startCode(show.count + 1)
      }
    }
    if (live() && document.visibilityState === 'visible') void refresh()
  }, POLL_MS)

  render()
  void refresh()
  return {
    element,
    refresh,
    dispose: () => {
      disposed = true
      window.clearInterval(timer)
      element.remove()
    },
  }
}
