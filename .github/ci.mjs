import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { relative } from 'node:path'
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

export function documentation(path) {
  return path.startsWith('docs/') || /^[^/]+\.md$/.test(path)
}

export function selectTests(event, paths, browserFiles) {
  if (event !== 'pull_request' || !paths.length) return { mode: 'full', browserFiles: [] }
  if (paths.every(documentation)) return { mode: 'none', browserFiles: [] }
  const selected = new Set(browserFiles.filter(file => smoke.includes(file.split('/').at(-1).replace('.spec.ts', ''))))
  for (const path of paths) {
    if (documentation(path)) continue
    if (/^tests\/e2e\/[^/]+\.spec\.ts$/.test(path) && browserFiles.includes(path)) {
      selected.add(path)
      continue
    }
    if (/^tests\/(?!fixtures\/).+\.test\.(?:ts|mjs)$/.test(path)) continue
    const area = areas.find(([source]) => source.test(path))
    if (!area) return { mode: 'full', browserFiles: [] }
    const matches = browserFiles.filter(file => area[1].test(file.split('/').at(-1).replace('.spec.ts', '')))
    if (!matches.length) throw new Error(`No browser coverage for ${path}`)
    matches.forEach(file => selected.add(file))
  }
  if (!smoke.every(name => selected.has(`tests/e2e/${name}.spec.ts`))) throw new Error('Missing core browser smoke suite')
  return { mode: 'affected', browserFiles: [...selected].sort() }
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
  if (!['full', 'affected', 'none', 'reuse'].includes(mode)) throw new Error(`Unknown CI mode: ${mode}`)
  if (mode === 'reuse' && !results.plan.outputs.reuse_url) throw new Error('Missing reused run evidence')
  const expected = ['none', 'reuse'].includes(mode) ? 'skipped' : 'success'
  for (const name of ['static', 'build', 'unit', 'browser']) {
    if (results[name]?.result !== expected) throw new Error(`${name}: expected ${expected}, got ${results[name]?.result}`)
  }
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

export async function plan(workflow) {
  if (!['ci.yml', 'caller.yml'].includes(workflow)) throw new Error('Expected CI or Caller workflow')
  const { GITHUB_EVENT_NAME: event, GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, BASE: base } = process.env
  if (!['pull_request', 'merge_group', 'push'].includes(event)) throw new Error(`Unsupported event: ${event}`)
  let reused = null
  if (event === 'push') {
    if (!repository || !/^[a-f0-9]{40}$/.test(sha ?? '') || !process.env.GITHUB_TOKEN) throw new Error('Missing reuse API configuration')
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?event=merge_group&head_sha=${sha}&per_page=100`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Cannot read merge-queue evidence: HTTP ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid workflow-runs response')
    reused = reusableRun(data.workflow_runs, { repository, sha, workflow })
  }
  let paths = []
  if (event === 'pull_request') {
    if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('Missing PR base SHA')
    paths = git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD').split('\0').filter(Boolean)
  }
  const browserFiles = git('ls-files', 'tests/e2e/*.spec.ts').split('\n').filter(Boolean)
  let selection = selectTests(event, paths, browserFiles)
  // Deleted source/tests cannot be resolved reliably by an import graph.
  if (paths.some(path => !documentation(path) && !existsSync(path))) selection = { mode: 'full', browserFiles: [] }
  const mode = reused ? 'reuse' : selection.mode
  const version = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages['node_modules/@playwright/test'].version
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable locked Playwright version')
  const values = {
    mode, base: base ?? '', browser_files: selection.browserFiles,
    browser_image: `mcr.microsoft.com/playwright:v${version}-noble`,
    unit_shards: mode === 'full' ? [1, 2] : [1],
    browser_shards: mode === 'full' ? [1, 2, 3, 4] : [1],
    reuse_url: reused?.html_url ?? '',
    run: !reused && (event !== 'pull_request' || callerAffected(paths)),
  }
  output(values)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `CI mode: **${mode}**. ${reused ? `Reuses ${reused.html_url} for exact commit ${sha}.` : `Changed paths: ${paths.length}.`}\n`)
}

function runTests(kind) {
  const mode = process.env.CI_TEST_MODE
  if (!['full', 'affected'].includes(mode)) throw new Error(`Cannot run tests in mode ${mode}`)
  const shard = Number(process.env.CI_TEST_SHARD)
  if (!Number.isInteger(shard) || shard < 1 || shard > (kind === 'unit' ? 2 : 4)) throw new Error('Invalid test shard')
  const args = kind === 'unit'
    ? ['test', '--', `--shard=${shard}/${mode === 'full' ? 2 : 1}`, '--reporter=default', '--reporter=json', '--outputFile=test-results/vitest.json']
    : ['run', 'test:e2e', '--', `--shard=${shard}/${mode === 'full' ? 4 : 1}`, '--workers=1']
  if (mode === 'affected') {
    if (kind === 'unit') {
      if (!/^[a-f0-9]{40}$/.test(process.env.BASE ?? '')) throw new Error('Missing affected-test base SHA')
      const listed = JSON.parse(execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'list',
        '--changed', process.env.BASE, '--filesOnly', '--json'], { encoding: 'utf8' }))
      if (!Array.isArray(listed) || listed.some(entry => typeof entry?.file !== 'string')) throw new Error('Invalid affected unit-test selection')
      const files = listed.map(entry => relative(process.cwd(), entry.file))
      if (files.some(file => !/^tests\/.+\.test\.(?:ts|mjs)$/.test(file))) throw new Error('Affected unit test is outside tests/')
      // An empty import graph is not proof of coverage (e.g. source-text tests).
      // Run the full unit suite on this one shard rather than accepting zero tests.
      if (files.length) args.push(...files)
    } else {
      const files = JSON.parse(process.env.CI_BROWSER_FILES ?? 'null')
      if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !/^tests\/e2e\/[^/]+\.spec\.ts$/.test(file))) throw new Error('Invalid browser test selection')
      args.push(...files)
    }
  }
  const result = spawnSync('npm', args, { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, workflow] = process.argv.slice(2)
  if (command === 'plan') await plan(workflow)
  else if (command === 'verify') verify(JSON.parse(process.env.RESULTS ?? 'null'))
  else if (['unit', 'browser'].includes(command)) runTests(command)
  else throw new Error(`Unknown CI command: ${command}`)
}
