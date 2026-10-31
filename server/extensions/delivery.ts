// What a chat receives: the servers switched on for its workspace, with
// every secret filled in. The runtime asks before each native start and
// before each turn; a different fingerprint means the native session resumes
// with the new set, so a change applies from the next turn.

import { createHash } from 'node:crypto'
import { accessToken } from './oauth'
import { addEvent, readSecret, redactSecrets, secretValues, storedServers, type StoredServer } from './store'
import { AGENT_LABEL, isEnabledIn, workspaceLabel, workspaceOf, type ResolvedServer, type Skipped } from './types'
import type { AgentId, ChatEvent } from '../chat/protocol'
import type { RuntimeExtensions } from '../chat/runtime'

export interface ExtensionSet {
  servers: ResolvedServer[]
  /** Servers switched on here that this chat cannot have, and why. */
  notices: string[]
  fingerprint: string
}

export type Resolution = { server: ResolvedServer } | { problem: string, signin?: true }

/** One server with its secrets and, for OAuth, a current access token. */
export async function resolveServer(stored: StoredServer): Promise<Resolution> {
  const { id, spec } = stored
  const values = (fields: typeof spec.env, prefix: 'env' | 'header'): Record<string, string> | string => {
    const out: Record<string, string> = {}
    for (const field of fields ?? []) {
      const value = field.secret ? readSecret(id, `${prefix}:${field.name}`) : field.value ?? ''
      if (value === null) return field.name
      out[field.name] = value
    }
    return out
  }
  if (spec.transport === 'stdio') {
    const env = values(spec.env, 'env')
    if (typeof env === 'string') return { problem: `${spec.title} has no value for ${env}` }
    return { server: { id, name: spec.name, title: spec.title, transport: 'stdio', command: spec.command, args: spec.args ?? [], env } }
  }
  const headers = values(spec.headers, 'header')
  if (typeof headers === 'string') return { problem: `${spec.title} has no value for ${headers}` }
  if (spec.auth === 'oauth' && !Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    const token = await accessToken(id)
    if (!token) return { problem: `${spec.title} needs a sign-in`, signin: true }
    headers.Authorization = `Bearer ${token}`
  }
  return { server: { id, name: spec.name, title: spec.title, transport: spec.transport, url: spec.url, headers } }
}

export async function extensionsFor(record: { repo: string }): Promise<ExtensionSet> {
  const workspace = workspaceOf(record)
  const servers: ResolvedServer[] = []
  const notices: string[] = []
  for (const stored of storedServers()) {
    if (!isEnabledIn(stored.enabled, workspace)) continue
    const resolution = await resolveServer(stored)
    if ('server' in resolution) servers.push(resolution.server)
    else notices.push(`Extensions: ${resolution.problem}, so this chat runs without it. ${resolution.signin ? 'Sign in' : 'Fix it'} in Extensions; the next turn picks it up.`)
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(servers)).digest('hex')
  return { servers, notices, fingerprint }
}

/** The activity line each delivered server keeps. */
export function recordDelivery(record: { title: string, repo: string, agent: AgentId }, set: ExtensionSet, skipped: readonly Skipped[]): void {
  const where = workspaceLabel(workspaceOf(record))
  for (const server of set.servers) {
    const missed = skipped.find((entry) => entry.name === server.title)
    addEvent(server.id, missed ? 'warning' : 'info', missed
      ? `Not delivered to ${AGENT_LABEL[record.agent]} chat “${record.title}” in ${where}: ${missed.reason}`
      : `Delivered to ${AGENT_LABEL[record.agent]} chat “${record.title}” in ${where}`)
  }
}

/** A transcript event with stored secret values replaced. */
export function scrubEvent(event: ChatEvent): ChatEvent {
  if (!secretValues().length) return event
  const text = JSON.stringify(event)
  const clean = redactSecrets(text)
  return clean === text ? event : JSON.parse(clean) as ChatEvent
}

export const runtimeExtensions: RuntimeExtensions = {
  resolve: extensionsFor,
  delivered: recordDelivery,
  scrub: scrubEvent,
  redact: redactSecrets,
}
