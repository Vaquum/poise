import { PARTS, PLACES, SECTIONS, placeHref, type Part, type Place, type Section } from '../src/ui/address'
import { listCapabilities, type Capability } from './capabilities'
import { runningRelease } from './running-release'

interface Surface {
  kind: string
  source: string
  retention: string
  permission: string
  tool?: 'poise_work' | 'poise_get' | 'poise_list' | 'poise_changes'
  reason: string
}

const work: Surface = { kind: 'issue-work', source: 'GitHub mirror, chain journal and Behavior Ledger',
  retention: 'Current mirror rows and retained chain and ledger records', permission: 'Workspace work-trail grant',
  tool: 'poise_work', reason: 'Exact issues and bounded repository label pages' }
const chat: Surface = { kind: 'chat', source: 'Chat sessions and timers', retention: 'Stored sessions and live timers',
  permission: 'Chat metadata consent', tool: 'poise_get', reason: 'Exact Chat or live timer metadata' }
const browser = (kind: string, source: string, retention: string, reason: string): Surface =>
  ({ kind, source, retention, permission: 'Workspace browser session', reason })

const places = {
  overview: browser('overview', 'Notices, requests and work activity', 'Current and retained notices', 'Overview summary reads are pending'),
  board: work,
  chat,
  manager: { ...chat, reason: 'Exact Manager Chat metadata' },
  editor: browser('document', 'Editor versions, reviews and publication bindings', 'Current document and retained versions', 'Document reads are pending'),
  observe: work,
  settings: browser('settings', 'Workspace settings and readiness', 'Current effective configuration', 'Settings reads are pending'),
} satisfies Record<Place, Surface>

const parts = {
  tasks: work,
  behaviors: { ...work, reason: 'Issue-targeted chain receipts' },
  github: { ...work, reason: 'Issue mirror and recorded PR observations' },
  logging: browser('logging', 'Gateway Logging and workspace diagnostic evidence', 'Source retention and coverage windows', 'Logging reads are pending'),
} satisfies Record<Part, Surface>

const settings = {
  general: browser('settings', 'Workspace configuration and release state', 'Current applied configuration', 'General settings reads are pending'),
  accounts: browser('accounts', 'Connected account readiness and device state', 'Current account and live device state', 'Account reads are pending'),
  models: browser('models', 'Model catalog and provider readiness', 'Latest model checks', 'Model reads are pending'),
  extensions: browser('extensions', 'Workspace extension registrations', 'Current registrations', 'Extension metadata reads are pending'),
  publishing: browser('publishing', 'Editor publication bindings', 'Current bindings and retained reviews', 'Publishing reads are pending'),
  behaviors: browser('behavior-settings', 'Configured Behaviors and policy', 'Current applied settings', 'Behavior settings reads are pending'),
  snippets: browser('snippets', 'Scoped workspace snippets', 'Current snippets', 'Snippet reads are pending'),
  admin: { ...browser('infrastructure', 'Gateway operator diagnostics', 'Current health and retained diagnostic windows',
    'Operator-only surface'), permission: 'Instance admin' },
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
  'handled-log': browser('handling-event', 'Retained handling activity', 'Handling history retention', 'Handling history reads are pending'),
  'publication-reviews': browser('publication-review', 'Editor review records', 'Retained publication reviews', 'Publication review reads are pending'),
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

export function mcpInventory(artifacts = false) {
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
      entry('chat/artifacts', placeHref('chat'), { kind: 'chat-artifact', source: 'Recorded Chat attachments and diffs',
        retention: 'Retained upload records and journal events', permission: 'Separate Chat artifact consent',
        ...(artifacts ? { tool: 'poise_get' } : {}), reason: artifacts ? 'Exact artifact ID under the owning Chat' : 'Requires separate Chat artifact consent' }),
    ],
  }
}
