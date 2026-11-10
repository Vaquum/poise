import { escapeHtml } from '../markdown'
import type { BehaviorCutoverState } from '../behavior-cutover'
import type { ProcessDiagnostic } from '../../server/process-diagnostic'

interface FailureEvidence {
  diagnostic?: ProcessDiagnostic
  publicationPlan?: { callId: string, recoveredAt: number | null }
}
interface ChainRow {
  id: string, repository: string, issue: number, sequence: number, held: string | null, waiting: string | null,
  mergeSha: string | null, reviewPending?: boolean | null, reviewStatus?: 'pending' | 'complete' | 'not-recorded', pullNumber: number | null,
  supersession?: { covering: Array<{ number: number, mergeSha: string }>, failures: Array<{ id: number }>, recovery: { id: number } } | null,
  reconciliation?: { nextObservationAt: number | null, waitingForOriginalResponse: boolean, waitingForResourceRelease?: boolean } | null,
  invocations: Array<{ behavior: string, state: string, outcome?: string | null, callId?: string | null, evidence?: FailureEvidence | null,
    nativeAction?: { attribution: string, outcome: string | null } | null }>
}
interface JournalEvent { sequence: number, at: number, type: string, reason?: string, outcome?: string, callId?: string | null, evidence?: FailureEvidence }

function failureDetails(callId?: string | null, evidence?: FailureEvidence | null): string {
  const call = callId ? ` · Call ${callId}` : ''
  const diagnostic = evidence?.diagnostic
  if (!diagnostic || (diagnostic.operation !== 'merge_if_ready' && diagnostic.phase !== 'native_action')) return call
  const submission = diagnostic.context.submission
  const known = submission === 'none' || submission === 'rejected'
  return `${call} · ${submission === 'none' ? 'Request not sent' : submission === 'rejected' ? 'Request rejected' : 'Action outcome unknown'} · Cause: ${diagnostic.stderr || diagnostic.context.message || 'cause unknown'} · Next: ${known
    ? 'address the cause; normal admission checks and retry backoff still apply.'
    : 'reconcile the original Call response; do not enqueue again.'}`
}

export function behaviorChainLogging() {
  const element = document.createElement('section')
  element.className = 'tp-section'
  element.setAttribute('aria-label', 'Behavior chain evidence')
  element.innerHTML = `<div class="tp-group-label">Behavior chain</div>
    <button type="button" class="st-clear" data-chain-refresh>Refresh chains</button>
    <p role="status" data-chain-status></p><p role="status" data-cutover-status>Reading behavior admission state…</p>
    <p data-chain-capacity>Atomic behavior capacity has not been read.</p>
    <details data-legacy hidden><summary>Legacy PR ownership retained at cutover</summary><ul></ul></details>
    <p class="st-help">Hold pauses future invocations; it does not stop a running worker. Use its existing Stop control to stop it.</p>
    <ul data-chain-list></ul><button type="button" class="st-clear" data-chain-more hidden>More chains</button>
    <section aria-label="Chain journal" hidden><p data-history-title></p><ol data-history></ol><button type="button" class="st-clear" data-history-more hidden>More events</button></section>`
  const status = element.querySelector<HTMLElement>('[data-chain-status]')!
  const list = element.querySelector<HTMLElement>('[data-chain-list]')!
  const more = element.querySelector<HTMLButtonElement>('[data-chain-more]')!
  const history = element.querySelector<HTMLElement>('[aria-label="Chain journal"]')!
  const historyMore = element.querySelector<HTMLButtonElement>('[data-history-more]')!
  let cutover: BehaviorCutoverState | null = null
  let reading = false
  let next: string | null = null
  let rows: ChainRow[] = []
  let historyId = ''
  let historyNext: number | null = null
  let historyGeneration = 0
  element.querySelector('[data-chain-refresh]')!.addEventListener('click', () => { void refresh() })
  more.addEventListener('click', () => { void refresh(true) })
  list.addEventListener('click', (event) => { void (async () => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-chain-id]')
    if (!button) return
    if (button.dataset.operation === 'history') { await readHistory(button.dataset.chainId!); return }
    if (!cutover) { status.textContent = 'Refresh chains before changing their controls.'; return }
    button.disabled = true
    try {
      const response = await fetch('/api/behavior-chains', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: button.dataset.chainId, sequence: Number(button.dataset.sequence), operation: button.dataset.operation }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      await refresh()
    } catch (error) { status.textContent = `Chain control was not applied: ${(error as Error).message}`; button.disabled = false }
  })() })
  historyMore.addEventListener('click', () => { void readHistory(historyId, true) })
  async function readHistory(id: string, append = false, startAfter?: number): Promise<void> {
    const generation = ++historyGeneration
    const after = append ? historyNext : (startAfter ?? 0)
    historyMore.disabled = true
    try {
      const response = await fetch(`/api/behavior-chains?${new URLSearchParams({ id, after: String(after ?? 0) })}`)
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.events)) throw new Error(data.error || `HTTP ${response.status}`)
      if (generation !== historyGeneration) return
      if (data.next !== null && (!Number.isSafeInteger(data.next) || data.next <= (after ?? 0))) throw new Error('Journal cursor did not advance')
      historyId = id; historyNext = data.next; history.hidden = false
      history.querySelector('[data-history-title]')!.textContent = `v2 journal · ${id}`
      const html = data.events.map((event: JournalEvent) => `<li>${escapeHtml(new Date(event.at).toLocaleString())} · ${escapeHtml(event.type)}${event.reason || event.outcome ? ` · ${escapeHtml(event.reason || event.outcome || '')}` : ''}${escapeHtml(failureDetails(event.callId, event.evidence))}</li>`).join('')
      const events = history.querySelector('[data-history]')!
      if (append) events.insertAdjacentHTML('beforeend', html); else events.innerHTML = html || '<li>No journal events.</li>'
      historyMore.hidden = historyNext === null
      if (!append) history.scrollIntoView({ block: 'nearest' })
    } catch (error) { if (generation === historyGeneration) status.textContent = `Journal could not be read: ${(error as Error).message}` }
    finally { if (generation === historyGeneration) historyMore.disabled = false }
  }
  async function refresh(append = false): Promise<void> {
    if (reading) return
    reading = true; more.disabled = true
    const after = append ? next : null
    const previousCount = append ? 0 : rows.length
    try {
      const response = await fetch(`/api/behavior-chains${after ? `?after=${encodeURIComponent(after)}` : ''}`)
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.chains)) throw new Error(data.error || `HTTP ${response.status}`)
      if (data.next !== null && (typeof data.next !== 'string' || data.next <= (after ?? ''))) throw new Error('Chain cursor did not advance')
      let chains = data.chains
      let cursor = data.next
      // A refresh must not drop pages loaded through More chains: re-read
      // until the fresh list covers what was shown.
      while (!append && chains.length < previousCount && cursor) {
        const page = await fetch(`/api/behavior-chains?after=${encodeURIComponent(cursor)}`)
        const paged = await page.json()
        if (!page.ok || !Array.isArray(paged.chains)) throw new Error(paged.error || `HTTP ${page.status}`)
        if (paged.next !== null && (typeof paged.next !== 'string' || paged.next <= cursor)) throw new Error('Chain cursor did not advance')
        cursor = paged.next
        chains = [...chains, ...paged.chains]
        if (paged.chains.length === 0) break
      }
      next = append ? data.next : cursor
      rows = append ? [...rows, ...data.chains] : chains
      more.hidden = !next
      cutover = data.cutover ?? null
      const legacy = element.querySelector<HTMLDetailsElement>('[data-legacy]')!
      legacy.hidden = !cutover?.legacyPulls.length
      legacy.querySelector('ul')!.innerHTML = (cutover?.legacyPulls ?? []).map((target) => {
        const match = /^([-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+)#([1-9][0-9]*)$/.exec(target)
        return `<li>v1 · ${match ? `<a href="https://github.com/${escapeHtml(match[1])}/pull/${match[2]}">${escapeHtml(target)}</a>` : escapeHtml(target)}</li>`
      }).join('')
      element.querySelector('[data-cutover-status]')!.textContent = !cutover ? 'Admission state unavailable' : cutover.mode === 'v2'
        ? `v2 owns new work · legacy PRs at cutover: ${cutover.legacyPulls.length}`
        : cutover.mode === 'draining' ? `Draining behaviors · ${(data.cutover.blockers as string[]).join('; ') || 'Verifying the legacy ownership boundary'}` : 'v1 owns new work'
      const capacity = data.capacity
      element.querySelector('[data-chain-capacity]')!.textContent = capacity?.status === 'available'
        ? `v2 chains: ${capacity.reservedModelInvocations} durable model admission(s) reserved · ceiling ${capacity.modelInvocationLimit} (shared with other heavy work).${capacity.processLocal ? ` Process-local behavior runs: ${capacity.processLocal.behaviorRunning}; these counts are not additive.` : ''} Mode: ${capacity.mode ?? 'not recorded'}. ${capacity.enabled ? 'Effective intake' : 'Saved intake (inactive)'}: ${capacity.intake?.seedMode === 'all' ? 'all issues' : `label ${capacity.intake?.label}`}. ${capacity.enabled ? 'Admissions enabled.' : 'Admissions paused.'} Manager worker-Chat capacity is separate.`
        : `Atomic behavior capacity unavailable${capacity?.error ? `: ${capacity.error}` : '.'}`
      list.innerHTML = rows.map((chain) => {
        const active = chain.invocations.find(invocation => invocation.state !== 'settled')
        const last = chain.invocations[chain.invocations.length - 1]
        const plan = (active ?? last)?.evidence?.publicationPlan
        const planStatus = !plan ? '' : plan.recoveredAt === null
          ? ` · Original Call ${plan.callId}: original publication plan is missing; publication evidence remains unverified. Restore the original Caller plan and let reconciliation validate it; do not retry publication.`
          : ` · Original publication plan recovered for Call ${plan.callId}; publication and resource-release checks still apply.`
        const githubTarget = /^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(chain.repository) && Number.isSafeInteger(chain.issue)
        const github = githubTarget
          ? `<a href="https://github.com/${escapeHtml(chain.repository)}/issues/${chain.issue}">#${chain.issue}</a>` : escapeHtml(chain.id)
        const complete = !!chain.supersession || !!chain.mergeSha && !chain.reviewPending
        const progress = active ? `${active.behavior}: ${active.state}${active.outcome ? ` · ${active.outcome}` : ''}`
          : chain.waiting || 'Awaiting the next observation'
        const state = [chain.supersession ? 'Superseded; duplicate PR closed' : '', chain.mergeSha ? `Merged: ${chain.mergeSha.slice(0, 12)}` : '',
          chain.reviewPending ? 'Review evidence pending' : '',
          chain.mergeSha && (chain.reviewStatus === 'not-recorded' || chain.reviewPending == null) ? 'Pre-merge review completion not recorded' : '',
          !complete && chain.held ? `Held: ${chain.held}` : '', !complete ? progress : ''].filter(Boolean).join(' · ')
        const control = chain.mergeSha || chain.supersession ? '' : ` <button type="button" class="st-clear" data-chain-id="${escapeHtml(chain.id)}" data-sequence="${Number(chain.sequence)}" data-operation="${chain.held ? 'resume' : 'hold'}"${!cutover ? ' disabled' : ''}>${chain.held ? 'Resume' : 'Hold new invocations'}</button>`
        const supersession = chain.supersession && githubTarget ? [
          ...chain.supersession.covering.map(pull => `<a href="https://github.com/${escapeHtml(chain.repository)}/pull/${Number(pull.number)}">Covering PR #${Number(pull.number)} (${escapeHtml(pull.mergeSha.slice(0, 12))})</a>`),
          ...chain.supersession.failures.map(run => `<a href="https://github.com/${escapeHtml(chain.repository)}/actions/runs/${Number(run.id)}">Failing run</a>`),
          `<a href="https://github.com/${escapeHtml(chain.repository)}/actions/runs/${Number(chain.supersession.recovery.id)}">Recovery run</a>`,
        ].join(' · ') : ''
        const attribution = last?.nativeAction?.attribution === 'accepted-response' ? ' · original action response accepted'
          : last?.nativeAction?.attribution === 'observed-no-action' ? ' · observed; mutation not attributed'
            : last?.nativeAction?.attribution === 'not-recorded' ? ' · action attribution not recorded' : ''
        const obligation = chain.mergeSha && chain.reviewPending && !active
          ? ' · Awaiting original pre-merge review evidence; no new invocation can start after merge.' : ''
        const recheck = chain.reconciliation?.waitingForResourceRelease ? ' · Original native resource release is unverified; Caller reconciliation continues while GitHub observations are deferred.'
          : chain.reconciliation?.waitingForOriginalResponse ? ' · Original action response required; GitHub reads cannot settle this invocation.'
          : chain.reconciliation?.nextObservationAt && chain.reconciliation.nextObservationAt > Date.now()
            ? ` · Next original-evidence observation: ${new Date(chain.reconciliation.nextObservationAt).toLocaleString()}.` : ''
        const failure = active ?? last
        const details = failure?.behavior === 'merge-pr' ? failureDetails(failure.callId,
          failure.nativeAction?.attribution === 'accepted-response' ? null : failure.evidence) : ''
        return `<li>v2 · ${github}${chain.pullNumber ? ` → <a href="https://github.com/${escapeHtml(chain.repository)}/pull/${Number(chain.pullNumber)}">PR #${Number(chain.pullNumber)}</a>` : ''}: ${escapeHtml(state)}${supersession ? ` · ${supersession}` : ''}${escapeHtml(planStatus)}${escapeHtml(obligation)}${escapeHtml(recheck)}${!active && last ? ` · Last: ${escapeHtml(last.behavior)} (${escapeHtml(last.outcome || last.state)}${escapeHtml(attribution)})` : ''}${escapeHtml(details)}${control} <button type="button" class="st-clear" data-chain-id="${escapeHtml(chain.id)}" data-operation="history">History</button></li>`
      }).join('') || '<li>No behavior chains.</li>'
      const errors = Array.isArray(data.runtime) ? data.runtime.filter((entry: { error: string | null }) => entry.error).map((entry: { organization: string, error: string }) => `${entry.organization}: ${entry.error}`).join('; ') : ''
      status.textContent = `Read ${new Date().toLocaleTimeString()}${errors ? ` · ${errors}` : ''}`
    } catch (error) {
      cutover = null
      for (const button of list.querySelectorAll<HTMLButtonElement>('button[data-operation="hold"], button[data-operation="resume"]')) button.disabled = true
      element.querySelector('[data-chain-capacity]')!.textContent = 'Atomic behavior capacity unavailable.'
      element.querySelector('[data-cutover-status]')!.textContent = 'Admission state unavailable'
      status.textContent = `Chains could not be refreshed: ${(error as Error).message}`
    } finally { reading = false; more.disabled = false }
  }
  return { element, refresh, readHistory }
}
