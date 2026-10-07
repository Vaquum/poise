# Behavior integration contract

Poise is a trigger and orchestration layer. It does not read GitHub source,
construct reviews, or mutate review threads itself.

Each behavior follows one transaction shape:

1. Gate on fresh `github-datastore` consumer state.
2. Read one immutable fact packet from `github-interface`, including head SHA
   and acting GitHub identity.
3. Persist launch intent with behavior, target, actor, source, correlation ID,
   and expected head before starting detached work.
4. Let `agent-interface` perform model work using only the permitted
   `github-interface` primitives.
5. Reconcile the durable agent outcome by exact correlation ID. Accept only
   an expected action/outcome pair on the expected head.
6. Dead-letter uncertain terminal work. Never retry an ambiguous side effect.

`review-new-issues` accepts `commented`: Caller posted every comment the
reviewer wrote, on the issue and its sub-issues, and recorded each one as it
was posted. An issue has no head, so no head is pinned or reported. A failure
is relaunched once, and only when the run recorded no comment and never began
posting. See [Review New Issues](Issue-review.md).

`review-new-prs` accepts either one atomic `requested_changes` review or the
authoritative `reviewed_clean` outcome. `approve-prs` accepts one head-pinned
approval or one atomic change request. An unresolved finding whose location became
outdated can be reaffirmed without another inline comment when the reviewer
confirms it still blocks the supplied head. A terminal review contract violation
is held on unchanged input and model instead of repeatedly launching the same
worker. A clean review becomes approval-eligible
on the next scheduler scan. `resolve-unblocking` uses the upstream strong
resolution primitive, which revalidates the complete gate before every thread
mutation.

New behaviors must add the required atomic fact or mutation upstream first.
They must not add GitHub authentication, GraphQL, REST, or repository-source
access to Poise.

One deliberate exception to step 4: an issue review's model work is not held
to github-interface primitives. At the operator's explicit request each
reviewer runs its provider's own CLI with full access in a fresh checkout, so
it can read the whole repository and run the tests. Its GitHub side effect is
still Caller's: the reviewer writes comments to a file, and Caller posts them
through github-interface as your agent account, only on the issue and its
sub-issues.

The installed legacy sync service runs Caller’s one-minute loop under launchd
KeepAlive, with a one-minute restart throttle. It does not depend on repeated
StartInterval launches for ordinary freshness.

Dependency recovery remains fail-closed. Exit-1 datastore health reports retain
the validated sync timestamp and age. A stale legacy index can wake only the
installed sync job matching the database and Caller binary, at most once per
minute across gates and restarts. Recovery never kills a live sync or admits
work before freshness is confirmed.

If Caller explicitly reports a missing local checkout, Poise can provision an
owned checkout through Caller's existing checkout primitive, verify its origin,
commit and clean state, and publish it atomically. Concurrent requests share
provisioning; changed or existing user checkouts are never replaced. The
checkout is provisioned as your agent account, the reviewer, which Poise names
to Caller with `--token-user`. CLI errors retain bounded, credential-redacted
terminal diagnostics. Review receipts and launch claims remain authoritative;
dependency repair never fabricates a verdict.

A closed legacy failure can recover when Caller subsequently supplies an exact
`not_started` / `preflight_failed` result. The same no-action rule applies before
and after restart. Bounded, oversized-packet and invalid-result holds retain
their existing rules; unrelated reviewers’ submitted receipts do not override
an exact proof that this particular run never submitted.

## Where the pull-request behaviors act

`review-new-prs`, `approve-prs` and `resolve-unblocking` each have a Skip
repositories list (`behavior_<behavior>_skip_repos`): `owner/repo` names, one
list per behavior shared by every ready account. Before a scan claims, reads or
launches anything, it keeps only the pull requests that pass one check: open,
not a draft, authored by your GitHub account, and outside the behavior's
skipped repositories. A skipped pull request is never claimed, dead-lettered or
counted toward a retry. The list is read again immediately before a launch or a
resolution, so a repository skipped while a scan is under way is left alone too.

`review-new-prs` takes its anti-flood baseline (`behavior_seen`,
`__snapshot_v3__` and the pull requests recorded with it) over every open pull
request of yours, skipped repositories included: the baseline records what was
already open when the behavior began, wherever it is. Saving a skip list never
retakes the baseline or clears the ledger. Unskipping a repository therefore
makes its open pull requests eligible on the next tick exactly as new ones are:
those opened since the baseline are reviewed, and the backlog it recorded is
not. `approve-prs` and `resolve-unblocking` have no baseline; an unskipped
repository's pull requests are evaluated on the next tick like any other.

## Replays

A replay from Swarm passes the same check the scheduler applies, or it is
refused with HTTP 409 and an error naming the check that failed. Poise reads
the target fresh, behind the datastore freshness gate and from the same
datastore the scheduler reads, and decides before it prepares a model, a
checkout or a head. The scheduler and the replay call the same function for
each kind of target, so the two cannot drift apart.

- `pr_review` and `pr_approve`: the pull request is open, not a draft,
  authored by your GitHub account, and not in the Skip repositories list of
  `review-new-prs` or `approve-prs` respectively.
- `issue_review`: the repository is opted in to `review-new-issues`, the issue
  is open, and its author is a trusted author.

A repository outside every ready account is refused the same way. When the
facts cannot be read, the replay answers 502 and launches nothing.
