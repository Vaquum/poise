// A classic view embedded in Settings lives for the page's life (#556): its
// element is made once, moved into its section when shown, and kept hidden off
// the page when left, as Chat and the Editor keep theirs. Its module's own
// state and listeners are made once, as in classic.
let keep: HTMLElement | null = null
const views = new Map<string, HTMLElement>()

/** The view's element, and whether it was just made. */
export function keptView(id: string, tag = 'section', className = 'view'): { el: HTMLElement, fresh: boolean } {
  let el = views.get(id)
  if (el) return { el, fresh: false }
  el = document.createElement(tag)
  if (id) el.id = id
  el.className = className
  views.set(id, el)
  return { el, fresh: true }
}

/** Moves a view off the page, kept for its next showing. */
export function putAway(el: HTMLElement): void {
  if (!keep) {
    keep = Object.assign(document.createElement('div'), { hidden: true })
    keep.dataset.settingsKeep = ''
    document.body.append(keep)
  }
  keep.append(el)
}
