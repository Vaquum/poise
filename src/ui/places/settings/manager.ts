// Settings → Manager (#556; SETTINGS.md, "Manager", brief 6): the three
// controls read together, Rhythm, Stability ↔ Expansion and Autonomy, the pause
// and the scope, all stored on main since 24 October as `manager` in the
// settings and carried by every Manager turn; how often the Manager wakes,
// on the same route as its header's control; and its standing instructions,
// the /manager snippet, edited in Snippets.
import { esc } from '../../dom'
import { placeHref } from '../../address'
import { effectiveTimezone } from '../../../config'
import { WAKE_OPTIONS, wakeStatusText, type ManagerWakeView, type WakeMinutes } from '../../../chat-manager-settings-types'
import { leaf, type Known } from './save'
import type { Row } from './rows'
import type { SectionContext, SectionDef } from './types'

// The five positions and their words are main's (server/chat/manager-policy.ts
// and server/settings.ts): every Manager turn carries the words you chose.
const STABILITY: [string, string, string][] = [
  ['Stability', 'Keep this Poise on the version it has. Track releases; never ask to install.', 'It keeps this Poise on its version and never asks to install a release.'],
  ['Lean to stability', 'Keep this Poise on the version it has. Track releases and ask to install them.', 'It keeps this Poise on its version and asks you before installing a release.'],
  ['Balanced', 'Tell me first, and install minor releases automatically.', 'It tells you first, and installs minor releases by itself.'],
  ['Lean to expansion', 'Install releases automatically, and tell me first.', 'It installs releases by itself, and tells you first.'],
  ['Full expansion', 'Install releases automatically.', 'It installs releases by itself.'],
]
const AUTONOMY: [string, string, string, string][] = [
  ['Ask first', 'Nothing on my behalf.', 'Everything: review and approve all of it.', 'It decides nothing on your behalf and brings you everything.'],
  ['Ask on judgement calls', 'The no-brainers; my charter defines them.', 'Everything else.', 'It decides the no-brainers your charter defines and brings you everything else.'],
  ['Balanced', 'The routine work.', 'Anything irreversible, and anything you’re unsure about.', 'It decides the routine work and brings you anything irreversible, and anything it is unsure about.'],
  ['Ask on the irreversible', 'Everything but the irreversible.', 'The irreversible.', 'It decides everything but the irreversible, which it brings to you.'],
  ['Standing instructions', 'Everything my charter allows.', 'Only what the charter says to bring.', 'It decides everything your charter allows and brings you only what the charter says to bring.'],
]
const DEFAULTS = { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null as string[] | null, paused: false }

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const managerOf = (known: Known) => ({ ...DEFAULTS, ...record(known.manager) }) as typeof DEFAULTS & { version?: number }
const scopeWords = (v: string[] | null): string => (v == null ? 'every followed repository' : v.length ? v.join(', ') : 'no repositories')
const upper = (t: string) => t.replace(/^./, (c) => c.toUpperCase())
function effect(known: Known): string {
  const m = managerOf(known)
  const s = STABILITY.find(([n]) => n === m.stability) ?? STABILITY[2]
  const a = AUTONOMY.find(([n]) => n === m.autonomy) ?? AUTONOMY[2]
  return `Up to ${m.rhythm} worker${m.rhythm > 1 ? 's' : ''} at once. ${s[2]} ${a[3]}${m.paused ? ' New work waits until you resume.' : ''}`
}
const slotsHTML = (n: number) => [...Array(10)].map((_, k) => `<span class="slot ${k < n ? 'free' : 'off'}"></span>`).join('')

// ---------- Wake-ups: the Manager header's control, on its route ----------
let wake: ManagerWakeView | null = null
let wakeError = ''
async function readWake(): Promise<void> {
  try {
    const response = await fetch('/api/chat/manager/wake', { cache: 'no-store' })
    const data = await response.json().catch(() => null) as (ManagerWakeView & { error?: string }) | null
    if (!response.ok) throw new Error(data?.error || `Poise answered ${response.status}`)
    if (!data || !(WAKE_OPTIONS as readonly number[]).includes(data.everyMinutes)) throw new Error('an unexpected answer')
    wake = data
    wakeError = ''
  } catch (error) {
    wakeError = `the wake interval could not be read: ${(error as Error).message}`
  }
}
async function saveWake(minutes: number): Promise<void> {
  const response = await fetch('/api/chat/manager/wake', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ everyMinutes: minutes, revision: wake?.revision ?? 0 }) })
  const data = await response.json().catch(() => null) as (ManagerWakeView & { error?: string }) | null
  if (response.status === 409) { await readWake(); throw new Error('the wake interval changed in another tab; it shows what is saved now') }
  if (!response.ok || !data || !(WAKE_OPTIONS as readonly number[]).includes(data.everyMinutes)) throw new Error(data?.error || `Poise answered ${response.status}`)
  wake = data
}

// ---------- Scope: every followed repository, or the ones you choose ----------
let repos: string[] | null = null
async function readRepos(): Promise<void> {
  try {
    const response = await fetch('/api/repos', { cache: 'no-store' })
    const data = await response.json().catch(() => null) as { repos?: string[] } | null
    repos = Array.isArray(data?.repos) ? data!.repos! : []
  } catch { repos = [] }
}

function stopsRow(ctx: SectionContext, kind: 'stability' | 'autonomy', label: string, gloss: string, names: string[], policy: (i: number) => string): Row {
  const index = (v: unknown) => Math.max(0, names.indexOf(String(v)))
  const row: Row = {
    key: `mgr.${kind}`, ref: `mgr.${kind}`, group: 'Controls', label, gloss, type: 'custom', wide: true,
    value: () => managerOf(ctx.known())[kind], def: 'Balanced', applies: 'from the Manager’s next turn',
    control: (r) => {
      const at = index(ctx.rows.shown(r))
      return `<div class="stops" role="radiogroup" aria-label="${esc(label)}">${names.map((n, i) => `<button type="button" role="radio" aria-checked="${i === at}" tabindex="${i === at ? 0 : -1}" data-act="stop" data-v="${esc(n)}" data-ref="mgr.${kind}"><i></i>${esc(n)}</button>`).join('')}</div><p class="spolicy" data-policy>${policy(at)}</p>`
    },
    painted: (r, el) => {
      const at = index(ctx.rows.shown(r))
      el.querySelectorAll<HTMLElement>('[data-act="stop"]').forEach((b, i) => { b.setAttribute('aria-checked', String(i === at)); b.tabIndex = i === at ? 0 : -1 })
      const p = el.querySelector('[data-policy]')
      if (p) p.innerHTML = policy(at)
      paintEffect(ctx)
    },
    act: (act, el) => { if (act === 'stop') ctx.rows.commit(row, el.dataset.v) },
    onKey: (e, r) => {
      const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key]
      if (!step || !(e.target as Element).closest('[role="radiogroup"]')) return false
      e.preventDefault()
      const next = names[Math.max(0, Math.min(names.length - 1, index(ctx.rows.shown(r)) + step))]
      ctx.rows.commit(row, next)
      ctx.rows.rowEl(row.key)?.querySelector<HTMLElement>(`[data-act="stop"][data-v="${CSS.escape(next)}"]`)?.focus()
      return true
    },
    save: (v) => leaf('manager', kind, v),
  }
  return row
}

function paintEffect(ctx: SectionContext): void {
  const el = ctx.rows.rowEl('mgr.effect')
  if (!el) return
  const sentence = el.querySelector('[data-effect]'), scope = el.querySelector('[data-scope-line]')
  if (sentence) sentence.textContent = effect(ctx.known())
  if (scope) scope.textContent = `Scope: ${scopeWords(managerOf(ctx.known()).scope)}`
  el.dataset.now = effect(ctx.known())
}

let scopeOpen = false
function scopeRow(ctx: SectionContext): Row {
  const row: Row = {
    key: 'mgr.scope', ref: 'mgr.scope', group: 'Scope', label: 'Repositories', type: 'custom', wide: true,
    gloss: 'Where the Manager may bind work: every followed repository, or only the ones you choose. With none, it binds nothing.',
    value: () => managerOf(ctx.known()).scope, def: null, defWords: 'every followed repository', applies: 'from the Manager’s next turn',
    words: (v) => upper(scopeWords(v as string[] | null)),
    control: (r) => {
      const v = ctx.rows.shown(r) as string[] | null
      const panel = scopeOpen ? `<div class="bpanel" role="group" aria-label="Repositories the Manager works in"><div class="checks"><label class="check"><input type="checkbox" value="*"${v === null ? ' checked' : ''} data-check-all data-ref="set.mgr.scope.choose"><span>Every followed repository</span></label>${(repos ?? []).map((repo) => `<label class="check"><input type="checkbox" value="${esc(repo)}"${v === null || v.includes(repo) ? ' checked' : ''}${v === null ? ' disabled' : ''} data-check data-ref="set.mgr.scope.choose"><span class="t-mono">${esc(repo)}</span></label>`).join('')}</div>${repos === null ? '<p class="fnote">Reading the repositories…</p>' : ''}<div class="fbtns"><button type="button" class="btn-ghost" data-act="done" data-ref="set.beh.done">Done</button><button type="button" class="btn-ghost" data-act="cancel" data-ref="set.cancel">Cancel</button></div></div>` : ''
      return `<span class="cline"><span class="bval is-wrap" data-bval>${esc(upper(scopeWords(v)))}</span><button type="button" class="lnk" data-act="choose" aria-expanded="${scopeOpen}" data-ref="set.mgr.scope.choose">Choose</button></span>${panel}`
    },
    painted: (r, el) => { const b = el.querySelector('[data-bval]'); if (b) b.textContent = upper(scopeWords(ctx.rows.shown(r) as string[] | null)); paintEffect(ctx) },
    act: (act) => {
      if (act === 'choose' || act === 'cancel') {
        scopeOpen = act === 'choose' ? !scopeOpen : false
        if (scopeOpen && repos === null) void readRepos().then(() => ctx.rows.rerow(row.key))
        ctx.rows.rerow(row.key)
        if (scopeOpen) ctx.rows.rowEl(row.key)?.querySelector<HTMLElement>('[data-check-all]')?.focus()
      }
      if (act === 'done') {
        const el = ctx.rows.rowEl(row.key)
        const all = el?.querySelector<HTMLInputElement>('[data-check-all]')?.checked
        const chosen = [...(el?.querySelectorAll<HTMLInputElement>('[data-check]:checked') ?? [])].map((c) => c.value)
        scopeOpen = false
        ctx.rows.rerow(row.key)
        ctx.rows.commit(row, all ? null : chosen)
      }
    },
    mounted: (el) => el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement
      if (!t.matches('[data-check-all]')) return
      el.querySelectorAll<HTMLInputElement>('[data-check]').forEach((c) => { c.disabled = t.checked; if (t.checked) c.checked = true })
    }, { signal: ctx.signal }),
    save: (v) => leaf('manager', 'scope', v),
  }
  return row
}

export const MANAGER: SectionDef = {
  key: 'manager',
  name: 'Manager',
  what: 'The Manager’s three controls, what they add up to, where it works, what it always or never does, and how often it wakes.',
  load: async () => { await readWake() },
  rows: (ctx) => {
    const rhythm: Row = {
      key: 'mgr.rhythm', ref: 'mgr.rhythm', group: 'Controls', label: 'Rhythm', type: 'custom', wide: true,
      gloss: 'How many workers the Manager keeps on tasks at once. Each holds its slot from the moment it takes a task until you close its chat: running, waiting for you, blocked, between turns, or done. The Manager fills a free slot on its next turn, and its own chat never uses one.',
      value: () => managerOf(ctx.known()).rhythm, def: 5, applies: 'from the Manager’s next turn; workers over the limit finish their tasks',
      words: (n) => `${n} slot${n === 1 ? '' : 's'}`,
      control: (r) => {
        const n = Number(ctx.rows.shown(r))
        return `<div class="rhythm" data-rhythm><button type="button" class="ib" data-act="less" aria-label="One slot fewer" data-ref="mgr.rhythm"${n <= 1 ? ' aria-disabled="true"' : ''}><i data-i="minus"></i></button><output class="rh-n">${n}</output><button type="button" class="ib" data-act="more" aria-label="One slot more" data-ref="mgr.rhythm"${n >= 10 ? ' aria-disabled="true"' : ''}><i data-i="plus"></i></button><div class="slots" aria-hidden="true">${slotsHTML(n)}</div></div>`
      },
      painted: (r, el) => {
        const n = Number(ctx.rows.shown(r)), box = el.querySelector<HTMLElement>('[data-rhythm]')
        if (!box) return
        box.querySelector('.rh-n')!.textContent = String(n)
        box.querySelector('.slots')!.innerHTML = slotsHTML(n)
        box.querySelector('[data-act="less"]')!.setAttribute('aria-disabled', String(n <= 1))
        box.querySelector('[data-act="more"]')!.setAttribute('aria-disabled', String(n >= 10))
        paintEffect(ctx)
      },
      act: (act) => { const n = Number(ctx.rows.shown(rhythm)); ctx.rows.commit(rhythm, Math.max(1, Math.min(10, n + (act === 'more' ? 1 : -1)))) },
      save: (v) => leaf('manager', 'rhythm', Number(v)),
    }
    const wakeRow: Row = {
      key: 'mgr.wake', ref: 'mgr.wake', group: 'Wake-ups', label: 'Wake the Manager every', type: 'seg',
      gloss: 'How often Poise wakes the Manager to review the workspace. The same control sits in the Manager’s header. There is no off: put the Manager on hold to stop it.',
      options: WAKE_OPTIONS.map((m): [string, string] => [String(m), `${m} min`]), value: () => String(wake?.everyMinutes ?? 60), def: '60',
      applies: 'applies now; a wake-up already due still comes',
      words: (v) => `${v} minutes, up to ${1440 / Number(v)} turns a day`,
      meta: () => (wakeError ? `<span class="is-err">${esc(wakeError)}</span>` : wake ? esc(wakeStatusText(wake, effectiveTimezone(), Date.now())) : ''),
      persist: (v) => saveWake(Number(v) as WakeMinutes),
    }
    return [
      { key: 'mgr.effect', ref: 'mgr.effective', group: 'In effect', label: 'What the three add up to', type: 'custom', plain: true, wide: true,
        gloss: 'Your three controls, read together. They ride on every Manager turn with its scope and pause, and take precedence over its standing instructions.',
        now: () => effect(ctx.known()),
        control: () => `<div class="seffect" data-ref="mgr.effective"><p class="sentence" data-effect>${esc(effect(ctx.known()))}</p><span class="t-gloss" data-scope-line>Scope: ${esc(scopeWords(managerOf(ctx.known()).scope))}</span></div>` },
      rhythm,
      stopsRow(ctx, 'stability', 'Stability ↔ Expansion', 'How the Manager handles a new Poise release. Every Manager turn carries the words of the position you choose.',
        STABILITY.map(([n]) => n), (i) => `<b>${esc(STABILITY[i][0])}.</b> “${esc(STABILITY[i][1])}”`),
      stopsRow(ctx, 'autonomy', 'Autonomy', 'What the Manager decides on its own, and what it brings to you, in the words every Manager turn carries.',
        AUTONOMY.map(([n]) => n), (i) => `<span class="t-micro">Decides</span>${esc(AUTONOMY[i][1])}<span class="t-micro">Brings to you</span>${esc(AUTONOMY[i][2])}`),
      { key: 'mgr.paused', ref: 'mgr.paused', group: 'Controls', label: 'Pause new work', type: 'switch',
        gloss: 'New work waits until you resume: the Manager still wakes, watches and answers, and gives out no new ticket. Work in flight carries on.',
        value: () => (managerOf(ctx.known()).paused ? 'on' : 'off'), def: 'off', words: (v) => (v === 'on' ? 'Paused' : 'Not paused'), applies: 'from the Manager’s next turn',
        painted: () => paintEffect(ctx), save: (v) => leaf('manager', 'paused', v === 'on') },
      scopeRow(ctx),
      wakeRow,
      { key: 'mgr.instructions', ref: 'set.mgr.charter', group: 'Standing instructions', label: 'The /manager snippet', type: 'custom', plain: true, wide: true,
        gloss: 'What the Manager always or never does, in your words. Every Manager turn carries it, after your own request and before Memories.',
        findText: () => 'standing instructions manager charter',
        control: () => '<button type="button" class="btn-ghost" data-act="edit" data-ref="set.mgr.charter.edit">Edit in Snippets</button>',
        act: () => ctx.go('snippets') },
      { key: 'mgr.open', ref: 'set.mgr.open', group: 'In the Manager', label: 'The Manager’s chat and the Switchboard', type: 'custom', plain: true,
        gloss: 'What the Manager and its workers are doing sits with the Manager, beside its chat. These are observations of work in progress, not settings.',
        control: () => `<a class="btn-ghost" href="${esc(placeHref('manager', { back: 'settings' }))}" data-ref="set.mgr.open"><i data-i="sliders" class="sm"></i>Open the Manager</a>` },
    ]
  },
}
