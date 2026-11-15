import { MCP_WORKSPACE_VIEWS, type McpWorkspaceView } from '../gateway/src/mcp-contract'
import { PARTS, PLACES, SECTIONS, placeHref, type Part, type Place, type Section } from '../src/ui/address'
import { listCapabilities, type Capability } from './capabilities'
import { workspaceViewSurface } from './mcp-workspace-views'
import { runningRelease } from './running-release'

interface Surface {
  kind: string
  source: string
  retention: string
  permission: string
  tool?: 'poise_work' | 'poise_get' | 'poise_list' | 'poise_changes'
  requiresWorkspace?: true
  requiresChat?: true
  requiresOperator?: true
  requiresContent?: true
  reason: string
}

const work: Surface = { kind: 'issue-work', source: 'GitHub mirror, chain journal and Behavior Ledger',
  retention: 'Current mirror rows and retained chain and ledger records', permission: 'Workspace work-trail grant',
  tool: 'poise_work', reason: 'Exact issues and bounded repository label pages' }
const chat: Surface = { kind: 'chat', source: 'Chat sessions and timers', retention: 'Stored sessions and live timers',
  permission: 'Chat metadata consent', tool: 'poise_get', requiresChat: true, reason: 'Exact Chat or live timer metadata' }
function workspace(id: McpWorkspaceView): Surface {
  const { kind, source, retention, permission, tool, reason } = workspaceViewSurface(id)
  return { kind, source, retention, permission, tool, reason, requiresWorkspace: true }
}
const browser = (kind: string, source: string, retention: string, reason: string): Surface =>
  ({ kind, source, retention, permission: 'Workspace browser session', reason })

const places = {
  overview: workspace('notices'),
  board: work,
  chat,
  manager: { ...chat, reason: 'Exact Manager Chat metadata' },
  editor: { kind: 'document', source: 'Editor, publication ledger and cached reviews', retention: 'Current document and retained publication versions',
    permission: 'Workspace content consent', tool: 'poise_list', requiresContent: true, reason: 'Resumable document list and exact document contents' },
  observe: work,
  settings: workspace('settings'),
} satisfies Record<Place, Surface>

const parts = {
  tasks: work,
  behaviors: workspace('behaviors'),
  github: { ...work, reason: 'Issue mirror and recorded PR observations' },
  logging: { kind: 'logging', source: 'Gateway Logging', retention: 'Configured retention and recorded source gaps',
    permission: 'Workspace settings and operational data consent', tool: 'poise_list', requiresWorkspace: true,
    reason: 'Bounded workspace diagnostics with exact events and changes' },
} satisfies Record<Part, Surface>

const settings = {
  general: workspace('settings'),
  accounts: workspace('accounts'),
  models: workspace('models'),
  extensions: workspace('extensions'),
  publishing: browser('publishing', 'Editor publication bindings', 'Current bindings and retained reviews', 'Publishing reads are pending'),
  behaviors: workspace('behaviors'),
  snippets: workspace('snippets'),
  admin: { kind: 'instance-logging', source: 'Gateway operator diagnostics', retention: 'Current health and retained diagnostic windows',
    permission: 'Instance admin', tool: 'poise_list', requiresOperator: true, reason: 'Separately consented instance Logging' },
  style: browser('style', 'Local browser preferences', 'Current browser preferences', 'Browser-local interface settings'),
  manager: { ...chat, kind: 'manager-timer', reason: 'Exact live Manager wake timer' },
} satisfies Record<Section, Surface>

const capabilities = {
  'held-reasons': { ...work, reason: 'Recorded issue-chain blocker' },
  'review-requests': browser('review-request', 'Owner review requests', 'Current pending requests', 'Review request reads are pending'),
  'approve-merge': browser('approval', 'GitHub approval and merge controls', 'Current head and recorded receipts', 'Interactive approval control'),
  'behavior-pause': browser('behavior-control', 'Behavior runtime policy', 'Current applied pause', 'Interactive behavior policy control'),
  'organization-unfollow': browser('organization', 'Followed GitHub accounts', 'Current configured accounts', 'Interactive account control'),
  'behavior-estimates': browser('estimate', 'Caller evidence and behavior timing', 'Retained timing history', 'Estimate reads are pending'),
  'chat-requests': browser('chat-request', 'Chat owner requests', 'Current pending requests', 'Chat request reads are pending'),
  'handled-log': workspace('handling'),
  'publication-reviews': { kind: 'document', source: 'Cached publication reviews', retention: 'Retained publication reviews',
    permission: 'Workspace content consent', tool: 'poise_get', requiresContent: true, reason: 'Exact document and retained review metadata' },
  'settings-conflict': browser('settings-conflict', 'Browser settings version check', 'Current settings version', 'Interactive settings conflict'),
} satisfies Record<Capability, Surface>

const capabilityLinks: Record<Capability, string> = {
  'held-reasons': placeHref('observe', { part: 'tasks' }),
  'review-requests': placeHref('overview'),
  'approve-merge': placeHref('board'),
  'behavior-pause': placeHref('settings', { settings: 'behaviors' }),
  'organization-unfollow': placeHref('settings', { settings: 'accounts' }),
  'behavior-estimates': placeHref('observe', { part: 'behaviors' }),
  'chat-requests': placeHref('overview'),
  'handled-log': placeHref('overview'),
  'publication-reviews': placeHref('editor'),
  'settings-conflict': placeHref('settings'),
}

export function mcpInventory() {
  const entry = (id: string, query: string, surface: Surface) => ({ id, href: `/${query}`, ...surface })
  return {
    observedAt: new Date().toISOString(),
    release: runningRelease(),
    surfaces: [
      ...PLACES.map(id => entry(id, placeHref(id), places[id])),
      ...PARTS.map(id => entry(`observe/${id}`, placeHref('observe', { part: id }), parts[id])),
      ...SECTIONS.map(id => entry(`settings/${id}`, placeHref('settings', { settings: id }), settings[id])),
      ...listCapabilities().map(id => entry(`capability/${id}`, capabilityLinks[id], capabilities[id])),
      entry('chat/sessions', placeHref('chat'), { ...chat, retention: 'Current and archived sessions',
        tool: 'poise_list', reason: 'Indexed pages by repository and update time' }),
      entry('chat/transcript', placeHref('chat'), { kind: 'chat-event', source: 'Retained Chat journal', retention: 'Events since the last context reset',
        permission: 'Chat transcript consent', tool: 'poise_changes', reason: 'Resumable transcript pages by stored sequence' }),
      ...MCP_WORKSPACE_VIEWS.map(id => ({ id: 'workspace/' + id, ...workspaceViewSurface(id) })),
      entry('workspace/caller', placeHref('observe', { part: 'tasks' }), { ...workspace('behaviors'), kind: 'call',
        source: 'Caller retained Call log and Behavior chain journal', retention: 'Retained Call and invocation records',
        reason: 'Exact full Call or invocation ID with settlement and quarantine coverage' }),
      entry('settings/link-devices', placeHref('settings', { settings: 'link' }), {
        ...workspace('accounts'), kind: 'gateway', source: 'Gateway Poise Link device inventory',
        retention: 'Current and retained pairings', reason: 'Exact link-devices snapshot' }),
    ],
  }
}
