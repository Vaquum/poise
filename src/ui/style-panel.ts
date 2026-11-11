// The Style panel, from the mocks' style.js: a person's full control over the
// tokens. Every control writes a token on :root; saved choices apply on every
// place, and Settings → Style works on the same choices.
import { hydrateIcons } from './icons'

const KEY = 'poise-style'
const root = document.documentElement
type Saved = Record<string, string>
const read = (): Saved => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Saved } catch { return {} } }
const write = (o: Saved): void => { try { localStorage.setItem(KEY, JSON.stringify(o)) } catch { /* still applies for this visit */ } }
let saved: Saved = {}
const apply = (o: Saved): void => { for (const [k, v] of Object.entries(o)) root.style.setProperty(k, v) }

export interface Archetype { label: string, gloss: string, ui: string, display: string, mono: string }
export const ARCHETYPES: Record<string, Archetype> = {
  engineer: { label: 'Engineer', gloss: 'Plex, Zen Maru display', ui: 'IBM Plex Sans', display: 'Zen Maru Gothic', mono: 'IBM Plex Mono' },
  minimalist: { label: 'Minimalist', gloss: 'Manrope, Space Grotesk', ui: 'Manrope', display: 'Space Grotesk', mono: 'JetBrains Mono' },
  companion: { label: 'Companion', gloss: 'Nunito, Rubik', ui: 'Nunito', display: 'Rubik', mono: 'IBM Plex Mono' },
  editor: { label: 'Editor', gloss: 'Lato, Playfair Display', ui: 'Lato', display: 'Playfair Display', mono: 'IBM Plex Mono' },
  writer: { label: 'Writer', gloss: 'Lora throughout', ui: 'Lora', display: 'Lora', mono: 'IBM Plex Mono' },
  auteur: { label: 'Auteur', gloss: 'Work Sans, Syne', ui: 'Work Sans', display: 'Syne', mono: 'IBM Plex Mono' },
}
function loadFonts(a: Archetype): void {
  const families = [...new Set([a.ui, a.display, a.mono])].map((f) => `family=${f.replace(/ /g, '+')}:wght@400;600;700`).join('&')
  let link = document.getElementById('style-fonts') as HTMLLinkElement | null
  if (!link) { link = Object.assign(document.createElement('link'), { id: 'style-fonts', rel: 'stylesheet' }); document.head.appendChild(link) }
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`
}
const savedArchetype = (): Archetype | null => (saved['--archetype'] ? ARCHETYPES[saved['--archetype'].replace(/"/g, '')] ?? null : null)

export const PRESETS: Record<string, { label: string, gloss: string, values: Saved }> = {
  calm: { label: 'Calm', gloss: 'Poise default', values: { '--ctl-density': '1', '--ctl-base-size': '15px' } },
  compact: { label: 'Compact', gloss: 'more rows on screen', values: { '--ctl-density': '0.8', '--ctl-base-size': '14px' } },
  comfortable: { label: 'Comfortable', gloss: 'more air', values: { '--ctl-density': '1.2', '--ctl-base-size': '15px' } },
  large: { label: 'Large type', gloss: 'for long days', values: { '--ctl-density': '1.1', '--ctl-base-size': '17px' } },
}
// [token, label, hint, min, max, step, unit]
const SLIDERS: [string, string, string, number, number, number, string][] = [
  ['--ctl-base-size', 'Base size', 'scales all type and controls', 13, 18, 0.5, 'px'],
  ['--ctl-density', 'Density', 'space inside and between things', 0.75, 1.35, 0.05, '×'],
  ['--ctl-radius', 'Corners', 'square to round', 0, 2, 0.25, '×'],
  ['--ctl-line', 'Route lines', 'weight of lines and stations', 0.6, 1.6, 0.1, '×'],
  ['--ctl-tint', 'Status tints', 'how strongly a meaning colours its badge', 10, 35, 1, '%'],
]
// One colour per state word; Idle has none (it is hollow). Then information, and Poise acting on its own.
export const MEANINGS: [string, string, string][] = [
  ['--c-attention', 'Needs you', 'only you can move it on'], ['--c-running', 'Running', 'working now'],
  ['--c-other', 'Waiting', 'for checks or a slot; also the route'], ['--c-risk', 'Blocked', 'a prerequisite is missing'],
  ['--c-done', 'Done', 'finished, merged'], ['--c-failed', 'Failed', 'errors, and destructive actions'],
  ['--c-agent', 'Information', 'an agent, information, focus'], ['--c-special', 'Poise acting', 'the Manager, Poise changing itself'],
]
export const NEUTRALS: [string, string][] = [
  ['--p-n0', 'Canvas'], ['--p-n1', 'Surface'], ['--p-n2', 'Hairline'], ['--p-n3', 'Border'],
  ['--p-n4', 'Muted text'], ['--p-n5', 'Soft text'], ['--p-n6', 'Text'], ['--p-n7', 'Strongest'],
]
// Each control names its row in Settings → Style, which the registry explains.
const SLIDER_REF: Record<string, string> = { '--ctl-base-size': 'set.style.size', '--ctl-density': 'set.style.density', '--ctl-radius': 'set.style.corners', '--ctl-line': 'set.style.lines', '--ctl-tint': 'set.style.tints' }

export const styleToken = (prop: string): string => getComputedStyle(root).getPropertyValue(prop).trim()
export function toHex(colour: string): string {
  const probe = document.createElement('div')
  probe.style.color = colour
  document.body.appendChild(probe)
  const m = getComputedStyle(probe).color.match(/\d+/g)
  probe.remove()
  return m ? `#${m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : '#000000'
}

function set(prop: string, value: string): void { saved[prop] = value; root.style.setProperty(prop, value); write(saved); sync() }
function setMany(o: Saved): void { Object.assign(saved, o); apply(o); write(saved); sync() }
function unset(prop: string): void { delete saved[prop]; root.style.removeProperty(prop); write(saved); sync() }

/** Saved choices, applied before the first place paints. */
export function applySavedStyle(): void {
  saved = read()
  apply(saved)
  const a = savedArchetype()
  if (a) loadFonts(a)
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    for (const k of Object.keys(saved)) root.style.removeProperty(k)
    saved = read()
    apply(saved)
    sync()
  })
}

/** Settings → Style works on the same saved choices as this panel. */
export const css = (): string => `:root {\n${Object.entries(saved).filter(([k]) => k !== '--archetype').map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`
/** Poise's own value of a token: what it is with your choice set aside. */
export function defaultOf(prop: string): string {
  const mine = root.style.getPropertyValue(prop)
  if (mine) root.style.removeProperty(prop)
  const d = styleToken(prop)
  if (mine) root.style.setProperty(prop, mine)
  return d
}
export function restore(o: Saved): void {
  for (const k of Object.keys(saved)) root.style.removeProperty(k)
  saved = { ...o }
  apply(saved)
  write(saved)
  const a = savedArchetype()
  if (a) loadFonts(a)
  sync()
}
export function setArchetype(k: string): void {
  if (k === 'engineer') {
    for (const p of ['--archetype', '--ctl-font-ui', '--ctl-font-display', '--ctl-font-mono']) { delete saved[p]; root.style.removeProperty(p) }
    write(saved)
    sync()
    return
  }
  const a = ARCHETYPES[k]
  if (!a) return
  loadFonts(a)
  setMany({ '--archetype': `"${k}"`, '--ctl-font-ui': `"${a.ui}"`, '--ctl-font-display': `"${a.display}"`, '--ctl-font-mono': `"${a.mono}"` })
}
export const setStyle = (prop: string, value: string | null): void => (value == null ? unset(prop) : set(prop, value))
export const savedStyle = (): Saved => ({ ...saved })
export const archetype = (): string => (saved['--archetype'] || '"engineer"').replace(/"/g, '')

function build(settingsHref: string): HTMLElement {
  const panel = document.createElement('aside')
  panel.className = 'panel'
  panel.id = 'style-panel'
  panel.setAttribute('aria-label', 'Style')
  panel.innerHTML = `
    <div class="panel-h"><i data-i="palette"></i><h2>Style</h2><button class="ib" data-style-close aria-label="Close style" data-ref="style.close"><i data-i="cross"></i></button></div>
    <div class="panel-b">
      <p class="t-gloss">The same settings as <a class="lnk" href="${settingsHref}" data-style-settings data-ref="style.settings">Settings → Style</a>, which also has the writing ones.</p>
      <div class="panel-sec"><span class="t-micro">Presets</span><span class="t-gloss">a starting point; everything below stays adjustable</span></div>
      <div class="choices" data-group="preset">${Object.entries(PRESETS).map(([k, p]) => `<button class="choice" data-preset="${k}" data-ref="set.style.preset"><b>${p.label}</b><span>${p.gloss}</span></button>`).join('')}</div>
      <div class="panel-sec"><span class="t-micro">Type</span><span class="t-gloss">interface, display and code faces together</span></div>
      <div class="choices" data-group="type">${Object.entries(ARCHETYPES).map(([k, a]) => `<button class="choice" data-arch="${k}" data-ref="set.style.type"><b>${a.label}</b><span>${a.gloss}</span></button>`).join('')}</div>
      <div class="panel-sec"><span class="t-micro">Scale and shape</span></div>
      ${SLIDERS.map(([p, l, h, min, max, step]) => `<div class="field"><label for="f${p}" data-ref="${SLIDER_REF[p]}">${l}</label><output data-out="${p}"></output><input id="f${p}" type="range" min="${min}" max="${max}" step="${step}" data-slider="${p}" data-ref="${SLIDER_REF[p]}"><span class="hint">${h}</span></div>`).join('')}
      <div class="field"><label data-ref="set.style.motion">Motion</label><button class="ib" data-motion aria-label="Motion" data-ref="set.style.motion"><span class="switch"></span></button><span class="hint">the Tactile spring; off keeps everything still</span></div>
      <div class="panel-sec"><span class="t-micro">Meaning colours</span><span class="t-gloss">each colour is one meaning; badges, lines and tints follow</span></div>
      ${MEANINGS.map(([p, l, h]) => `<div class="field"><label for="c${p}" data-ref="set.style.colours">${l}</label><input id="c${p}" type="color" data-color="${p}" data-ref="set.style.colour"><span class="hint">${h}</span></div>`).join('')}
      <details class="panel-sec"><summary class="t-micro" data-ref="set.style.neutrals">Neutrals</summary><span class="t-gloss">the dark stack every surface is made from</span>
      ${NEUTRALS.map(([p, l]) => `<div class="field"><label for="n${p}" data-ref="set.style.neutrals">${l}</label><input id="n${p}" type="color" data-color="${p}" data-ref="set.style.colour"></div>`).join('')}</details>
    </div>
    <div class="panel-f"><button class="btn btn-line" data-style-reset data-ref="set.style.reset">Reset to Poise</button><button class="btn btn-line" data-style-copy data-ref="set.style.copy">Copy as CSS</button></div>`
  document.body.appendChild(panel)
  hydrateIcons(panel)
  panel.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement
    if (t.dataset.slider) {
      const unit = SLIDERS.find((s) => s[0] === t.dataset.slider)?.[6]
      set(t.dataset.slider, unit === 'px' || unit === '%' ? `${t.value}${unit}` : t.value)
    }
    if (t.dataset.color) set(t.dataset.color, t.value)
  })
  panel.addEventListener('click', (e) => {
    const t = (e.target as Element).closest<HTMLElement>('button, a')
    if (!t) return
    if (t.dataset.preset) setMany(PRESETS[t.dataset.preset].values)
    if (t.dataset.arch) setArchetype(t.dataset.arch)
    if (t.hasAttribute('data-motion')) set('--ctl-motion', styleToken('--ctl-motion') === '0' ? '1' : '0')
    if (t.hasAttribute('data-style-reset')) { for (const k of Object.keys(saved)) root.style.removeProperty(k); saved = {}; write(saved); sync() }
    if (t.hasAttribute('data-style-copy')) { void navigator.clipboard?.writeText(css()); t.textContent = 'Copied'; setTimeout(() => { t.textContent = 'Copy as CSS' }, 1400) }
    if (t.hasAttribute('data-style-close')) toggleStylePanel(false)
    if (t.hasAttribute('data-style-settings')) toggleStylePanel(false)
  })
  return panel
}

function sync(): void {
  document.dispatchEvent(new CustomEvent('poise:style'))
  const panel = document.getElementById('style-panel')
  if (!panel) return
  for (const [p, , , , , , unit] of SLIDERS) {
    const v = parseFloat(styleToken(p))
    const input = panel.querySelector<HTMLInputElement>(`[data-slider="${p}"]`)
    if (input && document.activeElement !== input) input.value = String(v)
    const out = panel.querySelector(`[data-out="${p}"]`)
    if (out) out.textContent = unit === '×' ? `${v.toFixed(2)}×` : `${v}${unit}`
  }
  panel.querySelectorAll<HTMLInputElement>('[data-color]').forEach((i) => { if (document.activeElement !== i) i.value = toHex(styleToken(i.dataset.color ?? '')) })
  panel.querySelector('[data-motion]')?.setAttribute('aria-pressed', String(styleToken('--ctl-motion') !== '0'))
  const arch = archetype()
  panel.querySelectorAll<HTMLElement>('[data-arch]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.arch === arch)))
  const preset = Object.entries(PRESETS).find(([, p]) => Object.entries(p.values).every(([k, v]) => styleToken(k) === v))
  panel.querySelectorAll<HTMLElement>('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(!!preset && b.dataset.preset === preset[0])))
}

export function toggleStylePanel(force?: boolean): void {
  const panel = document.getElementById('style-panel')
  if (!panel) return
  const on = panel.classList.toggle('open', force)
  document.querySelectorAll('[data-style-open]').forEach((b) => b.setAttribute('aria-pressed', String(on)))
}

/** Points the panel's Settings → Style link at the place it is open over. */
export function styleSettingsHref(href: string): void {
  document.querySelector<HTMLAnchorElement>('#style-panel [data-style-settings]')?.setAttribute('href', href)
}

export function installStylePanel(settingsHref: string): void {
  build(settingsHref)
  sync()
  document.addEventListener('click', (e) => { if ((e.target as Element).closest('[data-style-open]')) toggleStylePanel() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleStylePanel(false) })
}
