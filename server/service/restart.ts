// How Poise restarts onto another installed release. The production entry
// point registers its shutdown here; exiting with UPDATE_EXIT_CODE tells the
// workspace supervisor (deploy/runtime/supervisor.mjs) to start the release
// the switch named, while the agent processes Poise started keep running.

export const UPDATE_EXIT_CODE = 75

let restart: ((exitCode: number) => void) | null = null

export function onUpdateRestart(handler: ((exitCode: number) => void) | null): void {
  restart = handler
}

/** Whether this server runs under the supervisor and can restart onto another release. */
export function canRestartForUpdate(): boolean {
  return restart !== null && Boolean(process.env.POISE_RELEASE && process.env.POISE_BASE)
}

export function requestUpdateRestart(): boolean {
  if (!restart || !canRestartForUpdate()) return false
  restart(UPDATE_EXIT_CODE)
  return true
}
