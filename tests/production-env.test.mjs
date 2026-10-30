import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requireProductionDotenv } from '../scripts/production-env.mjs'

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'poise-production-env-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('the production installer .env gate', () => {
  it('points a missing .env at the template and chmod 600, not a raw ENOENT', async () => {
    const failure = await requireProductionDotenv(join(root, '.env')).catch((error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('.env')
    expect(failure.message).toContain('.env.example')
    expect(failure.message).toContain('chmod 600')
    expect(failure.message).not.toContain('ENOENT')
  })

  it('keeps the chmod-only message for a group-readable .env', async () => {
    const dotenvPath = join(root, '.env')
    await writeFile(dotenvPath, 'REVIEW_AGENT_USERNAME=someone\n')
    await chmod(dotenvPath, 0o640)
    await expect(requireProductionDotenv(dotenvPath))
      .rejects.toThrow('.env must exist and be owner-readable only (chmod 600 .env)')
  })

  it('accepts an owner-readable-only .env', async () => {
    const dotenvPath = join(root, '.env')
    await writeFile(dotenvPath, 'REVIEW_AGENT_USERNAME=someone\n')
    await chmod(dotenvPath, 0o600)
    await expect(requireProductionDotenv(dotenvPath)).resolves.toBeUndefined()
  })

  it('keeps the chmod-only message when .env is not a file', async () => {
    const dotenvPath = join(root, '.env')
    await mkdir(dotenvPath)
    await expect(requireProductionDotenv(dotenvPath))
      .rejects.toThrow('.env must exist and be owner-readable only (chmod 600 .env)')
  })
})
