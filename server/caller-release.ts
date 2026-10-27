// The Caller this Poise runs: the packages under caller/, run from the CLIs
// in callerBinRoot(). /api/health reports it and production refuses to start
// without it. The check reads local files only.
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { CALLER_COMMANDS, agentInterfaceRoot, callerBinRoot, callerVersions } from '../scripts/caller.mjs'

export interface CallerReleaseHealth {
  status: 'ready' | 'invalid'
  // Each package's version from caller/<package>/pyproject.toml.
  packages: Record<string, string>
  error: string | null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// An executable whose interpreter line names an executable interpreter.
async function runnable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    const firstLine = (await readFile(path, 'utf8')).split('\n', 1)[0]
    if (!firstLine.startsWith('#!')) return false
    await access(firstLine.slice(2).trim().split(/\s+/, 1)[0], constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function getCallerReleaseHealth(): Promise<CallerReleaseHealth> {
  let packages: Record<string, string>
  try {
    packages = await callerVersions()
  } catch (error) {
    return { status: 'invalid', packages: {}, error: `Caller is missing from this checkout: ${message(error)}` }
  }
  const invalid = (error: string): CallerReleaseHealth => ({ status: 'invalid', packages, error })
  let binRoot: string
  let agentRoot: string
  try {
    binRoot = callerBinRoot()
    agentRoot = agentInterfaceRoot()
  } catch (error) {
    return invalid(message(error))
  }
  if (!await isDirectory(agentRoot)) return invalid(`agent-interface root ${agentRoot} is not a directory`)
  for (const command of CALLER_COMMANDS) {
    const path = join(binRoot, command)
    if (!await runnable(path)) {
      return invalid(`${path} is missing or not runnable${process.env.CALLER_BIN_ROOT ? ' (CALLER_BIN_ROOT)' : '; run npm run caller:setup'}`)
    }
  }
  return { status: 'ready', packages, error: null }
}

export async function assertCallerRelease(): Promise<void> {
  const health = await getCallerReleaseHealth()
  if (health.status !== 'ready') throw new Error(`Caller is not ready: ${health.error}`)
}
