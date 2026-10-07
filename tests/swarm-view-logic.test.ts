import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

// swarm-view.ts is a browser module that touches `document` at import time
// through its module-level `let viewEl: HTMLElement`. The pure helpers are the
// part worth locking in, so the module is bundled and the helpers are pulled
// out of it rather than importing the view wholesale into a node environment.
const SRC = new URL('../src/views/swarm-view.ts', import.meta.url).pathname

type Helpers = {
  sessionLabel: (id: string) => string
  targetText: (e: any) => string
  matchesSearch: (e: any) => boolean
  setSearch: (q: string) => void
  startedAtMs: (e: any) => number
  elapsedText: (e: any) => string
  hasDetail: (e: any) => boolean
  progressText: (e: any) => string
  progressDetail: (e: any) => string
  quarantineRecordMarkup: (e: any) => string
  groupRuns: (entries: any[]) => Array<{ key: string, entries: any[] }>
}

async function loadHelpers(): Promise<Helpers> {
  const source = await readFile(SRC, 'utf8')
  // Re-export the internals and expose the module-level search state, which is
  // otherwise only reachable through a DOM input event.
  const patched = source + `
export const __test = {
  sessionLabel, targetText, matchesSearch, startedAtMs, elapsedText, hasDetail, progressText, progressDetail, quarantineRecordMarkup, groupRuns,
  setSearch: (q: string) => { searchQuery = q },
}
`
  const out = await build({
    stdin: { contents: patched, resolveDir: new URL('../src/views', import.meta.url).pathname, loader: 'ts' },
    bundle: true, platform: 'neutral', format: 'esm', write: false,
    external: ['*.css'],
  })
  const encoded = 'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
  const mod = await import(encoded)
  const t = mod.__test
  return { ...t, setSearch: t.setSearch }
}

const helpers = await loadHelpers()

function entry(over: Record<string, unknown> = {}): any {
  return {
    id: 'a'.repeat(32), pr_id: null, repo: null, actor: null, model: 'opus-5',
    behavior: 'chat', session_id: null, prompt: '', started_at: '2026-07-29T21:26:23',
    started_at_precise: null, completed_at: null, time_elapsed: '', status: 'completed',
    outcome: null, response: '', error: '', ...over,
  }
}

describe('identical finished attempts share a row', () => {
  const failed = (overrides: Record<string, unknown> = {}) => entry({
    repo: 'owner/repo', pr_id: '42', model: 'muse-spark-1.3-contributor-max',
    behavior: 'pr_review', status: 'failed', outcome: 'preflight_failed', error: 'Provider access blocked',
    expected_head: '1'.repeat(40), ...overrides,
  })

  it('groups repeated failures while preserving every attempt and the newest row', () => {
    const newest = failed({ id: 'b'.repeat(32), started_at: '2026-10-06T20:00:00', time_elapsed: '14s' })
    const earlier = failed({ started_at: '2026-10-06T19:00:00', time_elapsed: '13s' })
    expect(helpers.groupRuns([newest, entry(), earlier]).map((group) => group.entries))
      .toEqual([[newest, earlier], [entry()]])
  })

  it('compares full error output even when the first status line is identical', () => {
    const groups = helpers.groupRuns([
      failed({ error: 'Provider failed\nAPI key blocked' }),
      failed({ error: 'Provider failed\nNetwork unavailable' }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('keeps different work separate even when it fails with the same error', () => {
    const rows = [failed(), failed({ pr_id: '43' }), failed({ model: 'grok-4.7-xhigh' }),
      failed({ expected_head: '2'.repeat(40) }), failed({ prompt: 'A different request' }),
      failed({ outcome: null }), failed({ actor: 'other-reviewer' })]
    expect(helpers.groupRuns(rows)).toHaveLength(rows.length)
  })

  it('never treats response availability markers as equal output bodies', () => {
    expect(helpers.groupRuns([
      failed({ id: 'b'.repeat(32), response: 'body-one' }),
      failed({ response: 'body-two' }),
    ])).toHaveLength(2)
  })

  it('keeps unseen provider reasoning separate even when its character count matches', () => {
    const progress = { phase: 'failed', warning: null, events: [], reasoning_available: true, reasoning_chars: 100 }
    expect(helpers.groupRuns([
      failed({ id: 'b'.repeat(32), progress }), failed({ progress }),
    ])).toHaveLength(2)
  })

  it('keeps live workers individually visible and stoppable', () => {
    expect(helpers.groupRuns([
      failed({ id: 'b'.repeat(32), status: 'running' }),
      failed({ status: 'running' }),
    ])).toHaveLength(2)
  })

  it('groups the same final error despite differing activity histories', () => {
    const progress = { phase: 'finished', warning: null, events: [{ message: 'Failed before posting', at: '2026-10-06T17:00:00Z' }] }
    const newest = failed({ id: 'b'.repeat(32), progress })
    const earlier = failed({ progress: { ...progress, events: [{ message: 'Waiting for provider', at: '2026-10-06T16:00:00Z' }] } })
    expect(helpers.groupRuns([newest, earlier])[0].entries).toEqual([newest, earlier])
    expect(helpers.groupRuns([newest, earlier])).toHaveLength(1)
  })

  it('keeps distinct posted comment receipts separate under a matching error', () => {
    expect(helpers.groupRuns([
      failed(),
      failed({ receipts: [{ issue: 'owner/repo#42', comment_id: 123, url: null, author: 'reviewer' }] }),
    ])).toHaveLength(2)
  })
})

// A chat run is not tied to a repo or pull request, and Swarm has no Prompt
// column, so the session id is the only thing that identifies the row. It was
// on the wire and never read.
describe('a run with no pull request is identified by its session', () => {
  it('labels a chat row by its session instead of a dash', () => {
    expect(helpers.targetText(entry({ session_id: 'debate-cd5805a5-gemini' })))
      .toBe('debate-cd5805a5-gemini')
  })

  it('strips the editor prefix and the uniqueness digits from an editor session', () => {
    // editorChatSessionId() mints `editor-<slug>-<digits>`; the digits exist
    // only to keep two sessions minted in the same millisecond apart.
    expect(helpers.sessionLabel('editor-my-notes-1785143835153')).toBe('my-notes')
  })

  it('shortens a session too long to read, and never returns the raw id', () => {
    const long = 'editor-untitled-20260727091613565-1de20996-e5bc-41e3-a9f2-a9401ba9704b-1785143835153'
    const label = helpers.sessionLabel(long)
    expect(label.length).toBeLessThanOrEqual(26)
    expect(label.endsWith('…')).toBe(true)
  })

  it('still says nothing when there is genuinely nothing to say', () => {
    expect(helpers.targetText(entry())).toBe('')
  })

  it('prefers the pull request when the run has one', () => {
    expect(helpers.targetText(entry({ repo: 'owner/poise', pr_id: '42' }))).toBe('owner/poise#42')
  })
})

// Copying what the Target column shows and pasting it into the filter is the
// first thing anyone tries; it used to return nothing, because the filter
// matched repo and pr_id separately but never the rendered "name#123".
describe('the filter matches what the column shows', () => {
  it('matches the rendered target label', () => {
    helpers.setSearch('poise#42')
    expect(helpers.matchesSearch(entry({ repo: 'owner/poise', pr_id: '42' }))).toBe(true)
  })

  it('matches a session label', () => {
    helpers.setSearch('debate-cd5805a5')
    expect(helpers.matchesSearch(entry({ session_id: 'debate-cd5805a5-gemini' }))).toBe(true)
  })

  it('finds a failed run by its error text', () => {
    helpers.setSearch('rate limit')
    expect(helpers.matchesSearch(entry({ status: 'failed', error: 'GitHub rate limit exceeded' }))).toBe(true)
  })

  it('finds a review by its verdict', () => {
    helpers.setSearch('changes_requested')
    expect(helpers.matchesSearch(entry({ outcome: 'changes_requested' }))).toBe(true)
    helpers.setSearch('')
  })
})

// started_at is naive local time: ambiguous for the hour that repeats when the
// clock goes back, and nonexistent for the hour skipped when it goes forward.
describe('start time uses the exact instant when there is one', () => {
  it('prefers started_at_precise over the ambiguous local string', () => {
    const ms = helpers.startedAtMs(entry({
      started_at: '2026-07-29T21:26:23',
      started_at_precise: '2026-07-29T18:26:23.740Z',
    }))
    expect(ms).toBe(Date.parse('2026-07-29T18:26:23.740Z'))
  })

  it('falls back to the naive value for rows that predate it', () => {
    const ms = helpers.startedAtMs(entry({ started_at: '2026-07-29T21:26:23', started_at_precise: null }))
    expect(ms).toBe(new Date('2026-07-29T21:26:23').getTime())
  })
})

// agent-interface only fills time_elapsed when a run ends, so a running row's
// value sat still for up to a full refresh interval while Started ticked
// beside it — which reads as a stalled agent.
describe('elapsed is live while a run is still going', () => {
  it('derives elapsed for a running row', () => {
    const startedAgo = new Date(Date.now() - 90_000).toISOString()
    const text = helpers.elapsedText(entry({
      status: 'running', completed_at: null, time_elapsed: '', started_at_precise: startedAgo,
    }))
    expect(text).toMatch(/^1m \d+s$/)
  })

  it('keeps the recorded value once the run has finished', () => {
    expect(helpers.elapsedText(entry({
      status: 'completed', completed_at: '2026-07-29T18:34:00.262Z', time_elapsed: '7m 36s',
    }))).toBe('7m 36s')
  })
})

// Every failed run carries an error string. The row offered no way to open it,
// so diagnosing a failure meant leaving Poise for the CLI.
describe('a failed run can be opened', () => {
  it('offers detail for a failure with no response body', () => {
    expect(helpers.hasDetail(entry({ status: 'failed', response: '', error: 'boom' }))).toBe(true)
  })

  it('offers nothing when there is neither a body nor an error', () => {
    expect(helpers.hasDetail(entry({ response: '', error: '' }))).toBe(false)
  })
})


describe('progress reports observations without inventing model activity', () => {
  function running(overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString()
    return entry({ status: 'running', progress: {
      version: 1, phase: 'reasoning', phase_started_at: now, heartbeat_at: now,
      last_provider_event_at: now, deadline_at: null, warning: null,
      events: [{ at: now, message: 'Provider reported reasoning activity' }],
      ...overrides,
    } })
  }

  it('separates a fresh worker heartbeat from an unresponsive provider', () => {
    const row = running({ last_provider_event_at: new Date(Date.now() - 7 * 60_000).toISOString() })
    expect(helpers.progressText(row)).toContain('No provider update for 7m')
    expect(helpers.progressDetail(row)).toContain('Worker heartbeat 0s ago')
  })

  it('shows a lost worker heartbeat explicitly without declaring an outcome', () => {
    const row = running({ heartbeat_at: new Date(Date.now() - 90_000).toISOString() })
    expect(helpers.progressText(row)).toContain('Worker heartbeat missing for 1m')
    expect(row.status).toBe('running')
  })

  it('does not imply activity for old runs without instrumentation', () => {
    expect(helpers.progressText(entry({ status: 'running' }))).toBe('Progress unavailable for this run')
    expect(helpers.progressText(entry({ status: 'completed' }))).toBe('')
  })

  it('makes active runs expandable and escapes activity messages', () => {
    const row = running({ events: [{ at: new Date().toISOString(), message: '<img src=x onerror=alert(1)>' }] })
    expect(helpers.hasDetail(row)).toBe(true)
    expect(helpers.progressDetail(row)).not.toContain('<img')
    expect(helpers.progressDetail(row)).toContain('&lt;img')
  })

  it('reports observation failure and overdue deadlines without claiming a failed review', () => {
    const row = running({ warning: 'Progress stream incomplete', deadline_at: new Date(Date.now() - 1_000).toISOString() })
    expect(helpers.progressText(row)).toContain('Progress incomplete')
    expect(helpers.progressDetail(row)).toContain('Stage deadline passed; awaiting worker outcome')
    expect(row.status).toBe('running')
  })
})


describe('unreadable records remain diagnostics rather than actionable runs', () => {
  const unreadable = {
    index: 2, error: 'incomplete terminal outcome', id: 'b'.repeat(32),
    correlationId: 'claim-2', repo: 'owner/repo', prId: '42', behavior: 'pr_review', sessionId: null,
  }

  it('shows the reported target, call and rejection reason without implying an outcome or activity', () => {
    const markup = helpers.quarantineRecordMarkup(unreadable)
    expect(markup).toContain('Reported target: owner/repo#42')
    expect(markup).toContain('Call: ' + unreadable.id)
    expect(markup).toContain('Correlation: claim-2')
    expect(markup).toContain('Behavior: pr_review')
    expect(markup).toContain('incomplete terminal outcome')
    expect(markup).not.toMatch(/<button|agent-status-icon|elapsed-cell|started-cell|agent-row/)
  })

  it('keeps an unidentified record visible without inventing a target or call', () => {
    const markup = helpers.quarantineRecordMarkup({
      index: 0, error: 'log row is not an object', id: null, correlationId: null,
      repo: null, prId: null, behavior: null, sessionId: null,
    })
    expect(markup).toContain('Target unknown')
    expect(markup).toContain('Call: unknown')
    expect(markup).toContain('Log index: 0')
    expect(markup).toContain('log row is not an object')
  })

  it('preserves full session identity and escapes every reported field', () => {
    const markup = helpers.quarantineRecordMarkup({
      ...unreadable, repo: null, prId: null, sessionId: 'content-session-123',
      behavior: '<img src=x onerror=alert(1)>', error: '<script>bad</script>',
    })
    expect(markup).toContain('Reported session: content-session-123')
    expect(markup).toContain('&lt;script&gt;bad&lt;/script&gt;')
    expect(markup).toContain('&lt;img')
    expect(markup).not.toMatch(/<script|<img/)
  })
})
