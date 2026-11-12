// Behaviors in Overview (#556: runs, minutes and success move here; the
// switches stay the same settings as Settings → Behaviors). Classic's reads:
// /api/behaviors through src/behaviors.ts, /api/behavior-metrics as
// src/views/behaviors-view.ts reads it, and /api/behavior-estimates for what
// is running now.
import { formatShortDuration } from '../../../analytics-format'
import type { BehaviorMetricsReport } from '../../../behavior-metrics'
import { BEHAVIORS, getLastTriggered, getPausedUntil, isBehaviorStateLoaded, isEnabled, setEnabled, type BehaviorKey } from '../../../behaviors'
import { TIME_RANGES, timeRangeWindow, type TimeRange } from '../../../time-range'
import { placeHref } from '../../address'
import { $, esc } from '../../dom'
import { toast } from '../../shell'
import { bar } from './charts'
import type { Entry } from './entries'
import { ago, clockAt, json, reason, readLine, reportRead, unread, whileVisible, type Read, type PartContext } from './util'

/** The agent behaviors' log names, as /api/behavior-estimates names them. */
const RUNNING_KEYS: Record<string, BehaviorKey> = {
  pr_review: 'review-new-prs', pr_approve: 'approve-prs', issue_review: 'review-new-issues', implement_issue: 'implement-issues', repair_pr: 'repair-prs',
}
interface Estimate { id: string, behavior: string, startedAt: string, estimate: { remainingMs: number } | { overrun: true } | null }

export interface BehaviorsTable {
  /** /api/behaviors was read again. */
  stateChanged(error: string): void
  /** Answer here's entries changed: the chips count them. */
  entriesChanged(entries: readonly Entry[]): void
}

export function mountBehaviors(ctx: PartContext, box: HTMLElement): BehaviorsTable {
  const { signal } = ctx
  let range: TimeRange = 'today'
  let metrics: Read<BehaviorMetricsReport> = unread()
  let estimates: Read<Estimate[]> = unread()
  let stateError = ''
  let entries: readonly Entry[] = []
  const rowErrors = new Map<BehaviorKey, string>()
  const saving = new Set<BehaviorKey>()
  let generation = 0

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

  function row(key: BehaviorKey, label: string): string {
    const loaded = isBehaviorStateLoaded()
    const on = isEnabled(key)
    const paused = getPausedUntil(key)
    const last = getLastTriggered(key)
    const m = metrics.data?.behaviors[key]
    const minutes = m?.durationMinutes
    const duration = minutes == null ? '—' : minutes === 0 ? '0s' : formatShortDuration(minutes * 60_000)
    const running = runningWords(key)
    const why = !loaded ? 'Behaviors could not be read, so their switches are unknown.' : saving.has(key) ? 'Saving the last change.' : ''
    const lastRun = running
      ? `<span class="st" data-state="running"><span data-term="state.running">Running</span></span><span class="onote">${esc(running)}</span>`
      : last ? `<span class="onote"><a class="lnk" href="${esc(placeHref('observe', { part: 'behaviors', pr: /^[\w.-]+\/[\w.-]+#\d+$/.test(last.target) ? last.target : null, back: 'overview' }))}" title="See its runs in Observe">${clockAt(last.at)} · ${esc(last.target)}</a></span>` : '<span class="onote">No run recorded</span>'
    return `<tr data-beh="${key}" data-ref="ov.behavior">
      <td><button class="oswitch" aria-pressed="${loaded && on}" data-act="beh-toggle" aria-label="${esc(label)}: ${loaded ? (on ? 'on' : 'off') : 'unknown'}" data-ref="ov.behavior.switch"${why ? ` aria-disabled="true" data-why="${esc(why)}"` : ''}><span class="switch"></span></button></td>
      <th scope="row">${esc(label)}${paused && Date.parse(paused) > Date.now() ? `<span class="onote">paused until ${clockAt(paused)}</span>` : ''}${rowErrors.get(key) ? `<span class="onote is-warn" role="status">${esc(rowErrors.get(key)!)}</span>` : ''}</th>
      <td>${loaded && !on ? '<span class="onote">Off</span>' : lastRun}</td>
      <td class="num">${m ? m.totalRuns.toLocaleString('en-US') : '—'}</td>
      <td class="num">${duration}</td>
      <td class="num">${m?.successRate == null ? '—' : `<span class="okbar">${bar(`okb${m.successRate < 90 ? ' is-low' : ''}`, m.successRate)}${(Math.round(m.successRate * 10) / 10).toLocaleString('en-US')}%</span>`}</td>
      <td class="chips">${chips(key)}</td></tr>`
  }

  function paint(): void {
    const notes = [
      stateError ? `Behaviors could not be read: ${stateError}.` : '',
      readLine('Their runs, minutes and success', metrics),
      metrics.data?.error ? metrics.data.error : '',
      readLine('What is running now', estimates),
    ].filter(Boolean)
    box.innerHTML = `<div class="obeh" data-ref="ov.behaviors">
      <div class="obeh-h"><div class="seg" role="group" aria-label="Range" data-ref="ov.range">${TIME_RANGES.map((r) => `<button aria-pressed="${r.key === range}" data-range="${r.key}">${esc(r.label)}</button>`).join('')}</div>
      <a class="lnk" href="${esc(placeHref('settings', { settings: 'behaviors', back: 'overview' }))}">Settings for each behavior</a></div>
      ${notes.map((note) => `<p class="onote is-warn" role="status" data-ref="${note === metrics.data?.error ? 'ov.partial' : 'ov.read'}">${esc(note)}</p>`).join('')}
      <div class="otable-wrap"><table class="otable"><thead><tr><th scope="col"><span class="sr">On</span></th><th scope="col">Behavior</th><th scope="col">Last run</th><th scope="col" class="num">Runs</th><th scope="col" class="num">Time</th><th scope="col" class="num">Success</th><th scope="col"><span class="sr">In Answer here</span></th></tr></thead>
      <tbody>${BEHAVIORS.map((meta) => row(meta.key, meta.label)).join('')}</tbody></table></div></div>`
  }

  async function readMetrics(): Promise<void> {
    const mine = ++generation
    try {
      const data = await json<BehaviorMetricsReport>(`/api/behavior-metrics?${new URLSearchParams(timeRangeWindow(range))}`)
      if (!data?.behaviors) throw new Error('the service answered with something this page cannot read')
      if (mine !== generation) return
      metrics = { data, error: '', at: Date.now() }
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
    const pick = target.closest<HTMLElement>('[data-range]')
    if (pick) { range = pick.dataset.range as TimeRange; metrics = { ...metrics, data: null }; paint(); void readMetrics(); return }
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

  paint()
  whileVisible(ctx, 60_000, () => { void readMetrics(); void readEstimates() })
  return {
    stateChanged(error) { stateError = error; paint() },
    entriesChanged(next) {
      const before = entries.map((entry) => `${entry.id}:${entry.group}`).join()
      entries = next
      if (before !== next.map((entry) => `${entry.id}:${entry.group}`).join()) paint()
    },
  }
}
