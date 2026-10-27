// When the sign-in in front of a workspace ends, every request the open page
// makes is turned away. The gateway answers 401, and a login proxy in front of
// it, such as a portal, redirects to its own login page: on another origin the
// request fails as if the connection had dropped, and on the same origin it
// arrives at the login page instead of the answer it asked for. Each view would
// show its own failure. Instead, Poise checks once whether the page is still
// signed in and, when it is not, dims the page under "Your sign-in has ended"
// with Sign in again, which reloads the page through the sign-in. Its look is
// the updating notice's (views/updating.css).

/** Answered by Poise itself, so only the sign-in in front of it can turn it away. */
export const SIGN_IN_PROBE_PATH = '/api/workspace'

let plainFetch: typeof fetch | null = null
let overlay: HTMLElement | null = null
let checking = false

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function sameOrigin(input: RequestInfo | URL): boolean {
  try {
    return new URL(requestUrl(input), location.href).origin === location.origin
  } catch {
    return false
  }
}

function aborted(error: unknown): boolean {
  return (error as { name?: unknown })?.name === 'AbortError'
}

/** Notices requests the sign-in turned away. Returns a function that stops noticing. */
export function watchForSignOut(): () => void {
  if (plainFetch) return () => undefined
  const plain = window.fetch.bind(window)
  plainFetch = plain
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    let response: Response
    try {
      response = await plain(...args)
    } catch (error) {
      if (!aborted(error) && sameOrigin(args[0])) void checkSignIn()
      throw error
    }
    // Poise's own API never redirects: a redirected answer came from a sign-in in front of it.
    if ((response.status === 401 || response.redirected) && sameOrigin(args[0])) void checkSignIn()
    return response
  }
  return () => {
    window.fetch = plain
    plainFetch = null
  }
}

/**
 * Asks, without following a redirect, whether the page is still signed in. A 401 or a redirect
 * is an ended sign-in. Anything else, a server that cannot be reached included, is not.
 */
export async function checkSignIn(): Promise<void> {
  if (overlay || checking) return
  checking = true
  try {
    const response = await (plainFetch ?? fetch)(SIGN_IN_PROBE_PATH, { cache: 'no-store', redirect: 'manual' })
    if (response.type === 'opaqueredirect' || response.status === 401) showSignedOut()
  } catch {
    // Not reachable at all: a lost connection, which every request reports for itself.
  } finally {
    checking = false
  }
}

export function showSignedOut(): void {
  if (overlay) return
  overlay = document.createElement('div')
  overlay.className = 'up-backdrop'
  overlay.setAttribute('role', 'alertdialog')
  overlay.setAttribute('aria-live', 'assertive')
  overlay.setAttribute('aria-label', 'Your sign-in has ended')
  overlay.innerHTML = `
    <div class="up-card">
      <div class="up-title">Your sign-in has ended</div>
      <div class="up-detail">Sign in again to go on where you were. Running agents and reviews carry on meanwhile.</div>
      <button type="button" class="st-save up-action">Sign in again</button>
    </div>`
  const button = overlay.querySelector<HTMLButtonElement>('.up-action')
  // Loading the page again goes through the sign-in, which brings the person back here.
  button?.addEventListener('click', () => location.reload())
  document.body.append(overlay)
  requestAnimationFrame(() => {
    overlay?.classList.add('up-visible')
    button?.focus()
  })
}

/** For tests: back to the state before anything was noticed. */
export function resetSignedOut(): void {
  overlay?.remove()
  overlay = null
  checking = false
}
