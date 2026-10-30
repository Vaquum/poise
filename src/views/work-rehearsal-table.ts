import type { WorkDecision, WorkObservation } from '../../server/work-rehearsal'
import type { SessionStatus } from '../../server/chat/protocol'
import { patchContent } from '../dom-patch'
import { escapeHtml } from '../markdown'
import { CHAT_MIN_WIDTH } from './chat-sidebar'

export interface RehearsalTableRow {
  work: WorkObservation
  title: string
  manager: string | null
  worker: { id: string, title: string, status: SessionStatus } | null
  decision: WorkDecision
  history: Array<{ seq: number, at: number, text: string }>
}
export interface RehearsalTableData {
  manager: string | null
  observedAt: number
  release: string | null
  error: string | null
  rows: RehearsalTableRow[]
}

/** Read-only composition used by the offline rehearsal. No production entry imports it. */
export function mountWorkRehearsalTable(view: HTMLElement, initial: RehearsalTableData, openChat: (id: string) => void) {
  const layout = view.querySelector<HTMLElement>('.chat-layout')
  const chat = view.querySelector<HTMLElement>('.chat-main')
  if (!layout || !chat) throw new Error('the shared Chat view must be mounted first')
  const el = document.createElement('section')
  el.className = 'work-rehearsal-table'
  el.setAttribute('aria-label', 'Work rehearsal')
  el.innerHTML = '<header><strong>Work rehearsal</strong><label>Width <input type="range" aria-label="Resize work table" min="180" max="600" value="300" step="16"></label></header><p role="status"></p><div class="work-table-scroll"><table><thead><tr><th>Task</th><th>PR / issue</th><th>Worker</th><th>Status</th><th>Conflicts</th><th>Open review</th><th>Behind main</th><th>CI failing</th><th>Now</th><th>Latest changes</th></tr></thead><tbody></tbody></table></div>'
  chat.after(el)
  const body = el.querySelector('tbody')!
  const status = el.querySelector<HTMLElement>('[role="status"]')!
  const range = el.querySelector<HTMLInputElement>('input')!
  const previousFloor = chat.style.minWidth
  chat.style.minWidth = `${CHAT_MIN_WIDTH}px`
  let preferred = 300
  const resize = () => {
    const occupied = [...layout.children].filter(node => node !== el && node !== chat)
      .reduce((sum, node) => sum + (getComputedStyle(node).position === 'absolute' ? 0 : node.getBoundingClientRect().width), 0)
    const max = Math.max(180, layout.clientWidth - occupied - CHAT_MIN_WIDTH)
    range.max = String(Math.floor(max))
    el.style.width = `${Math.min(preferred, max)}px`
  }
  range.addEventListener('input', () => { preferred = Number(range.value); resize() })
  const observer = new ResizeObserver(resize)
  observer.observe(layout)
  for (const pane of layout.children) if (pane !== el && pane !== chat) observer.observe(pane)
  let data = initial
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-worker]')
    if (button) openChat(button.dataset.worker!)
  }
  el.addEventListener('click', click)

  function update(next: RehearsalTableData, now = Date.now()): void {
    data = next
    const age = Math.max(0, Math.floor((now - data.observedAt) / 1000))
    status.textContent = `Proposals only · observed ${new Date(data.observedAt).toISOString()} (${age}s ago) · serving ${data.release ?? 'unknown'}${data.error ? ` · refresh failed: ${data.error}` : ''}`
    const flag = (value: boolean | null) => value === null ? '?' : value ? '☑' : '☐'
    patchContent(body, data.rows.filter(row => row.manager === data.manager).map(row => {
      const work = row.work
      const stage = work.stage
      const pr = stage.kind === 'pull' ? stage : null
      const fresh = !data.error && work.checkedAt <= now && now - work.checkedAt <= 5 * 60_000
      const ci = fresh && pr && pr.ci?.head === pr.head ? pr.ci : null
      const flags = [ci?.mergeable === undefined || ci.mergeable === null ? null : !ci.mergeable,
        fresh && pr?.unresolved !== undefined && pr.unresolved !== null ? pr.unresolved > 0 : null,
        ci?.mergeableState ? ci.mergeableState === 'behind' : null,
        ci ? ci.failing.length > 0 ? true : ci.pending === false ? false : null : null]
      const target = stage.kind === 'plan' ? 'No issue yet'
        : /^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/(issues|pull)\/[1-9][0-9]*$/i.test(stage.target.url)
          ? `<a href="${escapeHtml(stage.target.url)}">#${stage.target.number}</a>` : escapeHtml(stage.target.url)
      const action = row.decision.kind === 'propose' ? `Proposed: ${row.decision.action}` : row.decision.reason
      const history = row.history.map(change => `<li data-id="${change.seq}"><time>${escapeHtml(new Date(change.at).toISOString())}</time> ${escapeHtml(change.text)}</li>`).join('')
      return `<tr data-id="${escapeHtml(work.id)}"><td>${escapeHtml(row.title)}</td><td>${target}${pr ? `<br><code>${escapeHtml(pr.head.slice(0, 7))}</code>` : ''}</td><td>${row.worker ? `<button type="button" data-worker="${escapeHtml(row.worker.id)}">${escapeHtml(row.worker.title)}</button>` : 'Headless'}</td><td>${escapeHtml(row.worker?.status ?? row.decision.kind)}${fresh ? '' : ' (last known)'}</td>${flags.map(value => `<td>${flag(value)}</td>`).join('')}<td>${escapeHtml(action)}</td><td><ol>${history}</ol></td></tr>`
    }).join('') || '<tr><td colspan="10">No assigned work in this recording.</td></tr>')
    resize()
  }
  update(initial)
  return { update, remove() { observer.disconnect(); el.removeEventListener('click', click); el.remove(); chat.style.minWidth = previousFloor } }
}
