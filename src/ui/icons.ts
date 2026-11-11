// One icon set for every place, from the mocks' icons.js: a 16-unit grid,
// stroke only, colour from the text. <i data-i="name"></i> becomes
// <svg class="i"><use href="#i-name"/></svg>.
export const ICONS: Record<string, string> = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  tag: '<path d="M2.5 3.5v4.2l5.8 5.8a1 1 0 0 0 1.4 0l3.8-3.8a1 1 0 0 0 0-1.4L7.7 2.5H3.5a1 1 0 0 0-1 1z"/><circle cx="5.5" cy="5.5" r="1"/>',
  import: '<path d="M8 10V2.5M5 5.5 8 2.5l3 3M2.5 9.5V12a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9.5"/>',
  bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14a1.6 1.6 0 0 0 3 0"/>',
  menu: '<path d="M3 5h10M3 8h10M3 11h10"/>',
  sliders: '<path d="M3 5h6M12 5h1M3 11h1M7 11h6"/><circle cx="10.5" cy="5" r="1.5"/><circle cx="5.5" cy="11" r="1.5"/>',
  cross: '<path d="m4 4 8 8M12 4l-8 8"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  chev: '<path d="m6 4 4 4-4 4"/>',
  down: '<path d="m4 6 4 4 4-4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  chat: '<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/>',
  session: '<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/><path d="m6 6 2 1.5L6 9M8.5 9h2"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  replay: '<path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2"/><path d="M3.5 2.5v3h3"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5"/>',
  pr: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7M8.5 3 7 4.5 8.5 6"/>',
  issue: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.2"/>',
  card: '<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M5 6.5h6M5 9.5h4"/>',
  done: '<circle cx="8" cy="8" r="5.5"/><path d="m5.6 8.2 1.7 1.7 3.2-3.6"/>',
  failed: '<circle cx="8" cy="8" r="5.5"/><path d="m6 6 4 4M10 6l-4 4"/>',
  changes: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 10.8v.2"/>',
  stopped: '<circle cx="8" cy="8" r="5.5"/><path d="M6.2 6.2h3.6v3.6H6.2z"/>',
  superseded: '<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h5M8.5 6l2 2-2 2"/>',
  posted: '<circle cx="8" cy="8" r="5.5"/><path d="M5.5 7.5h5M5.5 9.5h3"/>',
  group: '<rect x="3.5" y="3.5" width="9" height="7" rx="1.5"/><path d="M5 12.5h6"/>',
  palette: '<path d="M8 2.5a5.5 5.5 0 1 0 0 11c.8 0 1.2-.6 1-1.3-.3-.9.3-1.7 1.2-1.7H12a1.5 1.5 0 0 0 1.5-1.5A5.5 5.5 0 0 0 8 2.5z"/><circle cx="5.5" cy="7" r=".6"/><circle cx="8" cy="5.2" r=".6"/><circle cx="10.5" cy="7" r=".6"/>',
  sidebar: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6.5 3v10"/>',
  send: '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
  attach: '<path d="M10.5 5 6.2 9.3a1.2 1.2 0 0 0 1.7 1.7l4.6-4.6a2.6 2.6 0 0 0-3.7-3.7L4.2 7.3a4 4 0 0 0 5.7 5.7L13 9.9"/>',
  fork: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="11.5" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4.5 5v1a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V5M8 8v3"/>',
  handoff: '<path d="M2.5 8h8M8 5l3 3-3 3M13.5 3v10"/>',
  read: '<path d="M2.5 3.5h4A1.5 1.5 0 0 1 8 5v8a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5h4z"/>',
  term: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3"/>',
  edit: '<path d="m10.5 3.5 2 2L6 12H4v-2z"/>',
  tool: '<path d="M9.8 3.2a3 3 0 0 0-3.6 3.9L3 10.3 4.7 12l3.2-3.2a3 3 0 0 0 3.9-3.6L10 7l-1-1z"/>',
  pause: '<path d="M5.5 4v8M10.5 4v8"/>',
  minus: '<path d="M3 8h10"/>',
  publish: '<path d="M8 10V2.5M5 5.5l3-3 3 3M2.5 10v3h11v-3"/>',
  snippet: '<path d="M9 1.5 4 9h3.5L7 14.5 12 7H8.5z"/>',
  think: '<path d="M8 2.5a4 4 0 0 0-2.3 7.3v1.7h4.6V9.8A4 4 0 0 0 8 2.5zM6.3 13.5h3.4"/>'
};

/** Puts the sprite every icon refers to into the page, once. */
export function installIcons(): void {
  if (document.getElementById('poise-icons')) return
  document.body.insertAdjacentHTML('afterbegin', `<svg id="poise-icons" class="i-sprite" aria-hidden="true">${
    Object.entries(ICONS).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 16 16">${v}</symbol>`).join('')}</svg>`)
}

/** An icon's markup: `icon('bell')`, or `icon('down', 'sm')`. */
export function icon(name: string, cls = ''): string {
  return `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`
}

/** Turns every <i data-i> placeholder under `root` into its icon. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('i[data-i]').forEach((el) => {
    el.outerHTML = icon(el.dataset.i ?? '', [...el.classList].join(' '))
  })
}
