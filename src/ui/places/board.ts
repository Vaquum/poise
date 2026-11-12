// Board (#556 PR 3): your cards beside live issues and pull requests, in the
// seven states; Lanes or List, with Assign to Poise. Ported from the mocks'
// board.html and current.js, on the endpoints classic's Current uses
// (src/views/current-view.ts); docs/design/interface/poise-ds/CURRENT.md says why.
import './board.css'
// A card's chat opens in classic's side pane, styled with Chat's sheet.
import './chat/classic.css'
import './chat/chat.css'
import { $, $$, esc, store } from '../dom'
import { hydrateIcons, icon } from '../icons'
import { term } from '../registry'
import { paintTerms } from '../reference'
import { closeMenus, lifeTo, motion, routeBack, toast, type Stage } from '../shell'
import { placeHref } from '../address'
import type { MountPlace } from '../router'
import { getOrganizations, loadSettings, startRefreshTicker } from '../../config'
import { CURRENT_FILTER_KEY, timeRangeWindow, type TimeRange } from '../../time-range'
import { ORGANIZATION_STORAGE_KEY, setSelectedOrganization } from '../../organizations'
import { noticeFeed } from '../../notices'
import { registerReloadGuard } from '../../self-update-guards'
import { chatSidePane } from '../../views/chat-side-pane'
import { readJournalPage, eventWords, timelineLines, type ChainRow, type ChainCapacity } from './observe/chains'
import { readNewest } from './observe/journal'
import { railHTML } from './observe/tasks'
import { BOARD_REF } from './board/registry'
import { register } from '../registry'
import {
  STATES, ago, canAssign, dwell, isNew, isSettled, itemKey, phaseOf, sortItems, toItem,
  type Item, type Lane, type MineLane, type Order, type StateKey,
} from './board/model'
import {
  assignIssue, createCard, deleteCard, editIssue, openIssue, readCards, readChains, readChats, readIntake, readIssue,
  readLabels, readLive, readPrStatus, readRepos, readRunning, runReview, updateCard, type Card, type ChatOn, type Intake, type RepoLabel,
} from './board/data'

register(BOARD_REF)

interface LaneDef { key: Lane, label: string, kind: 'mine' | 'live', gloss: string }
const LANES: LaneDef[] = [
  { key: 'idea', label: 'Idea', kind: 'mine', gloss: 'a thought worth keeping' },
  { key: 'concept', label: 'Concept', kind: 'mine', gloss: 'shaped enough to talk about' },
  { key: 'plan', label: 'Plan', kind: 'mine', gloss: 'ready to be written down' },
  { key: 'issue', label: 'Issue', kind: 'live', gloss: 'a task, live from GitHub' },
  { key: 'pr', label: 'PR', kind: 'live', gloss: 'a change, live from GitHub' },
]
const MINE: MineLane[] = ['idea', 'concept', 'plan']
const ORDERS: Record<Order, [string, string]> = {
  attention: ['Attention', 'Needs you, Blocked, Failed, Running, Waiting, Idle; Done at the end'],
  recent: ['Recent activity', 'Most recently updated first'],
  repo: ['Repository', 'By repository, then by attention'],
}

type Status = 'any' | 'open'
type By = 'updated' | 'opened'
type WhoFilter = 'any' | 'poise' | 'other'
type Layout = 'lanes' | 'list'
interface Filters { status: Status, time: TimeRange, org: string, layout: Layout, by: By, who: WhoFilter }
type FilterKey = keyof Filters

/** Classic's Current keeps `status` as all|open in the same key; Board reads and writes it that way.
 *  Board's view, what its time means and Who are its own (`poise-board`). */
const BOARD_KEY = 'poise-board'
function readFilters(): Filters {
  const saved = store.get<Record<string, unknown>>(CURRENT_FILTER_KEY, {})
  const own = { ...saved, ...store.get<Record<string, unknown>>(BOARD_KEY, {}) }
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed as readonly unknown[]).includes(value) ? value as T : fallback
  return {
    status: saved.status === 'open' ? 'open' : 'any',
    time: pick(saved.time, ['all', 'today', 'yesterday', 'week'] as const, 'all'),
    // The organization is Poise's one choice, shared with Overview and Observe; read before settings load.
    org: (() => { try { return localStorage.getItem(ORGANIZATION_STORAGE_KEY) || '' } catch { return '' } })(),
    layout: pick(own.layout, ['lanes', 'list'] as const, 'lanes'),
    by: pick(own.by, ['updated', 'opened'] as const, 'updated'),
    who: pick(own.who, ['any', 'poise', 'other'] as const, 'any'),
  }
}

/** What a writer holds: a new card, a card's edit, or the issue writer. */
interface IssueWriter {
  repo: string
  title: string
  body: string
  labels: string[]
  labelsOpen: boolean
  lq: string
  cleared: number
  /** The card it was opened from, deleted once the issue exists. */
  source: number | null
  /** An issue being edited, with the title and body it was loaded with. */
  edit: { number: number, expected: { title: string, body: string } } | null
  conflict: string
  err: string
  busy: boolean
}

export const mount: MountPlace = (ctx) => {
  const { root, signal, address, query } = ctx
  const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void, target: Document | HTMLElement = document) =>
    target.addEventListener(type, fn as EventListener, { signal })

  // ---------- Filters: yours, or a link's for this visit only ----------
  const F = readFilters()
  const linked: Partial<Filters> = {}
  const linkTo = <K extends FilterKey>(k: K, v: Filters[K]) => { if (!(k in linked)) (linked as Record<string, unknown>)[k] = F[k]; F[k] = v }
  for (const k of ['layout', 'by', 'who', 'time', 'status'] as const) {
    const v = query.get(k)
    if (v) linkTo(k, v as never)
  }
  const saveFilters = () => {
    const { layout, by, who, org, ...kept } = { ...F, ...linked }
    store.set(CURRENT_FILTER_KEY, { ...store.get<Record<string, unknown>>(CURRENT_FILTER_KEY, {}), ...kept, status: kept.status === 'open' ? 'open' : 'all' })
    store.set(BOARD_KEY, { layout, by, who })
    setSelectedOrganization(org)
  }
  const choose = (patch: Partial<Filters>) => {
    for (const [k, v] of Object.entries(patch)) { (F as unknown as Record<string, unknown>)[k] = v; delete (linked as Record<string, unknown>)[k] }
    saveFilters()
  }
  let order: Order = (['attention', 'recent', 'repo'] as const).includes(store.get<Order>('poise-current-order', 'attention')) ? store.get<Order>('poise-current-order', 'attention') : 'attention'
  let search = ''
  let only: StateKey | null = STATES.includes(query.get('state') as StateKey) ? query.get('state') as StateKey : null
  const folds = store.get<Record<string, boolean>>('poise-current-folds', {})

  // ---------- What Board knows ----------
  let cards: Card[] = []
  let items: Item[] = []
  let repos: string[] = []
  let intake: Intake | null = null
  let capacity: ChainCapacity | null = null
  let chats = new Map<string, ChatOn>()
  let truncated = false
  let readOnce = false
  /** GitHub's issues and pull requests have been read at least once: until then nothing reads as zero. */
  let liveRead = false
  const failures = new Map<string, string>()
  /** Issues opened here, shown at once until GitHub's copy arrives. */
  const pending = new Map<string, Item>()
  /** Confirmed assignments, shown until the intake read has them. */
  const assigned = new Map<string, number>()
  const assignErrors = new Map<string, string>()
  const LIFE = new Map<string, [Stage, string, boolean]>()
  let sideFor: string | null = null
  let sideMode: 'about' | 'task' | null = null

  // ---------- The page ----------
  root.innerHTML = `<main class="cur">
    <div class="cur-head">
      <div class="cur-filters">
        <a class="back" href="#" data-back hidden data-ref="back"></a>
        <div class="fgrp"><span class="t-micro">Scope</span><button class="pick" data-menu="board-org-menu" aria-haspopup="menu" aria-expanded="false" data-ref="cur.scope"><span data-org-label>All orgs</span></button></div>
        <div class="fgrp"><span class="t-micro">Shows</span>
          <div class="seg" role="group" aria-label="Status" data-filter="status" data-ref="cur.status"><button aria-pressed="true" data-v="any">Any</button><button aria-pressed="false" data-v="open">Open</button></div>
          <div class="seg" role="group" aria-label="When" data-filter="time" data-ref="cur.time"><button aria-pressed="true" data-v="all">Any time</button><button aria-pressed="false" data-v="today">Today</button><button aria-pressed="false" data-v="yesterday">Yesterday</button><button aria-pressed="false" data-v="week">This week</button></div>
          <div class="seg" role="group" aria-label="Time means" data-filter="by" data-ref="cur.by"><button aria-pressed="true" data-v="updated">Updated</button><button aria-pressed="false" data-v="opened">Opened</button></div>
          <input class="search" type="search" placeholder="Filter…" aria-label="Filter cards" data-search data-ref="cur.search">
        </div>
        <div class="fgrp"><span class="t-micro">Who</span><div class="seg" role="group" aria-label="Who has it" data-filter="who" data-ref="cur.who"><button aria-pressed="true" data-v="any">Anyone</button><button aria-pressed="false" data-v="poise">Poise</button><button aria-pressed="false" data-v="other">Not Poise</button></div></div>
        <div class="fgrp push"><span class="t-micro">Order</span><button class="order-btn" data-menu="board-order-menu" aria-haspopup="menu" aria-expanded="false" data-ref="cur.order"><span data-order-label>Attention</span>${icon('down', 'sm')}</button><span class="held" role="status" data-ref="cur.held" hidden></span></div>
      </div>
      <div class="cur-sumrow">
        <div class="cur-sum" role="group" aria-label="In motion" data-sum><span class="t-micro" data-ref="cur.summary">In motion</span></div>
        <div class="fgrp"><span class="t-micro">View</span><div class="seg" role="group" aria-label="View" data-filter="layout" data-ref="cur.view"><button aria-pressed="true" data-v="lanes">Lanes</button><button aria-pressed="false" data-v="list">List</button></div></div>
      </div>
      <p class="cur-partial" role="status" data-ref="cur.partial" hidden></p>
    </div>
    <div class="lanes" data-lanes aria-busy="true"></div>
    <aside class="bside" data-bside hidden aria-label="Beside the board"></aside>
  </main>
  <div class="menu" id="board-org-menu" hidden role="menu" aria-label="Organization"></div>
  <div class="menu order-menu" id="board-order-menu" hidden role="menu" aria-label="Order">${(Object.entries(ORDERS) as [Order, [string, string]][]).map(([k, [name, gloss]]) => `<button class="menu-row" role="menuitemradio" data-order="${k}" aria-checked="false" data-ref="cur.order"><b>${name}</b><span>${gloss}</span></button>`).join('')}</div>`
  routeBack($('[data-back]', root), address)
  const lanesEl: HTMLElement = $('[data-lanes]', root)
  const sumEl: HTMLElement = $('[data-sum]', root)
  const sideEl: HTMLElement = $('[data-bside]', root)
  const curEl: HTMLElement = $('.cur', root)

  // ---------- What shows, and in what order ----------
  const now = () => Date.now()
  const timeWindow = () => timeRangeWindow(F.time)
  const inWindow = (at: number) => {
    const w = timeWindow()
    return (!w.since || at >= Date.parse(w.since)) && (!w.until || at < Date.parse(w.until))
  }
  const inOrg = (repo: string | null) => !F.org || !repo || repo.split('/')[0].toLowerCase() === F.org.toLowerCase()
  const matches = (...hay: (string | null | undefined)[]) => !search || hay.some((h) => (h || '').toLowerCase().includes(search.toLowerCase()))
  const filtersOn = () => F.status !== 'any' || F.time !== 'all' || !!search || !!only || F.who !== 'any'
  const everyIssueEnters = () => capacity?.intake?.seedMode === 'all'
  const chainOff = () => !!capacity && (capacity.enabled === false || capacity.mode === 'v1')
  const allItems = (): Item[] => [...items, ...[...pending.values()].filter((p) => !items.some((it) => it.id === p.id))]
  const shown = (): Item[] => allItems().filter((it) => inOrg(it.repo)
    && (F.by === 'opened' ? inWindow(it.openedAt) : true)
    && (F.status === 'any' || !isSettled(it))
    && matches(it.title, it.repo, `#${it.num}`, it.chain ? `#${it.chain.issue}` : '')
    && (F.who === 'any' || (F.who === 'poise') === (it.who?.kind === 'poise')))
  const byId = (id: string): Item | undefined => allItems().find((it) => it.id === id)
  const cardById = (id: string): Card | undefined => cards.find((c) => String(c.id) === id)
  const minutesSince = (iso: string) => Math.max(0, (now() - Date.parse(iso)) / 60_000)

  // ---------- Progress on the card itself ----------
  function life(id: string, stage: Stage, label: string, skipQueued = true, clearAfter = 0): void {
    LIFE.set(id, [stage, label, skipQueued])
    const el = $(`.card[data-id="${CSS.escape(id)}"] .life`, lanesEl)
    if (el) { el.hidden = false; lifeTo(el, stage, label, skipQueued) }
    if (clearAfter) ctx.after(clearAfter, () => {
      if (LIFE.get(id)?.[0] !== stage) return
      LIFE.delete(id)
      const e = $(`.card[data-id="${CSS.escape(id)}"] .life`, lanesEl)
      if (e) e.hidden = true
    })
  }
  const lifeEl = (id: string) => `<div class="life" data-ref="life"${LIFE.has(id) ? '' : ' hidden'}></div>`
  const clock = () => new Date().toTimeString().slice(0, 5)

  // ---------- Who has it ----------
  function who(it: Item): Item['who'] {
    if (it.who) return it.who
    const chat = chats.get(itemKey(it.repo, it.num))
    if (!chat) return null
    return chat.role === 'worker'
      ? { tag: 'Worker', kind: 'worker', href: placeHref('chat', { chat: chat.id, back: 'board' }) }
      : { tag: 'Chat', kind: 'chat', href: placeHref('chat', { chat: chat.id, back: 'board' }) }
  }
  const whoHref = (it: Item): string => {
    const w = who(it)
    if (!w) return ''
    if (w.kind === 'poise') return it.chain ? placeHref('observe', { part: 'tasks', chain: it.chain.id, back: 'board' }) : placeHref('observe', { part: 'tasks', back: 'board' })
    if (w.kind === 'run') return placeHref('observe', { part: 'behaviors', pr: `${it.repo}#${it.num}`, back: 'board' })
    return w.href
  }

  // ---------- Rendering ----------
  const W = new Map<string, unknown>()   // open writers: add.<lane>, issue, edit.<id>
  const drafts = new Map<string, Record<string, string>>()
  const issueW = (): IssueWriter | null => (W.get('issue') as IssueWriter | undefined) ?? null
  const repoOptions = (sel: string | null, none = true) => `${none ? `<option value=""${sel ? '' : ' selected'}>No repository</option>` : ''}${(sel && !repos.includes(sel) ? [sel, ...repos] : repos).map((r) => `<option${r === sel ? ' selected' : ''}>${esc(r)}</option>`).join('')}`
  const actsMine = `<div class="card-acts"><button class="ib" data-act="copy" aria-label="Copy" data-ref="card.copy">${icon('copy', 'sm')}</button><button class="ib" data-act="chat" aria-label="Chat about this" data-ref="card.chat">${icon('chat', 'sm')}</button><button class="ib" data-act="to-issue" aria-label="Open as issue…" data-ref="card.to-issue">${icon('issue', 'sm')}</button><button class="ib" data-act="del" aria-label="Delete card" data-ref="card.delete">${icon('cross', 'sm')}</button></div>`

  function mineHTML(c: Card): string {
    if (W.has(`edit.${c.id}`)) {
      return `<article class="card is-editing" data-id="${c.id}" data-kind="mine" data-ref="card.edit"><div class="writer" data-writer="edit.${c.id}"><textarea data-w="edit-text" aria-label="Card text" rows="3">${esc(c.text)}</textarea><div class="row"><select data-w="edit-repo" aria-label="Linked repository" data-ref="composer.repo">${repoOptions(c.repo)}</select><span class="spacer"></span><button class="btn btn-line" data-act="w-cancel" data-w-key="edit.${c.id}">Cancel</button><button class="btn btn-primary" data-act="w-save" data-id="${c.id}">Save</button></div></div></article>`
    }
    return `<article class="card" data-id="${c.id}" data-kind="mine" tabindex="0" draggable="true" data-ref="card.manual" aria-label="Card: ${esc(c.text.slice(0, 60))}"><div class="card-text">${esc(c.text)}</div><div class="card-meta">${c.repo ? `<span class="repo">${esc(c.repo)}</span>` : ''}<time>${ago(minutesSince(c.updated_at))}</time></div>${lifeEl(String(c.id))}${actsMine}</article>`
  }

  const intakeHTML = (it: Item): string => {
    if (!intake || it.lane !== 'issue' || it.chain || isSettled(it)) return ''
    const prs = it.closing ?? []
    return prs.length
      ? prs.map((p) => `<a class="intake" href="${esc(p.url)}" target="_blank" rel="noopener" data-ref="card.intake" title="An open pull request that closes this issue. The chain does not take an issue that has one.">PR #${p.number}</a>`).join('')
      : '<span class="intake dim" data-ref="card.intake" title="No open pull request closes this issue.">no open PR</span>'
  }
  const ASSIGN_WHAT = 'Adds the chain’s label on GitHub, as you. The chain takes the issue at its next check.'
  const assignable = (it: Item) => canAssign({ ...it, who: who(it) }, !!intake, everyIssueEnters()) && !assigned.has(it.id.toLowerCase())
  const assignHTML = (it: Item, cls = 'btn-ghost card-assign') => (assignable(it)
    ? `<button class="${cls}" data-act="assign" data-id="${esc(it.id)}" data-ref="card.assign" title="${chainOff() ? 'Adds the chain’s label on GitHub, as you. The chain is off, so it takes the issue once it is on.' : ASSIGN_WHAT}">Assign to Poise</button>` : '')
  const railFor = (it: Item): string => {
    if (it.chain) return railHTML(it.chain)
    const p = phaseOf(it)
    if (p.index === null) return `<span class="rail-w">${esc(p.word)}</span>`
    return `<span class="rail" data-ref="task.rail" role="img" aria-label="${esc(`Phase: ${p.word}`)}">${Array.from({ length: 7 }, (_, i) => `<i class="${i < p.index! ? 'p' : i === p.index ? 'c' : ''}"${i === p.index ? ` data-state="${it.state ?? ''}"` : ''}></i>`).join('')}</span><span class="rail-w">${esc(p.word)}</span>`
  }

  /** The state's dot and word; nothing when its status could not be read. */
  const stateHTML = (it: Item): string => it.state ? `<span class="sc" data-state="${it.state}"></span><b>${term(`state.${it.state}`)}</b>` : ''

  function liveHTML(it: Item): string {
    const settled = isSettled(it), list = F.layout === 'list', w = who(it)
    const d = dwell(it, now())
    const detail = settled ? (it.record.state === 'merged' ? 'merged' : 'closed') : it.detail
    const said = list ? esc(detail) : detail ? `${esc(detail)}${d.stuck ? ` · <span class="stuck" data-ref="card.stuck">${esc(d.text)}</span>` : ''}` : ''
    const refusal = assignErrors.get(it.id)
    const stateRow = list || assignable(it) || it.state !== 'idle' || detail || w
      ? `<div class="card-state" data-ref="card.state">${stateHTML(it)}${said ? `<span class="detail"${it.lane === 'pr' && !settled ? ' data-ref="card.blocker"' : ''}>${said}</span>` : ''}${list ? `<span class="dwell" data-ref="card.dwell">${d.stuck ? `<span class="stuck" data-ref="card.stuck">${esc(d.text)}</span>` : esc(d.text)}</span>` : ''}${w ? `<a class="wk${w.kind === 'poise' ? ' is-mgr' : w.kind === 'worker' ? '' : ' is-own'}" href="${esc(whoHref(it))}" data-ref="${w.kind === 'poise' ? 'card.chain' : 'card.worker'}">${esc(w.tag)}</a>` : ''}${assignHTML(it)}</div>${refusal ? `<p class="card-refusal" role="alert" data-ref="card.assign">${esc(refusal)}</p>` : ''}`
      : ''
    const rail = list || it.chain ? `<div class="card-rail">${railFor(it)}</div>` : ''
    const reviewWhy = settled ? `This pull request is ${it.record.state}: there is nothing to review.` : ''
    const primary = it.lane === 'pr'
      ? `<button class="ib" data-act="review" aria-label="Run PR review" data-ref="card.review"${settled ? ` aria-disabled="true" data-why="${esc(reviewWhy)}"` : ''}>${icon('play', 'sm')}</button>`
      : (!settled ? `<button class="ib" data-act="edit-issue" aria-label="Edit issue" data-ref="card.edit-issue">${icon('edit', 'sm')}</button>` : '')
    const num = it.chain && it.chain.pullNumber && it.lane === 'pr' ? `#${it.chain.issue} → #${it.num}` : `#${it.num}`
    return `<article class="card" data-id="${esc(it.id)}" data-kind="live" data-state="${it.state ?? ''}" tabindex="0" data-ref="card.live" aria-label="${it.lane === 'pr' ? 'Pull request' : 'Issue'} #${it.num}: ${esc(it.title)}">`
      + `<a class="card-title" href="${esc(it.url)}" target="_blank" rel="noopener" data-ref="card.link">${esc(it.title)}</a>`
      + `<div class="card-meta"><span class="repo">${esc(it.repo)}</span><span class="num">${num}</span>${isNew(it, now()) ? '<span class="new" data-ref="card.new">New</span>' : ''}${intakeHTML(it)}<time>${list ? `opened ${ago(minutesSince(it.record.created_at))} · changed ${ago(minutesSince(it.record.updated_at))}` : ago(minutesSince(it.record.updated_at))}</time></div>`
      + `${rail}${stateRow}${lifeEl(it.id)}<div class="card-acts"><button class="ib" data-act="copy" aria-label="Copy" data-ref="card.copy">${icon('copy', 'sm')}</button><button class="ib" data-act="chat" aria-label="Chat about this, beside the board" data-ref="card.chat">${icon('chat', 'sm')}</button>${it.chain ? `<button class="ib" data-act="task" aria-label="Open its timeline" data-ref="card.timeline">${icon('chev', 'sm')}</button>` : ''}<button class="ib" data-act="open-chat" aria-label="Open in Chat" data-ref="card.open-chat">${icon('session', 'sm')}</button>${primary}</div></article>`
  }

  function writerHTML(lane: LaneDef): string {
    const w = issueW()
    if (lane.key === 'issue' && w) {
      const n = w.labels.length
      const pop = w.labelsOpen ? labelsHTML(w) : ''
      const blocked = !!w.conflict || w.busy
      return `<div class="writer" data-writer="issue">${w.edit ? `<span class="t-micro" data-ref="composer.editing">Edit ${esc(w.repo)}#${w.edit.number}</span>` : ''}<input data-w="issue-title" placeholder="Issue title" aria-label="Issue title" data-ref="composer.title" value="${esc(w.title)}"${w.busy ? ' readonly' : ''}><textarea data-w="issue-body" rows="3" placeholder="What should happen, in plain words (optional)" aria-label="Issue body" data-ref="composer.body"${w.busy ? ' readonly' : ''}>${esc(w.body)}</textarea><div class="row"><select data-w="issue-repo" aria-label="Repository" data-ref="composer.repo"${w.edit || w.busy ? ' disabled' : ''}>${repoOptions(w.repo, false)}</select>${w.edit ? '' : `<button class="ib${n ? ' is-on' : ''}" data-act="labels" aria-label="Labels${n ? `, ${n} chosen` : ''}" aria-expanded="${w.labelsOpen}"${w.busy ? ' aria-disabled="true"' : ''} data-ref="composer.labels">${icon('tag', 'sm')}${n ? `<span class="n">${n}</span>` : ''}</button>`}<span class="spacer"></span><button class="btn btn-line" data-act="w-cancel" data-w-key="issue"${w.busy ? ' aria-disabled="true"' : ''} data-ref="composer.cancel">Cancel</button><button class="btn btn-primary" data-act="w-open-issue"${blocked ? ' aria-disabled="true"' : ''} data-ref="${w.edit ? 'composer.save-issue' : 'composer.open'}">${w.edit ? 'Save issue' : 'Open issue'}</button></div>${pop}${w.conflict ? `<p class="w-err" role="alert">${esc(w.conflict)} <button class="lnk" data-act="w-theirs">Load the latest</button></p>` : ''}${w.err ? `<p class="w-err" role="alert">${esc(w.err)}</p>` : ''}${w.cleared ? `<p class="t-gloss">Cleared ${w.cleared} label${w.cleared > 1 ? 's' : ''} chosen for the previous repository.</p>` : ''}</div>`
    }
    if (lane.kind === 'mine' && W.has(`add.${lane.key}`)) {
      return `<div class="writer" data-writer="add.${lane.key}"><textarea data-w="add-text" rows="3" placeholder="Write a card…" aria-label="Card text" data-ref="composer.text"></textarea><div class="row"><select data-w="add-repo" aria-label="Link a repository" data-ref="composer.repo">${repoOptions(null)}</select><span class="spacer"></span><button class="btn btn-line" data-act="w-cancel" data-w-key="add.${lane.key}" data-ref="composer.cancel">Cancel</button><button class="btn btn-primary" data-act="w-add" data-lane="${lane.key}" data-ref="composer.add">Add</button></div></div>`
    }
    return ''
  }
  let labels: { repo: string, list: RepoLabel[] | null, error: string } = { repo: '', list: null, error: '' }
  function labelsHTML(w: IssueWriter): string {
    const list = labels.repo === w.repo ? labels.list : null
    const shownLabels = (list ?? []).filter((l) => !w.lq || l.name.toLowerCase().includes(w.lq.toLowerCase()))
    const body = labels.repo === w.repo && labels.error
      ? `<p class="t-gloss">Could not load ${esc(w.repo)}’s labels: ${esc(labels.error)}. The issue still opens without them.</p>`
      : !list ? '<p class="t-gloss">Reading the labels…</p>'
        : shownLabels.length ? shownLabels.map((l) => `<label class="label-row" title="${esc(l.description || '')}"><input type="checkbox" value="${esc(l.name)}" data-label${w.labels.includes(l.name) ? ' checked' : ''}><span class="t-mono">${esc(l.name)}</span><span class="t-gloss">${esc(l.description || '')}</span></label>`).join('')
          : `<p class="t-gloss">${list.length ? 'No labels match.' : 'This repository has no labels.'}</p>`
    const notes = [w.labels.length ? `${w.labels.length} selected` : '', intake?.label && w.labels.includes(intake.label) ? `${intake.label}: it enters the chain` : ''].filter(Boolean).join(' · ')
    return `<div class="labels-pop" role="dialog" aria-label="Issue labels" data-ref="composer.labels"><input class="search" type="search" placeholder="Filter labels…" aria-label="Filter labels" data-labels-filter value="${esc(w.lq)}"><div class="labels-list" role="group" aria-label="Labels">${body}</div><div class="labels-foot">${esc(notes)}</div></div>`
  }

  function laneHTML(lane: LaneDef): string {
    const live = lane.kind === 'live'
    let open: (Item | Card)[] = []
    let done: Item[] = []
    if (live) {
      const all = shown().filter((it) => it.lane === lane.key && (!only || it.state === only))
      const fresh = all.filter((it) => pending.has(it.id))
      open = [...fresh, ...sortItems(all.filter((it) => !isSettled(it) && !pending.has(it.id)), order)]
      done = sortItems(all.filter((it) => isSettled(it) && !pending.has(it.id)), 'recent')
    } else {
      open = cards.filter((c) => c.lane === lane.key && inOrg(c.repo) && matches(c.text, c.repo)).sort((a, b) => a.position - b.position)
    }
    let lastRepo: string | null = null
    const body = open.map((x) => {
      const repo = (x as Item).lane ? (x as Item).repo : null
      const head = live && order === 'repo' && repo !== lastRepo ? `<div class="repo-h">${esc(lastRepo = repo)}</div>` : ''
      return head + (live ? liveHTML(x as Item) : mineHTML(x as Card))
    }).join('')
    const count = open.length + done.length
    const add = lane.key === 'issue' ? `<button class="lane-add" data-act="add-issue" data-ref="lane.add-issue">${icon('plus', 'sm')}Add issue</button>`
      : lane.kind === 'mine' ? `<button class="lane-add" data-act="add" data-lane="${lane.key}" data-ref="lane.add">${icon('plus', 'sm')}Add</button>` : ''
    const empty = count ? '' : live && !liveRead ? `<div class="empty">${failures.has('live') ? 'Not read yet.' : 'Reading GitHub…'}</div>` : `<div class="empty" data-ref="cur.empty">${filtersOn() || F.org ? `Nothing here under your filters.${filtersOn() ? '<button class="clear" data-act="clear" data-ref="cur.clear">Clear filters</button>' : ''}` : live ? 'Nothing here.' : 'No cards yet. Add one, or drag one here.'}</div>`
    const fold = done.length ? `<div class="done-fold${folds[lane.key] ? ' open' : ''}"><button class="done-h" data-act="fold" data-lane="${lane.key}" aria-expanded="${!!folds[lane.key]}" data-ref="cur.done">${icon('chev', 'sm')}<span class="t-micro">${term('state.done')}</span><span class="n">${done.length}</span><span class="t-gloss">merged and closed</span></button><div class="lane-list done-list">${done.map(liveHTML).join('')}</div></div>` : ''
    const trunc = live && truncated ? '<p class="trunc" data-ref="cur.trunc">Older items are not loaded: Board shows the 200 most recently updated issues and pull requests, combined.</p>' : ''
    return `<section class="lane" data-lane="${lane.key}" data-kind="${lane.kind}" aria-label="${lane.label}">`
      + `<header class="lane-h"><span class="station"></span><span class="name"><span class="t-micro" data-ref="lane.${lane.key}">${lane.label}</span><span class="count" data-ref="lane.count">${live && !liveRead ? '—' : count}${live && truncated ? '+' : ''}</span></span>${add}</header>`
      + `<p class="lane-gloss">${lane.gloss}</p>`
      + `<div class="lane-body" data-body="${lane.key}">${lane.key === 'issue' ? '<div class="drop-hint" data-ref="lane.drop">Drop to open this card as an issue</div>' : ''}${writerHTML(lane)}<div class="lane-list" data-list="${lane.key}">${body}</div>${empty}${fold}${trunc}</div></section>`
  }

  function summary(): void {
    const counts = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<StateKey, number>
    for (const it of shown()) if (it.state) counts[it.state]++
    sumEl.innerHTML = `<span class="t-micro" data-ref="cur.summary">In motion</span>${STATES.map((s) => `<button class="st" data-state="${s}" data-n="${counts[s]}" aria-pressed="${only === s}" data-act="state" data-ref="cur.count"><span data-term="state.${s}">${term(`state.${s}`)}</span><span class="n">${liveRead ? counts[s] : '—'}</span></button>`).join('')}${filtersOn() ? '<button class="clear" data-act="clear" data-ref="cur.clear">Clear filters</button>' : ''}`
    sumEl.classList.toggle('is-filtered', !!only)
  }

  function paintPartial(): void {
    const p: HTMLElement = $('[data-ref="cur.partial"]', root)
    const said = [...failures.values()]
    p.hidden = !said.length
    p.textContent = said.length ? `Board is not updating. ${said.join(' ')} Showing what is available.` : ''
    noticeFeed.reportReadErrors('board', said.length ? [{ key: 'board', title: 'Board is not updating', body: said.join(' '), target: undefined }] : [])
  }

  function paintHead(): void {
    $('[data-order-label]', root).textContent = ORDERS[order][0]
    $$('#board-order-menu [data-order]', root).forEach((b: HTMLElement) => b.setAttribute('aria-checked', String(b.dataset.order === order)))
    for (const k of ['status', 'time', 'by', 'who', 'layout'] as const) {
      $$(`[data-filter="${k}"] button`, root).forEach((b: HTMLElement) => b.setAttribute('aria-pressed', String(b.dataset.v === F[k])))
    }
    $('[data-org-label]', root).textContent = F.org || 'All orgs'
    const orgs = getOrganizations().filter((o) => o.status === 'ready')
    $('#board-org-menu', root).innerHTML = [['', 'All orgs'], ...orgs.map((o) => [o.login, o.login])].map(([v, label]) => `<button class="menu-row org-row" role="menuitemradio" aria-checked="${v === F.org}" data-org="${esc(v)}" data-ref="cur.scope">${esc(label)}</button>`).join('')
  }

  function render(animate = true): void {
    const before = new Map($$('.card[data-id]', lanesEl).map((c: HTMLElement) => [c.dataset.id, c.getBoundingClientRect()]))
    const scrolls = Object.fromEntries($$('[data-body]', lanesEl).map((b: HTMLElement) => [b.dataset.body, b.scrollTop]))
    const values = Object.fromEntries($$('[data-w]', lanesEl).map((f: HTMLInputElement) => [f.dataset.w, f.value]))
    const a = document.activeElement as HTMLInputElement | null
    const focusW = a?.dataset?.w
    const focusId = !focusW ? a?.closest?.<HTMLElement>('.card')?.dataset.id : undefined
    const focusAct = !focusW && a?.dataset?.act ? a.dataset.act : undefined
    const caret = focusW ? [a?.selectionStart ?? 0, a?.selectionEnd ?? 0] as const : null
    curEl.classList.toggle('is-list', F.layout === 'list')
    lanesEl.innerHTML = LANES.map(laneHTML).join('')
    lanesEl.removeAttribute('aria-busy')
    hydrateIcons(lanesEl)
    paintTerms(lanesEl)
    $$('[data-body]', lanesEl).forEach((b: HTMLElement) => { b.scrollTop = scrolls[b.dataset.body ?? ''] || 0 })
    $$('[data-w]', lanesEl).forEach((f: HTMLInputElement) => { const v = values[f.dataset.w ?? '']; if (v != null) f.value = v })
    for (const [id, [stage, label, skip]] of LIFE) lifeTo($(`.card[data-id="${CSS.escape(id)}"] .life`, lanesEl), stage, label, skip)
    if (focusW) {
      const f = $(`[data-w="${focusW}"]`, lanesEl)
      if (f) { f.focus({ preventScroll: true }); if (caret && f.setSelectionRange) try { f.setSelectionRange(caret[0], caret[1]) } catch { /* selects have no caret */ } }
    } else if (focusId) {
      const card = $(`.card[data-id="${CSS.escape(focusId)}"]`, lanesEl)
      ;(focusAct ? $(`[data-act="${focusAct}"]`, card ?? lanesEl) : card)?.focus({ preventScroll: true })
    }
    summary()
    paintHead()
    const m = motion()
    if (!animate || !m.duration) return
    $$('.card[data-id]', lanesEl).forEach((c: HTMLElement) => {
      const b = before.get(c.dataset.id), r = c.getBoundingClientRect()
      if (!r.width) return
      if (!b || !b.width) { c.animate([{ opacity: 0 }, { opacity: 1 }], m); return }
      const dx = b.left - r.left, dy = b.top - r.top
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], m)
    })
  }

  // ---------- Stability: live changes wait while you are on the board ----------
  let onBoard = false
  let held = 0
  const busy = () => onBoard || lanesEl.contains(document.activeElement) || W.size > 0 || !!document.querySelector('.ref-layer')
  function showHeld(): void {
    const h: HTMLElement = $('[data-ref="cur.held"]', root)
    h.hidden = !held
    h.textContent = held ? `${held} update${held > 1 ? 's' : ''} held` : ''
  }
  function flush(): void { if (!held || busy()) return; held = 0; showHeld(); render() }
  on('pointerenter', () => { onBoard = true }, lanesEl)
  on('pointerleave', () => { onBoard = false; flush() }, lanesEl)
  on('focusout', () => ctx.after(0, flush), lanesEl)
  on('poise:ref' as keyof DocumentEventMap, () => ctx.after(0, flush))

  // ---------- Reading ----------
  let generation = 0
  /** The last status read: a failed read keeps it rather than guessing. */
  let statusesRead: Awaited<ReturnType<typeof readPrStatus>> | undefined
  async function settle<T>(key: string, what: string, read: Promise<T>): Promise<T | undefined> {
    try {
      const value = await read
      failures.delete(key)
      return value
    } catch (error) {
      failures.set(key, `Could not load ${what}: ${(error as Error).message}.`)
      return undefined
    }
  }
  async function load(first = false): Promise<void> {
    const mine = ++generation
    const w = timeWindow()
    const [cardsRead, live, statuses, intakeRead, running, chainsRead, chatsRead] = await Promise.all([
      first ? settle('cards', 'your cards', readCards(F.org)) : Promise.resolve(undefined),
      settle('live', 'GitHub issues and pull requests', readLive({ open: F.status === 'open', since: w.since, until: w.until }, F.org)),
      settle('status', 'pull requests’ blockers', readPrStatus()),
      settle('intake', 'which issues are assigned to Poise', readIntake(F.org)),
      settle('running', 'the runs going now', readRunning(F.org)),
      settle('chains', 'the chain’s tasks', readChains()),
      settle('chats', 'the chats on each item', readChats()),
    ])
    if (mine !== generation || signal.aborted) return
    if (cardsRead) cards = cardsRead
    if (intakeRead) {
      intake = intakeRead.intake
      for (const [key, at] of assigned) if (intake.labelled.has(key) || now() - at > 3_600_000) assigned.delete(key)
    } else if (failures.has('intake')) intake = null
    if (chainsRead) capacity = chainsRead.capacity
    if (chatsRead) chats = chatsRead
    if (statuses) statusesRead = statuses
    if (live) {
      truncated = live.truncated
      const sig = (it: Item) => `${it.state}|${it.detail}|${it.title}|${it.record.updated_at}`
      const before = new Map(items.map((it) => [it.id, sig(it)]))
      items = live.records.map((record) => {
        const key = itemKey(record.repo, record.number)
        return toItem({
          record, status: statuses ? statuses.get(key) ?? null : statusesRead?.get(key), chain: chainsRead?.byItem.get(key) ?? null, run: running?.get(key) ?? null,
          labelled: !!intake?.labelled.has(key) || assigned.has(key), closing: intake ? intake.prs[key] ?? [] : null,
        })
      })
      for (const id of [...pending.keys()]) if (items.some((it) => it.id === id) || now() - (pending.get(id)?.openedAt ?? 0) > 3_600_000) pending.delete(id)
      const changed = items.filter((it) => before.has(it.id) && before.get(it.id) !== sig(it)).length
        + items.filter((it) => !before.has(it.id)).length * (readOnce ? 1 : 0)
      readOnce = true
      liveRead = true
      paintPartial()
      if (busy() && changed && !first) {
        // Their state words change at once, in place; their new places wait (cur.held).
        for (const it of items) {
          const card = before.has(it.id) && before.get(it.id) !== sig(it) ? $(`.card[data-id="${CSS.escape(it.id)}"]`, lanesEl) as HTMLElement | null : null
          const focused = document.activeElement
          if (!card || armedAssign === it.id || (focused !== card && card.contains(focused))) continue
          const fresh = document.createElement('div')
          fresh.innerHTML = liveHTML(it)
          const next = fresh.firstElementChild as HTMLElement
          card.innerHTML = next.innerHTML
          card.dataset.state = next.dataset.state ?? ''
          card.setAttribute('aria-label', next.getAttribute('aria-label') ?? '')
          card.classList.add('is-changed')
          hydrateIcons(card)
        }
        held += changed; showHeld(); summary(); return
      }
    }
    readOnce = true
    paintPartial()
    if (first || !busy()) render(!first)
    else summary()
    if (sideFor && sideMode) side(sideMode, byId(sideFor) ?? null)
  }
  window.addEventListener('poise:refresh-tick', () => { if (document.visibilityState === 'visible') void load() }, { signal })

  // ---------- Writing: one writer at a time; a draft you leave is kept ----------
  const stash = () => $$('[data-writer]', lanesEl).forEach((w: HTMLElement) => { drafts.set(w.dataset.writer ?? '', Object.fromEntries($$('[data-w]', w).map((f: HTMLInputElement) => [f.dataset.w, f.value]))) })
  function openWriter(key: string, data: unknown = {}): void {
    // An issue on its way to GitHub keeps its writer, so the answer lands where it was asked.
    if (issueW()?.busy) return
    stash()
    W.clear()
    W.set(key, data)
    render(false)
    const w = $(`[data-writer="${CSS.escape(key)}"]`, lanesEl)
    if (!w) return
    const draft = drafts.get(key)
    if (draft) $$('[data-w]', w).forEach((f: HTMLInputElement) => { const v = draft[f.dataset.w ?? '']; if (v != null) f.value = v })
    const f = $('[data-w]', w)
    f?.focus({ preventScroll: true })
    if (f?.setSelectionRange) f.setSelectionRange(f.value.length, f.value.length)
    w.scrollIntoView({ block: 'nearest' })
  }
  function closeWriter(key: string, focusTo?: () => void): void {
    if (issueW()?.busy) return
    drafts.delete(key)
    W.delete(key)
    render(false)
    focusTo?.()
  }
  const writerFocus = (key: string) => () => (key.startsWith('edit.') ? $(`.card[data-id="${key.slice(5)}"]`, lanesEl) : $(`[data-lane="${key === 'issue' ? 'issue' : key.slice(4)}"] .lane-add`, lanesEl))?.focus()
  const newIssueWriter = (patch: Partial<IssueWriter> = {}): IssueWriter => ({
    repo: repos[0] ?? '', title: '', body: '', labels: [], labelsOpen: false, lq: '', cleared: 0, source: null, edit: null, conflict: '', err: '', busy: false, ...patch,
  })

  async function addCard(lane: MineLane): Promise<void> {
    const w = $(`[data-writer="add.${lane}"]`, lanesEl)
    const text = ($('[data-w="add-text"]', w).value as string).trim(), repo = ($('[data-w="add-repo"]', w).value as string) || null
    if (!text) { closeWriter(`add.${lane}`, writerFocus(`add.${lane}`)); return }
    W.delete(`add.${lane}`)
    drafts.delete(`add.${lane}`)
    try {
      const created = await createCard({ text, lane, repo })
      // + Add puts the card at the top of its lane, under the composer.
      const placed = await updateCard(created.id, { lane, position: 0 }, F.org).catch(() => created)
      cards = [placed, ...cards.filter((c) => c.id !== placed.id).map((c) => (c.lane === lane ? { ...c, position: c.position + 1 } : c))]
      life(String(placed.id), 'Completed', `saved ${clock()}`, true, 4500)
      render()
      $(`.card[data-id="${placed.id}"]`, lanesEl)?.focus()
      if (!matches(text, repo) || !inOrg(repo)) toast('Card added. Your filter hides it; clear the filter to see it.')
    } catch (error) {
      W.set(`add.${lane}`, {})
      drafts.set(`add.${lane}`, { 'add-text': text, 'add-repo': repo ?? '' })
      render(false)
      toast(`The card was not saved: ${(error as Error).message}`, 'failed')
    }
  }
  function startEdit(id: string): void { drafts.delete(`edit.${id}`); openWriter(`edit.${id}`) }
  async function saveEdit(id: string): Promise<void> {
    const c = cardById(id), w = $(`[data-writer="edit.${id}"]`, lanesEl)
    if (!c || !w) return
    const text = ($('[data-w="edit-text"]', w).value as string).trim(), repo = ($('[data-w="edit-repo"]', w).value as string) || null
    if (!text || (text === c.text && repo === c.repo)) { closeWriter(`edit.${id}`, writerFocus(`edit.${id}`)); return }
    W.delete(`edit.${id}`)
    drafts.delete(`edit.${id}`)
    try {
      const saved = await updateCard(c.id, { text, repo })
      cards = cards.map((x) => (x.id === c.id ? { ...x, ...saved } : x))
      life(id, 'Completed', `saved ${clock()}`, true, 4500)
      render(false)
      $(`.card[data-id="${id}"]`, lanesEl)?.focus()
    } catch (error) {
      W.set(`edit.${id}`, {})
      drafts.set(`edit.${id}`, { 'edit-text': text, 'edit-repo': repo ?? '' })
      openWriter(`edit.${id}`)
      toast(`The card was not saved: ${(error as Error).message}`, 'failed')
    }
  }

  async function saveIssue(): Promise<void> {
    const w = issueW()
    if (!w || w.busy || w.conflict) return
    const box = $('[data-writer="issue"]', lanesEl)
    w.title = ($('[data-w="issue-title"]', box).value as string).trim()
    w.body = $('[data-w="issue-body"]', box).value as string
    if (!w.edit) w.repo = $('[data-w="issue-repo"]', box).value as string
    if (!w.title) { w.err = 'Add a title: it is required.'; render(false); $('[data-w="issue-title"]', lanesEl)?.focus(); return }
    if (!w.repo) { w.err = 'Choose a repository.'; render(false); return }
    w.err = ''
    w.busy = true
    render(false)
    if (w.edit) {
      const id = `${w.repo}#${w.edit.number}`
      try {
        const record = await editIssue({ repo: w.repo, number: w.edit.number, title: w.title, body: w.body, expected: w.edit.expected })
        W.delete('issue')
        drafts.delete('issue')
        const it = byId(id)
        if (it) items = items.map((x) => (x.id === id ? { ...x, title: record.title, record: { ...x.record, ...record } } : x))
        life(id, 'Completed', `saved ${clock()}`, true, 4500)
        render(false)
        toast(`Saved #${w.edit.number}. GitHub confirmed the new title and body.`, 'done')
        $(`.card[data-id="${CSS.escape(id)}"]`, lanesEl)?.focus()
      } catch (error) {
        w.busy = false
        const message = (error as Error).message
        if (/changed|conflict|expected/i.test(message)) w.conflict = 'The issue changed on GitHub. Keep your draft and reopen the editor to load the latest version.'
        else w.err = message
        render(false)
      }
      return
    }
    const source = w.source
    const repo = w.repo, title = w.title, body = w.body, chosen = w.labels
    try {
      const { record, dropped } = await openIssue({ repo, title, body, labels: chosen })
      W.delete('issue')
      drafts.delete('issue')
      if (record) {
        const it = toItem({ record, status: null, chain: null, run: null, labelled: !!intake?.label && chosen.includes(intake.label), closing: intake ? [] : null })
        pending.set(it.id, { ...it, openedAt: now() })
        life(it.id, 'Completed', `opened #${record.number}`, true, 4500)
      }
      if (source !== null) {
        await deleteCard(source).catch(() => undefined)
        cards = cards.filter((c) => c.id !== source)
      }
      render()
      const hidden = record ? !shown().some((it) => it.id === `${record.repo}#${record.number}`) || (only && only !== 'idle') : false
      const where = record ? `#${record.number} in ${repo}` : `the issue in ${repo}`
      toast(`${source !== null ? `Opened ${where} from your card; the card is removed.` : `Opened ${where}${chosen.length ? `, labelled ${chosen.filter((l) => !dropped.includes(l)).join(', ') || 'nothing'}` : ''}.`}${dropped.length ? ` GitHub did not apply ${dropped.join(', ')}: the account may lack permission.` : ''}${hidden ? ' Your filters hide it; clear them to see it.' : ''}${intake?.label && chosen.includes(intake.label) ? ` With ${intake.label}, it enters the chain.` : ''}`, 'done')
      if (record) $(`.card[data-id="${CSS.escape(`${record.repo}#${record.number}`)}"]`, lanesEl)?.focus({ preventScroll: true })
    } catch (error) {
      w.busy = false
      w.err = `The issue was not opened: ${(error as Error).message}`
      render(false)
    }
  }

  async function loadLabels(repo: string): Promise<void> {
    if (!repo || (labels.repo === repo && (labels.list || labels.error))) return
    labels = { repo, list: null, error: '' }
    try { labels = { repo, list: await readLabels(repo), error: '' } } catch (error) { labels = { repo, list: null, error: (error as Error).message } }
    if (issueW()?.labelsOpen) { stash(); render(false) }
  }

  async function editAnIssue(it: Item, button: HTMLButtonElement): Promise<void> {
    const open = issueW()
    if (open || drafts.get('issue')?.['issue-title'] || drafts.get('issue')?.['issue-body']) {
      toast('Close the current issue writer before editing another issue. Your draft stays in it.', 'waiting')
      if (!open) openWriter('issue', newIssueWriter())
      $('[data-w="issue-title"]', lanesEl)?.focus()
      return
    }
    button.setAttribute('aria-busy', 'true')
    try {
      const latest = await readIssue(it.repo, it.num)
      drafts.delete('issue')
      openWriter('issue', newIssueWriter({ repo: it.repo, title: latest.title, body: latest.body, edit: { number: it.num, expected: latest } }))
    } catch (error) {
      toast(`Could not load #${it.num}: ${(error as Error).message}`, 'failed')
    } finally {
      button.removeAttribute('aria-busy')
    }
  }
  async function loadTheirs(): Promise<void> {
    const w = issueW()
    if (!w?.edit) return
    try {
      const latest = await readIssue(w.repo, w.edit.number)
      Object.assign(w, { title: latest.title, body: latest.body, conflict: '', err: '', edit: { number: w.edit.number, expected: latest } })
      drafts.delete('issue')
      render(false)
      const t = $('[data-w="issue-title"]', lanesEl)
      if (t) t.value = latest.title
      const b = $('[data-w="issue-body"]', lanesEl)
      if (b) b.value = latest.body
      t?.focus()
    } catch (error) {
      w.err = `Could not load the latest: ${(error as Error).message}`
      render(false)
    }
  }

  // ---------- Card actions, each with its progress on the card ----------
  // The check shows only once the browser took the text.
  async function copy(b: HTMLElement, text: string): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(text)
    } catch {
      toast('Not copied: the browser refused the clipboard.', 'failed')
      return
    }
    const use = $('use', b), old = use?.getAttribute('href')
    use?.setAttribute('href', '#i-check')
    b.classList.add('is-done')
    ctx.after(1200, () => { if (old) use?.setAttribute('href', old); b.classList.remove('is-done') })
  }
  async function del(b: HTMLElement, id: string): Promise<void> {
    if (!b.classList.contains('is-armed')) {
      b.classList.add('is-armed')
      b.textContent = 'Sure?'
      b.setAttribute('aria-label', 'Sure? Delete the card')
      ctx.after(3000, () => { if (b.isConnected && b.classList.contains('is-armed')) { b.classList.remove('is-armed'); b.innerHTML = icon('cross', 'sm'); b.setAttribute('aria-label', 'Delete card') } })
      return
    }
    const c = cardById(id)
    if (!c) return
    const lane = c.lane, before = cards.filter((x) => x.lane === lane).sort((x, y) => x.position - y.position), pos = before.findIndex((x) => x.id === c.id)
    try {
      await deleteCard(c.id)
    } catch (error) {
      b.classList.remove('is-armed')
      b.innerHTML = icon('cross', 'sm')
      b.setAttribute('aria-label', 'Delete card')
      toast(`The card was not deleted: ${(error as Error).message}`, 'failed')
      return
    }
    cards = cards.filter((x) => x.id !== c.id)
    render()
    const after = cards.filter((x) => x.lane === lane).sort((x, y) => x.position - y.position), next = after[Math.min(pos, after.length - 1)]
    ;(next ? $(`.card[data-id="${next.id}"]`, lanesEl) : $(`[data-lane="${lane}"] .lane-add`, lanesEl))?.focus()
    toast(`Deleted “${c.text.length > 48 ? `${c.text.slice(0, 48)}…` : c.text}”. Nothing on GitHub changed.`)
  }
  async function review(it: Item, b: HTMLElement): Promise<void> {
    if (b.getAttribute('aria-disabled') === 'true') { toast(b.dataset.why || 'Not available right now.'); return }
    life(it.id, 'Accepted', clock())
    try {
      await runReview(it.url)
      life(it.id, 'Executing', 'review starting')
      // Its run shows on the card once agent-interface has written it.
      ctx.after(4000, () => { void load() })
      ctx.after(20_000, () => { if (LIFE.get(it.id)?.[0] === 'Executing') life(it.id, 'Completed', `review started ${clock()}`, true, 4500) })
    } catch (error) {
      LIFE.delete(it.id)
      render(false)
      toast(`The review did not start: ${(error as Error).message}`, 'failed')
    }
  }
  let armedAssign: string | null = null
  async function assign(b: HTMLElement, it: Item): Promise<void> {
    if (armedAssign !== it.id) {
      armedAssign = it.id
      b.textContent = 'Sure?'
      b.classList.add('is-armed')
      ctx.after(4000, () => { if (armedAssign === it.id) { armedAssign = null; if (b.isConnected) { b.textContent = 'Assign to Poise'; b.classList.remove('is-armed') } } })
      return
    }
    armedAssign = null
    assignErrors.delete(it.id)
    life(it.id, 'Accepted', clock(), false)
    b.setAttribute('aria-disabled', 'true')
    try {
      await assignIssue(it.repo, it.num)
    } catch (error) {
      LIFE.delete(it.id)
      assignErrors.set(it.id, `GitHub refused the label: ${(error as Error).message}. Nothing changed.`)
      render(false)
      if (sideFor === it.id) side('about', byId(it.id) ?? null)
      return
    }
    const key = it.id.toLowerCase()
    assigned.set(key, now())
    const off = chainOff(), closing = (it.closing ?? []).length > 0
    items = items.map((x) => (x.id === it.id ? { ...x, labelled: true, who: { tag: 'Poise', kind: 'poise', href: '' } } : x))
    life(it.id, 'Completed', 'label added', false, 4500)
    render(false)
    toast(`Label ${intake?.label || 'poise'} added to #${it.num} as you.${off ? ' The chain is off, so it takes the issue once it is on.' : closing ? ' An open pull request closes it, so the chain does not take it while that is open.' : ' The chain takes it at its next check.'}`, 'waiting')
    if (sideFor === it.id) side('about', byId(it.id) ?? null)
  }

  const cardSubject = (it: Item | null, card: Card | null) => (it
    ? { surface: 'current' as const, key: `poise.${it.lane}.${it.repo}.${it.num}`, label: `${it.repo}#${it.num}`, url: it.url }
    : { surface: 'current' as const, key: `poise.card.${card!.id}`, label: card!.text.slice(0, 80) })
  function chatBeside(it: Item | null, card: Card | null): void {
    side(null, null)
    chatSidePane.toggle({ subject: cardSubject(it, card), prefill: it ? undefined : card?.text })
  }
  function openInChat(it: Item): void {
    const w = who(it)
    if (w && w.kind !== 'poise' && w.kind !== 'run') { document.dispatchEvent(new CustomEvent('poise:go', { detail: { href: whoHref(it) } })); return }
    window.dispatchEvent(new CustomEvent('poise:open-chat-session', { detail: { subject: cardSubject(it, null), prefill: `${it.title}\n${it.url}` } }))
  }

  async function move(id: string, key: string): Promise<void> {
    const c = cardById(id)
    if (!c) return
    const list = cards.filter((x) => x.lane === c.lane).sort((x, y) => x.position - y.position), pos = list.findIndex((x) => x.id === c.id)
    let lane: MineLane = c.lane, position = pos
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      position = pos + (key === 'ArrowUp' ? -1 : 1)
      if (position < 0 || position >= list.length) return
    } else {
      const to = MINE[MINE.indexOf(c.lane) + (key === 'ArrowLeft' ? -1 : 1)]
      if (!to) return
      lane = to
      position = Math.min(pos, cards.filter((x) => x.lane === to).length)
    }
    await place(c, lane, position)
    const now2 = cards.filter((x) => x.lane === lane).sort((x, y) => x.position - y.position)
    toast(`Moved to ${LANES.find((l) => l.key === lane)?.label}, ${now2.findIndex((x) => x.id === c.id) + 1} of ${now2.length}.`)
    $(`.card[data-id="${id}"]`, lanesEl)?.focus()
  }
  /** Puts a card at a lane and position, here at once and then on the server; a refusal puts it back. */
  async function place(c: Card, lane: MineLane, position: number): Promise<void> {
    const previous = cards
    const others = cards.filter((x) => x.id !== c.id)
    const target = others.filter((x) => x.lane === lane).sort((x, y) => x.position - y.position)
    target.splice(position, 0, { ...c, lane })
    const placed = new Map(target.map((x, i) => [x.id, { ...x, position: i }]))
    cards = [...others.filter((x) => x.lane !== lane), ...placed.values()]
    render()
    try {
      await updateCard(c.id, { lane, position }, F.org)
    } catch (error) {
      cards = previous
      render()
      toast(`The card did not move: ${(error as Error).message}`, 'failed')
    }
  }

  // ---------- Beside the board ----------
  function side(mode: 'about' | 'task' | null, it: Item | null): void {
    if (!mode || !it) {
      const back = sideFor && $(`.card[data-id="${CSS.escape(sideFor)}"]`, lanesEl)
      sideEl.hidden = true
      curEl.classList.remove('has-side')
      sideFor = null
      sideMode = null
      back?.focus()
      return
    }
    chatSidePane.close()
    sideFor = it.id
    sideMode = mode
    curEl.classList.add('has-side')
    sideEl.hidden = false
    sideEl.innerHTML = mode === 'task' && it.chain ? taskHTML(it, it.chain) : aboutHTML(it)
    hydrateIcons(sideEl)
    paintTerms(sideEl)
    if (mode === 'task' && it.chain) void timeline(it.chain)
  }
  function sameWork(it: Item): string {
    const key = `${it.repo}#${it.num}`
    return `<p class="bside-same" data-ref="side.same"><span class="t-micro">The same work, elsewhere</span>${it.chain ? `<a class="lnk" href="${esc(placeHref('observe', { part: 'tasks', chain: it.chain.id, back: 'board' }))}">Task</a>` : ''}<a class="lnk" href="${esc(placeHref('observe', { part: 'behaviors', pr: key, back: 'board' }))}">Its runs in Behaviors</a><a class="lnk" href="${esc(placeHref('observe', { part: 'github', item: key, back: 'board' }))}">Its row in GitHub</a><a class="lnk" href="${esc(it.url)}" target="_blank" rel="noopener">GitHub</a></p>`
  }
  function aboutHTML(it: Item): string {
    const w = who(it), refusal = assignErrors.get(it.id)
    const owner = w
      ? `<span class="t-gloss">${w.kind === 'poise' ? 'With Poise: the chain carries it.' : 'Carried by'}</span>${w.kind === 'poise' ? '' : `<a class="wk${w.kind === 'worker' ? '' : ' is-own'}" href="${esc(whoHref(it))}">${esc(w.tag)}</a>`}`
      : it.lane === 'issue' && !isSettled(it)
        ? `<span class="t-gloss">Not with Poise.</span>${assignHTML(it, 'btn btn-primary')}<span class="t-gloss">${!intake ? 'Which issues are assigned to Poise could not be read, so Assign waits until it can be.' : everyIssueEnters() ? 'Every open issue enters the chain, so it takes this one by itself.' : chainOff() ? 'The chain is off: assigning adds the label, and the chain takes the issue once it is on.' : ASSIGN_WHAT}</span>${(it.closing ?? []).length ? '<span class="t-gloss">An open pull request closes it, so the chain does not take it while that is open.</span>' : ''}`
        : `<span class="t-gloss">Not with Poise.${it.lane === 'pr' && !isSettled(it) ? ' The chain starts from an issue, so a pull request opened elsewhere stays outside it.' : ''}</span>`
    const d = dwell(it, now())
    return `<div class="bside-h"><span class="t-micro" data-ref="side.about">${it.lane === 'pr' ? 'Pull request' : 'Issue'}</span><button class="ib" data-act="side-close" aria-label="Close" data-ref="side.close">${icon('cross', 'sm')}</button></div><h3>${esc(it.title)}</h3><p class="t-mono t-gloss">${esc(it.repo)}#${it.num} · opened ${ago(minutesSince(it.record.created_at))} · changed ${ago(minutesSince(it.record.updated_at))}</p><div class="bside-rail">${railFor(it)}</div><div class="card-state">${stateHTML(it)}<span class="detail">${esc(it.detail || '')}</span>${d.text ? `<span class="dwell">${esc(d.text)}</span>` : ''}</div><div class="bside-owner" data-ref="card.chain">${owner}</div>${refusal ? `<p class="card-refusal" role="alert">${esc(refusal)}</p>` : ''}${sameWork(it)}`
  }
  function taskHTML(it: Item, chain: ChainRow): string {
    const held = !!chain.held
    return `<div class="bside-h"><span class="t-micro">Task</span><button class="ib" data-act="side-close" aria-label="Close" data-ref="side.close">${icon('cross', 'sm')}</button></div><h3>${esc(it.title)}</h3><p class="t-mono t-gloss">${esc(chain.repository)}#${chain.issue}${chain.pullNumber ? ` → #${chain.pullNumber}` : ''}</p><div class="bside-rail">${railHTML(chain)}</div><div class="card-state">${stateHTML(it)}<span class="detail">${esc(it.detail)}</span></div><div class="bside-acts"><button class="btn btn-line" data-act="side-hold" data-id="${esc(it.id)}" data-ref="${held ? 'task.resume' : 'task.hold'}">${held ? 'Resume' : 'Hold new invocations'}</button><a class="btn btn-line" href="${esc(placeHref('observe', { part: 'tasks', chain: chain.id, back: 'board' }))}" data-ref="task.open">Open in Observe</a></div><div class="bside-tl" data-ref="side.timeline"><span class="t-micro">Timeline</span><ol class="tl" data-tl><li class="t-gloss">Reading its steps…</li></ol></div>${sameWork(it)}`
  }
  async function timeline(chain: ChainRow): Promise<void> {
    const box = $('[data-tl]', sideEl)
    try {
      const read = async (after: number) => {
        const page = readJournalPage(await (await fetch(`/api/behavior-chains?${new URLSearchParams({ id: chain.id, after: String(after) })}`, { cache: 'no-store', signal })).json())
        return { events: page.events, next: page.next }
      }
      const window = await readNewest(read, chain.sequence)
      if (!box?.isConnected) return
      const invocations = new Map(chain.invocations.map((i) => [i.id, i]))
      const lines = timelineLines(window.events, null).slice(0, 20)
      box.innerHTML = lines.length ? lines.map(({ event, folded }) => {
        const w = eventWords(event, invocations)
        return `<li><time>${esc(new Date(event.at).toTimeString().slice(0, 5))}</time><span class="k">${esc(w.kind === 'run' ? 'Run' : w.kind === 'hold' ? 'Hold' : w.kind === 'uncertain' ? 'Not confirmed' : 'Event')}</span><span>${esc(w.text)}${folded > 1 ? ` · ${folded} times` : ''}</span></li>`
      }).join('') : '<li class="t-gloss">No steps yet.</li>'
    } catch (error) {
      if (box?.isConnected) box.innerHTML = `<li class="t-gloss">Its steps could not be read: ${esc((error as Error).message)}. <a class="lnk" href="${esc(placeHref('observe', { part: 'tasks', chain: chain.id, back: 'board' }))}">Open it in Observe</a>.</li>`
    }
  }
  async function holdOrResume(it: Item): Promise<void> {
    const chain = it.chain
    if (!chain) return
    const operation = chain.held ? 'resume' : 'hold'
    try {
      const response = await fetch('/api/behavior-chains', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: chain.id, sequence: chain.sequence, operation }), signal })
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || `HTTP ${response.status}`)
      toast(operation === 'hold' ? 'Held. No new step starts; a run already going carries on.' : 'Resumed. Its next step starts when it is due.', operation === 'hold' ? 'waiting' : 'running')
      await load()
    } catch (error) {
      if (!signal.aborted) toast(`${operation === 'hold' ? 'Hold' : 'Resume'} did not apply: ${(error as Error).message}`, 'failed')
    }
  }

  // ---------- Events ----------
  on('click', (e) => {
    const t = e.target as Element
    if (!root.contains(t)) return
    const seg = t.closest<HTMLElement>('[data-filter] button')
    if (seg) {
      const key = seg.closest<HTMLElement>('[data-filter]')?.dataset.filter as FilterKey
      const before = F[key]
      choose({ [key]: seg.dataset.v } as Partial<Filters>)
      if (key === 'status' || key === 'time') { if (before !== F[key]) void load() }
      render()
      return
    }
    const org = t.closest<HTMLElement>('#board-org-menu [data-org]')
    if (org) { choose({ org: org.dataset.org ?? '' }); closeMenus(); void load(true); return }
    const ord = t.closest<HTMLElement>('#board-order-menu [data-order]')
    if (ord) { order = ord.dataset.order as Order; store.set('poise-current-order', order); closeMenus(); render(); return }
    const b = t.closest<HTMLElement>('[data-act]')
    if (b?.matches('[aria-disabled="true"]') && b.dataset.act !== 'review') { e.preventDefault(); return }
    if (!b) {
      const card = t.closest<HTMLElement>('.card:not(.is-editing)')
      if (!card || t.closest('.card-acts, .writer, a')) return
      if (card.dataset.kind === 'mine') startEdit(card.dataset.id ?? '')
      else {
        const it = byId(card.dataset.id ?? '')
        if (it) side(it.chain ? 'task' : 'about', it)
      }
      return
    }
    const id = b.dataset.id || b.closest<HTMLElement>('.card')?.dataset.id || ''
    const it = byId(id), card = cardById(id)
    switch (b.dataset.act) {
      case 'state': only = only === b.dataset.state ? null : b.dataset.state as StateKey; render(); break
      case 'clear': choose({ status: 'any', time: 'all', who: 'any' }); search = ''; only = null; $('[data-search]', root).value = ''; void load(); render(); break
      case 'add': openWriter(`add.${b.dataset.lane}`); break
      case 'add-issue': openWriter('issue', newIssueWriter()); break
      case 'w-cancel': { const key = b.dataset.wKey ?? ''; closeWriter(key, writerFocus(key)); break }
      case 'w-add': void addCard(b.dataset.lane as MineLane); break
      case 'w-save': void saveEdit(b.dataset.id ?? ''); break
      case 'w-open-issue': void saveIssue(); break
      case 'w-theirs': void loadTheirs(); break
      case 'labels': {
        const w = issueW()
        if (!w) break
        stash()
        const d = drafts.get('issue') ?? {}
        Object.assign(w, { title: d['issue-title'] ?? w.title, body: d['issue-body'] ?? w.body, repo: d['issue-repo'] ?? w.repo, labelsOpen: !w.labelsOpen })
        render(false)
        if (w.labelsOpen) { void loadLabels(w.repo); $('[data-labels-filter]', lanesEl)?.focus() } else $('[data-act="labels"]', lanesEl)?.focus()
        break
      }
      case 'copy': void copy(b, it ? `${it.title}\n${it.url}` : card?.text ?? ''); break
      case 'chat': chatBeside(it ?? null, card ?? null); break
      case 'task': if (it) side('task', it); break
      case 'side-close': side(null, null); break
      case 'side-hold': if (it) void holdOrResume(it); break
      case 'open-chat': if (it) openInChat(it); break
      case 'review': if (it) void review(it, b); break
      case 'assign': if (it) void assign(b, it); break
      case 'edit-issue': if (it) void editAnIssue(it, b as HTMLButtonElement); break
      case 'to-issue': if (card) { drafts.delete('issue'); openWriter('issue', newIssueWriter({ body: card.text, repo: card.repo ?? repos[0] ?? '', source: card.id })) } break
      case 'del': void del(b, id); break
      case 'fold': {
        const lane = b.dataset.lane ?? ''
        folds[lane] = !folds[lane]
        store.set('poise-current-folds', folds)
        render(false)
        $(`[data-act="fold"][data-lane="${lane}"]`, lanesEl)?.focus()
        break
      }
      default: break
    }
  })

  let searchTimer = 0
  on('input', (e) => {
    const t = e.target as HTMLInputElement
    if (t.matches('[data-search]')) { clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { search = t.value.trim(); render() }, 90); return }
    if (t.matches('[data-labels-filter]')) {
      const w = issueW()
      if (!w) return
      w.lq = t.value.trim()
      const pos = t.selectionStart ?? 0
      stash()
      render(false)
      const f = $('[data-labels-filter]', lanesEl)
      f?.focus()
      f?.setSelectionRange(pos, pos)
    }
  }, root)
  on('change', (e) => {
    const t = e.target as HTMLInputElement
    const w = issueW()
    if (!w) return
    if (t.matches('[data-label]')) {
      const set = new Set(w.labels)
      if (t.checked) set.add(t.value); else set.delete(t.value)
      w.labels = [...set]
      stash()
      render(false)
      $(`[data-label][value="${CSS.escape(t.value)}"]`, lanesEl)?.focus()
    }
    if (t.matches('[data-w="issue-repo"]')) {
      stash()
      Object.assign(w, { repo: t.value, cleared: w.labels.length, labels: [], lq: '' })
      render(false)
      if (w.labelsOpen) void loadLabels(w.repo)
      $('[data-w="issue-repo"]', lanesEl)?.focus()
    }
  }, root)
  on('keydown', (e) => {
    const t = e.target as HTMLElement
    if (!root.contains(t)) return
    const w = t.closest<HTMLElement>('[data-writer]')
    if (w && e.key === 'Escape' && t.closest('.labels-pop') && issueW()?.labelsOpen) { e.preventDefault(); stash(); issueW()!.labelsOpen = false; render(false); $('[data-act="labels"]', lanesEl)?.focus(); return }
    if (w) {
      const key = w.dataset.writer ?? ''
      if (e.key === 'Escape') { e.preventDefault(); closeWriter(key, writerFocus(key)) }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (key === 'issue') void saveIssue(); else if (key.startsWith('edit.')) void saveEdit(key.slice(5)); else void addCard(key.slice(4) as MineLane) }
      return
    }
    if (e.key === 'Escape' && !sideEl.hidden && sideEl.contains(t)) { side(null, null); return }
    const cardEl = t.closest<HTMLElement>('.card')
    if (!cardEl || t !== cardEl) return
    if (cardEl.dataset.kind === 'mine') {
      if (e.key === 'Enter') { e.preventDefault(); startEdit(cardEl.dataset.id ?? '') }
      else if (e.altKey && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) { e.preventDefault(); void move(cardEl.dataset.id ?? '', e.key) }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = byId(cardEl.dataset.id ?? '')
      if (it) side(it.chain ? 'task' : 'about', it)
    }
  })

  // ---------- Drag your cards; drop one on Issue to open it ----------
  let dragId: string | null = null
  const line = Object.assign(document.createElement('div'), { className: 'drop-line' })
  const endDrag = () => {
    $$('.is-dragging', lanesEl).forEach((c: HTMLElement) => c.classList.remove('is-dragging'))
    $$('.lane.is-drop, .lane.is-drop-issue', lanesEl).forEach((l: HTMLElement) => l.classList.remove('is-drop', 'is-drop-issue'))
    line.remove()
    dragId = null
  }
  on('dragstart', (e) => {
    const c = (e.target as Element).closest?.<HTMLElement>('.card[data-kind="mine"]:not(.is-editing)')
    if (!c) { e.preventDefault(); return }
    dragId = c.dataset.id ?? null
    c.classList.add('is-dragging')
    e.dataTransfer?.setData('text/plain', dragId ?? '')
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove'
  }, lanesEl)
  on('dragover', (e) => {
    const lane = (e.target as Element).closest<HTMLElement>('.lane')
    if (!dragId || !lane) return
    $$('.lane.is-drop, .lane.is-drop-issue', lanesEl).forEach((l: HTMLElement) => { if (l !== lane) l.classList.remove('is-drop', 'is-drop-issue') })
    if (lane.dataset.lane === 'issue') { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; lane.classList.add('is-drop-issue'); line.remove(); return }
    if (lane.dataset.kind !== 'mine') { line.remove(); return }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    lane.classList.add('is-drop')
    const list = $('[data-list]', lane), cardsEls = $$('.card:not(.is-dragging)', list)
    const idx = cardsEls.findIndex((c: HTMLElement) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 })
    line.dataset.index = String(idx < 0 ? cardsEls.length : idx)
    list.insertBefore(line, idx < 0 ? null : cardsEls[idx])
  }, lanesEl)
  on('dragleave', (e) => {
    const lane = (e.target as Element).closest<HTMLElement>('.lane')
    if (lane && !lane.contains(e.relatedTarget as Node | null)) { lane.classList.remove('is-drop', 'is-drop-issue'); if (lane.contains(line)) line.remove() }
  }, lanesEl)
  on('drop', (e) => {
    const lane = (e.target as Element).closest<HTMLElement>('.lane'), id = dragId, idx = Number(line.dataset.index || 0)
    if (!lane || !id) return
    e.preventDefault()
    endDrag()
    const c = cardById(id)
    if (!c) return
    if (lane.dataset.lane === 'issue') { drafts.delete('issue'); openWriter('issue', newIssueWriter({ body: c.text, repo: c.repo ?? repos[0] ?? '', source: c.id })); return }
    if (lane.dataset.kind !== 'mine') return
    void place(c, lane.dataset.lane as MineLane, idx)
  }, lanesEl)
  on('dragend', endDrag, lanesEl)

  // An update waits while a writer holds text or an action is on its way.
  const unguard = registerReloadGuard(() => {
    const out: string[] = []
    for (const key of W.keys()) {
      const box = $(`[data-writer="${CSS.escape(key)}"]`, lanesEl)
      const typed = box ? $$('[data-w]', box).some((f: HTMLInputElement) => f.tagName !== 'SELECT' && f.value.trim()) : false
      if (typed) out.push(key === 'issue' ? 'An issue being written on Board' : 'A card being written on Board')
    }
    if ([...LIFE.values()].some(([stage]) => stage === 'Accepted' || stage === 'Executing')) out.push('A Board action on its way')
    return out
  })

  // ---------- Start ----------
  paintHead()
  render(false)
  startRefreshTicker()
  void (async () => {
    await loadSettings().catch(() => undefined)
    if (signal.aborted) return
    const scope = getOrganizations().some((o) => o.login === F.org && o.status === 'ready') ? F.org : ''
    if (scope !== F.org) choose({ org: scope })
    void readRepos(F.org).then((r) => { repos = r.repos; if (r.warning) failures.set('repos', r.warning); else failures.delete('repos') }).catch((error) => { failures.set('repos', `Could not load your repositories: ${(error as Error).message}.`) })
    await load(true)
    const item = address.item
    if (item) await focusItem(item)
  })()

  /** A link's item: open it, widening a filter that hides it, for this visit only. */
  async function focusItem(item: string): Promise<void> {
    const find = () => allItems().find((x) => x.id.toLowerCase() === item.toLowerCase())
    let it = find()
    // The time window and the scope decide what is read: a link widens them and reads again.
    if (!it && (F.time !== 'all' || F.org)) {
      if (F.time !== 'all') linkTo('time', 'all')
      if (F.org) linkTo('org', '')
      await load()
      if (signal.aborted) return
      it = find()
    }
    if (!it) { toast(`${item} is not among the items Board has loaded.`, 'waiting'); return }
    if (F.status === 'open' && isSettled(it)) linkTo('status', 'any')
    if (F.by === 'opened' && !inWindow(it.openedAt)) linkTo('time', 'all')
    if (F.who !== 'any') linkTo('who', 'any')
    if (only && it.state !== only) only = null
    if (search && !matches(it.title, it.repo, `#${it.num}`)) { search = ''; $('[data-search]', root).value = '' }
    if (F.layout === 'lanes' && isSettled(it)) folds[it.lane] = true
    render(false)
    const el = $(`.card[data-id="${CSS.escape(it.id)}"]`, lanesEl)
    el?.scrollIntoView({ block: 'center' })
    el?.classList.add('is-linked')
    el?.focus({ preventScroll: true })
    side(it.chain ? 'task' : 'about', it)
  }

  return () => {
    unguard()
    chatSidePane.close()
    noticeFeed.reportReadErrors('board', [])
    closeMenus()
  }
}
