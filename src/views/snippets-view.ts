// Snippets — manage espanso text-expansion pairs from Poise.
//
// Same table contract as Behaviors / Swarm (the universal `table` /
// `thead th` / `tbody tr` rules do the layout). Editing is inline,
// mirroring Swarm's row expansion: clicking a row toggles a sibling
// expand row beneath it, with the same chevron cue (`.expand-btn` +
// CHEV_SVG, rotated via `.open`). Unlike Swarm's read-only response
// view, this expand row is an editor — trigger + body fields with Save
// and Delete. One row open at a time. The list lives in espanso's
// match/poise.yml (see server/snippets.ts): Poise rewrites the whole set
// on each save and espanso hot-reloads, so a `;trigger` goes live at once.

import { chatClient } from '../chat-client'
import { parseChatSwitches, type ChatSwitches } from '../chat-switches'

interface Snippet { trigger: string; replace: string }
interface SnippetState { snippets: Snippet[]; version: string; skills?: ChatSwitches }

class SnippetConflictError extends Error {}

let viewEl: HTMLElement
let tbodyEl: HTMLTableSectionElement
let initialized = false
let snippets: Snippet[] = []
let snippetVersion = ''
let espansoOk = true
// Service mode: no Espanso runs beside the server; Poise Link brings the
// snippets to the person's desktop.
let viaPoiseLink = false
let skills: ChatSwitches = { revision: 0, switches: [] }
let saving = false
let loadGeneration = 0

// Chevron — identical to Swarm's (src/views/swarm-view.ts). Points right
// when collapsed, rotates 90° via `.expand-btn.open .chev`.
const CHEV_SVG = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

// Attribute-safe HTML escape — same helper the other views carry.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ))
}

// ── shell + rows ─────────────────────────────────────────────────────────
function renderShell(): string {
  return `
    <header class="view-header">
      <div class="filter-cluster" id="snippets-filters">
        <button type="button" class="st-save snip-add">Add snippet</button>
        <button type="button" class="st-clear snip-import-open" aria-expanded="false">Import</button>
        <span class="filter-count" id="snippets-count"></span>
        <span class="st-help st-help-info snip-espanso-hint" hidden>Chat skills work without Espanso. Install Espanso for system-wide text expansion.</span>
        <span class="st-help st-help-info snip-link-hint" hidden>Snippets reach your desktop through Poise Link, which keeps Espanso there in sync.</span>
      </div>
    </header>
    <main>
      <section class="snip-import" aria-label="Import snippets from Espanso" hidden>
        <div class="snip-edit">
          <p class="st-help st-help-info">Paste an Espanso match file, such as <code>base.yml</code>, or choose one. Its plain trigger and replacement pairs are added; entries that run commands or use other Espanso features are skipped, and snippets you already have are kept.</p>
          <textarea class="st-input snip-import-text" aria-label="Espanso match file" placeholder="matches:&#10;  - trigger: &quot;:hi&quot;&#10;    replace: Hello" spellcheck="false"></textarea>
          <div class="st-row">
            <button type="button" class="st-save snip-import-run">Import</button>
            <button type="button" class="st-clear snip-import-choose">Choose file…</button>
            <input type="file" class="snip-import-file" accept=".yml,.yaml" hidden />
            <button type="button" class="st-clear snip-import-close">Close</button>
          </div>
          <div>
            <p class="st-help st-help-info snip-import-status" role="status"></p>
            <ul class="st-help snip-import-report" aria-label="Skipped entries" hidden></ul>
          </div>
        </div>
      </section>
      <table id="snippets-table">
        <thead>
          <tr>
            <th class="col-snip-trigger">Trigger / Chat skill</th>
            <th class="col-title">Snippet</th>
            <th class="col-action"></th>
          </tr>
        </thead>
        <tbody id="snippets-tbody"></tbody>
      </table>
      <p class="st-help snip-skill-help">Every snippet is a Chat skill. Use <code>;name</code> for text expansion and <code>/name</code> in Chat. Skills saved with <code>/create</code> appear here too.</p>
      <p class="snip-empty" hidden>No snippets yet. Add one here, or use <code>/create /name</code> in Chat.</p>
      <div class="snip-load-error" hidden>
        <p class="snip-load-error-title">Your snippets could not be read.</p>
        <p class="snip-load-error-detail"></p>
        <p class="snip-load-error-where">They are still on disk in the espanso match file — nothing has been
          lost, and nothing will be written until the file can be read again.</p>
        <button type="button" class="st-save snip-retry">Try again</button>
      </div>
    </main>
  `
}

// First non-empty line of the body — the row stays one calm line; the
// full text lives in the expanded editor.
function previewLine(body: string): string {
  return body.split('\n').map((l) => l.trim()).find((l) => l) || ''
}

function skillBadge(trigger: string): string {
  const name = skills.switches.find(skill => skill.snippetTrigger === trigger)?.name
  return name ? `<span class="snip-skill-name" aria-label="Chat skill /${escapeHtml(name)}">/${escapeHtml(name)}</span>` : ''
}
function libraryChanged(catalogue: ChatSwitches): void {
  if (catalogue.revision > skills.revision) refreshLibraryView()
}
function refreshLibraryView(): void {
  if (!initialized || saving || viewEl.hidden) return
  const editor = tbodyEl.querySelector('.snip-expand-row')
  if (editor) {
    setStatus(editor.querySelector('.snip-status'), 'The library changed elsewhere. Your edit is kept; Save will check for conflicts.', 'info')
    return
  }
  void fetchSnippets().then(loaded => { if (loaded && !tbodyEl.querySelector('.snip-expand-row')) renderRows() })
}

function renderRow(s: Snippet): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = 'snip-row'
  tr.dataset.trigger = s.trigger
  tr.innerHTML = `
    <td class="title-cell"><span class="snip-trigger">${escapeHtml(s.trigger)}</span>${skillBadge(s.trigger)}</td>
    <td><span class="snip-preview">${escapeHtml(previewLine(s.replace))}</span></td>
    <td class="action-cell"><button type="button" class="expand-btn" title="Edit" aria-label="Edit snippet">${CHEV_SVG}</button></td>
  `
  return tr
}

// The reason the last load failed, or null when the list is trustworthy.
// Without this a failed read fell back to the default empty list and the
// view claimed, in the same words it uses for a brand-new install, that the
// user had no snippets — while the server had just explained exactly what
// was wrong with their file.
let loadError: string | null = null

function renderRows() {
  tbodyEl.innerHTML = ''
  const frag = document.createDocumentFragment()
  for (const s of snippets) frag.appendChild(renderRow(s))
  tbodyEl.appendChild(frag)

  const n = snippets.length
  const failed = loadError !== null
  updateSnippetCount()
  viewEl.querySelector<HTMLElement>('#snippets-table')!.hidden = failed || n === 0
  // "No snippets yet" is a statement about the user's data. Only make it
  // when the data was actually read.
  viewEl.querySelector<HTMLElement>('.snip-empty')!.hidden = failed || n > 0
  viewEl.querySelector<HTMLElement>('.snip-espanso-hint')!.hidden = failed || espansoOk
  viewEl.querySelector<HTMLElement>('.snip-link-hint')!.hidden = failed || !viaPoiseLink

  const errorBox = viewEl.querySelector<HTMLElement>('.snip-load-error')!
  errorBox.hidden = !failed
  if (failed) {
    viewEl.querySelector<HTMLElement>('.snip-load-error-detail')!.textContent = loadError!
  }
}

// ── inline edit row (expand-to-edit) ──────────────────────────────────────
function setStatus(el: HTMLElement | null, text: string, cls: 'info' | 'ok' | 'error' = 'info') {
  if (!el) return
  el.textContent = text
  el.className = `st-help st-help-${cls} snip-status`
}

function buildEditRow(snip: Snippet | null, isDraft: boolean): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = 'snip-expand-row'
  tr.innerHTML = `
    <td colspan="3">
      <div class="snip-edit">
        <input type="text" class="st-input snip-trigger-input" aria-label="Snippet trigger" placeholder=";hello" autocomplete="off" spellcheck="false" />
        <textarea class="st-input snip-body-input" aria-label="Snippet instructions" placeholder="Text to expand, or instructions to include in Chat…" spellcheck="false"></textarea>
        <div class="st-row">
          <button type="button" class="st-save snip-save">Save</button>
          <button type="button" class="st-clear snip-delete">${isDraft ? 'Discard' : 'Delete'}</button>
          <span class="st-help st-help-info snip-status" role="status"></span>
        </div>
      </div>
    </td>
  `
  const triggerInput = tr.querySelector<HTMLInputElement>('.snip-trigger-input')!
  const bodyInput = tr.querySelector<HTMLTextAreaElement>('.snip-body-input')!
  // Seed via .value (not inline HTML) to dodge the textarea leading-newline quirk.
  triggerInput.value = snip?.trigger ?? ''
  bodyInput.value = snip?.replace ?? ''

  tr.querySelector('.snip-save')!.addEventListener('click', () => void save(tr))
  tr.querySelector('.snip-delete')!.addEventListener('click', () => void del(tr))
  // Escape collapses (discard); ⌘/Ctrl+↵ saves; plain Enter in the
  // trigger jumps to the body (which keeps Enter for newlines).
  triggerInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') { e.preventDefault(); collapseOpen(); return }
    if (e.key === 'Enter') { e.preventDefault(); if (e.metaKey || e.ctrlKey) void save(tr); else bodyInput.focus() }
  })
  bodyInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') { e.preventDefault(); collapseOpen(); return }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(tr) }
  })
  return tr
}

// Collapse whatever row is open: remove its expand row, un-rotate the
// chevron, and discard the draft main row if that's what was open.
function collapseOpen() {
  if (saving) return
  const editRow = tbodyEl.querySelector('.snip-expand-row')
  if (!editRow) return
  const main = editRow.previousElementSibling as HTMLElement | null
  editRow.remove()
  if (main) {
    main.querySelector('.expand-btn')?.classList.remove('open')
    if (main.classList.contains('snip-draft')) main.remove()
  }
  // openAdd force-shows the table and hides the onboarding line to make room
  // for the draft. Discarding that draft on a first run otherwise left a bare
  // TRIGGER/SNIPPET header and no instructions at all, until the view was
  // re-entered. Put the empty state back when nothing is left.
  if (!snippets.length && loadError === null) {
    viewEl.querySelector<HTMLElement>('#snippets-table')!.hidden = true
    viewEl.querySelector<HTMLElement>('.snip-empty')!.hidden = false
  }
}

function onTbodyClick(e: MouseEvent) {
  if (saving) return
  // Only main rows toggle. Clicks inside the expand row (inputs/buttons)
  // have no `tr.snip-row` ancestor, so they never collapse the editor.
  const main = (e.target as HTMLElement).closest<HTMLTableRowElement>('tr.snip-row')
  if (!main || !tbodyEl.contains(main)) return
  const sibling = main.nextElementSibling
  const isOpen = !!sibling && sibling.classList.contains('snip-expand-row')
  collapseOpen()
  if (isOpen) return                                   // clicked the open row → toggled closed
  const isDraft = main.classList.contains('snip-draft')
  const snip = isDraft ? null : (snippets.find((s) => s.trigger === main.dataset.trigger) || null)
  const editRow = buildEditRow(snip, isDraft)
  main.insertAdjacentElement('afterend', editRow)
  main.querySelector('.expand-btn')?.classList.add('open')
  // Existing snippet → land in the body; draft/add → land in the trigger.
  const focusSel = snip ? '.snip-body-input' : '.snip-trigger-input'
  ;(editRow.querySelector(focusSel) as HTMLElement | null)?.focus()
}

async function putSnippets(list: Snippet[]): Promise<SnippetState> {
  if (!snippetVersion) throw new Error('Snippets must be reloaded before saving.')
  const res = await fetch('/api/snippets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippets: list, base_version: snippetVersion }),
  })
  const data = await res.json().catch(() => ({})) as {
    snippets?: unknown
    version?: unknown
    skills?: unknown
    error?: string
  }
  if (res.status === 409) throw new SnippetConflictError(data.error || 'Snippets changed elsewhere.')
  if (!res.ok) throw new Error(data.error || 'request failed')
  if (!Array.isArray(data.snippets) || typeof data.version !== 'string') {
    throw new Error('server returned an invalid snippet state')
  }
  return { snippets: data.snippets as Snippet[], version: data.version, skills: parseChatSwitches(data.skills) ?? undefined }
}

async function preserveEditAfterConflict(
  status: HTMLElement | null,
  intent: 'save' | 'delete' = 'save',
): Promise<void> {
  const refreshed = await fetchSnippets()
  if (refreshed) {
    // Repaint the other rows against what was just fetched. Without this the
    // status said "Latest data loaded" while the table still showed the old
    // values for whatever the other writer changed. The open editor is kept:
    // renderRows would rebuild the whole tbody and take the user's unsaved
    // text with it, which is the one thing this path exists to protect.
    repaintRowsAroundOpenEditor()
  }
  // A conflict during a delete needs its own wording. The save copy tells the
  // user to "save again", which on this path means re-saving the very snippet
  // they were trying to remove — the opposite of what they asked for.
  const message = intent === 'delete'
    ? (refreshed
      ? 'Snippets changed elsewhere, so the delete did not go through. Latest data loaded — check the row and delete again.'
      : 'Snippets changed elsewhere, so the delete did not go through. Reload before trying again.')
    : (refreshed
      ? 'Snippets changed elsewhere. Latest data loaded; your unsaved edit is preserved. Review and save again.'
      : 'Snippets changed elsewhere. Your unsaved edit is preserved; reload before saving.')
  setStatus(status, message, 'error')
}

// Refresh every saved row's rendering in place, leaving the open edit row and
// the row it belongs to untouched.
// The header total. Blank while the list is empty or unreadable — a count
// over an error box would be a claim we cannot stand behind.
function updateSnippetCount(): void {
  const el = viewEl.querySelector('#snippets-count')
  if (!el) return
  const n = snippets.length
  el.textContent = loadError !== null || !n ? '' : `${n} snippet${n === 1 ? '' : 's'}`
}

function repaintRowsAroundOpenEditor(): void {
  // The header count is the only place the total is stated, and this path
  // adds and removes rows — leaving it stale made the header contradict the
  // table the user was looking at ("1 snippet" over three rows).
  updateSnippetCount()
  const editRow = tbodyEl.querySelector('.snip-expand-row')
  const editingMain = editRow?.previousElementSibling as HTMLElement | null
  const editingTrigger = editingMain?.dataset.trigger ?? null
  for (const row of Array.from(tbodyEl.querySelectorAll<HTMLElement>('tr.snip-row'))) {
    if (row === editingMain || row.classList.contains('snip-draft')) continue
    const snip = snippets.find((x) => x.trigger === row.dataset.trigger)
    if (!snip) { row.remove(); continue }
    row.replaceWith(renderRow(snip))
  }
  // Rows added elsewhere since the last load would otherwise never appear.
  for (const snip of snippets) {
    if (snip.trigger === editingTrigger) continue
    if (tbodyEl.querySelector(`tr.snip-row[data-trigger="${CSS.escape(snip.trigger)}"]`)) continue
    tbodyEl.appendChild(renderRow(snip))
  }
}

function setMutationDisabled(row: HTMLTableRowElement, disabled: boolean): void {
  for (const el of row.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input,textarea,button')) el.disabled = disabled
  viewEl.querySelector<HTMLButtonElement>('.snip-add')!.disabled = disabled
  viewEl.querySelector<HTMLButtonElement>('.snip-import-run')!.disabled = disabled || importing
}

async function save(editRow: HTMLTableRowElement) {
  if (saving) return
  const main = editRow.previousElementSibling as HTMLElement | null
  const isDraft = !!main?.classList.contains('snip-draft')
  const editingTrigger = isDraft ? null : (main?.dataset.trigger ?? null)
  const triggerInput = editRow.querySelector<HTMLInputElement>('.snip-trigger-input')!
  const bodyInput = editRow.querySelector<HTMLTextAreaElement>('.snip-body-input')!
  const status = editRow.querySelector<HTMLElement>('.snip-status')
  const trigger = triggerInput.value.trim()
  const replace = bodyInput.value
  if (!trigger) { setStatus(status, 'Trigger is required.', 'error'); triggerInput.focus(); return }
  if (!replace.trim()) { setStatus(status, 'Snippet body is required.', 'error'); bodyInput.focus(); return }
  if (editingTrigger != null && !snippets.some((s) => s.trigger === editingTrigger)) {
    setStatus(status, 'This snippet was removed or renamed elsewhere. Your edit is preserved; copy it before reloading.', 'error')
    return
  }
  // Preserve order: edit replaces in place, add appends.
  const next = editingTrigger != null
    ? snippets.map((s) => (s.trigger === editingTrigger ? { trigger, replace } : s))
    : [...snippets, { trigger, replace }]
  if (next.filter((s) => s.trigger === trigger).length > 1) {
    setStatus(status, `A snippet with trigger "${trigger}" already exists.`, 'error')
    return
  }
  const saveBtn = editRow.querySelector<HTMLButtonElement>('.snip-save')!
  saving = true
  loadGeneration++
  setMutationDisabled(editRow, true)
  saveBtn.disabled = true
  saveBtn.textContent = 'Saving…'
  try {
    const saved = await putSnippets(next)
    snippets = saved.snippets
    snippetVersion = saved.version
    if (saved.skills) skills = saved.skills
    renderRows()                                       // rebuild collapses the (transient) edit row
  } catch (err) {
    if (err instanceof SnippetConflictError) await preserveEditAfterConflict(status)
    else setStatus(status, (err as Error).message || 'Failed to save.', 'error')
    saveBtn.disabled = false
    saveBtn.textContent = 'Save'
  } finally { saving = false; setMutationDisabled(editRow, false) }
}

async function del(editRow: HTMLTableRowElement) {
  if (saving) return
  const main = editRow.previousElementSibling as HTMLElement | null
  const editingTrigger = main?.dataset.trigger ?? null
  // Draft (never saved) or somehow unkeyed → just discard, no server call.
  if (main?.classList.contains('snip-draft') || editingTrigger == null) { collapseOpen(); return }
  // Deleting a saved snippet is immediate, irreversible and one click away
  // from the row you were merely editing — and unlike a document there is no
  // copy of it anywhere. Confirm, the same as the editor does before removing
  // a document.
  if (!window.confirm(`Delete the snippet "${editingTrigger}"? This cannot be undone.`)) return
  const next = snippets.filter((s) => s.trigger !== editingTrigger)
  const delBtn = editRow.querySelector<HTMLButtonElement>('.snip-delete')!
  saving = true
  loadGeneration++
  setMutationDisabled(editRow, true)
  delBtn.disabled = true
  try {
    const saved = await putSnippets(next)
    snippets = saved.snippets
    snippetVersion = saved.version
    if (saved.skills) skills = saved.skills
    renderRows()
  } catch (err) {
    const status = editRow.querySelector<HTMLElement>('.snip-status')
    if (err instanceof SnippetConflictError) await preserveEditAfterConflict(status, 'delete')
    else setStatus(status, (err as Error).message || 'Failed to delete.', 'error')
    delBtn.disabled = false
  } finally { saving = false; setMutationDisabled(editRow, false) }
}

// "Add snippet" → a draft main row pinned at the top, opened in edit mode.
// A second click on it / Escape / Discard removes it. One draft at a time.
function openAdd() {
  if (saving) return
  const existingDraft = tbodyEl.querySelector<HTMLElement>('tr.snip-draft')
  if (existingDraft) {
    ;(existingDraft.nextElementSibling?.querySelector('.snip-trigger-input') as HTMLElement | null)?.focus()
    return
  }
  // Nothing may be composed while the file cannot be read. The error box says
  // nothing will be written until the file parses again, and opening a draft
  // over it put an editable table of stale rows on screen beside that promise
  // — with a Save that could only fail.
  if (loadError !== null) return
  collapseOpen()
  // The table is hidden while the saved list is empty — show it for the draft.
  viewEl.querySelector<HTMLElement>('#snippets-table')!.hidden = false
  viewEl.querySelector<HTMLElement>('.snip-empty')!.hidden = true
  const main = document.createElement('tr')
  main.className = 'snip-row snip-draft'
  main.innerHTML = `
    <td class="title-cell"><span class="snip-draft-label">New snippet</span></td>
    <td><span class="snip-preview"></span></td>
    <td class="action-cell"><button type="button" class="expand-btn open" title="Edit" aria-label="Edit snippet">${CHEV_SVG}</button></td>
  `
  tbodyEl.insertBefore(main, tbodyEl.firstChild)
  const editRow = buildEditRow(null, true)
  main.insertAdjacentElement('afterend', editRow)
  ;(editRow.querySelector('.snip-trigger-input') as HTMLElement | null)?.focus()
}

// ── Import ───────────────────────────────────────────────────────────────
// An Espanso match file's plain pairs join the library through the server's
// compare-and-swap, the one every other write uses; the server says which
// entries it skipped and why.

interface ImportSkip { entry: number | null; trigger: string | null; reason: 'duplicate' | 'not_plain' | 'invalid'; detail: string }

const IMPORT_MAX_BYTES = 1024 * 1024
const SKIP_REASONS: Record<ImportSkip['reason'], string> = {
  duplicate: 'duplicate trigger',
  not_plain: 'not a plain snippet',
  invalid: 'invalid',
}
let importing = false

function importEl<T extends HTMLElement>(selector: string): T {
  return viewEl.querySelector<T>(selector)!
}

function setImportStatus(text: string, cls: 'info' | 'ok' | 'error'): void {
  const el = importEl('.snip-import-status')
  el.textContent = text
  el.className = `st-help st-help-${cls} snip-import-status`
}

function toggleImport(open: boolean): void {
  importEl('.snip-import').hidden = !open
  importEl('.snip-import-open').setAttribute('aria-expanded', String(open))
  if (open) importEl<HTMLTextAreaElement>('.snip-import-text').focus()
}

function renderSkip(skip: ImportSkip): string {
  // A top-level key (global_vars, imports) is not an entry; its detail names it.
  if (skip.entry === null) return `<li>${escapeHtml(skip.detail)}</li>`
  const what = skip.trigger !== null ? `<code>${escapeHtml(skip.trigger)}</code>` : `Entry ${skip.entry}`
  return `<li>${what} — ${SKIP_REASONS[skip.reason] ?? escapeHtml(skip.reason)}: ${escapeHtml(skip.detail)}</li>`
}

async function runImport(): Promise<void> {
  if (importing || saving) return
  const text = importEl<HTMLTextAreaElement>('.snip-import-text')
  const run = importEl<HTMLButtonElement>('.snip-import-run')
  const report = importEl<HTMLUListElement>('.snip-import-report')
  if (!text.value.trim()) {
    setImportStatus('Paste an Espanso match file or choose one first.', 'error')
    text.focus()
    return
  }
  importing = true
  loadGeneration++
  run.disabled = true
  run.textContent = 'Importing…'
  report.hidden = true
  report.innerHTML = ''
  setImportStatus('', 'info')
  try {
    const res = await fetch('/api/snippets/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml: text.value }),
    })
    const data = await res.json().catch(() => ({})) as {
      added?: unknown, skipped?: unknown, snippets?: unknown, version?: unknown, skills?: unknown, error?: string
    }
    if (!res.ok) throw new Error(data.error || `The import failed (HTTP ${res.status}).`)
    if (!Array.isArray(data.added) || !Array.isArray(data.skipped) || !Array.isArray(data.snippets) || typeof data.version !== 'string') {
      throw new Error('The server returned an unreadable import report.')
    }
    snippets = data.snippets as Snippet[]
    snippetVersion = data.version
    skills = parseChatSwitches(data.skills) ?? skills
    loadError = null
    // An open editor keeps its text; the rows around it are brought up to date.
    if (tbodyEl.querySelector('.snip-expand-row')) repaintRowsAroundOpenEditor()
    else renderRows()
    const added = data.added.length
    const skipped = data.skipped as ImportSkip[]
    setImportStatus(
      `${added ? `Added ${added} snippet${added === 1 ? '' : 's'}.` : 'No new snippets to add.'}${skipped.length ? ` Skipped ${skipped.length}:` : ''}`,
      added ? 'ok' : 'info',
    )
    report.innerHTML = skipped.map(renderSkip).join('')
    report.hidden = skipped.length === 0
  } catch (err) {
    setImportStatus((err as Error).message || 'The import failed.', 'error')
  } finally {
    importing = false
    run.disabled = saving
    run.textContent = 'Import'
  }
}

// A chosen file is put in the text area to review before importing it.
async function loadImportFile(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0]
  input.value = '' // Choosing the same file again after editing still loads it.
  if (!file) return
  try {
    if (file.size > IMPORT_MAX_BYTES) throw new Error('Choose a file smaller than 1 MiB.')
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) }
    catch { throw new Error('Choose a UTF-8 text file; this one could not be read as text.') }
    importEl<HTMLTextAreaElement>('.snip-import-text').value = content
    setImportStatus(`Loaded ${file.name}. Check it, then choose Import.`, 'info')
  } catch (err) {
    setImportStatus((err as Error).message, 'error')
  }
}

function attachHandlers() {
  viewEl.querySelector('.snip-add')!.addEventListener('click', openAdd)
  tbodyEl.addEventListener('click', onTbodyClick)
  viewEl.querySelector('.snip-retry')!.addEventListener('click', () => {
    void fetchSnippets().then(() => renderRows())
  })
  importEl('.snip-import-open').addEventListener('click', () => toggleImport(importEl('.snip-import').hidden))
  importEl('.snip-import-close').addEventListener('click', () => toggleImport(false))
  importEl('.snip-import-run').addEventListener('click', () => void runImport())
  importEl('.snip-import-choose').addEventListener('click', () => importEl<HTMLInputElement>('.snip-import-file').click())
  importEl<HTMLInputElement>('.snip-import-file').addEventListener('change', (e) => void loadImportFile(e.target as HTMLInputElement))
  importEl<HTMLTextAreaElement>('.snip-import-text').addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void runImport() }
  })
}

async function fetchSnippets(): Promise<boolean> {
  const generation = ++loadGeneration
  const editorAtStart = tbodyEl?.querySelector('.snip-expand-row')
  try {
    const res = await fetch('/api/snippets')
    if (!res.ok) {
      // The server explains itself well here — an unparseable poise.yml comes
      // back as the YAML parser's message, with line and column. Keep it: it
      // is the only thing that tells the user which file to look at and why.
      const body = await res.json().catch(() => ({})) as { error?: string }
      loadError = body.error || `The snippets file could not be read (HTTP ${res.status}).`
      return false
    }
    const data = await res.json()
    if (!Array.isArray(data.snippets) || typeof data.version !== 'string') {
      loadError = 'The server returned an unreadable snippet list.'
      return false
    }
    if (generation !== loadGeneration || tbodyEl?.querySelector('.snip-expand-row') !== editorAtStart) return false
    skills = parseChatSwitches(data.skills) ?? skills
    snippets = Array.isArray(data.snippets) ? data.snippets : []
    snippetVersion = data.version
    espansoOk = data.espansoDetected !== false
    viaPoiseLink = data.desktop === 'poise-link'
    loadError = null
    return true
  } catch (err) {
    // Leave the current list intact; a stale save will conflict safely.
    loadError = (err as Error)?.message
      ? `Could not reach Poise to read your snippets (${(err as Error).message}).`
      : 'Could not reach Poise to read your snippets.'
    return false
  }
}

export async function initSnippetsView() {
  viewEl = document.getElementById('view-snippets')!
  if (!initialized) {
    initialized = true
    viewEl.innerHTML = renderShell()
    tbodyEl = viewEl.querySelector<HTMLTableSectionElement>('#snippets-tbody')!
    attachHandlers()
    chatClient.on('switches', libraryChanged)
    chatClient.on('restart', refreshLibraryView)
    chatClient.start()
  }
  // Re-entering the view re-renders the table from scratch, and renderRows
  // starts by emptying the tbody — which threw away an open editor and every
  // character typed into it, with no prompt. If something is being edited,
  // leave the screen alone: the list is refreshed the next time it is safe.
  if (tbodyEl.querySelector('.snip-expand-row')) return
  await fetchSnippets()
  // Opening an editor while the request was in flight is newer user work.
  if (!tbodyEl.querySelector('.snip-expand-row')) renderRows()
}
