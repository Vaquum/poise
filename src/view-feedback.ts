import { noticeFeed, type LocalNotice } from './notices'

const diagnostics = new Map<string, string>()

/** Operational details belong in logging; repeat refreshes do not repeat the log. */
export function viewDiagnostic(source: string, message: string): void {
  if (diagnostics.get(source) === message) return
  diagnostics.set(source, message)
  if (message) console.info(`[${source}] ${message}`)
}

/** Failures and actionable results remain accessible across views until recovery. */
export function viewFeedback(source: string, title: string, body: string, kind: LocalNotice['kind'] = 'action_failed'): void {
  noticeFeed.reportLocalNotices(source, body ? [{ key: source, title, body, kind }] : [])
}

/** Reading feedback must not dismiss or submit the draft whose failure it explains. */
export function isNotificationInteraction(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('#notification-bell, #notification-rail, .nr-toasts')
}
