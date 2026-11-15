// A revision-fenced review that fails final cleanup stays visible in Logging:
// --diagnostics carries artifact.resource_error, and the classifier keeps it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { callerDiagnostic } from '../../gateway/src/diagnostics/sources'

const wire = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const before = JSON.stringify(wire)
assert.equal(wire.diagnostic.resource_error, 'cleanup_failed')
const input = callerDiagnostic(wire.diagnostic, 'local')
assert.ok(input, 'cleanup failure must stay visible')
assert.equal(input!.level, 'error')
assert.equal(input!.message, wire.diagnostic.error)
assert.equal(JSON.stringify(wire), before)
