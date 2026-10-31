export const BEHAVIOR_KEYS = ['review-new-prs', 'approve-prs', 'resolve-unblocking', 'merge-prs', 'rerun-grey-ci', 'review-new-issues', 'implement-issues', 'repair-prs'] as const
export type BehaviorKey = typeof BEHAVIOR_KEYS[number]
