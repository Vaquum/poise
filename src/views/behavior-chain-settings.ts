import { getSettings, setLocalSettings, type AppSettings } from '../config'
import { escapeHtml } from '../markdown'
import type { BehaviorCutoverState } from '../behavior-cutover'

type Settings = NonNullable<AppSettings['behaviorChain']>
interface ChainRow {
  id: string, repository: string, issue: number, sequence: number, held: string | null, waiting: string | null,
  mergeSha: string | null, pullNumber: number | null,
  invocations: Array<{ behavior: string, state: string, outcome?: string | null }>
}
interface JournalEvent { sequence: number, at: number, type: string, reason?: string, outcome?: string }
const defaults: Settings = { enabled: false, seedMode: 'label', label: 'poise' }

export function behaviorChainSettings() {
  const element = document.createElement('section')
  element.className = 'tp-section'
  element.setAttribute('aria-label', 'Behavior chain settings')
  element.innerHTML = `<div class="tp-group-label">Behavior chain</div>
    <p role="status" data-cutover-status>Reading behavior admission state…</p>
    <button type="button" class="st-clear" data-cutover disabled>Switch to v2</button>
    <p class="st-help">Switching drains current behavior invocations, then assigns new work to v2. Existing legacy PRs keep their ownership. Chats remain available.</p>
    <label class="tp-label"><input type="checkbox" data-chain-enabled disabled> Run the issue-to-merge chain</label>
    <label class="tp-label" for="chain-seed-mode">Seed issues</label><select id="chain-seed-mode" class="st-select"><option value="label">Issues with the selected label</option><option value="all">All issues in followed organizations</option></select>
    <label class="tp-label" for="chain-seed-label">Issue label</label><input id="chain-seed-label" class="st-input" maxlength="50" spellcheck="false" autocomplete="off">
    <p class="st-help">This intake controls v2. Repository/author triggers and the approval-round cap in the Behaviors table apply to legacy work. Existing reviewer counts, phase switches, pauses, notes and PR exclusions still apply to v2.</p>
    <button type="button" class="st-clear" data-chain-save disabled>Save chain settings</button> <button type="button" class="st-clear" data-chain-reload>Reload saved settings</button> <button type="button" class="st-clear" data-chain-refresh>Refresh chains</button>
    <p class="st-help">Hold pauses future invocations; it does not stop a running worker. Use its existing Stop control to stop it.</p>
    <p role="status" data-chain-status></p><details data-legacy hidden><summary>Legacy PR ownership retained at cutover</summary><ul></ul></details><ul data-chain-list></ul>
    <button type="button" class="st-clear" data-chain-more hidden>More chains</button>
    <section aria-label="Chain journal" hidden><p data-history-title></p><ol data-history></ol><button type="button" class="st-clear" data-history-more hidden>More events</button></section>`
  const enabled = element.querySelector<HTMLInputElement>('[data-chain-enabled]')!
  const mode = element.querySelector<HTMLSelectElement>('#chain-seed-mode')!
  const label = element.querySelector<HTMLInputElement>('#chain-seed-label')!
  const status = element.querySelector<HTMLElement>('[data-chain-status]')!
  const list = element.querySelector<HTMLElement>('[data-chain-list]')!
  const save = element.querySelector<HTMLButtonElement>('[data-chain-save]')!
  const cutoverButton = element.querySelector<HTMLButtonElement>('[data-cutover]')!
  const more = element.querySelector<HTMLButtonElement>('[data-chain-more]')!
  const history = element.querySelector<HTMLElement>('[aria-label="Chain journal"]')!
  const historyMore = element.querySelector<HTMLButtonElement>('[data-history-more]')!
  let current: Settings = { ...defaults }
  let cutover: BehaviorCutoverState | null = null
  let dirty = false
  let reading = false
  let next: string | null = null
  let rows: ChainRow[] = []
  let historyId = ''
  let historyNext: number | null = null
  let historyGeneration = 0

  function update(settings: AppSettings): void {
    if (dirty) return
    current = { ...defaults, ...settings.behaviorChain }
    enabled.checked = current.enabled; mode.value = current.seedMode; label.value = current.label
    label.disabled = mode.value === 'all'
  }
  element.addEventListener('input', () => { dirty = true; label.disabled = mode.value === 'all' })
  element.addEventListener('change', () => { dirty = true; label.disabled = mode.value === 'all' })
  save.addEventListener('click', () => { void (async () => {
    save.disabled = true
    try {
      const next: Settings = { enabled: enabled.checked, seedMode: mode.value === 'all' ? 'all' : 'label', label: label.value.trim() }
      const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ behaviorChain: next, expect: { behaviorChain: current } }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      setLocalSettings(data); dirty = false; update(data)
      status.textContent = next.enabled ? 'Chain invocations enabled. Phase switches and holds still apply.' : 'New chain invocations paused. Ownership and receipts are retained.'
    } catch (error) { status.textContent = `Settings were not saved: ${(error as Error).message}` }
    finally { save.disabled = cutover === null }
  })() })
  cutoverButton.addEventListener('click', () => { void (async () => {
    if (!cutover) return
    if (dirty) { status.textContent = 'Save intake changes before switching.'; return }
    cutoverButton.disabled = true
    try {
      const response = await fetch('/api/behavior-chains', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sequence: cutover.sequence, operation: cutover.mode === 'draining' ? 'cancel-cutover' : 'switch-to-v2' }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      await refresh()
    } catch (error) { status.textContent = `Cutover was not applied: ${(error as Error).message}`; cutoverButton.disabled = false }
  })() })
  element.querySelector('[data-chain-refresh]')!.addEventListener('click', () => { void refresh() })
  more.addEventListener('click', () => { void refresh(true) })
  element.querySelector('[data-chain-reload]')!.addEventListener('click', () => { void (async () => {
    try {
      const response = await fetch('/api/settings')
      const settings = await response.json()
      if (!response.ok) throw new Error(settings.error || `HTTP ${response.status}`)
      dirty = false; setLocalSettings(settings); update(settings); status.textContent = 'Saved settings reloaded.'
    } catch (error) { status.textContent = `Settings could not be reloaded: ${(error as Error).message}` }
  })() })
  list.addEventListener('click', (event) => { void (async () => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-chain-id]')
    if (!button) return
    if (button.dataset.operation === 'history') { await readHistory(button.dataset.chainId!); return }
    button.disabled = true
    try {
      const response = await fetch('/api/behavior-chains', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: button.dataset.chainId, sequence: Number(button.dataset.sequence), operation: button.dataset.operation }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      await refresh()
    } catch (error) { status.textContent = `Chain control was not applied: ${(error as Error).message}`; button.disabled = false }
  })() })
  historyMore.addEventListener('click', () => { void readHistory(historyId, true) })
  async function readHistory(id: string, append = false): Promise<void> {
    const generation = ++historyGeneration
    const after = append ? historyNext : 0
    historyMore.disabled = true
    try {
      const response = await fetch(`/api/behavior-chains?${new URLSearchParams({ id, after: String(after ?? 0) })}`)
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.events)) throw new Error(data.error || `HTTP ${response.status}`)
      if (generation !== historyGeneration) return
      if (data.next !== null && (!Number.isSafeInteger(data.next) || data.next <= (after ?? 0))) throw new Error('Journal cursor did not advance')
      historyId = id; historyNext = data.next; history.hidden = false
      history.querySelector('[data-history-title]')!.textContent = `v2 journal · ${id}`
      const html = data.events.map((event: JournalEvent) => `<li>${escapeHtml(new Date(event.at).toLocaleString())} · ${escapeHtml(event.type)}${event.reason || event.outcome ? ` · ${escapeHtml(event.reason || event.outcome || '')}` : ''}</li>`).join('')
      const events = history.querySelector('[data-history]')!
      if (append) events.insertAdjacentHTML('beforeend', html); else events.innerHTML = html || '<li>No journal events.</li>'
      historyMore.hidden = historyNext === null
    } catch (error) { if (generation === historyGeneration) status.textContent = `Journal could not be read: ${(error as Error).message}` }
    finally { if (generation === historyGeneration) historyMore.disabled = false }
  }
  async function refresh(append = false): Promise<void> {
    if (reading) return
    reading = true; more.disabled = true
    const after = append ? next : null
    try {
      const response = await fetch(`/api/behavior-chains${after ? `?after=${encodeURIComponent(after)}` : ''}`)
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.chains)) throw new Error(data.error || `HTTP ${response.status}`)
      if (data.next !== null && (typeof data.next !== 'string' || data.next <= (after ?? ''))) throw new Error('Chain cursor did not advance')
      next = data.next; rows = append ? [...rows, ...data.chains] : data.chains
      more.hidden = !next
      if (data.settings) update({ ...getSettings(), behaviorChain: data.settings })
      cutover = data.cutover ?? null
      save.disabled = cutover === null
      cutoverButton.disabled = !cutover || cutover.mode === 'v2'
      cutoverButton.textContent = cutover?.mode === 'draining' ? 'Cancel cutover' : cutover?.mode === 'v2' ? 'v2 active' : 'Switch to v2'
      enabled.disabled = cutover?.mode !== 'v2'
      const legacy = element.querySelector<HTMLDetailsElement>('[data-legacy]')!
      legacy.hidden = !cutover?.legacyPulls.length
      legacy.querySelector('ul')!.innerHTML = (cutover?.legacyPulls ?? []).map((target) => {
        const match = /^([-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+)#([1-9][0-9]*)$/.exec(target)
        return `<li>v1 · ${match ? `<a href="https://github.com/${escapeHtml(match[1])}/pull/${match[2]}">${escapeHtml(target)}</a>` : escapeHtml(target)}</li>`
      }).join('')
      element.querySelector('[data-cutover-status]')!.textContent = !cutover ? 'Admission state unavailable' : cutover.mode === 'v2'
        ? `v2 owns new work · legacy PRs at cutover: ${cutover.legacyPulls.length}`
        : cutover.mode === 'draining' ? `Draining behaviors · ${(data.cutover.blockers as string[]).join('; ') || 'Verifying the legacy ownership boundary'}` : 'v1 owns new work'
      list.innerHTML = rows.map((chain) => {
        const active = chain.invocations.find(invocation => invocation.state !== 'settled')
        const last = chain.invocations[chain.invocations.length - 1]
        const github = /^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(chain.repository) && Number.isSafeInteger(chain.issue)
          ? `<a href="https://github.com/${escapeHtml(chain.repository)}/issues/${chain.issue}">#${chain.issue}</a>` : escapeHtml(chain.id)
        const state = chain.mergeSha ? `Merged: ${chain.mergeSha.slice(0, 12)}` : chain.held || (active
          ? `${active.behavior}: ${active.state}${active.outcome ? ` · ${active.outcome}` : ''}` : chain.waiting || 'Awaiting the next observation')
        const control = chain.mergeSha ? '' : ` <button type="button" class="st-clear" data-chain-id="${escapeHtml(chain.id)}" data-sequence="${Number(chain.sequence)}" data-operation="${chain.held ? 'resume' : 'hold'}">${chain.held ? 'Resume' : 'Hold new invocations'}</button>`
        return `<li>v2 · ${github}${chain.pullNumber ? ` → <a href="https://github.com/${escapeHtml(chain.repository)}/pull/${Number(chain.pullNumber)}">PR #${Number(chain.pullNumber)}</a>` : ''}: ${escapeHtml(state)}${!active && last ? ` · Last: ${escapeHtml(last.behavior)} (${escapeHtml(last.outcome || last.state)})` : ''}${control} <button type="button" class="st-clear" data-chain-id="${escapeHtml(chain.id)}" data-operation="history">History</button></li>`
      }).join('') || '<li>No behavior chains.</li>'
      const errors = Array.isArray(data.runtime) ? data.runtime.filter((entry: { error: string | null }) => entry.error).map((entry: { organization: string, error: string }) => `${entry.organization}: ${entry.error}`).join('; ') : ''
      status.textContent = `Read ${new Date().toLocaleTimeString()}${errors ? ` · ${errors}` : ''}`
    } catch (error) {
      cutover = null; cutoverButton.disabled = true; enabled.disabled = true
      save.disabled = true
      element.querySelector('[data-cutover-status]')!.textContent = 'Admission state unavailable'
      status.textContent = `Chains could not be refreshed: ${(error as Error).message}`
    } finally { reading = false; more.disabled = false }
  }
  update(getSettings())
  return { element, update, refresh }
}
