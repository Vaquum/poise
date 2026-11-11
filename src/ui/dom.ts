// The small helpers every place uses, from the mocks' shell.js. Queries are
// loosely typed on purpose: the places are ported from the mocks, which find
// their own markup and fail loudly if it is missing.

export const $ = (selector: string, root: ParentNode = document): any => root.querySelector(selector)
export const $$ = (selector: string, root: ParentNode = document): any[] => [...root.querySelectorAll(selector)]

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
export const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"]/g, (c) => ENTITIES[c])

/** This browser's own choices. A private window keeps them for the visit only. */
export const store = {
  get<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v) as T } catch { return fallback }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window: kept for this visit */ }
  },
}
