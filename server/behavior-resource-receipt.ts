import { posix } from 'node:path'

/** Caller resource metadata. Publication phases cannot replace this receipt. */
export interface ResourceOwnershipReceipt {
  version: 1 | 2
  roots: { path: string, state: 'registered' | 'allocated' | 'reclaimed' | 'covered', device?: string, inode?: string,
    parent_device?: string, parent_inode?: string, reclaimed_at?: number, recovered_at?: number, covered_by?: string }[]
  errors: { cause: string, path: string | null, at: number, recovered_at?: number }[]
  process_pending?: boolean
  namespace?: NativeNamespaceReceipt
}

interface NativeNamespaceReceipt {
  state: 'requested' | 'active' | 'settled' | 'not_started'
  callId: string
  correlation: string
  controller?: { version: 1, instance: string }
  binding?: { pid: number, start: string, namespace: string, owner: { pid: number, start: string },
    holder: { pid: number, start: string }, epoch: { boot: string, init_start: string, namespace_dev: string, namespace_ino: string } }
  settled_at?: number
  no_effect?: 'original-no-go' | 'verified-pre-go'
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function time(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)) }
function decimal(value: unknown): boolean { return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) }
function processIdentity(value: unknown): value is { pid: number, start: string } {
  return object(value) && keys(value, ['pid', 'start']) && Number.isSafeInteger(value.pid) && Number(value.pid) >= 2 && decimal(value.start)
}

function namespaceReceipt(value: unknown): value is NativeNamespaceReceipt {
  if (!object(value) || typeof value.callId !== 'string' || !/^[0-9a-f]{32}$/.test(value.callId)
    || typeof value.correlation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value.correlation)) return false
  const base = ['state', 'callId', 'correlation']
  if (value.state === 'requested') return keys(value, base)
  if (value.state === 'not_started') return keys(value, [...base, 'no_effect', 'settled_at'])
    && value.no_effect === 'original-no-go' && time(value.settled_at)
  if (!['active', 'settled'].includes(String(value.state))
    || !keys(value, [...base, 'binding', 'controller', ...(value.state === 'settled' ? ['settled_at', 'no_effect'] : [])])
    || value.state === 'settled' && (!time(value.settled_at) || value.no_effect !== undefined && value.no_effect !== 'verified-pre-go')) return false
  const controller = value.controller, binding = value.binding
  if (!object(controller) || !keys(controller, ['version', 'instance']) || controller.version !== 1
    || typeof controller.instance !== 'string' || !/^[0-9a-f]{32}$/.test(controller.instance)
    || !object(binding) || !keys(binding, ['pid', 'start', 'namespace', 'owner', 'holder', 'epoch'])
    || !Number.isSafeInteger(binding.pid) || Number(binding.pid) < 2 || !decimal(binding.start)
    || typeof binding.namespace !== 'string' || !/^pid:\[[1-9][0-9]{0,19}\]$/.test(binding.namespace)
    || !processIdentity(binding.owner) || !processIdentity(binding.holder)
    || new Set([binding.pid, binding.owner.pid, binding.holder.pid]).size !== 3) return false
  const epoch = binding.epoch
  return object(epoch) && keys(epoch, ['boot', 'init_start', 'namespace_dev', 'namespace_ino'])
    && typeof epoch.boot === 'string' && epoch.boot.length > 0 && epoch.boot.length <= 128
    && ['init_start', 'namespace_dev', 'namespace_ino'].every(key => decimal(epoch[key]))
}

export function parseResourceOwnership(value: unknown): ResourceOwnershipReceipt {
  if (!object(value) || value.version !== 1 && value.version !== 2 || !Array.isArray(value.roots) || !Array.isArray(value.errors)
    || (value.process_pending !== undefined && typeof value.process_pending !== 'boolean')
    || Object.keys(value).some(key => !['version', 'roots', 'errors', 'process_pending', ...(value.version === 2 ? ['namespace'] : [])].includes(key))
    || value.version === 2 && (!namespaceReceipt(value.namespace)
      || (value.namespace.state === 'not_started' || value.namespace.no_effect === 'verified-pre-go') && value.roots.length > 0)
    || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error('invalid native resource ownership')
  const roots = new Map<string, Record<string, unknown>>()
  for (const root of value.roots) {
    if (!object(root) || typeof root.path !== 'string' || !root.path.startsWith('/') || roots.has(root.path)
      || !['registered', 'allocated', 'reclaimed', 'covered'].includes(String(root.state))
      || Object.keys(root).some(key => !['path', 'state', 'device', 'inode', 'parent_device', 'parent_inode', 'reclaimed_at', 'recovered_at', 'covered_by'].includes(key))
      || (['allocated', 'reclaimed'].includes(String(root.state)) && ['device', 'inode', 'parent_device', 'parent_inode']
        .some(key => typeof root[key] !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(String(root[key]))))
      || (root.state === 'covered' && (value.version !== 2 || typeof root.covered_by !== 'string'
        || ['device', 'inode', 'parent_device', 'parent_inode'].some(key => root[key] !== undefined)))
      || (root.covered_by !== undefined && root.state !== 'covered')
      || (['reclaimed', 'covered'].includes(String(root.state)) && !time(root.reclaimed_at))
      || (root.reclaimed_at !== undefined && (!['reclaimed', 'covered'].includes(String(root.state)) || !time(root.reclaimed_at)))
      || (root.recovered_at !== undefined && (!time(root.recovered_at) || root.recovered_at !== root.reclaimed_at))) {
      throw new Error('invalid native resource directory receipt')
    }
    roots.set(root.path, root)
  }
  for (const root of roots.values()) {
    if (root.state !== 'covered') continue
    const ancestor = typeof root.covered_by === 'string' ? roots.get(root.covered_by) : undefined
    if (!ancestor || ancestor.state !== 'reclaimed' || typeof root.path !== 'string' || typeof ancestor.path !== 'string'
      || posix.normalize(root.path) !== root.path || posix.normalize(ancestor.path) !== ancestor.path
      || !root.path.startsWith(`${ancestor.path}/`)
      || root.reclaimed_at !== ancestor.reclaimed_at) throw new Error('invalid native ancestor coverage')
  }
  for (const error of value.errors) {
    if (!object(error) || typeof error.cause !== 'string' || !error.cause || error.cause.length > 2000
      || (error.path !== null && (typeof error.path !== 'string' || !roots.has(error.path))) || !time(error.at)
      || (error.recovered_at !== undefined && (value.version !== 2 || !time(error.recovered_at) || error.recovered_at < Number(error.at)))
      || Object.keys(error).some(key => !['cause', 'path', 'at', 'recovered_at'].includes(key))) throw new Error('invalid native resource failure receipt')
  }
  return value as unknown as ResourceOwnershipReceipt
}

export function resourceOwnershipReleased(value: ResourceOwnershipReceipt): boolean {
  if (value.process_pending || value.roots.some(root => !['reclaimed', 'covered'].includes(root.state))) return false
  if (value.version === 2 && !['settled', 'not_started'].includes(value.namespace?.state ?? '')) return false
  const reclaimedAt = value.roots.reduce((latest, root) => Math.max(latest, root.reclaimed_at ?? Infinity), 0)
  return value.errors.every(error => {
    const recovered = error.recovered_at
    return value.version === 2 && value.namespace?.state === 'settled' && recovered !== undefined
      && recovered >= Math.max(error.at, value.namespace.settled_at ?? Infinity, reclaimedAt)
      || error.cause !== 'resources_unknown' && error.path !== null
      && (value.roots.find(root => root.path === error.path)?.recovered_at ?? 0) >= error.at
  })
}

export function resourceReleaseContradicted(evidence: Record<string, unknown>): boolean {
  if (!evidence.resources_settled_at) return false
  const releasedAt = typeof evidence.resources_settled_at === 'string' ? Date.parse(evidence.resources_settled_at) : NaN
  const artifact = evidence.artifact
  const uncertain = object(artifact) && (artifact.resource_error != null || artifact.phase === 'resources_unknown')
  if (evidence.resource_ownership != null) {
    try {
      const ownership = parseResourceOwnership(evidence.resource_ownership)
      return !resourceOwnershipReleased(ownership) || ownership.version === 2
        && (!ownership.namespace?.settled_at || typeof evidence.resources_settled_at !== 'string'
          || releasedAt < ownership.namespace.settled_at * 1000
          || ownership.errors.some(error => error.recovered_at !== undefined
            && releasedAt < Math.floor(error.recovered_at * 1000)))
        || !!uncertain && (!object(artifact) || !time(artifact.resource_recovered_at) || ownership.version !== 2
          || !ownership.errors.length || ownership.errors.some(error => error.recovered_at === undefined
            || Number(artifact.resource_recovered_at) < error.recovered_at)
          || releasedAt < Math.floor(Number(artifact.resource_recovered_at) * 1000))
    }
    catch { return true }
  }
  return !!uncertain
}

export function resourceReleaseProven(evidence: Record<string, unknown>, requireOwnership = false): boolean {
  return typeof evidence.resources_settled_at === 'string' && Number.isFinite(Date.parse(evidence.resources_settled_at))
    && (!requireOwnership || evidence.resource_ownership != null)
    && !resourceReleaseContradicted(evidence)
}

export function nativeResourcesPending(invocation: Record<string, unknown>): boolean {
  const evidence = object(invocation.evidence) ? invocation.evidence : {}
  if (object(evidence.publicationResume) && typeof evidence.publicationResume.correlation === 'string'
    && (!object(evidence.publicationReceipt) || !resourceReleaseProven(evidence.publicationReceipt, true))) return true
  // A receipt-store failure before any CLI ran creates no Call and acquires
  // no resources, so its deferred settlement holds no reservation. Cleanup
  // has no Call to reconcile; readability alone clears this hold.
  if (invocation.state === 'settled' && invocation.outcome === 'receipt_unavailable'
    && evidence.action === 'not_started' && !evidence.nativeCallId && !evidence.resource_ownership) return false
  const request = object(invocation.request) ? invocation.request : {}
  if (invocation.model === null && request.nativeResources !== 2 && !evidence.nativeCallId && !evidence.resource_ownership) return false
  if (request.nativeResources === 2 || evidence.nativeCallId || object(evidence.resource_ownership) && evidence.resource_ownership.version === 2) {
    return !resourceReleaseProven(evidence, true)
  }
  // Older terminal journal records remain readable. Contradictory release
  // evidence is re-held in derived capacity without rewriting any event/hash.
  return invocation.state === 'settled' ? resourceReleaseContradicted(evidence) : !resourceReleaseProven(evidence, true)
}
