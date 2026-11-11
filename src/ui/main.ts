// The new interface (#556). In order: the watchers, then the returns from
// Extensions' and Google's sign-ins, then the place the address names.
import './tokens.css'
import './components.css'
import './states.css'
import './narrow.css'
import { watchForUpdates } from '../updating'
import { watchForSignOut } from '../signed-out'
import { installSelfUpdateWatch } from '../self-update-watch'
import { initMotion } from '../motion'
import { initClaudeAuth } from '../claude-auth'
import { finishGoogleConnection } from '../google'
import { noticeFeed } from '../notices'
import { finishExtensionSignIn } from './extension-return'
import { applySavedStyle, installStylePanel } from './style-panel'
import { installIcons } from './icons'
import { installReference } from './reference'
import { mountFrame, toast } from './shell'
import { installStates } from './states'
import { go, startRouter } from './router'
import { placeHref } from './address'

// 1. Before anything asks the server: an answer the gateway marks as updating
// dims the page, a sign-in that ended says so once, and the self-update watch
// polls at once, so the first two must already be watching.
watchForUpdates()
watchForSignOut()
installSelfUpdateWatch()

initMotion()
applySavedStyle()
installIcons()

;(async () => {
  // 2. An Extensions sign-in returns to /extensions/oauth, then Google's to its
  // own query; each is finished before anything else reads the address.
  const extension = await finishExtensionSignIn()
  const google = extension ? null : await finishGoogleConnection()
  if (google === 'publish') history.replaceState(null, '', `${location.pathname}${placeHref('editor')}`)
  if (google === 'accounts') history.replaceState(null, '', `${location.pathname}${placeHref('settings', { settings: 'accounts' })}`)

  // 3. The frame, once, and the place the address names under it.
  const host = document.getElementById('ui')!
  const placeRoot = mountFrame(host)
  installReference()
  installStylePanel(placeHref('settings', { settings: 'style' }))
  installStates(go)
  initClaudeAuth()
  noticeFeed.start()
  startRouter(placeRoot)
  if (extension) toast(extension.text, extension.tone === 'error' ? 'failed' : 'done')
})()
