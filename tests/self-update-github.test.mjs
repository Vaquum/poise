import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import {
  GitHubError, REQUIRED_CONTEXTS, assertPullRequestIdentity, assertRepositoryIdentity, createGitHubClient,
  evaluateCi, isUncertain, verifyMergeCommit, verifyQueuedMergeCommit,
} from '../scripts/self-update/github.mjs'
import { REPOSITORY } from '../scripts/self-update/paths.mjs'

const HEAD = 'b'.repeat(40)
const MAIN = 'a'.repeat(40)
const MERGE = 'c'.repeat(40)
const TREE = 'd'.repeat(40)

function workflowRun(overrides = {}) {
  return {
    path: '.github/workflows/ci.yml', head_sha: HEAD, event: 'pull_request', status: 'completed', conclusion: 'success',
    run_number: 7, created_at: '2026-09-19T10:00:00Z', check_suite_id: 55, html_url: `https://github.com/${REPOSITORY}/actions/runs/7`,
    head_repository: { full_name: REPOSITORY }, ...overrides,
  }
}

function checkRuns(overrides = {}) {
  return REQUIRED_CONTEXTS.map((name) => ({
    name, head_sha: HEAD, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 55 }, ...overrides,
  }))
}

describe('CI gate', () => {
  it('passes with the Node 22 aggregate and trusted workflow on the exact head', () => {
    expect(REQUIRED_CONTEXTS).toEqual(['Verify (Node 22)'])
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun()] })).toMatchObject({ status: 'success' })
  })

  it('is pending until the workflow starts, completes and every check reports', () => {
    expect(evaluateCi({ headSha: HEAD, checkRuns: [], workflowRuns: [] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ status: 'in_progress', conclusion: null })] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: [], workflowRuns: [workflowRun()] })).toMatchObject({ status: 'pending', reason: /Node 22/ })
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns({ status: 'queued', conclusion: null }), workflowRuns: [workflowRun()] }).status).toBe('pending')
  })

  it('fails on a failed run or check', () => {
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ conclusion: 'failure' })] })).toMatchObject({ status: 'failure' })
    const runs = checkRuns()
    runs[0].conclusion = 'failure'
    expect(evaluateCi({ headSha: HEAD, checkRuns: runs, workflowRuns: [workflowRun()] })).toMatchObject({ status: 'failure', reason: /Node 22/ })
  })

  it('ignores runs for other heads, other workflows, other events, forks and other apps', () => {
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ head_sha: MAIN })] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ path: '.github/workflows/other.yml' })] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ event: 'push' })] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ head_repository: { full_name: 'fork/Poise' } })] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns({ app: { slug: 'some-other-app' } }), workflowRuns: [workflowRun()] }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns({ check_suite: { id: 99 } }), workflowRuns: [workflowRun()] }).status).toBe('pending')
  })

  it('judges the latest run when the workflow re-ran', () => {
    const runs = [workflowRun({ run_number: 7, conclusion: 'failure' }), workflowRun({ run_number: 8, check_suite_id: 56 })]
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns({ check_suite: { id: 56 } }), workflowRuns: runs }).status).toBe('success')
  })
})

describe('repository identity', () => {
  it('rejects repository and pull request identity mismatches', () => {
    expect(() => assertRepositoryIdentity({ full_name: REPOSITORY, default_branch: 'main' })).not.toThrow()
    expect(() => assertRepositoryIdentity({ full_name: 'mikkokotila/poise-fork', default_branch: 'main' })).toThrow(/identity mismatch/)
    expect(() => assertRepositoryIdentity({ full_name: REPOSITORY, default_branch: 'develop' })).toThrow(/default branch/)
    const pull = {
      number: 3, draft: false,
      base: { ref: 'main', repo: { full_name: REPOSITORY } },
      head: { ref: 'poise/change-x', sha: HEAD, repo: { full_name: REPOSITORY } },
    }
    expect(() => assertPullRequestIdentity(pull, { branch: 'poise/change-x', headSha: HEAD })).not.toThrow()
    expect(() => assertPullRequestIdentity({ ...pull, base: { ref: 'release', repo: pull.base.repo } }, { branch: 'poise/change-x' })).toThrow(/base branch is release/)
    expect(() => assertPullRequestIdentity({ ...pull, head: { ...pull.head, repo: { full_name: 'x/Poise' } } }, { branch: 'poise/change-x' })).toThrow(/head repository/)
    expect(() => assertPullRequestIdentity(pull, { branch: 'poise/change-x', headSha: MAIN })).toThrow(/PR head moved/)
    expect(() => assertPullRequestIdentity({ ...pull, draft: true }, { branch: 'poise/change-x' })).toThrow(/draft/)
    expect(() => assertPullRequestIdentity(pull, { branch: 'poise/change-y' })).toThrow(/head branch/)
  })
})

describe('merge commit verification', () => {
  const commit = (overrides = {}) => ({ sha: MERGE, parents: [{ sha: MAIN }, { sha: HEAD }], commit: { tree: { sha: TREE } }, ...overrides })

  it('accepts exactly [base, head] with the verified head tree', () => {
    expect(verifyMergeCommit({ commit: commit(), expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toBe(MERGE)
  })

  it('rejects reordered, missing or extra parents and a different tree', () => {
    expect(() => verifyMergeCommit({ commit: commit({ parents: [{ sha: HEAD }, { sha: MAIN }] }), expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toThrow(/parents/)
    expect(() => verifyMergeCommit({ commit: commit({ parents: [{ sha: MAIN }] }), expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toThrow(/parents/)
    expect(() => verifyMergeCommit({ commit: commit({ parents: [{ sha: 'e'.repeat(40) }, { sha: HEAD }] }), expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toThrow(/parents/)
    expect(() => verifyMergeCommit({ commit: commit({ commit: { tree: { sha: 'f'.repeat(40) } } }), expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toThrow(/tree/)
    expect(() => verifyMergeCommit({ commit: null, expectedBase: MAIN, expectedHead: HEAD, headTree: TREE })).toThrow()
  })
})

describe('queued integration verification', () => {
  const newerBase = '7'.repeat(40)
  const commit = { sha: MERGE, parents: [{ sha: newerBase }, { sha: HEAD }], commit: { tree: { sha: '8'.repeat(40) } } }
  const options = { commit, mergeSha: MERGE, expectedBase: MAIN, expectedHead: HEAD, mainSha: '9'.repeat(40) }

  it('accepts a changed integration tree only with base and live-main ancestry', async () => {
    const calls = []
    await expect(verifyQueuedMergeCommit({ ...options, compare: async (base, head) => {
      calls.push([base, head])
      return { status: 'ahead', behind_by: 0 }
    } })).resolves.toBe(MERGE)
    expect(calls).toEqual([[MAIN, newerBase], [MERGE, options.mainSha]])
  })

  it('rejects a substituted head, missing base, and a merge outside live main', async () => {
    const ahead = async () => ({ status: 'ahead', behind_by: 0 })
    await expect(verifyQueuedMergeCommit({ ...options, commit: { ...commit, parents: [{ sha: newerBase }, { sha: MAIN }] }, compare: ahead })).rejects.toThrow(/pinned head/)
    await expect(verifyQueuedMergeCommit({ ...options, compare: async () => ({ status: 'diverged', behind_by: 1 }) })).rejects.toThrow(/recorded base/)
    await expect(verifyQueuedMergeCommit({ ...options, compare: async (base) => base === MAIN ? ahead() : { status: 'behind', behind_by: 1 } })).rejects.toThrow(/live main/)
  })

  it('requires the trusted merge_group workflow, not a pull-request run for that SHA', () => {
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun()], event: 'merge_group' }).status).toBe('pending')
    expect(evaluateCi({ headSha: HEAD, checkRuns: checkRuns(), workflowRuns: [workflowRun({ event: 'merge_group' })], event: 'merge_group' }).status).toBe('success')
  })
})

describe('GitHub client', () => {
  function client(handler, options = {}) {
    const calls = []
    const fetch = async (url, init) => {
      calls.push({ url, init })
      return handler(url, init)
    }
    return { calls, api: createGitHubClient({ fetch, loadToken: async () => 'github_pat_TESTTOKEN0123456789abcdef', timeoutMs: 1_000, ...options }) }
  }
  const response = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('sends the release token as a bearer header to the pinned repository only', async () => {
    const { api, calls } = client(() => response(200, { object: { sha: MAIN } }))
    expect(await api.getBranchSha()).toBe(MAIN)
    expect(calls[0].url).toBe(`https://api.github.com/repos/${REPOSITORY}/git/ref/heads/main`)
    expect(calls[0].init.headers.authorization).toBe('Bearer github_pat_TESTTOKEN0123456789abcdef')
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports 4xx as definite errors and network or 5xx failures as uncertain', async () => {
    const notFound = client(() => response(404, { message: 'Not Found' }))
    await expect(notFound.api.getPullRequest(1)).rejects.toMatchObject({ status: 404, code: 'http' })
    const down = client(() => response(502))
    const error = await down.api.getPullRequest(1).catch((caught) => caught)
    expect(error).toBeInstanceOf(GitHubError)
    expect(isUncertain(error)).toBe(true)
    const offline = client(() => { throw new TypeError('fetch failed') })
    const netError = await offline.api.mergePullRequest(4, { sha: HEAD }).catch((caught) => caught)
    expect(isUncertain(netError)).toBe(true)
    expect(isUncertain(new Error('other'))).toBe(false)
  })

  it('merges with the exact head and merge_method merge, and refuses without a SHA', async () => {
    const { api, calls } = client(() => response(200, { merged: true, sha: MERGE }))
    expect(await api.mergePullRequest(12, { sha: HEAD })).toEqual({ merged: true, sha: MERGE })
    expect(calls[0].init.method).toBe('PUT')
    expect(calls[0].url).toBe(`https://api.github.com/repos/${REPOSITORY}/pulls/12/merge`)
    expect(JSON.parse(calls[0].init.body)).toEqual({ sha: HEAD, merge_method: 'merge' })
    await expect(api.mergePullRequest(12, { sha: 'abc' })).rejects.toThrow(/exact head SHA/)
  })

  it('reads native queue configuration and enqueues with an atomic expected head', async () => {
    const { api, calls } = client((url, init) => {
      const { query } = JSON.parse(init.body)
      return response(200, { data: query.startsWith('query') ? { repository: { pullRequest: {
        id: 'PR_12', headRefOid: HEAD, isMergeQueueEnabled: true, merged: false, state: 'OPEN',
        mergeQueue: { configuration: { mergeMethod: 'MERGE' } }, mergeQueueEntry: null,
      } } } : { enqueuePullRequest: { mergeQueueEntry: { id: 'QUEUE_12', state: 'QUEUED' } } } })
    })
    expect(await api.getMergeQueue(12)).toMatchObject({ enabled: true, headSha: HEAD, mergeMethod: 'MERGE', entry: null, merged: false, state: 'OPEN' })
    expect(await api.enqueuePullRequest('PR_12', { sha: HEAD })).toEqual({ id: 'QUEUE_12', state: 'QUEUED' })
    expect(calls[1].url).toBe('https://api.github.com/graphql')
    expect(JSON.parse(calls[1].init.body).variables.input).toEqual({ pullRequestId: 'PR_12', expectedHeadOid: HEAD })
    await expect(api.enqueuePullRequest('PR_12', { sha: 'abc' })).rejects.toThrow(/exact head/)
  })

  it('fails loudly on GraphQL errors and missing queue configuration', async () => {
    const rejected = client(() => response(200, { errors: [{ message: 'Head changed' }] }))
    await expect(rejected.api.enqueuePullRequest('PR_12', { sha: HEAD })).rejects.toThrow(/Head changed/)
    const missing = client(() => response(200, { data: { repository: { pullRequest: null } } }))
    await expect(missing.api.getMergeQueue(12)).rejects.toThrow(/configuration/)
  })

  it('finds a pull request by exact head branch and opens one without maintainer edits', async () => {
    const pulls = [{ number: 1, head: { ref: 'poise/change-other' } }, { number: 2, head: { ref: 'poise/change-x' } }]
    const { api, calls } = client((url) => (url.includes('/pulls?') ? response(200, pulls) : response(201, { number: 3 })))
    expect((await api.findPullRequest('poise/change-x')).number).toBe(2)
    expect(calls[0].url).toContain(`head=${REPOSITORY.split('/')[0]}%3Apoise%2Fchange-x`)
    expect(await api.findPullRequest('poise/change-none')).toBeNull()
    await api.createPullRequest({ title: 't', body: 'b', head: 'poise/change-x' })
    expect(JSON.parse(calls.at(-1).init.body)).toEqual({ title: 't', body: 'b', head: 'poise/change-x', base: 'main', maintainer_can_modify: false })
  })

  it('normalises list responses', async () => {
    const { api } = client((url) => (url.includes('check-runs') ? response(200, { check_runs: [{ name: 'x' }] }) : response(200, {})))
    expect(await api.listCheckRuns(HEAD)).toEqual([{ name: 'x' }])
    expect(await api.listWorkflowRuns(HEAD)).toEqual([])
  })

  it('filters workflow runs by event and follows a full first page to the trusted run', async () => {
    const filler = Array.from({ length: 100 }, (_, index) => workflowRun({ event: 'schedule', run_number: index + 1 }))
    const trusted = workflowRun({ event: 'merge_group', run_number: 101 })
    const { api, calls } = client((url) => {
      const page = Number(new URL(url).searchParams.get('page'))
      return response(200, { total_count: 101, workflow_runs: page === 1 ? filler : [trusted] })
    })
    const runs = await api.listWorkflowRuns(HEAD, { event: 'merge_group' })
    expect(runs).toHaveLength(101)
    expect(runs.at(-1)).toMatchObject({ event: 'merge_group', run_number: 101 })
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('event=merge_group')
    expect(calls[0].url).toContain('per_page=100')
  })

  it('requests one short page when no event filter is given', async () => {
    const { api, calls } = client(() => response(200, { workflow_runs: [] }))
    expect(await api.listWorkflowRuns(HEAD)).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).not.toContain('event=')
  })

  it('requires a token loader', () => {
    expect(() => createGitHubClient({ fetch: async () => response(200, {}) })).toThrow(/loadToken/)
  })
})


describe('required workflow aggregate', () => {
  const { jobs } = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const command = jobs.verify.steps.find((step) => step.run)?.run
  const results = Object.fromEntries(jobs.verify.needs.map((name) => [name, { result: 'success' }]))
  results.plan.outputs = { mode: 'full' }
  const run = (results) => spawnSync(process.execPath, command.slice('node '.length).split(' '), {
    env: { ...process.env, RESULTS: JSON.stringify(results) }, encoding: 'utf8',
  })

  it('binds self-update to every CI prerequisite, including jobs skipped after failure', () => {
    expect(REQUIRED_CONTEXTS).toEqual([jobs.verify.name])
    expect(command).toBe('node .github/ci.mjs verify')
    expect(jobs.verify.if).toBe('${{ always() }}')
    expect(jobs.verify.needs.toSorted()).toEqual(Object.keys(jobs).filter((name) => name !== 'verify').toSorted())
    expect(run(results).status).toBe(0)
  })

  it.each(['failure', 'skipped', 'cancelled', undefined])('rejects a prerequisite with result %s', (result) => {
    for (const name of jobs.verify.needs) {
      expect(run({ ...results, [name]: { result } }).status).not.toBe(0)
    }
  })

  it('rejects missing gate evidence', () => {
    expect(run({}).status).not.toBe(0)
  })
})
