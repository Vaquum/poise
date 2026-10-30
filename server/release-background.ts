// Cooperative handover barrier for process-owned background operations.
// Pausing stops admission, never cancels an operation already in progress.
let paused = false
let operations = 0
let switchPending = false

export function pauseReleaseBackground(): void { paused = true }
export function resumeReleaseBackground(): void { paused = false }
export function releaseBackgroundPaused(): boolean { return paused }
export function releaseBackgroundBusy(): number { return operations }

/** A release switch is waiting for its quiet moment: timer turns hold back
 *  so they never keep it waiting. Set by the service controller. */
export function markReleaseSwitch(pending: boolean): void { switchPending = pending }
export function releaseSwitchPending(): boolean { return switchPending }

export function trackReleaseBackground(): () => void {
  operations += 1
  let finished = false
  return () => {
    if (finished) return
    finished = true
    operations -= 1
  }
}
