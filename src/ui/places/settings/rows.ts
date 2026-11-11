// The setting row every Settings section shares (#556; the mocks' settings.js).
// One pattern: what it is and does on the left; its control and what happened
// to the last change on the right. A row saves itself: pickers when you
// choose, fields on Enter or when you leave them, never while the value is
// invalid. Saving…, then Saved with when it applies and Undo for eight
// seconds; an error stays on the row with the reason. A row that is not its
// default says so, with Reset.
import { esc } from '../../dom'
import { hydrateIcons, icon } from '../../icons'
import { paintTerms } from '../../reference'
import { term } from '../../registry'
import { shortTime } from '../../../clock'
import { effectiveTimezone } from '../../../config'
import { deepEqual } from '../../../settings-save'
import type { Outcome, Save } from './save'

export const UNDO_MS = 8000

export type RowType = 'text' | 'number' | 'select' | 'seg' | 'switch' | 'custom'

/** One setting. Values are what the control holds: text for fields, a choice's value for pickers, 'on' or 'off' for a switch. */
export interface Row {
  key: string
  /** The reference key; `set.<key>` when absent. */
  ref?: string
  group: string
  label: string
  gloss: string
  type: RowType
  /** The saved value, as this tab knows it. */
  value?: () => unknown
  def?: unknown
  /** The default in words, for "Changed · Reset to …". */
  defWords?: string | (() => string)
  options?: [string, string][]
  unit?: string
  placeholder?: string
  mono?: boolean
  /** Kept in this browser only: marked with the scope chip. */
  local?: boolean
  wide?: boolean
  /** No status line: a link, a read-only line, a custom row that says its own. */
  plain?: boolean
  applies?: string | ((value: unknown) => string)
  words?: (value: unknown) => string
  hint?: (value: unknown) => string
  /** What is wrong with a value, or ''. */
  check?: (value: unknown) => string
  /** Saves through the settings queue. */
  save?: (value: unknown) => Save
  /** Saves here, in this browser, at once. */
  apply?: (value: unknown) => void
  /** Saves somewhere of its own (the Manager's wake-ups): resolves when saved, rejects with the reason. */
  persist?: (value: unknown) => Promise<void>
  control?: (row: Row) => string
  meta?: (row: Row) => string
  /** The row's current state in words, for the reference; derived when absent. */
  now?: () => string
  findText?: () => string
  /** A custom row's own buttons: `data-act` names the action. */
  act?: (act: string, el: HTMLElement, event: Event) => void
  /** Wires a custom row's control after it is drawn. */
  mounted?: (el: HTMLElement) => void
  /** Repaints a custom control after the row's value or state changes. */
  painted?: (row: Row, el: HTMLElement) => void
  /** A custom control's own keys; true when handled. */
  onKey?: (e: KeyboardEvent, row: Row) => boolean
}

interface RowState {
  mode: null | 'dirty' | 'saving' | 'saved' | 'error'
  draft?: unknown
  prev?: unknown
  at?: string
  msg?: string
  /** A refused save: what changed, with Save mine and Use theirs. */
  conflict?: boolean
  /** The newest save of a row that saves somewhere of its own. */
  seq?: number
  timer?: ReturnType<typeof setTimeout>
}

export interface RowHost {
  /** Sends a row's save through the queue. */
  send(row: Row, save: Save): Promise<Outcome>
  /** Called after a row's saved value changes: counts and other rows' words. */
  changed(row: Row): void
  /** What a conflict's `current` means for this row, in words. */
  conflictWords(row: Row, current: Record<string, unknown>): string
}

const same = (a: unknown, b: unknown): boolean => deepEqual(a, b)
const optWords = (row: Row, v: unknown): string => row.options?.find(([o]) => o === v)?.[1] ?? String(v ?? '')
export const words = (row: Row, v: unknown = row.value?.()): string => (row.words ? row.words(v) : `${optWords(row, v)}${row.unit && v !== '' ? ` ${row.unit}` : ''}`)
const defWords = (row: Row): string => (typeof row.defWords === 'function' ? row.defWords() : row.defWords ?? words(row, row.def))
export const hasDef = (row: Row): boolean => row.def !== undefined
export const isDefault = (row: Row): boolean => hasDef(row) && same(row.value?.(), row.def)
const applies = (row: Row, v: unknown): string => (typeof row.applies === 'function' ? row.applies(v) : row.applies || 'applies now')
export const refOf = (row: Row): string => row.ref || `set.${row.key}`
const isField = (row: Row): boolean => row.type === 'text' || row.type === 'number'
const clock = (): string => shortTime(Date.now(), effectiveTimezone(), Date.now())

export function stateHTML(state: string, note = ''): string {
  return `<span class="st" data-state="${state}"><span data-term="state.${state}">${esc(term(`state.${state}`))}</span></span>${note ? `<span class="fnote">${note}</span>` : ''}`
}

export function nowWords(row: Row): string {
  if (row.now) return row.now()
  if (!row.value) return ''
  if (!hasDef(row)) return `${words(row) || 'Empty'}.`
  return `${words(row)}. ${isDefault(row) ? 'The default.' : `Changed from the default, ${defWords(row)}.`}`
}

/** A section's rows, drawn into its element, saving themselves. */
export class Rows {
  private readonly state = new Map<string, RowState>()
  private rows: Row[] = []

  constructor(private readonly el: HTMLElement, private readonly host: RowHost, signal: AbortSignal) {
    el.addEventListener('click', (e) => this.onClick(e), { signal })
    el.addEventListener('input', (e) => this.onInput(e), { signal })
    el.addEventListener('change', (e) => this.onChange(e), { signal })
    el.addEventListener('keydown', (e) => this.onKey(e), { signal })
    el.addEventListener('focusout', (e) => this.onLeave(e), { signal })
    signal.addEventListener('abort', () => { for (const s of this.state.values()) clearTimeout(s.timer) })
  }

  /** Whether any row holds a change that is not saved yet. */
  pending(): boolean {
    return [...this.state.values()].some((s) => s.mode === 'saving' || s.mode === 'dirty')
  }

  byKey(key: string): Row | undefined { return this.rows.find((r) => r.key === key) }

  /** Draws these rows, grouped, keeping each row's state. */
  render(rows: Row[], into: HTMLElement): void {
    this.rows = rows
    const groups = [...new Set(rows.map((r) => r.group))]
    into.innerHTML = groups.map((g, i) => `<section class="sgrp" aria-labelledby="g-${i}"><h2 class="t-micro" id="g-${i}">${esc(g)}</h2>${rows.filter((r) => r.group === g).map((r) => this.rowHTML(r)).join('')}</section>`).join('')
    this.hydrate(into)
    for (const row of rows) { const el = this.rowEl(row.key); if (el) row.mounted?.(el) }
  }

  rowEl(key: string): HTMLElement | null { return this.el.querySelector<HTMLElement>(`[data-setting="${CSS.escape(key)}"]`) }

  /** Draws one row again, keeping what its own status line says. */
  rerow(key: string): void {
    const row = this.byKey(key), el = this.rowEl(key)
    if (!row || !el) return
    const said = el.querySelector('[data-lstat]')?.innerHTML
    el.outerHTML = this.rowHTML(row)
    const next = this.rowEl(key)!
    this.hydrate(next)
    row.mounted?.(next)
    if (said) this.lstat(row, said)
  }

  /** A custom row's own status line. */
  lstat(row: Row, html: string): void {
    const el = this.rowEl(row.key)?.querySelector<HTMLElement>('[data-lstat]')
    if (el) { el.innerHTML = html; this.hydrate(el) }
  }

  /** Repaints a row's status and control; the field you type in is left alone unless `value`. */
  paint(row: Row, { value = false } = {}): void {
    const el = this.rowEl(row.key)
    if (!el) return
    const s = this.state.get(row.key)
    el.dataset.now = nowWords(row)
    const stat = el.querySelector<HTMLElement>('[data-stat]')
    if (stat) { stat.innerHTML = this.statHTML(row); this.hydrate(stat) }
    const shown = this.shown(row)
    el.querySelectorAll<HTMLInputElement>('input[data-input]').forEach((input) => {
      input.setAttribute('aria-invalid', String(s?.mode === 'error'))
      if (value) input.value = String(shown ?? '')
    })
    el.querySelectorAll<HTMLSelectElement>('select[data-input]').forEach((select) => {
      const v = select.dataset.part ? (shown as Record<string, unknown> | undefined)?.[select.dataset.part] : shown
      if (value || select !== document.activeElement) select.value = String(v ?? '')
    })
    el.querySelectorAll<HTMLElement>('.seg[data-seg]').forEach((g) => g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(shown)))))
    el.querySelectorAll<HTMLElement>('.sswitch').forEach((sw) => {
      sw.setAttribute('aria-pressed', String(shown === 'on'))
      const word = sw.querySelector('[data-switch-word]')
      if (word) word.textContent = shown === 'on' ? 'On' : 'Off'
    })
    const meta = el.querySelector<HTMLElement>('[data-meta]')
    if (meta && row.meta) { meta.innerHTML = row.meta(row); this.hydrate(meta) }
    row.painted?.(row, el)
  }

  /** Paints every row from what this tab knows; rows being edited keep their drafts. */
  paintAll(): void { for (const row of this.rows) this.paint(row, { value: !this.busy(row) }) }

  private busy(row: Row): boolean {
    const mode = this.state.get(row.key)?.mode
    return mode === 'dirty' || mode === 'saving' || mode === 'error'
  }

  /** What the control shows: the draft while it saves or was refused, else the saved value. */
  shown(row: Row): unknown {
    const s = this.state.get(row.key)
    return s && (s.mode === 'saving' || s.mode === 'error' || s.mode === 'dirty') && 'draft' in s ? s.draft : row.value?.()
  }

  // ---------- Drawing ----------
  private hydrate(el: HTMLElement): void { hydrateIcons(el); paintTerms(el) }

  private statHTML(row: Row): string {
    const s = this.state.get(row.key) ?? { mode: null }
    const hint = (v: unknown) => (row.hint ? `<span class="t-mono">${esc(row.hint(v))}</span>` : '')
    if (s.mode === 'saving') return '<span class="sdot"></span>Saving…'
    if (s.mode === 'saved') return `<span class="sdot is-saved"></span>Saved ${esc(s.at ?? '')} · ${esc(applies(row, row.value?.()))}${s.prev !== undefined ? ' · <button type="button" class="lnk" data-act="undo" data-ref="set.undo">Undo</button>' : ''}`
    if (s.mode === 'error') {
      if (s.conflict) return `<span class="is-err" role="alert">Not saved: ${esc(s.msg ?? '')}.</span> <button type="button" class="lnk" data-act="mine" data-ref="set.mine">Save mine</button> · <button type="button" class="lnk" data-act="theirs" data-ref="set.theirs">Use theirs</button>`
      return `<span class="is-err" role="alert">Not saved: ${esc(s.msg ?? '')}.</span>${isField(row) ? ` Esc puts back ${esc(words(row) || 'the saved value')}.` : ''}`
    }
    if (s.mode === 'dirty') return `${row.hint ? `${hint(s.draft)} · ` : ''}Enter saves · Esc puts back`
    if (!hasDef(row)) return hint(row.value?.())
    if (isDefault(row)) return `Default${row.hint ? ` · ${hint(row.value?.())}` : ''}`
    return `Changed · <button type="button" class="lnk" data-act="reset" data-ref="set.reset">Reset to ${esc(defWords(row))}</button>`
  }

  private controlHTML(row: Row): string {
    if (row.control) return row.control(row)
    const id = `s-${row.key}`, v = this.shown(row), ref = refOf(row)
    switch (row.type) {
      case 'text': case 'number':
        return `<span class="sfield"><input id="${id}" class="sinput${row.mono ? ' t-mono' : ''}${row.unit ? ' is-short' : ''}" value="${esc(String(v ?? ''))}"${row.type === 'number' ? ' inputmode="numeric"' : ''} placeholder="${esc(row.placeholder ?? '')}" autocomplete="off" spellcheck="false" data-input data-ref="${ref}">${row.unit ? `<span class="unit">${esc(row.unit)}</span>` : ''}</span>`
      case 'select': return selectHTML(row, { id, value: v })
      case 'seg': return `<div class="seg" role="group" aria-labelledby="l-${row.key}" data-seg data-ref="${ref}">${(row.options ?? []).map(([o, l]) => `<button type="button" aria-pressed="${o === v}" data-v="${esc(o)}">${esc(l)}</button>`).join('')}</div>`
      case 'switch': return `<button type="button" class="sswitch" id="${id}" aria-pressed="${v === 'on'}" data-ref="${ref}"><span class="switch"></span><span data-switch-word>${v === 'on' ? 'On' : 'Off'}</span></button>`
      default: return ''
    }
  }

  private rowHTML(row: Row): string {
    const labelFor = ['text', 'number', 'select', 'switch'].includes(row.type) && !row.control ? ` for="s-${row.key}"` : ''
    // A custom row that saves a value says so as any row does; one that acts says what happened on its own line.
    const saves = !!(row.save || row.persist || row.apply)
    const stat = row.plain ? '' : row.type === 'custom' && !saves ? '<div class="sstat" data-lstat aria-live="polite"></div>' : `<div class="sstat" data-stat data-ref="set.status" aria-live="polite">${this.statHTML(row)}</div>`
    const left = `<div class="srow-l"><span class="slabel"><label id="l-${row.key}"${labelFor} data-ref="${refOf(row)}">${esc(row.label)}</label>${row.local ? '<span class="chip is-outline" data-ref="set.scope">This browser</span>' : ''}</span><p class="gloss">${row.gloss}</p>${row.meta ? `<p class="smeta" data-meta>${row.meta(row)}</p>` : ''}</div>`
    return `<div class="srow${row.wide ? ' is-wide' : ''}" data-setting="${esc(row.key)}" data-now="${esc(nowWords(row))}">${left}<div class="srow-r">${this.controlHTML(row)}${stat}</div></div>`
  }

  // ---------- Saving ----------
  /** Saves a row's value: checked, then sent; the row says what happened. */
  commit(row: Row, v: unknown, { undo = false } = {}): void {
    const s = this.stateOf(row)
    clearTimeout(s.timer)
    if (same(v, row.value?.())) { Object.assign(s, { mode: null, draft: undefined, conflict: false }); this.paint(row, { value: true }); return }
    const problem = row.check?.(v)
    if (problem) {
      // A typed value stays in its field to fix; a choice goes back to the saved one.
      Object.assign(s, { mode: 'error', msg: problem, conflict: false, ...(isField(row) ? { draft: v } : { draft: undefined }) })
      this.paint(row, { value: !isField(row) })
      return
    }
    const prev = undo ? undefined : row.value?.()
    if (row.apply) {
      row.apply(v)
      Object.assign(s, { mode: 'saved', at: clock(), prev, draft: undefined, conflict: false })
      this.settle(row)
      return
    }
    if (row.persist) {
      Object.assign(s, { mode: 'saving', draft: v, conflict: false, ...(prev !== undefined || undo ? { prev } : {}) })
      this.paint(row, { value: true })
      const mine = (s.seq = (s.seq ?? 0) + 1)
      row.persist(v).then(() => {
        if (s.seq !== mine) return
        Object.assign(s, { mode: 'saved', at: clock(), draft: undefined })
        this.settle(row)
      }, (error: unknown) => {
        if (s.seq !== mine) return
        Object.assign(s, { mode: 'error', conflict: false, msg: (error as Error).message || String(error), draft: undefined })
        this.paint(row, { value: true })
      })
      return
    }
    if (!row.save) return
    Object.assign(s, { mode: 'saving', draft: v, conflict: false, ...(prev !== undefined || undo ? { prev } : {}) })
    this.paint(row, { value: true })
    void this.host.send(row, row.save(v)).then((outcome) => {
      if (outcome.kind === 'superseded') return
      if (outcome.kind === 'saved') {
        Object.assign(s, { mode: 'saved', at: clock(), draft: undefined })
        this.settle(row)
        return
      }
      if (outcome.kind === 'conflict') Object.assign(s, { mode: 'error', conflict: true, msg: this.host.conflictWords(row, outcome.current) })
      else Object.assign(s, { mode: 'error', conflict: false, msg: outcome.message })
      this.paint(row, { value: !isField(row) })
      this.host.changed(row)
    })
  }

  private settle(row: Row): void {
    const s = this.stateOf(row)
    this.paint(row, { value: true })
    this.host.changed(row)
    s.timer = setTimeout(() => { Object.assign(s, { mode: null, prev: undefined }); this.paint(row) }, UNDO_MS)
  }

  private putBack(row: Row): void {
    const s = this.stateOf(row)
    clearTimeout(s.timer)
    Object.assign(s, { mode: null, draft: undefined, conflict: false })
    this.paint(row, { value: true })
  }

  private stateOf(row: Row): RowState {
    let s = this.state.get(row.key)
    if (!s) { s = { mode: null }; this.state.set(row.key, s) }
    return s
  }

  // ---------- Events ----------
  private rowOf(target: EventTarget | null): Row | undefined {
    return this.byKey((target as Element | null)?.closest<HTMLElement>('[data-setting]')?.dataset.setting ?? '')
  }

  private onClick(e: Event): void {
    const b = (e.target as Element).closest<HTMLElement>('button, a')
    if (!b || b.matches('[aria-disabled="true"]')) return
    const row = this.rowOf(b)
    if (!row) return
    const s = this.stateOf(row)
    switch (b.dataset.act) {
      case 'undo': this.commit(row, s.prev, { undo: true }); return
      case 'reset': this.commit(row, row.def); return
      case 'mine': this.commit(row, s.draft); return
      case 'theirs': this.putBack(row); this.host.changed(row); return
      case undefined: break
      default: row.act?.(b.dataset.act, b, e); return
    }
    if (b.matches('.seg[data-seg] button')) { this.commit(row, b.dataset.v); return }
    if (b.matches('.sswitch')) this.commit(row, this.shown(row) === 'on' ? 'off' : 'on')
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement
    if (!t.matches('input[data-input]')) return
    const row = this.rowOf(t)
    if (!row || !isField(row)) return
    const s = this.stateOf(row), v = t.value.trim()
    clearTimeout(s.timer)
    Object.assign(s, v === String(row.value?.() ?? '') ? { mode: null, draft: undefined, conflict: false } : { mode: 'dirty', draft: v, conflict: false })
    this.paint(row)
  }

  private onChange(e: Event): void {
    const t = e.target as HTMLSelectElement
    if (!t.matches('select[data-input]')) return
    const row = this.rowOf(t)
    if (!row) return
    const part = t.dataset.part
    this.commit(row, part ? { ...(this.shown(row) as Record<string, unknown>), [part]: t.value } : t.value)
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLInputElement
    const own = this.rowOf(t)
    if (own?.onKey?.(e, own)) return
    if (!t.matches('input[data-input]')) return
    const row = this.rowOf(t)
    if (!row || !isField(row)) return
    const mode = this.state.get(row.key)?.mode
    if (e.key === 'Enter') { e.preventDefault(); this.commit(row, t.value.trim()) }
    if (e.key === 'Escape' && (mode === 'dirty' || mode === 'error')) { e.preventDefault(); e.stopPropagation(); this.putBack(row) }
  }

  // Leaving a field saves it, unless what is in it is not valid.
  private onLeave(e: Event): void {
    const t = e.target as HTMLInputElement
    if (!t.matches('input[data-input]')) return
    const row = this.rowOf(t)
    if (row && this.state.get(row.key)?.mode === 'dirty') this.commit(row, t.value.trim())
  }
}

export function selectHTML(row: Row, { id, value, part, label, options = row.options ?? [] }: { id?: string, value: unknown, part?: string, label?: string, options?: [string, string][] }): string {
  const cur = part ? (value as Record<string, unknown> | undefined)?.[part] : value
  const known = options.some(([o]) => o === cur)
  // A value with no option of its own still shows, rather than a blank select.
  const all: [string, string][] = known || cur === undefined || cur === null || cur === '' ? options : [[String(cur), String(cur)], ...options]
  return `<span class="sselect"><select${id ? ` id="${id}"` : ''} data-input${part ? ` data-part="${esc(part)}"` : ''}${label ? ` aria-label="${esc(label)}"` : ''} data-ref="${refOf(row)}">${all.map(([o, l]) => `<option value="${esc(o)}"${o === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></span>`
}

export { icon }
