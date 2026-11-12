// System health in Overview (#1101, served since #1137): five live cards over
// the last 24 hours of v2 chain work, each opening the evidence behind it.
// Classic Analytics' read and figures (src/analytics-health.ts), in the mocks' words.
import type { AnalyticsHealth, HealthSource } from '../../../analytics-health-types'
import { formatCount, formatDuration, formatRate } from '../../../analytics-format'
import { organizationUrl } from '../../../organizations'
import { $, esc } from '../../dom'
import { clockAt, json, readLine, reason, reportRead, unread, whileVisible, type PartContext, type Read } from './util'

const OK = ['ok', 'verified v2']

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

export function mountHealth(ctx: PartContext, box: HTMLElement): void {
  let health: Read<AnalyticsHealth> = unread()
  let generation = 0

  function card(ref: string, value: string, note: string): void {
    const el = $(`[data-ref="${ref}"]`, box)
    $('.osmall-v', el).innerHTML = value
    el.querySelector(':scope > .t-gloss').textContent = note
  }

  function paint(): void {
    const line = readLine('System health', health)
    $('[data-healthfail]', box).innerHTML = line ? `<p class="onote is-warn ova-fail" role="status" data-ref="ov.read">${esc(line)}</p>` : ''
    const data = health.data
    if (!data) return
    const { rate, blocked, recovery, lastError: { error, lastObserved, coveredSince, coveredUntil } } = data
    card('ov.h.errors', rate.perItem === null ? 'Unavailable' : `${esc(formatRate(rate.perItem))}<span class="t-gloss"> per item</span>`, `${formatCount(rate.errors)} errors across ${formatCount(rate.completed)} items completed`)
    card('ov.h.blocked', esc(formatCount(blocked.count)), blocked.oldestProgressAt === null ? 'none without verified progress' : `oldest ${formatDuration(data.readAt - blocked.oldestProgressAt)} without verified progress${blocked.largestStage ? ` · ${blocked.largestStage}` : ''}`)
    card('ov.h.recovery', esc(formatCount(recovery.automatic.length)), `${formatCount(recovery.intervention.length)} needed outside help`)
    card('ov.h.lasterror', error ? esc(formatDuration(data.readAt - error.at)) : coveredSince !== null && coveredUntil !== null ? 'None' : 'Unavailable',
      error ? `${lastObserved ? 'last observed ' : ''}at ${clockAt(error.at)} · ${error.work}` : coveredSince !== null && coveredUntil !== null ? `in the ${formatDuration(coveredUntil - coveredSince)} covered` : 'error coverage unknown')
    $('[data-ref="ov.h.coverage"] .hcov', box).innerHTML = data.coverage.map(sourceRow).join('')
    $('[data-ref="ov.h.coverage"] > .t-gloss', box).textContent = 'gaps in amber, unknown hollow'
  }

  async function read(): Promise<void> {
    const mine = ++generation
    try {
      const data = await json<AnalyticsHealth>(organizationUrl('/api/analytics/system-health'))
      if (!data?.rate || !data.blocked || !data.recovery || !data.lastError || !Array.isArray(data.coverage)) throw new Error('the service answered with something this page cannot read')
      if (mine !== generation) return
      health = { data, error: '', at: Date.now() }
    } catch (error) {
      if (mine !== generation) return
      // A failed read keeps what was read, with when.
      health = { ...health, error: reason(error) }
    }
    reportRead(ctx, 'overview-health', 'System health could not be read', health)
    paint()
  }

  whileVisible(ctx, 60_000, () => { void read() })
  window.addEventListener('poise:organization-filter-changed', () => { void read() }, { signal: ctx.signal })
}
