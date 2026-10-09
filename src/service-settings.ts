// Service mode adds the gateway's parts to Settings: Poise Link under Accounts
// (pairing and the paired computers) and, for the gateway's admins, an Admin
// tab. The gateway sends /link, /link/devices and its own admin link here as
// /?settings=link and /?settings=admin, which open Settings at that place.

import { openSettingsPanel } from './settings'
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

function selectTab(panel: HTMLElement, tab: string): void {
  panel.querySelector<HTMLButtonElement>(`.st-tabs [data-tab="${tab}"]`)?.click()
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

  const tabs = panel.querySelector<HTMLElement>('.st-tabs')
  tabs?.addEventListener('click', (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]')?.dataset.tab
    if (tab === 'accounts') void link?.refresh()
    else if (tab === 'admin') void admin?.refresh()
  })
  if (!gateway.isAdmin || !tabs) return
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('role', 'tab')
  button.setAttribute('aria-selected', 'false')
  button.dataset.tab = 'admin'
  button.textContent = 'Admin'
  tabs.append(button)
  tabs.classList.add('st-tabs-four')
  const section = document.createElement('section')
  section.className = 'st-tab'
  section.dataset.tab = 'admin'
  section.hidden = true
  admin = adminSection(gateway)
  section.append(admin.element)
  panel.querySelector('.tp-body > .st-row')?.before(section)
}

/** Opens Settings at Poise Link or, for an admin, at Admin. */
export async function openServicePlace(place: ServicePlace): Promise<void> {
  const panel = document.getElementById('settings-panel')
  const gateway = await gatewayAccount()
  if (!panel || !gateway) return
  addSections(panel, gateway)
  openSettingsPanel()
  if (place === 'admin' && gateway.isAdmin) {
    selectTab(panel, 'admin')
    return
  }
  selectTab(panel, 'accounts')
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

/** Adds the gateway's sections once service mode is confirmed. */
export async function initServiceSettings(): Promise<void> {
  const panel = document.getElementById('settings-panel')
  let gateway: GatewayAccount | null
  try {
    gateway = await gatewayAccount()
  } catch (error) {
    console.error('[settings] the gateway did not say who is signed in:', error)
    return
  }
  if (panel && gateway) addSections(panel, gateway)
}
