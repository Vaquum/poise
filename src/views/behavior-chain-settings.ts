import { getSettings, setLocalSettings, type AppSettings } from '../config'
import { viewFeedback } from '../view-feedback'
import type { BehaviorCutoverState } from '../behavior-cutover'

type Settings = NonNullable<AppSettings['behaviorChain']>
const defaults: Settings = { enabled: false, seedMode: 'label', label: 'poise' }

export function behaviorChainSettings() {
  const element = document.createElement('section')
  element.className = 'tp-section'
  element.setAttribute('aria-label', 'Behavior chain settings')
  element.innerHTML = `<div class="tp-group-label">Behavior chain</div>
    <button type="button" class="st-clear" data-cutover disabled>Switch to v2</button>
    <p class="st-help" data-native-support hidden></p>
    <p class="st-help">Switching drains current behavior invocations, then assigns new work to v2. Existing legacy PRs keep their ownership. Chats remain available.</p>
    <label class="tp-label"><input type="checkbox" data-chain-enabled disabled> Run the issue-to-merge chain</label>
    <label class="tp-label" for="chain-seed-mode">Seed issues</label><select id="chain-seed-mode" class="st-select"><option value="label">Issues with the selected label</option><option value="all">All issues in followed organizations</option></select>
    <label class="tp-label" for="chain-seed-label">Issue label</label><input id="chain-seed-label" class="st-input" maxlength="50" spellcheck="false" autocomplete="off">
    <p class="st-help">This intake controls v2. Repository/author triggers and the approval-round cap in the Behaviors table apply to legacy work. Existing reviewer counts, phase switches, pauses, notes and PR exclusions still apply to v2.</p>
    <button type="button" class="st-clear" data-chain-save disabled>Save chain settings</button> <button type="button" class="st-clear" data-chain-reload>Reload saved settings</button> <button type="button" class="st-clear" data-chain-refresh>Refresh availability</button>
    <p role="status" data-chain-status></p>`
  const enabled = element.querySelector<HTMLInputElement>('[data-chain-enabled]')!
  const mode = element.querySelector<HTMLSelectElement>('#chain-seed-mode')!
  const label = element.querySelector<HTMLInputElement>('#chain-seed-label')!
  const status = element.querySelector<HTMLElement>('[data-chain-status]')!
  const save = element.querySelector<HTMLButtonElement>('[data-chain-save]')!
  const cutoverButton = element.querySelector<HTMLButtonElement>('[data-cutover]')!
  let current: Settings = { ...defaults }
  let cutover: BehaviorCutoverState | null = null
  let dirty = false
  let reading = false

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
      status.textContent = 'Chain settings saved.'
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
      viewFeedback('behavior-cutover', 'Behavior cutover needs attention', '')
      await refresh()
    } catch (error) { viewFeedback('behavior-cutover', 'Behavior cutover needs attention', `Cutover was not applied: ${(error as Error).message}`); cutoverButton.disabled = false }
  })() })
  element.querySelector('[data-chain-refresh]')!.addEventListener('click', () => { void refresh() })
  element.querySelector('[data-chain-reload]')!.addEventListener('click', () => { void (async () => {
    try {
      const response = await fetch('/api/settings')
      const settings = await response.json()
      if (!response.ok) throw new Error(settings.error || `HTTP ${response.status}`)
      dirty = false; setLocalSettings(settings); update(settings); status.textContent = 'Saved settings reloaded.'
    } catch (error) { status.textContent = `Settings could not be reloaded: ${(error as Error).message}` }
  })() })
  async function refresh(): Promise<void> {
    if (reading) return
    reading = true
    try {
      const response = await fetch('/api/behavior-chains')
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.chains)) throw new Error(data.error || `HTTP ${response.status}`)
      if (data.settings) update({ ...getSettings(), behaviorChain: data.settings })
      cutover = data.cutover ?? null
      save.disabled = cutover === null
      cutoverButton.hidden = cutover?.mode === 'v2'
      cutoverButton.disabled = !cutover || (cutover.mode !== 'draining' && cutover.support?.status !== 'supported')
      cutoverButton.textContent = cutover?.mode === 'draining' ? 'Cancel cutover' : 'Switch to v2'
      enabled.disabled = cutover?.mode !== 'v2' || cutover.support?.status !== 'supported'
      const support = cutover?.support
      const help = element.querySelector<HTMLElement>('[data-native-support]')!
      help.hidden = support?.status === 'supported'
      help.textContent = support?.status === 'unsupported' ? (cutover?.mode === 'v2'
        ? 'v2 is paused: this setup cannot verify worker cleanup.' : 'This setup cannot run v2. v1 remains available.')
        : 'The v2 setup check is unavailable. Switching is disabled.'
      viewFeedback('behavior-chain-settings', 'Behavior chain controls unavailable', '')
    } catch (error) {
      cutover = null; cutoverButton.hidden = false; cutoverButton.disabled = true; enabled.disabled = true; save.disabled = true
      viewFeedback('behavior-chain-settings', 'Behavior chain controls unavailable', (error as Error).message)
    } finally { reading = false }
  }
  update(getSettings())
  return { element, update, refresh }
}
