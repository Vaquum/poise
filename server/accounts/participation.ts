// The account evidence a server-started model check forwards to its refresh
// script (POISE_PROVIDER_EVIDENCE): the durable record plus the live sign-in
// the server already observed, so the script applies the eligibility rule
// without probing the CLIs again. scripts/provider-participation.mjs owns the
// rule; this module only assembles its inputs.

import { listAccounts } from './index'
import { accountLoginsStrict } from './logins'
import type { AccountId } from './types'

export interface ProviderEvidence {
  logins: Partial<Record<AccountId, string>>
  live: { claude: boolean | 'missing' | null, codex: boolean | 'missing' | null }
}

// The providers a model check maintains: the same five the refresh script
// resolves (scripts/provider-participation.mjs). GitHub takes no part.
const CHECK_PROVIDERS: AccountId[] = ['claude', 'codex', 'grok', 'antigravity', 'muse']

/** The participation context a check ran under: who is eligible, plus the
 *  live states. Recorded-or-verified reads the same either way, so a memo
 *  written mid-flight does not split sharing; timestamps and GitHub don't
 *  take part in checks and don't take part in the signature. */
export function evidenceSignature(evidence: ProviderEvidence): string {
  const eligible = [...new Set([
    ...CHECK_PROVIDERS.filter((id) => evidence.logins[id]),
    ...(['claude', 'codex'] as const).filter((id) => evidence.live[id] === true),
  ])].sort()
  return JSON.stringify({ eligible, live: evidence.live })
}

/** Throws on a corrupt record, so the check fails instead of skipping
 *  configured providers. A CLI that is not installed reports 'missing',
 *  which skips: only a failed read is unknown. */
export async function providerEvidence(): Promise<ProviderEvidence> {
  const accounts = await listAccounts()
  const observed = (id: AccountId): boolean | 'missing' | null => {
    const found = accounts.find((account) => account.id === id)
    if (!found) return null
    if (!found.installed) return 'missing'
    return typeof found.signedIn === 'boolean' ? found.signedIn : null
  }
  return { logins: accountLoginsStrict(), live: { claude: observed('claude'), codex: observed('codex') } }
}
