// Shared types for existing work-monitor observations; no reader or runtime lives here.
export interface WorkTarget { url: string, repo: string, kind: 'issues' | 'pull', number: number }

export interface CiObservation {
  head: string, pending?: boolean, failing: Array<{ name: string, state: string, conclusion?: string | null, url?: string | null }>,
  /** Merge state from the same get_pull response: null while GitHub is still computing it. Absent from older Caller output. */
  mergeable?: boolean | null, mergeableState?: string | null, author?: string, draft?: boolean, base?: string,
  /** Pull state from the same get_pull response. Absent from older Caller output. */
  state?: string, merged?: boolean,
}
