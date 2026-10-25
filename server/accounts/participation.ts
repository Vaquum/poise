// The account evidence a server-started model check forwards to its refresh
// script (POISE_PROVIDER_EVIDENCE): the durable record plus the live sign-in
// the server already observed, so the script applies the eligibility rule
// without probing the CLIs again. scripts/provider-participation.mjs owns the
// rule; this module only assembles its inputs.

import { listAccounts } from './index'
import { accountLogins } from './logins'
import type { AccountId } from './types'

export interface ProviderEvidence {
  logins: Partial<Record<AccountId, string>>
  live: { claude: boolean | null, codex: boolean | null }
}

export async function providerEvidence(): Promise<ProviderEvidence> {
  const accounts = await listAccounts()
  const signedIn = (id: AccountId): boolean | null => {
    const found = accounts.find((account) => account.id === id)
    return found && typeof found.signedIn === 'boolean' ? found.signedIn : null
  }
  return { logins: accountLogins(), live: { claude: signedIn('claude'), codex: signedIn('codex') } }
}
