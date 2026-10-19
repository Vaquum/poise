import { describe, expect, it } from 'vitest'
import { analyticsGroups as buildGroups, firstReviewTrend, formatDuration, formatRate, formatShortDuration, mergeTimeTrend, type AnalyticsReport } from '../src/analytics-format'
import { workType, type WorkReviewAnalytics } from '../src/analytics-work-review'

// What the Analytics view says (src/analytics-format.ts).

function report(pullRequests: Partial<AnalyticsReport['pullRequests']> = {}): AnalyticsReport {
  return {
    window: { since: null, until: null },
    agentAccount: 'robot',
    issues: { opened: 1204, closed: 1 },
    pullRequests: {
      opened: 6,
      closedUnmerged: 1,
      merged: 4,
      mergedByAgent: 3,
      firstReview: { count: 5, medianMs: 95_000 },
      commentsPerPr: 2.25,
      medianCommentsPerPr: pullRequests.commentsPerPr ?? 2.25,
      lines: { total: 12_345, median: 180.5, counted: 4 },
      behaviors: { medianPerPr: 1.5, perPr: 1.5, approvals: 1, reviews: 4, changesRequested: 1 },
      averageTimeToMergeMs: (26 * 60 + 5) * 60_000,
      medianTimeToMergeMs: 5 * 3_600_000,
      ...pullRequests,
    },
    daily: Array.from({ length: 7 }, () => ({ issues: { opened: 172, closed: 1 }, pullRequests: { opened: 3, closedUnmerged: 0, merged: 2, mergedByAgent: 1, firstReview: { count: 1, medianMs: 1 }, commentsPerPr: 1, lines: { total: 350, median: 175, counted: 2 }, behaviors: { perPr: 1, approvals: 1, reviews: 1, changesRequested: 0 }, averageTimeToMergeMs: 1, medianTimeToMergeMs: 1 } })),
    errors: [],
  }
}

function analyticsGroups(value: AnalyticsReport) { return buildGroups(value, report()) }

function tile(groups: ReturnType<typeof analyticsGroups>, label: string) {
  return groups.flatMap((group) => group.tiles).find((t) => t.label === label)!
}

describe('work and review analytics', () => {
  it.each([
    ['feat: add capability', 'feat'], ['fix(api)!: correct result', 'fix'], ['perf!: reduce work', 'perf'],
    ['refactor(core): simplify', 'refactor'], ['test: cover it', 'test'], ['ci: check', 'ci'], ['revert: undo', 'revert'],
    ['Fix: crash', 'fix'], ['Feat(api): add capability', 'feat'], ['PERF(core)!: speed up', 'perf'],
    ['docs: describe', 'docs'], ['build: package', 'build'], ['chore: maintain', 'chore'], ['style: format', 'style'], ['Revert "feat: add capability"', 'unclassified'],
    ['feature: not a recognized prefix', 'unclassified'], ['feat: ', 'unclassified'], ['A feat: title', 'unclassified'], ['feat(scope: broken', 'unclassified'],
  ])('classifies %s as %s', (title, expected) => { expect(workType(title)).toBe(expected) })

  function work(merged: number, affected: number, rounds: number | null = 3): WorkReviewAnalytics {
    return { reviewed: merged, types: [{ type: 'feat', count: merged }], rounds: { median: rounds, counted: merged, missingReviews: 0, distribution: [] }, changesRequested: { prs: affected, reviews: affected * 2, dismissed: 1, counted: merged } }
  }

  it('shows the approved population, neutral work mix and relative review-friction comparisons', () => {
    const groups = buildGroups(report({ merged: 57, workReview: work(57, 48) }), report({ merged: 237, workReview: work(237, 170) }), 0.5)
    expect(tile(groups, 'Work type')).toMatchObject({ value: '100.0%', valueLabel: 'feat', population: 57 })
    expect(tile(groups, 'Work type').trend).toBeUndefined()
    expect(tile(groups, 'Review rounds')).toMatchObject({ value: '3.0', comparison: '7-day median: 3.0 · 237 PRs', trend: { direction: 'neutral', text: '→ 0%' } })
    expect(tile(groups, 'Change-request share')).toMatchObject({ value: '84.2%', comparison: '7-day share: 71.7% · 237 PRs', trend: { direction: 'bad', text: '↑ 17.4%' } })
    const lower = buildGroups(report({ merged: 57, workReview: work(57, 20, 1) }), report({ merged: 237, workReview: work(237, 170) }))
    for (const label of ['Review rounds', 'Change-request share']) expect(tile(lower, label).trend?.direction).toBe('good')
  })

  it('includes unclassified PRs in neutral work-type shares without a baseline', () => {
    const mix = work(4, 2)
    mix.types = [{ type: 'feat', count: 2 }, { type: 'unclassified', count: 2 }]
    expect(tile(buildGroups(report({ workReview: mix }), report()), 'Work type')).toMatchObject({ value: '50.0%', valueLabel: 'feat', population: 4 })
    expect(tile(buildGroups(report({ workReview: mix }), report()), 'Work type').comparison).toBeUndefined()
  })

  it('withholds unavailable figures and comparisons rather than inventing zeros', () => {
    const absent = buildGroups(report(), report())
    for (const label of ['Work type', 'Review rounds', 'Change-request share']) expect(tile(absent, label).value).toBe('—')
    const day = report({ workReview: work(4, 2, null) })
    day.pullRequests.workReview!.rounds.counted = 3
    day.pullRequests.workReview!.rounds.missingReviews = 2
    const week = report({ workReview: work(4, 2) })
    expect(tile(buildGroups(day, week), 'Review rounds')).toMatchObject({ value: '—', note: expect.stringContaining('3 of 4') })
    day.errors = [{ org: 'missing', error: 'unreadable' }]
    expect(tile(buildGroups(day, week), 'Change-request share').trend).toBeUndefined()
    const empty = report({ merged: 0, workReview: work(0, 0, null) })
    expect(tile(buildGroups(empty, week), 'Change-request share').value).toBe('—')
    const zero = report({ workReview: work(4, 0) })
    expect(tile(buildGroups(report({ workReview: work(4, 1) }), zero), 'Change-request share').trend).toBeUndefined()
    expect(tile(buildGroups(zero, zero), 'Change-request share').trend).toMatchObject({ direction: 'neutral', text: '→ 0%' })
    expect(tile(buildGroups(report({ workReview: work(4, 1, 1) }), report({ workReview: work(4, 0, 0) })), 'Review rounds').trend).toBeUndefined()
    expect(tile(buildGroups(report({ workReview: work(4, 0, 0) }), report({ workReview: work(4, 0, 0) })), 'Review rounds').trend).toMatchObject({ direction: 'neutral', text: '→ 0%' })
  })

  it('explains day and baseline coverage independently, including unavailable and empty cohorts', () => {
    const day = report({ workReview: work(4, 2) })
    const week = report({ workReview: work(4, 2, null) })
    week.pullRequests.workReview!.rounds = { median: null, counted: 3, missingReviews: 2, distribution: [{ rounds: 1, prs: 3 }] }
    const rounds = tile(buildGroups(day, week), 'Review rounds')
    expect(rounds.note).toContain('Selected day: exact round counts for 4 of 4')
    expect(rounds.note).toContain('7-day baseline: exact round counts for 3 of 4 merged PRs; 2 reviews lack commit identities')
    expect(rounds.trend).toBeUndefined()
    expect(tile(buildGroups(week, day), 'Review rounds').note).toContain('Selected day: exact round counts for 3 of 4')
    expect(tile(buildGroups(day, report()), 'Review rounds').note).toContain('7-day baseline: review aggregates unavailable')
    expect(tile(buildGroups(report({ merged: 0 }), day), 'Review rounds').note).toContain('Selected day: no merged PRs')
    expect(tile(buildGroups(day, week), 'Change-request share').note).toContain('Stored summaries available for 4 of 4 PRs')
  })

  it('keeps observed-friction polarity while exposing when fewer PRs were reviewed', () => {
    const unreviewed = work(4, 0, 0)
    unreviewed.reviewed = 0
    const groups = buildGroups(report({ workReview: unreviewed }), report({ workReview: work(4, 2, 1) }))
    for (const label of ['Review rounds', 'Change-request share']) {
      expect(tile(groups, label).trend).toMatchObject({ direction: 'good', text: '↓ 100%' })
      expect(tile(groups, label).note).toContain('0 of 4 PRs had an eligible review')
      expect(tile(groups, label).note).toContain('Fewer reviewed PRs can lower observed friction')
    }
  })
})

describe('Analytics wording', () => {
  it('shows durations in at most two units', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(30_000)).toBe('<1m')
    expect(formatDuration(42 * 60_000)).toBe('42m')
    expect(formatDuration(5 * 3_600_000)).toBe('5h')
    expect(formatDuration(5 * 3_600_000 + 12 * 60_000)).toBe('5h 12m')
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000 + 59 * 60_000)).toBe('3d 4h')
    expect(formatDuration(2 * 86_400_000)).toBe('2d')
  })

  it('shows averages to one decimal', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(2)).toBe('2.0')
    expect(formatRate(2.25)).toBe('2.3')
    expect(formatRate(1234.5)).toBe('1,234.5')
  })

  it('orders productivity by pull request flow, review and merge times, then issues', () => {
    const groups = analyticsGroups(report())
    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ['productivity', 'Productivity'], ['work-review', 'Work & review'], ['per-merged-pr', 'Per merged pull request'],
    ])
    expect(groups.map((group) => group.tiles.map((t) => [t.label, t.value]))).toEqual([
      [['Pull requests opened', '6'], ['Pull requests merged', '4'], ['Closed without merging', '1'], ['Lines changed', '12,345'], ['Time to first review', '1m 35s'], ['Time to merge', '5h'], ['Issues opened', '1,204'], ['Issues closed', '1']],
      [['Work type', '—'], ['Review rounds', '—'], ['Change-request share', '—']],
      [['Comments', '2.3'], ['Median lines', '181'], ['Behaviors', '1.5'], ['Median time', '5h'], ['Merged by agent', '75%']],
    ])
    expect(tile(groups, 'Merged by agent').note).toBe('3 of 4 by robot')
    expect(groups.every((group) => group.help)).toBe(true)
    expect(tile(groups, 'Behaviors').note).toBe('1 approval · 4 reviews · 1 change request')
    expect(groups.every((group) => !group.note)).toBe(true)
  })

  it('says how many pull requests the line counts come from when some have no size yet', () => {
    const groups = analyticsGroups(report({ merged: 52, lines: { total: 900, median: 20, counted: 40 } }))
    expect(tile(groups, 'Lines changed').value).toBe('900')
    expect(groups[0].note).toBe('From 40 of 52 pull requests')
  })

  it('shows an unknown total, not zero, when no merged pull request has a size yet', () => {
    const groups = analyticsGroups(report({ merged: 1, lines: { total: null, median: null, counted: 0 } }))
    expect(tile(groups, 'Lines changed').value).toBe('—')
    expect(tile(groups, 'Median lines').value).toBe('—')
    expect(groups[0].note).toBe('From 0 of 1 pull request')
  })

  it('says nothing was merged instead of showing averages of nothing', () => {
    const groups = analyticsGroups(report({
      merged: 0,
      mergedByAgent: 0,
      commentsPerPr: null,
      medianCommentsPerPr: null,
      lines: { total: null, median: null, counted: 0 },
      behaviors: { perPr: null, approvals: 0, reviews: 0, changesRequested: 0 },
      averageTimeToMergeMs: null,
      medianTimeToMergeMs: null,
    }))
    expect(tile(groups, 'Lines changed').value).toBe('0')
    expect(tile(groups, 'Comments').value).toBe('—')
    expect(tile(groups, 'Behaviors').note).toBeUndefined()
    expect(tile(groups, 'Merged by agent').value).toBe('—')
    expect(tile(groups, 'Merged by agent').trend).toBeUndefined()
    expect(groups[0].note).toBe('')
    expect(groups[2].note).toBe('No pull requests were merged in this range.')
  })
})


describe('merge-time trends', () => {
  it('makes faster, slower and unchanged comparisons explicit', () => {
    expect(mergeTimeTrend(50, 100)).toEqual({ direction: 'good', caption: 'Faster vs 7-day median', text: '↓ 50%', description: '50% faster versus the preceding 7-day median' })
    expect(mergeTimeTrend(150, 100)).toEqual({ direction: 'bad', caption: 'Slower vs 7-day median', text: '↑ 50%', description: '50% slower versus the preceding 7-day median' })
    expect(mergeTimeTrend(100, 100)?.text).toBe('→ 0%')
    expect(mergeTimeTrend(100, 100)?.direction).toBe('neutral')
  })
  it('does not invent percentages without data or with a zero baseline', () => {
    expect(mergeTimeTrend(null, 100)).toBeUndefined()
    expect(mergeTimeTrend(100, null)).toBeUndefined()
    expect(mergeTimeTrend(3_600_000, 0)?.text).toBe('↑ 1h')
    expect(mergeTimeTrend(0, 0)?.text).toBe('→ 0%')
    expect(mergeTimeTrend(100.001, 100)?.text).toBe('↑ <0.1%')
  })
})

it('withholds comparative claims when an account is missing from either period', () => {
  const partial = report()
  partial.errors = [{ org: 'beta', error: 'offline' }]
  expect(tile(buildGroups(partial, report()), 'Time to merge').trend).toBeUndefined()
  expect(tile(buildGroups(report(), partial), 'Time to merge').trend).toBeUndefined()
})

it('compares headline event counts against seven-day daily medians, including zero days', () => {
  const day = report({ merged: 4, lines: { total: 700, median: 175, counted: 4 } })
  day.issues = { opened: 7, closed: 0 }
  const week = report({ merged: 14, lines: { total: 2450, median: 175, counted: 14 } })
  week.issues = { opened: 14, closed: 7 }
  week.daily!.forEach((day) => { day.issues = { opened: 2, closed: 1 } })
  const groups = buildGroups(day, week)
  expect(tile(groups, 'Issues opened').trend).toMatchObject({ direction: 'good', text: '↑ 250%' })
  expect(tile(groups, 'Issues closed').trend).toMatchObject({ direction: 'bad', text: '↓ 100%' })
  expect(tile(groups, 'Pull requests merged').comparison).toBe('7-day median: 2.0 / day')
  expect(tile(groups, 'Lines changed').trend).toMatchObject({ direction: 'good', text: '↑ 100%' })
  week.pullRequests.lines.counted = 10
  week.daily![0].pullRequests.lines.counted = 1
  expect(tile(buildGroups(day, week), 'Lines changed').trend).toBeUndefined()
  expect(tile(buildGroups(day, week), 'Lines changed').comparison).toBe('7-day median: — / day')
})

describe('elapsed-day pacing', () => {
  function mergedTile(current: number, median = 100, progress = 0.5) {
    const week = report()
    week.daily!.forEach((day) => { day.pullRequests.merged = median })
    return tile(buildGroups(report({ merged: current }), week, progress), 'Pull requests merged')
  }

  it('keeps actual totals and the full-day median while comparing with typical work by now', () => {
    const merged = mergedTile(15, 27, 10 / 24)
    expect(merged.value).toBe('15')
    expect(merged.comparison).toBe('Typical by now: 11.3 · 7-day median: 27.0 / day')
    expect(merged.trend).toMatchObject({ direction: 'good', text: '↑ 33.3% ahead of pace' })
    expect(merged.trend?.caption).toMatch(/pace/i)
    expect(merged.trend?.description).toMatch(/pace/i)
  })

  it.each([
    [44, 'bad', '↓ 12% behind pace'],
    [45, 'neutral', '→ On pace'],
    [50, 'neutral', '→ On pace'],
    [55, 'neutral', '→ On pace'],
    [56, 'good', '↑ 12% ahead of pace'],
  ] as const)('uses inclusive 90–110%% neutral boundaries for %s of a typical 50', (current, direction, text) => {
    expect(mergedTile(current).trend).toMatchObject({ direction, text })
  })

  it('keeps exact tolerance boundaries neutral despite fractional elapsed-day rounding', () => {
    expect(mergedTile(30, 80, 10 / 24).trend).toMatchObject({ direction: 'neutral', text: '→ On pace' })
    expect(mergedTile(29, 80, 10 / 24).trend?.direction).toBe('bad')
    expect(mergedTile(110, 240, 10 / 24).trend).toMatchObject({ direction: 'neutral', text: '→ On pace' })
    expect(mergedTile(111, 240, 10 / 24).trend?.direction).toBe('good')
  })

  it.each([
    [111, 2018, 'good', '↑ >10% ahead of pace'],
    [89, 1978, 'bad', '↓ >10% behind pace'],
  ] as const)('makes a raw outside-band change explicit when its percentage rounds to 10%%', (current, median, direction, text) => {
    const merged = mergedTile(current, median, 0.05)
    expect(merged.trend).toMatchObject({ direction, text })
    expect(merged.trend?.description).toContain('>10%')
  })

  it('paces event counts and total lines while preserving duration and per-PR comparisons', () => {
    const day = report({ merged: 1, lines: { total: 175, median: 175, counted: 1 } })
    day.issues = { opened: 86, closed: 1 }
    const week = report()
    const groups = buildGroups(day, week, 0.5)
    for (const label of ['Pull requests opened', 'Pull requests merged', 'Closed without merging', 'Lines changed', 'Issues opened', 'Issues closed']) {
      expect(tile(groups, label).comparison).toMatch(/^Typical by now: /)
    }
    expect(tile(groups, 'Pull requests merged').trend).toMatchObject({ direction: 'neutral', text: '→ On pace' })
    expect(tile(groups, 'Lines changed')).toMatchObject({ value: '175', comparison: 'Typical by now: 175.0 · 7-day median: 350.0 / day', trend: { direction: 'neutral', text: '→ On pace' } })
    const fullDay = buildGroups(day, week)
    for (const label of ['Time to first review', 'Time to merge', 'Comments', 'Median lines', 'Behaviors', 'Median time', 'Merged by agent']) {
      expect(tile(groups, label)).toEqual(tile(fullDay, label))
    }
  })

  it.each([
    [0, 27, 0],
    [15, 27, 0],
    [0, 0, 0.5],
    [15, 0, 0.5],
  ])('does not invent a percentage for %s merges with median %s and progress %s', (current, median, progress) => {
    const merged = mergedTile(current, median, progress)
    expect(merged.value).toBe(String(current))
    expect(merged.comparison).toBe(`Typical by now: 0.0 · 7-day median: ${median.toFixed(1)} / day`)
    expect(merged.trend).toBeUndefined()
  })

  it('retains unknown and incomplete-data suppression for live comparisons', () => {
    const day = report({ merged: 2, lines: { total: 100, median: 100, counted: 1 } })
    const week = report()
    expect(tile(buildGroups(day, week, 0.5), 'Lines changed').trend).toBeUndefined()
    week.daily![0].pullRequests.lines.counted = 1
    expect(tile(buildGroups(day, week, 0.5), 'Lines changed').comparison).toBe('Typical by now: — · 7-day median: — / day')
    day.errors = [{ org: 'missing', error: 'unreadable' }]
    expect(tile(buildGroups(day, week, 0.5), 'Pull requests merged').trend).toBeUndefined()
    day.errors = []
    week.errors = [{ org: 'missing', error: 'unreadable' }]
    expect(tile(buildGroups(day, week, 0.5), 'Pull requests merged').trend).toBeUndefined()
    week.errors = []
    delete week.daily
    expect(tile(buildGroups(day, week, 0.5), 'Pull requests merged').trend).toBeUndefined()
  })

  it.each(['current', 'baseline'] as const)('withholds live cumulative trends for a stale %s report while retaining other comparisons', (stale) => {
    const day = report()
    const week = report()
    const fresh = buildGroups(day, week, 0.5)
    const historical = buildGroups(day, week)
    const staleReport = stale === 'current' ? day : week
    staleReport.errors = [{ org: 'offline', error: 'sync failed', stale: true }]
    const groups = buildGroups(day, week, 0.5)
    for (const label of ['Pull requests opened', 'Pull requests merged', 'Closed without merging', 'Lines changed', 'Issues opened', 'Issues closed']) {
      expect(tile(groups, label).trend).toBeUndefined()
      expect(tile(groups, label).value).toBe(tile(fresh, label).value)
      expect(tile(groups, label).comparison).toBe(tile(fresh, label).comparison)
    }
    expect(tile(groups, 'Pull requests merged').comparison).toBe('Typical by now: 1.0 · 7-day median: 2.0 / day')
    for (const label of ['Time to first review', 'Time to merge', 'Comments', 'Median lines', 'Behaviors', 'Median time', 'Merged by agent']) {
      expect(tile(groups, label)).toEqual(tile(fresh, label))
    }
    expect(buildGroups(day, week)).toEqual(historical)
  })

  it('identifies the totals snapshot in cumulative-card notes only for a paced day', () => {
    const snapshotTime = '9 Oct 2026, 10:00 UTC'
    const note = `Pace as of ${snapshotTime}, when totals were read.`
    const day = report()
    const week = report()
    const groups = buildGroups(day, week, 0.5, snapshotTime)
    for (const label of ['Pull requests opened', 'Pull requests merged', 'Closed without merging', 'Lines changed', 'Issues opened', 'Issues closed']) {
      expect(tile(groups, label).note).toBe(note)
      expect(tile(buildGroups(day, week, undefined, snapshotTime), label).note).toBeUndefined()
    }
    for (const label of ['Time to first review', 'Time to merge', 'Comments', 'Median lines', 'Behaviors', 'Median time', 'Merged by agent']) {
      expect(tile(groups, label)).toEqual(tile(buildGroups(day, week, 0.5), label))
    }
    day.pullRequests.lines.counted = 3
    const partial = tile(buildGroups(day, week, 0.5, snapshotTime), 'Lines changed')
    expect(partial.note).toContain(note)
    expect(partial.note).toContain('From 3 of 4 pull requests')
    expect(partial.trend).toBeUndefined()
  })
})

describe('lower-is-better analytics', () => {
  function closedTile(current: number, median: number, progress?: number) {
    const week = report()
    week.daily!.forEach((day) => { day.pullRequests.closedUnmerged = median })
    return tile(buildGroups(report({ closedUnmerged: current }), week, progress), 'Closed without merging')
  }

  it.each([
    [0, 'good', '↓ 100% below typical'],
    [44, 'good', '↓ 12% below typical'],
    [45, 'neutral', '→ On pace'],
    [50, 'neutral', '→ On pace'],
    [55, 'neutral', '→ On pace'],
    [56, 'bad', '↑ 12% above typical'],
  ] as const)('treats %s unmerged closings against typical 50 with inclusive tolerance', (current, direction, text) => {
    const closed = closedTile(current, 100, 0.5)
    expect(closed).toMatchObject({ value: String(current), trend: { direction, text }, comparison: 'Typical by now: 50.0 · 7-day median: 100.0 / day' })
    expect(closed.trend?.description).not.toMatch(/ahead|behind|faster|slower/)
    expect(closed.trend?.caption).not.toMatch(/ahead|behind|faster|slower/i)
  })

  it.each([
    [4, 'good', '↓ 50%', 'below'],
    [8, 'neutral', '→ 0%', 'Unchanged'],
    [12, 'bad', '↑ 50%', 'above'],
  ] as const)('treats %s completed-day unmerged closings against median 8', (current, direction, text, movement) => {
    const closed = closedTile(current, 8)
    expect(closed).toMatchObject({ trend: { direction, text }, comparison: '7-day median: 8.0 / day' })
    expect(closed.trend?.description).toContain(movement)
    expect(closed.trend?.description).not.toMatch(/faster|slower/)
  })

  it('keeps zero unmerged closings on pace against zero typical and reports positive counts as absolute increases', () => {
    expect(closedTile(0, 0, 0.5).trend).toMatchObject({ direction: 'neutral', text: '→ On pace' })
    const positive = closedTile(3, 0, 0.5)
    expect(positive).toMatchObject({ value: '3', trend: { direction: 'bad', text: '↑ 3.0 above typical' }, comparison: 'Typical by now: 0.0 · 7-day median: 0.0 / day' })
    expect(positive.trend?.description).not.toContain('%')
    expect(closedTile(3, 0).trend).toMatchObject({ direction: 'bad', text: '↑ 3.0' })
    expect(closedTile(0, 0).trend).toMatchObject({ direction: 'neutral', text: '→ 0%' })
  })

  it.each([
    [50, 'good', '↓ 50%', 'below'],
    [95, 'good', '↓ 5%', 'below'],
    [100, 'neutral', '→ 0%', 'Unchanged'],
    [150, 'bad', '↑ 50%', 'above'],
  ] as const)('favors median lines %s against 100 with numeric wording and no daily tolerance', (current, direction, text, movement) => {
    const day = report({ lines: { total: current * 4, median: current, counted: 4 } })
    const week = report({ lines: { total: 400, median: 100, counted: 4 } })
    const median = tile(buildGroups(day, week, 0.5), 'Median lines')
    expect(median).toMatchObject({ value: String(current), trend: { direction, text }, comparison: '7-day median: 100 · 4 PRs' })
    expect(median.trend?.description).toContain(movement)
    expect(median.trend?.description).not.toMatch(/faster|slower/)
    expect(median.trend?.caption).not.toMatch(/faster|slower/i)
    expect(tile(buildGroups(day, week), 'Median lines')).toEqual(median)
  })

  it('retains increasing-activity and faster-duration polarity for the other metrics', () => {
    const day = report({
      opened: 8, merged: 4, mergedByAgent: 4, commentsPerPr: 4.5,
      firstReview: { count: 5, medianMs: 47_500 },
      lines: { total: 700, median: 50, counted: 4 },
      behaviors: { perPr: 3, medianPerPr: 3, approvals: 1, reviews: 4, changesRequested: 1 },
      medianTimeToMergeMs: 2.5 * 3_600_000,
    })
    day.issues = { opened: 344, closed: 2 }
    for (const progress of [undefined, 0.5]) {
      const groups = buildGroups(day, report(), progress)
      for (const label of ['Pull requests opened', 'Pull requests merged', 'Lines changed', 'Issues opened', 'Issues closed', 'Comments', 'Behaviors', 'Merged by agent']) {
        expect(tile(groups, label).trend?.direction).toBe('good')
        expect(tile(groups, label).trend?.text).toMatch(/^↑/)
      }
      for (const label of ['Time to first review', 'Time to merge', 'Median time']) {
        expect(tile(groups, label).trend).toMatchObject({ direction: 'good', text: '↓ 50%' })
        expect(tile(groups, label).trend?.description).toContain('faster')
      }
    }
  })
})


describe('pull request flow', () => {
  it('times first reviews down to the second', () => {
    expect(formatShortDuration(null)).toBe('—')
    expect(formatShortDuration(400)).toBe('<1s')
    expect(formatShortDuration(42_900)).toBe('42s')
    expect(formatShortDuration(3 * 60_000)).toBe('3m')
    expect(formatShortDuration(3 * 60_000 + 12_000)).toBe('3m 12s')
    expect(formatShortDuration(59 * 60_000 + 59_999)).toBe('59m 59s')
    expect(formatShortDuration(65 * 60_000 + 30_000)).toBe('1h 5m')
    expect(formatShortDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h')
  })

  it('compares first reviews with the 7-day median, in seconds when the baseline is zero', () => {
    expect(firstReviewTrend(30_000, 60_000)).toEqual({ direction: 'good', caption: 'Faster vs 7-day median', text: '↓ 50%', description: '50% faster versus the preceding 7-day median' })
    expect(firstReviewTrend(90_000, 60_000)?.caption).toBe('Slower vs 7-day median')
    expect(firstReviewTrend(45_000, 0)?.text).toBe('↑ 45s')
    expect(firstReviewTrend(null, 60_000)).toBeUndefined()
    const groups = buildGroups(report(), report({ firstReview: { count: 20, medianMs: 190_000 } }))
    expect(tile(groups, 'Time to first review').trend).toMatchObject({ direction: 'good', text: '↓ 50%' })
    expect(tile(groups, 'Time to first review').comparison).toBe('7-day median: 3m 10s · 20 first reviews')
  })

  it('counts openings and unmerged closings against the 7-day daily median', () => {
    const groups = buildGroups(report(), report({ opened: 21, closedUnmerged: 0 }))
    expect(tile(groups, 'Pull requests opened')).toMatchObject({ trend: { direction: 'good', text: '↑ 100%' }, comparison: '7-day median: 3.0 / day' })
    expect(tile(groups, 'Closed without merging').trend).toMatchObject({ text: '↑ 1.0' })
  })

  it('says when nothing had its first review, and when no agent account is set', () => {
    const quiet = analyticsGroups(report({ firstReview: { count: 0, medianMs: null } }))
    expect(tile(quiet, 'Time to first review').value).toBe('—')
    expect(quiet[0].note).toBe('No pull request had its first review in this range.')
    const unset = analyticsGroups({ ...report({ mergedByAgent: null }), agentAccount: null })
    expect(tile(unset, 'Merged by agent')).toMatchObject({ value: '—', comparison: 'No agent account in Settings' })
  })
})

it('compares every per-PR metric with the same seven-day population', () => {
  const day = report({ commentsPerPr: 6, medianTimeToMergeMs: 3_600_000 })
  const groups = buildGroups(day, report({ commentsPerPr: 3, medianTimeToMergeMs: 7_200_000 }))
  expect(groups[2].tiles.every((item) => item.trend && item.comparison?.includes('4 PRs'))).toBe(true)
  expect(tile(groups, 'Comments').trend?.text).toBe('↑ 100%')
  expect(tile(groups, 'Median time')).toMatchObject({ trend: { direction: 'good', text: '↓ 50%' }, comparison: '7-day median: 2h · 4 PRs' })
})

it('keeps trends for a readable cache with a sync failure, but not missing scope', () => {
  const stale = report()
  stale.errors = [{ org: 'alpha', error: 'enumeration changed', stale: true }]
  expect(tile(buildGroups(stale, report()), 'Time to merge').trend).toBeDefined()
  stale.errors.push({ org: 'beta', error: 'unreadable' })
  expect(tile(buildGroups(stale, report()), 'Time to merge').trend).toBeUndefined()
})

it('uses the middle daily total, includes zero days, and never substitutes a weekly mean', () => {
  const week = report()
  week.daily!.forEach((day, i) => { day.issues.opened = [0, 0, 0, 2, 4, 10, 700][i] })
  const day = report()
  day.issues.opened = 4
  expect(tile(buildGroups(day, week), 'Issues opened')).toMatchObject({ trend: { text: '↑ 100%' }, comparison: '7-day median: 2.0 / day' })
  delete week.daily
  expect(tile(buildGroups(day, week), 'Issues opened').trend).toBeUndefined()
})

it('compares medians consistently even when unchanged populations are strongly skewed', () => {
  const skewed = report({ commentsPerPr: 34, medianCommentsPerPr: 1, behaviors: { perPr: 34, medianPerPr: 1, approvals: 100, reviews: 1, changesRequested: 1 } })
  const groups = buildGroups(skewed, skewed)
  for (const label of ['Comments', 'Behaviors']) expect(tile(groups, label)).toMatchObject({ value: '1.0', trend: { direction: 'neutral', text: '→ 0%' } })
})
