import { finishGoogleConnection } from './google'
import './style.css'
import './motion.css'
import { finishMotion, initMotion, reveal } from './motion'
initMotion()
import { installIconTooltips } from './icon-tooltips'
installIconTooltips()
import { initTypography, toggleTypographyPanel, closeTypographyPanel } from './typo'
import { initSettings, openSettingsPanel, openSettingsAt, closeSettingsPanel, isFullyConfigured } from './settings'
import { initMenu } from './menu'
import { initAnalyticsView, prepareAnalyticsView, stopAnalyticsRefresh } from './views/analytics-view'
import { initLoggingView, refreshLoggingView, stopLoggingRefresh } from './views/logging-view'
import { loggingCallId, loggingHref, type LoggingLink } from './logging'
import { initMainView, refreshMainView, stopMainRefresh } from './views/main-view'
import { initCurrentView, stopCurrentPolling } from './views/current-view'
import { initSwarmView, stopSwarmRefresh, focusRow as focusSwarmRow, focusCall as focusSwarmCall } from './views/swarm-view'
import { initChatView, stopChatRefresh, openChatSession, openChatWithContext, chatSessionInView, type NewSessionPrefill } from './views/chat-view'
import { initBehaviorsView, stopBehaviorsRefresh } from './views/behaviors-view'
import { initSnippetsView } from './views/snippets-view'
import { initEditorView, stopEditorRefresh } from './views/editor-view'
import { toggle as toggleChat, close as closeChatPane } from './views/chat-pane'
import { loadSettings, startRefreshTicker, applyTheme, getTheme } from './config'
import { initClaudeAuth } from './claude-auth'
import { getSelectedOrganization, setSelectedOrganization } from './organizations'
import { initServiceSettings, openServicePlace, takeServicePlace } from './service-settings'
import { restartOnboarding, startOnboarding } from './onboarding'
import { watchForUpdates } from './updating'
import { watchForSignOut } from './signed-out'
import { noticeFeed, type NoticeTarget } from './notices'
import { mountNotificationRail } from './views/notification-rail'
import './views/notification-rail.css'
import './views/updating.css'
import './views/editor-publish.css'
import './views/editor-reviews.css'
import './views/google-documents.css'

const viewMainEl = document.getElementById('view-main')!
const viewCurrentEl = document.getElementById('view-current')!
const viewSwarmEl = document.getElementById('view-swarm')!
const viewChatEl = document.getElementById('view-chat')!
const viewBehaviorsEl = document.getElementById('view-behaviors')!
const viewSnippetsEl = document.getElementById('view-snippets')!
const viewEditorEl = document.getElementById('view-editor')!
const viewAnalyticsEl = document.getElementById('view-analytics')!
const viewLoggingEl = document.getElementById('view-logging')!

const visitedViews = new WeakSet<HTMLElement>()

type ViewSlug = 'main' | 'current' | 'swarm' | 'chat' | 'behaviors' | 'snippets' | 'editor' | 'analytics' | 'logging'

function showView(v: ViewSlug) {
  const all = [viewMainEl, viewCurrentEl, viewSwarmEl, viewChatEl, viewBehaviorsEl, viewSnippetsEl, viewEditorEl, viewAnalyticsEl, viewLoggingEl]
  if (v !== 'logging') {
    const url = new URL(location.href)
    if (url.searchParams.get('view') === 'logging') {
      for (const key of ['view', 'event', 'incident', 'from', 'to']) url.searchParams.delete(key)
      history.replaceState(null, '', url)
    }
  }
  const target =
      v === 'main'      ? viewMainEl
    : v === 'current'   ? viewCurrentEl
    : v === 'swarm'     ? viewSwarmEl
    : v === 'chat'      ? viewChatEl
    : v === 'behaviors' ? viewBehaviorsEl
    : v === 'snippets'  ? viewSnippetsEl
    : v === 'analytics' ? viewAnalyticsEl
    : v === 'logging'   ? viewLoggingEl
    :                     viewEditorEl

  // Polling stays attached across view changes — every view that has
  // been visited at least once keeps fetching on every `poise:refresh-
  // tick`, so a row whose status flips from running → completed (or
  // whose time-elapsed advances) reflects on its next tick whether or
  // not its view is the one currently on screen. Returning to a view
  // therefore shows fresh data instantly rather than waiting for an
  // entry-fetch to land. The init functions are idempotent — each
  // guards its tick-listener with a boolean so re-entering doesn't
  // attach duplicates.
  //
  // Editor leave-cleanup pauses publication reviews, flushes pending
  // autosaves, closes the doc picker, and restores the writer-mode chrome.
  // All of those are essential on leaving the editor; keep the call.
  if (v !== 'editor')    stopEditorRefresh()
  // Behaviors needs the same leave-cleanup. stopBehaviorsRefresh existed and
  // was documented but nothing ever called it, so its memory panel stayed open
  // over whatever view came next — a Behaviors draft floating over the editor —
  // and its refresh tick kept fetching /api/behaviors for the rest of the
  // session while the view was hidden.
  if (v !== 'behaviors') stopBehaviorsRefresh()
  // Swarm had the same unused stop. After one visit it kept polling for the
  // rest of the session: every tick spawned an `agent-interface --logs`
  // subprocess, fetched the whole log and rebuilt a table of a thousand rows
  // nobody was looking at, on the main thread, while the user typed elsewhere.
  if (v !== 'swarm') stopSwarmRefresh()
  // And Current, the third view with an exported stop that nothing called.
  if (v !== 'current') stopCurrentPolling()
  // And Archive, the fourth and last. Every view in this app shipped a
  // leave-cleanup that nothing invoked.
  if (v !== 'main') stopMainRefresh()
  // Analytics' quota refresh and midnight re-read stop with the view.
  if (v !== 'analytics') stopAnalyticsRefresh()
  if (v !== 'logging') stopLoggingRefresh()
  // Chat keeps its socket (a running turn keeps being mirrored) but stops
  // the per-second tick and parks the composer draft.
  if (v !== 'chat') stopChatRefresh()
  // The chat pane is bound to whatever card or document opened it, so it does
  // not belong to the next view. It had no leave-cleanup at all: it stayed
  // open over whatever came next, kept polling for the rest of the session,
  // and its composer stayed in the tab order — so a message could be sent
  // into a conversation the person had navigated away from.
  closeChatPane()

  // Initialize the target first so content exists before the animation starts
  if (v === 'main')           initMainView()
  else if (v === 'current')   initCurrentView()
  else if (v === 'swarm')     initSwarmView()
  else if (v === 'chat')      void initChatView()
  else if (v === 'behaviors') initBehaviorsView()
  else if (v === 'snippets')  initSnippetsView()
  else if (v === 'analytics') initAnalyticsView()
  else if (v === 'logging')   initLoggingView()
  else                        initEditorView()

  for (const el of all) {
    if (el === target) {
      el.hidden = false
      if (!visitedViews.has(el)) for (const child of el.querySelectorAll<HTMLElement>(':scope > :not(.view-header)')) reveal(child, { distance: v === 'chat' || v === 'editor' ? 0 : 20 })
    } else {
      finishMotion(el, true)
      el.hidden = true
    }
  }
  visitedViews.add(target)
  window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
}

// Apply the saved theme as early as possible so the first paint matches
// the user's preference (no light → dark flash on dark-mode boots).
applyTheme(getTheme())

// Avatars fall back to a styled placeholder when the image 404s — a GitHub App
// has no `<login>.png`, for instance. That was an inline onerror attribute,
// which production's `script-src 'self'` blocks outright, so in production the
// fallback never ran and a broken-image icon showed instead. `error` does not
// bubble, so this listens in the capture phase, once, for every avatar in the
// app.
document.addEventListener('error', (e) => {
  const el = e.target as HTMLElement | null
  if (el?.tagName === 'IMG' && el.classList.contains('last-avatar')) el.classList.add('broken')
}, true)

initClaudeAuth()

// Init order: typography → settings → menu → initial view
initTypography()
initSettings()

const menu = initMenu({
  onSelectView: (v) => showView(v),
  onOpenTypography: () => toggleTypographyPanel(),
  onOpenSettings: (section) => openSettingsAt(section),
  // Leaving first makes even a repeat choice arrive afresh, on Today.
  onOpenAnalytics: () => { stopAnalyticsRefresh(); menu.switchTo('analytics') },
  onClosePanels: () => { closeTypographyPanel(); closeSettingsPanel() },
})

// The notification rail beside the page, and where each notice in it takes
// the person.
const notices = noticeFeed
function openNotice(target: NoticeTarget): void {
  if ('view' in target) menu.switchTo(target.view)
  else if ('swarm' in target) {
    if (menu.currentView() !== 'swarm') menu.switchTo('swarm')
    void focusSwarmCall(target.swarm)
  }
  else if ('settings' in target) openSettingsAt(target.settings)
  else if ('chat' in target) window.dispatchEvent(new CustomEvent('poise:open-chat-session', { detail: { id: target.chat } }))
  else window.open(target.pullRequest, '_blank', 'noopener,noreferrer')
}
// A Chat session on screen already shows what its notice would say.
const notificationRail = mountNotificationRail(notices, { open: openNotice, inView: (target) => 'chat' in target && chatSessionInView() === target.chat })
window.addEventListener('poise:notifications-changed', () => { void notices.refresh() })

// On load: pull settings first so views render with the correct org/me/timezone,
// then show the initial view. The user's external service keeps the data
// fresh; Poise only reads.
// Before anything asks the server: an answer the gateway marks as updating
// dims the page until the new version is up.
watchForUpdates()
// A sign-in in front of Poise that has ended turns every request away; the
// page then says so once, instead of failing view by view. Only a gateway or a
// login proxy turns requests away like that, so a personal computer never sees
// it. Installed at once, not after a first answer that may itself fail.
watchForSignOut()

;(async () => {
  const initialView = menu.currentView()
  const logging = new URLSearchParams(location.search).get('view') === 'logging'
  // Personal documents and snippets do not depend on GitHub settings.
  const openedEarly = !logging && (initialView === 'editor' || initialView === 'snippets')
  if (openedEarly) showView(initialView)
  const [googleReturned] = await Promise.all([finishGoogleConnection(), loadSettings()])
  if (logging) menu.switchTo('logging')
  else if (!openedEarly || menu.currentView() !== initialView) showView(menu.currentView())
  prepareAnalyticsView()
  // Single shared refresh clock — every view listens for poise:refresh-tick
  // and refreshes on it. Wall-clock-aligned so switching views never causes
  // an off-cycle re-fetch. (Behaviors run server-side on their own
  // wall-clock ticker — see server/behaviors.ts.)
  startRefreshTicker()
  notices.start()
  notificationRail.start()
  void initServiceSettings({
    runSetup: () => {
      restartOnboarding().catch((error: unknown) => console.error('[setup] setup could not start again:', error))
    },
  })

  // The gateway sends Poise Link's /link here as /?settings=link.
  const place = takeServicePlace()
  // A workspace that still has to be set up opens first-run setup instead, at
  // pairing when Poise Link sent the person here.
  if (googleReturned) { openSettingsAt('accounts'); return }
  if (await startOnboarding(place)) return
  if (place) {
    void openServicePlace(place)
    return
  }
  const ready = await isFullyConfigured()
  if (!ready) openSettingsPanel()
})()

// When settings saves and triggers a refresh, re-init the open view to
// pull fresh data through whatever cache layer it uses.
// Saving settings re-scopes the data every view reads, so each view needs to
// pull again. showView() does that by re-running the view's init — which for
// the editor means tearing down and rebuilding the surface, taking the undo
// stack and the cursor with it. Someone who saves a setting mid-draft should
// not lose their history for it. The editor re-reads on its own next save
// cycle and does not depend on org/me, so leave it alone; refresh the rest.
window.addEventListener('poise:synced', () => {
  const v = menu.currentView()
  // Startup reads the durable target after Settings resolves; this earlier
  // Settings notification must not mount a different view and discard it.
  if (v !== 'logging' && new URLSearchParams(location.search).get('view') === 'logging') return
  if (v === 'main') refreshMainView()
  else if (v === 'logging') refreshLoggingView()
  else if (v === 'editor') { /* nothing here is scoped by org/me */ }
  else showView(v)
})

// Card chat icon → toggle the chat pane bound to that card's session.
// Clicking the same card's icon again closes the pane; switching to a
// different card swaps the conversation in place. Hosts that want
// JSON-edit-card rendering (currently: the editor's toolbar chat)
// pass parseEdits=true in the event detail and may also supply hover
// / accept / decline callbacks so the host can react to user gestures
// on cards (highlight in surface, apply to surface, etc.); everyone
// else leaves them unset and gets plain prose rendering.
window.addEventListener('poise:open-chat', (ev) => {
  const detail = (ev as CustomEvent<{
    session: string,
    label: string,
    draft?: string,
    parseEdits?: boolean,
    onEditHover?: (edit: any) => void,
    onEditLeave?: () => void,
    onEditAccept?: (edit: any, key: string) => 'applied' | 'conflict',
    onEditDecline?: (edit: any, key: string) => void,
  }>).detail
  if (!detail) return
  toggleChat(detail.session, detail.label, detail.draft, {
    parseEdits: detail.parseEdits,
    onEditHover: detail.onEditHover,
    onEditLeave: detail.onEditLeave,
    onEditAccept: detail.onEditAccept,
    onEditDecline: detail.onEditDecline,
  })
})

// Chat handoffs. `{ id }` opens an existing session (Swarm's Target column);
// `{ context, repo, branch }` opens the New session dialog prefilled from a
// Current card or an Editor document, so the person confirms agent, model
// and branch before anything runs.
window.addEventListener('poise:open-chat-session', (ev) => {
  const detail = (ev as CustomEvent<{ id?: string } & NewSessionPrefill>).detail
  if (!detail) return
  menu.switchTo('chat')
  window.requestAnimationFrame(() => {
    if (detail.id) void openChatSession(detail.id)
    else void openChatWithContext(detail)
  })
})

// Behaviors view → Swarm row navigation. The "Last triggered" link
// dispatches `poise:goto-swarm-row` with { repo, pr_id }; switch to
// Swarm, wait for it to mount, then ask it to focus the matching log
// entry (scroll + expand if completed).
window.addEventListener('poise:goto-swarm-row', (ev) => {
  const detail = (ev as CustomEvent<{ repo: string, pr_id: string }>).detail
  if (!detail) return
  const owner = detail.repo.split('/')[0]
  if (getSelectedOrganization() && getSelectedOrganization().toLowerCase() !== owner.toLowerCase()) setSelectedOrganization(owner)
  menu.switchTo('swarm')
  // Defer one frame so showView's animation classes have applied and
  // initSwarmView() has run before we ask for a focus.
  window.requestAnimationFrame(() => {
    void focusSwarmRow(detail.repo, detail.pr_id)
  })
})

window.addEventListener('poise:goto-swarm-call', (event) => {
  const detail = (event as CustomEvent<{ id?: unknown }>).detail
  if (typeof detail?.id !== 'string' || !loggingCallId(detail.id)) return
  menu.switchTo('swarm')
  void focusSwarmCall(detail.id)
})
window.addEventListener('poise:logging-settings', (event) => {
  const section = (event as CustomEvent<{ section?: unknown }>).detail?.section
  if (section === 'general' || section === 'models' || section === 'accounts' || section === 'publishing' || section === 'admin') openSettingsAt(section)
})
window.addEventListener('poise:open-logging', (event) => {
  const href = loggingHref((event as CustomEvent<LoggingLink>).detail ?? {})
  if (!href) return
  history.pushState(null, '', href)
  menu.switchTo('logging')
})
window.addEventListener('popstate', () => {
  if (new URLSearchParams(location.search).get('view') === 'logging' || menu.currentView() === 'logging') menu.switchTo('logging')
})

// Chat /content → editor article. The chat pane dispatches
// `poise:open-editor-doc` after agent-interface --author-content
// completes; we switch to the editor view and re-dispatch a
// `poise:editor-load-doc` event the editor view listens for.
window.addEventListener('poise:open-editor-doc', (ev) => {
  const detail = (ev as CustomEvent<{ slug: string }>).detail
  if (!detail?.slug) return
  menu.switchTo('editor')
  window.requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail }))
  })
})
