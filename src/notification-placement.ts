import type { NoticeKind } from './notices'
/** Executable lifecycle inventory; action groups are rendered from NOTICE_LOOK. */
export const NOTIFICATION_PLACEMENT = {
  chat_waiting: { actor: 'user', logging: 'none', lifecycle: 'pending-session' },
  chat_turn_finished: { actor: 'user', logging: 'separate-failure-only', lifecycle: 'long-turn-one-hour' },
  sign_in_needed: { actor: 'user', logging: 'confirmed-failure-only', lifecycle: 'confirmed-false-until-true' },
  behavior_held: { actor: 'cause-owner', logging: 'exact-attempt-cause', lifecycle: 'material-cause-until-authoritative-clearance' },
  datastore_sync_failing: { actor: 'user-operator', logging: 'account-sync-condition', lifecycle: 'fifteen-minutes-until-success' },
  storage_low: { actor: 'user-operator', logging: 'exact-crossing', lifecycle: 'five-gib-downward-rearm-six' },
  github_quota_warning: { actor: 'user-operator', logging: 'sustained-forecast', lifecycle: 'fifty-percent-thirty-seconds-reset-keyed' },
  github_quota_exhausted: { actor: 'account-operator', logging: 'observed-exhaustion', lifecycle: 'zero-until-confirmed-capacity' },
  ledger_queue_stalled: { actor: 'poise', logging: 'sustained-queue-age', lifecycle: 'stall-budget-two-checks-until-drained' },
  ledger_capture_loss: { actor: 'poise', logging: 'dropped-increase', lifecycle: 'increase-per-generation-until-dismissed' },
  pr_ready: { actor: 'user', logging: 'none', lifecycle: 'ready-two-minute-check-fifteen-minute-reminder' },
  review_requested: { actor: 'user', logging: 'none', lifecycle: 'requested-until-authoritative-removal' },
  pr_conflict: { actor: 'user', logging: 'none', lifecycle: 'conflict-until-resolved-or-closed' },
  worker_idle: { actor: 'user', logging: 'none', lifecycle: 'idle-two-minute-check-hourly-reminder' },
  action_failed: { actor: 'poise', logging: 'known-source-only', lifecycle: 'tab-dedupe-until-action-recovery' },
  action_needed: { actor: 'user', logging: 'none', lifecycle: 'tab-dedupe-until-action-recovery' },
  action_finished: { actor: 'user', logging: 'none', lifecycle: 'tab-local-until-dismissed-or-cleared' },
  read_failed: { actor: 'user', logging: 'known-source-only', lifecycle: 'tab-dedupe-until-read-recovery' },
} as const satisfies Record<NoticeKind, { actor: string; logging: string; lifecycle: string }>
