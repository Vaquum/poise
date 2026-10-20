import { beginGoogleConnection, escapeGoogleHtml as escape, googleCall, onGoogleNavigationReturn, takeGoogleConnectionResult, type GoogleSettings } from '../google'

export function googleAccountsSection(element: HTMLElement): { refresh(): Promise<void> } {
  let settings: GoogleSettings | null = null, busy = false
  element.innerHTML = '<div class="st-account-group"><h3 class="tp-group-label">Google accounts</h3><div class="google-account-list st-account-group"></div><div class="st-account-actions"><button type="button" class="st-clear google-connect" disabled>Add Google account</button></div><p class="st-help st-help-info google-account-status" role="status" tabindex="-1"></p></div>'
  const status = element.querySelector<HTMLElement>('.google-account-status')!, list = element.querySelector<HTMLElement>('.google-account-list')!, add = element.querySelector<HTMLButtonElement>('.google-connect')!
  const say = (message: string, focus = false) => { status.textContent = message; if (focus) status.focus({ preventScroll: true }) }
  const render = () => {
    const accounts = settings?.accounts ?? []
    list.innerHTML = accounts.length ? accounts.map(a => `<div class="st-account" data-google-account="${escape(a.id)}"><div class="st-account-head"><span class="st-account-name">${escape(a.email)}</span><button type="button" class="st-clear" data-google-${a.connected ? 'disconnect' : 'reconnect'}="${escape(a.id)}"${busy || !settings?.configured ? ' disabled' : ''}>${a.connected ? 'Disconnect' : 'Reconnect'}</button></div><div class="st-account-state st-account-state-${a.connected ? 'on' : 'off'}">${a.connected ? 'Connected' : a.state === 'expired' ? 'Needs sign-in' : 'Disconnected'}</div></div>`).join('') : '<div class="st-account"><div class="st-account-head"><span class="st-account-name">Google Docs</span><button type="button" class="st-clear" data-google-add' + (busy || !settings?.configured ? ' disabled' : '') + '>Connect Google</button></div><div class="st-account-state st-account-state-off">Disconnected</div></div>'
    add.hidden = !accounts.length
    add.disabled = busy || !settings?.configured || accounts.filter(a => a.connected).length >= 10
    if (settings && !settings.configured) say('Google connections are unavailable. Ask the Poise operator to enable Google.')
  }
  const refresh = async () => {
    try {
      settings = await googleCall<GoogleSettings>('/api/google/accounts'); render()
      const result = takeGoogleConnectionResult()
      if (result) say(result, true)
    } catch (error) { say((error as Error).message) }
  }
  element.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-google-disconnect], [data-google-reconnect], [data-google-add], .google-connect')
    if (!target || busy) return
    busy = true; render()
    void (async () => {
      let leaving = false
      try {
        if (target.dataset.googleDisconnect) {
          settings = await googleCall<GoogleSettings>('/api/google/disconnect', { accountId: target.dataset.googleDisconnect })
          say('Google account disconnected.', true)
        } else {
          say('Opening Google…')
          await beginGoogleConnection({ ...(target.dataset.googleReconnect ? { accountId: target.dataset.googleReconnect } : {}) })
          leaving = true
          onGoogleNavigationReturn(() => { busy = false; render(); say('Google sign-in was not completed.') })
        }
      } catch (error) { say((error as Error).message, true) }
      finally { if (!leaving) { busy = false; render() } }
    })()
  })
  return { refresh }
}
