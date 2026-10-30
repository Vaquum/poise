import { getSettings, setLocalSettings, type AppSettings } from '../config'
import { escapeHtml } from '../markdown'

type Settings = NonNullable<AppSettings['behaviorChain']>
const defaults: Settings = { enabled: false, seedMode: 'label', label: 'poise' }

export function behaviorChainSettings() {
  const element = document.createElement('section')
  element.className = 'tp-section'
  element.setAttribute('aria-label', 'Behavior chain settings')
  element.innerHTML = '<div class="tp-group-label">Behavior chain</div><label class="tp-label"><input type="checkbox" data-chain-enabled> Run the issue-to-merge chain</label>'
    + '<label class="tp-label" for="chain-seed-mode">Seed issues</label><select id="chain-seed-mode" class="st-select"><option value="label">Issues with the selected label</option><option value="all">All issues in followed organizations</option></select>'
    + '<label class="tp-label" for="chain-seed-label">Issue label</label><input id="chain-seed-label" class="st-input" maxlength="50" spellcheck="false" autocomplete="off">'
    + '<p class="st-help">After every configured issue reviewer posts its comments, an implementation behavior starts. Reviews, repairs and native repository gates continue until confirmed merge. Each invocation finishes and releases its resources. The existing behavior switches and pauses apply.</p>'
    + '<button type="button" class="st-clear" data-chain-save>Save chain settings</button> <button type="button" class="st-clear" data-chain-reload>Reload saved settings</button> <button type="button" class="st-clear" data-chain-refresh>Refresh chains</button>'
    + '<p role="status" data-chain-status></p><ul data-chain-list></ul>'
  const enabled = element.querySelector<HTMLInputElement>('[data-chain-enabled]')!
  const mode = element.querySelector<HTMLSelectElement>('#chain-seed-mode')!
  const label = element.querySelector<HTMLInputElement>('#chain-seed-label')!
  const status = element.querySelector<HTMLElement>('[data-chain-status]')!
  const list = element.querySelector<HTMLElement>('[data-chain-list]')!
  const save = element.querySelector<HTMLButtonElement>('[data-chain-save]')!
  let current: Settings = { ...defaults }
  let dirty = false
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
      status.textContent = next.enabled ? 'Chain admissions enabled. Phase switches and holds still apply.' : 'New chain invocations paused. Existing receipts and ownership are retained.'
    } catch (error) { status.textContent = `Settings were not saved: ${(error as Error).message}` }
    finally { save.disabled = false }
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
  list.addEventListener('click', (event) => { void (async () => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-chain-id]')
    if (!button) return
    button.disabled = true
    try {
      const response = await fetch('/api/behavior-chains', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: button.dataset.chainId, sequence: Number(button.dataset.sequence), operation: button.dataset.operation }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      await refresh()
    } catch (error) { status.textContent = `Chain control was not applied: ${(error as Error).message}`; button.disabled = false }
  })() })
  async function refresh(): Promise<void> {
    try {
      const response = await fetch('/api/behavior-chains')
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.chains)) throw new Error(data.error || `HTTP ${response.status}`)
      list.innerHTML = data.chains.map((chain: { id: string, repository: string, issue: number, sequence: number, held: string | null, waiting: string | null,
        mergeSha: string | null, pullNumber: number | null, invocations: Array<{ behavior: string, state: string, outcome?: string | null }> }) => {
        const active = chain.invocations.find(invocation => invocation.state !== 'settled')
        const number = chain.pullNumber
        const github = /^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(chain.repository) && Number.isSafeInteger(chain.issue)
          ? `<a href="https://github.com/${escapeHtml(chain.repository)}/issues/${chain.issue}">#${chain.issue}</a>` : escapeHtml(chain.id)
        const state = chain.mergeSha ? `Merged: ${chain.mergeSha.slice(0, 12)}` : chain.held || (active
          ? `${active.behavior}: ${active.state}${active.state === 'uncertain' && active.outcome ? ` · ${active.outcome}` : ''}`
          : chain.waiting || 'Awaiting the next observation')
        const control = chain.mergeSha ? '' : ` <button type="button" class="st-clear" data-chain-id="${escapeHtml(chain.id)}" data-sequence="${Number(chain.sequence)}" data-operation="${chain.held ? 'resume' : 'hold'}">${chain.held ? 'Resume' : 'Hold new invocations'}</button>`
        return `<li>${github}${number ? ` → <a href="https://github.com/${escapeHtml(chain.repository)}/pull/${Number(number)}">PR #${Number(number)}</a>` : ''}: ${escapeHtml(state)}${control}</li>`
      }).join('') || '<li>No behavior chains.</li>'
      const errors = Array.isArray(data.runtime) ? data.runtime.filter((entry: { error: string | null }) => entry.error).map((entry: { organization: string, error: string }) => `${entry.organization}: ${entry.error}`).join('; ') : ''
      status.textContent = `Read ${new Date().toLocaleTimeString()}${data.next ? ' · more chains available through the paginated API' : ''}${errors ? ` · ${errors}` : ''}`
    } catch (error) { status.textContent = `Chains could not be refreshed: ${(error as Error).message}` }
  }
  update(getSettings())
  return { element, update, refresh }
}
