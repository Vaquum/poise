import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isExpectedFailure, runFile } from './process'

const FILE = 'tests/test-offload.test.ts'
const SINGLE = 'recovers mid-suite when only one suite may run'
const MEMORY = 'keeps memory warnings correlatable without logging command bodies with base service '
const OBSERVED = 'poise fixture recheck observation'
// JSON alone omits unhandled errors and can describe an interrupted run. The
// controller adds completion evidence to the pinned base's standard reporter.
const REPORTER = `import { JsonReporter } from 'vitest/node'
export default class extends JsonReporter {
  observations = 0
  onUserConsoleLog(log) {
    if (log.content.trim() === '${OBSERVED}') this.observations++
  }
  onTestRunEnd(modules, errors, reason) {
    this.completion = { reason, errors: errors.length, observations: this.observations }
    return super.onTestRunEnd(modules)
  }
  writeReport(report) {
    return super.writeReport(JSON.stringify({ ...JSON.parse(report), completion: this.completion }))
  }
}`

export interface TestRecheckResult {
  old: { base: string, tests: string[], failure: string }
  current: { base: string, tests: string[] }
  condition: string
}

function escape(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Apply only the incident's bounded observation condition, on both pinned
 * bases. No assertion, production code or test deadline is changed. */
export function recheckFixture(source: string, test: string, file = FILE) {
  const leaf = test.split(' > ').at(-1)!
  const single = leaf === SINGLE, memory = leaf.startsWith(MEMORY) && ['null', 'crn-test'].includes(leaf.slice(MEMORY.length))
  if (file !== FILE || !single && !memory) return { source, condition: 'unmodified reported test', names: [test], observations: 0 }
  const title = single ? SINGLE : MEMORY + '%s'
  const start = source.indexOf(`('${title}`)
  if (start < 0 || source.indexOf(`('${title}`, start + 1) >= 0) throw new Error('reported fixture is missing or ambiguous on the pinned base')
  const end = source.indexOf('\n  it', start + 1)
  if (end < 0) throw new Error('reported fixture boundary is unavailable')
  let fixture = source.slice(start, end)
  const delay = single ? 750 : 6650
  const statement = single ? 'relay.stop()' : 'const { code, stderr } = await suite(repo, argv).done'
  if (!fixture.includes(statement) || fixture.indexOf(statement) !== fixture.lastIndexOf(statement)) throw new Error('reported fixture observation is ambiguous')
  if (!single || !fixture.includes('setTimeout(done, 750)')) {
    fixture = fixture.replace(statement, `await new Promise((done) => setTimeout(done, ${delay}))\n      ${statement}`)
  }
  const boundary = single ? statement : `await new Promise((done) => setTimeout(done, ${delay}))`
  fixture = fixture.replace(boundary, `console.info('${OBSERVED}')\n      ${boundary}`)
  return { source: source.slice(0, start) + fixture + source.slice(end),
    condition: single ? '750 ms after first output, before relay interruption' : '6650 ms before each memory-warning command',
    names: memory ? [test, ...['node', 'sh', 'npm run check'].map(command => `${test} and command ${command}`)] : [test], observations: memory ? 3 : 1 }
}

interface Assertion { ancestorTitles: string[], title: string, status: string, failureMessages: string[] }
interface Results { success: boolean, completion: { reason: string, errors: number, observations: number }, numFailedTestSuites: number,
  numTotalTests: number, numPassedTests: number, numFailedTests: number, numPendingTests: number,
  numTodoTests: number, testResults: Array<{ name: string, message: string, assertionResults: Assertion[] }> }

export function recheckResults(stdout: string, cwd: string, names: string[], failed: boolean, file = FILE, observations = 0) {
  const result = JSON.parse(stdout) as Results
  if (result.completion?.reason !== (failed ? 'failed' : 'passed') || result.completion.errors !== 0
    || result.completion.observations !== observations || !Array.isArray(result.testResults)
    || result.testResults.length !== 1 || result.testResults[0].name !== join(cwd, file)
    || result.testResults[0].message || result.success !== !failed || !Array.isArray(result.testResults[0].assertionResults)) throw new Error('recheck has no complete assertion result')
  const assertions = result.testResults[0].assertionResults
  const selected = assertions.filter(item => !['pending', 'skipped', 'todo'].includes(item.status))
  const tests = selected.map(item => [...item.ancestorTitles, item.title].filter(Boolean).join(' > '))
  const expected = names.length === 1 || failed ? names.slice(0, 1) : names.slice(1)
  if (!selected.length || tests.length !== expected.length || new Set(tests).size !== tests.length
    || expected.some(name => !tests.includes(name))
    || assertions.some(item => ['pending', 'skipped', 'todo'].includes(item.status)
      && expected.includes([...item.ancestorTitles, item.title].filter(Boolean).join(' > ')))
    || selected.some(item => !['passed', 'failed'].includes(item.status))
    || result.numTotalTests !== assertions.length || result.numFailedTests !== selected.filter(item => item.status === 'failed').length
    || result.numPassedTests !== selected.filter(item => item.status === 'passed').length
    || result.numPendingTests + result.numTodoTests !== assertions.length - selected.length
    || (failed ? result.numFailedTests !== 1 : result.numFailedTests !== 0 || result.numFailedTestSuites !== 0)) {
    throw new Error('recheck did not exercise exactly the reported fixture cases')
  }
  const failure = selected.filter(item => item.status === 'failed').flatMap(item => item.failureMessages).join('\n').trim()
  if (failed && (!failure || failure.length > 8192 || failure === 'Error: STACK_TRACE_ERROR')) throw new Error('old-base recheck has no bounded actionable failure')
  return { tests, failure }
}

/** Fresh main sources, never the failed candidate or its historical reports.
 * Process deadlines also bound install, execution and cleanup failures. */
export async function recheckImplementationTest(repository: string, actor: string, old: string, current: string,
  merge: string, file: string, test: string): Promise<TestRecheckResult> {
  if (!/^tests\/(?:[\w-]+\/)*[\w.-]+\.(?:test|spec)\.[tj]sx?$/.test(file)
    || ![old, current, merge].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('recheck requires pinned fixture bases')
  const root = await mkdtemp(join(tmpdir(), 'poise-test-recheck-'))
  const cwd = join(root, 'repo')
  const options = { cwd, timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 }
  try {
    await runFile('github-interface', ['--checkout-repo', repository, '--path', cwd, '--token-user', actor], { timeoutMs: 120_000 })
    await runFile('git', ['merge-base', '--is-ancestor', old, merge], options)
    await runFile('git', ['merge-base', '--is-ancestor', merge, current], options)
    const diff = await runFile('git', ['diff', `${merge}^1`, merge, '--', file], options)
    if (!diff.stdout.trim()) throw new Error('linked remediation did not change the reported fixture')
    const results = []
    let condition = ''
    for (const base of [old, current]) {
      await runFile('git', ['checkout', '--detach', '--force', base], options)
      await runFile('git', ['clean', '-fdx'], options)
      const fixture = recheckFixture(await readFile(join(cwd, file), 'utf8'), test, file)
      condition = fixture.condition
      await writeFile(join(cwd, file), fixture.source)
      await runFile('npm', ['ci', '--no-audit', '--no-fund'], { ...options, timeoutMs: 120_000 })
      const reporter = join(cwd, '.poise-test-recheck.mjs')
      await writeFile(reporter, REPORTER)
      let stdout: string
      const failed = base === old
      try {
        ({ stdout } = await runFile('node', [join(cwd, 'node_modules/vitest/vitest.mjs'), 'run', file,
          '-t', `^(?:${fixture.names.map(name => escape(name.replaceAll(' > ', ' '))).join('|')})$`,
          '--maxWorkers=1', '--retry=0', '--reporter', reporter], { ...options, timeoutMs: 90_000, expected: { codes: [1] } }))
        if (failed) throw new Error('old-base recheck passed; the reported shared failure was not reproduced')
      } catch (error) {
        if (!isExpectedFailure(error)) throw error
        stdout = (error as { stdout: string }).stdout
        if (!failed) {
          const result = JSON.parse(stdout) as Results
          const failures = result.testResults?.flatMap(suite => suite.assertionResults.filter(item => item.status === 'failed')
            .flatMap(item => item.failureMessages)).join('\n')
          throw new Error(`corrected-base recheck failed: ${failures?.slice(0, 8192) || 'assertion details are unavailable'}`)
        }
      }
      results.push({ base, ...recheckResults(stdout, cwd, fixture.names, failed, file, fixture.observations) })
    }
    return { old: results[0], current: { base: results[1].base, tests: results[1].tests }, condition }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
