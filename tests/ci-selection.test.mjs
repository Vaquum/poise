import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { callerAffected, reusableRun, selectTests, verify } from '../.github/ci.mjs'

const browsers = ['smoke', 'service-mode', 'independent-startup', 'swarm-loading', 'swarm-pagination', 'analytics', 'settings-save', 'chat', 'notices']
  .map(name => `tests/e2e/${name}.spec.ts`)
const select = (paths, event = 'pull_request') => selectTests(event, paths, browsers)

describe('PR test admission', () => {
  it('retains exhaustive merge-queue and unproven main validation', () => {
    expect(select(['docs/Testing.md'], 'merge_group').mode).toBe('full')
    expect(select(['src/views/swarm-view.ts'], 'push').mode).toBe('full')
    expect(select([]).mode).toBe('full')
  })

  it('runs the affected browser area and core journeys', () => {
    expect(select(['src/views/swarm-view.ts', 'tests/swarm-view-logic.test.ts'])).toEqual({
      mode: 'affected',
      browserFiles: ['independent-startup', 'service-mode', 'smoke', 'swarm-loading', 'swarm-pagination']
        .map(name => `tests/e2e/${name}.spec.ts`),
    })
    expect(select(['src/analytics-history.ts', 'src/settings-save.ts']).browserFiles)
      .toEqual(expect.arrayContaining(['tests/e2e/analytics.spec.ts', 'tests/e2e/settings-save.spec.ts']))
  })

  it('includes changed browser regressions alongside core journeys', () => {
    expect(select(['tests/e2e/notices.spec.ts']).browserFiles).toContain('tests/e2e/notices.spec.ts')
  })

  it.each(['server/process.ts', 'scripts/build-server.mjs', 'src/style.css', 'src/http.ts', 'src/main.ts', 'package-lock.json',
    'vitest.config.ts', 'tests/e2e/fixtures/chat.ts', 'tests/home-isolation.ts', '.github/ci.mjs', 'new-root-config.json'])
  ('runs everything for shared or unknown changes: %s', path => {
    expect(select([path]).mode).toBe('full')
  })

  it('skips application work only for documentation-only PRs', () => {
    expect(select(['README.md', 'docs/Testing.md']).mode).toBe('none')
    expect(select(['README.md', 'server/process.ts']).mode).toBe('full')
  })

  it('fails rather than silently dropping missing smoke or feature coverage', () => {
    expect(() => selectTests('pull_request', ['src/views/swarm-view.ts'], browsers.filter(file => !file.includes('swarm')))).toThrow('No browser coverage')
    expect(() => selectTests('pull_request', ['tests/analytics.test.ts'], [])).toThrow('Missing core')
  })

  it('does not run Caller on frontend-only PRs, but retains shared and unknown coverage', () => {
    expect(callerAffected(['src/views/swarm-view.ts', 'tests/e2e/swarm-loading.spec.ts', 'docs/Testing.md'])).toBe(false)
    for (const path of ['caller/agent_interface/agent_interface/__init__.py', 'server/process.ts', 'package-lock.json', 'tests/chat/checkout-lock.test.ts', '.github/ci.mjs', 'new-config']) {
      expect(callerAffected([path]), path).toBe(true)
    }
    expect(callerAffected([])).toBe(true)
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
  ])('refuses mismatched or incomplete evidence: %j', change => {
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
    for (const mode of ['full', 'affected']) expect(() => verify(gates(mode, 'success'))).not.toThrow()
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
    expect(readFileSync('.github/ci.mjs', 'utf8')).toContain("'--workers=1'")
    expect(ci.permissions.actions).toBe('read')
  })
})
