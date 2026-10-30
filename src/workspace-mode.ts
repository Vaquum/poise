// Whether this Poise is a workspace behind the gateway (service mode) and whose
// it is (GET /api/workspace). It cannot change while the page is open, so it is
// asked once; a read that fails is asked again next time.

export interface WorkspaceMode {
  service: boolean
  /** The owner's GitHub login in service mode; null on a personal computer. */
  owner: string | null
}

let pending: Promise<WorkspaceMode> | null = null

async function read(): Promise<WorkspaceMode> {
  const res = await fetch('/api/workspace', { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as { mode?: unknown, owner?: unknown } | null
  return data?.mode === 'service' && typeof data.owner === 'string'
    ? { service: true, owner: data.owner }
    : { service: false, owner: null }
}

export function workspaceMode(): Promise<WorkspaceMode> {
  if (!pending) {
    const attempt = read()
    pending = attempt
    attempt.catch(() => { if (pending === attempt) pending = null })
  }
  return pending
}
