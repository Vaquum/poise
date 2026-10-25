// The production server's signal posture. The workspace container runs worker
// agents, issue reviews and their tests as the same user as this server, so
// any of them can signal it. A SIGUSR1 would switch on the V8 inspector and
// hand this process to anyone in the container; refuse that, and name the
// reason whenever the server shuts down, so the next exit is identifiable.

import { close as closeInspector, url as inspectorUrl } from 'node:inspector'
import { onUpdateRestart } from './service/restart'

function refuseInspectorSignal(): void {
  console.error('[poise] ignored SIGUSR1: the production inspector is disabled')
}

/** Refuse inspector access to the production server: close a listener
 *  inherited from the environment and ignore SIGUSR1, which would otherwise
 *  switch the V8 inspector on at runtime. Idempotent. */
export function refuseInspectorActivation(): void {
  if (inspectorUrl() !== undefined) {
    closeInspector()
    console.error('[poise] closed the inherited inspector: production refuses debugger attachment')
  }
  if (!process.listeners('SIGUSR1').includes(refuseInspectorSignal)) {
    process.on('SIGUSR1', refuseInspectorSignal)
  }
}

/** Wire graceful shutdown to its triggers, naming the trigger in the log so
 *  a shutdown stays identifiable after the fact. */
export function registerProductionShutdownSignals(shutdown: (exitCode?: number) => void): void {
  onUpdateRestart((exitCode) => {
    console.log(`[poise] release switch requested; shutting down (exit ${exitCode})`)
    shutdown(exitCode)
  })
  process.once('SIGINT', () => {
    console.log('[poise] received SIGINT; shutting down')
    shutdown()
  })
  process.once('SIGTERM', () => {
    console.log('[poise] received SIGTERM; shutting down')
    shutdown()
  })
}
