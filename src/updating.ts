// While a workspace restarts onto a new release, the gateway answers for it
// with `x-poise-updating: 1` (gateway/src/workspace.ts). Poise then dims the
// page under "Updating to the latest version" and, once it answers again,
// reloads into the new version. A dropped Chat connection asks at once, so
// the notice shows within moments of the restart. A page that made no request
// while the restart went through misses all of that; when its next lazy chunk
// then fails, Vite's `vite:preloadError` carries the failure here, and the
// page reloads into the new version the same way. Its styles are
// views/updating.css, which main.ts loads.

export const UPDATING_HEADER = 'x-poise-updating'
export const UPDATING_PROBE_PATH = '/api/workspace'
/** How often the page asks whether Poise is back, while it updates. */
export const UPDATING_POLL_MS = 1_500
/** The entry a stale page already reloaded for, so a chunk that stays missing cannot loop it. */
const STALE_RELOAD_KEY = 'poise-stale-chunk-reload'

let originalFetch: typeof fetch | null = null
let overlay: HTMLElement | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let chunkFailureListener: (() => void) | null = null

function isUpdating(response: Response): boolean {
  return response.headers.get(UPDATING_HEADER) === '1'
}

/**
 * Notices every answer the gateway marks as updating, and every lazy chunk
 * that fails because the page is older than its release. Returns a function
 * that stops noticing.
 */
export function watchForUpdates(): () => void {
  if (originalFetch) return () => undefined
  const plain = window.fetch.bind(window)
  originalFetch = plain
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await plain(...args)
    if (isUpdating(response)) showUpdating()
    return response
  }
  chunkFailureListener = () => { void reloadIfStale() }
  window.addEventListener('vite:preloadError', chunkFailureListener)
  return () => {
    window.fetch = plain
    originalFetch = null
    if (chunkFailureListener) window.removeEventListener('vite:preloadError', chunkFailureListener)
    chunkFailureListener = null
  }
}

/**
 * Reloads a page whose release moved on, once per entry. A served entry or an
 * unreachable server leaves the original error alone, for its own view to show.
 */
async function reloadIfStale(): Promise<void> {
  // This module's own chunk belongs to the page's release: a new release
  // serves different hashes, so a 404 here means the page is stale. The entry
  // is immutable-cached, hence no-store.
  const entry = new URL(import.meta.url).pathname
  if (staleReloadEntry() === entry) return
  let stale = false
  try {
    const response = await fetch(entry, { cache: 'no-store' })
    stale = response.status === 404
  } catch {
    return
  }
  if (!stale) return
  recordStaleReload(entry)
  showUpdating()
}

function staleReloadEntry(): string | null {
  try {
    return window.sessionStorage.getItem(STALE_RELOAD_KEY)
  } catch {
    return null
  }
}

function recordStaleReload(entry: string): void {
  try {
    window.sessionStorage.setItem(STALE_RELOAD_KEY, entry)
  } catch {
    // Nowhere to record: a missing entry still means a stale page, so reload.
  }
}

/** Asks whether Poise is updating, as after a dropped connection. */
export async function probeForUpdate(): Promise<void> {
  try {
    const response = await (originalFetch ?? fetch)(UPDATING_PROBE_PATH, { cache: 'no-store' })
    if (isUpdating(response)) showUpdating()
  } catch {
    // Unreachable without the gateway's word: the Chat connection keeps retrying by itself.
  }
}

export function showUpdating(): void {
  if (overlay) return
  overlay = document.createElement('div')
  overlay.className = 'up-backdrop'
  overlay.setAttribute('role', 'alertdialog')
  overlay.setAttribute('aria-live', 'assertive')
  overlay.setAttribute('aria-label', 'Updating to the latest version')
  overlay.innerHTML = `
    <div class="up-card">
      <div class="up-spinner" aria-hidden="true"></div>
      <div class="up-title">Updating to the latest version…</div>
      <div class="up-detail">Poise is back in a few seconds. Running agents and reviews carry on.</div>
    </div>`
  document.body.append(overlay)
  requestAnimationFrame(() => overlay?.classList.add('up-visible'))
  poll()
}

/** Once Poise answers again without the gateway's mark, the new version is up: reload into it. */
function poll(): void {
  pollTimer = setTimeout(async () => {
    pollTimer = null
    try {
      const response = await (originalFetch ?? fetch)(UPDATING_PROBE_PATH, { cache: 'no-store' })
      if (response.ok && !isUpdating(response)) {
        location.reload()
        return
      }
    } catch {
      // Still restarting.
    }
    poll()
  }, UPDATING_POLL_MS)
}

/** For tests: back to the state before anything was noticed. */
export function resetUpdating(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  overlay?.remove()
  overlay = null
}
