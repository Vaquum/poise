// Caller pytest supplies stored log bytes to a fresh Poise decoder process.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAgentLogStdout } from '../../server/agent-log-parse'

const snapshot = parseAgentLogStdout(readFileSync(process.argv[2], 'utf8'), 'retained Caller failure')
assert.equal(snapshot.quarantined.length, 0, JSON.stringify(snapshot.quarantined))
assert.equal(snapshot.entries.length, 1)
process.stdout.write(JSON.stringify(snapshot.entries[0].diagnostic))
