// What Observe hands each of its parts, and what a part answers.
import type { Part } from '../../address'

export interface Scope {
  /** The organization shown, or '' for all of them. */
  org(): string
  /** Changes it; `remember` saves it as Board's choice, otherwise it holds for this visit. */
  set(org: string, remember: boolean): void
  onChange(fn: () => void): void
}

export interface PartContext {
  /** The part's panel, empty until the part draws itself. */
  root: HTMLElement
  /** The address Observe was opened with: each part reads its own target from it once. */
  query: URLSearchParams
  /** Where Observe was opened from, kept on links to its other parts. */
  back: string | null
  signal: AbortSignal
  every(ms: number, fn: () => void): void
  after(ms: number, fn: () => void): void
  scope: Scope
  /** Whether the part is the one showing, in a tab that is visible. */
  visible(): boolean
  /** The tab's own number, as markup. */
  count(html: string): void
  /** Follows a link within this page, as a history entry. */
  go(href: string): void
}

export interface ObservePart {
  show(): void
  hide(): void
  leave(): void
  /** An action sent and not yet answered: a reload onto a new build waits for it. */
  busy(): boolean
}

export type { Part }
