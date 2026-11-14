import { normalize } from './contract.js'
import type { DiagnosticStore } from './store.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Host-owned verifier evidence, delivered through the existing private writer. */
export async function receiveDeployment(db: DiagnosticStore, stdin: AsyncIterable<Buffer | string>, write: (line: string) => void): Promise<void> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 64 * 1024) throw new Error('Deployment observation exceeds 64 KiB')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8'), end = text.indexOf('\n')
  if (end < 0) throw new Error('Missing deployment observation header')
  const observation: unknown = JSON.parse(text.slice(0, end))
  const health: unknown = JSON.parse(text.slice(end + 1))
  if (!object(observation) || typeof observation.rollout !== 'string' || !/^[a-f0-9]{40}\.[a-zA-Z0-9]{6}$/.test(observation.rollout)
    || typeof observation.workspace !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(observation.workspace)
    || typeof observation.observedAt !== 'string' || observation.observedAt.length > 50 || !Number.isFinite(Date.parse(observation.observedAt))
    || typeof observation.complete !== 'boolean'
    || !Number.isSafeInteger(observation.budgetSeconds) || Number(observation.budgetSeconds) < 0
    || !Number.isSafeInteger(observation.elapsedSeconds) || Number(observation.elapsedSeconds) < 0
    || (health !== null && !object(health))) throw new Error('Invalid deployment observation')
  const { rollout, workspace, observedAt, complete } = observation
  const budgetSeconds = Number(observation.budgetSeconds), elapsedSeconds = Number(observation.elapsedSeconds)
  const key = `deployment:${rollout}:${workspace}`, previous = db.checkpoint(key)
  const retained: unknown = previous === null ? null : JSON.parse(previous)
  if (retained !== null && (!object(retained) || !['observing', 'failed', 'recovered'].includes(String(retained.state))
    || typeof retained.observedAt !== 'string' || !Number.isFinite(Date.parse(retained.observedAt)))) throw new Error('Invalid retained deployment observation')
  let events = 0
  const validHealth = object(health) && health.ok === true
  const resumed = validHealth && health.draining === false
  const serving = validHealth && health.release === rollout.slice(0, 40) && health.version === rollout.slice(0, 40)
    && (health.switching == null || health.switching === '')
  const blocker = validHealth ? ['activeChatTurns', 'runningCallerCalls', 'backgroundWork', 'unsettledNativeCalls']
    .find((name) => typeof health[name] === 'number' && health[name] > 0) ?? null : null
  if ((!object(retained) || retained.state !== 'recovered')
    && (!object(retained) || Date.parse(observedAt) > Date.parse(String(retained.observedAt)))) {
    const recovered = complete || resumed
    const exhausted = budgetSeconds > 0 && elapsedSeconds >= budgetSeconds && validHealth && health.draining === true && !serving
    // A zero-second receipt read can observe recovery, but exhausts no pause budget.
    if (recovered || exhausted) {
      const wasFailed = object(retained) && retained.state === 'failed'
      const state = recovered ? wasFailed || complete ? 'recovered' : 'observing' : 'failed'
      const emit = recovered ? wasFailed : !wasFailed
      const event = emit ? normalize({ id: `${key}:${state}`, time: observedAt, source: 'gateway', component: 'deployment-verifier',
        level: recovered ? 'warning' : 'error', operation: 'workspace.deployment.pause', phase: recovered ? 'recovered' : 'deadline',
        workspace, visibility: 'infrastructure', target: rollout, correlationId: rollout, condition: key,
        release: rollout.slice(0, 40), timeoutMs: recovered ? null : budgetSeconds * 1000,
        message: recovered ? 'Deployment replacement pause recovered' : 'Deployment replacement pause exceeded the verifier deadline',
        context: { rollout, requestedRevision: rollout.slice(0, 40), servingRevision: validHealth ? health.release ?? null : null,
          budget: 'deployment-verifier', budgetSeconds, elapsedSeconds, admissionState: validHealth ? health.draining === true ? 'drained' : health.draining === false ? 'open' : 'unknown' : 'unknown',
          blocker, nextRetry: null, recovery: recovered ? complete ? 'rollout_complete' : 'admissions_restored' : null,
          health: validHealth ? Object.fromEntries(['version', 'release', 'draining', 'idle', 'activeChatTurns', 'runningCallerCalls', 'backgroundWork',
            'unsettledNativeCalls', 'nativeCleanupHold', 'desiredRelease', 'installedRelease', 'switching', 'pendingSince', 'switchWaitingOn']
            .map((name) => [name, health[name] ?? null])) : null },
      }) : null
      events = db.commitDelivery(event ? [event] : [], key, JSON.stringify({ state, observedAt }))
    }
  }
  write(JSON.stringify({ accepted: true, events }))
}
