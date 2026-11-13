import { expect, it, vi } from 'vitest'
import { arrangeCli, loadModules } from './behaviors-runtime-fixture'

// Behaviors health answers every /api/behaviors read and runs its queries per
// failure target: they compile once per connection, not on each read.
it('reads behavior health again without compiling its statements', async () => {
  arrangeCli()
  const { database: db, behaviors: runtime } = await loadModules()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_review_new_prs_enabled', '1')
  const now = Date.now()
  db.setMeta('behavior_review_new_prs_failure:acme/repo#7', JSON.stringify({ kind: 'worker', consecutiveFailures: 1,
    lastFailureAtMs: now, nextRetryAtMs: now + 60_000, error: 'held', diagnostic: { severity: 'info', code: 'rate_limit' },
    callId: 'a'.repeat(32) }))
  const first = runtime.getBehaviorsRuntimeHealth()
  expect(first.failures.map((failure) => failure.target)).toContain('acme/repo#7')
  const prepare = vi.spyOn(db.db, 'prepare')
  let compiled: string[] = []
  try {
    expect(runtime.getBehaviorsRuntimeHealth().failures.map((failure) => failure.target)).toContain('acme/repo#7')
  } finally {
    // Read before restoring: restoring a spy clears its calls.
    compiled = prepare.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim())
    prepare.mockRestore()
  }
  // The chain journal's own statements are cached on their own (behavior-chain-store).
  expect(compiled.filter((sql) => !/\bbehavior_chain_/.test(sql)).map((sql) => sql.slice(0, 60))).toEqual([])
})
