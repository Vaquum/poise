import { mountGooglePublish } from './google-documents'
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
  version(): string | null
  published?(): void
}

interface Choice {
  key: string
  site: SiteView
  section: SectionView
}

type Shared = 'title' | 'description' | 'date'

/** A site's own field as the panel holds it: a list as its words, each kept whole, commas and all. */
type OwnValue = string | boolean | string[]

interface State {
  slug: string
  choices: Choice[]
  doc: DocumentPublishing
  chosen: Set<string>
  /** Title and description as shown; the date as typed, once it is (dateTyped), until then each site's own (dateFor). */
  shared: Record<Shared, string>
  /** The date was typed, or cleared: from then it is every site's. */
  dateTyped: boolean
  /** Each destination's own values. */
  values: Map<string, Record<string, OwnValue>>
  /** A list's text while it is typed, by the control's field key: shown as typed, read into words as it goes. */
  listText: Map<string, string>
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
  if (which === 'description') {
    // A description that is the first line is the title's: one field, one control.
    const field = section.fields.find((f) => f.name === 'description' && f.kind === 'text')?.name
    return field !== sharedField(section, 'title') ? field : undefined
  }
  // The date that dates the post, only where the writer fills it: a later date
  // field (an expiry, say) is the site's own, and a fixed one is never shown.
  if (section.dateField) return section.fields.some((f) => f.name === section.dateField) ? section.dateField : undefined
  return section.fields.find((f) => f.kind === 'date')?.name
}

function ownFields(section: SectionView): FieldView[] {
  const shared = new Set((['title', 'description', 'date'] as const).map((which) => sharedField(section, which)))
  return section.fields.filter((f) => !shared.has(f.name))
}

/**
 * Whether a publication is of a choice's site and section: by its
 * repository's id where both are known, so a repository that took another's
 * name never takes its publications; else by name.
 */
function isOf(publication: PublicationView, choice: Choice): boolean {
  if (publication.section !== choice.section.name) return false
  return publication.repoId && choice.site.id ? publication.repoId === choice.site.id : keyOf(publication.repo, publication.section) === choice.key
}

function publicationOf(s: State, key: string): PublicationView | undefined {
  const choice = s.choices.find((c) => c.key === key)
  return choice && s.doc.publications.find((p) => isOf(p, choice))
}

/** A publication still on its way or on the site: one only ever closed unmerged holds no slug. */
function livePublicationOf(s: State, key: string): PublicationView | undefined {
  const publication = publicationOf(s, key)
  return publication?.live ? publication : undefined
}

/** What a publication's values hold under a name: their own, never what every object inherits, like constructor. */
function savedValue(values: Record<string, unknown>, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined
}

/** Empty as the site reads it: nothing, an empty text, or no words. */
function blank(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)
}

/** A list's words as typed, separated by commas. */
function words(text: string): string[] {
  return text.split(',').map((w) => w.trim()).filter(Boolean)
}

const fieldKey = (key: string, name: string) => JSON.stringify([key, name])

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
    const choice = choices.find((c) => isOf(publication, c))
    const field = choice && sharedField(choice.section, 'title')
    const value = field ? asText(savedValue(publication.values, field)) : ''
    if (value) return String(value)
  }
  return doc.title
}

/**
 * A shared value from the first publication whose site has it: a site
 * without a description says nothing about another's. Read from the
 * publications as they are, so one made in the panel counts at once. A date
 * is the one a publication went by, where its section is dated by a field:
 * one the site fixes too, which the writer never fills.
 */
function remembered(doc: DocumentPublishing, choices: Choice[], which: Shared): string {
  for (const publication of doc.publications) {
    const choice = choices.find((c) => isOf(publication, c))
    if (!choice) continue
    const field = sharedField(choice.section, which)
    const dated = which === 'date' && (choice.section.dateField || field) ? publication.date : undefined
    const value = dated ?? (field ? asText(savedValue(publication.values, field)) : '')
    if (value) return String(value)
  }
  return ''
}

function startState(slug: string, sites: SiteView[], doc: DocumentPublishing): State {
  const choices: Choice[] = sites.filter((s) => s.state === 'ready').flatMap((site) =>
    site.sections!.map((section) => ({ key: keyOf(site.repo, section.name), site, section })))
  const published = (choice: Choice) => doc.publications.find((p) => isOf(p, choice))
  const chosen = new Set(choices.filter((c) => published(c)).map((c) => c.key))
  if (!chosen.size && choices.length === 1) chosen.add(choices[0].key)
  const values = new Map<string, Record<string, OwnValue>>()
  const slugs = new Map<string, string>()
  for (const choice of choices) {
    const publication = published(choice)
    const own: Record<string, OwnValue> = {}
    for (const field of ownFields(choice.section)) {
      // A field the saved values leave empty, or do not have (one added
      // since), takes its default: what the site was given for it. Only a
      // date field reads today as today; elsewhere it is the word. A list
      // given as one text, as the API takes it, is its words by commas.
      const saved = publication ? savedValue(publication.values, field.name) : undefined
      const value = !blank(saved) ? saved : field.default === 'today' && field.kind === 'date' ? doc.today : field.default
      own[field.name] = field.kind === 'boolean' ? value === true
        : field.kind === 'list' ? (Array.isArray(value) ? value.map(String) : typeof value === 'string' ? words(value) : [])
        : asText(value) as string
    }
    values.set(choice.key, own)
    slugs.set(choice.key, publication?.slug ?? doc.slug)
  }
  return {
    slug, choices, doc, chosen, values, listText: new Map(), slugs, slugTyped: new Set(), results: new Map(), busy: false,
    shared: { title: titleFor(doc, choices), description: remembered(doc, choices, 'description'), date: '' },
    dateTyped: false,
  }
}

/**
 * The date a chosen site is published with: the one typed; until then the
 * date it has, else the piece's date elsewhere, else the site's own default,
 * today unless its description fixes another.
 */
function dateFor(s: State, choice: Choice): string {
  const field = choice.section.fields.find((f) => f.name === sharedField(choice.section, 'date'))
  // A date cleared is left out, unless it has a default: the site writes that instead, so the panel does.
  const cleared = field?.default === 'today' ? s.doc.today : typeof field?.default === 'string' ? field.default : ''
  if (s.dateTyped) return s.shared.date || cleared
  const publication = livePublicationOf(s, choice.key)
  if (field && publication) {
    // Cleared when it was published: left out still, or the default it went by.
    // Otherwise the date it went by, one the site fixed when it was published too.
    const saved = savedValue(publication.values, field.name)
    if (saved === '') return cleared && (publication.date || cleared)
    const own = typeof saved === 'string' && saved ? saved : publication.date
    if (own) return own
  }
  const piece = remembered(s.doc, s.choices, 'date')
  if (piece) return piece
  return typeof field?.default === 'string' && field.default !== 'today' ? field.default : s.doc.today
}

/** The date the panel shows: the first chosen site's. */
function shownDate(s: State): string {
  const choice = s.choices.find((c) => s.chosen.has(c.key) && sharedField(c.section, 'date'))
  return choice ? dateFor(s, choice) : s.dateTyped ? s.shared.date : s.doc.today
}

/* ---------------------------------------------------------------- rendering */

/** A field's own name read as a label: canonical_url reads Canonical url. */
function labelOf(field: FieldView): string {
  if (field.label) return field.label
  const words = field.name.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function fieldHtml(key: string, field: FieldView, value: OwnValue, typed?: string): string {
  const name = escapeHtml(labelOf(field))
  // The label wraps the control; aria-label keeps its name to the field's
  // name alone, without a select's options or a list's suggestions.
  const data = `data-field="${encode(key, field.name)}" aria-label="${name}"`
  const required = field.required ? ' required' : ''
  const max = field.max && field.kind === 'text' ? ` maxlength="${field.max}"` : ''
  // Left empty, a field is written with its default: the box says which.
  const hint = typeof field.default === 'string' && field.default ? ` placeholder="${escapeHtml(field.default)}"` : ''
  let control: string
  switch (field.kind) {
    case 'choice': {
      // Nothing chosen shows as nothing chosen, never as the first choice the
      // browser would display. A choice with a default is never left empty:
      // the site would write its default.
      const none = value === ''
        ? `<option value="" selected${field.required ? ' disabled' : ''}>${field.required ? 'Choose…' : ''}</option>`
        : field.required || field.default !== undefined ? '' : '<option value=""></option>'
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
      const items = value as string[]
      const chips = (field.suggestions ?? []).map((s) =>
        `<button type="button" class="ep-chip${items.includes(s) ? ' is-on' : ''}" data-chip="${encode(key, field.name, s)}" aria-pressed="${items.includes(s)}">${escapeHtml(s)}</button>`).join('')
      const listHint = Array.isArray(field.default) && field.default.length ? field.default.join(', ') : 'separated, by commas'
      const input = `<input type="text" class="ep-input ep-mono" ${data} value="${escapeHtml(typed ?? items.join(', '))}" placeholder="${escapeHtml(listHint)}" autocomplete="off" spellcheck="false" />`
      return `<div class="ep-list"><label class="ep-field"><span class="ep-label">${name}</span>${input}</label>${chips ? `<span class="ep-chips">${chips}</span>` : ''}</div>`
    }
    default:
      control = field.lines === 'many'
        ? `<textarea class="ep-input" rows="2" ${data}${max}${required}${hint}>${escapeHtml(String(value))}</textarea>`
        : `<input type="text" class="ep-input" ${data} value="${escapeHtml(String(value))}"${max}${required}${hint} autocomplete="off" />`
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
    if (control.dataset.shared) wanted = control.dataset.shared === 'date' ? shownDate(s) : s.shared[control.dataset.shared as Shared]
    else if (control.dataset.slug) wanted = s.slugs.get(control.dataset.slug) ?? ''
    else {
      const [key, name] = decode(control.dataset.field!)
      const value = s.values.get(key)?.[name] ?? ''
      wanted = Array.isArray(value) ? s.listText.get(control.dataset.field!) ?? value.join(', ') : value
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
      ${prChip(publicationOf(s, c.key))}
    </label>`).join('')
  const chosen = s.choices.filter((c) => s.chosen.has(c.key))
  const uses = (which: Shared) => chosen.some((c) => sharedField(c.section, which))
  const shared = [
    uses('title') ? `<label class="ep-field"><span class="ep-label">Title</span><input type="text" class="ep-input ep-title" data-key="shared-title" data-shared="title" aria-label="Title" value="${escapeHtml(s.shared.title)}" autocomplete="off" /></label>` : '',
    uses('description') ? `<label class="ep-field"><span class="ep-label">Description</span><textarea class="ep-input" rows="2" data-key="shared-description" data-shared="description" aria-label="Description">${escapeHtml(s.shared.description)}</textarea></label>` : '',
    uses('date') ? `<label class="ep-field"><span class="ep-label">Date</span><input type="date" class="ep-input" data-key="shared-date" data-shared="date" aria-label="Date" value="${escapeHtml(shownDate(s))}" /></label>` : '',
  ].join('')
  const destinations = chosen.map((c) => {
    const publication = livePublicationOf(s, c.key)
    const own = s.values.get(c.key)!
    return `
      <div class="ep-dest" data-key="${escapeHtml(c.key)}-fields">
        ${chosen.length > 1 || ownFields(c.section).length ? `<div class="ep-dest-name">${escapeHtml(c.site.site ?? c.site.repo)}${sectionsOf(c.site.repo) > 1 ? ` · ${escapeHtml(c.section.name)}` : ''}</div>` : ''}
        <label class="ep-field"><span class="ep-label">Slug</span><input type="text" class="ep-input ep-mono" data-slug="${escapeHtml(c.key)}" aria-label="Slug" value="${escapeHtml(s.slugs.get(c.key) ?? '')}"${publication ? ' readonly title="Published under this slug"' : ''} autocomplete="off" spellcheck="false" /></label>
        ${ownFields(c.section).map((f) => fieldHtml(c.key, f, own[f.name] ?? '', s.listText.get(fieldKey(c.key, f.name)))).join('')}
        ${resultHtml(s.results.get(c.key))}
      </div>`
  }).join('')
  const updating = chosen.length > 0 && chosen.every((c) => livePublicationOf(s, c.key))
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

function destinationFor(s: State, choice: Choice): Destination {
  const values: Record<string, unknown> = {}
  for (const field of ownFields(choice.section)) values[field.name] = s.values.get(choice.key)![field.name]
  for (const which of ['title', 'description', 'date'] as const) {
    const field = sharedField(choice.section, which)
    if (!field) continue
    // A date is always sent: an empty one is one the writer cleared, and stays so.
    if (which === 'date') values[field] = dateFor(s, choice)
    else if (s.shared[which]) values[field] = s.shared[which]
  }
  return { repo: choice.site.repo, ...(choice.site.id ? { id: choice.site.id } : {}), section: choice.section.name, slug: (s.slugs.get(choice.key) ?? '').trim(), values }
}

async function publish(host: PublishPanelHost, replace: boolean): Promise<void> {
  const s = state
  if (!s || s.busy || !s.chosen.size) return
  s.busy = true
  message = ''
  render()
  // What is published is this panel's, read from its own state: closing the
  // panel meanwhile does not stop it, and shows nothing of it.
  let note = ''
  try {
    if (!await host.flush()) throw new Error('The document could not be saved, so it was not published.')
    const chosen = s.choices.filter((c) => s.chosen.has(c.key))
    const results = await publishDocument(s.slug, chosen.map((c) => destinationFor(s, c)), replace)
    for (const result of results) {
      const key = keyOf(result.repo, result.section)
      s.results.set(key, result)
      const choice = s.choices.find((c) => c.key === key)
      if (result.ok && result.publication) {
        // In place of the one it updates: another repository's under the same name stays.
        s.doc.publications = [...s.doc.publications.filter((p) => !(choice ? isOf(p, choice) : keyOf(p.repo, p.section) === key)), result.publication]
        s.slugs.set(key, result.publication.slug)
      }
    }
    const done = results.filter((r) => r.ok).length
    if (done) host.published?.()
    note = done === results.length ? '' : `${results.length - done} of ${results.length} not published.`
  } catch (error) {
    note = (error as Error).message
  } finally {
    s.busy = false
    if (state === s) {
      message = note
      render()
    }
  }
}

function onInput(event: Event): void {
  const s = state
  const target = event.target as HTMLInputElement
  if (!s || !target) return
  if (target.dataset.shared) {
    const which = target.dataset.shared as Shared
    s.shared[which] = target.value
    if (which === 'date') {
      s.dateTyped = true
      // Cleared, once the change is made: a date with a default shows it again.
      if (event.type === 'change' && !target.value) render()
    }
    if (which === 'title') {
      // A slug follows the title until it is typed, or published.
      for (const choice of s.choices) {
        if (!s.slugTyped.has(choice.key) && !livePublicationOf(s, choice.key)) s.slugs.set(choice.key, slugFromTitle(target.value))
      }
      render()
    }
  } else if (target.dataset.slug) {
    s.slugs.set(target.dataset.slug, target.value)
    s.slugTyped.add(target.dataset.slug)
  } else if (target.dataset.field) {
    const [key, name] = decode(target.dataset.field)
    const own = s.values.get(key)!
    if (Array.isArray(own[name])) {
      // Typed words light their suggestions; the text stays as typed.
      s.listText.set(target.dataset.field, target.value)
      own[name] = words(target.value)
      render()
    } else {
      own[name] = target.type === 'checkbox' ? target.checked : target.value
      // A date with a default, cleared once the change is made, is written
      // with its default, as the shared date is: the control shows it.
      if (event.type === 'change' && target.type === 'date' && !target.value) {
        const field = s.choices.find((c) => c.key === key)?.section.fields.find((f) => f.name === name)
        const fallback = field?.default === 'today' ? s.doc.today : typeof field?.default === 'string' ? field.default : ''
        if (fallback) {
          own[name] = fallback
          render()
        }
      }
    }
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
    const items = own[name] as string[]
    own[name] = items.includes(word) ? items.filter((w) => w !== word) : [...items, word]
    s.listText.delete(fieldKey(key, name))
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
  mountGooglePublish(panel, host)
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
