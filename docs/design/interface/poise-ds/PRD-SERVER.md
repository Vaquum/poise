### Objective

Give the server what the redesigned interface needs and does not have today.

#556 replaces Poise's interface as a frontend-only change. Everything the reviewed design shows that the server cannot supply is out of scope there, and the new interface falls back to an Open link or to less detail. This PRD is the server side of that list, so the new interface can do what the owner reviewed. On 2026-10-24 the owner asked for "a ticket in autonomio/poise for the new features you need for this", to be handed to someone to build.

References are to `main` at `a306a94`. The implementing PR re-checks them against its own base.

Without this work:

- **The Manager has none of the brief's Manager controls.** The owner's "Poise Interface and Interaction Brief" asks for "three independent Manager controls (Rhythm 1–10 worker slots, Stability ↔ Expansion, Autonomy), plus their combined effect". The server has none of them. `maxConcurrentLocalTurns` is not Rhythm: it governs ordinary local chats, and the Manager and the Switchboard skip it (`server/chat/runtime.ts:728`, `:3169`).
- **Board cannot say why a pull request is held.** For an open pull request the server reports only green or yellow (`server/gh.ts:50`). It drops every pull request that is neither, such as a draft or one with a conflict (`server/gh.ts:396-405`).
- **Overview cannot answer what it lists.** It cannot approve or merge a pull request as you, pause a behavior until a time, or show pull requests that request your review.

### Summary

Additive server capabilities in four groups, plus one fix. Each capability adds fields, endpoints or operations without removing any, and classic keeps working unchanged.

1. **Pull requests.**
   - Say why each open pull request is held, from the readiness evidence the server already reads.
   - Mark the ones that request your review, with a notice.
   - Approve and merge them as you. They run on Caller's existing primitives, are pinned to the reviewed head, recorded at most once, and use the merge queue where one is configured.
2. **Behaviors and organizations.** Pause a behavior until a time. Stop following an organization.
3. **The Manager.** This is the workspace Manager from #350, which already has its chat, timers, supervision and charter.
   - Rhythm: its own worker slots, enforced where turns are admitted.
   - Stability ↔ Expansion, with deferred issues recorded with their context.
   - Autonomy, with the reason each decision came to you.
   - Its scope, enforced on `bind`.
   - A Pause, defined through the existing holds.
   - A plan whose prerequisites hold work back at admission.

   Only you can change these settings. One precedence order decides between them, the charter and Auto-merge.
4. **Supporting reads.**
   - an estimate for a running behavior run;
   - one consistent list of open chat requests;
   - a log of what was handled today, for the whole workspace;
   - background synchronisation of publication reviews;
   - settings saves that refuse to overwrite a newer value.
5. **A fix.** Server-written text names places that do not exist in either interface (Design 14).

On 2026-10-24 the owner decided that this stays one ticket: "we definitely do not split the ticket." One `feat` PR closes it (`CLAUDE.md`, law 1).

### Is This Really Necessary?

Yes, for the pull request and Manager groups. Section 6 of the brief cannot be met without the Manager group, and Overview's purpose is answering what wants you in place: approving, merging and reviewing are among the most frequent answers.

The supporting reads replace workarounds in #556:

| #556's workaround | Read that replaces it |
| --- | --- |
| Overview reads at most 20 waiting chats' transcripts | the list of open chat requests |
| *Handled today* covers one browser | the handling log |
| Review threads come from cached documents only | background review synchronisation |
| Settings saves are last-write-wins across tabs | saves that expect a value |

### Named Concepts

| Term | Meaning |
| --- | --- |
| **Held pull request** | An open pull request that is not green, with every reason the readiness evidence shows. |
| **Review request** | An open pull request whose current requested reviewers include *Your GitHub account* by name. Team requests are an open question. |
| **As you** | Recorded by GitHub under *Your GitHub account*, not the automation account. |
| **Person-only** | Accepted only from a request that `speaksForPerson()` (`server/chat/transport.ts:445`): it carries a browser Origin and, in service mode, came through the gateway's browser authority. This keeps cooperating agents out, including the control service's `api` operation. It is not a security boundary: inside a workspace, agents run with the person's own credentials (`SECURITY.md:43`). |
| **Action receipt** | A durable record of one approve or merge, keyed by the browser's action id, that makes the action happen at most once and records its outcome, including *unknown*. |
| **Paused until** | A time before which a behavior launches nothing new, after which it resumes by itself. It is kept apart from the behavior's on/off setting. |
| **Manager slot** | Room for one turn in one of the Manager's workers. A turn paused for your answer still holds its slot. |
| **The Manager's workers** | Its descendants: the chats it created, and the chats they created in turn (`chat_control_children`). |
| **Rhythm** | How many Manager slots there are: 1 to 10. The default is an open question. |
| **Stability ↔ Expansion** | Five positions for how the Manager weighs new issues against planned work: Stability, Lean to stability, Balanced, Lean to expansion, Full expansion. |
| **Deferred issue** | A new issue the Manager recorded with its context and set aside, so that planned work could continue. |
| **Autonomy** | Five levels for what the Manager decides by itself and what it brings to you: Ask first, Ask on judgement calls, Balanced, Ask on the irreversible, Standing instructions. |
| **Effective policy** | The Manager's settings with their wording, a policy version, and the precedence order, carried by every Manager turn and every worker turn the Manager causes. |
| **Escalation reason** | Why the Manager brought a decision to you, for example "Autonomy is Balanced, and what stays in an issue is a product choice." |
| **Manager scope** | The repositories the Manager and its workers may bind work in. `null` means every repository followed at the time of the check. |
| **Plan** | The Manager's ordered work items, each with its target, its worker, and typed prerequisites. An item with an unmet prerequisite is blocked, and its worker's Manager-caused turns wait. |
| **Turn estimate** | Roughly how long a running behavior run has left, from similar completed runs. Shown as ≈, never as a promise. |
| **Open chat request** | A permission or question a chat is waiting on, with its full content. |
| **Handling log** | An append-only record of each answer, dismissal or silence, and who did it, kept apart from whether the alert's condition still holds. |

### Outline

| Capability | Today (`main` `a306a94`) | After this PRD |
| --- | --- | --- |
| Why a pull request is held | `checkPrStatus()` (`server/gh.ts:304`) reads the GraphQL readiness evidence, which includes checks, threads, the review decision and the merge queue (`get_pr_readiness_state`, `caller/github_interface/github_interface/atoms/pulls.py:22`). It keeps only green or yellow, and `fetchGreenPrs()` drops the rest. | A separate `held` list for every open pull request it checks, with every reason and the failing checks |
| Review requests | The extractor stores `requested_reviewers` (`extract.py:51-58`), but Caller's `prs` and `user_items` projections return no reviewer list (`caller/github_datastore/github_datastore/db.py:207-318`) | A current-state projection, `reviewRequested` on items, and a `review_requested` notice |
| Approve, merge | Not possible from Poise. Caller has `approve_pr` and `merge_if_ready`, both pinned to the head. | Person-only endpoints on those primitives, with action receipts |
| Pause a behavior | On or off (`POST /api/behaviors/<key>`, `server/cache-plugin.ts:838`) | Also `pausedUntil`, held at every launch's final admission |
| Stop following | Add and Retry only (`/api/organizations`) | Person-only `DELETE /api/organizations/<login>` for managed organizations, with the job fenced |
| Manager controls | None. Settings can be written through the `api` operation (`server/chat/control.ts:58`). | Person-only `manager` settings with an effective policy, Rhythm in turn admission, scope on `bind`, and Pause through the holds |
| Plan, deferred issues, escalations | None | Typed records in the control store. Role-checked operations, prerequisites enforced at admission, and a durable Take on now. |
| Turn estimates | None | Behavior runs, by behavior and model |
| Open chat requests | `chat_pending` holds request id, session, kind and `seq` (`server/chat/storage.ts:45`); the content is in `chat_events` | A revisioned snapshot, `GET /api/chat/requests`, and a `chatRequests.updated` frame |
| Handled notices | `alerts` keeps `resolved_at`, `dismissed_at` and `silenced_at` for 30 days (`server/db.ts:171-188`) | An append-only handling log, and `GET /api/notices/handled` |
| Publication reviews | Synchronised for a document while the Editor shows it; terminal publications are never read again (`server/publishing-reviews.ts:211-235`) | A fair background sweep of every GitHub publication, terminal ones included daily |
| Settings saves | Partials merge, written key by key (`server/settings.ts:174-216`); last write wins | One transaction that can refuse a save whose expected values changed |
| Which capabilities exist | Nothing | `GET /api/capabilities`, so #556's interface uses each one once it ships |
| Server-written place names | "Open Swarm in Poise…", "Settings → GitHub", "Settings → Connected accounts" | The names both interfaces use |

### Out of Scope

- **The interface.** #556's interface uses these capabilities once they ship. It detects them through `GET /api/capabilities` and keeps its Open fallback otherwise. That change, and the end-to-end journeys that need both sides, belong to #556. Classic gets no new controls and ignores the new fields.
- **Containing agents.** Person-only keeps cooperating agents out. It cannot stop a local process that forges the header, or a chat that runs `gh` with your token itself, because agents run with the person's own credentials (`SECURITY.md:43`). #350 defers a real boundary, which needs per-agent OS users or containers.
- **Bypassing GitHub's protections.** Nothing here merges with failing required checks, skips a merge queue, or uses administrator overrides.
- **Google publications in the background review sweep.** Their reads need live browser delegation.
- **Changing what the automation account does.**
- **The light theme.** It is a frontend decision in #556.

### User Experience

What the person sees once #556's interface uses these:

1. **Board and Overview say why a pull request is held.** Examples: *Failed · browser shard 3*, *Blocked · conflict with main*, *Waiting · review needed for the merge queue*.
   - Your review requests show there too.
   - Approve is offered on other people's pull requests, because GitHub refuses self-approval. If the branch moved while you approved, it says so: *Approved at 3f9c2ab; the branch is now at 8d1e04f*.
   - Merge is offered only on green pull requests. It says *Merged*, *In the merge queue* or *Already merged by bit-mis*, never claiming more than happened.
   - When the outcome is unknown because a response was lost, the action says *Not confirmed* and shows what GitHub reports, instead of retrying.
2. **A behavior can be paused until a time**, for example until the GitHub API quota resets. Work that arrives meanwhile is handled when it resumes.
3. **Settings → General lets you stop following an organization.** Nothing changes on GitHub. The organization from account setup, and the last one, cannot be removed.
4. **The Manager place** has:
   - its three controls and the sentence they add up to;
   - its scope and a Pause;
   - the plan, with its blocked items and what they wait for;
   - the deferred issues, with their evidence and Take on now.

   A decision it brings you says why. With Rhythm 1, one unanswered question holds its only slot, so the Manager place says so. Take on now shows Accepted, then Queued, then Taken when a worker has it, and waits with the reason while the Manager is paused, at Rhythm, or blocked.
5. **A running behavior run** may say "≈ 2 min left", or "longer than usual" once it passes most similar runs.
6. **Overview** lists every open chat request, says what was handled today in the whole workspace and by whom, and sees new review feedback on GitHub publications nobody has opened.
7. **Settings** says so when a field you are saving was changed elsewhere since you read it, instead of overwriting it. A classic tab still saves all its fields at once, without that check.

### New Data

| Where | What |
| --- | --- |
| The held list in `/api/gh`'s green-pull-request response | One entry for each open pull request checked: `{ repo, number, head, held }`, kept apart from today's `records`. `held` is `{ reasons, checks, threadsChecked }`. `reasons` is an ordered list from `draft`, `conflict`, `checks_failing`, `changes_requested`, `review_required`, `conversation_open`, `checks_running`, `behind`, `blocked` and `unknown`. `checks` is `{ failing (names, at most five), failingCount, runningCount, partial }`. |
| Caller's `prs` and `user_items` projections | `requested_reviewers` as of the last sync. Items carry `reviewRequested`: true, false, or null when unknown. |
| Notices | New kinds: `review_requested` (Needs you, silenceable, one per pull request) and `pr_conflict` (Needs you, for your own open pull requests). |
| Action receipts | `actionId`, `kind` (approve or merge), the payload fingerprint, `repo`, `number`, `expectedHead`, `state` (intent, done or unknown), the result, the actor GitHub recorded, `createdAt` and `updatedAt`. |
| Behaviors | `pausedUntil` (ISO time or null) and `pausedBy` (`person`, or `api` for a write that does not speak for the person; the server cannot name the chat behind an `api` write). |
| Organizations | Removal for managed organizations, with an activation generation. Whether Poise-owned datastore data is kept is an open question. |
| Settings | `manager: { rhythm, stability, autonomy, scope, paused }`, person-only, with `scope: null` meaning every followed repository. Also a change counter, which serves as the policy version. |
| Control store | Plan items, deferred issues and escalations, keyed by the Manager's session id and deleted with the Manager chat. The `manager` settings outlive the chat. |
| Behavior runs | `estimate`: `{ remainingMs, basis, samples }`, or `{ overrun: true, basis }`. |
| Handling log | `{ id, actionId, subject (alert id or request id), action (answered, dismissed, silenced or cleared), actor (the person, the Manager, a chat, or Poise), at }`, kept 30 days from `at`. |
| Publication reviews | For each GitHub publication: `checkedAt`, `stale`, `problems`, `retryAt`, and whether it is terminal. |

### Support

- **Acting as you.** Each approve or merge is one action receipt.
  - A lost response or a crash leaves it *unknown*. It is reconciled by reading GitHub before anything is retried.
  - The `pr.approve` and `pr.merge` diagnostics are best-effort, because `diagnostic()` returns null when collection is unavailable (`server/logging.ts:41-61`). The receipt is the record.
- **GitHub cost.** The held reasons add check contexts to the readiness query the server already runs for each open pull request, as the agent account (`server/gh.ts:321`). They add no request. Quota gating reads github-quota's resource state for the account and resource concerned, never the visible warning notices, which can be turned off.
- **Manager enforcement.** Every wait and refusal carries its reason, where it happens and in Logging:
  - *waiting for a Manager slot*;
  - *the Manager is paused*;
  - *outside the Manager's scope*;
  - *waiting for a prerequisite: …*.
- **Rollback.** Every capability is additive, classic ignores the new fields, and `GET /api/capabilities` lists only what is present. Reverting a capability leaves the others working.
- **Tests.** Each capability has contract tests through its real endpoint or operation, in local and service mode. Design lists each item's cases. Person-only refusals run through the native control CLI (`scripts/poise-chat-control.mjs`) for the Manager, a worker and the Switchboard.
- **Docs**, each in the PR that changes the behaviour:
  - `docs/Chat-orchestration.md`: the Manager's controls, effective policy, plan, deferred issues and escalations;
  - `docs/Notifications.md`: the new notice kinds and the handling log;
  - `docs/Publishing.md`: the background review sweep;
  - `docs/Service-architecture.md`: the new endpoints and `GET /api/capabilities`;
  - `docs/Behavior-Contract.md`: pausing until a time.

### Market Desirability

An agent workspace earns trust when you can steer it without leaving the page and see why it does what it does. Approving and merging from the overview, knowing exactly why a pull request waits, and giving the Manager limits it actually keeps make Poise something you can leave running and check at a glance.

### Risks

| Risk | Mitigation |
| --- | --- |
| A cooperating agent acts as you | Approve and merge are person-only. This does not contain a process that forges the header or runs `gh` itself; that boundary is deferred in #350, as `SECURITY.md` states. |
| An approval or merge lands on a commit you did not review | The mutation is pinned. An approval names `commit_id`, a REST merge sends `sha`, and queue admission uses the expected head. The returned head and actor are validated, and a moved branch is reported as such. |
| A retried request acts twice | The action id and receipt make it happen at most once, and an unknown outcome is reconciled before any retry. |
| The Manager rewrites its own limits | Any settings write that touches `manager` or `chat.maxConcurrentLocalTurns` is person-only, checked before anything changes, as the `/manager` charter is (`guardManagerBuiltIn`, `server/snippet-library.ts:195`). |
| The controls and the charter disagree | The effective policy states one precedence on every relevant turn: your direct request, then the controls, then the charter, then Memories. The shipped default charter is revised for new installs. |
| Manager workers starve your chats | A worker takes its Manager slot before a workspace slot, so a waiting worker never holds a workspace slot. |
| Blocked work starts anyway | Prerequisites are checked at turn admission, not only displayed, and missing or stale evidence never satisfies one. |
| Estimates mislead | Only behavior runs at first, by behavior and model, with the basis shown and an overrun state. Never a promise. |
| Background synchronisation spends your quota | At most one read a minute, gated on *Your GitHub account*'s resource state, sharing the Editor's cache and cooldowns, and respecting the release drain. |
| A save check breaks classic | It is optional. Saves without it behave as today, inside the same transaction. |

### Drawbacks

- One large `feat` PR carries four groups with different risks. The owner chose that over splitting.
- More server surface to keep: endpoints, records, admission and enforcement.
- Acting as you raises the stakes of an interface bug. Person-only and the head pin contain it among cooperating agents only.
- Stability and Autonomy still depend on the Manager following its effective policy. Rhythm, scope on `bind`, Pause and prerequisites are enforced.
- A worker can still push to any repository through its shell. Scope binds only what Poise tracks.

### Alternatives

- **Leave all of this out.** The new interface keeps its Open fallbacks, and section 6 of the brief stays unmet. Rejected.
- **Split into one PRD per group.** Smaller PRs. The owner declined on 2026-10-24.
- **Put the Manager's limits in its charter only.** Writing "at most four workers" in `/manager` costs nothing, but nothing enforces it. Rejected as the only mechanism; the soft parts reach the Manager as the effective policy.
- **Merge through an agent.** It would merge as the automation account, not as you, and slower. Rejected.
- **Read pull request detail from GitHub in the browser.** The browser has no GitHub token. Rejected.

### Unresolved Questions

Decision log:

1. **2026-10-24:** one ticket, not split. The owner said: "we definitely do not split the ticket."

Open:

- **Defaults for the controls.** The shipped charter puts Poise Chat and agent bugs first, keeps the agent slots full, and says not to ask the owner operational questions (`server/chat/manager-default.ts:6-20`). The mocks' defaults (Lean to expansion, Balanced, Rhythm 4) contradict all three. Proposed:
  - the defaults match today's charter, so nothing changes until you choose: Stability, Standing instructions, and Rhythm equal to the workspace cap;
  - the mocks' values become one click in the Manager place.
- **Auto-merge for the Manager's workers.** Proposed: workers it creates inherit Auto-merge on only at Ask on the irreversible or Standing instructions.
- **Stopping following:** delete Poise-owned datastore data, or keep it until the organization is followed again?
- **Team review requests:** count requests to a team you are in, as GitHub's own filter does?
- **Autonomy as a hard limit:** which decisions should the server refuse at low Autonomy, such as merges to main, rather than leave to the effective policy?
- **Turns the Manager causes in your own chats.** Rhythm bounds its workers. Turns it causes elsewhere through `send` or `timer` take workspace slots only. Should they count too?
- **Issue prerequisites.** If the datastore cannot say whether an issue was closed as completed, should the person mark it met by hand, as proposed?
- **Dependencies.** This builds on what #350 has delivered on `main`. It needs none of #350's open slices; if one of them changes the control service, the Manager group rebases on it.

### Success Metrics

This PRD's acceptance is the server's; the combined journeys belong to #556.

- Every capability passes its contract tests through its real endpoint or operation, in local and service mode, and appears in `GET /api/capabilities`.
- Classic is unchanged: its 46 end-to-end specs and its unit tests pass.
- GitHub cost: a Board refresh makes no more GitHub requests than today, measured in a test.
- Rhythm:
  - No new turn is admitted beyond Rhythm, under concurrent starts from every turn source, including recovery.
  - After Rhythm is lowered, occupancy falls as running turns finish, as the workspace cap does today.
- Every out-of-scope `bind` by the Manager or a worker is refused.
- No blocked plan item's worker starts a Manager-caused turn.
- Approve, merge, organization removal, Take on now, Dismiss, and any settings write touching `manager` each refuse the native control CLI, proven by tests.

### Design

**1. Why a pull request is held.**

- **Response.** `fetchGreenPrs()` (`server/gh.ts:384`) adds a separate `held` list to its response: one entry for every open pull request that `checkPrStatus()` checks, including those that are neither green nor yellow. Today's `records`, and so classic's green and yellow membership, stay exactly as they are.
- **Evidence.** The reasons come from the readiness evidence already in `get_pr_readiness_state`:
  - `isDraft`, `mergeable` and `mergeStateStatus`;
  - the `statusCheckRollup` state;
  - `reviewDecision`;
  - review threads, counting unresolved non-outdated ones, with `hasNextPage`;
  - the merge queue fields.
- **Check names.** The query also selects `contexts(first: 100)` on the rollup, covering both `CheckRun` (name, status, conclusion) and `StatusContext` (context, state). It is the same query and the same head commit, so the check names always belong to the head the reasons describe.
- **Order of reasons.** Every reason that applies is listed, in this order: `draft`, `conflict` (`mergeable` is `CONFLICTING` or the merge state is `DIRTY`), `checks_failing`, `changes_requested`, `review_required`, `conversation_open`, `checks_running`, `behind`, `blocked`.
  - `review_required` covers `REVIEW_REQUIRED`, and a queue repository that is not approved.
  - `blocked` is used only when `BLOCKED` has no other explanation.
- **Incomplete evidence.**
  - `checks_failing` and `checks_running` come from the rollup's aggregate state, which covers every context. When there are more contexts than one read covers, the names are partial and `checks.partial` is true.
  - When threads were truncated, `threadsChecked` is false and `conversation_open` is claimed only if an unresolved thread was seen.
  - A failed read, or a missing rollup, gives `unknown`.
- **Quota.** Under pressure on the agent account's GraphQL resource, the contexts are left out and the aggregate state still decides.
- **Tests**, through the real `/api/gh` response:
  - a draft whose merge state is not `DRAFT`, a conflict, and a pull request that is behind;
  - a failing required check reported as `BLOCKED`, running checks, an open conversation and truncated threads;
  - a queue repository without approval;
  - more than 100 contexts, and a legacy commit status;
  - a failed read, and quota pressure.

**2. Review requests.**

- **Projection.** Caller's `prs` and `user_items` projections gain the pull request's current `requested_reviewers` as of the last sync. They never use the `event_requested_reviewer` timeline rows (`extract.py:95-99`), which stay after a request is removed.
- **On items.** `reviewRequested` is true when *Your GitHub account* is among the reviewers, false when an authoritative read shows it is not, and null when unknown.
- **The `review_requested` notice.**
  - It is produced from every involved open pull request, including ones others authored, not from the own-pull-request ready filter.
  - There is one per pull request.
  - It stays when a read fails or is incomplete, and resolves only on an authoritative read without the request, a submitted review, or the pull request closing.
  - A request made again after removal raises a new notice.
  - Silence lasts until the request is removed.
  - Changing *Your GitHub account* resolves the old account's notices.
- **The `pr_conflict` notice** is raised for your own open pull request whose held reasons include `conflict`.
- **Freshness.** Both are as fresh as the organization's datastore sync.
- **Tests:**
  - an involvement that is only a review request;
  - a historic request that was removed;
  - a stale or failed read;
  - a request made again;
  - a change of configured account.

**3. Approve and merge as you.**

Two person-only endpoints, acting with *Your GitHub account* (`token_user`). Each body carries `actionId`, a UUID made by the browser, and `expectedHeadSha`.

- **Receipts.** Following the pattern of `server/chat/command-receipts.ts:53-106`, the server reserves `actionId` with a fingerprint of the payload before acting.
  - The same id with a different payload is refused with 409.
  - The same id with the same payload returns the stored outcome without acting again.
  - The receipt moves from intent to done with its result, or to unknown when a response was lost or the process stopped after the request was sent.
  - An unknown receipt is reconciled by reading GitHub, the reviews or the pull request's state, before anything is retried. The response then says unknown, with what GitHub shows.
- **`POST /api/pull-requests/approve`** runs Caller's `approve_pr`, which already sends `commit_id` and validates the returned head and actor (`approve_pr.py:31-43`).
  - GitHub's `commit_id` chooses the commit to approve. It is not an atomic check against the current head. If the branch moved after the check, an approval of H can exist while the head is now H2. The response says exactly that, never "approved" for H2 and never a refusal with no effect.
  - Approve is offered only on pull requests you did not author.
- **`POST /api/pull-requests/merge`** runs a new primitive built from `merge_if_ready`, without its author check:
  - **Without a queue:** a REST merge pinned with `sha`. If the head moved, the result is `superseded`.
  - **With a queue:** admission with the expected head, accepted in the queue's admissible states (`CLEAN`, `BEHIND`, `BLOCKED`, `UNSTABLE`, `HAS_HOOKS`; `mergeable.py:13`), using the queue's own method and no bypass. Admission is reported as `enqueued`, or `in_queue` if it was already queued, never as merged.
  - **Method.** Without a queue, it is the first of squash, merge and rebase that the repository allows.
  - **When it is offered.** Only when Poise's green holds: every check `SUCCESS` and no unresolved conversation, and in a queue repository also queue-admissible and approved.
  - **Already merged.** A pull request already merged when the action runs reports who merged it, never crediting you.
- **Tests:**
  - a response lost after GitHub succeeded, and a crash before the result was saved;
  - two clicks with the same id and with different ids;
  - a pull request already merged, and automation merging first;
  - a head change after the check (the approval reported at H; the merge `superseded`), and a head that was stale from the start;
  - queue admission, an already queued pull request, and a protection refusal;
  - refusal through the native CLI.

**4. Pause a behavior until a time.**

- **Fields.** `pausedUntil` is added to `POST /api/behaviors/<key>` and `GET /api/behaviors`, apart from `enabled`. Classic still shows its saved on/off. A pause clears no claims, seen state or backoff, and has none of `setEnabled()`'s side effects.
- **Barrier.** The pause works like disabling does (`server/behaviors.ts:5267-5311`):
  - the decision is published first;
  - the POST answers after operations that started under the old state have settled;
  - every launch path rechecks `isEnabled()` and the pause at its final admission, not only at its tick, so a sweep already past its first check cannot launch during the pause.
- **During a pause:**
  - nothing new launches;
  - agents already launched run to completion;
  - reconciliation of work already launched continues;
  - new work stays in the behavior's ledger and is handled on resume;
  - Run now and replay still work, as your explicit actions.
- **Expiry.** The pause ends at `pausedUntil`, also across a restart, or at once when cleared. Expiry never turns on a behavior that was set off during the pause.
- **Tests:**
  - a pause arriving during preparation;
  - a behavior turned off during a pause;
  - a pause cleared just as it expires;
  - expiry after a restart;
  - no launch before the boundary.

**5. Stop following an organization.**

- **The endpoint.** A person-only `DELETE /api/organizations/<login>` removes a managed organization. It refuses:
  - the legacy organization, which `getOrganizations()` recreates from `meta.org` (`server/organizations.ts:149-173`) and which the workspace needs to be ready;
  - the last organization.
- **The job.** Removal fences the per-login activation and sync job (`server/organizations.ts:423-479`) with a generation number. It aborts the job in flight, so an older job can never publish into a new registration of the same login after a quick re-add.
- **Data.** Poise-owned data follows the open question. An externally managed datastore (`POISE_DATASTORE_DB`) is never deleted.
- **Everything else.** The organization's notices are resolved, and its repositories leave behavior selections and the Manager's scope. Work bindings stay as history.
- **Tests:**
  - removal during initialization and during sync;
  - a restart;
  - an external datastore;
  - removing and re-adding;
  - notices, selections and scope afterwards.

**6. The Manager's controls.**

- **Storage.** `manager` lives in the workspace settings. Any write that contains `manager` or `chat.maxConcurrentLocalTurns` must speak for the person, checked before any state changes. Saves of other fields keep working for every caller.
- **Effective policy.**
  - Every Manager turn, and every worker turn the Manager causes, carries the settings with the wording below and the policy version.
  - It also carries the precedence: your direct request, then these controls, then the charter, then Memories. The existing order is your request, then the charter, then Memories (`docs/Chat-orchestration.md`); the controls go between the first two.
  - The shipped default charter is revised for new installs so that it defers to the controls. The charter is the person's standing authorization (`server/chat/control.ts:644-657`), and an existing charter is never replaced (`docs/Chat-orchestration.md`, Manager charter), so the precedence line decides for them.
- **Auto-merge** stays per chat (`server/chat/auto-merge.ts:10-19`). Which workers inherit it is an open question.

| Stability ↔ Expansion | |
| --- | --- |
| Stability | New issues found while working come first. Planned work resumes once they are handled or you set them aside. |
| Lean to stability | New issues come first unless minor; minor ones are recorded and handled after the current plan step. |
| Balanced | After each planned step the Manager takes the most important new issue, then returns to the plan. |
| Lean to expansion | Planned work comes first. New issues are recorded with their context and taken when a slot is free and nothing planned is ready. |
| Full expansion | New issues are recorded with their context and bypassed; planned work continues. Missing prerequisites still block. |

| Autonomy | Decides by itself | Brings to you |
| --- | --- | --- |
| Ask first | Only what you asked for directly | Every choice, including which worker and which model, so every `create` waits for you; also retries, order, merges and scope |
| Ask on judgement calls | Retries once; picks models from your defaults | Order changes, product and design choices, merges, scope and anything irreversible |
| Balanced | Starts and resumes workers, picks models, retries once, orders work within the plan, answers routine questions the standing instructions cover | Product and design choices, merges to main, scope changes, deleting branches or data, anything touching credentials |
| Ask on the irreversible | Everything above, plus product choices the instructions cover, and merges of green pull requests in chats whose Auto-merge is on | Scope changes, deleting data and credentials |
| Standing instructions | Everything the standing instructions cover | Only what they do not cover, plus credentials and anything destructive |

- **Rhythm** is enforced in `ChatRuntime`'s turn admission, at both sites that take a local slot (`server/chat/runtime.ts:728`, `:3169`).
  - It is a second semaphore beside the local-slot one, with the same FIFO and abort handling (`runtime.ts:3839-3890`).
  - A slot is reserved atomically with the turn's provenance, and released only when that turn's native work has settled.
  - After a restart, relays adopted during recovery are counted before anything more is admitted.
  - A turn in a worker takes a Manager slot first, then a workspace slot. It waits for one at a time, so `queuedBehind` keeps one reason.
  - Every turn source counts: a delivered message, a timer, supervision, the queue, and recovery.
  - Your own prompt to a worker skips the Manager slot.
  - Lowering Rhythm converges as running turns finish, and cancelling or deleting a chat releases its slot.
- **Scope** is enforced on `bind`, which binds the calling chat.
  - The check applies when the caller is the Manager or one of its workers. `null` means every repository followed at the moment of the check.
  - Narrowing the scope refuses new binds. Existing bindings stay until released, and the Manager place marks them as outside the scope.
  - `create` names no repository, so it cannot be checked.
- **Pause** reuses the existing holds, and is checked again at admission, so a `send` accepted before the Pause cannot start a turn after it:
  - The Manager is held as the person's Hold holds it (`chat_control_holds`), so its scheduled wake-up and its own timers skip.
  - Timers it set on other chats are held.
  - Its supervision watches do not fire.
  - Durable messages it sent but that have not been delivered wait.
  - New turns it causes in its workers wait, and `create` is refused.
  - Running turns finish, and your own prompts to workers run.
  - Resume releases everything in order.
- **Tests:**
  - every turn source and recovery with live adopted turns;
  - a worker waiting on you, and Rhythm lowered below current occupancy;
  - cancellation and deletion, and grandchildren;
  - scope refusals for the Manager and for a worker;
  - each effect of Pause;
  - the precedence line in every relevant turn, including with the shipped charter.

**7. The plan and deferred issues.**

- **Plan items** are `{ id, title, target, worker, order, prerequisites, state, updatedAt }`. Each prerequisite has a type and its own satisfaction rule:
  - **`pr_merged { repo, number }`** is met only when the pull request is merged. Closing it without merging does not meet it: the change did not land.
  - **`pr_approved { repo, number }`** is met while the current review decision is `APPROVED` at the current head. A dismissed or stale approval does not meet it.
  - **`issue_closed { repo, number }`** is met when the issue is closed as completed. Closed as not planned, reopened, or a reason the datastore does not record does not meet it; see the open question.
  - **`item_done { itemId }`** is met when that item is Done.
  - **Evidence.** Missing, stale or failed evidence never meets a prerequisite.
  - **Validation.** A reference that is missing, points at the item itself, or forms a cycle is refused with 400.
- **Admission.** A turn the Manager causes in a worker whose plan item has an unmet prerequisite does not start. It waits as `queued`, with *waiting for a prerequisite: …*, and is checked again at admission. Your own prompts still run.
- **Item state.** An item is Done when its target pull request is merged or its issue closed as completed. A pull request closed unmerged makes it Idle · Abandoned.
- **Deferred issues** are `{ id, target, title, context, foundBy, evidence, state, createdAt, takenAt, dismissedAt }`.
  - `target` is a canonical `{ repo, number }`, or null when the issue is not filed yet.
  - `foundBy` is the real acting chat, recorded by the server.
  - `state` is deferred, taking, taken or dismissed.
- **Take on now** is person-only.
  - One transaction moves the issue from deferred to taking and inserts one durable inbox entry for the Manager, keyed by the deferred issue's id, so a crash or a repeated click never loses or doubles it.
  - The state becomes taken when the Manager binds the target or assigns a worker.
  - The message is your request to take the issue on now; the deferred context travels as data, not as authorization.
  - Take and Dismiss at once have one winner.
  - "Now" moves the issue ahead of Stability's ordering, not past the hard limits. While the Manager is paused, the issue is outside the scope, Rhythm is full or a prerequisite is unmet, it waits with that reason.
- **Authority** is checked explicitly per operation:
  - `plan.set` and `escalate`: the Manager only.
  - `defer`: the Manager and its workers, attributed to the real acting chat.
  - `plan.get` and `deferred.list`: the Manager and its workers.
  - Any other chat, and the Switchboard, is refused.
  - Changes run under the existing durable command receipts and budgets. Reads stay outside the budget for mutating actions.
- **Storage.** The records live in the control store. `storage.deleteSession()` clears chat tables only (`server/chat/storage.ts:227`), so deleting the Manager chat deletes these explicitly.
- **Tests:**
  - refusals for an ordinary chat and for the Switchboard, replays, and requests from another instance or out of date;
  - deleting the Manager;
  - a real blocked start, then its admission once the prerequisite is met, across a restart;
  - a pull request closed unmerged, a dismissed approval and a reopened issue;
  - Take and Dismiss at once, and Take while paused.

**8. Escalation reasons.** `escalate { sessionId, requestId, reason }`, from the Manager only, is checked first:

- the request must be pending now, in this instance;
- it must be in one of the Manager's workers.

The server records the acting chat rather than accepting it from the caller. The reason attaches to that live request only, and a cancelled or reset request is never brought back.

**9. Turn estimates.**

- **Scope.** The first release covers behavior runs only.
- **Similar runs.** The same behavior and the same model, completed successfully in the last 30 days. At least five are needed.
- **What is measured.** The median time from launch to completion, without queue or preparation time and without time waiting on a person. Failed and restarted runs are left out.
- **Overrun.** Once a run passes the 90th percentile of similar runs, the estimate becomes `overrun` instead of counting below zero.
- **Chat turns come later.** Their duration starts at reservation (`runtime.ts:2671-2688`), before they wait for a slot (`:3162-3174`), and an adopted turn resets the clock (`:701-706`).
- **Tests:** different behaviors and models kept apart, the clock boundaries, four samples against five, the 30-day cutoff, and an overrun.

**10. Open chat requests.**

- **The read.** `GET /api/chat/requests` returns `{ revision, complete, requests }`.
  - It reads one consistent snapshot of this instance.
  - It joins each `chat_pending` row by `seq` to its stored `permission.requested` or `question.asked` event (`server/chat/storage.ts:292-345`), instead of scanning a transcript.
  - Each entry carries its content, its session, its creation time and any escalation reason.
  - It returns at most 200 entries, newest first, with `complete: false` beyond that.
- **The frame.** `chatRequests.updated` carries the same revision. It is sent when a request is created, answered, cancelled, reset, deleted or recovered.
- **Clients** read again after reconnecting or a restart, and discard a response older than a frame they have seen.
- **Tests:** an answer arriving while a read is in flight, several requests at once, more than 5,000 earlier events, a restart and replay, and another instance's rows.

**11. The handling log.**

- **Separate from alerts.** The log is append-only and separate from an alert's condition. Alerts keep their meaning:
  - dismiss and silence still leave `resolved_at` unset (`server/alerts/store.ts:238-256`);
  - reminders for a pull request that is ready still reuse their alert (`server/alerts/notices.ts:65-76`).
- **One entry per action**, idempotent by action id. An earlier answer or dismissal stays in the log when the condition later clears.
- **Chat requests are logged per request**, from `permission.resolved` and `question.answered`, which already say who answered. The per-session `chat_waiting` alert is not used.
- **The read.** `GET /api/notices/handled?since=<ISO>` returns the log, kept 30 days from each entry's time.
- **Tests:** repeated reminders, two requests in one chat, an answer against a cancellation, and an alert created more than 30 days before it was handled.

**12. Publication reviews in the background.**

- **What it reads.** A sweep reads every GitHub publication as *Your GitHub account*.
- **Order and rate.**
  - The publication checked longest ago goes first, each publication separately, so documents published to several sites progress per site.
  - At most one read a minute, and each publication at most every 15 minutes.
  - The longest delay before new feedback is seen is the larger of 15 minutes and the number of publications in minutes. The response states it.
- **Closed and merged publications.** The Editor's polling serves them from cache for good, so the sweep reads each of them again once a day. A reopened pull request or late feedback is seen within a day.
- **What it respects.** The release-background admission and drain (`server/publishing-reviews.ts:306-320`), the Editor's cache, cooldowns and backoff, and the account's quota resource state.
- **The list.** `GET /api/editor/reviews` lists every publication, including those with no open thread, with its `checkedAt`, `stale`, `problems` and `retryAt`. A cold or failed one never looks as if it had no feedback.
- **Tests:** a cold cache, an old unopened document, a closed publication that reopens, several sites, quota exhaustion, the Editor reading at the same time, and the release drain.

**13. Saves that refuse to overwrite.**

- **The check.** A settings save may carry `expect: { <field>: <value the tab last read> }`. If any of those fields changed since, the save is refused with 409 and the current values.
- **One transaction.** The comparison, the partial merge, every field write and the change counter happen in one SQLite transaction on one consistent read, as Memories' save does (`server/chat/memories.ts:16-28`).
  - The model catalog is loaded before the transaction starts.
  - A refused save changes no field and no counter, and has no side effects: no `localTurnCapChanged()` and no `checkNotices()`.
- **Every writer.** Classic's whole save and onboarding (`server/service/onboarding.ts:162-169`) go through the same transaction and advance the same counter.
- **Tests:** two saves expecting the same value, a classic save followed by one that expects a value, a restart, nested `manager` partials, and an invalid change to several fields that leaves everything unchanged.

**14. Server-written text.** Classic already names these places General and Accounts (`src/menu.ts:94`, `:103`), so these strings are wrong today. They ship with the rest, first in the PR.

| Where | Today | After |
| --- | --- | --- |
| `server/alerts/notices.ts:95` | "Open Swarm in Poise to see what happened." | "Open it in Poise to see what happened." |
| `server/gh.ts:200`, `:573`, `server/action-runs.ts:164`, `server/behaviors.ts:863`, `server/settings.ts:228`, `:230` | "Settings → GitHub" | "Settings → General" |
| `server/behaviors.ts:660`, `server/alerts/producers.ts:68`, `server/service/turned-off.ts:5` | "Settings → Connected accounts" | "Settings → Accounts" |

**15. Which capabilities exist.** `GET /api/capabilities` lists the capabilities above that this server has, by name. #556's interface reads it once at mount.

**Order of work**, within the one `feat` PR:

1. The fix: item 14.
2. Pull requests: items 1–3.
3. The Manager: items 6–8.
4. Behaviors and organizations: items 4 and 5.
5. Supporting reads: items 9–13 and 15.

The PR runs `npm run verify`.
