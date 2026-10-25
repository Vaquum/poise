import { rm } from 'node:fs/promises'
import { join } from 'node:path'

// The legacy personal-install calendar job. The daily model check now runs
// inside the production server at 07:00 in the timezone saved in Settings,
// so the installer retires this job instead of installing it.
export const CATALOG_LABEL = 'com.vaquum.poise.model-catalog'

export function catalogPlistPath(launchAgents) {
  return join(launchAgents, `${CATALOG_LABEL}.plist`)
}

// Unload the legacy job and remove its plist, so the old calendar schedule
// and the server's own schedule cannot both fire. A first install has
// nothing to unload or remove.
export async function retireCatalogJob({ launchAgents, domain, run, removeFile = rm }) {
  try {
    await run('/bin/launchctl', ['bootout', `${domain}/${CATALOG_LABEL}`], { capture: true })
  } catch {
    // A first install has nothing to unload.
  }
  await removeFile(catalogPlistPath(launchAgents), { force: true })
}
