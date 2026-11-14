import { relative } from 'node:path'
import type { Reporter, TestCase } from 'vitest/node'
import { environmentSecrets, redact } from '../gateway/src/diagnostics/redaction.mjs'

const LIMIT = 8192
const TRUNCATED = '\n[truncated]'

export default class FirstFailureReporter implements Reporter {
  private reported = false

  onTestRunStart(): void {
    this.reported = false
  }

  onTestCaseResult(test: TestCase): void {
    const result = test.result()
    if (this.reported || result.state !== 'failed') return
    this.reported = true
    const error = result.errors.find((error) => error.stack || error.message)
    const record = `[poise] first test failure: ${relative(process.cwd(), test.module.moduleId)} > ${test.fullName}\n${error?.stack || error?.message || 'Assertion details unavailable'}`
    // Redact the complete record: clipping a credential first could leave a secret fragment.
    const safe = redact(record, environmentSecrets())
    process.stderr.write((safe.length > LIMIT ? safe.slice(0, LIMIT - TRUNCATED.length) + TRUNCATED : safe) + '\n')
  }
}
