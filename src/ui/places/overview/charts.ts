// Overview's small charts, from the mocks' overview-ui.js, drawn over classic
// Analytics' geometry (src/analytics-history.ts): an unknown value breaks the
// line and never reads as zero. Points sit in a 100 by 100 box; dots are
// placed with --x and --y, so nothing stretches with the chart.
import { histogram, historyChart, type HistogramBin } from '../../../analytics-history'
import { esc } from '../../dom'

const dot = (cls: string, point: { x: number, y: number }) => `<i class="${cls}" style="--x: ${point.x}%; --y: ${point.y}%"></i>`

/** A year as a sparkline: the line, its area and the latest week marked. */
export function spark(values: readonly (number | null)[]): string {
  const chart = historyChart([...values])
  const latest = chart.points[chart.points.length - 1]
  return `<span class="spark" aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${chart.area ? `<path class="spark-a" d="${chart.area}"/>` : ''}${chart.line ? `<path class="spark-l" d="${chart.line}"/>` : ''}</svg>${latest ? dot('spark-last', latest) : ''}</span>`
}

/** The year with its readout: the latest week marked, the highest named. */
export function yearChart(values: readonly (number | null)[], label: string): string {
  const chart = historyChart([...values])
  const latest = chart.points[chart.points.length - 1]
  const highest = chart.max === null ? -1 : values.indexOf(chart.max)
  return `<div class="ychart" tabindex="0" role="img" aria-label="${esc(label)} over the past year, one point per week. Arrow keys move through the weeks." data-ychart>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${chart.area ? `<path class="y-a" d="${chart.area}"/>` : ''}${chart.line ? `<path class="y-l" d="${chart.line}"/>` : ''}</svg>
    ${chart.isolated.map((point) => dot('y-pt', point)).join('')}
    ${highest >= 0 && chart.points[highest] ? dot('y-max', chart.points[highest]!) : ''}${latest ? dot('y-last', latest) : ''}
    <i class="y-cur" data-cur hidden></i>
  </div>`
}

/** Where week `index` sits along the chart, in percent. */
export const weekAt = (index: number, count: number): number => (count > 1 ? (index / (count - 1)) * 100 : 50)

/** Five equal bins; unknown days are left out and real zeros stay. */
export function bins(values: readonly (number | null)[], min?: number, max?: number): { svg: string, bins: HistogramBin[], known: number } {
  const result = histogram([...values], min, max)
  const top = Math.max(1, ...result.map((bin) => bin.count))
  const known = result.reduce((sum, bin) => sum + bin.count, 0)
  const svg = `<svg class="yhist" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true" data-ref="ov.dist">${result.map((bin, i) => `<rect class="y-bin" x="${i * 20 + 1}" y="${(40 - (bin.count / top) * 38).toFixed(2)}" width="18" height="${((bin.count / top) * 38).toFixed(2)}"/>`).join('')}</svg>`
  return { svg, bins: result, known }
}

/** Today against typical by now: the bar is today, the tick is typical. */
export function bullet(current: number, typical: number, tone: string): string {
  const top = Math.max(current, typical) * 1.15 || 1
  return `<svg class="bullet is-${tone}" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="b-track" x="0" y="0" width="100" height="6"/><rect class="b-val" x="0" y="0" width="${((current / top) * 100).toFixed(1)}" height="6"/><rect class="b-typ" x="${((typical / top) * 100).toFixed(1)}" y="0" width="1.2" height="6"/></svg>`
}

/** A share as a short bar: success, use or a work type. */
export function bar(cls: string, share: number): string {
  const width = Math.max(0, Math.min(100, share))
  return `<svg class="${cls}" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="bar-t" width="100" height="6"/><rect class="bar-v" width="${width.toFixed(1)}" height="6"/></svg>`
}
