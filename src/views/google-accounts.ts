import { escapeGoogleHtml as escape, googleCall, takeGoogleConnectionResult, type GoogleSettings } from '../google'

export function googleAccountsSection(element: HTMLElement): { refresh(): Promise<void> } {
  let settings: GoogleSettings | null = null, busy = false
  element.innerHTML = '<h3 class="tp-group-label">Google accounts</h3><div class="google-account-list"></div><button type="button" class="st-clear google-connect">Connect Google account</button><details class="google-config"><summary>Google OAuth setup</summary><p>Create a Google web OAuth client with Drive API enabled. Register this redirect URI:</p><code></code><label>Client ID<input class="st-input" name="google-client-id" autocomplete="off" /></label><label>Client secret<input class="st-input" name="google-client-secret" type="password" autocomplete="new-password" /></label><button type="button" class="st-clear google-save">Save Google setup</button></details><p class="st-help google-account-status" role="status"></p>'
  const status = element.querySelector<HTMLElement>('.google-account-status')!, list = element.querySelector<HTMLElement>('.google-account-list')!
  element.querySelector('code')!.textContent = location.origin + '/'
  const say = (message: string) => { status.textContent = message }
  const render = () => {
    list.innerHTML = settings?.accounts.map(a => `<div class="st-account"><span>${escape(a.email)} · ${a.connected ? 'Connected' : 'Disconnected'}</span>${a.connected ? `<button type="button" class="st-clear" data-google-disconnect="${escape(a.id)}">Disconnect</button>` : ''}</div>`).join('') ?? ''
    element.querySelector<HTMLButtonElement>('.google-connect')!.disabled = busy || !settings?.configured
    element.querySelector<HTMLInputElement>('[name="google-client-id"]')!.value = settings?.clientId ?? ''
    if (settings && !settings.configured) element.querySelector('details')!.open = true
  }
  const refresh = async () => {
    try {
      settings = await googleCall<GoogleSettings>('/api/google/accounts'); render()
      const result = takeGoogleConnectionResult()
      if (result) say(result)
    } catch (error) { say((error as Error).message) }
  }
  element.addEventListener('click', event => {
    const target = event.target as HTMLElement
    const disconnect = target.closest<HTMLElement>('[data-google-disconnect]')?.dataset.googleDisconnect
    if (busy || (!disconnect && !target.closest('.google-connect, .google-save'))) return
    busy = true
    void (async () => {
      try {
        if (disconnect) settings = await googleCall<GoogleSettings>('/api/google/disconnect', { accountId: disconnect })
        else if (target.closest('.google-save')) {
          settings = await googleCall<GoogleSettings>('/api/google/config', { clientId: element.querySelector<HTMLInputElement>('[name="google-client-id"]')!.value.trim(), clientSecret: element.querySelector<HTMLInputElement>('[name="google-client-secret"]')!.value, origin: location.origin })
          element.querySelector<HTMLInputElement>('[name="google-client-secret"]')!.value = ''; say('Google setup saved.')
        } else {
          const browserSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
          // Tab storage survives Google's redirect without passing a secret in its URL.
          sessionStorage.setItem('poise-google-login-secret', browserSecret)
          const result = await googleCall<{ url: string }>('/api/google/connect', { browserSecret })
          location.assign(result.url)
        }
      } catch (error) { say((error as Error).message) }
      finally { busy = false; render() }
    })()
  })
  return { refresh }
}
