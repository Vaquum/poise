// While a workspace restarts onto a new release, the gateway answers for it
// with `x-poise-updating: 1` (gateway/src/workspace.ts). Poise then dims the
// page under "Updating to the latest version" and, once it answers again,
// reloads into the new version. A dropped Chat connection asks at once, so
// the notice shows within moments of the restart.

import './views/updating.css'

export const UPDATING_HEADER = 'x-poise-updating'
export const UPDATING_PROBE_PATH = '/api/workspace'
/** How often the page asks whether Poise is back, while it updates. */
export const UPDATING_POLL_MS = 1_500

let originalFetch: typeof fetch | null = null
let overlay: HTMLElement | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null

function isUpdating(response: Response): boolean {
  return response.headers.get(UPDATING_HEADER) === '1'
}

/** Notices every answer the gateway marks as updating. Returns a function that stops noticing. */
export function watchForUpdates(): () => void {
  if (originalFetch) return () => undefined
  const plain = window.fetch.bind(window)
  originalFetch = plain
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await plain(...args)
    if (isUpdating(response)) showUpdating()
    return response
  }
  return () => {
    window.fetch = plain
    originalFetch = null
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
