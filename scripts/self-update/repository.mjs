// The repository this controller releases, owner/name, read from Poise's
// package.json — a field the release policy refuses to let a change touch.
// The trusted copy of the controller runs outside any checkout, so
// installControllerCopy (bootstrap.mjs) writes this module there with the
// value fixed.
import { readFileSync } from 'node:fs'

const { repository } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(String(repository?.url ?? ''))
if (!match) throw new Error(`package.json repository is not an HTTPS GitHub repository: ${repository?.url}`)

export const REPOSITORY = match[1]
