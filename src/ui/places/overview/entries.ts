// What Answer here lists (#556, Design → Answer here), from four sources each
// keyed by its own id: the notices feed (with Behaviors' diagnostics and the
// behavior chain's attention, joined as classic's rail joins them), open chat
// requests, the Switchboard's open decisions, and review threads. Pure: it
// turns what was read into entries; answers.ts reads, draws and acts.
import { evidenceReferences, type DiagnosticEvidence } from '../../../../gateway/src/diagnostics/evidence-contract'
import { STALLED_MESSAGE } from '../../../behavior-diagnostics'
import type { NotificationItem } from '../../../notification-items'
import type { Notice, NoticeKind } from '../../../notices'
import type { BlockerId, PrStatus } from '../board/model'
import { noticeGroup, STUCK_MS, type Group } from './level'
import type { State } from './states'
import { chatOpening, itemOf, journalStep, targetOpening, timelineHref, type Opening } from './targets'

export type Source = 'notice' | 'diagnostic' | 'chain' | 'request' | 'decision' | 'thread'

export interface Option { key: string, label: string, primary?: boolean, detail?: string | null }

export interface QuestionField {
  id: string
  header?: string
  question: string
  options: { label: string, description?: string }[]
  multiSelect: boolean
  freeText: boolean
}

export interface Entry {
  /** The source's own id, prefixed by source: an answer acts on it, never on a position. */
  id: string
  source: Source
  group: Group
  kind: string
  title: string
  who: string
  where: string
  /** The state capsule beside it; none for what plainly needs you. */
  state: State | null
  since: string | null
  /** One line under the title: who acts next, or what it is waiting on. */
  detail?: string
  body: string
  code?: string
  meta?: string
  why?: string
  details: string[]
  options: Option[]
  /** Actions that stay under the pointer with the card's other icons: [option key, label, icon]. */
  quiet?: { key: string, label: string, icon: string }[]
  /** A question's form: several questions, choices or free text. */
  questions?: QuestionField[]
  /** An answer in your own words: [button, placeholder, send]. */
  freeText?: { label: string, placeholder: string, send: string }
  open?: Opening
  github?: string
  diagnostic?: DiagnosticEvidence
  timeline?: string
  dismissable: boolean
  /** What Dismiss does to this entry, said on the entry: it never resumes, retries or tells a chat anything. */
  dismissWords: string
  /** What the entry reports, for its dismissal: a put-away entry returns when this changes. */
  revision: string
  silenceable: boolean
  /** The behaviors it concerns, for their chips in the Behaviors table. */
  behaviors: string[]
  /** Painted from the last read while its source reads afresh: shown, never answered. */
  remembered?: boolean
  notice?: Notice
  request?: { sessionId: string, id: string, kind: 'permission' | 'question', options: string[] }
  decision?: { id: number }
  thread?: { slug: string, id: string }
  chain?: { id: string, sequence: number }
  pull?: { repo: string, number: number, url: string }
}

export type Role = (chat: string) => 'manager' | 'worker' | null | undefined

// ---------- The notices feed, Behaviors' diagnostics and chain attention ----------
const KIND_WORDS: Record<NoticeKind, string> = {
  chat_waiting: 'Waiting', sign_in_needed: 'Sign-in needed', behavior_held: 'Behavior held', datastore_sync_failing: 'GitHub data',
  pr_ready: 'Ready to merge', review_requested: 'Review requested', pr_conflict: 'Merge conflict', chat_turn_finished: 'Turn finished',
  github_quota_warning: 'GitHub API', github_quota_exhausted: 'GitHub API', storage_low: 'Storage', ledger_queue_stalled: 'Ledger',
  ledger_capture_loss: 'Ledger', worker_idle: 'Idle slots', read_failed: 'Read failed', action_failed: 'Action failed',
  action_needed: 'Action needed', action_finished: 'Finished',
  behavior_metrics_incomplete: 'Incomplete metrics',
}

const GROUP_STATE: Record<Group, State | null> = { 'needs-you': null, fault: 'failed', auto: 'waiting' }
/** What Dismiss says on each kind of entry. */
const NOTICE_DISMISS = 'puts it away until it happens again'
const WAITING_DISMISS = 'hides it here; the chat still waits for your answer in Chat'

function pullOf(notice: Notice): Entry['pull'] {
  const target = notice.target
  if (!target || !('pullRequest' in target)) return undefined
  const item = itemOf(target.pullRequest)
  if (!item) return undefined
  const [repo, number] = item.split('#')
  return { repo, number: Number(number), url: target.pullRequest }
}

function noticeOptions(notice: Notice): Option[] {
  if (notice.kind === 'review_requested') return [{ key: 'approve', label: 'Approve', primary: true }]
  return []
}

/** Pull requests by `owner/repo#number`, in lower case: who moves each next. */
export type PrStatuses = ReadonlyMap<string, PrStatus>
export const prKey = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`

// A behavior moves the pull request on its own (server/behavior-pr-status.ts).
const PR_MOVING: readonly BlockerId[] = ['review_running', 'awaiting_review', 'ci_pending', 'behind', 'approved_not_enqueued', 'in_queue']

/** Group operational PR notices by the recorded behavior blocker. */
export function prGroup(row: PrStatus | undefined): Group {
  if (!row) return 'auto'
  if (row.ownership?.chainId) return 'auto'
  const { id, line } = row.blocker
  if (id === 'ci_failing') return /grey rerun pending/.test(line) ? 'auto' : 'fault'
  if (id === 'awaiting_review' && /cap reached/.test(line)) return 'fault'
  if (id === 'approved_not_enqueued' && /merge-prs (disabled|paused)/.test(line)) return 'fault'
  return PR_MOVING.includes(id) || id === 'unknown' ? 'auto' : 'fault'
}

/** What /api/behavior-ledger/pr-status answered, as pull requests' next actors.
 *  An unavailable answer is a failed read, never "no pull requests": it throws,
 *  so the last good read stays. An organization whose datastore could not be
 *  read keeps the rows read before. */
export function prStatusesFrom(value: unknown, previous: PrStatuses | null): Map<string, PrStatus> {
  const body = value as { health?: { status?: string }, rows?: unknown, datastore?: { orgs?: { org: string | null, status: string }[] } } | null
  if (!body || !Array.isArray(body.rows)) throw new Error('the service answered with something this page cannot read')
  if (body.health?.status === 'unavailable') throw new Error('Poise could not read its pull requests just now')
  const next = new Map((body.rows as PrStatus[]).map((row) => [prKey(row.repository, row.number), row]))
  const unread = new Set((body.datastore?.orgs ?? []).filter((org) => org.org && org.status !== 'ready').map((org) => org.org!.toLowerCase()))
  for (const [key, row] of previous ?? []) if (!next.has(key) && unread.has(row.repository.split('/')[0].toLowerCase())) next.set(key, row)
  return next
}

/** Diagnostics Poise retries on its own. */
const RETRYING = new Set(['head_changed', 'provider_capacity', 'rate_limit', 'upstream_unavailable', 'network_interruption',
  'approval_blocked_unresolved_conversations', 'datastore_stale', 'runtime_status_unknown'])

/** Behavior diagnostics describe faults and retries. Confirmed account
 *  sign-in requests come from the accounts themselves. */
export function diagnosticGroup(code: string | undefined, message: string): Group {
  if (code && RETRYING.has(code)) return 'auto'
  return code === 'unknown' && message === STALLED_MESSAGE ? 'auto' : 'fault'
}

/** Automatic work that has not moved for four hours is stuck. */
const stuck = (group: Group, since: string | null, now: number): Group => {
  const at = since === null ? NaN : Date.parse(since)
  return group === 'auto' && Number.isFinite(at) && now - at >= STUCK_MS ? 'fault' : group
}

const firstLine = (value: string): string => value.split('\n')[0].trim()

/** Classic's rail items as entries, by who acts. A notice joined with a
 *  diagnostic takes the diagnostic's group; a pull request's notice takes who
 *  moves the pull request next; finished work is not listed. Chain work never
 *  waits on you: held, or not moved for four hours, it is a fault. */
export function itemEntries(items: readonly NotificationItem[], role: Role, chains: ReadonlyMap<string, { sequence: number, held: string | null }>,
  prs: PrStatuses = new Map(), now = Date.now()): Entry[] {
  return items.flatMap((item): Entry[] => {
    const refs = evidenceReferences(item)
    const details = item.details.map((line) => line.detail)
    const base = { details, behaviors: item.behaviors, diagnostic: refs[0], since: item.when, meta: item.meta || undefined }
    if (item.notice) {
      const notice = item.notice
      const pull = pullOf(notice)
      const status = pull ? prs.get(prKey(pull.repo, pull.number)) : undefined
      const kept = item.details.length ? diagnosticGroup(item.code, item.body) : noticeGroup(notice.kind)
      if (kept === null) return []
      const byPull = !item.details.length && pull && (notice.kind === 'pr_ready' || notice.kind === 'pr_conflict')
      const group = stuck(byPull ? prGroup(status) : kept, item.when, now)
      return [{
        ...base, id: `notice:${notice.id}`, source: 'notice', group, kind: KIND_WORDS[notice.kind],
        // A pull request's own title; its notice's words are its kind and where.
        title: pull && notice.body ? notice.body : notice.title,
        detail: byPull ? status?.blocker.line ?? 'Behavior status unavailable' : pull ? undefined : firstLine(notice.body) || undefined,
        who: item.source, where: pull ? `${pull.repo} #${pull.number}` : item.scope ?? '', state: GROUP_STATE[group], body: notice.body, options: noticeOptions(notice),
        open: notice.target ? targetOpening(notice.target, role) : undefined, github: pull?.url,
        dismissable: true, dismissWords: NOTICE_DISMISS, revision: notice.due, silenceable: notice.silenceable, notice, pull,
      }]
    }
    if (item.chainJournal) {
      const step = journalStep(item.chainJournal)
      const row = item.chain
      // The attention row covers every active page; the chains map only its first 100.
      const paged = step ? chains.get(step.chain) : undefined
      const held = row && row.held !== undefined ? row.held : paged?.held ?? null
      const mergeSha = row?.mergeSha ?? null
      const sequence = typeof row?.sequence === 'number' ? row.sequence : paged?.sequence
      const progressed = row ? row.progressAt : Date.parse(item.when ?? '')
      const group: Group = held || !Number.isFinite(progressed) || now - progressed >= STUCK_MS ? 'fault' : 'auto'
      const resume = step && held && !mergeSha && typeof sequence === 'number' ? { id: step.chain, sequence } : undefined
      return [{
        ...base, id: item.id, source: 'chain', group, kind: held ? 'Chain held' : group === 'fault' ? 'Chain stuck' : 'Behavior chain',
        // Its first reason as the title; every reason, and the evidence, under More.
        title: row?.blocker ? firstLine(row.blocker).split('; ')[0] : item.title, detail: row ? row.step : item.meta,
        who: 'the chain', where: row ? `${row.repository} #${row.issue}${row.pullNumber ? ` → #${row.pullNumber}` : ''}` : '', state: GROUP_STATE[group], body: item.body,
        options: [], quiet: resume ? [{ key: 'resume', label: 'Resume the chain', icon: 'play' }] : undefined,
        timeline: step ? timelineHref(step.chain, step.after) : undefined, silenceable: false,
        dismissable: true, dismissWords: held ? 'hides it until the chain moves; the chain stays held' : 'hides it until the chain moves; nothing is retried',
        revision: `${item.when}|${item.title}|${item.body}`,
        chain: resume,
      }]
    }
    // A retry still failing four hours after it began is stuck.
    const group = stuck(diagnosticGroup(item.code, item.title), item.began ?? null, now)
    return [{
      ...base, id: item.id, source: 'diagnostic', group, kind: 'Behaviors', title: item.title, who: item.source,
      detail: [item.body, item.scope].filter(Boolean).join(' · ') || undefined,
      where: item.scope ?? '', state: GROUP_STATE[group], body: '',
      options: [], silenceable: false,
      dismissable: true, dismissWords: 'hides it until it happens again; nothing is retried', revision: `${item.when}|${item.title}`,
    }]
  })
}

// ---------- Open chat requests ----------
export interface OpenRequest {
  id: string
  kind: 'permission' | 'question'
  sessionId: string
  sessionTitle: string
  createdAt: string
  content: unknown
  escalation: string | null
  /** True when the request is for the workspace owner. */
  ownerAction: boolean
}

export interface RequestsRead { revision: number, complete: boolean, requests: OpenRequest[] }

/** The service's answer, or null when it is not one this page can draw. */
export function requestsFrom(value: unknown): RequestsRead | null {
  if (!value || typeof value !== 'object') return null
  const body = value as Record<string, unknown>
  if (!Number.isSafeInteger(body.revision) || !Array.isArray(body.requests)) return null
  const requests = body.requests.filter((request): request is OpenRequest => {
    const r = request as Partial<OpenRequest> | null
    return !!r && typeof r.id === 'string' && (r.kind === 'permission' || r.kind === 'question') && typeof r.sessionId === 'string'
      && typeof r.sessionTitle === 'string' && typeof r.createdAt === 'string'
  })
  return { revision: body.revision as number, complete: body.complete !== false, requests }
}

function preview(value: unknown, max = 600): string {
  if (value === undefined || value === null) return ''
  const textValue = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return textValue.length > max ? `${textValue.slice(0, max)}…` : textValue
}

function questionFields(content: unknown): QuestionField[] | null {
  const questions = (content as { questions?: unknown } | null)?.questions
  if (!Array.isArray(questions) || !questions.length) return null
  const fields = questions.filter((q): q is QuestionField => !!q && typeof q.id === 'string' && typeof q.question === 'string'
    && Array.isArray(q.options) && q.options.every((o: { label?: unknown }) => typeof o?.label === 'string'))
  return fields.length === questions.length ? fields.map((q) => ({ ...q, multiSelect: !!q.multiSelect, freeText: !!q.freeText })) : null
}

/** One entry per open request, in the request's own words and options. */
export function requestEntries(requests: readonly OpenRequest[], role: Role): Entry[] {
  return requests.flatMap((request): Entry[] => {
    if (request.ownerAction !== true) return []
    const base = {
      id: `request:${request.id}`, source: 'request' as const, group: 'needs-you' as const, who: request.sessionTitle,
      since: request.createdAt, state: null, details: [], behaviors: [], silenceable: false,
      dismissable: true, dismissWords: WAITING_DISMISS, revision: 'open',
      open: chatOpening(request.sessionId, role(request.sessionId)), why: request.escalation ?? undefined,
    }
    if (request.kind === 'permission') {
      const content = request.content as { title?: unknown, description?: unknown, input?: unknown, options?: unknown } | null
      const options = Array.isArray(content?.options) ? content!.options.filter((o: { id?: unknown, name?: unknown }) => typeof o?.id === 'string' && typeof o?.name === 'string') as { id: string, name: string, kind?: string }[] : []
      if (typeof content?.title !== 'string' || !options.length) return []
      return [{
        ...base, kind: 'Permission', title: content.title, where: request.sessionTitle, detail: 'Asks before a step', body: typeof content.description === 'string' ? content.description : '',
        code: preview(content.input) || undefined,
        options: options.map((o, i) => ({ key: o.id, label: o.name, primary: i === 0 })),
        request: { sessionId: request.sessionId, id: request.id, kind: 'permission', options: options.map((o) => o.id) },
      }]
    }
    const questions = questionFields(request.content)
    if (!questions) return []
    // One single-choice question answers with one press, or in your own words
    // where it takes them; several questions or several choices are Chat's form.
    const single = questions.length === 1 && !questions[0].multiSelect ? questions[0] : null
    const quick = single && (single.options.length || single.freeText) ? single : null
    // A Manager's question that offers options always takes Other, in your own
    // words, so it needs no Dismiss. One that takes only its options keeps Dismiss,
    // so no card is ever stuck.
    const other = questions.every((q) => q.freeText)
    const managerPrompt = role(request.sessionId) === 'manager' && questions.some((q) => q.options.length > 0) && other
    return [{
      ...base, kind: 'Question', title: questions.length === 1 ? questions[0].question : `${questions.length} questions`,
      where: request.sessionTitle, detail: request.escalation || (questions.length === 1 ? questions[0].header : undefined), body: '',
      options: quick ? quick.options.map((o, i) => ({ key: o.label, label: o.label, primary: i === 0, detail: o.description ?? null })) : [],
      questions: quick ? undefined : questions,
      freeText: quick?.freeText ? { label: quick.options.length ? 'Other' : 'Answer…', placeholder: `Your answer to ${request.sessionTitle}`, send: 'Send answer' } : undefined,
      request: { sessionId: request.sessionId, id: request.id, kind: 'question', options: quick ? [quick.id] : questions.map((q) => q.id) },
      ...(managerPrompt ? { dismissable: false, dismissWords: '' } : {}),
    }]
  })
}

// ---------- The Switchboard's open decisions ----------
export interface DecisionItem {
  id: number
  kind: string
  text: string
  detail: string | null
  createdAt: string
  source: { sessionId: string, title: string, exists: boolean, managed?: true, turnsSince?: number }
  options?: { id: string, label: string, detail: string | null, recommended: boolean }[]
  answer?: { label: string, freeText: boolean, at: string, relay: 'queued' | 'delivered' | 'held' }
  resolved?: { at: string, reason: string }
}

export const openDecision = (item: DecisionItem): boolean => item.kind === 'decision' && item.source.exists && !item.source.managed && !item.answer && !item.resolved

export function decisionEntries(items: readonly DecisionItem[], role: Role): Entry[] {
  return items.filter(openDecision).map((item): Entry => {
    const options = [...(item.options ?? [])].sort((a, b) => Number(b.recommended) - Number(a.recommended))
    const stale = item.source.turnsSince ? `${item.source.title} has started ${item.source.turnsSince === 1 ? 'a turn' : `${item.source.turnsSince} turns`} since it asked; the question may be out of date.` : ''
    return {
      id: `decision:${item.id}`, source: 'decision', group: 'needs-you', kind: 'Decision', title: item.text, who: item.source.title,
      where: item.source.title, detail: stale || undefined, state: null, since: item.createdAt, body: [item.detail, stale].filter(Boolean).join('\n'), details: [],
      options: options.map((o) => ({ key: o.id, label: o.recommended ? `${o.label} (recommended)` : o.label, primary: o.recommended, detail: o.detail })),
      freeText: { label: options.length ? 'Other' : 'Answer…', placeholder: `Your answer to ${item.source.title}`, send: 'Send answer' },
      open: chatOpening(item.source.sessionId, role(item.source.sessionId)),
      dismissable: !options.length, dismissWords: 'hides it from the Switchboard; the chat is told nothing',
      revision: 'open', silenceable: false, behaviors: [], decision: { id: item.id },
    }
  })
}

// ---------- Review threads on published documents ----------
export interface Publication {
  slug: string, site: string, repo: string, pr: number, prUrl: string,
  checkedAt: string | null, active: boolean, stale: boolean, problems: string[], retryAt?: string, openThreads: number,
}
export interface ThreadReview {
  id: string, kind: 'thread' | 'comment' | 'review', repo: string, site: string, pr: number, prUrl: string, path?: string,
  resolved: boolean, canReply: boolean, canResolve: boolean, messages: { author: string, body: string, createdAt: string }[]
}

const clip = (value: string, max: number): string => { const line = value.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line }

export function threadEntries(publication: Publication, reviews: readonly ThreadReview[], editorHref: (slug: string) => string): Entry[] {
  return reviews.filter((review) => review.kind === 'thread' && !review.resolved).map((review): Entry => {
    const first = review.messages[0]
    return {
      id: `thread:${publication.slug}:${review.id}`, source: 'thread', group: 'auto', kind: 'Review comment',
      title: first ? clip(first.body, 140) : 'An open review thread', who: first?.author ?? 'a reviewer',
      where: `${review.repo} #${review.pr}`, detail: `${first?.author ?? 'A reviewer'} on ${publication.site}${review.path ? ` · ${review.path}` : ''}`, state: null,
      since: review.messages[review.messages.length - 1]?.createdAt ?? null,
      body: review.messages.map((m) => `${m.author}: ${m.body}`).join('\n\n'), details: [],
      options: review.canResolve ? [{ key: 'resolve', label: 'Resolve', primary: !review.canReply }] : [],
      freeText: review.canReply ? { label: 'Reply…', placeholder: 'Your reply, posted on GitHub as you', send: 'Send reply' } : undefined,
      open: { href: editorHref(publication.slug), label: 'Open in Editor' }, github: review.prUrl,
      dismissable: true, dismissWords: 'hides it until someone replies; the thread stays open on GitHub',
      revision: `${review.messages.length}|${review.messages[review.messages.length - 1]?.createdAt ?? ''}`,
      silenceable: false, behaviors: [], thread: { slug: publication.slug, id: review.id },
    }
  })
}

// ---------- Together ----------
const GROUP_ORDER: Record<Group, number> = { 'needs-you': 0, fault: 1, auto: 2 }

/** By who acts, then newest first (#1379); an entry without a time goes last,
 *  and equal times keep their sources' order. */
export function ordered(entries: readonly Entry[]): Entry[] {
  const time = (entry: Entry) => { const at = entry.since === null ? NaN : Date.parse(entry.since); return Number.isFinite(at) ? at : -Infinity }
  return entries.map((entry, index) => ({ entry, index, at: time(entry) }))
    .sort((a, b) => GROUP_ORDER[a.entry.group] - GROUP_ORDER[b.entry.group] || (b.at === a.at ? 0 : b.at > a.at ? 1 : -1) || a.index - b.index)
    .map(({ entry }) => entry)
}

/** Sources whose put-away entries Answer here keeps (server/answer-dismissals.ts):
 *  notices and decisions keep their own dismissal. */
export const KEPT_DISMISSALS: readonly Source[] = ['chain', 'diagnostic', 'request', 'thread']

/** Entries not put away at the revision they report now. */
export function undismissed(entries: readonly Entry[], dismissals: ReadonlyMap<string, string>): Entry[] {
  return entries.filter((entry) => !KEPT_DISMISSALS.includes(entry.source) || dismissals.get(entry.id) !== entry.revision)
}

// ---------- The last read, kept across page loads ----------
/** An entry as Answer here drew it, small enough to keep: what a card shows at
 *  rest and where it opens, never what answering it needs. */
export interface KeptEntry {
  id: string, source: Source, group: Group, kind: string, title: string, where: string, since: string | null
  detail?: string, options?: string[], primary?: number, reply?: string, open?: Opening, github?: string, timeline?: string
}

const SOURCES: readonly Source[] = ['notice', 'diagnostic', 'chain', 'request', 'decision', 'thread']
const GROUPS_KEPT: readonly Group[] = ['needs-you', 'fault', 'auto']
const cut = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value

/** What a reload paints at once: at most 200 entries, their words cut to what a card shows. */
export function keepEntries(entries: readonly Entry[]): KeptEntry[] {
  return entries.slice(0, 200).map((entry): KeptEntry => ({
    id: entry.id, source: entry.source, group: entry.group, kind: entry.kind, title: cut(entry.title, 240), where: cut(entry.where, 120), since: entry.since,
    ...(entry.detail ? { detail: cut(entry.detail, 200) } : {}),
    ...(entry.options.length ? { options: entry.options.map((option) => cut(option.label, 80)), primary: Math.max(0, entry.options.findIndex((option) => option.primary)) } : {}),
    ...(entry.freeText ? { reply: entry.freeText.label } : {}),
    ...(entry.open ? { open: entry.open } : {}), ...(entry.github ? { github: entry.github } : {}), ...(entry.timeline ? { timeline: entry.timeline } : {}),
  }))
}

/** Kept entries as Answer here draws them, remembered: their answers show, unanswerable, until their source reads afresh.
 *  Anything kept in another shape is dropped, never guessed at. */
export function restoreEntries(value: unknown): Entry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((kept: KeptEntry): Entry[] => {
    if (!kept || typeof kept.id !== 'string' || !SOURCES.includes(kept.source) || !GROUPS_KEPT.includes(kept.group)
      || typeof kept.kind !== 'string' || typeof kept.title !== 'string' || typeof kept.where !== 'string') return []
    const options = Array.isArray(kept.options) ? kept.options.filter((label): label is string => typeof label === 'string') : []
    const href = (value: unknown) => typeof value === 'string' && (value.startsWith('?') || value.startsWith('https://')) ? value : undefined
    const open = kept.open && href(kept.open.href) && typeof kept.open.label === 'string' ? { href: kept.open.href, label: kept.open.label, ...(kept.open.external ? { external: true } : {}) } : undefined
    return [{
      id: kept.id, source: kept.source, group: kept.group, kind: kept.kind, title: kept.title, where: kept.where,
      since: typeof kept.since === 'string' ? kept.since : null, detail: typeof kept.detail === 'string' ? kept.detail : undefined,
      who: '', state: GROUP_STATE[kept.group], body: '', details: [], behaviors: [],
      options: options.map((label, i) => ({ key: label, label, primary: i === kept.primary })),
      freeText: typeof kept.reply === 'string' ? { label: kept.reply, placeholder: '', send: '' } : undefined,
      open, github: href(kept.github), timeline: href(kept.timeline),
      dismissable: false, dismissWords: '', revision: 'remembered', silenceable: false, remembered: true,
    }]
  })
}
