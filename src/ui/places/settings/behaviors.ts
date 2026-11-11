// Settings → Behaviors (#556; SETTINGS.md, B1–B9): classic's Behaviors view,
// copied without the Settings panel it opened (classic/behaviors-view.ts),
// and the chain that carries an issue to its merge, under Issue to merge
// (views/behavior-chain-settings.ts, which classic kept in General).
import { esc } from '../../dom'
import type { AppSettings } from '../../../config'
import { behaviorChainSettings } from '../../../views/behavior-chain-settings'
import { initBehaviorsView, stopBehaviorsRefresh } from './classic/behaviors-view'
import { keptView, putAway } from './keep'
import type { SectionDef } from './types'

let chain: ReturnType<typeof behaviorChainSettings> | null = null

export const BEHAVIORS: SectionDef = {
  key: 'behaviors',
  name: 'Behaviors',
  what: 'Work Poise does on GitHub on its own: each behavior with its switch, where it acts and what it remembers, and the chain that carries an issue to its merge. How often they run, and how well, is in Overview.',
  findText: 'behaviors behavior review approve merge rerun ci issues implement repair chain engine v1 v2 pause memory reviewers skip label intake capacity',
  mount: async (body, ctx) => {
    const { el } = keptView('view-behaviors')
    el.hidden = false
    chain ??= behaviorChainSettings()
    const { el: group, fresh } = keptView('settings-chain', 'section', 'sgrp set-chain')
    if (fresh) {
      group.dataset.chainSettings = ''
      group.innerHTML = `<h2 class="t-micro">${esc('Issue to merge')}</h2>`
      group.append(chain.element)
    }
    body.append(el, group)
    chain.update(ctx.known() as unknown as AppSettings)
    void chain.refresh()
    await initBehaviorsView()
    return () => { stopBehaviorsRefresh(); putAway(el); putAway(group) }
  },
}
