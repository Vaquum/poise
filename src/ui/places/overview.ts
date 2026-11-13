// Overview, the first place (#556; the mocks' Cockpit, overview.html): what
// wants you on the left, answerable in place; the work in motion, the day's
// numbers, the Manager, the behaviors and the API quota on the right. Each
// part reads what classic reads, and its reads start and stop with the place.
import './overview.css'
import './overview/registry'
import { getBehaviorDiagnostics, isBehaviorStateLoaded, refreshState } from '../../behaviors'
import { placeSettings } from '../../config'
import { noticeFeed } from '../../notices'
import type { ChainAttentionRow } from '../../notification-items'
import { placeHref } from '../address'
import { $ } from '../dom'
import { hydrateIcons } from '../icons'
import type { MountPlace } from '../router'
import { routeBack } from '../shell'
import { mountAnswers } from './overview/answers'
import { mountBehaviors } from './overview/behaviors'
import { mountDay } from './overview/day'
import { mountHealth } from './overview/health'
import { mountManager } from './overview/manager'
import { mountMotion } from './overview/motion'
import { rightFilter } from './overview/find'
import { mountQuota } from './overview/quota'
import type { ChainLike } from './overview/states'
import { json, reason, whileVisible } from './overview/util'

const health = (ref: string, href: string, label: string, value = '<span class="osmall-v">—</span>') =>
  `<a class="osmall ohealth" href="${href}" data-ref="${ref}"><span class="otile-l">${label}</span>${value}<span class="t-gloss">Not read yet</span></a>`

function layoutHTML(): string {
  return `<main class="ova">
    <aside class="ova-answer" aria-label="Answer here" data-answers>
      <div class="ova-ah">
        <div class="ova-top"><h1 tabindex="-1" data-ref="ov.answer">Answer here <span class="ocount" data-ncount data-ref="ov.count-open">0</span></h1><p class="oheld is-none" data-held data-ref="ov.held" aria-live="polite"></p></div>
        <p class="t-gloss">Everything that wants you, with the answer on it.</p>
        <div class="ova-level"><span class="t-micro">Show</span><div data-levelbox></div></div>
      </div>
      <div class="ova-list" data-nlist></div>
    </aside>

    <div class="ova-main" data-scroll>
      <header class="ova-head">
        <div class="ova-title"><h2 data-ref="nav.overview">Overview</h2><span class="t-gloss" data-when></span></div>
        <a class="back" href="#" data-back hidden data-ref="back"></a>
        <div class="ova-ctl" role="group" aria-label="Filters for this side" data-ref="ov.filters"><div data-dayctl></div><input class="search" type="search" placeholder="Filter…" aria-label="Filter this side" autocomplete="off" data-find data-ref="ov.find"><div data-orgctl></div></div>
      </header>

      <section class="ova-row" aria-label="Now">
        <div class="ocard ova-motion" data-ref="ov.motion">
          <h3 class="ocard-h"><span class="t-micro">In motion</span><span class="t-gloss" data-livenote="motion">live · choose a state to list it</span></h3>
          <div class="ova-counts"><span class="t-gloss">Chats and workers</span><div data-counts="people"></div><span class="t-gloss">Issues and pull requests</span><div data-counts="items"></div><span class="t-gloss">Tasks, by phase</span><div data-phases></div></div>
          <ul class="owork" data-worklist></ul>
          <div data-motionfail></div>
        </div>
      </section>

      <section class="ova-sec" aria-labelledby="h-health" data-health>
        <h3 class="ova-sh" id="h-health"><span class="t-micro">System health</span><span class="t-gloss" data-livenote="health">live · the last 24 hours of v2 chain work · each card opens its evidence</span></h3>
        <div data-healthfail></div><div data-healthnone></div>
        <div class="ohealths" data-ref="ov.health">
          ${health('ov.h.errors', placeHref('observe', { part: 'logging', back: 'overview' }), 'Errors per completed work item')}
          ${health('ov.h.blocked', placeHref('observe', { part: 'tasks', which: 'attention', back: 'overview' }), 'Work blocked')}
          ${health('ov.h.recovery', placeHref('observe', { part: 'tasks', back: 'overview' }), 'Recovered by itself')}
          ${health('ov.h.lasterror', placeHref('observe', { part: 'logging', back: 'overview' }), 'Since the last work error')}
          ${health('ov.h.coverage', placeHref('observe', { part: 'logging', data: '1', back: 'overview' }), 'Evidence coverage', '<ul class="hcov"></ul>')}
        </div>
      </section>

      <section class="ova-sec" aria-labelledby="h-day">
        <h3 class="ova-sh" id="h-day"><span class="t-micro">The day</span><span class="t-gloss" data-dayline></span><span class="t-gloss ova-hint">Drag a tile, or press Alt with an arrow key, to reorder</span></h3>
        <div data-dayfail></div>
        <div class="ova-tiles" data-tiles data-ref="ov.tiles"></div>
        <div class="ova-detail" data-detail hidden></div>
      </section>

      <section class="ova-sec" aria-labelledby="h-pr">
        <h3 class="ova-sh" id="h-pr"><span class="t-micro">Per merged pull request</span><span class="t-gloss">medians against the 7 days before</span></h3>
        <div class="ova-small" data-perpr></div>
      </section>

      <section class="ova-sec ova-three" aria-label="Work, review and the Manager">
        <div class="ocard" data-worktype></div>
        <div class="ocard" data-friction></div>
        <div class="ocard ova-mgr" data-mgr>
          <h3 class="ocard-h"><span class="t-micro" data-ref="mgr">The Manager</span><span class="t-gloss">same settings as its controls</span></h3>
          <div data-mgrbox></div>
        </div>
      </section>

      <section class="ova-sec" aria-labelledby="h-beh">
        <h3 class="ova-sh" id="h-beh"><span class="t-micro">Behaviors</span><span class="t-gloss">what Poise did on its own</span></h3>
        <div data-behaviors></div>
      </section>

      <section class="ova-sec" aria-labelledby="h-api">
        <h3 class="ova-sh" id="h-api"><span class="t-micro">GitHub API</span><span class="t-gloss">live, every 15 seconds, whatever the day</span></h3>
        <div data-quota></div>
      </section>
    </div>
  </main>`
}

export const mount: MountPlace = async (ctx) => {
  // Days begin at midnight in Settings' time zone, and the organizations are Settings': read them first.
  await placeSettings()
  if (ctx.signal.aborted) return
  const { root, address } = ctx
  root.innerHTML = layoutHTML()
  hydrateIcons(root)
  routeBack($('[data-back]', root), address)
  const main: HTMLElement = $('.ova-main', root)

  // One time filter (the day) and one search for everything on this side (#1380).
  const find = rightFilter($('[data-find]', root) as HTMLInputElement, ctx.signal)
  const motion = mountMotion(ctx, $('.ova-motion', root), find)
  const behaviors = mountBehaviors(ctx, $('[data-behaviors]', root), find)
  const manager = mountManager(ctx, $('[data-mgrbox]', root), motion.sessions)
  const answers = mountAnswers(ctx, $('[data-answers]', root), {
    role: (chat) => motion.role(chat),
    onEntries: (entries) => behaviors.entriesChanged(entries),
    chainsChanged: () => { void readChains() },
  })
  motion.onSessions(() => { manager.sessionsChanged(); answers.diagnosticsChanged() })
  // Live panels say when they are not for the chosen day.
  const live: Record<string, string> = { motion: 'live · choose a state to list it', health: 'live · the last 24 hours of v2 chain work · each card opens its evidence' }
  mountDay(ctx, main, find, (day) => {
    behaviors.dayChanged(day)
    for (const note of root.querySelectorAll<HTMLElement>('[data-livenote]')) {
      const words = live[note.dataset.livenote ?? '']
      note.textContent = day.isToday ? words : `${words.replace(/^live/, 'live now')} · not for ${day.label}`
    }
  })
  mountHealth(ctx, $('[data-health]', root), find)
  mountQuota(ctx, $('[data-quota]', root), find)

  // The chain's journal feeds Answer here (work that needs attention) and In motion (tasks).
  async function readChains(): Promise<void> {
    try {
      const data = await json<{ chains?: (ChainLike & { sequence: number })[], attention?: ChainAttentionRow[] }>('/api/behavior-chains?state=active')
      if (!Array.isArray(data.chains) || !Array.isArray(data.attention)) throw new Error('the service answered with something this page cannot read')
      answers.setChains(new Map(data.chains.map((chain) => [chain.id, { sequence: chain.sequence, held: chain.held }])), data.attention)
      motion.setChains(data.chains, '', Date.now())
      noticeFeed.reportLocalNotices('overview-chains', [])
    } catch (error) {
      motion.setChains([], reason(error), 0)
      noticeFeed.reportLocalNotices('overview-chains', [{ key: 'overview-chains', title: 'Attention evidence unavailable', body: `Any entries already shown may be stale. ${reason(error)}` }])
    }
  }
  // Behaviors' state feeds the table's switches and Answer here's diagnostics.
  async function readBehaviors(): Promise<void> {
    await refreshState()
    behaviors.stateChanged(isBehaviorStateLoaded() ? '' : getBehaviorDiagnostics()?.apiError?.message ?? 'the service did not answer')
    answers.diagnosticsChanged()
  }
  whileVisible(ctx, 60_000, () => { void readChains(); void readBehaviors() })

  return () => {
    answers.leave()
    noticeFeed.reportLocalNotices('overview-chains', [])
  }
}
