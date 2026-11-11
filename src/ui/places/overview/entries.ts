// What Answer here lists (#556, Design → Answer here), from four sources each
// keyed by its own id: the notices feed (with Behaviors' diagnostics and the
// behavior chain's attention, joined as classic's rail joins them), open chat
// requests, the Switchboard's open decisions, and review threads. Pure: it
// turns what was read into entries; answers.ts reads, draws and acts.
import { evidenceReferences, type DiagnosticEvidence } from '../../../../gateway/src/diagnostics/evidence-contract'
import type { NotificationItem } from '../../../notification-items'
import type { Notice, NoticeKind } from '../../../notices'
import { noticeGroup, type Group } from './level'
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
  body: string
  code?: string
  meta?: string
  why?: string
  details: string[]
  options: Option[]
  /** A question's form: several questions, choices or free text. */
  questions?: QuestionField[]
  /** An answer in your own words: [button, placeholder, send]. */
  freeText?: { label: string, placeholder: string, send: string }
  open?: Opening
  github?: string
  diagnostic?: DiagnosticEvidence
  timeline?: string
  dismissable: boolean
  silenceable: boolean
  /** The behaviors it concerns, for their chips in the Behaviors table. */
  behaviors: string[]
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
}

const ITEM_GROUP: Record<NotificationItem['group'], Group> = { needs: 'needs-you', faults: 'fault', ready: 'ready', auto: 'auto' }
const GROUP_STATE: Record<Group, State | null> = { 'needs-you': null, fault: 'failed', ready: 'done', auto: 'waiting' }

function pullOf(notice: Notice): Entry['pull'] {
  const target = notice.target
  if (!target || !('pullRequest' in target)) return undefined
  const item = itemOf(target.pullRequest)
  if (!item) return undefined
  const [repo, number] = item.split('#')
  return { repo, number: Number(number), url: target.pullRequest }
}

function noticeOptions(notice: Notice): Option[] {
  if (notice.kind === 'pr_ready') return [{ key: 'merge', label: 'Merge', primary: true }]
  if (notice.kind === 'review_requested') return [{ key: 'review', label: 'Ask an agent to review', primary: true }, { key: 'approve', label: 'Approve' }]
  return []
}

/** Classic's rail items as entries. A notice joined with a diagnostic takes
 *  the diagnostic's group, which says who can correct it; a notice alone
 *  takes its kind's group; chain work that needs attention needs you. */
export function itemEntries(items: readonly NotificationItem[], role: Role, chains: ReadonlyMap<string, { sequence: number, held: string | null }>): Entry[] {
  return items.map((item): Entry => {
    const refs = evidenceReferences(item)
    const details = item.details.map((line) => line.detail)
    const base = { details, behaviors: item.behaviors, diagnostic: refs[0], since: item.when, meta: item.meta || undefined }
    if (item.notice) {
      const notice = item.notice
      const group = item.details.length ? ITEM_GROUP[item.group] : noticeGroup(notice.kind)
      const pull = pullOf(notice)
      return {
        ...base, id: `notice:${notice.id}`, source: 'notice', group, kind: KIND_WORDS[notice.kind], title: notice.title,
        who: item.source, where: item.scope ?? '', state: GROUP_STATE[group], body: notice.body, options: noticeOptions(notice),
        open: notice.target ? targetOpening(notice.target, role) : undefined, github: pull?.url,
        dismissable: true, silenceable: notice.silenceable, notice, pull,
      }
    }
    if (item.chainJournal) {
      const step = journalStep(item.chainJournal)
      const chain = step ? chains.get(step.chain) : undefined
      return {
        ...base, id: item.id, source: 'chain', group: 'needs-you', kind: chain?.held ? 'Chain held' : 'Behavior chain', title: item.title,
        who: 'the chain', where: '', state: chain?.held ? null : 'waiting', body: item.body,
        options: step && chain?.held ? [{ key: 'resume', label: 'Resume', primary: true }] : [],
        timeline: step ? timelineHref(step.chain, step.after) : undefined, dismissable: false, silenceable: false,
        chain: step && chain ? { id: step.chain, sequence: chain.sequence } : undefined,
      }
    }
    const group = ITEM_GROUP[item.group]
    return {
      ...base, id: item.id, source: 'diagnostic', group, kind: 'Behaviors', title: item.title, who: item.source,
      where: [item.body, item.scope].filter(Boolean).join(' · '), state: group === 'auto' ? 'waiting' : GROUP_STATE[group], body: '',
      options: [], dismissable: false, silenceable: false,
    }
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
    const base = {
      id: `request:${request.id}`, source: 'request' as const, group: 'needs-you' as const, who: request.sessionTitle,
      since: request.createdAt, state: null, details: [], behaviors: [], dismissable: false, silenceable: false,
      open: chatOpening(request.sessionId, role(request.sessionId)), why: request.escalation ?? undefined,
    }
    if (request.kind === 'permission') {
      const content = request.content as { title?: unknown, description?: unknown, input?: unknown, options?: unknown } | null
      const options = Array.isArray(content?.options) ? content!.options.filter((o: { id?: unknown, name?: unknown }) => typeof o?.id === 'string' && typeof o?.name === 'string') as { id: string, name: string, kind?: string }[] : []
      if (typeof content?.title !== 'string' || !options.length) return []
      return [{
        ...base, kind: 'Permission', title: content.title, where: 'asks before a step', body: typeof content.description === 'string' ? content.description : '',
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
    return [{
      ...base, kind: 'Question', title: questions.length === 1 ? questions[0].question : `${questions.length} questions`,
      where: questions.length === 1 && questions[0].header ? questions[0].header : 'asks you', body: '',
      options: quick ? quick.options.map((o, i) => ({ key: o.label, label: o.label, primary: i === 0, detail: o.description ?? null })) : [],
      questions: quick ? undefined : questions,
      freeText: quick?.freeText ? { label: quick.options.length ? 'Something else…' : 'Answer…', placeholder: `Your answer to ${request.sessionTitle}`, send: 'Send answer' } : undefined,
      request: { sessionId: request.sessionId, id: request.id, kind: 'question', options: quick ? [quick.id] : questions.map((q) => q.id) },
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
  source: { sessionId: string, title: string, exists: boolean, turnsSince?: number }
  options?: { id: string, label: string, detail: string | null, recommended: boolean }[]
  answer?: { label: string, freeText: boolean, at: string, relay: 'queued' | 'delivered' | 'held' }
  resolved?: { at: string, reason: string }
}

export const openDecision = (item: DecisionItem): boolean => item.kind === 'decision' && !item.answer && !item.resolved

export function decisionEntries(items: readonly DecisionItem[], role: Role): Entry[] {
  return items.filter(openDecision).map((item): Entry => {
    const options = [...(item.options ?? [])].sort((a, b) => Number(b.recommended) - Number(a.recommended))
    const stale = item.source.turnsSince ? `${item.source.title} has started ${item.source.turnsSince === 1 ? 'a turn' : `${item.source.turnsSince} turns`} since it asked; the question may be out of date.` : ''
    return {
      id: `decision:${item.id}`, source: 'decision', group: 'needs-you', kind: 'Decision', title: item.text, who: item.source.title,
      where: 'brought by the Switchboard', state: null, since: item.createdAt, body: [item.detail, stale].filter(Boolean).join('\n'), details: [],
      options: options.map((o) => ({ key: o.id, label: o.recommended ? `${o.label} (recommended)` : o.label, primary: o.recommended, detail: o.detail })),
      freeText: { label: options.length ? 'Something else…' : 'Answer…', placeholder: `Your answer to ${item.source.title}`, send: 'Send answer' },
      open: item.source.exists ? chatOpening(item.source.sessionId, role(item.source.sessionId)) : undefined,
      dismissable: false, silenceable: false, behaviors: [], decision: { id: item.id },
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
      id: `thread:${publication.slug}:${review.id}`, source: 'thread', group: 'needs-you', kind: 'Review comment',
      title: first ? clip(first.body, 140) : 'An open review thread', who: first?.author ?? 'a reviewer',
      where: `${publication.site} · ${review.repo}#${review.pr}${review.path ? ` · ${review.path}` : ''}`, state: null,
      since: review.messages[review.messages.length - 1]?.createdAt ?? null,
      body: review.messages.map((m) => `${m.author}: ${m.body}`).join('\n\n'), details: [],
      options: review.canResolve ? [{ key: 'resolve', label: 'Resolve', primary: !review.canReply }] : [],
      freeText: review.canReply ? { label: 'Reply…', placeholder: 'Your reply, posted on GitHub as you', send: 'Send reply' } : undefined,
      open: { href: editorHref(publication.slug), label: 'Open in Editor' }, github: review.prUrl,
      dismissable: false, silenceable: false, behaviors: [], thread: { slug: publication.slug, id: review.id },
    }
  })
}

// ---------- Together ----------
/** A chat's waiting notice folds into its request entries, one per request;
 *  it stands on its own only while none of its requests is listed. */
export function foldWaiting(entries: readonly Entry[]): Entry[] {
  const asking = new Set(entries.flatMap((entry) => entry.request ? [entry.request.sessionId] : []))
  return entries.filter((entry) => {
    const target = entry.notice?.kind === 'chat_waiting' ? entry.notice.target : null
    return !(target && 'chat' in target && asking.has(target.chat))
  })
}

const GROUP_ORDER: Record<Group, number> = { 'needs-you': 0, fault: 1, ready: 2, auto: 3 }

/** By who acts, then as each source lists them: requests and decisions first,
 *  for whoever asked is waiting. */
export function ordered(entries: readonly Entry[]): Entry[] {
  const SOURCE_ORDER: Record<Source, number> = { request: 0, decision: 1, notice: 2, chain: 3, thread: 4, diagnostic: 5 }
  return entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => GROUP_ORDER[a.entry.group] - GROUP_ORDER[b.entry.group] || SOURCE_ORDER[a.entry.source] - SOURCE_ORDER[b.entry.source] || a.index - b.index)
    .map(({ entry }) => entry)
}
