// One time filter and one search filter for Overview's right-hand side (#1380).
// The day control is the time filter; this is the search: each panel draws
// only what matches, says so when nothing does, and redraws when it changes.

/** What the right-hand side is filtered by. */
export interface RightFilter {
  /** The search text, trimmed; empty matches everything. */
  query(): string
  /** True when `text` contains the search text, ignoring case. */
  matches(...texts: (string | null | undefined)[]): boolean
  /** Hears the search change; returns a way to stop hearing it. */
  onChange(listener: () => void): () => void
  /** "Nothing here matches “…”." for a panel with nothing to show. */
  none(): string
}

export function rightFilter(input: HTMLInputElement, signal: AbortSignal): RightFilter {
  const listeners = new Set<() => void>()
  let query = ''
  input.addEventListener('input', () => {
    const next = input.value.trim()
    if (next === query) return
    query = next
    for (const listener of listeners) listener()
  }, { signal })
  // Escape clears the search, as a search field's own clear does.
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { input.value = ''; input.dispatchEvent(new Event('input')) } }, { signal })
  return {
    query: () => query,
    matches: (...texts) => !query || texts.some((text) => !!text && text.toLowerCase().includes(query.toLowerCase())),
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    none: () => `Nothing here matches “${query}”.`,
  }
}
