// Which redesigned-interface capabilities this server has, by name. #556's
// interface reads GET /api/capabilities once at mount and uses each one
// once it ships, keeping its Open fallback otherwise. Only delivered
// capabilities are listed: reverting one removes its name with it. The
// Manager's controls, plan and escalation (PRD items 6-8) stay absent
// until their enforcement lands; their settings alone are not the
// capability.
export const CAPABILITIES = [
  'held-reasons',
  'review-requests',
  'approve-merge',
  'behavior-pause',
  'organization-unfollow',
  'behavior-estimates',
  'chat-requests',
  'handled-log',
  'publication-reviews',
  'settings-conflict',
] as const

export type Capability = (typeof CAPABILITIES)[number]

export function listCapabilities(): Capability[] {
  return [...CAPABILITIES]
}
