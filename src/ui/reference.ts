// Tooltips appear after --dur-tip on pointer rest or keyboard focus.
// The universal reference, from the mocks' reference.js, has two depths:
//  · a tooltip with a link to the full reference, also available by long-press;
//  · the full reference: the page dims, the element stays lit and wired to a
//    card that answers the brief's questions, without covering it.
// Opening or closing never activates the element; closing restores focus and scroll.
import { reveal } from '../motion'
import { durationMs } from './css-duration'
import { esc } from './dom'
import { entry, term, type RefEntry, type RefText } from './registry'

const root = document.documentElement
const token = (name: string, fallback: number): number => parseFloat(getComputedStyle(root).getPropertyValue(name)) || fallback
const duration = (name: string, fallback: number): number => durationMs(getComputedStyle(root).getPropertyValue(name), fallback)
const defFor = (el: Element | null | undefined): RefEntry | undefined => entry(el?.getAttribute('data-ref') ?? undefined)
// A value read from a live element; an element out of its usual place reads as unknown, not as an error.
const call = (v: RefText | undefined, el: HTMLElement): string => { try { return (typeof v === 'function' ? v(el) : v) ?? '' } catch { return '' } }
const short = (d: RefEntry): string => d.short || (d.what || '').split(/(?<=\.)\s/)[0]

let tip: HTMLElement | null = null
let tipFor: HTMLElement | null = null
let pendingFor: HTMLElement | null = null
let showTimer = 0, hideTimer = 0, touchTimer = 0
const tipObserver = new MutationObserver(() => {
  if (tipFor && !canShowTip(tipFor)) hideTip()
})
let suppressClick = false
/** The element last pressed: it shows no tooltip again until the pointer leaves it. */
let pressed: HTMLElement | null = null
/** The page behind the open reference, made inert while it is open. */
let inerted: HTMLElement[] = []
let layer: HTMLElement | null = null
let layerFor: HTMLElement | null = null
let layerKey = ''
let layerObserver: MutationObserver | null = null
let lastFocus: HTMLElement | null = null
let savedScroll: [Element | null, number][] = []

/** Words on screen come from the registry: <span data-term="state.running">. */
export function paintTerms(scope: ParentNode = document): void {
  scope.querySelectorAll<HTMLElement>('[data-term]').forEach((n) => { n.textContent = term(n.dataset.term ?? '') })
}

// ---------- Tooltip ----------
function placeNear(box: HTMLElement, el: HTMLElement): void {
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect(), gap = token('--sp-2', 8)
  // In a vertical list (Settings' sections) a tip below would cover the next item: beside it instead.
  if (el.closest('[data-tip-side="right"]') && r.right + gap + b.width <= innerWidth - gap) {
    box.style.top = `${Math.max(gap, Math.min(r.top + r.height / 2 - b.height / 2, innerHeight - b.height - gap))}px`
    box.style.left = `${r.right + gap}px`
    return
  }
  let top = r.bottom + gap
  if (top + b.height > innerHeight - gap) top = r.top - b.height - gap
  let left = r.left + r.width / 2 - b.width / 2
  left = Math.max(gap, Math.min(left, innerWidth - b.width - gap))
  box.style.top = `${Math.max(gap, top)}px`
  box.style.left = `${left}px`
}

function canShowTip(el: Element): boolean {
  return el.isConnected && !el.closest('[hidden], [inert], dialog:not([open]), [popover]:not(:popover-open)')
}

function showTip(el: HTMLElement): void {
  if (layer || !canShowTip(el)) return
  const d = defFor(el)
  const help = el.dataset.help?.trim()
  const label = !d && !help && el.hasAttribute('data-tooltip')
    ? (el.dataset.tooltip || el.getAttribute('aria-label') || '').replace(/[.…]+$/g, '').trim().split(/\s+/).slice(0, 2).join(' ')
    : ''
  if (!d && !help && !label) return
  hideTip()
  tip = document.createElement('div')
  tip.className = d ? 'tip' : help ? 'icon-tooltip context-tooltip' : 'icon-tooltip'
  tip.id = 'poise-tip'
  tip.setAttribute('role', 'tooltip')
  if (d) {
    const summary = call(d.tip, el) || short(d)
    tip.innerHTML = `<div class="tip-name">${esc(d.name)}${d.kind ? ` <span class="t-micro">${esc(d.kind)}</span>` : ''}</div>
      <p class="tip-text">${esc(summary)}</p>${help && help !== summary ? `<p class="tip-text">${esc(help)}</p>` : ''}
      <div class="tip-foot"><button class="tip-link" data-ref-open>Full reference →</button><span class="kbd">?</span></div>`
    tip.addEventListener('pointerenter', () => clearTimeout(hideTimer))
    tip.addEventListener('pointerleave', scheduleHide)
    tip.querySelector('[data-ref-open]')?.addEventListener('click', (e) => { e.stopPropagation(); openRef(el) })
  } else {
    tip.textContent = help || label || ''
  }
  // Keep viewport positioning and paint above a native dialog or popover.
  const container = el.closest('dialog[open], [popover]:popover-open')
  if (container) {
    tip.popover = 'manual'
    container.appendChild(tip)
    tip.showPopover()
  } else document.body.appendChild(tip)
  placeNear(tip, el)
  if (label) reveal(tip, { distance: 8 })
  tipFor = el
  el.setAttribute('aria-describedby', [el.getAttribute('aria-describedby'), tip.id].filter(Boolean).join(' '))
  tipObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'open'] })
}

function hideTip(): void {
  clearTimeout(hideTimer)
  if (!tip) return
  tipObserver.disconnect()
  if (tipFor) {
    const descriptions = (tipFor.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== 'poise-tip')
    if (descriptions.length) tipFor.setAttribute('aria-describedby', descriptions.join(' '))
    else tipFor.removeAttribute('aria-describedby')
  }
  tip.remove()
  tip = null
  tipFor = null
}
function scheduleHide(): void {
  if (!tip?.classList.contains('tip')) { hideTip(); return }
  clearTimeout(hideTimer)
  hideTimer = window.setTimeout(hideTip, duration('--dur-tip-hide', 160))
}
function cancelShow(): void {
  if (!pendingFor) return
  clearTimeout(showTimer)
  pendingFor = null
}

const refOf = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>('[data-ref]') : null)
const tipOf = (target: EventTarget | null): HTMLElement | null => (
  target instanceof Element ? target.closest<HTMLElement>('[data-ref], [data-help]:not([data-help=""]), [data-tooltip]') : null
)
// A press often redraws what was pressed: its successor, the same key and words, stays quiet too.
const isPressed = (el: HTMLElement): boolean => !!pressed && (el === pressed
  || (!!el.dataset.ref && !pressed.isConnected && el.dataset.ref === pressed.dataset.ref && el.textContent === pressed.textContent))
const inTip = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('.tip')

// ---------- Full reference ----------
const QUESTIONS: [keyof RefEntry, string][] = [
  ['what', 'What is this?'], ['does', 'What it does or shows'], ['now', 'What the current value means'],
  ['values', 'Other possible values'], ['scope', 'What it affects'], ['when', 'When a change takes effect'],
  ['unchanged', 'What stays unchanged'], ['shows', 'How the result shows'], ['source', 'Where the information comes from'],
  ['unavailable', 'Why it is unavailable'],
]
const disabled = (el: HTMLElement): boolean => el.matches('[disabled], [aria-disabled="true"]') || !!el.closest('[aria-disabled="true"]')

function answer(key: keyof RefEntry, d: RefEntry, el: HTMLElement): string {
  if (key === 'now') {
    const v = call(d.now, el)
    return v ? `<span class="now">${esc(v)}</span>` : ''
  }
  if (key === 'unavailable') return disabled(el) ? esc(call(d.unavailable, el) || 'Not available right now.') : ''
  if (key === 'values') {
    let v: [string, string][] = []
    try { v = (typeof d.values === 'function' ? d.values(el) : d.values) ?? [] } catch { v = [] }
    return v.length ? `<ul>${v.map(([k, m]) => `<li><b>${esc(k)}</b><span>${esc(m)}</span></li>`).join('')}</ul>` : ''
  }
  const v = call(d[key] as RefText | undefined, el)
  return v ? esc(v) : ''
}

export function openRef(el: HTMLElement): void {
  const d = defFor(el)
  if (!d) return
  cancelShow()
  hideTip()
  const active = document.activeElement
  lastFocus = active instanceof HTMLElement && active !== document.body ? active : el
  const scroller = document.scrollingElement
  savedScroll = [[scroller, scroller?.scrollTop ?? 0], ...[...document.querySelectorAll('.scroll, .list-scroll, .pane-scroll')].map((s): [Element, number] => [s, s.scrollTop])]
  layer = document.createElement('div')
  layer.className = 'ref-layer'
  const rows = QUESTIONS.map(([k, q]) => { const a = answer(k, d, el); return a ? `<dt>${q}</dt><dd>${a}</dd>` : '' }).join('')
  layer.innerHTML = `<svg class="ref-wire" aria-hidden="true"><path class="ref-dim" fill-rule="evenodd"/><line/><circle r="4"/><circle r="4"/></svg><div class="ref-spot"></div>
    <section class="ref-card" role="dialog" aria-modal="true" aria-labelledby="ref-title" tabindex="-1">
      <div class="ref-head"><div><span class="t-micro">${esc(d.kind || 'Reference')}</span><h3 id="ref-title">${esc(d.name)}</h3></div><button class="ib" data-ref-close aria-label="Close reference"><svg class="i"><use href="#i-cross"/></svg></button></div>
      ${d.tip && typeof d.tip === 'string' && d.tip !== d.what ? `<p class="ref-lede">${esc(d.tip)}</p>` : ''}
      <dl class="ref-qa">${rows}</dl>
      <p class="ref-foot"><span class="kbd">Esc</span> closes and returns you to ${esc(d.name)} <span class="t-mono">· ${esc(el.dataset.ref)}</span></p>
    </section>`
  document.body.appendChild(layer)
  // Modal: what is behind it cannot be reached until it closes.
  inerted = [...document.body.children].filter((n): n is HTMLElement => n instanceof HTMLElement && n !== layer && !n.inert)
  for (const n of inerted) n.inert = true
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  layerFor = el
  layerKey = el.dataset.ref ?? ''
  layout(el)
  layer.addEventListener('click', (e) => { const t = e.target as Element; if (t.closest('[data-ref-close]') || !t.closest('.ref-card')) closeRef() })
  layer.querySelector<HTMLElement>('.ref-card')?.focus()
  // Live places re-render: when the element is replaced, the spotlight follows its
  // successor, the one with the same key and words, or else the first with the key.
  const sig = el.textContent
  layerObserver = new MutationObserver(() => {
    if (!layer || !layerFor || layerFor.isConnected) return
    const all = [...document.querySelectorAll<HTMLElement>(`[data-ref="${CSS.escape(layerKey)}"]`)].filter((x) => !layer?.contains(x))
    const again = all.find((x) => x.textContent === sig) || all[0]
    if (again) { layerFor = again; layout(again) }
  })
  layerObserver.observe(document.body, { childList: true, subtree: true })
  addEventListener('resize', relayout)
  document.dispatchEvent(new CustomEvent('poise:ref', { detail: { open: true } }))
}

function relayout(): void { if (layerFor) layout(layerFor) }

function layout(el: HTMLElement): void {
  if (!layer) return
  const r = el.getBoundingClientRect()
  const pad = token('--sp-1', 4)
  const spot = layer.querySelector<HTMLElement>('.ref-spot')!
  Object.assign(spot.style, { top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` })
  // The page dims everywhere except a rounded hole around the element.
  const hx = r.left - pad, hy = r.top - pad, hw = r.width + pad * 2, hh = r.height + pad * 2, rr = Math.min(token('--r-panel', 8), hw / 2, hh / 2)
  layer.querySelector('.ref-dim')?.setAttribute('d', `M0 0H${innerWidth}V${innerHeight}H0Z M${hx + rr} ${hy}H${hx + hw - rr}A${rr} ${rr} 0 0 1 ${hx + hw} ${hy + rr}V${hy + hh - rr}A${rr} ${rr} 0 0 1 ${hx + hw - rr} ${hy + hh}H${hx + rr}A${rr} ${rr} 0 0 1 ${hx} ${hy + hh - rr}V${hy + rr}A${rr} ${rr} 0 0 1 ${hx + rr} ${hy}Z`)
  const card = layer.querySelector<HTMLElement>('.ref-card')!
  card.style.maxHeight = ''
  const m = token('--sp-6', 24), cw = card.offsetWidth
  let ch = card.offsetHeight
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
  // Centre first. If that would cover the element, use a side where the card
  // fits, the one that keeps it closest to the centre; shrink it only if none does.
  let x = (innerWidth - cw) / 2, y = (innerHeight - ch) / 2
  const covers = (cx: number, cy: number, h: number) => !(cx + cw < r.left - m || cx > r.right + m || cy + h < r.top - m || cy > r.bottom + m)
  if (covers(x, y, ch)) {
    type Side = 'right' | 'left' | 'below' | 'above'
    const place = (side: Side, h: number): [number, number] => {
      const midY = clamp(r.top + r.height / 2 - h / 2, m, innerHeight - h - m), midX = clamp(r.left + r.width / 2 - cw / 2, m, innerWidth - cw - m)
      return { right: [r.right + m, midY], left: [r.left - m - cw, midY], below: [midX, r.bottom + m], above: [midX, r.top - m - h] }[side] as [number, number]
    }
    const rooms: { side: Side, w: number, h: number }[] = [
      { side: 'right', w: innerWidth - r.right - m * 2, h: innerHeight - m * 2 },
      { side: 'left', w: r.left - m * 2, h: innerHeight - m * 2 },
      { side: 'below', w: innerWidth - m * 2, h: innerHeight - r.bottom - m * 2 },
      { side: 'above', w: innerWidth - m * 2, h: r.top - m * 2 },
    ]
    const dist = ([px, py]: [number, number], h: number) => Math.hypot(px + cw / 2 - innerWidth / 2, py + h / 2 - innerHeight / 2)
    const fits = rooms.filter((o) => o.w >= cw && o.h >= ch).sort((a, b) => dist(place(a.side, ch), ch) - dist(place(b.side, ch), ch))
    let pick: { side: Side, w: number, h: number } | undefined = fits[0]
    if (!pick) {
      pick = rooms.filter((o) => o.w >= cw).sort((a, b) => b.h - a.h)[0]
      if (pick && pick.h >= token('--sp-unit', 4) * 40) { ch = pick.h; card.style.maxHeight = `${ch}px` } else pick = undefined
    }
    if (pick) [x, y] = place(pick.side, ch)
  }
  card.style.left = `${clamp(x, m, innerWidth - cw - m)}px`
  card.style.top = `${clamp(y, m, innerHeight - ch - m)}px`
  // A wire from the element to the nearest point of the card.
  const c = card.getBoundingClientRect()
  const ex = Math.min(Math.max(c.left + c.width / 2, r.left), r.right), ey = Math.min(Math.max(c.top + c.height / 2, r.top), r.bottom)
  const cx = Math.min(Math.max(ex, c.left), c.right), cy = Math.min(Math.max(ey, c.top), c.bottom)
  const [line, a, b] = layer.querySelectorAll('.ref-wire line, .ref-wire circle')
  line.setAttribute('x1', String(ex)); line.setAttribute('y1', String(ey)); line.setAttribute('x2', String(cx)); line.setAttribute('y2', String(cy))
  a.setAttribute('cx', String(ex)); a.setAttribute('cy', String(ey)); b.setAttribute('cx', String(cx)); b.setAttribute('cy', String(cy))
}

export function closeRef(): void {
  cancelShow()
  hideTip()
  if (!layer) return
  removeEventListener('resize', relayout)
  layerObserver?.disconnect()
  layerObserver = null
  layer.remove()
  layer = null
  // A live update may have replaced the element: focus then returns to its successor.
  const successor = layerFor
  layerFor = null
  for (const n of inerted) n.inert = false
  inerted = []
  savedScroll.forEach(([s, t]) => { if (s) s.scrollTop = t })
  const back = lastFocus?.isConnected ? lastFocus : successor
  back?.focus({ preventScroll: true })
  document.dispatchEvent(new CustomEvent('poise:ref', { detail: { open: false } }))
}

export function referenceOpen(): boolean {
  return !!layer
}

/** Listens once for tooltips throughout the page, including newly rendered controls. */
export function installReference(): void {
  const delay = duration('--dur-tip', 500)
  function scheduleShow(el: HTMLElement): void {
    if (el === pendingFor) return
    clearTimeout(showTimer)
    pendingFor = el
    showTimer = window.setTimeout(() => { pendingFor = null; showTip(el) }, delay)
  }
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch' || layer) return
    if (inTip(e.target)) { cancelShow(); clearTimeout(hideTimer); return }
    const el = tipOf(e.target)
    if (!el || isPressed(el)) return
    if (el === tipFor) { cancelShow(); clearTimeout(hideTimer); return }
    if (tipFor?.contains(el)) scheduleHide()
    scheduleShow(el)
  })
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch' || !(pressed || pendingFor || tipFor)) return
    const el = tipOf(e.target)
    if (!el) return
    const to = e.relatedTarget
    if (to instanceof Node && (el.contains(to) || inTip(to))) return
    if (isPressed(el)) pressed = null
    cancelShow()
    if (tip) scheduleHide()
  })
  // Pressing is acting, not resting: it cancels a pending tooltip and hides a
  // shown one, and the pressed element stays quiet until the pointer leaves it.
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || layer || inTip(e.target)) return
    cancelShow()
    pressed = tipOf(e.target)
    if (tip) hideTip()
  }, true)
  document.addEventListener('focusin', (e) => {
    if (layer || inTip(e.target)) return
    const el = tipOf(e.target)
    // Keyboard focus only: focus moved by a script after a click, or by the press itself, is not a request for help.
    if (el && el !== tipFor && !isPressed(el) && (e.target as Element).matches(':focus-visible')) scheduleShow(el)
  })
  document.addEventListener('focusout', (e) => {
    if (inTip(e.relatedTarget)) return
    cancelShow()
    if (tip && !layer) scheduleHide()
  })
  // Touch: a long press shows the tooltip and does not activate the element.
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return
    const el = refOf(e.target)
    if (!el) return
    touchTimer = window.setTimeout(() => { suppressClick = true; showTip(el) }, delay)
  })
  // A long press released gives one click to swallow, at once; a cancelled one gives none.
  document.addEventListener('pointerup', () => { clearTimeout(touchTimer); if (suppressClick) window.setTimeout(() => { suppressClick = false }) })
  document.addEventListener('pointercancel', () => { clearTimeout(touchTimer); suppressClick = false })
  document.addEventListener('click', (e) => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false } }, true)
  document.addEventListener('keydown', (e) => {
    if (layer) {
      if (e.key === 'Escape') { e.preventDefault(); closeRef() }
      // Tab goes round the card's own controls.
      if (e.key === 'Tab') {
        const card = layer.querySelector<HTMLElement>('.ref-card')!
        const stops = [card, ...card.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        const at = stops.indexOf(document.activeElement as HTMLElement)
        e.preventDefault()
        stops[(at + (e.shiftKey ? stops.length - 1 : 1) + stops.length) % stops.length].focus()
      }
      return
    }
    if (e.key === 'Escape' && tip) { hideTip(); return }
    // Outside text fields only: a field, a select or an editable page takes the key as typing.
    const focused = document.activeElement as HTMLElement | null
    const typing = !!focused && (/input|textarea|select/i.test(focused.tagName) || focused.isContentEditable)
    if (e.key === '?' && !typing) {
      const el = refOf(tipFor) ?? refOf(focused)
      if (el && defFor(el)) { e.preventDefault(); openRef(el) }
    }
  })
  addEventListener('scroll', () => { cancelShow(); if (tip && !layer) hideTip() }, true)
  addEventListener('resize', () => { cancelShow(); hideTip() })
  // Typing is not resting: it cancels a pending tooltip and hides a shown one.
  // Any key also ends a press's quiet, so focus the keyboard moves next explains itself.
  document.addEventListener('keydown', (e) => { pressed = null; if (e.key !== '?' && !layer) cancelShow() }, true)
  document.addEventListener('input', () => { cancelShow(); if (tip && !layer) hideTip() })
}
