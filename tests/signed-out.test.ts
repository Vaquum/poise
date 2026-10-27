import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// What the page does once the sign-in in front of its workspace has ended
// (src/signed-out.ts): a request the gateway answers with 401, or one a login
// proxy redirects away, makes it check once, without following redirects, and
// dim itself under "Your sign-in has ended" when the check is turned away too.

class FakeButton {
  listeners: Record<string, () => void> = {}
  focused = false
  addEventListener(type: string, listener: () => void): void { this.listeners[type] = listener }
  focus(): void { this.focused = true }
}

class FakeElement {
  className = ''
  innerHTML = ''
  attributes: Record<string, string> = {}
  classes = new Set<string>()
  classList = { add: (name: string) => { this.classes.add(name) } }
  button = new FakeButton()
  setAttribute(name: string, value: string): void { this.attributes[name] = value }
  querySelector(selector: string): FakeButton | null { return selector === '.up-action' ? this.button : null }
  remove(): void { appended.splice(appended.indexOf(this), 1) }
}

let appended: FakeElement[] = []
const reload = vi.fn()
const fetchMock = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>()
const unauthorized = () => new Response('{"error":"unauthorized"}', { status: 401 })
const ok = () => new Response('{"mode":"service"}', { status: 200 })
// What fetch gives for a redirect it was told not to follow; no Response constructor makes one.
const redirected = () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() }) as unknown as Response
const dropped = () => new TypeError('Failed to fetch')
// A login page on the same origin, reached by following the proxy's redirect.
const loginPage = () => ({ type: 'basic', status: 200, ok: true, redirected: true, headers: new Headers({ 'content-type': 'text/html' }) }) as unknown as Response
// The checks run after the answer is handed back: let them finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function load() {
  vi.resetModules()
  return import('../src/signed-out')
}

beforeEach(() => {
  appended = []
  reload.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('window', { fetch: fetchMock })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('document', { createElement: () => new FakeElement(), body: { append: (element: FakeElement) => appended.push(element) } })
  vi.stubGlobal('location', { href: 'https://alice.poise.test/', origin: 'https://alice.poise.test', reload })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the ended sign-in notice', () => {
  it('says the sign-in has ended when the gateway turns requests away, and signs in again by reloading', async () => {
    const { SIGN_IN_PROBE_PATH, watchForSignOut } = await load()
    watchForSignOut()
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(unauthorized())
    // The view still gets its own answer.
    expect((await window.fetch('/api/accounts')).status).toBe(401)
    await settle()
    expect(fetchMock).toHaveBeenLastCalledWith(SIGN_IN_PROBE_PATH, { cache: 'no-store', redirect: 'manual' })
    expect(appended).toHaveLength(1)
    expect(appended[0].innerHTML).toContain('Your sign-in has ended')
    expect(appended[0].innerHTML).toContain('Sign in again')
    expect(appended[0].attributes.role).toBe('alertdialog')
    expect(appended[0].classes.has('up-visible')).toBe(true)
    expect(appended[0].button.focused).toBe(true)

    appended[0].button.listeners.click()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('says so when a login proxy redirects the page\'s requests to its own login page', async () => {
    const { watchForSignOut } = await load()
    watchForSignOut()
    // Followed to another origin, the redirect fails like a lost connection; the check sees it.
    fetchMock.mockRejectedValueOnce(dropped()).mockResolvedValueOnce(redirected())
    await expect(window.fetch('/api/models')).rejects.toThrow('Failed to fetch')
    await settle()
    expect(appended).toHaveLength(1)
    expect(appended[0].innerHTML).toContain('Your sign-in has ended')
  })

  it('says so when a login proxy on the same origin answers with its login page', async () => {
    const { watchForSignOut } = await load()
    watchForSignOut()
    fetchMock.mockResolvedValueOnce(loginPage()).mockResolvedValueOnce(redirected())
    expect((await window.fetch('/api/accounts')).redirected).toBe(true)
    await settle()
    expect(appended).toHaveLength(1)
  })

  it('shows nothing when Poise cannot be reached, or when only one request was turned away', async () => {
    const { watchForSignOut } = await load()
    watchForSignOut()
    fetchMock.mockRejectedValueOnce(dropped()).mockRejectedValueOnce(dropped())
    await expect(window.fetch('/api/models')).rejects.toThrow('Failed to fetch')
    await settle()
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok())
    await window.fetch('/api/accounts')
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(appended).toHaveLength(0)
  })

  it('leaves cancelled requests and requests to other origins alone', async () => {
    const { watchForSignOut } = await load()
    watchForSignOut()
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
    await expect(window.fetch('/api/claude-auth')).rejects.toThrow('aborted')
    fetchMock.mockRejectedValueOnce(dropped()).mockResolvedValueOnce(unauthorized())
    await expect(window.fetch('https://api.github.com/user')).rejects.toThrow('Failed to fetch')
    await window.fetch('https://api.github.com/user')
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(appended).toHaveLength(0)
  })

  it('shows one notice however many requests are turned away', async () => {
    const { watchForSignOut } = await load()
    watchForSignOut()
    fetchMock.mockResolvedValue(unauthorized())
    await Promise.all([window.fetch('/api/accounts'), window.fetch('/api/models'), window.fetch('/api/current')])
    await settle()
    await window.fetch('/api/current')
    await settle()
    expect(appended).toHaveLength(1)
  })
})
