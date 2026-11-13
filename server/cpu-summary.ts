import { Session } from 'node:inspector'

// Where the server's thread spends its time, for /api/health/cpu: a short
// sampling profile of this process, summarised to the functions that use it.
// The full capture (server/production-cpu-profile.ts) needs a signal on the
// host; this answers from the workspace itself, and returns no data, only
// function names and times.

interface ProfileNode { id: number, callFrame: { functionName: string, url: string, lineNumber: number }, hitCount?: number, children?: number[] }
export interface Profile { nodes: ProfileNode[], startTime: number, endTime: number, samples?: number[] }
interface Spent { fn: string, at: string, ms: number }
export interface CpuSummary {
  durationMs: number
  samples: number
  /** Waiting for work: the thread was free. */
  idleMs: number
  gcMs: number
  /** Native work outside JavaScript functions (V8's own, and callbacks into C++). */
  programMs: number
  /** Time in each function itself, the most first. */
  self: Spent[]
  /** Time in each function and everything it called, the most first. */
  total: Spent[]
}

const SAMPLING_INTERVAL_US = 2_000
const LISTED = 30
let capturing = false

/** Samples this process for `seconds` and summarises where the time went. One at a time. */
export async function captureCpuSummary(seconds: number): Promise<CpuSummary> {
  if (capturing) throw new Error('a CPU summary is already being taken')
  capturing = true
  const session = new Session()
  const post = <T>(method: string, params: object = {}) => new Promise<T>((resolve, reject) => {
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result as T))
  })
  try {
    session.connect()
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US })
    await post('Profiler.start')
    await new Promise((resolve) => setTimeout(resolve, seconds * 1_000))
    const { profile } = await post<{ profile: Profile }>('Profiler.stop')
    return summariseProfile(profile)
  } finally {
    capturing = false
    try { session.disconnect() } catch { /* already closed */ }
  }
}

export function summariseProfile(profile: Profile): CpuSummary {
  const hits = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0)
  const durationMs = (profile.endTime - profile.startTime) / 1_000
  const perHit = hits ? durationMs / hits : 0
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const fn = (node: ProfileNode) => node.callFrame.functionName || '(anonymous)'
  const at = (node: ProfileNode) => node.callFrame.url ? `${node.callFrame.url.split('/').pop()}:${node.callFrame.lineNumber + 1}` : ''
  const key = (node: ProfileNode) => `${fn(node)} ${at(node)}`
  const add = (into: Map<string, Spent>, node: ProfileNode, ms: number) => {
    const entry = into.get(key(node)) ?? { fn: fn(node), at: at(node), ms: 0 }
    entry.ms += ms
    into.set(key(node), entry)
  }
  const self = new Map<string, Spent>()
  const total = new Map<string, Spent>()
  let idleMs = 0, gcMs = 0, programMs = 0
  for (const node of profile.nodes) {
    const ms = (node.hitCount ?? 0) * perHit
    if (!ms) continue
    if (fn(node) === '(idle)') idleMs += ms
    else if (fn(node) === '(garbage collector)') gcMs += ms
    else if (fn(node) === '(program)') programMs += ms
    else add(self, node, ms)
  }
  // Each function's time with what it called, counted once on a path that recurses.
  const inclusive = (node: ProfileNode, path: Set<string>): number => {
    let ms = (node.hitCount ?? 0) * perHit
    const nested = new Set(path).add(key(node))
    for (const child of node.children ?? []) ms += inclusive(nodes.get(child)!, nested)
    if (!path.has(key(node)) && !['(root)', '(idle)', '(program)', '(garbage collector)'].includes(fn(node))) add(total, node, ms)
    return ms
  }
  if (profile.nodes[0]) inclusive(profile.nodes[0], new Set())
  const top = (spent: Map<string, Spent>) => [...spent.values()].sort((a, b) => b.ms - a.ms).slice(0, LISTED)
    .map((entry) => ({ ...entry, ms: Math.round(entry.ms) }))
  return { durationMs: Math.round(durationMs), samples: hits, idleMs: Math.round(idleMs), gcMs: Math.round(gcMs),
    programMs: Math.round(programMs), self: top(self), total: top(total) }
}
