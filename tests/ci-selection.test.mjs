import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { browserShards, callerAffected, drawsFullRun, failedTests, failureReport, reusableRun, selectTests, selectUnitTests, verify } from '../.github/workflows/ci.mjs'

const core = ['service-mode', 'ui-frame'].map(name => `tests/e2e/${name}.spec.ts`)
const browsers = [...core, ...['ui-overview', 'ui-settings', 'ui-chat', 'ui-editor-chat', 'ui-article-reviews'].map(name => `tests/e2e/${name}.spec.ts`)]
const select = (paths, event = 'pull_request') => selectTests(event, paths, browsers)
const ciScript = resolve('.github/workflows/ci.mjs')
const notDrawn = '1'.repeat(40)
const drawn = '0'.repeat(40)

describe('what runs every time', () => {
  it('runs everything on main, by hand and when nothing says what changed', () => {
    expect(select(['server/process.ts'], 'push').mode).toBe('full')
    expect(select(['server/process.ts'], 'workflow_dispatch').mode).toBe('full')
    expect(select([]).mode).toBe('full')
    expect(select([], 'merge_group').mode).toBe('full')
  })

  it.each(['pull_request', 'merge_group'])('runs the affected browser area and core journeys on %s', (event) => {
    expect(select(['src/views/editor-view.ts', 'tests/editor-history.test.ts'], event)).toEqual({
      mode: 'essential',
      browserFiles: [...core, 'tests/e2e/ui-editor-chat.spec.ts', 'tests/e2e/ui-article-reviews.spec.ts'].sort(),
    })
    expect(select(['src/analytics-history.ts', 'src/settings-save.ts'], event).browserFiles)
      .toEqual(expect.arrayContaining(['tests/e2e/ui-overview.spec.ts', 'tests/e2e/ui-settings.spec.ts']))
  })

  it("runs a place's own specs when the new interface's place changes, and only the core journeys for its frame", () => {
    const places = ['ui-board', 'ui-chat', 'ui-chat-queue', 'ui-editor-chat', 'ui-article-reviews', 'ui-overview', 'ui-observe', 'ui-settings'].map(name => `tests/e2e/${name}.spec.ts`)
    const run = path => selectTests('pull_request', [path], [...browsers, ...places]).browserFiles.filter(file => !core.includes(file)).map(file => file.slice(10, -8))
    expect(run('src/ui/places/chat/view.ts')).toEqual(['ui-chat-queue', 'ui-chat'])
    expect(run('src/ui/places/manager.ts')).toEqual(['ui-chat-queue', 'ui-chat'])
    expect(run('src/ui/places/editor/classic.css')).toEqual(['ui-article-reviews', 'ui-editor-chat'])
    expect(run('src/ui/places/board.css')).toEqual(['ui-board'])
    expect(run('src/ui/places/overview/tiles.ts')).toEqual(['ui-overview'])
    expect(run('src/ui/places/observe.ts')).toEqual(['ui-observe'])
    expect(run('src/ui/places/settings/rows.ts')).toEqual(['ui-settings'])
    expect(run('src/ui/setup/onboarding.ts')).toEqual(['ui-settings'])
    expect(run('src/ui/shell.ts')).toEqual([])
  })

  it('splits selected browser tests into shards of about 80, up to a full run', () => {
    const tests = count => '\n'.repeat(2) + "test('x', () => {})\n  test('y', () => {})\n".repeat(count / 2)
    expect(browserShards([], () => '')).toEqual([1])
    expect(browserShards(['a', 'b'], file => tests(file === 'a' ? 40 : 40))).toEqual([1])
    expect(browserShards(['a', 'b'], file => tests(file === 'a' ? 80 : 2))).toEqual([1, 2])
    expect(browserShards(['a'], () => `${tests(160)}test.describe('d', () => {})\n// test(\n`)).toEqual([1, 2])
    expect(browserShards(['a'], () => tests(2000))).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('includes edited browser regressions alongside the core journeys', () => {
    expect(select(['tests/e2e/ui-overview.spec.ts']).browserFiles).toEqual([...core, 'tests/e2e/ui-overview.spec.ts'].sort())
  })

  it.each(['server/process.ts', 'server/gone.ts', 'scripts/build-server.mjs', 'src/ui/tokens.css', 'src/http.ts', 'src/ui/main.ts', 'tests/fixtures/accounts.ts', 'caller/agent_interface/agent_interface/__init__.py', 'gateway/src/main.ts', 'new-root-config.json'])
  ('runs only the core journeys for code outside a browser area: %s', (path) => {
    for (const event of ['pull_request', 'merge_group']) expect(select([path], event)).toEqual({ mode: 'essential', browserFiles: core })
  })

  it.each(['package.json', 'package-lock.json', '.node-version', 'vitest.config.ts', 'playwright.config.ts', 'vite.config.ts', 'tsconfig.server.json',
    'tests/essential.txt', 'tests/e2e/fixtures/chat.ts', 'tests/home-isolation.ts', '.github/workflows/ci.mjs', '.github/workflows/ci.yml'])
  ('runs everything when what every test proves can change: %s', (path) => {
    for (const event of ['pull_request', 'merge_group']) expect(select([path, 'server/process.ts'], event).mode).toBe('full')
  })

  it('skips application work only for documentation-only changes', () => {
    for (const event of ['pull_request', 'merge_group']) {
      expect(select(['README.md', 'docs/Testing.md'], event).mode).toBe('none')
      expect(select(['README.md', 'server/process.ts'], event).mode).toBe('essential')
    }
  })

  it('fails rather than silently dropping missing smoke or feature coverage', () => {
    expect(() => selectTests('pull_request', ['src/views/editor-view.ts'], browsers.filter(file => !/editor|article-reviews/.test(file)))).toThrow('No browser coverage')
    expect(() => selectTests('pull_request', ['tests/analytics.test.ts'], [])).toThrow('Missing core')
  })

  it.each([
    ['src/chat-client.ts', 'ui-chat'],
    ['src/views/connected-accounts.ts', 'ui-settings'],
    ['src/settings-save.ts', 'ui-settings'],
    ['src/analytics-history.ts', 'ui-overview'],
    ['src/views/editor-view.ts', 'ui-editor-chat'],
    ['src/views/snippets-view.ts', 'ui-settings'],
    ['src/notification-items.ts', 'ui-overview'],
    ['src/views/notification-rail.ts', 'ui-overview'],
    ['src/motion.ts', 'ui-frame'],
  ])('selects surviving browser coverage for shared code: %s', (path, suite) => {
    const files = readdirSync('tests/e2e').filter(file => file.endsWith('.spec.ts')).map(file => `tests/e2e/${file}`)
    for (const event of ['pull_request', 'merge_group']) {
      expect(selectTests(event, [path], files)).toEqual({
        mode: 'essential', browserFiles: expect.arrayContaining([...core, `tests/e2e/${suite}.spec.ts`]),
      })
    }
  })

  it('does not run Caller on frontend-only PRs, but retains shared and unknown coverage', () => {
    expect(callerAffected(['src/views/chat-composer.ts', 'tests/e2e/ui-chat.spec.ts', 'docs/Testing.md'])).toBe(false)
    for (const path of ['caller/agent_interface/agent_interface/__init__.py', 'server/process.ts', 'package-lock.json', 'tests/chat/checkout-lock.test.ts', '.github/workflows/ci.mjs', 'new-config']) {
      expect(callerAffected([path]), path).toBe(true)
    }
    expect(callerAffected([])).toBe(true)
  })
})

describe('essential application tests', () => {
  const sources = {
    'tests/guard.test.ts': "import { other } from './helper.js'",
    'tests/static.test.ts': "import { x } from '../server/x.js'",
    'tests/chat/nested.test.mjs': "import { x } from '../../server/x.ts'",
    'tests/dynamic.test.ts': "const y = await import('../server/y')",
    'tests/requery.test.ts': 'const y = await import(`../server/q.js?case=${n}`)',
    'tests/mocked.test.ts': "vi.mock('../server/z.js', () => ({}))",
    'tests/actual.test.ts': "const a = await vi.importActual<typeof import('x')>('../server/a.js')",
    'tests/index.test.ts': "import { c } from '../server/chat/index.js'",
    'tests/fixture.test.ts': "import { f } from './fixtures/f.js'",
    'tests/package.test.ts': "import { x } from 'server/x'",
    'tests/unlinked.test.ts': "import { o } from '../server/other.js'",
    'tests/edited.test.ts': '',
  }
  const pick = (paths, essential = ['tests/guard.test.ts']) => selectUnitTests(paths, Object.keys(sources), essential, file => sources[file])

  it('always runs the list', () => {
    expect(pick([])).toEqual(['tests/guard.test.ts'])
  })

  it('adds the tests a change edits', () => {
    expect(pick(['tests/edited.test.ts', 'docs/Testing.md'])).toEqual(['tests/edited.test.ts', 'tests/guard.test.ts'])
  })

  it.each([
    ['server/x.ts', ['tests/chat/nested.test.mjs', 'tests/static.test.ts']],
    ['server/y.ts', ['tests/dynamic.test.ts']],
    ['server/q.ts', ['tests/requery.test.ts']],
    ['server/z.ts', ['tests/mocked.test.ts']],
    ['server/a.ts', ['tests/actual.test.ts']],
    ['server/chat/index.ts', ['tests/index.test.ts']],
    ['tests/fixtures/f.ts', ['tests/fixture.test.ts']],
  ])('adds the tests that directly import %s', (path, tests) => {
    expect(pick([path])).toEqual(['tests/guard.test.ts', ...tests].sort())
  })

  it('leaves out tests linked only through another file', () => {
    expect(pick(['tests/helper.ts'])).toEqual(['tests/guard.test.ts'])
    expect(pick(['server/untested.ts'])).toEqual(['tests/guard.test.ts'])
  })

  it('fails naming a listed test that no longer exists', () => {
    expect(() => pick([], ['tests/renamed.test.ts'])).toThrow('tests/essential.txt names tests that do not exist: tests/renamed.test.ts')
  })

  it('lists real, distinct tests that guard security, agent spend, data loss and release safety', () => {
    const listed = readFileSync('tests/essential.txt', 'utf8').split('\n').filter(line => line && !line.startsWith('#'))
    expect(new Set(listed).size).toBe(listed.length)
    for (const file of listed) {
      expect(file).toMatch(/^tests\/.+\.test\.(?:ts|mjs)$/)
      expect(existsSync(file), file).toBe(true)
    }
    expect(listed).toEqual(expect.arrayContaining(['tests/service-identity.test.ts', 'tests/terminal.test.ts', 'tests/behaviors-quota-budget.test.ts',
      'tests/behaviors-merge.test.ts', 'tests/storage-maintenance.test.ts', 'tests/chat-legacy-import.test.ts', 'tests/ci-selection.test.mjs', 'tests/self-update-policy.test.mjs']))
  })
})

describe('the full-run draw', () => {
  it('draws about one merge in ten, and the same answer on a rerun', () => {
    const shas = Array.from({ length: 5000 }, (_, n) => createHash('sha1').update(String(n)).digest('hex'))
    const share = shas.filter(drawsFullRun).length / shas.length
    expect(share).toBeGreaterThan(0.085)
    expect(share).toBeLessThan(0.115)
    expect(shas.filter(drawsFullRun)).toEqual(shas.filter(drawsFullRun))
    expect(drawsFullRun(drawn)).toBe(true)
    expect(drawsFullRun(notDrawn)).toBe(false)
  })
})

const identity = { repository: 'autonomio/poise', sha: 'a'.repeat(40), workflow: 'ci.yml' }
const success = {
  id: 10, event: 'merge_group', head_sha: identity.sha, path: '.github/workflows/ci.yml',
  head_repository: { full_name: identity.repository }, head_branch: 'gh-readonly-queue/main/pr-1-a',
  status: 'completed', conclusion: 'success', html_url: 'https://github.com/autonomio/poise/actions/runs/10',
}

describe('exact-commit queue evidence', () => {
  it('reuses only a completed successful trusted integration run', () => {
    expect(reusableRun([success], identity)).toBe(success)
    expect(reusableRun([], identity)).toBeNull()
  })

  it.each([
    { head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { event: 'push' },
    { head_repository: { full_name: 'fork/poise' } }, { head_branch: 'main' },
    { path: '.github/workflows/other.yml' }, { status: 'in_progress' },
    { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' },
  ])('refuses mismatched or incomplete evidence: %j', (change) => {
    expect(reusableRun([{ ...success, ...change }], identity)).toBeNull()
  })

  it('does not fall back to an old success after a later failure or unfinished run', () => {
    expect(reusableRun([success, { ...success, id: 11, conclusion: 'failure' }], identity)).toBeNull()
    expect(reusableRun([success, { ...success, id: 11, status: 'in_progress' }], identity)).toBeNull()
  })
})

function gates(mode, result) {
  return {
    plan: { result: 'success', outputs: { mode, reuse_url: mode === 'reuse' ? success.html_url : '' } },
    ...Object.fromEntries(['static', 'build', 'unit', 'browser'].map(name => [name, { result }])),
  }
}

describe('required aggregate', () => {
  it('accepts complete selected gates or explicit planned omissions', () => {
    for (const mode of ['full', 'essential']) expect(() => verify(gates(mode, 'success'))).not.toThrow()
    for (const mode of ['none', 'reuse']) expect(() => verify(gates(mode, 'skipped'))).not.toThrow()
  })

  it('rejects skipped, failed, cancelled or missing required jobs', () => {
    for (const result of ['skipped', 'failure', 'cancelled', undefined]) {
      expect(() => verify({ ...gates('full', 'success'), browser: { result } })).toThrow('browser')
    }
    expect(() => verify({ ...gates('none', 'skipped'), plan: { result: 'failure' } })).toThrow('plan')
    expect(() => verify(gates('invented', 'skipped'))).toThrow('Unknown')
    const reuse = gates('reuse', 'skipped')
    reuse.plan.outputs.reuse_url = ''
    expect(() => verify(reuse)).toThrow('evidence')
  })

  it('keeps the application contracts and pinned isolated browser workers', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
    const caller = parse(readFileSync('.github/workflows/caller.yml', 'utf8'))
    expect(ci.jobs.verify.name).toBe('Verify (Node 22)')
    expect(caller.jobs.caller.name).toBe('Caller (Python 3.13)')
    expect(ci.on.merge_group.types).toContain('checks_requested')
    expect(caller.on.merge_group.types).toContain('checks_requested')
    expect(ci.on.push.branches).toContain('main')
    expect(caller.on.push.branches).toContain('main')
    expect(ci.jobs.verify.if).toContain('always()')
    expect(ci.jobs.verify.needs).toEqual(['plan', 'static', 'build', 'unit', 'browser'])
    expect(ci.jobs.browser.container.image).toBe('${{ needs.plan.outputs.browser_image }}')
    expect(JSON.stringify(ci.jobs.browser.steps)).not.toContain('playwright install')
    expect(readFileSync('.github/workflows/ci.mjs', 'utf8')).toContain("'--workers=1'")
    expect(ci.permissions.actions).toBe('read')
  })
})

describe('how CI and the commands reach the choice', () => {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
  const step = (job, name) => ci.jobs[job].steps.find(candidate => candidate.name === name || candidate.id === name)

  it('hands the plan the base of a PR or queue candidate, and its choice to the tests', () => {
    for (const expression of ['github.event.pull_request.base.sha', 'github.event.merge_group.base_sha']) {
      expect(step('plan', 'Fetch comparison base').env.BASE).toContain(expression)
      expect(step('plan', 'plan').env.BASE).toContain(expression)
    }
    expect(step('plan', 'Fetch comparison base').if).toContain("'merge_group'")
    expect(ci.jobs.plan.outputs.unit_files).toContain('steps.plan.outputs.unit_files')
    expect(step('unit', 'Run unit and integration shard with timings').env.CI_UNIT_FILES).toContain('needs.plan.outputs.unit_files')
    expect(step('browser', 'Run browser shard against the production build').env).toMatchObject({
      CI_TEST_SHARD: '${{ matrix.shard }}', CI_TEST_SHARDS: '${{ strategy.job-total }}' })
  })

  it('never lets a merge cancel a full run here, and leaves a fork superseding its pushes', () => {
    expect(ci.concurrency.group).toContain("github.repository == 'autonomio/poise' && github.event_name == 'push' && github.sha || github.event_name")
  })

  it('paces automatic fork updates through verification and a serialized Deploy attempt', () => {
    const sync = parse(readFileSync('.github/workflows/sync-upstream.yml', 'utf8'))
    const deploy = parse(readFileSync('.github/workflows/deploy.yml', 'utf8'))
    const steps = sync.jobs.sync.steps
    const gate = steps.find(candidate => candidate.id === 'gate')
    const merge = steps.find(candidate => candidate.name === "Merge autonomio/poise's main into main")
    expect(gate.if).toBe("vars.POISE_DEPLOY_HOST != ''")
    expect(gate.run).toBe('deploy/actions/sync-gate.sh')
    expect(gate.env.GH_TOKEN).toBe('${{ github.token }}')
    expect(gate.env.REPO).toBe('${{ github.repository }}')
    expect(gate.env.SUCCESSFUL_DEPLOY_RUN_ID).toBe("${{ github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.id || '' }}")
    expect(sync.jobs.sync.if).toMatch(/^vars\.POISE_UPSTREAM_SYNC == 'true' \|\|/)
    expect(steps.indexOf(gate)).toBeLessThan(steps.indexOf(merge))
    expect(merge.if).toBe("vars.POISE_UPSTREAM_SYNC == 'true' && (vars.POISE_DEPLOY_HOST == '' || steps.gate.outputs.proceed == 'true')")
    expect(sync.concurrency).toEqual({ group: 'sync-upstream', 'cancel-in-progress': false })
    expect(deploy.concurrency).toEqual({ group: 'deploy', 'cancel-in-progress': false })
  })

  it('can run in full by hand, without a base to audit against', () => {
    expect(ci.on).toHaveProperty('workflow_dispatch')
    expect(step('static', 'deps').if).toBe("github.event_name != 'workflow_dispatch'")
  })

  it('starts one full run a night and reports only trusted full runs on main', () => {
    const full = parse(readFileSync('.github/workflows/full-suite.yml', 'utf8'))
    expect(full.on.schedule).toHaveLength(1)
    expect(full.on.workflow_run).toEqual({ workflows: ['CI'], types: ['completed'], branches: ['main'] })
    expect(full.permissions).toEqual({})
    expect(full.jobs.nightly.if).toContain("github.repository == 'autonomio/poise'")
    expect(full.jobs.nightly.steps[0].run).toContain('gh workflow run ci.yml')
    expect(full.jobs.nightly.steps[0].run).toContain('--ref main')
    expect(full.jobs.report.if).toContain("github.repository == 'autonomio/poise'")
    expect(full.jobs.report.if).toContain('github.event.workflow_run.head_repository.full_name == github.repository')
    expect(full.jobs.report.if).toContain("github.event.workflow_run.event == 'push'")
    expect(full.jobs.report.if).toContain("github.event.workflow_run.event == 'workflow_dispatch'")
    expect(full.jobs.report.if).not.toContain('pull_request')
    expect(full.jobs.report.permissions.issues).toBe('write')
    expect(full.jobs.report.steps.at(-1).run).toBe('node .github/workflows/ci.mjs report')
    // What report() takes for the mark of a full run.
    expect(ci.jobs.unit.name).toBe('Unit & integration (${{ matrix.shard }})')
  })

  it('does not wake a fork\'s deploy with the report', () => {
    expect(parse(readFileSync('.github/workflows/deploy.yml', 'utf8')).on.workflow_run.workflows).toEqual(['CI', 'Caller'])
  })

  it('makes the everyday commands the essential run', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(scripts.test).toBe('node .github/workflows/ci.mjs test')
    expect(scripts['test:full']).toBe('vitest run')
    expect(scripts['test:e2e']).toBe('node .github/workflows/ci.mjs e2e')
    expect(scripts['test:e2e:full']).toContain('with-e2e-lock')
    expect(scripts.check).toContain('npm test')
    expect(scripts.verify).toContain('npm run test:e2e')
  })
})

const roots = []
const servers = []
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))))
})

function tempRoot(owner = roots) {
  const root = mkdtempSync(join(tmpdir(), 'poise-ci-'))
  owner.push(root)
  return root
}

function write(root, path, text = '') {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

// A checkout with one commit on main and one change on top of it.
function checkout(owner = roots) {
  const root = tempRoot(owner)
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'CI test')
  git('config', 'user.email', 'ci@example.invalid')
  write(root, 'package-lock.json', JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '1.2.3' } } }))
  write(root, 'tests/essential.txt', '# Comment\n\ntests/guard.test.ts\n')
  for (const file of core) write(root, file)
  write(root, 'tests/e2e/notices.spec.ts')
  write(root, 'tests/guard.test.ts')
  write(root, 'tests/linked.test.ts', "import { thing } from '../server/thing.js'\n")
  write(root, 'tests/other.test.ts', "import { other } from '../server/other.js'\n")
  write(root, 'server/thing.ts', 'export const thing = 1\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', base)
  git('checkout', '-qb', 'change')
  write(root, 'server/thing.ts', 'export const thing = 2\n')
  git('commit', '-qam', 'change')
  return { root, base, git }
}

// One checkout for the many cases that only read it.
function sharedCheckout() {
  const owned = []
  const shared = {}
  beforeAll(() => { Object.assign(shared, checkout(owned)) })
  afterAll(() => { for (const root of owned) rmSync(root, { recursive: true, force: true }) })
  return shared
}

const exec = promisify(execFile)
async function ci(root, args, env = {}, { path = process.env.PATH } = {}) {
  const outputFile = join(tempRoot(), 'output')
  // CI runs these tests with its own settings for this very script.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:GITHUB_|CI_|BASE$|REPORTS$|RUN_ID$)/.test(name)))
  const result = await exec(process.execPath, [ciScript, ...args], {
    cwd: root, encoding: 'utf8', env: { ...inherited, PATH: path, GITHUB_OUTPUT: outputFile, ...env },
  }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
  const outputs = existsSync(outputFile) ? Object.fromEntries(readFileSync(outputFile, 'utf8').trim().split('\n').map((line) => {
    const at = line.indexOf('=')
    const value = line.slice(at + 1)
    return [line.slice(0, at), /^(?:\[|\{|true$|false$)/.test(value) ? JSON.parse(value) : value]
  })) : {}
  return { ...result, outputs }
}

// A stand-in for GitHub's REST API that records what it is asked.
async function github(routes) {
  const requests = []
  const server = createServer((request, response) => {
    let text = ''
    request.on('data', chunk => { text += chunk })
    request.on('end', () => {
      const url = request.url.replace(/^\/repos\/[^/]+\/[^/]+\//, '')
      requests.push({ method: request.method, url, body: text ? JSON.parse(text) : undefined, auth: request.headers.authorization })
      const route = Object.keys(routes).find(key => `${request.method} ${url}`.startsWith(key))
      response.statusCode = route ? 200 : 404
      response.end(JSON.stringify(route ? routes[route] : { message: `no route for ${request.method} ${url}` }))
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  servers.push(server)
  return { requests, writes: () => requests.filter(item => item.method !== 'GET'), env: { GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: 'autonomio/poise', GITHUB_TOKEN: 'test-token' } }
}

describe('the plan each CI event gets', () => {
  const repo = sharedCheckout()

  it.each(['pull_request', 'merge_group'])('chooses the essential tests for %s against the base it is given', async (event) => {
    const { code, outputs, stderr } = await ci(repo.root, ['plan', 'ci.yml'], { GITHUB_EVENT_NAME: event, BASE: repo.base })
    expect(code, stderr).toBe(0)
    expect(outputs.mode).toBe('essential')
    expect(outputs.unit_files).toEqual(['tests/guard.test.ts', 'tests/linked.test.ts'])
    expect(outputs.browser_files).toEqual(core)
    expect(outputs.unit_shards).toEqual([1])
    expect(outputs.browser_shards).toEqual([1])
    expect(outputs.browser_image).toBe('mcr.microsoft.com/playwright:v1.2.3-noble')
  })

  it('fails naming a missing comparison base', async () => {
    const { code, stderr } = await ci(repo.root, ['plan', 'ci.yml'], { GITHUB_EVENT_NAME: 'merge_group' })
    expect(code).not.toBe(0)
    expect(stderr).toContain('Missing comparison base SHA')
  })

  it('still runs every Caller test in the queue, needing no base', async () => {
    const { code, outputs } = await ci(repo.root, ['plan', 'caller.yml'], { GITHUB_EVENT_NAME: 'merge_group' })
    expect(code).toBe(0)
    expect(outputs.run).toBe(true)
    expect(outputs.unit_files).toEqual([])
  })

  it('runs everything by hand', async () => {
    const { code, outputs } = await ci(repo.root, ['plan', 'ci.yml'], { GITHUB_EVENT_NAME: 'workflow_dispatch' })
    expect(code).toBe(0)
    expect(outputs).toMatchObject({ mode: 'full', unit_shards: [1, 2], browser_shards: [1, 2, 3, 4, 5, 6], unit_files: [] })
  })

  const evidence = sha => ({ workflow_runs: [{ ...success, head_sha: sha }] })

  it('reuses the queue evidence of a commit that did not draw the full run', async () => {
    const api = await github({ 'GET actions/workflows/ci.yml/runs': evidence(notDrawn) })
    const { code, outputs } = await ci(repo.root, ['plan', 'ci.yml'], { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: notDrawn, ...api.env })
    expect(code).toBe(0)
    expect(outputs).toMatchObject({ mode: 'reuse', reuse_url: success.html_url })
    expect(api.requests[0].auth).toBe('Bearer test-token')
  })

  it('runs everything on a commit that drew the full run, whatever evidence it has', async () => {
    const api = await github({ 'GET actions/workflows/ci.yml/runs': evidence(drawn) })
    const { code, outputs } = await ci(repo.root, ['plan', 'ci.yml'], { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: drawn, ...api.env })
    expect(code).toBe(0)
    expect(outputs).toMatchObject({ mode: 'full', unit_shards: [1, 2], browser_shards: [1, 2, 3, 4, 5, 6] })
    expect(api.requests).toEqual([])
  })

  it('keeps Caller reusing queue evidence on a commit that drew the full run', async () => {
    const api = await github({ 'GET actions/workflows/caller.yml/runs': { workflow_runs: [{ ...success, head_sha: drawn, path: '.github/workflows/caller.yml' }] } })
    const { code, outputs } = await ci(repo.root, ['plan', 'caller.yml'], { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: drawn, ...api.env })
    expect(code).toBe(0)
    expect(outputs).toMatchObject({ mode: 'reuse', run: false })
  })

  it('runs everything on a fork\'s push, which has no queue evidence', async () => {
    const api = await github({ 'GET actions/workflows/ci.yml/runs': { workflow_runs: [] } })
    const { code, outputs } = await ci(repo.root, ['plan', 'ci.yml'], { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: notDrawn, ...api.env, GITHUB_REPOSITORY: 'Vaquum/poise' })
    expect(code).toBe(0)
    expect(outputs.mode).toBe('full')
  })
})

describe('the commands that run the tests', () => {
  const repo = sharedCheckout()

  // An npm that records what it was asked and exits as told.
  function fakeNpm(exit = 0) {
    const bin = tempRoot()
    const log = join(bin, 'calls')
    write(bin, 'npm', `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit ${exit}\n`)
    chmodSync(join(bin, 'npm'), 0o755)
    return { path: `${bin}${delimiter}${process.env.PATH}`, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) }
  }

  it('runs the list and what the change touches, uncommitted and untracked work included', async () => {
    const { root } = checkout()
    write(root, 'server/other.ts', 'export const other = 1\n')
    write(root, 'tests/new.test.ts')
    const npm = fakeNpm()
    const { code, stderr } = await ci(root, ['test'], {}, { path: npm.path })
    expect(code).toBe(0)
    expect(npm.calls()).toEqual(['run test:full -- tests/guard.test.ts tests/linked.test.ts tests/new.test.ts tests/other.test.ts'])
    expect(stderr).toContain('npm run test:full runs them all')
  })

  it('counts only the branch’s own work while main is being merged into it', async () => {
    const { root, base, git } = checkout()
    git('checkout', '-q', '--detach', base)
    write(root, 'server/other.ts', 'export const other = 1\n')
    git('add', '.')
    git('commit', '-qm', 'on main')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('checkout', '-q', 'change')
    git('merge', '-q', '--no-commit', '--no-ff', 'origin/main')
    const npm = fakeNpm()
    const { code, stderr } = await ci(root, ['test'], {}, { path: npm.path })
    expect(code, stderr).toBe(0)
    expect(npm.calls()).toEqual(['run test:full -- tests/guard.test.ts tests/linked.test.ts'])
  })

  it('still counts what a branch shares with its own remote while merging that', async () => {
    const { root, git } = checkout()
    write(root, 'server/other.ts', 'export const other = 1\n')
    git('add', '.')
    git('commit', '-qm', 'pushed from elsewhere')
    git('update-ref', 'refs/remotes/origin/change', 'HEAD')
    git('reset', '-q', '--hard', 'HEAD~1')
    write(root, 'tests/guard.test.ts', '// edited here\n')
    git('commit', '-qam', 'edited here')
    git('merge', '-q', '--no-commit', '--no-ff', 'origin/change')
    const npm = fakeNpm()
    const { code, stderr } = await ci(root, ['test'], {}, { path: npm.path })
    expect(code, stderr).toBe(0)
    expect(npm.calls()).toEqual(['run test:full -- tests/guard.test.ts tests/linked.test.ts tests/other.test.ts'])
  })

  it('still counts a branch being merged into main', async () => {
    const { root, git } = checkout()
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-commit', '--no-ff', 'change')
    const npm = fakeNpm()
    const { code, stderr } = await ci(root, ['test'], {}, { path: npm.path })
    expect(code, stderr).toBe(0)
    expect(npm.calls()).toEqual(['run test:full -- tests/guard.test.ts tests/linked.test.ts'])
  })

  it('treats flags alone as steering the essential run', async () => {
    const npm = fakeNpm()
    await ci(repo.root, ['test', '--reporter=dot'], {}, { path: npm.path })
    expect(npm.calls()).toEqual(['run test:full -- tests/guard.test.ts tests/linked.test.ts --reporter=dot'])
  })

  it.each([
    ['test', ['--reporter', 'dot'], 'test:full', ['tests/guard.test.ts', 'tests/linked.test.ts']],
    ['test', ['-t', 'a name'], 'test:full', ['tests/guard.test.ts', 'tests/linked.test.ts']],
    ['e2e', ['--workers', '1'], 'test:e2e:full', core],
  ])('takes the word after a bare flag for its value in %s %j, not for a test', async (command, flags, script, files) => {
    const npm = fakeNpm()
    await ci(repo.root, [command, ...flags], {}, { path: npm.path })
    expect(npm.calls()).toEqual([`run ${script} -- ${[...files, ...flags].join(' ')}`])
  })

  it('still sees a test named around a flag and its value', async () => {
    const npm = fakeNpm()
    await ci(repo.root, ['test', '--reporter', 'dot', 'tests/other.test.ts'], {}, { path: npm.path })
    await ci(repo.root, ['test', 'tests/other.test.ts', '--reporter', 'dot'], {}, { path: npm.path })
    await ci(repo.root, ['test', '--reporter=dot', 'tests/other.test.ts'], {}, { path: npm.path })
    expect(npm.calls()).toEqual([
      'run test:full -- --reporter dot tests/other.test.ts',
      'run test:full -- tests/other.test.ts --reporter dot',
      'run test:full -- --reporter=dot tests/other.test.ts',
    ])
  })

  it('runs exactly the tests a command names', async () => {
    const npm = fakeNpm()
    await ci(repo.root, ['test', 'tests/other.test.ts', '--reporter=dot'], {}, { path: npm.path })
    await ci(repo.root, ['e2e', 'tests/e2e/notices.spec.ts', '--workers=1'], {}, { path: npm.path })
    expect(npm.calls()).toEqual(['run test:full -- tests/other.test.ts --reporter=dot', 'run test:e2e:full -- tests/e2e/notices.spec.ts --workers=1'])
  })

  it('runs the core journeys and edited specs in the browser', async () => {
    const { root } = checkout()
    write(root, 'tests/e2e/notices.spec.ts', '// edited\n')
    const npm = fakeNpm()
    await ci(root, ['e2e'], {}, { path: npm.path })
    expect(npm.calls()).toEqual([`run test:e2e:full -- ${[...core, 'tests/e2e/notices.spec.ts'].sort().join(' ')}`])
  })

  it('passes on a failing exit code', async () => {
    const npm = fakeNpm(3)
    expect((await ci(repo.root, ['test'], {}, { path: npm.path })).code).toBe(3)
  })

  it('fails without running anything when it cannot tell what changed', async () => {
    const { root, git } = checkout()
    git('update-ref', '-d', 'refs/remotes/origin/main')
    const npm = fakeNpm()
    const { code, stderr } = await ci(root, ['test'], {}, { path: npm.path })
    expect(code).not.toBe(0)
    expect(stderr).toContain('origin/main')
    expect(npm.calls()).toEqual([])
  })

  it('runs the planned files in CI, with a retry only on main', async () => {
    const npm = fakeNpm()
    const shard = { CI_TEST_SHARD: '1' }
    await ci(repo.root, ['unit'], { ...shard, GITHUB_EVENT_NAME: 'pull_request', CI_TEST_MODE: 'essential', CI_UNIT_FILES: '["tests/guard.test.ts"]' }, { path: npm.path })
    await ci(repo.root, ['unit'], { ...shard, GITHUB_EVENT_NAME: 'pull_request', CI_TEST_MODE: 'full' }, { path: npm.path })
    await ci(repo.root, ['unit'], { ...shard, GITHUB_EVENT_NAME: 'push', CI_TEST_MODE: 'full' }, { path: npm.path })
    await ci(repo.root, ['unit'], { ...shard, GITHUB_EVENT_NAME: 'workflow_dispatch', CI_TEST_MODE: 'full' }, { path: npm.path })
    await ci(repo.root, ['browser'], { ...shard, GITHUB_EVENT_NAME: 'push', CI_TEST_MODE: 'full' }, { path: npm.path })
    await ci(repo.root, ['browser'], { ...shard, GITHUB_EVENT_NAME: 'merge_group', CI_TEST_MODE: 'essential', CI_BROWSER_FILES: JSON.stringify(core) }, { path: npm.path })
    await ci(repo.root, ['browser'], { CI_TEST_SHARD: '2', CI_TEST_SHARDS: '3', GITHUB_EVENT_NAME: 'pull_request', CI_TEST_MODE: 'essential', CI_BROWSER_FILES: JSON.stringify(core) }, { path: npm.path })
    const reporters = '--maxWorkers=1 --reporter=default --reporter=json --outputFile=test-results/vitest.json'
    expect(npm.calls()).toEqual([
      `run test:full -- --shard=1/1 ${reporters} tests/guard.test.ts`,
      `run test:full -- --shard=1/2 ${reporters}`,
      `run test:full -- --shard=1/2 ${reporters} --retry=1`,
      `run test:full -- --shard=1/2 ${reporters} --retry=1`,
      'run test:e2e:full -- --shard=1/6 --workers=1',
      `run test:e2e:full -- --shard=1/1 --workers=1 ${core.join(' ')}`,
      `run test:e2e:full -- --shard=2/3 --workers=1 ${core.join(' ')}`,
    ])
  })

  it('refuses a browser shard outside its run', async () => {
    const npm = fakeNpm()
    for (const [shard, shards] of [['3', '2'], ['1', '7'], ['1', 'x']]) {
      const { code } = await ci(repo.root, ['browser'], { CI_TEST_SHARD: shard, CI_TEST_SHARDS: shards, GITHUB_EVENT_NAME: 'pull_request', CI_TEST_MODE: 'essential', CI_BROWSER_FILES: JSON.stringify(core) }, { path: npm.path })
      expect(code, `${shard}/${shards}`).not.toBe(0)
    }
    expect(npm.calls()).toEqual([])
  })

  it('refuses a planned file list it cannot trust', async () => {
    const npm = fakeNpm()
    for (const files of ['[]', '["../outside.test.ts"]', 'not json']) {
      const { code } = await ci(repo.root, ['unit'], { CI_TEST_SHARD: '1', GITHUB_EVENT_NAME: 'pull_request', CI_TEST_MODE: 'essential', CI_UNIT_FILES: files }, { path: npm.path })
      expect(code, files).not.toBe(0)
    }
    expect(npm.calls()).toEqual([])
  })
})

describe('what a full run on main reports', () => {
  const unit = conclusion => ({ name: 'Unit & integration (2)', conclusion })
  const failedRun = { id: 7, conclusion: 'failure', head_sha: 'f'.repeat(40), html_url: 'https://github.test/runs/7' }
  const passedRun = { ...failedRun, conclusion: 'success' }
  const earlier = [{ id: 7, event: 'push', head_sha: drawn }, { id: 6, event: 'push', head_sha: notDrawn }, { id: 5, event: 'push', head_sha: drawn }]
  const merge = (number, title) => ({ sha: `${number}`.repeat(8), parents: [{}, {}], commit: { message: `Merge pull request #${number} from autonomio/x\n\n${title}` } })
  const openIssue = { number: 42, title: 'fix: the full test suite fails on main' }
  const routes = (run, jobs, issues = []) => ({
    'GET actions/runs/7/jobs': { jobs },
    'GET actions/runs/7': run,
    'GET issues': issues,
    'GET actions/workflows/ci.yml/runs': { workflow_runs: earlier },
    'GET compare/': { commits: [merge(11, 'fix: one'), { sha: 'aaaaaaaa', parents: [{}], commit: { message: 'fix: a branch commit' } }, merge(12, 'feat: two')] },
    'POST issues': { number: 43 },
    'PATCH issues/42': {},
  })
  const failingJobs = [unit('failure'), { name: 'Unit & integration (1)', conclusion: 'success' }, { name: 'Browser Chromium (1)', conclusion: 'cancelled' }, { name: 'Lint', conclusion: 'skipped' }, { name: 'Verify (Node 22)', conclusion: 'failure' }]

  function reports() {
    const folder = tempRoot()
    write(folder, 'unit-timings-2/vitest.json', JSON.stringify({ testResults: [
      { name: '/home/runner/work/poise/poise/tests/a.test.ts', status: 'failed', assertionResults: [{ status: 'failed', fullName: 'a breaks' }, { status: 'passed', fullName: 'a works' }] },
      { name: '/home/runner/work/poise/poise/tests/passed.test.ts', status: 'passed', assertionResults: [{ status: 'passed', fullName: 'fine' }] },
    ] }))
    write(folder, 'browser-report-1/test-results/playwright.json', JSON.stringify({ suites: [
      { file: 'b.spec.ts', specs: [{ file: 'b.spec.ts', title: 'b breaks', ok: false }, { file: 'b.spec.ts', title: 'b works', ok: true }], suites: [{ specs: [{ file: 'b.spec.ts', title: 'b nested', ok: false }] }] },
    ] }))
    write(folder, 'production-build/index.html', '<html>')
    return folder
  }

  async function report(api, reportFolder = reports()) {
    return ci(tempRoot(), ['report'], { ...api.env, RUN_ID: '7', REPORTS: reportFolder })
  }

  it('files one poise issue naming the failed tests, jobs and what merged since the last full run that passed', async () => {
    const api = await github(routes(failedRun, failingJobs))
    const { code, stderr } = await report(api)
    expect(code, stderr).toBe(0)
    expect(api.writes()).toHaveLength(1)
    const [{ url, body }] = api.writes()
    expect(url).toBe('issues')
    expect(body.title).toBe('fix: the full test suite fails on main')
    expect(body.labels).toEqual(['poise'])
    expect(body.body).toContain(`at ${failedRun.head_sha}: ${failedRun.html_url}`)
    expect(body.body).toContain('- tests/a.test.ts > a breaks')
    expect(body.body).toContain('- tests/e2e/b.spec.ts > b breaks')
    expect(body.body).toContain('- tests/e2e/b.spec.ts > b nested')
    expect(body.body).not.toContain('works')
    expect(body.body).toContain('Did not pass: Unit & integration (2), Browser Chromium (1).')
    expect(body.body).toContain(`Merged since the last full run that passed (${drawn}):\n- #11 fix: one\n- #12 feat: two`)
    expect(body.body).not.toContain('a branch commit')
    expect(api.requests.map(item => item.url)).toContain(`compare/${drawn}...${failedRun.head_sha}`)
  })

  it('adds a comment to an open issue instead of editing it or filing another', async () => {
    const api = await github(routes(failedRun, failingJobs, [{ number: 9, title: 'something else' }, { ...openIssue, title: openIssue.title, pull_request: {} }, openIssue]))
    expect((await report(api)).code).toBe(0)
    expect(api.writes().map(item => `${item.method} ${item.url}`)).toEqual(['POST issues/42/comments'])
    expect(api.writes()[0].body.body).toContain('- tests/a.test.ts > a breaks')
  })

  it('counts a job that ran out of time as failed, naming it', async () => {
    const api = await github(routes(failedRun, [unit('cancelled')]))
    const empty = tempRoot()
    expect((await report(api, join(empty, 'absent'))).code).toBe(0)
    const { body } = api.writes()[0].body
    expect(body).toContain('Did not pass: Unit & integration (2).')
    expect(body).toContain('No test report names a failed test')
  })

  it('stays quiet about a run cancelled as a whole, which leaves its aggregate failed', async () => {
    const api = await github(routes({ ...failedRun, conclusion: 'cancelled' }, [unit('cancelled'), { name: 'Verify (Node 22)', conclusion: 'failure' }], [openIssue]))
    expect((await report(api)).code).toBe(0)
    expect(api.writes()).toEqual([])
  })

  it('files nothing for a failure on an older commit than a full run that passed', async () => {
    const api = await github({ ...routes(failedRun, failingJobs), 'GET compare/': { status: 'behind', commits: [] } })
    expect((await report(api)).code).toBe(0)
    expect(api.writes()).toEqual([])
  })

  it('leaves the issue open when a pass is on an older commit than the latest failure', async () => {
    const api = await github({ ...routes(passedRun, [unit('success')], [openIssue]), 'GET compare/': { status: 'behind', commits: [] } })
    expect((await report(api)).code).toBe(0)
    expect(api.writes()).toEqual([])
    expect(api.requests.map(item => item.url)).toContain(`compare/${drawn}...${passedRun.head_sha}`)
    expect(api.requests.map(item => item.url)).toContain('actions/workflows/ci.yml/runs?branch=main&status=failure&per_page=100')
  })

  it.each(['ahead', 'identical'])('closes the open issue once a full run passes on a commit %s of the latest failure', async (status) => {
    const api = await github({ ...routes(passedRun, [unit('success')], [openIssue]), 'GET compare/': { status, commits: [] } })
    expect((await report(api)).code).toBe(0)
    expect(api.writes().map(item => `${item.method} ${item.url}`)).toEqual(['POST issues/42/comments', 'PATCH issues/42'])
  })

  it('closes the open issue once a later full run passes', async () => {
    const api = await github(routes(passedRun, [unit('success')], [openIssue]))
    expect((await report(api)).code).toBe(0)
    expect(api.writes().map(item => `${item.method} ${item.url}`)).toEqual(['POST issues/42/comments', 'PATCH issues/42'])
    expect(api.writes()[0].body.body).toContain(passedRun.html_url)
    expect(api.writes()[1].body).toEqual({ state: 'closed' })
  })

  it('writes nothing after a full run that passes with no open issue', async () => {
    const api = await github(routes(passedRun, [unit('success')]))
    expect((await report(api)).code).toBe(0)
    expect(api.writes()).toEqual([])
  })

  it.each([
    ['skipped its tests after reusing queue evidence', { ...failedRun, conclusion: 'success' }, [unit('skipped')]],
    ['failed before its tests', failedRun, [{ name: 'Select tests or reuse queue evidence', conclusion: 'failure' }]],
  ])('stays quiet about a run that %s', async (_case, run, jobs) => {
    const api = await github(routes(run, jobs, [openIssue]))
    expect((await report(api)).code).toBe(0)
    expect(api.writes()).toEqual([])
  })

  it('fails loudly when it cannot read the run or file the issue', async () => {
    const unreadable = await github({})
    const first = await report(unreadable)
    expect(first.code).not.toBe(0)
    expect(first.stderr).toContain('HTTP 404')
    expect((await ci(tempRoot(), ['report'], { RUN_ID: 'x' })).stderr).toContain('Missing RUN_ID')
  })

  it('reads both report shapes and says when a file never finished', () => {
    expect(failedTests({ testResults: [{ name: '/x/tests/crash.test.ts', status: 'failed', message: 'import failed', assertionResults: [] }] })).toEqual(['tests/crash.test.ts did not finish'])
    expect(failedTests({ suites: [] })).toEqual([])
    expect(failedTests({})).toEqual([])
  })

  it('bounds a long list of failures and says what it left out', () => {
    const body = failureReport({ sha: 's', url: 'u', jobs: ['j'], tests: Array.from({ length: 60 }, (_, n) => `test ${n}`), previous: null, merged: [] })
    expect(body).toContain('- test 49')
    expect(body).not.toContain('- test 50')
    expect(body).toContain('- and 10 more')
    expect(body).toContain('No earlier full run that passed was found.')
  })
})
