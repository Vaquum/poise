// The Timers pane: one chat's timers, its hold, and the workspace hold-all.
// Rendered by chat-view into #chat-timers-pane from GET …/timers, refetched
// every 30 s while open and on timer frames. Every label and message is
// escaped; times use Chat's clock.
import type { ChatClient } from '../chat-client'
import { shortTime } from '../clock'
import { effectiveTimezone } from '../config'
import { escapeHtml } from '../markdown'
import type { SessionRecord, TimerInput, TimerView } from '../../server/chat/protocol'
import { timerSetterName } from './chat-transcript'

export interface TimerPaneActions {
  add(input: TimerInput): Promise<void>
  cancel(timerId: string): Promise<void>
  rearm(timerId: string): Promise<void>
  hold(held: boolean): Promise<void>
  holdAll(held: boolean): Promise<void>
}

type TimersData = Awaited<ReturnType<ChatClient['timers']>>
// Pending creates outlive a refetch or a visit to another chat's pane.
const pendingAdds = new WeakMap<HTMLElement, Set<string>>()

function scheduleText(timer: TimerView): string {
  return timer.schedule.kind === 'every' ? `every ${timer.schedule.minutes} min` : `once in ${timer.schedule.delayMinutes} min`
}

function statusText(timer: TimerView, session: SessionRecord, zone: string, now: number): string {
  if (timer.state === 'tripped') return 'stopped after 3 failed turns'
  if (timer.state === 'done') return 'ended'
  if (timer.state === 'cancelled') return 'cancelled'
  if (timer.state === 'expired') return 'expired'
  if (timer.state === 'held') {
    if (timer.reason === 'person_stopped') return 'on hold: you stopped this chat'
    if (timer.reason === 'person_held') return 'on hold: you put this chat on hold'
    return 'on hold: all timers are on hold'
  }
  const waiting = timer.pending?.waitingFor
  if (!timer.pending) return timer.nextAt ? `next ${shortTime(timer.nextAt, zone, now)}` : 'due now'
  if (!waiting) return 'due now'
  switch (waiting) {
    case 'starting': case 'running': case 'stopping': return `waiting: chat is ${waiting}`
    case 'queued': return `waiting: chat is queued${session.queuedBehind ? ` (${session.queuedBehind})` : ''}`
    case 'waiting': return 'waiting: chat is waiting for an answer or permission'
    case 'maintenance': return 'waiting: chat is resetting or compacting'
    case 'queue': return 'waiting for queued tasks'
    case 'reopening': return 'waiting: reopening the chat'
    case 'model': return 'waiting: choose a model for the Manager'
    case 'person': return 'waiting: you were just here'
    case 'update': return 'waiting: Poise is updating'
    case 'backoff': return `waiting: retry after ${timer.notBefore ? shortTime(timer.notBefore, zone, now) : 'a while'}`
  }
}

export function renderTimersPane(container: HTMLElement, session: SessionRecord, data: TimersData, actions: TimerPaneActions): void {
  container.dataset.timersSession = session.id
  let adding = pendingAdds.get(container)
  if (!adding) { adding = new Set(); pendingAdds.set(container, adding) }
  const pending = adding
  const updateSubmit = (): void => {
    if (container.dataset.timersSession !== session.id) return
    const submit = container.querySelector<HTMLButtonElement>('.chat-timers-submit')
    if (submit) submit.disabled = pending.has(session.id)
  }
  const zone = effectiveTimezone()
  const now = Date.now()
  const hold = data.holds.find(h => h.sessionId === session.id) ?? null
  const allHeld = data.allHeld?.held === true
  const lastTick = data.scheduler.lastTickAt ? Date.parse(data.scheduler.lastTickAt) : NaN
  const schedulerDown = !data.scheduler.running || !Number.isFinite(lastTick) || now - lastTick > 60_000
  // A refetch re-render keeps the add form's draft.
  const draft = {
    label: container.querySelector<HTMLInputElement>('.chat-timers-label')?.value ?? '',
    message: container.querySelector<HTMLTextAreaElement>('.chat-timers-message')?.value ?? '',
    kind: container.querySelector<HTMLSelectElement>('.chat-timers-kind')?.value ?? 'every',
    minutes: container.querySelector<HTMLInputElement>('.chat-timers-minutes')?.value ?? '',
  }
  const rows = data.timers.map(timer => {
    const waitingSince = timer.pending ? ` · waiting since ${shortTime(timer.pending.since, zone, now)}` : ''
    return `<li class="chat-timer" data-timer="${escapeHtml(timer.id)}">`
      + `<div class="chat-timer-label">${escapeHtml(timer.label)}</div>`
      + `<div class="chat-timer-meta">${escapeHtml(scheduleText(timer))} · set by ${escapeHtml(timerSetterName(timer.setBy))}</div>`
      + `<div class="chat-timer-preview">${escapeHtml(timer.preview)}</div>`
      + `<div class="chat-timer-status">${escapeHtml(statusText(timer, session, zone, now))}${escapeHtml(waitingSince)}</div>`
      + `<div class="chat-timer-actions"><button type="button" class="chat-h-btn chat-timer-cancel" aria-label="Cancel timer ${escapeHtml(timer.label)}">Cancel</button>`
      + (timer.state === 'tripped' ? `<button type="button" class="chat-h-btn chat-timer-rearm" aria-label="Re-arm timer ${escapeHtml(timer.label)}">Re-arm</button>` : '')
      + `</div></li>`
  }).join('')
  container.innerHTML = `<div class="chat-timers">`
    + `<div class="chat-timers-controls"><button type="button" class="chat-h-btn chat-timers-hold" aria-pressed="${hold !== null}">${hold ? 'Resume' : 'Hold'}</button>`
    + `<button type="button" class="chat-h-btn chat-timers-hold-all" aria-pressed="${allHeld}">${allHeld ? 'Resume all timers' : 'Hold all timers'}</button></div>`
    + (schedulerDown ? `<div class="st-help st-help-error chat-timers-down" role="status">Timers are not running${data.scheduler.error ? `: ${escapeHtml(data.scheduler.error)}` : ''}</div>` : '')
    + (data.timers.length ? `<ul class="chat-timers-list">${rows}</ul>` : `<div class="chat-timers-empty">No timers on this chat yet.</div>`)
    + `<form class="chat-timers-add">`
    + (hold ? `<div class="st-help st-help-info">On hold: new timers start when you resume.</div>` : '')
    + `<label>Label<input type="text" class="chat-timers-label" name="label" maxlength="80" required></label>`
    + `<label>Message<textarea class="chat-timers-message" name="message" rows="2" required></textarea></label>`
    + `<label>Schedule<select class="chat-timers-kind" name="kind"><option value="every">Every</option><option value="once">Once</option></select></label>`
    + `<label>Minutes<input type="number" class="chat-timers-minutes" name="minutes" min="1" required></label>`
    + `<div class="chat-timers-error" role="alert" hidden></div>`
    + `<button type="submit" class="chat-h-btn chat-timers-submit">Add timer</button></form></div>`
  const labelEl = container.querySelector<HTMLInputElement>('.chat-timers-label')!
  const messageEl = container.querySelector<HTMLTextAreaElement>('.chat-timers-message')!
  const kindEl = container.querySelector<HTMLSelectElement>('.chat-timers-kind')!
  const minutesEl = container.querySelector<HTMLInputElement>('.chat-timers-minutes')!
  labelEl.value = draft.label
  messageEl.value = draft.message
  kindEl.value = draft.kind === 'once' ? 'once' : 'every'
  minutesEl.value = draft.minutes
  updateSubmit()
  const showError = (error: unknown): void => {
    if (container.dataset.timersSession !== session.id) return
    let alert = container.querySelector<HTMLElement>('.chat-timers-error')
    if (!alert) {
      if (!error) return
      alert = document.createElement('div')
      alert.className = 'chat-timers-error'
      alert.setAttribute('role', 'alert')
      container.append(alert)
    }
    alert.hidden = !error
    alert.textContent = error ? (error as Error).message || String(error) : ''
  }
  container.querySelector('.chat-timers-hold')!.addEventListener('click', () => {
    void actions.hold(hold === null).then(() => showError(null)).catch(showError)
  })
  container.querySelector('.chat-timers-hold-all')!.addEventListener('click', () => {
    void actions.holdAll(!allHeld).then(() => showError(null)).catch(showError)
  })
  for (const row of container.querySelectorAll<HTMLElement>('.chat-timer')) {
    const id = row.dataset.timer!
    row.querySelector('.chat-timer-cancel')!.addEventListener('click', () => {
      void actions.cancel(id).then(() => showError(null)).catch(showError)
    })
    row.querySelector('.chat-timer-rearm')?.addEventListener('click', () => {
      void actions.rearm(id).then(() => showError(null)).catch(showError)
    })
  }
  container.querySelector('.chat-timers-add')!.addEventListener('submit', (event) => {
    event.preventDefault()
    if (pending.has(session.id)) return
    pending.add(session.id)
    updateSubmit()
    const submitted = { label: labelEl.value, message: messageEl.value, minutes: minutesEl.value, kind: kindEl.value }
    const minutes = Number(minutesEl.value)
    const input: TimerInput = { sessionId: session.id, label: labelEl.value, message: messageEl.value,
      ...(kindEl.value === 'once' ? { delayMinutes: minutes } : { everyMinutes: minutes }) }
    void actions.add(input).then(() => {
      if (container.dataset.timersSession !== session.id) return
      // add() refetches and replaces the form. Clear its current copy only
      // if the person has not started a different draft while it was pending.
      const label = container.querySelector<HTMLInputElement>('.chat-timers-label')
      const message = container.querySelector<HTMLTextAreaElement>('.chat-timers-message')
      const minutes = container.querySelector<HTMLInputElement>('.chat-timers-minutes')
      const kind = container.querySelector<HTMLSelectElement>('.chat-timers-kind')
      if (label?.value === submitted.label && message?.value === submitted.message
        && minutes?.value === submitted.minutes && kind?.value === submitted.kind) {
        label.value = ''; message.value = ''; minutes.value = ''
      }
      showError(null)
    }).catch(showError).finally(() => {
      pending.delete(session.id)
      updateSubmit()
    })
  })
}
