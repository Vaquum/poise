import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'

const smoke = ['smoke', 'service-mode', 'independent-startup']
const areas = [
  [/^src\/(?:views\/chat[^/]*|chat-[^/]+)\.(?:ts|css)$/, /^(?:chat|current-chat)/],
  [/^src\/(?:views\/(?:admin-settings|connected-accounts)|settings-[^/]+)\.(?:ts|css)$/, /^(?:navigation-settings|settings-save|storage-settings|service-settings|connected-accounts)$/],
  [/^src\/(?:views\/analytics-view|analytics-[^/]+)\.(?:ts|css)$/, /^(?:analytics|behavior-metrics)$/],
  [/^src\/views\/swarm-view\.ts$/, /^(?:swarm-|repo-skips|multi-org|grey-ci-behavior)/],
  [/^src\/(?:views\/editor[^/]*|editor-[^/]+)\.(?:ts|css)$/, /^(?:editor-|publishing|google-publishing|article-reviews)/],
  [/^src\/(?:views\/snippets-view|snippet[^/]*)\.(?:ts|css)$/, /^(?:snippets-import|navigation-settings)$/],
  [/^src\/(?:views\/notification-rail|notification-[^/]+)\.(?:ts|css)$/, /^notices$/],
  [/^src\/(?:motion[^/]*|views\/motion[^/]*)\.(?:ts|css)$/, /^(?:motion|menu-ux|loading-stability|view-feedback)/],
]
// A change to one of these can change what every test proves, so only the full suite can vouch for it.
const sharedSetup = /^(?:package(?:-lock)?\.json$|\.node-version$|(?:vitest|playwright|vite)\.config\.ts$|tsconfig[^/]*\.json$|\.github\/workflows\/|tests\/essential\.txt$|tests\/e2e\/fixtures\/|tests\/[^/]+-isolation\.ts$)/
const unitTest = /^tests\/.+\.test\.(?:ts|mjs)$/
const browserSpec = /^tests\/e2e\/[^/]+\.spec\.ts$/
const importSpecifier = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*|\bvi\.(?:mock|doMock|importActual)(?:<[^>]*>)?\(\s*)['"`]([^'"`]+)['"`]/g
const fullRunIssueTitle = 'fix: the full test suite fails on main'

// Without extension or query, so `../server/x.js` also names a deleted server/x.ts.
const moduleKey = path => path.replace(/[?#].*$/, '').replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '')

export function documentation(path) {
  return path.startsWith('docs/') || /^[^/]+\.md$/.test(path)
}

export function selectBrowserTests(paths, browserFiles) {
  const selected = new Set(browserFiles.filter(file => smoke.includes(file.split('/').at(-1).replace('.spec.ts', ''))))
  for (const path of paths) {
    if (browserFiles.includes(path)) {
      selected.add(path)
      continue
    }
    const area = areas.find(([source]) => source.test(path))
    if (!area) continue
    const matches = browserFiles.filter(file => area[1].test(file.split('/').at(-1).replace('.spec.ts', '')))
    if (!matches.length) throw new Error(`No browser coverage for ${path}`)
    matches.forEach(file => selected.add(file))
  }
  if (!smoke.every(name => selected.has(`tests/e2e/${name}.spec.ts`))) throw new Error('Missing core browser smoke suite')
  return [...selected].sort()
}

export function selectTests(event, paths, browserFiles) {
  if (!['pull_request', 'merge_group'].includes(event) || !paths.length) return { mode: 'full', browserFiles: [] }
  if (paths.every(documentation)) return { mode: 'none', browserFiles: [] }
  if (paths.some(path => sharedSetup.test(path))) return { mode: 'full', browserFiles: [] }
  return { mode: 'essential', browserFiles: selectBrowserTests(paths, browserFiles) }
}

// tests/essential.txt, the tests that edit or directly import what changed.
export function selectUnitTests(paths, testFiles, essential, read) {
  const missing = essential.filter(file => !testFiles.includes(file))
  if (missing.length) throw new Error(`tests/essential.txt names tests that do not exist: ${missing.join(', ')}`)
  const changed = new Set(paths.map(moduleKey))
  const linked = testFiles.filter(file => paths.includes(file) || [...read(file).matchAll(importSpecifier)]
    .some(([, specifier]) => specifier.startsWith('.') && changed.has(moduleKey(posix.join(posix.dirname(file), specifier)))))
  return [...new Set([...essential, ...linked])].sort()
}

// One merge in ten, decided by its commit ID: no state to keep, and a rerun draws the same.
export function drawsFullRun(sha) {
  return parseInt(sha.slice(0, 8), 16) % 10 === 0
}

export function callerAffected(paths) {
  return !paths.length || paths.some(path => !documentation(path) && !path.startsWith('src/') && !path.startsWith('tests/e2e/'))
}

export function reusableRun(runs, { repository, sha, workflow }) {
  const candidates = runs.filter(run => run.event === 'merge_group' && run.head_sha === sha
    && run.path === `.github/workflows/${workflow}` && run.head_repository?.full_name === repository
    && run.head_branch?.startsWith('gh-readonly-queue/main/'))
  const latest = candidates.sort((a, b) => b.id - a.id)[0]
  return latest?.status === 'completed' && latest.conclusion === 'success' ? latest : null
}

export function verify(results) {
  if (results.plan?.result !== 'success') throw new Error('CI plan did not succeed')
  const mode = results.plan.outputs.mode
  if (!['full', 'essential', 'none', 'reuse'].includes(mode)) throw new Error(`Unknown CI mode: ${mode}`)
  if (mode === 'reuse' && !results.plan.outputs.reuse_url) throw new Error('Missing reused run evidence')
  const expected = ['none', 'reuse'].includes(mode) ? 'skipped' : 'success'
  for (const name of ['static', 'build', 'unit', 'browser']) {
    if (results[name]?.result !== expected) throw new Error(`${name}: expected ${expected}, got ${results[name]?.result}`)
  }
}

// The name of every test that failed in a Vitest or Playwright JSON report.
export function failedTests(report) {
  if (report.testResults) {
    return report.testResults.flatMap((file) => {
      const path = file.name.slice(file.name.indexOf('tests/'))
      const failed = file.assertionResults.filter(test => test.status === 'failed').map(test => `${path} > ${test.fullName}`)
      return failed.length || file.status === 'passed' ? failed : [`${path} did not finish`]
    })
  }
  const walk = suite => [
    ...(suite.specs ?? []).filter(spec => !spec.ok).map(spec => `tests/e2e/${spec.file} > ${spec.title}`),
    ...(suite.suites ?? []).flatMap(walk),
  ]
  return (report.suites ?? []).flatMap(walk)
}

function testReports(folder) {
  if (!existsSync(folder)) return []
  return readdirSync(folder).flatMap(artifact => ['vitest.json', 'test-results/playwright.json']
    .map(file => join(folder, artifact, file))
    .filter(file => existsSync(file))
    .flatMap((file) => {
      try {
        return failedTests(JSON.parse(readFileSync(file, 'utf8')))
      } catch (error) {
        return [`${file} could not be read: ${error.message}`]
      }
    }))
}

export function failureReport({ sha, url, jobs, tests, previous, merged }) {
  const named = tests.slice(0, 50).map(test => `- ${test}`)
  if (tests.length > named.length) named.push(`- and ${tests.length - named.length} more; the run has them all`)
  return [
    `The full test suite failed on \`main\` at ${sha}: ${url}`,
    `Did not pass: ${jobs.join(', ')}.`,
    ...(named.length ? ['Tests that still failed after their retries:', ...named] : ['No test report names a failed test, so the failure is in the jobs above.']),
    previous
      ? [`Merged since the last full run that passed (${previous}):`, ...(merged.length ? merged : ['- nothing'])].join('\n')
      : 'No earlier full run that passed was found.',
    'Fix the code, or the test if the test is wrong. `npx vitest run <file>` and `npm run test:e2e -- <spec>` run them.',
  ].join('\n\n')
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
    else process.stdout.write(line)
  }
}

async function github(path, { method = 'GET', body } = {}) {
  const { GITHUB_API_URL: api = 'https://api.github.com', GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = process.env
  if (!repository || !token) throw new Error('Missing GITHUB_REPOSITORY or GITHUB_TOKEN')
  const response = await fetch(`${api}/repos/${repository}/${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`)
  return response.json()
}

// Tracked and untracked, so a test the change just added counts.
function testFiles(pattern) {
  return git('ls-files', '--cached', '--others', '--exclude-standard', '-z', 'tests').split('\0')
    .filter(path => pattern.test(path) && existsSync(path))
}

function essentialUnitTests(paths) {
  const essential = readFileSync('tests/essential.txt', 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  return selectUnitTests(paths, testFiles(unitTest), essential, file => readFileSync(file, 'utf8'))
}

export async function plan(workflow) {
  if (!['ci.yml', 'caller.yml'].includes(workflow)) throw new Error('Expected CI or Caller workflow')
  const { GITHUB_EVENT_NAME: event, GITHUB_SHA: sha, BASE: base } = process.env
  if (!['pull_request', 'merge_group', 'push', 'workflow_dispatch'].includes(event)) throw new Error(`Unsupported event: ${event}`)
  let reused = null
  const drawn = event === 'push' && workflow === 'ci.yml' && drawsFullRun(sha ?? '')
  if (event === 'push' && !drawn) {
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Missing reuse API configuration')
    const data = await github(`actions/workflows/${workflow}/runs?event=merge_group&head_sha=${sha}&per_page=100`)
    if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid workflow-runs response')
    reused = reusableRun(data.workflow_runs, { repository: process.env.GITHUB_REPOSITORY, sha, workflow })
  }
  let paths = []
  if (event === 'pull_request' || (event === 'merge_group' && workflow === 'ci.yml')) {
    if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('Missing comparison base SHA')
    paths = git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD').split('\0').filter(Boolean)
  }
  const selection = selectTests(event, paths, testFiles(browserSpec))
  const mode = reused ? 'reuse' : selection.mode
  const version = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages['node_modules/@playwright/test'].version
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable locked Playwright version')
  const values = {
    mode, browser_files: selection.browserFiles,
    unit_files: workflow === 'ci.yml' && selection.mode === 'essential' ? essentialUnitTests(paths) : [],
    browser_image: `mcr.microsoft.com/playwright:v${version}-noble`,
    unit_shards: mode === 'full' ? [1, 2] : [1],
    browser_shards: mode === 'full' ? [1, 2, 3, 4] : [1],
    reuse_url: reused?.html_url ?? '',
    run: !reused && (event !== 'pull_request' || callerAffected(paths)),
  }
  output(values)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `CI mode: **${mode}**. ${reused ? `Reuses ${reused.html_url} for exact commit ${sha}.` : drawn ? `Commit ${sha} drew the full run.` : `Changed paths: ${paths.length}.`}\n`)
}

function npmRun(args) {
  const result = spawnSync('npm', ['run', ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

function selectedFiles(variable, pattern) {
  const files = JSON.parse(process.env[variable] ?? 'null')
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !pattern.test(file))) throw new Error(`Invalid ${variable}`)
  return files
}

function runTests(kind) {
  const mode = process.env.CI_TEST_MODE
  if (!['full', 'essential'].includes(mode)) throw new Error(`Cannot run tests in mode ${mode}`)
  const shard = Number(process.env.CI_TEST_SHARD)
  if (!Number.isInteger(shard) || shard < 1 || shard > (kind === 'unit' ? 2 : 4)) throw new Error('Invalid test shard')
  const args = kind === 'unit'
    ? ['test:full', '--', `--shard=${shard}/${mode === 'full' ? 2 : 1}`, '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=test-results/vitest.json']
    : ['test:e2e:full', '--', `--shard=${shard}/${mode === 'full' ? 4 : 1}`, '--workers=1']
  // A full run on main speaks for many merges, so a test must fail twice to count.
  // Playwright's own CI retries already do this for the browser tests.
  if (kind === 'unit' && ['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) args.push('--retry=1')
  if (mode === 'essential') args.push(...(kind === 'unit' ? selectedFiles('CI_UNIT_FILES', unitTest) : selectedFiles('CI_BROWSER_FILES', browserSpec)))
  npmRun(args)
}

function changesFromMain() {
  let base
  try {
    base = git('merge-base', 'origin/main', 'HEAD')
  } catch {
    throw new Error('The essential tests are chosen against origin/main, which this checkout cannot reach. Fetch it, name the tests (npm test -- tests/x.test.ts), or run everything (npm run test:full).')
  }
  return [...git('diff', '--name-only', '--no-renames', '-z', base).split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean)
}

// A word after a bare flag may be its value, as in --reporter dot. Taking it for a test
// would run the whole suite; taking a test for a value only adds the essential tests.
const namesTests = args => args.some((arg, index) => !arg.startsWith('-') && !/^-[^=]*$/.test(args[index - 1] ?? ''))

// What npm test and npm run test:e2e run: naming tests means exactly those; flags alone steer the essential run.
function runEssential(kind, args) {
  const script = kind === 'unit' ? 'test:full' : 'test:e2e:full'
  if (namesTests(args)) return npmRun([script, '--', ...args])
  const paths = changesFromMain()
  const files = kind === 'unit' ? essentialUnitTests(paths) : selectBrowserTests(paths, testFiles(browserSpec))
  console.error(`Running the essential ${kind} tests: ${files.length} files. npm run ${script} runs them all.`)
  npmRun([script, '--', ...files, ...args])
}

const isFullRun = run => run.event === 'workflow_dispatch' || (run.event === 'push' && drawsFullRun(run.head_sha))

// Files what a finished full run on main found as one issue, which Poise's chain then fixes.
export async function report() {
  const id = process.env.RUN_ID
  if (!/^\d+$/.test(id ?? '')) throw new Error('Missing RUN_ID')
  const [run, { jobs }] = await Promise.all([github(`actions/runs/${id}`), github(`actions/runs/${id}/jobs?per_page=100`)])
  // Superseded or stopped by hand, so it says nothing about the code. A job that
  // runs out of time is different: its run concludes as failed.
  if (run.conclusion === 'cancelled') return
  // A commit that reused queue evidence skips its tests; only a full run has a second unit shard.
  if (!jobs.some(job => job.name === 'Unit & integration (2)' && job.conclusion !== 'skipped')) return
  const issues = await github('issues?state=open&labels=poise&per_page=100')
  const open = issues.find(issue => issue.title === fullRunIssueTitle && !issue.pull_request)
  if (run.conclusion === 'success') {
    if (!open) return
    // Full runs overlap, and a pass on an older commit says nothing about a newer failure.
    const { workflow_runs: failures } = await github('actions/workflows/ci.yml/runs?branch=main&status=failure&per_page=100')
    const failure = failures.find(isFullRun)
    if (failure && (await github(`compare/${failure.head_sha}...${run.head_sha}`)).status === 'behind') return
    await github(`issues/${open.number}/comments`, { method: 'POST', body: { body: `The full suite passed at ${run.head_sha}: ${run.html_url}\n\nClosing.` } })
    await github(`issues/${open.number}`, { method: 'PATCH', body: { state: 'closed' } })
    return
  }
  const { workflow_runs: passes } = await github('actions/workflows/ci.yml/runs?branch=main&status=success&per_page=100')
  const previous = passes.find(other => other.id !== run.id && isFullRun(other))
  const compared = previous ? await github(`compare/${previous.head_sha}...${run.head_sha}`) : { commits: [] }
  // Nor does a failure on an older commit once a newer one has passed.
  if (compared.status === 'behind') return
  const merged = compared.commits.filter(commit => commit.parents.length > 1).map((commit) => {
    const [subject, title] = commit.commit.message.split('\n').filter(Boolean)
    return `- ${subject.match(/#\d+/)?.[0] ?? commit.sha.slice(0, 8)} ${title ?? subject}`
  })
  const failedJobs = jobs.filter(job => !['success', 'skipped'].includes(job.conclusion)).map(job => job.name)
  const body = failureReport({
    sha: run.head_sha, url: run.html_url, previous: previous?.head_sha, merged,
    jobs: failedJobs.length > 1 ? failedJobs.filter(name => name !== 'Verify (Node 22)') : failedJobs,
    tests: testReports(process.env.REPORTS ?? 'reports'),
  })
  // A comment, not an edit: editing an issue's body re-bases the chain already fixing it.
  if (open) await github(`issues/${open.number}/comments`, { method: 'POST', body: { body } })
  else await github('issues', { method: 'POST', body: { title: fullRunIssueTitle, labels: ['poise'], body } })
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'plan') await plan(args[0])
  else if (command === 'verify') verify(JSON.parse(process.env.RESULTS ?? 'null'))
  else if (['unit', 'browser'].includes(command)) runTests(command)
  else if (command === 'test') runEssential('unit', args)
  else if (command === 'e2e') runEssential('browser', args)
  else if (command === 'report') await report()
  else throw new Error(`Unknown CI command: ${command}`)
}
