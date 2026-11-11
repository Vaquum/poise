// In motion (#556, Overview): the work in the seven states. Chats and workers
// from Chat's session list, issues and pull requests as Board reads them
// (classic Current's list, its status check and the running runs), and the
// behavior chain's tasks by phase. Read here, not through another place.
import type { SessionRecord } from '../../../../server/chat/protocol'
import { chatClient } from '../../../chat-client'
import { organizationPayload, organizationUrl } from '../../../organizations'
import { placeHref } from '../../address'
import { $, esc } from '../../dom'
import { term } from '../../registry'
import {
  chatState, countStates, issueState, PHASES, phaseWords, pullState, STATES, taskPhase, taskState,
  type ChainLike, type HeldReason, type Phase, type State,
} from './states'
import { chatOpening } from './targets'
import { json, reason, readLine, reportRead, unread, whileVisible, type Read, type PartContext } from './util'

interface Work { group: 'people' | 'items' | 'tasks', id: string, title: string, state: State, note: string, href: string, phase?: Phase }
interface GhRecord { kind: 'pr' | 'issue', repo: string, number: number, title: string, state: string }
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

export function mountMotion(ctx: PartContext, card: HTMLElement): Motion {
  const { signal } = ctx
  const sessions: Read<Map<string, SessionRecord>> = { ...unread<Map<string, SessionRecord>>(), data: null }
  let items: Read<GhRecord[]> = unread()
  let pulls: Read<GreenRead> = unread()
  let running: Read<RunningLog[]> = unread()
  let chains: Read<ChainLike[]> = unread()
  let pick: { group: 'people' | 'items', state: State } | { phase: Phase } = { group: 'people', state: 'running' }
  const sessionListeners = new Set<() => void>()

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
        ? pullState({ status: status.get(id) ?? (held.has(id) ? 'yellow' : undefined), reasons: held.get(id)?.reasons, failing: held.get(id)?.checks?.failing, running: busy.has(id) })
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

  function countsHTML(list: Work[], group: 'people' | 'items'): string {
    const counts = countStates(list.filter((entry) => entry.group === group))
    return `<div class="ocounts" role="group" data-ref="ov.counts">${STATES.map((state) => {
      const on = 'state' in pick && pick.group === group && pick.state === state
      return `<button class="oc${on ? ' is-on' : ''}" data-state-pick="${state}" data-group="${group}" aria-pressed="${on}"${counts[state] ? '' : ' aria-disabled="true"'} data-ref="ov.count"><span class="sc" data-state="${state}"></span><b>${counts[state]}</b><span>${esc(term(`state.${state}`))}</span></button>`
    }).join('')}</div>`
  }

  function phasesHTML(list: Work[]): string {
    const tasks = list.filter((entry) => entry.group === 'tasks')
    const order: Phase[] = [...PHASES, 'Merged']
    const phases = order.filter((phase) => tasks.some((task) => task.phase === phase))
    if (!phases.length) return `<p class="onote">${chains.data ? 'No task is in motion.' : chains.error ? '' : 'Reading the chain…'}</p>`
    return `<div class="ocounts" role="group" data-ref="ov.phases">${phases.map((phase) => {
      const on = 'phase' in pick && pick.phase === phase
      const words = phase === 'Merge' ? 'at merge' : phase === 'Merged' ? 'merged' : `in ${phase.charAt(0).toLowerCase()}${phase.slice(1)}`
      return `<button class="oc${on ? ' is-on' : ''}" data-phase-pick="${esc(phase)}" aria-pressed="${on}" data-ref="ov.phase"><b>${tasks.filter((task) => task.phase === phase).length}</b> ${esc(words)}</button>`
    }).join('')}</div>`
  }

  function paint(): void {
    const list = work()
    $('[data-counts="people"]', card).innerHTML = countsHTML(list, 'people')
    $('[data-counts="items"]', card).innerHTML = countsHTML(list, 'items')
    $('[data-phases]', card).innerHTML = phasesHTML(list)
    const chosen = pick
    const listed = 'phase' in chosen
      ? list.filter((entry) => entry.group === 'tasks' && entry.phase === chosen.phase)
      : list.filter((entry) => entry.group !== 'tasks' && entry.state === chosen.state)
    const empty = 'phase' in chosen ? 'No task at this phase right now.' : `Nothing ${term(`state.${chosen.state}`)} right now.`
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
    for (const listener of sessionListeners) listener()
  }
  async function readItems(): Promise<void> {
    const gh = (body: Record<string, unknown>) => json<Record<string, unknown>>('/api/gh', { method: 'POST', body: JSON.stringify({ ...body, ...organizationPayload() }) })
    const settle = async <T>(target: Read<T>, read: () => Promise<T>): Promise<Read<T>> => {
      try { return { data: await read(), error: '', at: Date.now() } } catch (error) { return { ...target, error: reason(error) } }
    }
    ;[items, pulls, running] = await Promise.all([
      settle(items, async () => ((await gh({ operation: 'list', record_type: 'all', record_state: 'open', limit: 200, offset: 0 })).records ?? []) as GhRecord[]),
      settle(pulls, async () => await gh({ operation: 'green_pr' }) as GreenRead),
      settle(running, async () => ((await json<{ logs?: RunningLog[] }>(organizationUrl('/api/agent-logs?status=running'))).logs ?? []).filter((log) => log.status === 'running')),
    ])
    reportRead(ctx, 'overview-items', 'Issues and pull requests could not be read', items)
    reportRead(ctx, 'overview-pulls', 'Pull requests’ status checks could not be read', pulls)
    reportRead(ctx, 'overview-running', 'Running runs could not be read', running)
    paint()
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

  return {
    setChains(next, error, at) { chains = error ? { ...chains, error } : { data: next, error: '', at }; paint() },
    role: (chat) => sessions.data?.get(chat)?.role ?? null,
    sessions: () => [...(sessions.data?.values() ?? [])],
    onSessions: (listener) => { sessionListeners.add(listener) },
  }
}
