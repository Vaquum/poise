import { expect, it } from 'vitest'
import { callerDiagnostic } from '../gateway/src/diagnostics/sources.js'

it('retains a native merge refusal target when the Call row lacks it', () => {
  const row = { id: 'a'.repeat(32), status: 'failed', behavior: 'native_action', error: 'GitHub refused',
    diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'merge_if_ready',
      phase: 'merge_admission', outcome: 'refused', repository: 'Vaquum/Nexus', pr: '118',
      expected_head: 'b'.repeat(40), stderr: 'merge method squash: GitHub 405', stderr_truncated: false } }
  expect(callerDiagnostic(row, 'local')).toMatchObject({ repository: 'Vaquum/Nexus', pr: '118',
    target: 'Vaquum/Nexus#118', stderr: 'merge method squash: GitHub 405', context: { expectedHead: 'b'.repeat(40) } })
  expect(callerDiagnostic({ ...row, repo: 'other/repo', pr_id: '9', expected_head: 'c'.repeat(40) }, 'local'))
    .toMatchObject({ repository: 'other/repo', pr: '9', context: { expectedHead: 'c'.repeat(40) } })
})
