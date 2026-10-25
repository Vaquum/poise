import { rm } from 'node:fs/promises'
import { join } from 'node:path'

// The legacy personal-install calendar job. The daily model check now runs
// inside the production server at 07:00 in the timezone saved in Settings,
// so the installer retires this job instead of installing it.
export const CATALOG_LABEL = 'com.vaquum.poise.model-catalog'

export function catalogPlistPath(launchAgents) {
  return join(launchAgents, `${CATALOG_LABEL}.plist`)
}

// launchctl answers exit 113 ("Could not find service") for a job that is
// not loaded. The runners surface that differently — the installer's as
// "(exit 113)", the updater's as "exited 113", execFile's as error.code —
// so match all three.
function jobNotLoaded(error) {
  if (error && typeof error === 'object' && error.code === 113) return true
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Could not find service') || /exit(?:ed)? 113\b/.test(message)
}

// Unload the legacy job and remove its plist, so the old calendar schedule
// and the server's own schedule cannot both fire. A first install has
// nothing to unload or remove. Resolves whether a loaded job was unloaded;
// a job that is still loaded afterwards fails the install instead of
// silently leaving two schedulers.
export async function retireCatalogJob({ launchAgents, domain, run, removeFile = rm }) {
  let unloaded = true
  try {
    await run('/bin/launchctl', ['bootout', `${domain}/${CATALOG_LABEL}`], { capture: true })
  } catch (bootoutError) {
    // A failed unload is only benign when the job is really gone: verify
    // with print rather than assume it was absent.
    let loaded = true
    try {
      await run('/bin/launchctl', ['print', `${domain}/${CATALOG_LABEL}`], { capture: true })
    } catch (printError) {
      if (!jobNotLoaded(printError)) throw printError
      loaded = false
    }
    if (loaded) {
      const detail = bootoutError instanceof Error ? bootoutError.message : String(bootoutError)
      throw new Error(`Could not unload the legacy ${CATALOG_LABEL} launchd job; refusing to leave two model-check schedulers: ${detail}`, { cause: bootoutError })
    }
    unloaded = false
  }
  await removeFile(catalogPlistPath(launchAgents), { force: true })
  return { unloaded }
}
