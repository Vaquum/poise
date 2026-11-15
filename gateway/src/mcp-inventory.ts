import { HttpError } from './http.js'

export const WORKSPACE_RESOURCE = 'poise://workspace/inventory'
export const RUNBOOKS = [
  { name: 'Poise MCP', url: 'https://github.com/autonomio/poise/blob/main/docs/Poise-MCP.md' },
  { name: 'Behavior chain', url: 'https://github.com/autonomio/poise/blob/main/docs/Behavior-chain.md' },
  { name: 'Chat orchestration', url: 'https://github.com/autonomio/poise/blob/main/docs/Chat-orchestration.md' },
] as const

const repoName = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))

/** The workspace owns the inventory. Publish only metadata and links back to
 *  the authorized workspace, after intersecting its tools with the owner grant. */
export function workspaceInventory(value: unknown, origin: string, tools: readonly string[]) {
  if (value === undefined) return { coverage: 'unavailable', reason: 'The running workspace has no inventory projection' }
  if (!object(value) || !timestamp(value.observedAt) || !Array.isArray(value.surfaces) || value.surfaces.length > 128
    || !object(value.release) || typeof value.release.repo !== 'string' || !repoName.test(value.release.repo)
    || (value.release.commit !== null && (typeof value.release.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.release.commit)))
    || (value.release.since !== null && !timestamp(value.release.since))) throw new HttpError(502, 'invalid_workspace_inventory')
  const surfaces = value.surfaces.map((entry: unknown) => {
    if (!object(entry) || typeof entry.id !== 'string' || !/^[a-z0-9/-]{1,80}$/.test(entry.id) || typeof entry.kind !== 'string'
      || typeof entry.source !== 'string' || typeof entry.permission !== 'string' || typeof entry.retention !== 'string'
      || typeof entry.reason !== 'string' || typeof entry.href !== 'string' || !entry.href.startsWith('/?view=')) {
      throw new HttpError(502, 'invalid_workspace_inventory_surface')
    }
    const available = typeof entry.tool === 'string' && tools.includes(entry.tool)
    return { id: entry.id, kind: entry.kind, source: entry.source, permission: entry.permission, retention: entry.retention,
      href: new URL(entry.href, origin).href, status: available ? 'available' : 'unavailable',
      tool: available ? entry.tool : null, reason: typeof entry.tool === 'string' && !available
        ? 'Requires the listed permission and a workspace release that supports this read' : entry.reason }
  })
  if (new Set(surfaces.map(surface => surface.id)).size !== surfaces.length) throw new HttpError(502, 'duplicate_workspace_inventory_surface')
  const { repo, commit, since } = value.release
  return { coverage: 'complete', observedAt: value.observedAt, release: { repo, commit, since }, surfaces }
}
