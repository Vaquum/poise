import { RESERVED_HANDLES } from './config.js'

export type HostClass = { kind: 'apex' } | { kind: 'workspace'; handle: string } | { kind: 'unknown' }

// A handle is a lower-cased GitHub login, which is already a valid DNS label.
const HANDLE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/

/** The lower-cased host name of a Host header, without port or trailing dot; null when it is not a DNS name. */
export function hostName(header: string | undefined): string | null {
  const match = /^([a-z\d.-]+?)\.?(?::\d{1,5})?$/i.exec(header?.trim() ?? '')
  return match ? match[1].toLowerCase() : null
}

/** Classifies a host by name alone; whether a workspace handle belongs to anyone is the caller's question. */
export function classifyHost(header: string | undefined, domain: string): HostClass {
  const name = hostName(header)
  if (name === null) return { kind: 'unknown' }
  if (name === domain) return { kind: 'apex' }
  const suffix = `.${domain}`
  if (!name.endsWith(suffix)) return { kind: 'unknown' }
  const handle = name.slice(0, -suffix.length)
  if (!HANDLE.test(handle) || RESERVED_HANDLES.has(handle)) return { kind: 'unknown' }
  return { kind: 'workspace', handle }
}
