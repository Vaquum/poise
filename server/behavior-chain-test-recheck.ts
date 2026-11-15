import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FailedSourceEvidence } from './agent-log-parse'
import { isExpectedFailure, runFile } from './process'

const TEST_PATH = /^tests\/(?:[\w-]+\/)*[\w.-]+\.(?:test|spec)\.[tj]sx?$/
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
  merge: string, file: string, test: string, signal?: AbortSignal): Promise<TestRecheckResult> {
  if (!TEST_PATH.test(file)
    || ![old, current, merge].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('recheck requires pinned fixture bases')
  const root = await mkdtemp(join(tmpdir(), 'poise-test-recheck-'))
  const cwd = join(root, 'repo')
  const options = { cwd, timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024, signal }
  try {
    await runFile('github-interface', ['--checkout-repo', repository, '--path', cwd, '--token-user', actor], { timeoutMs: 120_000, signal })
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

export interface ReportedAssertion { file: string, test: string, message: string }
type Diagnosis = { kind: 'distinct-fix' | 'source-only' } | { kind: 'inconclusive', reason: string }
type Capture = Extract<FailedSourceEvidence, { status: 'available' }>

/** Worker prose selects a probe. Only a complete, matching assertion can classify it. */
export function reportedAssertion(error: string): ReportedAssertion | null {
  const head = error.split(/\s+Captured candidate\b/i)[0]
  const matches = [...head.matchAll(/\b(tests\/[\w./-]+)\s*>\s*([^\n]+?)(?:\s+[—–-]\s+|:\s+)AssertionError:\s*([^\n]+)/g)]
  if (matches.length !== 1) return null
  const [, file, name, message] = matches[0]
  const test = name.replace(/\s+\([^()]+:\d+\)$/, '').trim()
  if (!TEST_PATH.test(file) || !test || !message.trim() || message.length > 500) return null
  return { file, test, message: assertionMessage(message) }
}

function assertionMessage(message: string) {
  return message.trim().replace(/\s+/g, ' ').replace(/\s+\/\/ Object\.is equality$/, '').replace(/\.$/, '')
}

async function exists(path: string) {
  try { return await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeReplayFile(cwd: string, name: string, contents: Buffer | null, mode = 0o644) {
  const parts = name.split('/')
  let parent = cwd
  for (const segment of parts.slice(0, -1)) {
    parent = join(parent, segment)
    const node = await exists(parent)
    if (node && !node.isDirectory()) throw new Error('replay path crosses a non-directory')
    if (!node) await mkdir(parent)
  }
  const target = join(parent, parts.at(-1)!)
  const node = await exists(target)
  if (node && !node.isFile()) throw new Error('replay target is outside the regular-file scope')
  if (node) await rm(target)
  if (contents !== null) await writeFile(target, contents, { flag: 'wx', mode })
}

/** Materialize only the verified regular-file manifest, in the disposable
 * checkout. The candidate itself runs on the existing credential-free box. */
async function restoreCandidate(cwd: string, path: string, capture: Capture, call: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let payload: Buffer
  try {
    const stat = await handle.stat()
    const bytes = Buffer.alloc(capture.bytes + 1)
    if (!stat.isFile() || stat.mode & 0o077 || stat.size !== capture.bytes
      || (await handle.read(bytes, 0, bytes.length, 0)).bytesRead !== capture.bytes) throw new Error('capture changed')
    payload = bytes.subarray(0, capture.bytes)
  } finally { await handle.close() }
  if (createHash('sha256').update(payload).digest('hex') !== capture.sha256) throw new Error('capture changed')
  const manifest = JSON.parse(payload.toString('utf8')) as { call: string, candidate: string, run: string, base: string,
    changes: Array<{ path: string, mode: string | null, content: string | null }> }
  if (manifest.call !== call || manifest.candidate !== capture.candidate || manifest.run !== capture.run
    || manifest.base !== capture.base || !Array.isArray(manifest.changes) || !manifest.changes.length
    || manifest.changes.length > 1024) throw new Error('capture identity or bounded inventory is incomplete')
  const seen = new Set<string>()
  for (const entry of manifest.changes) {
    const name = entry.path
    if (typeof name !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(name)
      || name.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase())) || seen.has(name.toLowerCase())
      || (entry.mode === null ? entry.content !== null : !['100644', '100755'].includes(entry.mode) || typeof entry.content !== 'string')) {
      throw new Error('capture is outside the regular-file replay scope')
    }
    seen.add(name.toLowerCase())
    const contents = entry.content === null ? null : Buffer.from(entry.content, 'base64')
    if (contents && contents.toString('base64') !== entry.content) throw new Error('capture encoding changed')
    await writeReplayFile(cwd, name, contents, entry.mode === '100755' ? 0o755 : 0o644)
  }
}

function missingAssertion(stdout: string, cwd: string, file: string, test: string) {
  try {
    const result = JSON.parse(stdout) as Results
    const suite = result.testResults?.[0]
    return result.completion?.reason === 'passed' && result.completion.errors === 0
      && result.testResults.length === 1 && suite?.name === join(cwd, file) && !suite.message
      && suite.assertionResults.length === result.numTotalTests && result.numPassedTests === 0 && result.numFailedTests === 0
      && suite.assertionResults.every(item => ['pending', 'skipped', 'todo'].includes(item.status)
        && [...item.ancestorTitles, item.title].filter(Boolean).join(' > ') !== test)
  } catch { return false }
}

export async function diagnoseReportedAssertion(repository: string, actor: string, base: string, prepared: string,
  assertion: ReportedAssertion, retained: { path: string, capture: Capture, call: string } | null,
  signal?: AbortSignal): Promise<Diagnosis> {
  const inconclusive = (reason: string): Diagnosis => ({ kind: 'inconclusive', reason })
  const { file, test, message } = assertion
  if (!TEST_PATH.test(file) || ![base, prepared].every(sha => /^[a-f0-9]{40}$/.test(sha))) {
    return inconclusive('the reported test or its pinned bases are unverified')
  }
  const root = await mkdtemp(join(tmpdir(), 'poise-report-triage-'))
  try {
    const cwd = join(await realpath(root), 'repo')
    const isolatedHome = join(root, 'home')
    await mkdir(isolatedHome)
    const options = { cwd, signal, timeoutMs: 30_000, reportFailure: false, maxOutputBytes: 2 * 1024 * 1024 }
    const checkout = async (sha: string) => {
      await runFile('git', ['checkout', '--detach', '--force', sha], options)
      await runFile('git', ['clean', '-fdx'], options)
    }
    const probe = async (relay?: string) => {
      const testPath = join(cwd, file)
      const node = await exists(testPath)
      if (!node) return 'missing test file'
      if (!node.isFile() || await realpath(testPath) !== testPath) return 'the test file is outside the pinned checkout'
      const reporter = join(cwd, '.poise-report-triage.mjs')
      await writeFile(reporter, REPORTER, { flag: 'wx' })
      const args = ['node_modules/vitest/vitest.mjs', 'run', file, '-t', `^${escape(test.replaceAll(' > ', ' '))}$`,
        '--maxWorkers=1', '--retry=0', '--reporter', reporter]
      const env = { HOME: isolatedHome, XDG_CONFIG_HOME: isolatedHome, XDG_CACHE_HOME: isolatedHome,
        XDG_DATA_HOME: isolatedHome, XDG_STATE_HOME: isolatedHome, XDG_RUNTIME_DIR: isolatedHome }
      if (!relay) {
        try { await runFile('npm', ['ci', '--no-audit', '--no-fund'], { ...options, env, timeoutMs: 120_000 }) }
        catch { return 'dependency installation did not complete' }
      }
      let failed = false, stdout
      try {
        ({ stdout } = await runFile('node', relay
          ? [relay, '--', 'sh', '-c', 'npm ci --no-audit --no-fund >&2 && exec node "$@"', 'poise-report-triage', ...args]
          : args, { ...options, env: { ...env, BASH_DEFAULT_TIMEOUT_MS: '240000' },
          timeoutMs: relay ? 245_000 : 90_000, expected: { codes: [1] } }))
      } catch (error) {
        if (!isExpectedFailure(error)) return 'test execution did not complete'
        failed = true
        stdout = (error as { stdout: string }).stdout
      }
      let result
      try { result = recheckResults(stdout, cwd, [test], failed, file) }
      catch {
        return !failed && missingAssertion(stdout, cwd, file, test) ? 'the named test is absent'
          : 'the test was not exercised with exactly one complete assertion'
      }
      if (!failed) return 'passed'
      const match = /^AssertionError:\s*([^\n]+)/.exec(result.failure)
      return match && assertionMessage(match[1]) === message ? 'matched' : 'a different assertion failed'
    }
    await runFile('github-interface', ['--checkout-repo', repository, '--path', cwd, '--token-user', actor],
      { timeoutMs: 120_000, signal, reportFailure: false })
    await checkout(base)
    const main = await probe()
    if (main === 'matched') return { kind: 'distinct-fix' }
    const missing = (outcome: string) => ['missing test file', 'the named test is absent'].includes(outcome)
    if (!retained || main !== 'passed' && !missing(main)) {
      return inconclusive(`current main: ${main}${retained ? '' : '. Retained candidate source is unavailable'}`)
    }
    const offload = join(homedir(), '.poise', 'test-offload')
    const relay = join(offload, 'run.mjs')
    if (!(await exists(relay))?.isFile() || !(await exists(join(offload, 'relay')))?.isFile()) {
      return inconclusive('candidate reproduction requires the workspace test box')
    }
    await checkout(prepared)
    await restoreCandidate(cwd, retained.path, retained.capture, retained.call)
    const candidate = await probe(relay)
    if (candidate !== 'matched') return inconclusive(`retained candidate: ${candidate}`)
    const testPath = join(cwd, file)
    const testSource = await readFile(testPath)
    if (testSource.length > 2 * 1024 * 1024) return inconclusive('the retained candidate test exceeds the replay limit')
    for (const pinned of new Set([base, prepared])) {
      await checkout(pinned)
      const clean = await exists(testPath)
      const identical = clean?.isFile() && await realpath(testPath) === testPath && (await readFile(testPath)).equals(testSource)
      if (identical && pinned === base && main === 'passed') continue
      // A newly added or changed case still needs a positive passing control.
      // Only that captured test is overlaid on clean code, inside the box.
      if (!identical) await writeReplayFile(cwd, file, testSource)
      const result = await probe(identical ? undefined : relay)
      if (result !== 'passed') return inconclusive(`clean ${pinned === base ? 'current' : 'prepared'} base with the exact test: ${result}`)
    }
    return { kind: 'source-only' }
  } catch {
    // Output and exception paths from the private checkout must stay there.
    return inconclusive('a pinned checkout or the exact retained candidate could not be prepared for reproduction')
  } finally { await rm(root, { recursive: true, force: true }) }
}
