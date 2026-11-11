// A return from an Extensions sign-in at /extensions/oauth?code&state, finished
// before anything else reads that query: Google's return looks the same.
// Copied from finishExtensionSignIn in src/views/extensions-view.ts, which this
// page cannot import: that module brings classic's own stylesheet.

export interface ExtensionReturn { text: string, tone: 'info' | 'error' }

/** Finishes the sign-in and says how it went, or returns null when this is no such return. */
export async function finishExtensionSignIn(): Promise<ExtensionReturn | null> {
  if (location.pathname !== '/extensions/oauth') return null
  const url = new URL(location.href)
  const body = { state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error_description') || url.searchParams.get('error') }
  history.replaceState(null, '', '/?view=settings&settings=extensions')
  try {
    const response = await fetch('/api/extensions/oauth', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const text = await response.text()
    let parsed: { error?: string, title?: string } | null = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* reported below */ }
    if (!response.ok) throw new Error(parsed?.error || `Extensions answered ${response.status}.`)
    return { text: `Signed in to ${parsed?.title ?? 'the extension'}. Chats pick it up from their next turn.`, tone: 'info' }
  } catch (error) {
    return { text: (error as Error).message, tone: 'error' }
  }
}
