// System health in Overview (#1101, served since #1137): five live cards over
// the last 24 hours of v2 chain work, each opening the evidence behind it.
// Classic Analytics' read and figures (src/analytics-health.ts), in the mocks' words.
import type { AnalyticsHealth, HealthSource } from '../../../analytics-health-types'
import { formatCount, formatDuration, formatRate } from '../../../analytics-format'
import { getOrganizations, getSettings } from '../../../config'
import { getSelectedOrganization, organizationUrl } from '../../../organizations'
import { placeHref } from '../../address'
import { $, esc } from '../../dom'
import type { RightFilter } from './find'
import { clockAt, json, readLine, reason, reportRead, unread, whileVisible, type PartContext, type Read } from './util'

const OK = ['ok', 'verified v2']

/** The last read, kept across page loads: a reload paints it at once, then
 *  reads again. It stands only for the GitHub user, the organization chosen
 *  and the organizations configured, each with its status, it was read under:
 *  All orgs counts every configured organization, ready or not. */
interface LastHealth { key: string, data: AnalyticsHealth, at: number }
const LAST_HEALTH_KEY = 'poise-overview-health'
function healthKey(): string {
  const me = getSettings().me ?? ''
  const configured = getOrganizations().map((org) => `${org.login.toLowerCase()}:${org.status}`).sort().join(',')
  return me ? `${me}|${getSelectedOrganization()}|${configured}` : ''
}
const readable = (data: AnalyticsHealth | null | undefined): data is AnalyticsHealth =>
  !!data?.rate && !!data.blocked && !!data.recovery && !!data.lastError && Array.isArray(data.coverage)
function rememberedHealth(key: string): LastHealth | null {
  if (!key) return null
  try {
    const last = JSON.parse(localStorage.getItem(LAST_HEALTH_KEY) ?? 'null') as LastHealth | null
    return last?.key === key && readable(last.data) && Number.isFinite(last.at) ? last : null
  } catch {
    return null
  }
}

/** A source's row: its covered time, gaps and unknown time as a bar, or its status where it keeps no history. */
function sourceRow(source: HealthSource): string {
  const name = `<span>${esc(source.name === 'GitHub' ? `GitHub ${source.scope}` : source.name)}</span>`
  const parts = source.intervals ?? []
  const total = parts.reduce((sum, part) => sum + part.until - part.since, 0)
  if (!total) return `<li>${name}<span class="onote${OK.includes(source.status) ? '' : ' is-warn'}">${esc(source.status)}</span></li>`
  let x = 0
  const rects = parts.map((part) => { const w = (part.until - part.since) / total * 100; const rect = `<rect class="hb-${part.state}" x="${x}" width="${w}" height="6"/>`; x += w; return rect }).join('')
  const share = (state: string) => Math.round(parts.filter((part) => part.state === state).reduce((sum, part) => sum + part.until - part.since, 0) / total * 100)
  const words = (['covered', 'gap', 'unknown'] as const).filter((state) => share(state)).map((state) => `${share(state)}% ${state === 'gap' ? 'gaps' : state}`).join(', ')
  return `<li>${name}<svg class="hbar" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${esc(words)}"><title>${esc(words)}</title>${rects}</svg></li>`
}

export function mountHealth(ctx: PartContext, box: HTMLElement, find: RightFilter): void {
  const last = rememberedHealth(healthKey())
  let health: Read<AnalyticsHealth> = last ? { data: last.data, error: '', at: last.at } : unread()
  let generation = 0

  function card(ref: string, value: string, note: string): void {
    const el = $(`[data-ref="${ref}"]`, box)
    $('.osmall-v', el).innerHTML = value
    el.querySelector(':scope > .t-gloss').textContent = note
  }

  /** The search shows the cards whose name it finds, and says so when none. */
  function filter(): void {
    let shown = 0
    for (const el of box.querySelectorAll<HTMLElement>('.ohealth')) {
      el.hidden = !find.matches(el.querySelector('.otile-l')?.textContent, 'System health')
      if (!el.hidden) shown++
    }
    $('[data-healthnone]', box).innerHTML = shown ? '' : `<p class="onote" role="status">${esc(find.none())}</p>`
  }

  function paint(): void {
    filter()
    // The last error's card opens that diagnostic in Logging, or Logging while there is none.
    $('[data-ref="ov.h.lasterror"]', box).setAttribute('href', placeHref('observe', { part: 'logging', incident: health.data?.lastError.error?.incident, back: 'overview' }))
    const line = readLine('System health', health)
    $('[data-healthfail]', box).innerHTML = line ? `<p class="onote is-warn ova-fail" role="status" data-ref="ov.read">${esc(line)}</p>` : ''
    const data = health.data
    if (!data) {
      for (const ref of ['ov.h.errors', 'ov.h.blocked', 'ov.h.recovery', 'ov.h.lasterror']) card(ref, '—', 'Not read yet')
      $('[data-ref="ov.h.coverage"] .hcov', box).innerHTML = ''
      $('[data-ref="ov.h.coverage"] > .t-gloss', box).textContent = 'Not read yet'
      return
    }
    const { rate, blocked, recovery, lastError: { error, lastObserved, coveredSince, coveredUntil } } = data
    card('ov.h.errors', rate.perItem === null ? 'Unavailable' : `${esc(formatRate(rate.perItem))}<span class="t-gloss"> per item</span>`, `${formatCount(rate.errors)} errors across ${formatCount(rate.completed)} items completed${rate.perItem === null ? ' · rate requires a nonempty, complete lifetime cohort' : ''}`)
    card('ov.h.blocked', esc(formatCount(blocked.count)), blocked.oldestProgressAt === null ? 'none without verified progress' : `oldest ${formatDuration(data.readAt - blocked.oldestProgressAt)} without verified progress${blocked.largestStage ? ` · ${blocked.largestStage}` : ''}`)
    card('ov.h.recovery', esc(formatCount(recovery.automatic.length)), `${formatCount(recovery.intervention.length)} needed outside help`)
    card('ov.h.lasterror', error ? esc(formatDuration(data.readAt - error.at)) : coveredSince !== null && coveredUntil !== null ? 'None' : 'Unavailable',
      error ? `${lastObserved ? 'last observed ' : ''}at ${clockAt(error.at)} · ${error.work}` : coveredSince !== null && coveredUntil !== null ? `in the ${formatDuration(coveredUntil - coveredSince)} covered` : 'error coverage unknown')
    $('[data-ref="ov.h.coverage"] .hcov', box).innerHTML = data.coverage.map(sourceRow).join('')
    $('[data-ref="ov.h.coverage"] > .t-gloss', box).textContent = 'gaps in amber, unknown hollow'
  }

  async function read(): Promise<void> {
    const mine = ++generation
    const key = healthKey()
    try {
      const data = await json<AnalyticsHealth>(organizationUrl('/api/analytics/system-health'))
      if (!readable(data)) throw new Error('the service answered with something this page cannot read')
      if (mine !== generation) return
      health = { data, error: '', at: Date.now() }
      // A place left, or settings changed while it read, keeps nothing.
      if (key && !ctx.signal.aborted && key === healthKey()) {
        try { localStorage.setItem(LAST_HEALTH_KEY, JSON.stringify({ key, data, at: health.at } satisfies LastHealth)) } catch { /* the next page reads it anew */ }
      }
    } catch (error) {
      if (mine !== generation) return
      // A failed read keeps what was read, with when.
      health = { ...health, error: reason(error) }
    }
    reportRead(ctx, 'overview-health', 'System health could not be read', health)
    paint()
  }

  if (last) paint()
  whileVisible(ctx, 60_000, () => { void read() })
  find.onChange(filter)
  // Another organization's figures never stand for this one's.
  window.addEventListener('poise:organization-filter-changed', () => { health = unread(); paint(); void read() }, { signal: ctx.signal })
}
