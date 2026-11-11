// Settings → Style (#556; SETTINGS.md, T1–T17): the Style panel's choices as
// rows, kept in this browser. Each row writes one token through the panel's
// own module (style-panel.ts), so a change in one shows in the other.
import { esc } from '../../dom'
import { ARCHETYPES, MEANINGS, NEUTRALS, PRESETS, archetype, css, defaultOf, restore, savedStyle, setArchetype, setStyle, styleToken, toHex } from '../../style-panel'
import { shortTime } from '../../../clock'
import { effectiveTimezone } from '../../../config'
import { UNDO_MS, type Row } from './rows'
import type { SectionContext, SectionDef } from './types'

const PRESET_KEYS = ['--ctl-base-size', '--ctl-density']
const LINE_WORDS: Record<string, string> = { '-0.25': 'Tighter by ¼ line', 0: 'None', 0.25: '¼ line', 0.5: '½ line', 0.75: '¾ line', 1: '1 line' }
const num = (v: unknown) => parseFloat(String(v))
const clock = () => shortTime(Date.now(), effectiveTimezone(), Date.now())

interface TokenSpec { key: string, prop: string, group: string, label: string, gloss: string, min: number, max: number, step: number, unit?: string, fmt: (v: number) => string }
const TOKENS: TokenSpec[] = [
  { key: 'size', prop: '--ctl-base-size', group: 'Type', label: 'Base size', gloss: 'Every size of type and control derives from this one, including rows and tables.', min: 13, max: 18, step: 0.5, unit: 'px', fmt: (v) => `${v}px` },
  { key: 'leading', prop: '--ctl-leading', group: 'Type', label: 'Line height', gloss: 'The space between lines of reading and body text, shown for reading text. Interface labels keep theirs.', min: 0.85, max: 1.3, step: 0.05, fmt: (v) => (1.7 * v).toFixed(2) },
  { key: 'density', prop: '--ctl-density', group: 'Space and shape', label: 'Density', gloss: 'Space inside and between things: rows, cards and controls.', min: 0.75, max: 1.35, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
  { key: 'corners', prop: '--ctl-radius', group: 'Space and shape', label: 'Corners', gloss: 'From square to round, on every card, field and panel.', min: 0, max: 2, step: 0.25, fmt: (v) => (v === 0 ? 'Square' : `${v.toFixed(2)}×`) },
  { key: 'lines', prop: '--ctl-line', group: 'Space and shape', label: 'Route lines', gloss: 'The weight of routes and their stations, in Board, Chat and the Manager.', min: 0.6, max: 1.6, step: 0.1, fmt: (v) => `${v.toFixed(1)}×` },
  { key: 'measure', prop: '--ctl-measure', group: 'Writing', label: 'Reading width', gloss: 'How wide a page of text runs in Editor and Settings. The other views fill the window.', min: 0.8, max: 1.3, step: 0.05, fmt: (v) => `${Math.round(760 * v)}px` },
  { key: 'heading', prop: '--ctl-heading', group: 'Writing', label: 'Heading size', gloss: 'A document’s headings, and the space around them, which grows with them so they stay one family.', min: 0.8, max: 1.4, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'paragraph', prop: '--ctl-paragraph', group: 'Writing', label: 'Paragraph spacing', gloss: 'Extra space after each paragraph in Editor, in lines. None keeps the empty line you type as the only gap.', min: -0.25, max: 1, step: 0.25, fmt: (v) => LINE_WORDS[String(v)] ?? `${v} line` },
  { key: 'tints', prop: '--ctl-tint', group: 'Colour', label: 'Status tints', gloss: 'How strongly a state colours its chip and its background.', min: 10, max: 35, step: 1, unit: '%', fmt: (v) => `${v}%` },
]

function tokenRow(ctx: SectionContext, t: TokenSpec): Row {
  const def = defaultOf(t.prop)
  const row: Row = {
    key: `style.${t.key}`, ref: `set.style.${t.key}`, group: t.group, label: t.label, gloss: t.gloss, type: 'custom',
    value: () => styleToken(t.prop), def, defWords: t.fmt(num(def)), applies: 'applies now, in every view',
    words: (v) => t.fmt(num(v)),
    control: (r) => `<span class="srange"><input type="range" min="${t.min}" max="${t.max}" step="${t.step}" value="${num(r.value?.())}" aria-label="${esc(t.label)}" data-range data-ref="set.style.${t.key}"><output data-range-out>${esc(t.fmt(num(r.value?.())))}</output></span>`,
    apply: (v) => setStyle(t.prop, v === def ? null : String(v)),
    painted: (r, el) => {
      const input = el.querySelector<HTMLInputElement>('[data-range]'), out = el.querySelector('[data-range-out]')
      if (input && document.activeElement !== input) input.value = String(num(r.value?.()))
      if (out) out.textContent = t.fmt(num(r.value?.()))
    },
    // While you drag, the page shows it; letting go saves it.
    mounted: (el) => {
      const input = el.querySelector<HTMLInputElement>('[data-range]')
      input?.addEventListener('input', () => {
        document.documentElement.style.setProperty(t.prop, `${input.value}${t.unit ?? ''}`)
        const out = el.querySelector('[data-range-out]')
        if (out) out.textContent = t.fmt(num(input.value))
      }, { signal: ctx.signal })
      input?.addEventListener('change', () => ctx.rows.commit(row, `${input.value}${t.unit ?? ''}`), { signal: ctx.signal })
    },
  }
  return row
}

function palette(ctx: SectionContext, key: string, label: string, gloss: string, list: Array<[string, string, string?]>, folded: boolean): Row {
  let before: Record<string, string> | null = null
  let open = !folded
  const hex = (prop: string) => toHex(styleToken(prop))
  const changed = (prop: string) => hex(prop) !== toHex(defaultOf(prop))
  const say = (html: string) => ctx.rows.lstat(row, html)
  const row: Row = {
    key: `style.${key}`, ref: `set.style.${key}`, group: 'Colour', label, gloss, type: 'custom', wide: true,
    now: () => { const n = list.filter(([p]) => changed(p)).length; return n ? `${n} of ${list.length} changed from Poise’s own.` : `All ${list.length} are Poise’s own.` },
    findText: () => list.map(([, n, note]) => `${n} ${note ?? ''}`).join(' '),
    control: () => `<div class="flist">${open ? list.map(([prop, name, note]) => `<div class="frow" data-item="${esc(prop)}" data-ref="set.style.colour.row"><span class="fmain"><span class="name">${esc(name)}</span>${note ? `<span class="fsub">${esc(note)}</span>` : ''}</span><span class="fstate">${changed(prop) ? '<button type="button" class="lnk" data-act="c-reset" data-ref="set.reset">Reset</button>' : '<span class="fnote">Default</span>'}</span><span class="facts"><input type="color" value="${hex(prop)}" aria-label="${esc(name)} colour" data-colour data-ref="set.style.colour"></span></div>`).join('') : `<p class="fnone">Folded: ${list.length} colours, from ${esc(list[0][1])} to ${esc(list[list.length - 1][1])}.</p>`}</div>${folded ? `<button type="button" class="btn-ghost" data-act="fold" aria-expanded="${open}" data-ref="set.style.neutrals">${open ? 'Fold the neutrals' : 'Show the neutrals'}</button>` : ''}`,
    act: (act, el) => {
      const prop = el.closest<HTMLElement>('[data-item]')?.dataset.item ?? ''
      const name = list.find(([p]) => p === prop)?.[1] ?? ''
      if (act === 'c-reset') { before = savedStyle(); setStyle(prop, null); ctx.rows.rerow(row.key); say(`<span class="sdot is-saved"></span>${esc(name)} is Poise’s own again · <button type="button" class="lnk" data-act="c-undo" data-ref="set.undo">Undo</button>`) }
      if (act === 'c-undo' && before) { restore(before); before = null; ctx.rows.rerow(row.key); say('Back to the colours you had') }
      if (act === 'fold') { open = !open; ctx.rows.rerow(row.key) }
    },
    mounted: (el) => {
      el.addEventListener('input', (e) => { const t = e.target as HTMLInputElement; if (t.matches('[data-colour]')) document.documentElement.style.setProperty(t.closest<HTMLElement>('[data-item]')!.dataset.item!, t.value) }, { signal: ctx.signal })
      el.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement
        if (!t.matches('[data-colour]')) return
        const prop = t.closest<HTMLElement>('[data-item]')!.dataset.item!
        before = savedStyle()
        setStyle(prop, t.value)
        ctx.rows.rerow(row.key)
        say(`<span class="sdot is-saved"></span>Saved ${esc(list.find(([p]) => p === prop)?.[1] ?? '')} ${clock()} · applies now, in every view · <button type="button" class="lnk" data-act="c-undo" data-ref="set.undo">Undo</button>`)
      }, { signal: ctx.signal })
    },
  }
  return row
}

export const STYLE: SectionDef = {
  key: 'style',
  name: 'Style',
  what: 'How Poise looks and reads: type, space, shape, motion and the meaning colours. The Style panel holds the same choices, over any view.',
  scope: 'This browser',
  rows: (ctx) => {
    const tokens = TOKENS.map((t) => tokenRow(ctx, t))
    const presetIn = () => Object.entries(PRESETS).find(([, p]) => Object.entries(p.values).every(([k, v]) => styleToken(k) === v))?.[0] ?? ''
    let presetBefore: Record<string, string> | null = null
    let styleBefore: Record<string, string> | null = null
    const preset: Row = {
      key: 'style.preset', ref: 'set.style.preset', group: 'Start from', label: 'Preset', type: 'custom', wide: true,
      gloss: 'A starting point for size and density. Every row below stays yours to change.',
      control: () => `<div class="choices is-4" role="group" aria-label="Presets" data-ref="set.style.preset">${Object.entries(PRESETS).map(([k, p]) => `<button type="button" class="choice" data-act="preset" data-v="${k}" aria-pressed="${presetIn() === k}"><b>${esc(p.label)}</b><span>${esc(p.gloss)}</span></button>`).join('')}</div>`,
      painted: (_r, el) => el.querySelectorAll<HTMLElement>('[data-act="preset"]').forEach((b) => b.setAttribute('aria-pressed', String(presetIn() === b.dataset.v))),
      act: (act, el) => {
        if (act === 'preset') {
          presetBefore = savedStyle()
          const p = PRESETS[el.dataset.v ?? '']
          // Each row the preset touches saves on its own row, with its own Undo.
          for (const r of tokens) { const prop = TOKENS.find((t) => `style.${t.key}` === r.key)!.prop; if (PRESET_KEYS.includes(prop)) ctx.rows.commit(r, p.values[prop]) }
          ctx.rows.lstat(preset, `<span class="sdot is-saved"></span>Starting from ${esc(p.label)} ${clock()} · applies now · <button type="button" class="lnk" data-act="preset-undo" data-ref="set.undo">Undo</button>`)
          ctx.rows.paint(preset)
        }
        if (act === 'preset-undo' && presetBefore) { restore(presetBefore); presetBefore = null; ctx.rows.paintAll(); ctx.rows.lstat(preset, 'Back to what you had') }
      },
      // The panel, a preset or Undo can change a token: every Style row follows.
      mounted: () => document.addEventListener('poise:style', () => ctx.rows.paintAll(), { signal: ctx.signal }),
    }
    const typeface: Row = {
      key: 'style.type', ref: 'set.style.type', group: 'Type', label: 'Typeface', type: 'custom', wide: true,
      gloss: 'The faces for the interface, for headings and display, and for code, chosen to belong together.',
      value: () => archetype(), def: 'engineer', applies: 'applies now, in every view',
      words: (v) => `${ARCHETYPES[String(v)]?.label ?? v}: ${ARCHETYPES[String(v)]?.gloss ?? ''}`,
      control: (r) => `<div class="choices is-3" role="group" aria-labelledby="l-style.type" data-ref="set.style.type">${Object.entries(ARCHETYPES).map(([k, a]) => `<button type="button" class="choice" data-act="face" data-v="${k}" aria-pressed="${k === r.value?.()}"><b>${esc(a.label)}</b><span>${esc(a.gloss)}</span></button>`).join('')}</div>`,
      painted: (r, el) => el.querySelectorAll<HTMLElement>('[data-act="face"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === r.value?.()))),
      apply: (v) => setArchetype(String(v)),
      act: (act, el) => { if (act === 'face') ctx.rows.commit(typeface, el.dataset.v) },
    }
    const motion: Row = {
      key: 'style.motion', ref: 'set.style.motion', group: 'Space and shape', label: 'Motion', type: 'switch',
      gloss: 'The Tactile spring when things open, settle and reorder. Off keeps everything still; nothing waits on an animation.',
      value: () => (styleToken('--ctl-motion') === '0' ? 'off' : 'on'), def: 'on', words: (v) => (v === 'on' ? 'On' : 'Off'), applies: 'applies now, in every view',
      apply: (v) => setStyle('--ctl-motion', v === 'on' ? null : '0'),
    }
    const at = (k: string) => tokens.find((r) => r.key === `style.${k}`)!
    const copy: Row = {
      key: 'style.copy', ref: 'set.style.copy', group: 'Keep and share', label: 'Copy as CSS', type: 'custom',
      gloss: 'Your changes as CSS custom properties, to keep or to share.',
      control: () => '<button type="button" class="btn-ghost" data-act="copy" data-ref="set.style.copy"><i data-i="copy" class="sm"></i><span>Copy as CSS</span></button>',
      act: (act, el) => {
        if (act !== 'copy') return
        // Says Copied only once the browser took the text.
        void (async () => {
          let copied = true
          try {
            if (!navigator.clipboard) throw new Error('no clipboard')
            await navigator.clipboard.writeText(css())
          } catch { copied = false }
          if (ctx.signal.aborted) return
          const n = Object.keys(savedStyle()).filter((k) => k !== '--archetype').length
          ctx.rows.lstat(copy, !copied ? '<span class="is-err">Not copied: the browser refused the clipboard</span>'
            : n ? `Copied ${n} change${n === 1 ? '' : 's'} as CSS` : 'Copied · there are no changes yet, so it is empty')
          const label = el.querySelector('span')
          if (label) { label.textContent = copied ? 'Copied' : 'Not copied'; ctx.after(1400, () => { label.textContent = 'Copy as CSS' }) }
        })()
      },
    }
    const reset: Row = {
      key: 'style.reset', ref: 'set.style.reset', group: 'Keep and share', label: 'Reset everything', type: 'custom',
      gloss: 'Back to Poise’s own style, every row at once. Undo stays for eight seconds.',
      control: () => '<button type="button" class="btn-ghost" data-act="reset-all" data-ref="set.style.reset">Reset everything</button>',
      act: (act, el) => {
        if (act === 'reset-all') {
          if (!el.classList.contains('is-armed')) { el.classList.add('is-armed'); el.textContent = 'Sure?'; ctx.after(3000, () => { if (el.isConnected) { el.classList.remove('is-armed'); el.textContent = 'Reset everything' } }); return }
          styleBefore = savedStyle()
          restore({})
          ctx.rows.rerow('style.reset')
          ctx.rows.paintAll()
          ctx.rows.lstat(reset, `<span class="sdot is-saved"></span>Back to Poise ${clock()} · applies now · <button type="button" class="lnk" data-act="reset-undo" data-ref="set.undo">Undo</button>`)
          ctx.after(UNDO_MS, () => { if (styleBefore) { styleBefore = null; ctx.rows.lstat(reset, `Back to Poise ${clock()}`) } })
        }
        if (act === 'reset-undo' && styleBefore) { restore(styleBefore); styleBefore = null; ctx.rows.paintAll(); ctx.rows.lstat(reset, 'Your style is back') }
      },
    }
    return [
      preset, typeface, at('size'), at('leading'), at('density'), at('corners'), at('lines'), motion,
      at('measure'), at('heading'), at('paragraph'), at('tints'),
      palette(ctx, 'colours', 'Meaning colours', 'One colour per state word, then information and Poise acting on its own. Idle has no colour: it is hollow. Chips, routes and tints follow.', MEANINGS, false),
      palette(ctx, 'neutrals', 'Neutrals', 'The dark stack every surface and text is made from. Contrast follows these, so change them with care.', NEUTRALS, true),
      copy, reset,
    ]
  },
}
