import manifest from '../package.json' with { type: 'json' }

/** owner/name of an HTTPS GitHub repository URL. */
export function repositoryName(url: string): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url)
  if (!match) throw new Error(`package.json repository is not an HTTPS GitHub repository: ${url}`)
  return match[1]
}

// Poise's own repository, the one self-update releases. package.json is the
// one place it is named, and the release policy refuses a change to it.
export const POISE_REPOSITORY = repositoryName(manifest.repository.url)
