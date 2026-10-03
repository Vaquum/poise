// What a personal computer offers and a workspace container cannot: each is
// refused with a message the browser shows where it would offer the feature.

export const SELF_UPDATE_OFF = 'Improve Poise from Poise is turned off in service mode: this workspace runs the Poise image its server deploys, and /poise cannot change that image.'
export const CLAUDE_BROWSER_LOGIN_OFF = 'Claude sign-in through a local browser is not available in service mode. Connect Claude in Settings → Connected accounts.'
export const PRODUCTION_UPDATER_OFF = 'No production updater runs in service mode: the server upgrades this workspace with its image, so there is no update record here and no desktop notification.'

/** Error code of a request refused because its feature is off in service mode. */
export const SERVICE_MODE_CODE = 'service_mode'

/** /api/health's `production` in service mode, in the shape Settings reads. */
export function productionUpdaterOff() {
  return {
    status: 'off' as const,
    reason: PRODUCTION_UPDATER_OFF,
    checkedAt: null,
    deployedCommit: null,
    remoteCommit: null,
    behind: null,
    failingSince: null,
    error: null,
  }
}
