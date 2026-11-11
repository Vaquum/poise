// What a Settings section is, and what the place gives it (#556).
import type { Section } from '../../address'
import type { Row, Rows } from './rows'
import type { Known, SaveQueue } from './save'

export interface SectionContext {
  /** The section's rows: drawn, painted and saving themselves. */
  rows: Rows
  queue: SaveQueue
  /** The settings this tab knows, as GET /api/settings and each save return them. */
  known(): Known
  /** Aborted when the section is left, or the place leaves. */
  signal: AbortSignal
  every(ms: number, fn: () => void): void
  after(ms: number, fn: () => void): void
  query: URLSearchParams
  /** Opens a section, lighting one row when named. */
  go(section: Section, setting?: string): void
  /** Draws the section's rows again from what is known, keeping each row's state. */
  rerender(): void
  /** Service mode: a workspace behind the gateway. */
  service: boolean
}

export interface SectionDef {
  key: Section
  name: string
  what: string
  /** A chip after the section's name: Style is kept in this browser. */
  scope?: string
  /** A section of setting rows. */
  rows?: (ctx: SectionContext) => Row[]
  /** What the rows read before they are drawn, and again on Retry. */
  load?: (ctx: SectionContext) => Promise<void> | void
  /** A section that draws itself, a classic view embedded: may return what to stop on leaving. */
  mount?: (body: HTMLElement, ctx: SectionContext) => void | (() => void) | Promise<void | (() => void)>
  /** Words Find matches for a section that draws itself. */
  findText?: string
}
