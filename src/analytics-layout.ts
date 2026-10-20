import { patchContent } from './dom-patch'
import { cancelMotion, finishMotion, spring } from './motion'

const STORAGE_KEY = 'poise-analytics-card-order'
const GAP = 12
interface Box { x: number, y: number, width: number, height: number }
interface Card { id: string, element: HTMLElement, span: number, height: number, x: number, y: number }
interface Move {
  card: Card, original: string[], pointer: number | null, active: boolean,
  startX: number, startY: number, offsetX: number, offsetY: number, clientX: number, clientY: number,
}

export function reconcileCardOrder(saved: string[], available: string[]): string[] {
  const known = new Set(available)
  return [...new Set([...saved.filter(id => known.has(id)), ...available])]
}

/** Row packing keeps semantic order, including when different card sizes meet. */
export function cardPositions(cards: Pick<Card, 'id' | 'span' | 'height'>[], width: number): Map<string, Box> {
  const boxes = new Map<string, Box>()
  const unit = (width + GAP) / 20
  let column = 0, y = 0, rowHeight = 0
  for (const card of cards) {
    if (column + card.span > 20) { column = 0; y += rowHeight + GAP; rowHeight = 0 }
    boxes.set(card.id, { x: column * unit, y, width: card.span * unit - GAP, height: card.height })
    column += card.span
    rowHeight = Math.max(rowHeight, card.height)
  }
  return boxes
}

/** Stable boundaries distinguish insertion orders even when the held card wraps to the same box. */
export function cardInsertion(cards: Pick<Card, 'id' | 'span' | 'height'>[], width: number, x: number, y: number, current: number): number {
  if (!cards.length) return 0
  const positions = cardPositions(cards, width), costs = Array<number>(cards.length + 1).fill(Infinity)
  const anchor = (index: number, ax: number, ay: number) => { costs[index] = Math.min(costs[index], Math.hypot(x - ax, y - ay)) }
  cards.forEach((card, index) => {
    const box = positions.get(card.id)!
    anchor(index, box.x - GAP / 2, box.y + 20)
    anchor(index + 1, box.x + box.width + GAP / 2, box.y + 20)
    if (card.span === 20) {
      anchor(index, box.x + box.width / 2, box.y - GAP / 2)
      anchor(index + 1, box.x + box.width / 2, box.y + box.height + GAP / 2)
    }
  })
  let best = current
  for (let index = 0; index < costs.length; index++) if (costs[index] < costs[best]) best = index
  return costs[best] + 24 < costs[current] ? best : current
}

export function cardRowInsertion(cards: Pick<Card, 'id' | 'span' | 'height'>[], width: number, id: string, direction: -1 | 1): number {
  const current = cards.findIndex(card => card.id === id), held = cards[current]
  if (!held) throw new Error(`Analytics card ${id} is unavailable.`)
  const origin = cardPositions(cards, width).get(id)!, rest = cards.filter(card => card.id !== id)
  let best = current, distance = Infinity, alignment = Infinity
  for (let index = 0; index <= rest.length; index++) {
    const candidate = [...rest]; candidate.splice(index, 0, held)
    const box = cardPositions(candidate, width).get(id)!
    const dy = (box.y - origin.y) * direction
    const dx = Math.abs(box.x + box.width / 2 - origin.x - origin.width / 2)
    if (dy > .5 && (dy < distance - .5 || Math.abs(dy - distance) < .5 && dx < alignment)) {
      best = index; distance = dy; alignment = dx
    }
  }
  return best
}

export function analyticsLayout(board: HTMLElement, status: HTMLElement, onPatch?: () => void) {
  let saved: string[] = []
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(raw) || !raw.every(id => typeof id === 'string')) throw new Error('Expected a list of card IDs.')
    saved = [...new Set(raw)]
  } catch (error) { status.classList.remove('analytics-sr'); status.textContent = `Saved analytics layout could not be read: ${String(error)}` }
  let cards = new Map<string, Card>(), order: string[] = [], width = 0
  let move: Move | null = null, pending: string | null = null, resizeFrame = 0, scrollFrame = 0
  const placeholder = document.createElement('div')
  placeholder.className = 'analytics-drop-slot'
  placeholder.setAttribute('aria-hidden', 'true')
  placeholder.hidden = true
  // The slot lives outside the keyed content patched by live reads.
  board.parentElement!.append(placeholder)
  let boxes = new Map<string, Box>()
  const announce = (message: string) => { status.textContent = message }
  const draw = (card: Card) => { card.element.style.transform = `translate3d(${card.x}px, ${card.y}px, 0)` }
  const positions = (ids: string[]) => cardPositions(ids.map(id => cards.get(id)!), width)

  function arrange(immediate = false): void {
    boxes = positions(order)
    board.style.height = `${Math.max(0, ...[...boxes.values()].map(box => box.y + box.height))}px`
    for (const id of order) {
      const card = cards.get(id)!, box = boxes.get(id)!
      if (move?.card === card && move.active && move.pointer !== null) continue
      if (immediate) {
        cancelMotion(card.element, 'analytics-layout'); card.x = box.x; card.y = box.y; draw(card)
        if (move?.card !== card) card.element.classList.remove('analytics-card-held')
      } else spring(card.element, 'analytics-layout', {
        from: { x: card.x, y: card.y }, to: { x: box.x, y: box.y },
        write: ({ x, y }) => { card.x = x; card.y = y; draw(card) },
        complete: () => { if (move?.card !== card) card.element.classList.remove('analytics-card-held') },
      })
    }
    if (move?.active) {
      const box = boxes.get(move.card.id)!
      Object.assign(placeholder.style, { left: `${board.offsetLeft + box.x}px`, top: `${board.offsetTop + box.y}px`, width: `${box.width}px`, height: `${box.height}px` })
    }
  }

  function measure(): void {
    width = board.clientWidth
    const unit = (width + GAP) / 20
    for (const card of cards.values()) {
      const kind = card.element.dataset.group
      card.span = width < 450 ? 20 : width < 880 ? (kind === 'quota' || card.element.classList.contains('analytics-work-panel') ? 20 : 10)
        : kind === 'quota' || card.element.classList.contains('analytics-work-panel') ? 10 : kind === 'per-merged-pr' ? 4 : 5
      card.element.style.width = `${card.span * unit - GAP}px`
      card.element.style.height = ''
    }
    const heights = new Map<string, number>()
    for (const card of cards.values()) {
      const family = card.element.dataset.size!
      heights.set(family, Math.max(heights.get(family) ?? 0, card.element.scrollHeight, card.element.offsetHeight, Number(card.element.dataset.placeholderHeight ?? 0)))
    }
    const clearance = 5 * parseFloat(getComputedStyle(document.documentElement).fontSize)
    heights.set('tall', Math.max(heights.get('tall') ?? 0, (heights.get('short') ?? 0) + clearance))
    for (const card of cards.values()) {
      card.height = heights.get(card.element.dataset.size!)!
      card.element.style.height = `${card.height}px`
    }
  }

  function patch(markup: string, animate = false): void {
    if (move) { pending = markup; return }
    animate ||= !!board.querySelector('[data-motion-running]')
    const template = document.createElement('template')
    template.innerHTML = markup
    const nodes = new Map([...template.content.children].map(element => [element.getAttribute('data-id')!, element]))
    order = reconcileCardOrder(saved, [...nodes.keys()])
    for (const id of order) template.content.append(nodes.get(id)!)
    patchContent(board, template.innerHTML)
    const next = new Map<string, Card>()
    for (const element of board.querySelectorAll<HTMLElement>(':scope > [data-id]')) {
      const id = element.dataset.id!
      next.set(id, { id, element, span: 0, height: 0, x: cards.get(id)?.x ?? 0, y: cards.get(id)?.y ?? 0 })
    }
    cards = next
    measure(); arrange(!animate)
    onPatch?.()
  }

  function finish(cancel = false): void {
    if (!move) return
    const previous = move, active = previous.active
    if (cancel) order = [...previous.original]
    move = null; cancelAnimationFrame(scrollFrame)
    placeholder.hidden = true
    const handle = previous.card.element.querySelector('button')
    handle?.setAttribute('aria-pressed', 'false')
    if (previous.pointer !== null && handle?.hasPointerCapture(previous.pointer)) handle.releasePointerCapture(previous.pointer)
    const focused = document.activeElement
    for (const id of order) board.append(cards.get(id)!.element)
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
    arrange()
    if (active) {
      let failure: string | null = null
      if (!cancel) {
        // Missing account IDs remain saved, so temporary credential failures do not reset their place.
        const visible = new Set(order)
        const remaining = [...order]
        saved = [...saved.map(id => visible.has(id) ? remaining.shift()! : id), ...remaining]
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)) }
        catch (error) { status.classList.remove('analytics-sr'); failure = `Analytics layout could not be saved: ${String(error)}` }
      }
      announce(failure ?? (cancel ? 'Card move cancelled.' : `${previous.card.element.dataset.label} placed, position ${order.indexOf(previous.card.id) + 1} of ${order.length}.`))
    }
    if (pending !== null) { const markup = pending; pending = null; patch(markup, true) }
  }

  function begin(): void {
    if (!move) return
    move.active = true
    cancelMotion(move.card.element, 'analytics-layout')
    move.card.element.classList.add('analytics-card-held')
    move.card.element.querySelector('button')!.setAttribute('aria-pressed', 'true')
    placeholder.hidden = false
    announce(`Picked up ${move.card.element.dataset.label}. Arrow keys move, Space drops, Escape cancels.`)
    arrange()
  }

  function moveTo(index: number): void {
    if (!move || index === order.indexOf(move.card.id)) return
    order.splice(order.indexOf(move.card.id), 1); order.splice(index, 0, move.card.id)
    arrange()
  }

  function track(): void {
    if (!move?.active || move.pointer === null) return
    const card = move.card, rect = board.getBoundingClientRect()
    card.x = Math.max(0, Math.min(width - card.element.offsetWidth, move.clientX - rect.left - move.offsetX))
    card.y = Math.max(0, Math.min(board.offsetHeight - card.height, move.clientY - rect.top - move.offsetY))
    draw(card)
    const rest = order.filter(id => id !== card.id).map(id => cards.get(id)!)
    moveTo(cardInsertion(rest, width, move.clientX - rect.left, move.clientY - rect.top, order.indexOf(card.id)))
  }

  function autoScroll(): void {
    if (!move?.active || move.pointer === null) return
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-bar-h')) || 100
    const delta = move.clientY < top + 40 ? -12 : move.clientY > innerHeight - 48 ? 12 : 0
    if (delta) { window.scrollBy(0, delta); track() }
    scrollFrame = requestAnimationFrame(autoScroll)
  }

  board.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || move || board.hasAttribute('aria-busy')) return
    const handle = (event.target as Element).closest<HTMLButtonElement>('.analytics-drag-handle')
    if (!handle) return
    const card = cards.get(handle.closest<HTMLElement>('[data-id]')!.dataset.id!)!
    const rect = card.element.getBoundingClientRect()
    move = { card, original: [...order], pointer: event.pointerId, active: false, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, clientX: event.clientX, clientY: event.clientY }
    handle.setPointerCapture(event.pointerId)
  })
  board.addEventListener('pointermove', event => {
    if (!move || event.pointerId !== move.pointer) return
    move.clientX = event.clientX; move.clientY = event.clientY
    if (!move.active) {
      if (Math.hypot(event.clientX - move.startX, event.clientY - move.startY) < 5) return
      begin(); scrollFrame = requestAnimationFrame(autoScroll)
    }
    event.preventDefault(); track()
  })
  board.addEventListener('pointerup', event => { if (move?.pointer === event.pointerId) finish() })
  for (const type of ['pointercancel', 'lostpointercapture']) board.addEventListener(type, event => {
    if (move?.pointer === (event as PointerEvent).pointerId) finish(true)
  })
  board.addEventListener('keydown', event => {
    if (event.key === 'Escape' && move) { event.preventDefault(); finish(true); return }
    const handle = (event.target as Element).closest<HTMLButtonElement>('.analytics-drag-handle')
    if (!handle || board.hasAttribute('aria-busy')) return
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      if (move) { finish(); return }
      const card = cards.get(handle.closest<HTMLElement>('[data-id]')!.dataset.id!)!
      move = { card, original: [...order], pointer: null, active: true, startX: 0, startY: 0, offsetX: 0, offsetY: 0, clientX: 0, clientY: 0 }
      begin()
    } else if (move?.pointer === null && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const index = order.indexOf(move.card.id)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1
        : event.key === 'ArrowUp' || event.key === 'ArrowDown' ? cardRowInsertion(order.map(id => cards.get(id)!), width, move.card.id, event.key === 'ArrowUp' ? -1 : 1)
          : index + (event.key === 'ArrowLeft' ? -1 : 1)
      moveTo(Math.max(0, Math.min(order.length - 1, next)))
      announce(`${move.card.element.dataset.label}, position ${order.indexOf(move.card.id) + 1} of ${order.length}.`)
    }
  })
  window.addEventListener('scroll', track, { passive: true })
  window.addEventListener('blur', () => finish(true))
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(true) })
  window.addEventListener('beforeprint', () => { finish(true); finishMotion(board) })
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => { if (board.clientWidth && board.clientWidth !== width) { finish(true); measure(); arrange(true) } })
  }).observe(board)
  const typography = () => ['--typo-body', '--typo-heading', '--typo-size', '--typo-lh'].map(name => document.documentElement.style.getPropertyValue(name)).join('|')
  let lastTypography = typography()
  const refit = () => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => { if (board.clientWidth) { finish(true); measure(); arrange(true) } })
  }
  window.addEventListener('resize', () => { finish(true); refit() })
  new MutationObserver(() => {
    const next = typography()
    if (next !== lastTypography) { lastTypography = next; refit() }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  document.fonts.addEventListener('loadingdone', refit)
  return { patch, cancel: () => finish(true) }
}
