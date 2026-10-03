import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { POISE_REPOSITORY, repositoryName } from '../src/poise-repository'
import { REPOSITORY, REPOSITORY_URL } from '../scripts/self-update/paths.mjs'

// Poise's own repository is named once, in package.json; self-update, the
// release controller and the chat heuristics all read it from there.
describe("Poise's repository", () => {
  it('is the repository package.json names, everywhere it is used', async () => {
    const { repository } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(repository.url).toBe('https://github.com/autonomio/poise.git')
    expect(POISE_REPOSITORY).toBe('autonomio/poise')
    expect(REPOSITORY).toBe(POISE_REPOSITORY)
    expect(REPOSITORY_URL).toBe(repository.url)
  })

  it('accepts only an HTTPS GitHub repository URL', () => {
    expect(repositoryName('https://github.com/owner/name')).toBe('owner/name')
    expect(repositoryName('https://github.com/owner/name.git')).toBe('owner/name')
    for (const url of ['git@github.com:owner/name.git', 'https://gitlab.com/owner/name.git', 'https://github.com/owner', '']) {
      expect(() => repositoryName(url), url).toThrow('not an HTTPS GitHub repository')
    }
  })
})
