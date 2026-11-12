// Settings → Models (#556; SETTINGS.md, M1–M7, and main since #670 and #751):
// the three models chosen once, then each place's slot or Random, the saved
// configurations, what Caller fixes, and the catalog. The slots save as one
// row, so the rule that ties them (three different models) is checked on one
// save; a place saves only its own pick. The catalog and the configurations
// are read from GET /api/models, as classic's Models does (src/settings.ts).
import { esc } from '../../dom'
import { effectiveTimezone } from '../../../config'
import { shortTime } from '../../../clock'
import { MODEL_CHECK_TIMEOUT_MS, modelRefreshSummary, type ModelRefreshReport } from '../../../model-refresh'
import type { Known, Save } from './save'
import { selectHTML, stateHTML, UNDO_MS, type Row } from './rows'
import type { SectionContext, SectionDef } from './types'

type Slot = 'primary' | 'secondary' | 'tertiary'
const SLOTS: Slot[] = ['primary', 'secondary', 'tertiary']
const SLOT_WORDS: Record<string, string> = { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary', random: 'Random' }
interface CatalogModel { identity: string, provider: string }
interface ModelPlace { key: string, label: string, why: string, reviewers: boolean, slot: string, model: string, notes: string[], stored: { slot: string } | null, providers?: string[] | null }
interface Preset { name: string, models: { slots?: Partial<Record<Slot, string>>, places?: Record<string, { slot: string }> }, savedAt: string }
interface ModelsData {
  catalog: { models: CatalogModel[] }
  slots: Record<Slot, string> & { notes: string[], stored: Partial<Record<Slot, string>> | null }
  places: ModelPlace[]
  fixed: Array<{ key: string, label: string, model: string, why: string }>
  refresh: ModelRefreshReport | null
  presets?: Preset[]
}

/** What the section read last; kept for the place's life so Find and the counts can use it. */
let data: ModelsData | null = null
let failure = ''

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const modelsOf = (known: Known) => record(known.models)

async function read(): Promise<void> {
  const response = await fetch('/api/models', { cache: 'no-store' })
  const body = await response.json().catch(() => null) as (ModelsData & { error?: string }) | null
  if (!response.ok || !body?.catalog || !Array.isArray(body.places)) { failure = body?.error || `the model catalog could not be read (Poise answered ${response.status})`; return }
  data = body
  failure = ''
}

/** The three models: what is stored, else what Caller resolves them to. */
function slotsNow(known: Known): Record<Slot, string> {
  const stored = record(modelsOf(known).slots)
  return Object.fromEntries(SLOTS.map((s) => [s, typeof stored[s] === 'string' ? stored[s] as string : data?.slots[s] ?? ''])) as Record<Slot, string>
}
const placeNow = (known: Known, key: string): string => String(record(record(modelsOf(known).places)[key]).slot ?? 'primary')

const slotsSave = (v: Record<Slot, string>): Save => ({
  build: (known) => ({ body: { models: { slots: v } }, expect: 'models' in known ? { models: known.models } : {} }),
  own: (known) => modelsOf(known).slots,
})
const placeSave = (key: string, slot: string): Save => ({
  build: (known) => ({ body: { models: { places: { [key]: { slot } } } }, expect: 'models' in known ? { models: known.models } : {} }),
  own: (known) => record(modelsOf(known).places)[key],
})
const wholeSave = (models: unknown): Save => ({
  build: (known) => ({ body: { models }, expect: 'models' in known ? { models: known.models } : {} }),
  own: (known) => known.models,
})

const APPLIES: Record<string, string> = {
  chat: 'from the next chat', editor: 'from the next Editor chat', pr_review: 'from the next review', pr_approve: 'from the next approval',
  issue_review: 'from the next issue review', issue_implement: 'from the next implementation', pr_repair: 'from the next repair',
}

function presetsRow(ctx: SectionContext): Row {
  let busy = false
  let undo: { models: unknown, name: string } | null = null
  const held = new Map<string, ReturnType<typeof setTimeout>>()
  const say = (html: string) => ctx.rows.lstat(row, html)
  const list = () => (data?.presets ?? []).filter((p) => !held.has(p.name))
  const inUse = (p: Preset): boolean => {
    const known = ctx.known(), now = slotsNow(known)
    return (!p.models.slots || SLOTS.every((s) => !p.models.slots![s] || p.models.slots![s] === now[s]))
      && Object.entries(p.models.places ?? {}).every(([k, c]) => placeNow(known, k) === c.slot)
  }
  async function post(path: string, body: unknown): Promise<boolean> {
    busy = true
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const answer = await response.json().catch(() => null) as { presets?: Preset[], error?: string } | null
      if (!response.ok || !answer) throw new Error(answer?.error || `Poise answered ${response.status}`)
      if (data && Array.isArray(answer.presets)) data.presets = answer.presets
      return true
    } catch (error) {
      say(`<span class="is-err">Not saved: ${esc((error as Error).message)}</span>`)
      return false
    } finally { busy = false }
  }
  async function saveCurrent(): Promise<void> {
    const input = ctx.rows.rowEl('presets')?.querySelector<HTMLInputElement>('[data-list-in]')
    const name = input?.value.trim() ?? ''
    if (!name) { input?.focus(); return }
    if (name.length > 40) { say('<span class="is-err">Not saved: a name is at most 40 characters.</span>'); return }
    if (busy) return
    const known = ctx.known()
    const places = Object.fromEntries((data?.places ?? []).map((p) => [p.key, { slot: placeNow(known, p.key) }]))
    if (await post('/api/models/presets', { name, models: { slots: slotsNow(known), places } })) {
      ctx.rows.rerow('presets')
      say(`<span class="sdot is-saved"></span>Saved the current choices as “${esc(name)}”`)
    }
  }
  async function use(p: Preset): Promise<void> {
    const before = ctx.known().models
    const outcome = await ctx.queue.send('presets', wholeSave(p.models))
    if (outcome.kind === 'saved') {
      undo = { models: before, name: p.name }
      ctx.rerender()
      say(`<span class="sdot is-saved"></span>Using “${esc(p.name)}” · from the next chat, review and run · <button type="button" class="lnk" data-act="undo-use" data-ref="set.undo">Undo</button>`)
      ctx.after(UNDO_MS, () => { if (undo?.name === p.name) { undo = null; say('') } })
    } else if (outcome.kind !== 'superseded') say(`<span class="is-err">“${esc(p.name)}” could not be used: ${esc(outcome.kind === 'failed' ? outcome.message : 'the models changed in another tab; read them again')}</span>`)
  }
  function remove(p: Preset, button: HTMLElement): void {
    if (!button.classList.contains('is-armed')) {
      button.classList.add('is-armed')
      button.textContent = 'Sure?'
      ctx.after(3000, () => { if (button.isConnected && button.classList.contains('is-armed')) { button.classList.remove('is-armed'); button.innerHTML = '<i data-i="cross" class="sm"></i>'; ctx.rows.rerow('presets') } })
      return
    }
    // Held for eight seconds with Undo, then deleted.
    held.set(p.name, setTimeout(() => {
      held.delete(p.name)
      void post('/api/models/presets/delete', { name: p.name }).then((ok) => { ctx.rows.rerow('presets'); if (ok) say(`Deleted “${esc(p.name)}” · the places keep their choices`) })
    }, UNDO_MS))
    ctx.signal.addEventListener('abort', () => { const t = held.get(p.name); if (t) { clearTimeout(t); held.delete(p.name); void post('/api/models/presets/delete', { name: p.name }) } })
    ctx.rows.rerow('presets')
    say(`“${esc(p.name)}” will be deleted · <button type="button" class="lnk" data-act="undo-delete" data-name="${esc(p.name)}" data-ref="set.undo">Undo</button>`)
  }
  const row: Row = {
    key: 'presets', group: 'Saved configurations', label: 'Your configurations', type: 'custom', wide: true,
    gloss: 'The three models and every place’s slot under one name. Use one to switch them all at once.',
    findText: () => (data?.presets ?? []).map((p) => p.name).join(' '),
    now: () => { const on = list().find(inUse); return `${list().length} saved configurations${on ? `; ${on.name} is in use` : ''}.` },
    control: () => `<div class="flist" data-flist>${list().map((p) => `<div class="frow" data-item="${esc(p.name)}" data-ref="set.preset.row"><span class="fmain"><span class="name">${esc(p.name)}</span><span class="fsub">${esc(p.models.slots?.primary ?? '')} first · saved ${esc(shortTime(p.savedAt, effectiveTimezone(), Date.now()))}</span></span><span class="fstate">${inUse(p) ? '<span class="fnote">In use</span>' : ''}</span><span class="facts">${inUse(p) ? '' : '<button type="button" class="btn-ghost" data-act="use" data-ref="set.preset.use">Use</button>'}</span><button type="button" class="ib" data-act="delete" aria-label="Delete ${esc(p.name)}" data-ref="set.preset.delete"><i data-i="cross" class="sm"></i></button></div>`).join('') || '<p class="fnone">None saved yet.</p>'}</div><div class="fadd"><input class="sinput" maxlength="40" placeholder="Name the current choices" aria-label="Name for the current choices" autocomplete="off" spellcheck="false" data-list-in data-ref="set.preset.name"><button type="button" class="btn-ghost" data-act="save" data-ref="set.preset.save">Save</button></div>`,
    act: (act, el) => {
      const name = el.closest<HTMLElement>('[data-item]')?.dataset.item ?? el.dataset.name ?? ''
      const preset = (data?.presets ?? []).find((p) => p.name === name)
      if (act === 'save') void saveCurrent()
      if (act === 'use' && preset) void use(preset)
      if (act === 'delete' && preset) remove(preset, el)
      if (act === 'undo-delete') { const t = held.get(name); if (t) { clearTimeout(t); held.delete(name) } ctx.rows.rerow('presets'); say(`“${esc(name)}” is back, as it was`) }
      if (act === 'undo-use' && undo) {
        const back = undo
        undo = null
        void ctx.queue.send('presets', wholeSave(back.models)).then((outcome) => {
          ctx.rerender()
          say(outcome.kind === 'saved' ? 'Back to the choices you had' : `<span class="is-err">Not put back: ${esc(outcome.kind === 'failed' ? outcome.message : 'the models changed meanwhile')}</span>`)
        })
      }
    },
    mounted: (el) => el.querySelector<HTMLInputElement>('[data-list-in]')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void saveCurrent() } }, { signal: ctx.signal }),
  }
  return row
}

let checking: { started: number, step: string } | null = null
function catalogRow(ctx: SectionContext): Row {
  const checkedWords = (): string => {
    const report = data?.refresh
    const at = report?.completed_at || report?.checked_at
    return at && Number.isFinite(Date.parse(at)) ? `checked ${shortTime(at, effectiveTimezone(), Date.now())}` : 'not checked yet; the daily check runs at 07:00'
  }
  async function check(): Promise<void> {
    if (checking) return
    checking = { started: Date.now(), step: 'updating provider CLIs, then checking models' }
    ctx.rows.rerow('catalog')
    const tick = () => { if (checking) ctx.rows.lstat(row, `${stateHTML('running', `${checking.step} · ${Math.floor((Date.now() - checking.started) / 1000)} s`)} <span class="fnote">chats continue meanwhile</span>`) }
    tick()
    const ticker = setInterval(tick, 1000)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), MODEL_CHECK_TIMEOUT_MS)
    let said: string
    try {
      const response = await fetch('/api/models/refresh', { method: 'POST', signal: controller.signal })
      const report = await response.json().catch(() => null) as (ModelRefreshReport & { error?: string }) | null
      if (!response.ok || !report) throw new Error(report?.error || 'the model check failed')
      const before = new Set((data?.catalog.models ?? []).map((m) => m.identity))
      await read()
      if (data) data.refresh = report
      const added = (data?.catalog.models ?? []).filter((m) => !before.has(m.identity)).map((m) => m.identity)
      const summary = modelRefreshSummary(report)
      said = `${stateHTML(summary.level === 'error' ? 'failed' : 'done', esc(checkedWords()))} <span class="fnote">${esc(added.length ? `${added.length} new: ${added.join(', ')}; every place can choose ${added.length === 1 ? 'it' : 'them'}.` : summary.text)}</span>`
    } catch (error) {
      said = `${stateHTML('failed')} <span class="is-err">${controller.signal.aborted ? 'The model check timed out; the latest versions could not be confirmed. Your choices are kept.' : `The model check failed: ${esc((error as Error).message)}`}</span>`
    } finally {
      clearInterval(ticker)
      clearTimeout(deadline)
      checking = null
    }
    if (!ctx.signal.aborted) { ctx.rerender(); ctx.rows.lstat(ctx.rows.byKey('catalog') ?? row, said) }
  }
  const row: Row = {
    key: 'catalog', group: 'Catalog', label: 'Model catalog', type: 'custom',
    gloss: 'Where every model choice comes from. Poise checks it daily at 07:00 in your time zone; Check now also updates the provider CLIs.',
    findText: () => (data?.catalog.models ?? []).map((m) => m.identity).join(' '),
    control: () => `<span class="cline"><span class="fnote" data-ref="set.catalog">${data ? `${data.catalog.models.length} models · ${esc(checkedWords())}` : esc(failure || 'Reading the catalog…')}</span><button type="button" class="btn-ghost" data-act="check" data-ref="set.catalog.check"${checking ? ' aria-disabled="true"' : ''}>Check now</button></span>`,
    act: (act) => { if (act === 'check') void check() },
  }
  return row
}

export const MODELS: SectionDef = {
  key: 'models',
  name: 'Models',
  what: 'The three models, the slot each place runs, the configurations you saved, and the catalog they come from.',
  load: async () => { if (!data) await read() },
  rows: (ctx) => {
    if (!data) {
      return [{ key: 'catalog-failed', ref: 'set.catalog', group: 'The three models', label: 'Models', type: 'custom', plain: true, gloss: 'The three models every place runs.',
        control: () => `<p class="is-err" role="alert">${esc(failure || 'The model catalog is not read yet.')}</p><button type="button" class="btn-ghost" data-act="retry">Retry</button>`,
        act: () => { void read().then(() => ctx.rerender()) } }]
    }
    const options = data.catalog.models.map((m): [string, string] => [m.identity, m.identity])
    const storedSlots = record(modelsOf(ctx.known()).slots)
    const slotsRow: Row = {
      key: 'models.slots', ref: 'set.models.slots', group: 'The three models', label: 'Models', type: 'select', wide: true,
      gloss: 'Chosen once. Every place below runs one of these, or draws one at Random on each run, so changing a slot changes it everywhere. When a model fails before its verdict, the run moves to a slot it has not tried yet.',
      value: () => slotsNow(ctx.known()),
      ...(Object.keys(storedSlots).length ? {} : { def: slotsNow(ctx.known()), defWords: 'Caller’s choices' }),
      applies: 'from the next chat, review and run',
      words: (v) => SLOTS.map((s) => `${SLOT_WORDS[s]} ${(v as Record<Slot, string>)[s]}`).join('; '),
      check: (v) => {
        const value = v as Record<Slot, string>
        const clash = SLOTS.find((s, i) => SLOTS.slice(0, i).some((t) => value[t] === value[s]))
        return clash ? `${SLOT_WORDS[clash]} is already ${value[clash]} in another slot; change that slot first, as the three must be different models` : ''
      },
      control: (row) => `<div class="pgrid">${SLOTS.map((s) => `<label class="pl"><span class="t-micro">${SLOT_WORDS[s]}</span>${selectHTML(row, { value: row.value?.(), part: s, label: `${SLOT_WORDS[s]} model`, options })}</label>`).join('')}</div>`,
      meta: () => data!.slots.notes.map((n) => `<span class="is-attn">${esc(n)}</span>`).join('<br>'),
      save: (v) => slotsSave(v as Record<Slot, string>),
    }
    const places = data.places.map((p): Row => ({
      key: `models.${p.key}`, ref: 'set.models.place', group: 'Where each one runs', label: p.label, gloss: esc(p.why), type: 'seg',
      options: [['primary', 'Primary'], ['secondary', 'Secondary'], ['tertiary', 'Tertiary'], ['random', 'Random']],
      value: () => placeNow(ctx.known(), p.key), def: 'primary', defWords: 'Primary', applies: APPLIES[p.key] ?? 'from the next run',
      words: (v) => (v === 'random' ? 'Random: one of the three, drawn on each run' : `${SLOT_WORDS[String(v)]}: ${slotsNow(ctx.known())[v as Slot]}`),
      meta: () => [
        p.reviewers ? 'When Behaviors asks for more than one reviewer, the slots after this one review too; Random draws different models.' : '',
        ...p.notes.map((n) => `<span class="is-attn">${esc(n)}</span>`),
      ].filter(Boolean).join('<br>'),
      save: (v) => placeSave(p.key, String(v)),
    }))
    const fixed: Row = {
      key: 'fixed', group: 'Set by Caller', label: 'Fixed models', type: 'custom', wide: true, plain: true,
      gloss: 'Places whose model the Caller catalog sets. They change when Caller does.',
      findText: () => data!.fixed.map((f) => `${f.label} ${f.model}`).join(' '),
      control: () => `<div class="flist">${data!.fixed.map((f) => `<div class="frow" data-ref="set.fixed.row"><span class="fmain"><span class="name${f.label.startsWith('/') ? ' t-mono' : ''}">${esc(f.label)}</span><span class="fsub">${esc(f.why)}</span></span><span class="fstate"><span class="fnote t-mono">${esc(f.model)}</span></span></div>`).join('')}</div>`,
    }
    return [slotsRow, ...places, presetsRow(ctx), fixed, catalogRow(ctx)]
  },
}
