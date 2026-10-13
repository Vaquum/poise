// Service mode adds the gateway's parts to Settings: Poise Link under Accounts
// (pairing and the paired computers) and, for the gateway's admins, an Admin
// destination. The gateway sends /link, /link/devices and its own admin link here as
// /?settings=link and /?settings=admin, which open Settings at that place.

import { closeSettingsPanel, openSettingsAt } from './settings'
import { fetchGatewayAccount, type GatewayAccount } from './gateway-client'
import { workspaceMode } from './workspace-mode'
import { poiseLinkSection, type PoiseLinkSection } from './views/poise-link'
import { adminSection, type AdminSection } from './views/admin-settings'

export type ServicePlace = 'link' | 'admin'

let account: Promise<GatewayAccount | null> | null = null
let link: PoiseLinkSection | null = null
let admin: AdminSection | null = null

/** Who is signed in, as the gateway says; null on a personal computer. */
export function gatewayAccount(): Promise<GatewayAccount | null> {
  if (!account) {
    const attempt = (async () => (await workspaceMode()).service ? fetchGatewayAccount() : null)()
    account = attempt
    attempt.catch(() => { if (account === attempt) account = null })
  }
  return account
}

function addSections(panel: HTMLElement, gateway: GatewayAccount): void {
  const accountsTab = panel.querySelector<HTMLElement>('.st-tab[data-tab="accounts"]')
  if (!accountsTab || link) return
  // Between the agent CLIs' sign-ins and the login shell.
  const groupLabels = accountsTab.querySelectorAll<HTMLElement>(':scope > .tp-group-label')
  const terminalLabel = groupLabels[groupLabels.length - 1] ?? null
  const label = document.createElement('div')
  label.className = 'tp-group-label st-link-label'
  label.textContent = 'Poise Link'
  link = poiseLinkSection(gateway)
  accountsTab.insertBefore(label, terminalLabel)
  accountsTab.insertBefore(link.element, terminalLabel)

  window.addEventListener('poise:settings-section-changed', (event) => {
    const tab = (event as CustomEvent<{ section: string }>).detail.section
    if (tab === 'accounts') void link?.refresh()
    else if (tab === 'admin') void admin?.refresh()
  })
  if (!gateway.isAdmin) return
  const section = document.createElement('section')
  section.className = 'st-tab'
  section.dataset.tab = 'admin'
  section.hidden = true
  admin = adminSection(gateway)
  section.append(admin.element)
  panel.querySelector('.tp-body')?.append(section)
}

/** Opens Settings at Poise Link or, for an admin, at Admin. */
export async function openServicePlace(place: ServicePlace): Promise<void> {
  const panel = document.getElementById('settings-panel')
  const gateway = await gatewayAccount()
  if (!panel || !gateway) return
  addSections(panel, gateway)
  if (place === 'admin' && gateway.isAdmin) {
    openSettingsAt('admin')
    return
  }
  openSettingsAt('accounts')
  requestAnimationFrame(() => {
    link?.element.previousElementSibling?.scrollIntoView({ block: 'start' })
    link?.element.querySelector<HTMLInputElement>('.pl-code')?.focus({ preventScroll: true })
  })
}

/** The place /?settings= names, removed from the address so a reload does not open it again. */
export function takeServicePlace(): ServicePlace | null {
  const params = new URLSearchParams(location.search)
  const wanted = params.get('settings')
  if (wanted !== 'link' && wanted !== 'admin') return null
  params.delete('settings')
  const query = params.toString()
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
  return wanted
}

/** Settings → General → Setup: first-run setup again, from its first step. */
function addSetupAgain(panel: HTMLElement, runSetup: () => void): void {
  const general = panel.querySelector<HTMLElement>('.st-tab[data-tab="general"]')
  if (!general || general.querySelector('.st-run-setup')) return
  const label = document.createElement('div')
  label.className = 'tp-group-label'
  label.textContent = 'Setup'
  const section = document.createElement('div')
  section.className = 'tp-section'
  section.innerHTML = `
    <button type="button" class="st-clear st-run-setup" data-help="Walk through setup with your current choices prefilled.">Run setup again</button>`
  section.querySelector('button')!.addEventListener('click', () => {
    closeSettingsPanel()
    runSetup()
  })
  general.append(label, section)
}

/** Adds the gateway's sections once service mode is confirmed. */
export async function initServiceSettings(options: { runSetup: () => void }): Promise<void> {
  const panel = document.getElementById('settings-panel')
  let gateway: GatewayAccount | null
  try {
    gateway = await gatewayAccount()
  } catch (error) {
    console.error('[settings] the gateway did not say who is signed in:', error)
    return
  }
  if (!panel || !gateway) return
  addSections(panel, gateway)
  addSetupAgain(panel, options.runSetup)
}
