// Settings → Admin (#556; SETTINGS.md, D1–D7): classic's Admin section for the
// gateway's admins, copied without its stylesheet (classic/admin-settings.ts).
import { fetchGatewayAccount } from '../../../gateway-client'
import { adminSection, type AdminSection } from './classic/admin-settings'
import { putAway } from './keep'
import type { SectionDef } from './types'

let section: AdminSection | null = null

export const ADMIN: SectionDef = {
  key: 'admin',
  name: 'Admin',
  what: 'People and their workspaces on this gateway, and who may sign in. Only admins see this section.',
  findText: 'admin people workspaces gateway sign in allow login disk disable enable restart',
  mount: async (body) => {
    if (!section) {
      const account = await fetchGatewayAccount().catch(() => null)
      if (!account?.isAdmin) { body.innerHTML = '<p class="t-gloss">Only the gateway’s admins see this section.</p>'; return }
      section = adminSection(account)
    }
    body.append(section.element)
    void section.refresh()
    return () => { if (section) putAway(section.element) }
  },
}
