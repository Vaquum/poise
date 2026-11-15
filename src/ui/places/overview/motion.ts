// In motion (#556, Overview): the work in the seven states. Chats and workers
// from Chat's session list, issues and pull requests as Board reads them
// (classic Current's list, its status check and the running runs), and the
// behavior chain's tasks by phase. Read here, not through another place.
import type { SessionRecord } from '../../../../server/chat/protocol'
import { chatClient } from '../../../chat-client'
import { getOrganizations, getSettings } from '../../../config'
import { getSelectedOrganization, organizationPayload, organizationUrl } from '../../../organizations'
import { placeHref } from '../../address'
import { $, esc } from '../../dom'
import { term } from '../../registry'
import type { GhRecord } from '../board/model'
import {
  chatState, countStates, issueState, PHASES, phaseWords, pullState, STATES, taskPhase, taskState,
  type ChainLike, type HeldReason, type Phase, type State,
} from './states'
import type { RightFilter } from './find'
import { chatOpening } from './targets'
import { json, reason, readLine, reportRead, unread, whileVisible, type Read, type PartContext } from './util'

interface Work { group: 'people' | 'items' | 'tasks', id: string, title: string, state: State, note: string, href: string, phase?: Phase }
interface GreenRead { records?: { repo: string, number: number, status: 'green' | 'yellow' }[], held?: { repo: string, number: number, held: { reasons: HeldReason[], checks?: { failing?: string[] } } }[] }
interface RunningLog { repo: string | null, pr_id: string | null, issue?: string | null, status: string }

export interface Motion {
  /** The chain's tasks, read by the place with Answer here's chain attention. */
  setChains(chains: ChainLike[], error: string, at: number): void
  role(chat: string): 'manager' | 'worker' | null
  sessions(): SessionRecord[]
  onSessions(listener: () => void): void
}

const key = (repo: string, number: number | string) => `${repo.toLowerCase()}#${String(number).replace(/^#/, '')}`

/** The last reads, kept across visits and page loads: a return or a reload
 *  paints them at once, then reads again. Chats and the chain's tasks are the
 *  workspace's; issues, pull requests and runs are one organization's. Another
 *  GitHub user's or organization's reads never stand for these. */
interface LastMotion { me: string, org: string, orgs: string, sessions: Read<SessionRecord[]>, items: Read<GhRecord[]>, pulls: Read<GreenRead>, running: Read<RunningLog[]>, chains: Read<ChainLike[]> }
const LAST_MOTION_KEY = 'poise-overview-motion'
/** The organizations ready now: All orgs never stands for another set of them. */
const readyOrgs = (): string => getOrganizations().filter((org) => org.status === 'ready').map((org) => org.login.toLowerCase()).sort().join(',')
/** Only a known GitHub user keeps or finds In motion's last reads. */
function rememberedMotion(): LastMotion | null {
  try {
    const me = getSettings().me ?? ''
    const last = JSON.parse(localStorage.getItem(LAST_MOTION_KEY) ?? 'null') as LastMotion | null
    return last && me && last.me === me ? last : null
  } catch {
    return null
  }
}

export function mountMotion(ctx: PartContext, card: HTMLElement, find: RightFilter): Motion {
  const { signal } = ctx
  const sessions: Read<Map<string, SessionRecord>> = { ...unread<Map<string, SessionRecord>>(), data: null }
  let items: Read<GhRecord[]> = unread()
  let pulls: Read<GreenRead> = unread()
  let running: Read<RunningLog[]> = unread()
  let chains: Read<ChainLike[]> = unread()
  let pick: { group: 'people' | 'items', state: State } | { phase: Phase } = { group: 'people', state: 'running' }
  const sessionListeners = new Set<() => void>()
  // The GitHub user this mount reads for, and the organization of the issues,
  // pull requests and runs it holds; a read overtaken by a later one is dropped.
  const me = getSettings().me ?? ''
  let itemsOrg = getSelectedOrganization()
  let itemsOrgs = readyOrgs()
  let itemsRead = 0
  const last = rememberedMotion()
  if (last) {
    if (last.sessions.data) Object.assign(sessions, { data: new Map(last.sessions.data.map((session) => [session.id, session])), at: last.sessions.at })
    chains = last.chains
    if (last.org === itemsOrg && (itemsOrg || last.orgs === itemsOrgs)) ({ items, pulls, running } = last)
  }
  function remember(): void {
    // A place left, or a GitHub user changed since it opened, keeps nothing.
    if (signal.aborted || !me || (getSettings().me ?? '') !== me) return
    const kept = <T>(read: Read<T>): Read<T> => ({ data: read.data, error: '', at: read.at })
    const last: LastMotion = { me, org: itemsOrg, orgs: itemsOrgs, sessions: kept({ data: sessions.data ? [...sessions.data.values()] : null, error: '', at: sessions.at }),
      items: kept(items), pulls: kept(pulls), running: kept(running), chains: kept(chains) }
    try { localStorage.setItem(LAST_MOTION_KEY, JSON.stringify(last)) } catch { /* the next page reads them anew */ }
  }

  function work(): Work[] {
    const out: Work[] = []
    for (const session of sessions.data?.values() ?? []) {
      if (session.role === 'manager') continue
      const placed = chatState(session)
      out.push({ group: 'people', id: session.id, title: session.role === 'worker' ? `Worker · ${session.title}` : session.title, ...placed, href: chatOpening(session.id, session.role ?? null).href })
    }
    const status = new Map((pulls.data?.records ?? []).map((record) => [key(record.repo, record.number), record.status]))
    const held = new Map((pulls.data?.held ?? []).map((entry) => [key(entry.repo, entry.number), entry.held]))
    const busy = new Set((running.data ?? []).flatMap((log) => log.repo ? [log.pr_id ? key(log.repo, log.pr_id) : '', log.issue ? key(log.repo, log.issue) : ''].filter(Boolean) : []))
    for (const record of items.data ?? []) {
      const id = key(record.repo, record.number)
      const placed = record.kind === 'pr'
        ? pullState({ reviewRequested: record.reviewRequested, status: status.get(id) ?? (held.has(id) ? 'yellow' : undefined), reasons: held.get(id)?.reasons, failing: held.get(id)?.checks?.failing, running: busy.has(id) })
        : issueState({ running: busy.has(id) })
      // A pull request whose status could not be read has no state word.
      if (!placed) continue
      out.push({ group: 'items', id, title: `${record.repo}#${record.number} ${record.title}`, ...placed, href: placeHref('board', { item: `${record.repo}#${record.number}`, back: 'overview' }) })
    }
    for (const chain of chains.data ?? []) {
      if (chain.supersession) continue
      const { phase, round } = taskPhase(chain)
      const placed = taskState(chain)
      const words = phaseWords(phase, round)
      out.push({ group: 'tasks', id: chain.id, title: `${chain.repository}#${chain.pullNumber ?? chain.issue}`, state: placed.state, note: placed.note && placed.note !== words ? `${words} · ${placed.note}` : words, phase, href: placeHref('observe', { part: 'tasks', chain: chain.id, back: 'overview' }) })
    }
    return out
  }

  /** A group not yet read: chats, or items before the runs going now, or their pull requests' statuses, have been read. */
  const unreadGroup = (group: 'people' | 'items'): boolean => group === 'people' ? !sessions.data : !items.data || !running.data || (!pulls.data && items.data.some((record) => record.kind === 'pr'))

  function countsHTML(list: Work[], group: 'people' | 'items'): string {
    const counts = countStates(list.filter((entry) => entry.group === group))
    // Never read is not zero: its counts say so until a read arrives.
    const unread = unreadGroup(group)
    return `<div class="ocounts" role="group" data-ref="ov.counts">${STATES.map((state) => {
      const on = 'state' in pick && pick.group === group && pick.state === state
      return `<button class="oc${on ? ' is-on' : ''}" data-state-pick="${state}" data-group="${group}" aria-pressed="${on}"${counts[state] && !unread ? '' : ' aria-disabled="true"'} data-ref="ov.count"><span class="sc" data-state="${state}"></span><b>${unread ? '—' : counts[state]}</b><span>${esc(term(`state.${state}`))}</span></button>`
    }).join('')}</div>`
  }

  function phasesHTML(list: Work[], hidden: boolean): string {
    const tasks = list.filter((entry) => entry.group === 'tasks')
    const order: Phase[] = [...PHASES, 'Merged']
    const phases = order.filter((phase) => tasks.some((task) => task.phase === phase))
    // Tasks the search hides are not tasks that are gone.
    if (!phases.length && hidden) return `<p class="onote">${esc(find.none())}</p>`
    if (!phases.length) return `<p class="onote">${chains.data ? 'No task is in motion.' : chains.error ? '' : 'Reading the chain…'}</p>`
    return `<div class="ocounts" role="group" data-ref="ov.phases">${phases.map((phase) => {
      const on = 'phase' in pick && pick.phase === phase
      const words = phase === 'Merge' ? 'at merge' : phase === 'Merged' ? 'merged' : `in ${phase.charAt(0).toLowerCase()}${phase.slice(1)}`
      return `<button class="oc${on ? ' is-on' : ''}" data-phase-pick="${esc(phase)}" aria-pressed="${on}" data-ref="ov.phase"><b>${tasks.filter((task) => task.phase === phase).length}</b> ${esc(words)}</button>`
    }).join('')}</div>`
  }

  function paint(): void {
    // The search narrows the counts too, and lists every match whatever its state.
    const all = work()
    const list = all.filter((entry) => find.matches(entry.title, entry.note))
    $('[data-counts="people"]', card).innerHTML = countsHTML(list, 'people')
    $('[data-counts="items"]', card).innerHTML = countsHTML(list, 'items')
    $('[data-phases]', card).innerHTML = phasesHTML(list, all.some((entry) => entry.group === 'tasks' && !list.includes(entry)))
    const chosen = pick
    const listed = find.query() ? list
      : 'phase' in chosen
        ? list.filter((entry) => entry.group === 'tasks' && entry.phase === chosen.phase)
        : list.filter((entry) => entry.group !== 'tasks' && entry.state === chosen.state)
    const unread = 'phase' in chosen ? !chains.data : unreadGroup(chosen.group)
    const empty = find.query() ? find.none() : unread ? 'Not read yet.' : 'phase' in chosen ? 'No task at this phase right now.' : `Nothing ${term(`state.${chosen.state}`)} right now.`
    $('[data-worklist]', card).innerHTML = listed.length
      ? listed.map((entry) => `<li><span class="sc" data-state="${entry.state}" data-ref="state"></span><a href="${esc(entry.href)}">${esc(entry.title)}</a>${entry.note ? `<span class="onote">${esc(entry.note)}</span>` : ''}</li>`).join('')
      : `<li class="onote">${esc(empty)}</li>`
    const notes = [readLine('Chats', sessions), readLine('Issues and pull requests', items), readLine('Their status checks', pulls), readLine('Running runs', running), readLine('The chain’s tasks', chains)].filter(Boolean)
    $('[data-motionfail]', card).innerHTML = notes.map((note) => `<p class="onote is-warn" role="status" data-ref="ov.read">${esc(note)}</p>`).join('')
  }

  card.addEventListener('click', (e) => {
    const target = e.target as Element
    const phase = target.closest<HTMLElement>('[data-phase-pick]')
    if (phase) { pick = 'phase' in pick && pick.phase === phase.dataset.phasePick ? { group: 'people', state: 'running' } : { phase: phase.dataset.phasePick as Phase }; paint(); return }
    const state = target.closest<HTMLElement>('[data-state-pick]')
    if (!state || state.matches('[aria-disabled="true"]')) return
    pick = { group: state.dataset.group as 'people' | 'items', state: state.dataset.statePick as State }
    paint()
  }, { signal })

  async function readSessions(): Promise<void> {
    try {
      const data = await chatClient.listSessions()
      sessions.data = new Map(data.sessions.map((session) => [session.id, session]))
      sessions.error = ''
      sessions.at = Date.now()
    } catch (error) {
      sessions.error = reason(error)
    }
    reportRead(ctx, 'overview-chats', 'Chats could not be read', sessions)
    paint()
    remember()
    for (const listener of sessionListeners) listener()
  }
  async function readItems(): Promise<void> {
    // Another organization's last reads never stand for this one's.
    const org = getSelectedOrganization()
    const orgs = readyOrgs()
    if (org !== itemsOrg || (!org && orgs !== itemsOrgs)) { [items, pulls, running] = [unread(), unread(), unread()]; itemsOrg = org; paint() }
    itemsOrgs = orgs
    const mine = ++itemsRead
    const gh = (body: Record<string, unknown>) => json<Record<string, unknown>>('/api/gh', { method: 'POST', body: JSON.stringify({ ...body, ...organizationPayload() }) })
    const settle = async <T>(target: Read<T>, read: () => Promise<T>): Promise<Read<T>> => {
      try { return { data: await read(), error: '', at: Date.now() } } catch (error) { return { ...target, error: reason(error) } }
    }
    const read = await Promise.all([
      settle(items, async () => ((await gh({ operation: 'list', record_type: 'all', record_state: 'open', limit: 200, offset: 0 })).records ?? []) as GhRecord[]),
      settle(pulls, async () => await gh({ operation: 'green_pr' }) as GreenRead),
      settle(running, async () => ((await json<{ logs?: RunningLog[] }>(organizationUrl('/api/agent-logs?status=running'))).logs ?? []).filter((log) => log.status === 'running')),
    ])
    if (mine !== itemsRead || signal.aborted) return
    ;[items, pulls, running] = read
    reportRead(ctx, 'overview-items', 'Issues and pull requests could not be read', items)
    reportRead(ctx, 'overview-pulls', 'Pull requests’ status checks could not be read', pulls)
    reportRead(ctx, 'overview-running', 'Running runs could not be read', running)
    paint()
    remember()
  }

  // A chat created or changed elsewhere moves at once.
  const off = chatClient.on('session', (record) => {
    if (!sessions.data) return
    sessions.data.set(record.id, record)
    paint()
    for (const listener of sessionListeners) listener()
  })
  signal.addEventListener('abort', off)
  paint()
  whileVisible(ctx, 60_000, () => { void readSessions(); void readItems() })
  // Fresh settings naming other organizations, or another one chosen: what was read for the last ones goes at once.
  window.addEventListener('poise:organization-filter-changed', () => { void readItems() }, { signal })
  find.onChange(paint)

  return {
    setChains(next, error, at) { chains = error ? { ...chains, error } : { data: next, error: '', at }; paint(); if (!error) remember() },
    role: (chat) => sessions.data?.get(chat)?.role ?? null,
    sessions: () => [...(sessions.data?.values() ?? [])],
    onSessions: (listener) => { sessionListeners.add(listener) },
  }
}
