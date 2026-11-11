// The Style panel's Motion switch (#556): off makes every motion instant, as
// the system's reduced motion does. Classic's motion runtime (src/motion.ts),
// which the new interface reuses as it is, asks one question,
// matchMedia('(prefers-reduced-motion: reduce)'). Installed before that runtime
// starts, this answers the question with the switch as well, so its springs,
// reveals and panels stop with it, and tells the runtime when the answer turns.
const QUERY = '(prefers-reduced-motion: reduce)'
type Listener = (event: MediaQueryListEvent) => void

/** Returns what to call when the switch may have changed. */
export function installMotionSwitch(off: () => boolean): () => void {
  const native = window.matchMedia.bind(window)
  const system = native(QUERY)
  const listeners = new Set<Listener>()
  let was = system.matches || off()
  const list = {
    media: QUERY,
    onchange: null,
    get matches(): boolean { return system.matches || off() },
    addEventListener(type: string, fn: Listener) { if (type === 'change') listeners.add(fn) },
    removeEventListener(type: string, fn: Listener) { if (type === 'change') listeners.delete(fn) },
    addListener(fn: Listener) { listeners.add(fn) },
    removeListener(fn: Listener) { listeners.delete(fn) },
    dispatchEvent: () => false,
  } as unknown as MediaQueryList
  const turned = (): void => {
    const now = list.matches
    if (now === was) return
    was = now
    for (const fn of listeners) fn.call(list, { matches: now, media: QUERY } as MediaQueryListEvent)
  }
  system.addEventListener('change', turned)
  window.matchMedia = (query: string): MediaQueryList => (query.replace(/\s+/g, ' ').trim() === QUERY ? list : native(query))
  return turned
}
