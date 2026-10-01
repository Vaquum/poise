import { getOrganizations } from './config'

let selectedOrganization = ''
try { selectedOrganization = localStorage.getItem('poise-organization') || '' } catch { /* unavailable */ }

export function getSelectedOrganization(): string {
  if (!getOrganizations().some((org) => org.login === selectedOrganization && org.status === 'ready')) selectedOrganization = ''
  return selectedOrganization
}

export function organizationPayload(): { org?: string } {
  const org = getSelectedOrganization()
  return org ? { org } : {}
}

export function organizationUrl(path: string, org = getSelectedOrganization()): string {
  return org ? `${path}${path.includes('?') ? '&' : '?'}org=${encodeURIComponent(org)}` : path
}

export function setSelectedOrganization(org: string): void {
  selectedOrganization = org
  try { localStorage.setItem('poise-organization', org) } catch { /* unavailable */ }
  window.dispatchEvent(new CustomEvent('poise:organization-filter-changed'))
}

export function mountOrganizationFilter(container: HTMLElement): void {
  if (container.querySelector('.organization-filter')) return
  const select = document.createElement('select')
  select.className = 'organization-filter'
  select.setAttribute('aria-label', 'Organization filter')
  const refresh = () => {
    const organizations = getOrganizations().filter((org) => org.status === 'ready')
    const selected = getSelectedOrganization()
    select.replaceChildren(new Option('All organizations', ''), ...organizations.map((org) => new Option(org.login, org.login)))
    select.value = selected
    select.hidden = organizations.length < 2
  }
  refresh()
  select.addEventListener('change', () => setSelectedOrganization(select.value))
  window.addEventListener('poise:organization-filter-changed', refresh)
  window.addEventListener('poise:organizations-changed', refresh)
  window.addEventListener('poise:synced', refresh)
  container.prepend(select)
}

export function organizationErrors(data: { errors?: Array<{ org: string, error: string }> }): string {
  return Array.isArray(data.errors) && data.errors.length
    ? `Some organizations are unavailable: ${data.errors.map((entry) => `${entry.org}: ${entry.error}`).join('; ')}. Showing available results.`
    : ''
}
