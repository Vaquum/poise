// The page's states on the watchers this page reuses (#556, Design): updating
// and sign-in ended dim the page under one card, and Claude's subscription and
// a new build sit at the foot of every place, where the page makes room.
// states.css draws them in this page's tokens.
import { $ } from './dom'

const FOOT = '#claude-auth-banner, .self-update-banner'

export function installStates(go: (href: string) => void): void {
  const foot = Object.assign(document.createElement('div'), { className: 'foot' })
  document.body.append(foot)
  const root = document.documentElement
  const measure = () => {
    const height = foot.getBoundingClientRect().height
    if (height) root.style.setProperty('--foot-h', `${height}px`); else root.style.removeProperty('--foot-h')
  }
  new ResizeObserver(measure).observe(foot)
  // The watchers append their strips and cards to the body; strips move into the
  // foot, and a card makes the place beneath it inert while it shows.
  const adopt = () => {
    document.querySelectorAll<HTMLElement>(FOOT).forEach((strip) => { if (strip.parentElement !== foot) foot.append(strip) })
    const frame = $('.frame')
    if (document.querySelector('.up-backdrop')) frame?.setAttribute('inert', '')
    else frame?.removeAttribute('inert')
    measure()
  }
  new MutationObserver(adopt).observe(document.body, { childList: true })
  adopt()
  // The subscription strip's Reconnect, where the browser cannot sign in, opens
  // Settings → Accounts with Claude's terminal.
  addEventListener('poise:connect-account', () => go('?view=settings&settings=accounts'))
}
