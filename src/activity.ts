// Tells the server that someone is using Poise, so a requested release switch
// waits for a quiet moment instead of restarting under their hands
// (server/service/control.ts). Only input counts: a pointer, a key, a wheel or
// a touch on a visible page, never a background read, and at most one report
// every ACTIVITY_REPORT_MS.

export const ACTIVITY_PATH = '/api/service/activity'
export const ACTIVITY_REPORT_MS = 30_000
const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

type ActivityTarget = Pick<Window, 'addEventListener' | 'removeEventListener' | 'fetch'> & { document: Pick<Document, 'visibilityState'> }

/** Starts reporting input; returns a function that stops it. */
export function reportActivity(target: ActivityTarget = window, now: () => number = Date.now): () => void {
  let reportedAt = -Infinity
  const report = () => {
    if (target.document.visibilityState !== 'visible') return
    const at = now()
    if (at - reportedAt < ACTIVITY_REPORT_MS) return
    reportedAt = at
    void target.fetch(ACTIVITY_PATH, { method: 'POST', keepalive: true }).catch(() => undefined)
  }
  for (const type of INPUTS) target.addEventListener(type, report, { capture: true, passive: true })
  return () => {
    for (const type of INPUTS) target.removeEventListener(type, report, { capture: true })
  }
}
