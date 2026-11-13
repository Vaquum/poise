// Behaviors in Overview (#556: runs, minutes and success move here; the
// switches stay the same settings as Settings → Behaviors). Classic's reads:
// /api/behaviors through src/behaviors.ts, /api/behavior-metrics as
// src/views/behaviors-view.ts reads it, and /api/behavior-estimates for what
// is running now.
import { formatShortDuration } from '../../../analytics-format'
import type { BehaviorMetrics, BehaviorMetricsReport } from '../../../behavior-metrics'
import { BEHAVIORS, getLastTriggered, getPausedUntil, isBehaviorStateLoaded, isEnabled, setEnabled, type BehaviorKey } from '../../../behaviors'
import { getOrganizations, getSettings } from '../../../config'
import { placeHref } from '../../address'
import { $, esc } from '../../dom'
import { toast } from '../../shell'
import { bar } from './charts'
import type { ChosenDay } from './day'
import type { Entry } from './entries'
import type { RightFilter } from './find'
import { ago, clockAt, json, reason, readLine, reportRead, unread, whileVisible, type Read, type PartContext } from './util'

/** The agent behaviors' log names, as /api/behavior-estimates names them. */
const RUNNING_KEYS: Record<string, BehaviorKey> = {
  pr_review: 'review-new-prs', pr_approve: 'approve-prs', issue_review: 'review-new-issues', implement_issue: 'implement-issues', repair_pr: 'repair-prs',
}
interface Estimate { id: string, behavior: string, startedAt: string, estimate: { remainingMs: number } | { overrun: true } | null }

/** The last reads, kept across page loads: a reload paints them at once,
 *  then reads again. Each switch shows its last state but takes no press until
 *  Behaviors is read afresh. They stand only for the GitHub user and the
 *  organizations configured, each with its status; runs, time and success only
 *  for the day they were read for. Written at most once a minute. */
interface KeptState { on: boolean, paused: string | null, last: { at: string, target: string } | null }
interface LastBehaviors { key: string, at: number, since: string, state: Partial<Record<BehaviorKey, KeptState>>, metrics: BehaviorMetricsReport, estimates: Estimate[] }
const LAST_BEHAVIORS_KEY = 'poise-overview-behaviors'
const KEEP_EVERY_MS = 60_000
function behaviorsKey(): string {
  const me = getSettings().me ?? ''
  const configured = getOrganizations().map((org) => `${org.login.toLowerCase()}:${org.status}`).sort().join(',')
  return me ? `${me}|${configured}` : ''
}
function rememberedBehaviors(key: string): LastBehaviors | null {
  if (!key) return null
  try {
    const last = JSON.parse(localStorage.getItem(LAST_BEHAVIORS_KEY) ?? 'null') as LastBehaviors | null
    return last?.key === key && typeof last.at === 'number' && typeof last.since === 'string' && !!last.state && !!last.metrics?.behaviors && Array.isArray(last.estimates) ? last : null
  } catch {
    return null
  }
}

export interface BehaviorsTable {
  /** /api/behaviors was read again. */
  stateChanged(error: string): void
  /** Answer here's entries changed: the chips count them. */
  entriesChanged(entries: readonly Entry[]): void
  /** The right-hand side's day changed: runs, time and success follow it (#1380). */
  dayChanged(day: ChosenDay): void
}

export function mountBehaviors(ctx: PartContext, box: HTMLElement, find: RightFilter): BehaviorsTable {
  const { signal } = ctx
  let day: ChosenDay | null = null
  let metrics: Read<BehaviorMetricsReport> = unread()
  let estimates: Read<Estimate[]> = unread()
  let stateError = ''
  let entries: readonly Entry[] = []
  const rowErrors = new Map<BehaviorKey, string>()
  const saving = new Set<BehaviorKey>()
  let generation = 0
  let key = behaviorsKey()
  let last = rememberedBehaviors(key)
  let metricsFresh = false
  let keptAt = 0
  /** When the remembered estimates were read: a fresh read is always later. */
  const keptAtStart = last?.at ?? 0
  if (last) estimates = { data: last.estimates, error: '', at: last.at }

  /** Its switch, pause and last run: as read, or as last read while Behaviors reads afresh. */
  function stateOf(behavior: BehaviorKey): KeptState & { known: boolean, remembered: boolean } {
    const kept = last?.state[behavior]
    if (isBehaviorStateLoaded() || stateError || !kept) {
      const run = getLastTriggered(behavior)
      return { known: isBehaviorStateLoaded(), remembered: false, on: isEnabled(behavior), paused: getPausedUntil(behavior), last: run ? { at: run.at, target: run.target } : null }
    }
    return { ...kept, known: true, remembered: true }
  }

  /** Keeps what the table draws once Behaviors and the day's runs are read afresh, at most once a minute. */
  function keep(): void {
    if (!key || signal.aborted || key !== behaviorsKey() || !isBehaviorStateLoaded() || !metricsFresh || !metrics.data || !day || Date.now() - keptAt < KEEP_EVERY_MS) return
    keptAt = Date.now()
    const state = Object.fromEntries(BEHAVIORS.map((meta) => {
      const run = getLastTriggered(meta.key)
      return [meta.key, { on: isEnabled(meta.key), paused: getPausedUntil(meta.key), last: run ? { at: run.at, target: run.target } : null } satisfies KeptState]
    }))
    try { localStorage.setItem(LAST_BEHAVIORS_KEY, JSON.stringify({ key, at: keptAt, since: day.since, state, metrics: metrics.data, estimates: estimates.data ?? [] } satisfies LastBehaviors)) } catch { /* the next page reads them anew */ }
  }

  function runningWords(key: BehaviorKey): string {
    const runs = (estimates.data ?? []).filter((run) => RUNNING_KEYS[run.behavior] === key)
    if (!runs.length) return ''
    const first = runs[0]
    const left = first.estimate && 'remainingMs' in first.estimate ? ` · about ${formatShortDuration(first.estimate.remainingMs)} left` : first.estimate && 'overrun' in first.estimate ? ' · over its usual time' : ''
    return `${runs.length > 1 ? `${runs.length} running` : `running for ${ago(first.startedAt)}`}${left}`
  }

  function chips(key: BehaviorKey): string {
    const mine = entries.filter((entry) => entry.behaviors.includes(key))
    const counts = [['needs-you', 'needs you'], ['fault', 'fault'], ['auto', 'automatic']].map(([group, word]) => [mine.filter((entry) => entry.group === group), word] as const)
    return counts.filter(([of]) => of.length).map(([of, word]) => `<a class="chip is-outline" href="#answer" data-act="to-answers" data-entry="${esc(of[0].id)}">${of.length} ${word}</a>`).join('')
  }

  /** Runs, time and success, each a value or, where none can exist, why in words. */
  function numbers(m: BehaviorMetrics | null | undefined): string {
    if (m === undefined) {
      const why = metrics.data ? 'not reported by the service' : metrics.error ? 'not read: see above' : 'reading…'
      return `<td class="num" colspan="3"><span class="onote">${why}</span></td>`
    }
    if (m === null) return '<td class="num" colspan="3"><span class="onote is-warn" data-ref="ov.partial">unknown: some of its run records cannot be read</span></td>'
    const minutes = m.durationMinutes ?? 0
    const time = minutes === 0 ? '0s' : formatShortDuration(minutes * 60_000)
    const untimed = m.untimedRuns ? `<span class="onote" data-ref="ov.untimed">+ ${m.untimedRuns.toLocaleString('en-US')} untimed</span>` : ''
    const success = m.successRate !== null
      ? `<span class="okbar">${bar(`okb${m.successRate < 90 ? ' is-low' : ''}`, m.successRate)}${(Math.round(m.successRate * 10) / 10).toLocaleString('en-US')}%</span>`
      : `<span class="onote">${m.totalRuns ? 'none finished' : 'no runs'}</span>`
    return `<td class="num">${m.totalRuns.toLocaleString('en-US')}</td><td class="num">${time}${untimed}</td><td class="num">${success}</td>`
  }

  function row(key: BehaviorKey, label: string): string {
    const { known: loaded, remembered, on, paused, last } = stateOf(key)
    const m = metrics.data?.behaviors[key]
    const running = runningWords(key)
    const why = remembered ? 'Reading what is current: the switch works once read.'
      : !loaded ? 'Behaviors could not be read, so their switches are unknown.' : saving.has(key) ? 'Saving the last change.' : ''
    const lastRun = running
      ? `<span class="st" data-state="running"><span data-term="state.running">Running</span></span><span class="onote">${esc(running)}</span>`
      : last ? `<span class="onote"><a class="lnk" href="${esc(placeHref('observe', { part: 'behaviors', pr: /^[\w.-]+\/[\w.-]+#\d+$/.test(last.target) ? last.target : null, back: 'overview' }))}" title="See its runs in Observe">${clockAt(last.at)} · ${esc(last.target)}</a></span>` : '<span class="onote">No run recorded</span>'
    return `<tr data-beh="${key}" data-ref="ov.behavior">
      <td><button class="oswitch" aria-pressed="${loaded && on}" data-act="beh-toggle" aria-label="${esc(label)}: ${loaded ? (on ? 'on' : 'off') : 'unknown'}" data-ref="ov.behavior.switch"${why ? ` aria-disabled="true" data-why="${esc(why)}"` : ''}><span class="switch"></span></button></td>
      <th scope="row">${esc(label)}${paused && Date.parse(paused) > Date.now() ? `<span class="onote">paused until ${clockAt(paused)}</span>` : ''}${rowErrors.get(key) ? `<span class="onote is-warn" role="status">${esc(rowErrors.get(key)!)}</span>` : ''}</th>
      <td>${loaded && !on ? '<span class="onote">Off</span>' : lastRun}</td>
      ${numbers(m)}
      <td class="chips">${chips(key)}</td></tr>`
  }

  function paint(): void {
    const notes = [
      stateError ? `Behaviors could not be read: ${stateError}.` : '',
      readLine('Their runs, minutes and success', metrics),
      metrics.data?.error ? metrics.data.error : '',
      readLine('What is running now', estimates),
    ].filter(Boolean)
    const rows = BEHAVIORS.filter((meta) => find.matches(meta.label, getLastTriggered(meta.key)?.target))
    box.innerHTML = `<div class="obeh" data-ref="ov.behaviors">
      <div class="obeh-h"><span class="t-gloss" data-ref="ov.behaviors.day">Runs, time and success for ${esc(day?.label ?? 'the chosen day')}, as the day above</span>
      <a class="lnk" href="${esc(placeHref('settings', { settings: 'behaviors', back: 'overview' }))}">Settings for each behavior</a></div>
      ${notes.map((note) => `<p class="onote is-warn" role="status" data-ref="${note === metrics.data?.error ? 'ov.partial' : 'ov.read'}">${esc(note)}</p>`).join('')}
      <div class="otable-wrap"><table class="otable"><thead><tr><th scope="col"><span class="sr">On</span></th><th scope="col">Behavior</th><th scope="col">Last run</th><th scope="col" class="num">Runs</th><th scope="col" class="num">Time</th><th scope="col" class="num">Success</th><th scope="col"><span class="sr">In Answer here</span></th></tr></thead>
      <tbody>${rows.length ? rows.map((meta) => row(meta.key, meta.label)).join('') : `<tr><td colspan="7"><span class="onote" role="status">${esc(find.none())}</span></td></tr>`}</tbody></table></div></div>`
  }

  async function readMetrics(): Promise<void> {
    if (!day) return
    const mine = ++generation
    try {
      const data = await json<BehaviorMetricsReport>(`/api/behavior-metrics?${new URLSearchParams({ since: day.since, until: day.until })}`)
      if (!data?.behaviors) throw new Error('the service answered with something this page cannot read')
      if (mine !== generation) return
      metrics = { data, error: '', at: Date.now() }
      metricsFresh = true
      keep()
    } catch (error) {
      if (mine !== generation) return
      metrics = { ...metrics, error: reason(error) }
    }
    reportRead(ctx, 'overview-metrics', 'Behavior metrics could not be read', metrics)
    paint()
  }
  async function readEstimates(): Promise<void> {
    try {
      const data = await json<{ estimates?: Estimate[] }>('/api/behavior-estimates')
      if (!Array.isArray(data.estimates)) throw new Error('the service answered with something this page cannot read')
      estimates = { data: data.estimates, error: '', at: Date.now() }
    } catch (error) {
      estimates = { ...estimates, error: reason(error) }
    }
    reportRead(ctx, 'overview-estimates', 'Running behavior runs could not be read', estimates)
    paint()
  }

  box.addEventListener('click', (e) => {
    const target = e.target as Element
    const chip = target.closest<HTMLElement>('[data-act="to-answers"]')
    if (chip) { e.preventDefault(); (document.querySelector(`[data-answers] [data-notice="${CSS.escape(chip.dataset.entry ?? '')}"]`) as HTMLElement | null ?? document.querySelector('[data-answers] [data-ref="ov.answer"]') as HTMLElement | null)?.focus(); return }
    const toggle = target.closest<HTMLElement>('[data-act="beh-toggle"]')
    if (!toggle || toggle.matches('[aria-disabled="true"]')) return
    const key = toggle.closest<HTMLElement>('[data-beh]')!.dataset.beh as BehaviorKey
    const label = BEHAVIORS.find((meta) => meta.key === key)?.label ?? key
    const next = !isEnabled(key)
    saving.add(key)
    rowErrors.delete(key)
    paint()
    void setEnabled(key, next).then(() => {
      toast(`${label} is ${next ? 'on: it acts from its next run' : 'off: it stops before its next run'}. The same switch is in Settings.`, next ? 'running' : 'idle')
    }, (error: unknown) => {
      rowErrors.set(key, `Not saved: ${reason(error)}`)
    }).finally(() => { saving.delete(key); paint(); $(`[data-beh="${key}"] [data-act="beh-toggle"]`, box)?.focus() })
  }, { signal })

  // Settings read afresh may name another GitHub user or other organizations than the page opened on:
  // the last reads no longer stand, and this page keeps nothing.
  window.addEventListener('poise:settings-read', () => {
    if (!key || behaviorsKey() === key) return
    key = ''
    if (!last) return
    last = null
    if (!metricsFresh) metrics = { ...metrics, data: null }
    if (estimates.at && !estimates.error && estimates.data && estimates.at <= keptAtStart) estimates = unread()
    paint()
  }, { signal })

  paint()
  whileVisible(ctx, 60_000, () => { void readMetrics(); void readEstimates() })
  find.onChange(paint)
  return {
    dayChanged(next) {
      if (day && next.since === day.since && next.until === day.until) return
      day = next
      // The day's last read stands until its fresh one lands; another day's never does.
      metricsFresh = false
      metrics = last && last.since === next.since ? { data: last.metrics, error: '', at: last.at } : { ...metrics, data: null }
      paint()
      void readMetrics()
    },
    stateChanged(error) { stateError = error; paint(); keep() },
    entriesChanged(next) {
      const before = entries.map((entry) => `${entry.id}:${entry.group}`).join()
      entries = next
      if (before !== next.map((entry) => `${entry.id}:${entry.group}`).join()) paint()
    },
  }
}
