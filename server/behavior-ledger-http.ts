import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBehaviorLedger } from './behavior-ledger'
import { LEDGER_RESPONSE_BYTES, type LedgerRead, type LedgerReadTiming, type LedgerReply } from './behavior-ledger-contract'

const PREFIX = '/api/behavior-ledger'
const ID = /^[a-f0-9]{64}$/
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/
const MAX_CURSOR_LENGTH = 2048

class InvalidRead extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function identifier(value: string): string {
  if (!ID.test(value)) throw new InvalidRead(400, 'invalid_id')
  return value
}

function cursor(value: string): string {
  if (!value || value.length > MAX_CURSOR_LENGTH) throw new InvalidRead(400, 'invalid_cursor')
  return value
}

/** Strictly bounded selectors; no evidence resolution or execution operations. */
export function parseBehaviorLedgerRead(target: string): LedgerRead {
  const url = new URL(target, 'http://ledger.invalid')
  if (target.split('?')[0] !== url.pathname) throw new InvalidRead(404, 'not_found')
  const path = url.pathname
  const operation = path === PREFIX ? 'list'
    : path === `${PREFIX}/changes` ? 'changes'
      : path === `${PREFIX}/health` ? 'health' : 'get'
  if (operation === 'get' && (!path.startsWith(`${PREFIX}/`) || path.slice(PREFIX.length + 1).includes('/'))) {
    throw new InvalidRead(404, 'not_found')
  }
  const permitted = operation === 'list' ? ['limit', 'cursor', 'parent', 'repository', 'number']
    : operation === 'changes' ? ['limit', 'cursor'] : []
  for (const key of url.searchParams.keys()) {
    if (!permitted.includes(key) || url.searchParams.getAll(key).length !== 1) throw new InvalidRead(400, 'invalid_query')
  }
  const rawLimit = url.searchParams.get('limit')
  if (rawLimit !== null && (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100)) {
    throw new InvalidRead(400, 'invalid_query')
  }
  const limit = rawLimit === null ? undefined : Number(rawLimit)
  const rawCursor = url.searchParams.get('cursor')
  const continuation = rawCursor === null ? undefined : cursor(rawCursor)
  if (operation === 'health') return { operation }
  if (operation === 'get') return { operation, id: identifier(path.slice(PREFIX.length + 1)) }
  if (operation === 'changes') {
    if (!continuation) throw new InvalidRead(400, 'invalid_cursor')
    return { operation, cursor: continuation, ...(limit === undefined ? {} : { limit }) }
  }
  const parent = url.searchParams.get('parent')
  const repository = url.searchParams.get('repository')
  const rawNumber = url.searchParams.get('number')
  if ((repository === null) !== (rawNumber === null)) throw new InvalidRead(400, 'invalid_query')
  if (repository !== null && (!REPO.test(repository) || repository.length > 140)) throw new InvalidRead(400, 'invalid_query')
  if (rawNumber !== null && (!/^[1-9]\d{0,9}$/.test(rawNumber) || !Number.isSafeInteger(Number(rawNumber)))) {
    throw new InvalidRead(400, 'invalid_query')
  }
  return { operation, ...(limit === undefined ? {} : { limit }), ...(continuation === undefined ? {} : { cursor: continuation }),
    ...(parent === null ? {} : { parent: identifier(parent) }),
    ...(repository === null || rawNumber === null ? {} : { repository, number: Number(rawNumber) }) }
}

function serverTiming(startedAt: number, timing?: LedgerReadTiming): string {
  const metrics: string[] = []
  const add = (name: string, duration: unknown) => {
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= 86_400_000) {
      metrics.push(`${name};dur=${duration.toFixed(1)}`)
    }
  }
  add('ledger-handler', performance.now() - startedAt)
  add('ledger-queue', timing?.queueMs)
  add('ledger-active', timing?.activeMs)
  if (timing?.timeout === 'queued') add('ledger-queue-timeout', timing.queueMs)
  if (timing?.timeout === 'active') add('ledger-active-timeout', timing.activeMs)
  const blocked = timing?.blocking
  if (blocked && ['admit', 'result', 'caller', 'heartbeat', 'loss', 'capture', 'read', 'pending', 'close'].includes(blocked.kind)) {
    add(`ledger-blocked-${blocked.kind}`, blocked.elapsedMs)
  }
  add('ledger-worker', timing?.worker?.totalMs)
  add('ledger-read', timing?.worker?.readMs)
  add('ledger-pending', timing?.worker?.pendingMs)
  add('ledger-encode', timing?.worker?.encodeMs)
  add('ledger-budget-scan', timing?.worker?.budgetScanMs)
  return metrics.join(', ')
}

function send(res: ServerResponse, status: number, body: LedgerReply, startedAt: number, timing?: LedgerReadTiming): void {
  let text = JSON.stringify(body)
  if (Buffer.byteLength(text) > LEDGER_RESPONSE_BYTES) {
    status = 503
    text = JSON.stringify({ version: 1, health: body.health, error: 'response_too_large' })
  }
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Server-Timing', serverTiming(startedAt, timing))
  if (status === 429) res.setHeader('Retry-After', '1')
  if (status === 405) res.setHeader('Allow', 'GET')
  res.end(text)
}

/** Called only after the current workspace/local request guards succeed. */
export async function handleBehaviorLedger(req: IncomingMessage, res: ServerResponse, target: string): Promise<void> {
  const startedAt = performance.now()
  let request: LedgerRead
  try {
    if (req.method !== 'GET') throw new InvalidRead(405, 'method_not_allowed')
    request = parseBehaviorLedgerRead(target)
  } catch (error) {
    if (!(error instanceof InvalidRead)) throw error
    const { body, timing } = await readBehaviorLedger({ operation: 'health' })
    return send(res, error.status, { version: 1, health: body.health, error: error.code }, startedAt, timing)
  }
  const { status, body, timing } = await readBehaviorLedger(request)
  send(res, status, body, startedAt, timing)
}
