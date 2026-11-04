import { agentInterfaceCwd } from './models'
import { runFile } from './process'
import { releaseBackgroundPaused, trackReleaseBackground } from './release-background'
import { readBehaviorResourceAdmission } from './behavior-resources'

export interface NativeCleanupSupport {
  status: 'checking' | 'supported' | 'unsupported' | 'unavailable'
  error: string | null
}

let controller: string | undefined
let current: NativeCleanupSupport = { status: 'checking', error: null }
let pending: Promise<NativeCleanupSupport> | null = null
let retryAt = 0
let guardSupported = false

function executionSupport(support: NativeCleanupSupport): NativeCleanupSupport {
  return support.status === 'supported' && readBehaviorResourceAdmission() && !guardSupported
    ? { status: 'unsupported', error: 'Configured execution limits require a workspace image with native resource-guard support.' } : support
}

export function invalidateNativeCleanup(error: string): void {
  current = { status: 'unavailable', error }
  retryAt = Date.now() + 30_000
}

/** Uses the existing request/tick and release barrier, without a timer. A
 * failed read is unknown; it cannot enable cutover or a native admission. */
export function nativeCleanupSupport(): NativeCleanupSupport {
  const identity = process.env.POISE_NATIVE_CONTROL ?? ''
  if (identity !== controller) {
    controller = identity
    pending = null
    retryAt = 0
    guardSupported = false
    current = identity ? { status: 'checking', error: null }
      : { status: 'unsupported', error: 'This setup cannot safely clean up v2 workers. v1 remains available.' }
  }
  if (!identity || current.status === 'supported' || current.status === 'unsupported'
      || pending || Date.now() < retryAt || releaseBackgroundPaused()) return executionSupport(current)
  current = { status: 'checking', error: null }
  const release = trackReleaseBackground('behavior')
  pending = Promise.resolve().then(async () => {
    let result: NativeCleanupSupport
    try {
      const { stdout } = await runFile('agent-interface', ['--native-capability'],
        { cwd: agentInterfaceCwd(), timeoutMs: 15_000, maxOutputBytes: 16 * 1024 })
      const value: unknown = JSON.parse(stdout)
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
          || !('supported' in value) || typeof value.supported !== 'boolean'
          || ('unavailable' in value && (value.supported || value.unavailable !== true))
          || (value.supported ? 'error' in value : !('error' in value) || typeof value.error !== 'string' || !value.error || value.error.length > 500)) {
        throw new Error('Native cleanup setup check returned invalid evidence')
      }
      result = value.supported ? { status: 'supported', error: null }
        : { status: 'unavailable' in value ? 'unavailable' : 'unsupported', error: String('error' in value ? value.error : '') }
      if (controller === identity) guardSupported = value.supported && 'resourceGuard' in value && value.resourceGuard === 1
    } catch (error) {
      result = { status: 'unavailable', error: error instanceof Error ? error.message : String(error) }
    } finally { release() }
    if (controller === identity) {
      current = result
      pending = null
      retryAt = result.status === 'unavailable' ? Date.now() + 30_000 : 0
    }
    return result
  })
  return current
}

export async function requireNativeCleanup(): Promise<void> {
  const identity = process.env.POISE_NATIVE_CONTROL ?? ''
  let support = nativeCleanupSupport()
  if (pending) support = await pending
  if (controller !== identity || (process.env.POISE_NATIVE_CONTROL ?? '') !== identity) {
    throw new Error('Workspace cleanup controller changed during its setup check')
  }
  support = executionSupport(support)
  if (support.status !== 'supported') throw new Error(support.error || 'Native cleanup setup has not been verified')
}
