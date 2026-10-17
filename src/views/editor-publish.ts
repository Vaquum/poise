import { retire, reveal } from '../motion'
import { patchContent } from '../dom-patch'
import {
  fetchDocumentPublishing,
  fetchSites,
  publishDocument,
  slugFromTitle,
  type Destination,
  type DocumentPublishing,
  type FieldView,
  type PublicationView,
  type PublishResult,
  type SectionView,
  type SiteView,
} from '../publishing'

// The Editor's Publish panel (docs/Publishing.md): the sites from Settings →
// Publishing as choices; title, description and date once; each chosen site's
// own fields under its name; one button. Publishing opens a pull request on
// each site (server/publishing-api.ts); the panel then shows each one.
//
// Tests import the Editor, and so this module: its styles load with the app
// (src/main.ts), and it opens Settings by event rather than importing it.

export const ICON_PUBLISH = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 9V2.5M4.25 5.25 7 2.5l2.75 2.75M2.5 9.5v2h9v-2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'

export interface PublishPanelHost {
  /** The document open in the Editor, if any. */
  slug(): string | null
  /** Saves what has been typed, so what is published is what is on the page. */
  flush(): Promise<boolean>
}

interface Choice {
  key: string
  site: SiteView
  section: SectionView
}

type Shared = 'title' | 'description' | 'date'

interface State {
  slug: string
  choices: Choice[]
  doc: DocumentPublishing
  chosen: Set<string>
  shared: Record<Shared, string>
  /** Each destination's own values, as typed: a list is its words joined by commas. */
  values: Map<string, Record<string, string | boolean>>
  slugs: Map<string, string>
  slugTyped: Set<string>
  results: Map<string, PublishResult>
  busy: boolean
}

let panel: HTMLElement | null = null
let anchorEl: HTMLElement | null = null
let state: State | null = null
let message = ''
let opening = 0

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

const keyOf = (repo: string, section: string) => `${repo.toLowerCase()}#${section}`

// A section's name may hold any character, so the parts a control names are kept as JSON, never joined.
const encode = (...parts: string[]) => escapeHtml(JSON.stringify(parts))
const decode = (value: string) => JSON.parse(value) as string[]

/** Which of a section's fields the shared title, description and date fill. */
function sharedField(section: SectionView, which: Shared): string | undefined {
  if (which === 'title') return section.firstLine ?? section.fields.find((f) => f.name === 'title' && f.kind === 'text')?.name
  if (which === 'description') return section.fields.find((f) => f.name === 'description' && f.kind === 'text')?.name
  return section.fields.find((f) => f.kind === 'date')?.name
}

function ownFields(section: SectionView): FieldView[] {
  const shared = new Set((['title', 'description', 'date'] as const).map((which) => sharedField(section, which)))
  return section.fields.filter((f) => !shared.has(f.name))
}

function publicationOf(key: string): PublicationView | undefined {
  return state?.doc.publications.find((p) => keyOf(p.repo, p.section) === key)
}

/** A publication still on its way or on the site: one only ever closed unmerged holds no slug. */
function livePublicationOf(key: string): PublicationView | undefined {
  const publication = publicationOf(key)
  return publication?.live ? publication : undefined
}

function asText(value: unknown): string | boolean {
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.join(', ')
  return value === undefined || value === null ? '' : String(value)
}

/**
 * The title to offer: one published while the document's first line was
 * what it is now, typed in the panel or not, read from that same
 * publication; otherwise the first line.
 */
function titleFor(doc: DocumentPublishing, choices: Choice[]): string {
  for (const publication of doc.publications) {
    if (publication.docTitle !== doc.title) continue
    const choice = choices.find((c) => c.key === keyOf(publication.repo, publication.section))
    const field = choice && sharedField(choice.section, 'title')
    const value = field ? asText(publication.values[field]) : ''
    if (value) return String(value)
  }
  return doc.title
}

function startState(slug: string, sites: SiteView[], doc: DocumentPublishing): State {
  const choices: Choice[] = sites.filter((s) => s.state === 'ready').flatMap((site) =>
    site.sections!.map((section) => ({ key: keyOf(site.repo, section.name), site, section })))
  const published = (key: string) => doc.publications.find((p) => keyOf(p.repo, p.section) === key)
  const chosen = new Set(choices.filter((c) => published(c.key)).map((c) => c.key))
  if (!chosen.size && choices.length === 1) chosen.add(choices[0].key)
  // Each shared value from the first publication whose site has it: a site
  // without a description says nothing about another's.
  const remembered = (which: Shared): string => {
    for (const publication of doc.publications) {
      const choice = choices.find((c) => c.key === keyOf(publication.repo, publication.section))
      const field = choice && sharedField(choice.section, which)
      const value = field ? asText(publication.values[field]) : ''
      if (value) return String(value)
    }
    return ''
  }
  const values = new Map<string, Record<string, string | boolean>>()
  const slugs = new Map<string, string>()
  for (const choice of choices) {
    const publication = published(choice.key)
    const own: Record<string, string | boolean> = {}
    for (const field of ownFields(choice.section)) {
      const value = publication ? publication.values[field.name] : field.default === 'today' ? doc.today : field.default
      own[field.name] = field.kind === 'boolean' ? value === true : asText(value) as string
    }
    values.set(choice.key, own)
    slugs.set(choice.key, publication?.slug ?? doc.slug)
  }
  return {
    slug, choices, doc, chosen, values, slugs, slugTyped: new Set(), results: new Map(), busy: false,
    shared: { title: titleFor(doc, choices), description: String(remembered('description') || ''), date: String(remembered('date') || doc.today) },
  }
}

/* ---------------------------------------------------------------- rendering */

/** A field's own name read as a label: canonical_url reads Canonical url. */
function labelOf(field: FieldView): string {
  if (field.label) return field.label
  const words = field.name.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function fieldHtml(key: string, field: FieldView, value: string | boolean): string {
  const name = escapeHtml(labelOf(field))
  // The label wraps the control; aria-label keeps its name to the field's
  // name alone, without a select's options or a list's suggestions.
  const data = `data-field="${encode(key, field.name)}" aria-label="${name}"`
  const required = field.required ? ' required' : ''
  const max = field.max && field.kind === 'text' ? ` maxlength="${field.max}"` : ''
  let control: string
  switch (field.kind) {
    case 'choice': {
      // Nothing chosen shows as nothing chosen, never as the first choice the browser would display.
      const none = value === ''
        ? `<option value="" selected${field.required ? ' disabled' : ''}>${field.required ? 'Choose…' : ''}</option>`
        : field.required ? '' : '<option value=""></option>'
      control = `<select class="ep-input" ${data}>${none}${field.choices!.map((c) =>
        `<option value="${escapeHtml(c)}"${c === value ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>`
      break
    }
    case 'date':
      control = `<input type="date" class="ep-input" ${data} value="${escapeHtml(String(value))}"${required} />`
      break
    case 'boolean':
      return `<label class="ep-check"><input type="checkbox" ${data}${value === true ? ' checked' : ''} /> <span>${name}</span></label>`
    case 'list': {
      // The suggestions sit beside the label, not in it: they are not the field's name.
      const words = String(value).split(',').map((w) => w.trim()).filter(Boolean)
      const chips = (field.suggestions ?? []).map((s) =>
        `<button type="button" class="ep-chip${words.includes(s) ? ' is-on' : ''}" data-chip="${encode(key, field.name, s)}" aria-pressed="${words.includes(s)}">${escapeHtml(s)}</button>`).join('')
      const input = `<input type="text" class="ep-input ep-mono" ${data} value="${escapeHtml(String(value))}" placeholder="separated, by commas" autocomplete="off" spellcheck="false" />`
      return `<div class="ep-list"><label class="ep-field"><span class="ep-label">${name}</span>${input}</label>${chips ? `<span class="ep-chips">${chips}</span>` : ''}</div>`
    }
    default:
      control = field.lines === 'many'
        ? `<textarea class="ep-input" rows="2" ${data}${max}${required}>${escapeHtml(String(value))}</textarea>`
        : `<input type="text" class="ep-input" ${data} value="${escapeHtml(String(value))}"${max}${required} autocomplete="off" />`
  }
  return `<label class="ep-field"><span class="ep-label">${name}</span>${control}</label>`
}

function resultHtml(result: PublishResult | undefined): string {
  if (!result) return ''
  if (result.ok) {
    const pr = result.publication!.pullRequest
    const verb = result.unchanged ? 'has this version already' : 'is open'
    return `<div class="ep-result ep-result-ok"><a href="${escapeHtml(pr.url)}" target="_blank" rel="noopener noreferrer">Pull request #${pr.number}</a> ${verb}.</div>`
  }
  const lines = result.problems?.length ? result.problems : [result.error ?? 'Not published.']
  return `<div class="ep-result ep-result-error" role="alert">${lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}</div>`
}

function prChip(publication: PublicationView | undefined): string {
  if (!publication) return ''
  const pr = publication.pullRequest
  const label = pr.state === 'unknown' ? '' : ` ${pr.state}`
  return `<a class="ep-pr ep-pr-${pr.state}" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(publication.problem ?? publication.path)}">#${pr.number}${label}</a>`
}

/** A typed control shows its own value, not its markup's: put the state back into each. */
function syncValues(body: HTMLElement, s: State): void {
  for (const control of body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-shared], [data-slug], [data-field]')) {
    let wanted: string | boolean
    if (control.dataset.shared) wanted = s.shared[control.dataset.shared as Shared]
    else if (control.dataset.slug) wanted = s.slugs.get(control.dataset.slug) ?? ''
    else {
      const [key, name] = decode(control.dataset.field!)
      wanted = s.values.get(key)?.[name] ?? ''
    }
    if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      if (control.checked !== (wanted === true)) control.checked = wanted === true
    } else if (control.value !== String(wanted)) {
      control.value = String(wanted)
    }
  }
}

function render(): void {
  if (!panel) return
  const body = panel.querySelector<HTMLElement>('.ep-body')!
  if (!state) {
    patchContent(body, `<div class="ep-note${message ? ' ep-note-error' : ''}">${escapeHtml(message || 'Reading your sites…')}</div>`)
    return
  }
  const s = state
  if (!s.choices.length) {
    patchContent(body, `<div class="ep-note">No sites to publish to yet.</div><button type="button" class="ep-link" data-open-settings>Add one in Settings → Publishing</button>`)
    return
  }
  const sectionsOf = (repo: string) => s.choices.filter((c) => c.site.repo === repo).length
  const sites = s.choices.map((c) => `
    <label class="ep-site" data-key="${escapeHtml(c.key)}">
      <input type="checkbox" data-choose="${escapeHtml(c.key)}"${s.chosen.has(c.key) ? ' checked' : ''}${s.busy ? ' disabled' : ''} />
      <span class="ep-site-name">${escapeHtml(c.site.site ?? c.site.repo)}${sectionsOf(c.site.repo) > 1 ? `<span class="ep-site-section"> · ${escapeHtml(c.section.name)}</span>` : ''}</span>
      ${prChip(publicationOf(c.key))}
    </label>`).join('')
  const chosen = s.choices.filter((c) => s.chosen.has(c.key))
  const uses = (which: Shared) => chosen.some((c) => sharedField(c.section, which))
  const shared = [
    uses('title') ? `<label class="ep-field"><span class="ep-label">Title</span><input type="text" class="ep-input ep-title" data-key="shared-title" data-shared="title" aria-label="Title" value="${escapeHtml(s.shared.title)}" autocomplete="off" /></label>` : '',
    uses('description') ? `<label class="ep-field"><span class="ep-label">Description</span><textarea class="ep-input" rows="2" data-key="shared-description" data-shared="description" aria-label="Description">${escapeHtml(s.shared.description)}</textarea></label>` : '',
    uses('date') ? `<label class="ep-field"><span class="ep-label">Date</span><input type="date" class="ep-input" data-key="shared-date" data-shared="date" aria-label="Date" value="${escapeHtml(s.shared.date)}" /></label>` : '',
  ].join('')
  const destinations = chosen.map((c) => {
    const publication = livePublicationOf(c.key)
    const own = s.values.get(c.key)!
    return `
      <div class="ep-dest" data-key="${escapeHtml(c.key)}-fields">
        ${chosen.length > 1 || ownFields(c.section).length ? `<div class="ep-dest-name">${escapeHtml(c.site.site ?? c.site.repo)}${sectionsOf(c.site.repo) > 1 ? ` · ${escapeHtml(c.section.name)}` : ''}</div>` : ''}
        <label class="ep-field"><span class="ep-label">Slug</span><input type="text" class="ep-input ep-mono" data-slug="${escapeHtml(c.key)}" aria-label="Slug" value="${escapeHtml(s.slugs.get(c.key) ?? '')}"${publication ? ' readonly title="Published under this slug"' : ''} autocomplete="off" spellcheck="false" /></label>
        ${ownFields(c.section).map((f) => fieldHtml(c.key, f, own[f.name] ?? '')).join('')}
        ${resultHtml(s.results.get(c.key))}
      </div>`
  }).join('')
  const updating = chosen.length > 0 && chosen.every((c) => livePublicationOf(c.key))
  const conflicted = [...s.results.values()].some((r) => r.conflicts?.length)
  const label = s.busy ? 'Publishing…' : updating ? 'Update' : 'Publish'
  // While a publication is in flight nothing can be edited: what is sent is what stays.
  patchContent(body, `
    <fieldset class="ep-form"${s.busy ? ' disabled' : ''}>
    <div class="ep-sites">${sites}</div>
    ${chosen.length ? `<div class="ep-fields">${shared}</div>${destinations}` : ''}
    </fieldset>
    <div class="ep-actions">
      <button type="button" class="composer-add ep-publish"${!chosen.length || s.busy ? ' disabled' : ''}>${label}</button>
      ${conflicted && !s.busy ? '<button type="button" class="composer-cancel ep-replace">Replace with mine</button>' : ''}
      ${message ? `<span class="ep-message">${escapeHtml(message)}</span>` : ''}
    </div>`)
  syncValues(body, s)
}

/* ---------------------------------------------------------------- acting */

function destinationFor(choice: Choice): Destination {
  const s = state!
  const values: Record<string, unknown> = {}
  for (const field of ownFields(choice.section)) {
    const raw = s.values.get(choice.key)![field.name]
    values[field.name] = field.kind === 'list' ? String(raw).split(',').map((w) => w.trim()).filter(Boolean) : raw
  }
  for (const which of ['title', 'description', 'date'] as const) {
    const field = sharedField(choice.section, which)
    if (field && s.shared[which]) values[field] = s.shared[which]
  }
  return { repo: choice.site.repo, section: choice.section.name, slug: (s.slugs.get(choice.key) ?? '').trim(), values }
}

async function publish(host: PublishPanelHost, replace: boolean): Promise<void> {
  const s = state
  if (!s || s.busy || !s.chosen.size) return
  s.busy = true
  message = ''
  render()
  try {
    if (!await host.flush()) throw new Error('The document could not be saved, so it was not published.')
    const chosen = s.choices.filter((c) => s.chosen.has(c.key))
    const results = await publishDocument(s.slug, chosen.map(destinationFor), replace)
    for (const result of results) {
      const key = keyOf(result.repo, result.section)
      s.results.set(key, result)
      if (result.ok && result.publication) {
        s.doc.publications = [...s.doc.publications.filter((p) => keyOf(p.repo, p.section) !== key), result.publication]
        s.slugs.set(key, result.publication.slug)
      }
    }
    const done = results.filter((r) => r.ok).length
    message = done === results.length ? '' : `${results.length - done} of ${results.length} not published.`
  } catch (error) {
    message = (error as Error).message
  } finally {
    s.busy = false
    render()
  }
}

function onInput(event: Event): void {
  const s = state
  const target = event.target as HTMLInputElement
  if (!s || !target) return
  if (target.dataset.shared) {
    const which = target.dataset.shared as Shared
    s.shared[which] = target.value
    if (which === 'title') {
      // A slug follows the title until it is typed, or published.
      for (const choice of s.choices) {
        if (!s.slugTyped.has(choice.key) && !livePublicationOf(choice.key)) s.slugs.set(choice.key, slugFromTitle(target.value))
      }
      render()
    }
  } else if (target.dataset.slug) {
    s.slugs.set(target.dataset.slug, target.value)
    s.slugTyped.add(target.dataset.slug)
  } else if (target.dataset.field) {
    const [key, name] = decode(target.dataset.field)
    s.values.get(key)![name] = target.type === 'checkbox' ? target.checked : target.value
    // Typed words light their suggestions.
    if (target.closest('.ep-list')) render()
  } else if (target.dataset.choose) {
    if (target.checked) s.chosen.add(target.dataset.choose)
    else s.chosen.delete(target.dataset.choose)
    render()
  }
}

function onClick(event: MouseEvent, host: PublishPanelHost): void {
  const target = event.target as HTMLElement
  const s = state
  if (target.closest('[data-open-settings]')) {
    closePublishPanel()
    window.dispatchEvent(new CustomEvent('poise:open-settings', { detail: { section: 'publishing' } }))
    return
  }
  const chip = target.closest<HTMLElement>('[data-chip]')
  if (chip && s) {
    const [key, name, word] = decode(chip.dataset.chip!)
    const own = s.values.get(key)!
    const words = String(own[name]).split(',').map((w) => w.trim()).filter(Boolean)
    own[name] = (words.includes(word) ? words.filter((w) => w !== word) : [...words, word]).join(', ')
    render()
    return
  }
  if (target.closest('.ep-publish')) void publish(host, false)
  else if (target.closest('.ep-replace')) void publish(host, true)
}

function place(): void {
  if (!panel || !anchorEl) return
  const rect = anchorEl.getBoundingClientRect()
  const width = Math.min(380, window.innerWidth - 16)
  // Below the app's bar, as the Editor's composers sit, never under it.
  const bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-bar-h')) || 0
  const top = Math.max(rect.bottom + 6, bar + 8)
  panel.style.width = `${width}px`
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
  panel.style.top = `${top}px`
  panel.style.maxHeight = `${Math.max(160, window.innerHeight - top - 16)}px`
}

function onOutside(event: MouseEvent): void {
  const target = event.target as Node
  if (panel?.contains(target) || anchorEl?.contains(target)) return
  closePublishPanel()
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && panel) {
    event.preventDefault()
    const anchor = anchorEl
    closePublishPanel()
    anchor?.focus()
  }
}

export function closePublishPanel(): void {
  opening++
  if (!panel) return
  retire(panel)
  panel = null
  state = null
  message = ''
  anchorEl?.setAttribute('aria-expanded', 'false')
  anchorEl = null
  document.removeEventListener('mousedown', onOutside, true)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', place)
}

/** Opens the panel under `anchor` for the document open now, or closes it. */
export function togglePublishPanel(anchor: HTMLElement, host: PublishPanelHost): void {
  if (panel) { closePublishPanel(); return }
  const slug = host.slug()
  if (!slug) return
  const mine = ++opening
  anchorEl = anchor
  anchor.setAttribute('aria-expanded', 'true')
  panel = document.createElement('div')
  panel.className = 'ep-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Publish')
  panel.innerHTML = '<div class="ep-body"></div>'
  panel.addEventListener('input', onInput)
  panel.addEventListener('change', onInput)
  panel.addEventListener('click', (event) => onClick(event, host))
  document.body.appendChild(panel)
  place()
  render()
  reveal(panel, { distance: 8 })
  document.addEventListener('mousedown', onOutside, true)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', place)
  void (async () => {
    try {
      await host.flush()
      const [sites, doc] = await Promise.all([fetchSites(), fetchDocumentPublishing(slug)])
      if (mine !== opening) return
      state = startState(slug, sites, doc)
    } catch (error) {
      if (mine !== opening) return
      message = (error as Error).message
    }
    render()
    panel?.querySelector<HTMLElement>('.ep-title, .ep-publish, .ep-link')?.focus({ preventScroll: true })
  })()
}
