import { layout, retire } from './motion'
/** Preserve semantic actors, focused controls, native disclosure and draft state. */
function identity(node: Node): string | null {
  if (!(node instanceof Element)) return null
  const key = ['id', 'data-id', 'data-key', 'data-identity', 'data-request-id', 'data-request', 'data-queue-item', 'data-device', 'data-account', 'data-handle', 'data-org', 'data-jev-id', 'data-trigger', 'data-slug', 'data-behavior', 'data-place', 'data-q', 'data-option', 'data-level', 'data-field', 'data-action', 'data-expand-for', 'data-refusal-for'].find(name => node.hasAttribute(name))
  return key ? `${node.nodeName}:${key}:${node.getAttribute(key)}` : null
}

export function patchNode(current: Node, next: Node, onRemove?: (element: HTMLElement) => void): void {
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
    current.parentNode?.replaceChild(next.cloneNode(true), current)
    return
  }
  if (current instanceof Element && next instanceof Element) {
    const motionStyles = current instanceof HTMLElement && current.hasAttribute('data-motion-running')
      ? [...current.style].filter(name => name.startsWith('--flow-') || ['opacity', 'height', 'width', 'max-width', 'padding-top', 'padding-bottom', 'overflow', 'translate', 'transform'].includes(name)).map(name => [name, current.style.getPropertyValue(name)] as const) : []
    const protectedAttribute = (name: string) => name.startsWith('data-flow-') || name === 'data-motion-running'
      || current.hasAttribute('data-flow-retained') && (name === 'hidden' || name === 'inert')
      || current instanceof HTMLDetailsElement && name === 'open'
    for (const attr of [...current.attributes]) if (!protectedAttribute(attr.name) && !next.hasAttribute(attr.name)) current.removeAttribute(attr.name)
    for (const attr of [...next.attributes]) if (!protectedAttribute(attr.name) && current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value)
    if (current instanceof HTMLElement) for (const [name, value] of motionStyles) current.style.setProperty(name, value)
  } else if (current.nodeValue !== next.nodeValue) {
    const selection = window.getSelection()
    const anchor = selection?.anchorNode, focus = selection?.focusNode
    const selected = selection && !selection.isCollapsed && (anchor === current || focus === current)
    const anchorOffset = selection?.anchorOffset ?? 0, focusOffset = selection?.focusOffset ?? 0
    current.nodeValue = next.nodeValue
    if (selected && anchor && focus) {
      const length = current.nodeValue?.length ?? 0
      selection.setBaseAndExtent(anchor, anchor === current ? Math.min(anchorOffset, length) : anchorOffset, focus, focus === current ? Math.min(focusOffset, length) : focusOffset)
    }
  }
  const old = [...current.childNodes]
  const keyed = new Map(old.flatMap(node => { const key = identity(node); return key ? [[key, node] as const] : [] }))
  const used = new Set<Node>()
  let cursor = current.firstChild
  for (const child of [...next.childNodes]) {
    const key = identity(child)
    const existing = key ? keyed.get(key) : old.find(node => !used.has(node) && !identity(node) && node.nodeType === child.nodeType && node.nodeName === child.nodeName)
    const actor = existing ?? child.cloneNode(true)
    if (existing) patchNode(existing, child)
    used.add(actor)
    if (actor !== cursor) current.insertBefore(actor, cursor)
    cursor = actor.nextSibling
  }
  for (const node of old) if (!used.has(node)) {
    if (onRemove && node instanceof HTMLElement) onRemove(node)
    else node.parentNode?.removeChild(node)
  }
}

export function patchContent(element: Element, markup: string, onRemove?: (element: HTMLElement) => void): void {
  const next = element.cloneNode(false) as Element
  next.innerHTML = markup
  const active = document.activeElement
  patchNode(element, next, onRemove)
  if (active instanceof HTMLElement && active.isConnected && element.contains(active) && document.activeElement !== active) active.focus({ preventScroll: true })
}

/** Low-frequency collection changes; ordinary text/streaming patches stay direct. */
export function patchInformation(element: HTMLElement, markup: string): void {
  layout(element, () => patchContent(element, markup, retire))
}
