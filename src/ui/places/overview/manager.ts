// The Manager's card in Overview (#556; PRD #563): its controls read together,
// its Rhythm with − and +, and Pause new work, on the same settings as its
// controls and Settings → Manager. Each change sends only its own field, with
// the value this tab read, and shows what the service saved.
import type { SessionRecord } from '../../../../server/chat/protocol'
import { getSettings, setLocalSettings, settingsLoadOk, type AppSettings } from '../../../config'
import { placeHref } from '../../address'
import { $, esc } from '../../dom'
import { hydrateIcons } from '../../icons'
import { toast } from '../../shell'
import { chatState } from './states'
import { json, reason, ServiceError, type PartContext } from './util'

/** The Manager's controls as the service keeps them (server/settings.ts). */
export interface ManagerControls { rhythm: number, stability: string, autonomy: string, scope: string[] | null, paused: boolean, version: number }

// The three controls read together, one sentence per position: the words of
// the mocks' Manager controls, which follow server/chat/manager-policy.ts.
const STABILITY: Record<string, string> = {
  Stability: 'It keeps this Poise on its version and never asks to install a release.',
  'Lean to stability': 'It keeps this Poise on its version and asks you before installing a release.',
  Balanced: 'It tells you first, and installs minor releases by itself.',
  'Lean to expansion': 'It installs releases by itself, and tells you first.',
  'Full expansion': 'It installs releases by itself.',
}
const AUTONOMY: Record<string, string> = {
  'Ask first': 'It decides nothing on your behalf and brings you everything.',
  'Ask on judgement calls': 'It decides the no-brainers your charter defines and brings you everything else.',
  Balanced: 'It decides the routine work and brings you anything irreversible, and anything it is unsure about.',
  'Ask on the irreversible': 'It decides everything but the irreversible, which it brings to you.',
  'Standing instructions': 'It decides everything your charter allows and brings you only what the charter says to bring.',
}

export function managerSentence(m: ManagerControls): string {
  return [`Up to ${m.rhythm} worker${m.rhythm === 1 ? '' : 's'} at once.`, STABILITY[m.stability] ?? '', AUTONOMY[m.autonomy] ?? '', m.paused ? 'New work waits until you resume.' : ''].filter(Boolean).join(' ')
}

export function managerOf(settings: unknown): ManagerControls | null {
  const m = (settings as { manager?: Partial<ManagerControls> } | null)?.manager
  return m && Number.isSafeInteger(m.rhythm) && typeof m.paused === 'boolean' && typeof m.stability === 'string' && typeof m.autonomy === 'string'
    ? { rhythm: m.rhythm!, stability: m.stability, autonomy: m.autonomy, scope: m.scope ?? null, paused: m.paused, version: Number(m.version ?? 0) }
    : null
}

export function mountManager(ctx: PartContext, box: HTMLElement, sessions: () => SessionRecord[]): { sessionsChanged(): void } {
  let error = ''
  let saving: 'rhythm' | 'paused' | null = null
  let note = ''

  function paint(): void {
    const m = managerOf(getSettings())
    if (!m) {
      box.innerHTML = `<p class="onote${error ? ' is-warn' : ''}" role="status" data-ref="ov.read">${esc(error ? `The Manager’s controls could not be read: ${error}.` : 'Reading the Manager’s controls…')}</p>`
      return
    }
    const workers = sessions().filter((session) => session.role === 'worker' && session.status !== 'closed')
    const states = workers.map((session) => chatState(session).state)
    const running = states.filter((state) => state === 'running').length
    const paused = states.filter((state) => state === 'needs-you').length
    const blocked = states.filter((state) => state === 'blocked' || state === 'failed').length
    const used = workers.length
    const slot = (k: number) => k < Math.min(used, m.rhythm)
      ? (k < running ? 'run' : k < running + paused ? 'paused' : k < running + paused + blocked ? 'blocked' : 'held')
      : k < used ? 'over' : k < m.rhythm ? 'free' : 'off'
    const busy = saving ? ` aria-disabled="true" data-why="Saving the last change."` : ''
    box.innerHTML = `<div class="omgr" data-ref="mgr.effective"><p class="sentence">${esc(managerSentence(m))}</p>
      <div class="omgr-r"><div class="rhythm" data-rhythm data-limit="${m.rhythm}" data-used="${used}"><button class="ib" data-act="rh-less" aria-label="One slot fewer" data-ref="mgr.rhythm"${m.rhythm <= 1 ? ' aria-disabled="true" data-why="One slot is the least."' : busy}><i data-i="minus"></i></button><output class="rh-n" data-ref="mgr.rhythm">${m.rhythm}</output><button class="ib" data-act="rh-more" aria-label="One slot more" data-ref="mgr.rhythm"${m.rhythm >= 10 ? ' aria-disabled="true" data-why="Ten slots is the most."' : busy}><i data-i="plus"></i></button><div class="slots" aria-hidden="true">${Array.from({ length: 10 }, (_, k) => `<span class="slot ${slot(k)}"></span>`).join('')}</div></div>
      <button class="sbtn" data-act="mgr-paused" aria-pressed="${m.paused}" data-ref="mgr.paused"${busy}><span class="switch"></span>Pause new work</button>
      <a class="lnk" href="${esc(placeHref('manager', { pane: 'controls', back: 'overview' }))}">Open the Manager</a></div>
      ${note ? `<p class="onote is-warn" role="status">${esc(note)}</p>` : ''}</div>`
    hydrateIcons(box)
  }

  async function save(field: 'rhythm' | 'paused', value: number | boolean): Promise<void> {
    const read = managerOf(getSettings())
    if (!read || saving) return
    saving = field
    note = ''
    paint()
    try {
      const saved = await json<AppSettings>('/api/settings', { method: 'POST', body: JSON.stringify({ manager: { [field]: value }, expect: { manager: read } }) })
      setLocalSettings(saved)
      const m = managerOf(saved)
      if (m && field === 'rhythm') toast(`Rhythm ${m.rhythm}. The Manager reads it on its next turn.`, 'waiting')
      if (m && field === 'paused') toast(m.paused ? 'New work paused. The Manager still wakes and watches; workers finish their tasks.' : 'New work resumed from the Manager’s next turn.', m.paused ? 'waiting' : 'running')
    } catch (failure) {
      // Changed elsewhere since this tab read it: nothing was saved, and the card shows what is.
      const current = failure instanceof ServiceError && failure.status === 409 ? managerOf(failure.body?.current) : null
      if (current) {
        setLocalSettings({ ...getSettings(), manager: current } as AppSettings)
        note = `Not saved: the Manager’s controls changed elsewhere. Rhythm is ${current.rhythm}${current.paused ? ' and new work is paused' : ''}.`
      } else note = `Not saved: ${reason(failure)}`
    } finally {
      saving = null
      paint()
    }
  }

  box.addEventListener('click', (e) => {
    const button = (e.target as Element).closest<HTMLElement>('[data-act]')
    if (!button || button.matches('[aria-disabled="true"]')) return
    const m = managerOf(getSettings())
    if (!m) return
    if (button.dataset.act === 'rh-less' || button.dataset.act === 'rh-more') void save('rhythm', Math.min(10, Math.max(1, m.rhythm + (button.dataset.act === 'rh-more' ? 1 : -1))))
    if (button.dataset.act === 'mgr-paused') void save('paused', !m.paused)
  }, { signal: ctx.signal })

  // The place read Settings before it mounted; a failed read shows here, never guessed controls.
  error = !settingsLoadOk() ? 'Settings could not be read' : managerOf(getSettings()) ? '' : 'the service answered without them'
  paint()
  return { sessionsChanged: () => { if (!saving && !$('[data-act]:focus', box)) paint() } }
}
