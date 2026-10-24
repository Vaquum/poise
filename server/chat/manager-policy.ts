// The Manager's effective policy: its controls with the wording the person
// chose between, and the policy version. Every Manager turn, and every
// worker turn of a worker the Manager created, carries it in its control
// context, above the charter it outranks.
import { getManagerSettings, type ManagerAutonomy, type ManagerSettings, type ManagerStability } from '../settings'

const STABILITY: Record<ManagerStability, string> = {
  'Stability': 'Keep this Poise on the version it has. Track releases; never ask to install.',
  'Lean to stability': 'Keep this Poise on the version it has. Track releases and ask to install them.',
  'Balanced': 'Tell me first, and install minor releases automatically.',
  'Lean to expansion': 'Install releases automatically, and tell me first.',
  'Full expansion': 'Install releases automatically.',
}

const AUTONOMY: Record<ManagerAutonomy, { decides: string, brings: string }> = {
  'Ask first': { decides: 'Nothing on my behalf.', brings: 'Everything: review and approve all of it.' },
  'Ask on judgement calls': { decides: 'The no-brainers; my charter defines them.', brings: 'Everything else.' },
  'Balanced': { decides: 'The routine work.', brings: 'Anything irreversible, and anything you\'re unsure about.' },
  'Ask on the irreversible': { decides: 'Everything but the irreversible.', brings: 'The irreversible.' },
  'Standing instructions': { decides: 'Everything my charter allows.', brings: 'Only what the charter says to bring.' },
}

export function managerPolicyBlock(settings: ManagerSettings = getManagerSettings()): string {
  const scope = settings.scope === null
    ? 'every followed repository'
    : settings.scope.length === 0 ? 'no repositories' : settings.scope.join(', ')
  const autonomy = AUTONOMY[settings.autonomy]
  return [
    `[Manager controls — policy version ${settings.version}.]`,
    `Rhythm: ${settings.rhythm} Manager slot${settings.rhythm === 1 ? '' : 's'}.`,
    `Stability: ${settings.stability} — "${STABILITY[settings.stability]}"`,
    `Autonomy: ${settings.autonomy} — decides "${autonomy.decides}" Brings "${autonomy.brings}"`,
    `Scope: ${scope}.`,
    settings.paused ? 'Paused: yes — new work waits until the person resumes.' : 'Paused: no.',
    'Precedence: a direct request from the person in this chat first, then these controls, then the charter, then Memories.',
  ].join('\n')
}
