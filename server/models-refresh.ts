import { diagnostic } from './logging'
import { releaseBackgroundPaused, trackReleaseBackground } from './release-background'
// The scheduled job and manual check share CLI updates, discovery and receipts.
import { dirname, join } from 'node:path'
import { HttpError } from './http'
import { agentInterfaceCwd, catalogReportPath, invalidateCatalog } from './models'
import { CLAUDE_SUBSCRIPTION_CLI, claudeSubscriptionEnvironment, runFile, scrubbedChildEnvironment } from './process'

let pending: Promise<Record<string, unknown>> | null = null
export function refreshModelCatalog(): Promise<Record<string, unknown>> {
  if (pending) return pending
  // A drain admits no new background work: CLI updates cut by the restart
  // that follows could leave a provider CLI half installed.
  if (releaseBackgroundPaused()) return Promise.reject(new HttpError(503, 'Poise is installing an update; the model check has not started.'))
  const finished = trackReleaseBackground()
  pending = (async () => {
    let stdout: string
    try { ({ stdout } = await runFile(process.execPath, [join(dirname(CLAUDE_SUBSCRIPTION_CLI), 'refresh-models.mjs'), '--json'], {
      cwd: agentInterfaceCwd(),
      env: { ...scrubbedChildEnvironment('agent-interface', claudeSubscriptionEnvironment()), POISE_MODEL_CATALOG_REPORT: catalogReportPath() },
      timeoutMs: 15 * 60_000, killSignal: 'SIGTERM',
    })) } catch (error) {
      // The script emits a durable structured failure even on a nonzero exit.
      // Return that diagnostic, not just the Node process's exit code.
      const output = (error as { stdout?: unknown }).stdout
      if (typeof output !== 'string' || !output.trim()) throw error
      stdout = output
    }
    let report: unknown
    try { report = JSON.parse(stdout) } catch { throw new Error('The model check returned an unreadable report') }
    if (!report || typeof report !== 'object' || !('families' in report) || !report.families || typeof report.families !== 'object' || Array.isArray(report.families)) throw new Error('The model check returned an invalid report')
    if ('error' in report && typeof report.error === 'string') {
      const evidence = 'diagnostic' in report && report.diagnostic && typeof report.diagnostic === 'object' ? report.diagnostic as Record<string, unknown> : {}
      diagnostic({ level: 'error', operation: 'models.discovery', phase: 'catalog_refresh', message: report.error,
        stderr: typeof evidence.stderr === 'string' ? evidence.stderr : null, truncated: evidence.truncated === true,
        exitCode: typeof evidence.exitCode === 'number' ? evidence.exitCode : null, signal: typeof evidence.signal === 'string' ? evidence.signal : null,
        errno: typeof evidence.errno === 'number' || typeof evidence.errno === 'string' ? evidence.errno : null,
        timeoutMs: typeof evidence.timeoutMs === 'number' ? evidence.timeoutMs : null, context: { configuredExecutable: evidence.configuredExecutable ?? null, cwd: evidence.cwd ?? null, elapsedMs: evidence.elapsedMs ?? null } })
    }
    const updates = 'cli_updates' in report && report.cli_updates && typeof report.cli_updates === 'object' ? report.cli_updates as Record<string, Record<string, unknown>> : {}
    for (const [family, update] of Object.entries(updates)) {
      if (update.status !== 'unavailable') continue
      const evidence = update.diagnostic && typeof update.diagnostic === 'object' ? update.diagnostic as Record<string, unknown> : {}
      diagnostic({ level: 'warning', operation: 'provider.cli_update', component: family, phase: 'updater',
        message: typeof update.error === 'string' ? update.error : 'Provider CLI update is unavailable',
        stderr: typeof evidence.stderr === 'string' ? evidence.stderr : null, truncated: evidence.truncated === true,
        exitCode: typeof evidence.exitCode === 'number' ? evidence.exitCode : null, signal: typeof evidence.signal === 'string' ? evidence.signal : null,
        errno: typeof evidence.errno === 'number' || typeof evidence.errno === 'string' ? evidence.errno : null,
        timeoutMs: typeof evidence.timeoutMs === 'number' ? evidence.timeoutMs : null,
        context: { configuredExecutable: evidence.configuredExecutable ?? update.configuredExecutable ?? null, resolvedExecutable: update.resolvedPath ?? null,
          launchExecutable: update.launchPath ?? null, cwd: evidence.cwd ?? null, elapsedMs: evidence.elapsedMs ?? null } })
    }
    for (const [family, value] of Object.entries(report.families)) {
      if (value && typeof value === 'object' && 'status' in value && value.status !== 'ok') diagnostic({
        level: 'warning', operation: 'models.discovery', component: family,
        message: 'error' in value && typeof value.error === 'string' ? value.error : 'Model discovery did not return a healthy result',
        context: { family, status: value.status, reportPath: catalogReportPath(), configuredExecutable: updates[family]?.configuredExecutable ?? process.env[family.toUpperCase() + '_CLI'] ?? null,
          resolvedExecutable: updates[family]?.resolvedPath ?? null, launchExecutable: updates[family]?.launchPath ?? null, phase: 'catalog_discovery' },
      })
    }
    return report as Record<string, unknown>
  })().finally(() => { invalidateCatalog(); pending = null; finished() })
  return pending
}
