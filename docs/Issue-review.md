# Review New Issues

An adversarial review of each new issue in the repositories you opt in, and of
every sub-issue it makes part of itself. One to three reviewers work on each
issue at the same time. Each is its provider's own coding-agent CLI with full
access to a fresh checkout of the repository: it reads the whole codebase and
its history, builds, and runs the tests. Every comment is posted as your agent
account (Menu → Settings → General → GitHub automation account).

Each reviewer gets `TMPDIR`, `TMP` and `TEMP` pointing to a private `tmp`
directory inside its existing run workspace. Its instruction puts throwaway
files, dependency environments, downloads and test artifacts there. Full
repository access, build/test commands and provider permissions stay the same.
Caller removes the workspace after success or failure. A later review also
cleans abandoned run directories older than two hours. It checks the workspace
user's processes (including temporary-directory environment and open files),
preserves active or unreadable relevant process state, and ignores other users.
Read-only owned build directories are made removable; unrelated paths and
symlink targets are preserved. Cleanup errors are logged without failing a review.

The instruction each reviewer gets is fixed:

> Provide an adversarial, meticulous, and comprehensive review with comments
> on `owner/repo#N` and any issue directly linked to it.

The behavior's memory (the Memory column) is added to it, as for the PR
behaviors.

## Turning it on

Behaviors → **Review New Issues**:

- **Setting** opens the trigger dropdown. Tick the repositories whose new
  issues are reviewed; nothing is reviewed until at least one is ticked, even
  with Active on. The list is the configured organization's repositories, the
  same list Current uses. Below it, **Trusted authors** lists the GitHub
  accounts whose issues count. Until you save a list it is your GitHub account
  and your agent account (Settings → GitHub), whichever are set. Every way of
  closing the dropdown saves it.
- **Reviewers** chooses how many of the Issue review models review each issue.
- **Active** is the switch.

Settings → Models names the three slot models once — Primary, Secondary,
Tertiary — and **Issue review** picks which slot it runs. Caller switches to
the next slot once after a Claude output limit; when a slot's provider fails
before a verdict, the run moves to the next slot instead. It offers every
provider Caller can run with full access — all five: Claude, Codex, Grok,
Antigravity and Muse.

## Which issues

An open issue is reviewed once, when all of these hold:

- its repository is ticked, and the issue was opened after it was ticked —
  ticking a repository never reviews its backlog;
- its author is one of the trusted authors;
- it has been open for 10 minutes, so sub-issues and links added right after
  opening it are part of the review;
- no other issue's review covers it as a sub-issue (see below).

An extra reviewer reviews only the issues opened after the panel grew to
include it. Edits, new comments and your agent account's own comments never
start another review; Replay in Swarm runs one by hand. At most three
reviewers run at once across all issues; the rest wait for a free slot.

## Asking for another review

When you revise the issue and want it reviewed again, Replay on its review
row requests a fresh review of the exact revision the issue holds at that
moment: Poise reads the current title and body, binds the run to their
SHA-256, and Caller verifies that revision before reading and again before
posting, failing loud instead of reviewing another body. A repeated request
for the same revision reuses the recorded request and starts nothing new,
even after the run finished, failed or is held; editing the issue creates a
new revision that can be requested on its own. The request needs the same
standing as a first review — an opted-in repository, an open issue, a
trusted author — but it is not bound by the automatic discovery rules above
(it works for older issues and while the behavior is off), and it runs one
reviewer: the current Issue review default.

## Sub-issues

"Directly linked" means the issue makes the other issue its sub-issue, one
level deep, in either of the two ways GitHub work here does it:

- a GitHub sub-issue of it;
- an issue linked under its own **Work Slices** heading — how an Origo PRD
  makes its Slices part of it.

A mention elsewhere in the text, a `Depends on`/`Unlocks` line or a Slice's
`Parent issue:` line does not make one, nor does anything inside a code block
or an HTML comment. The heading may read `Work Slices`, `Work Slices:` or
`5. Work Slices`. A linked sub-issue must belong to the same owner as the
issue, as GitHub's own sub-issues do; it can live in another of that owner's
repositories, and reviewers comment on it there.

A sub-issue is reviewed once. When a new issue is also a sub-issue of another
new issue, the parent's review covers it, and it gets no review of its own:

- it waits while its parent's review is still to come (the parent may still be
  settling) or running;
- once any review has commented on it, it is done;
- it is reviewed on its own when it became a sub-issue only after its parent's
  review began, or when that review ended without commenting on it, for
  example because it was stopped.

A review reaches only its own issue's sub-issues, so a sub-issue of a covered
Slice still gets a review of its own. An issue whose sub-issues cannot be
read, a deleted one say, waits and covers nothing until they can be, while
the rest go ahead. When several reads fail and none succeeds, which points at
GitHub or the token, nothing launches that minute and Behaviors shows why.

The same holds the other way round. A review does not comment on a sub-issue
that already has an issue review from another issue, or whose own review is
still running, such as a Slice reviewed on its own before a PRD took it in.
Its reviewers read that sub-issue and its review for context, and put anything
they add in their comment on the issue itself.

Two new issues that both make the same issue their sub-issue, reviewed at the
same time, both comment on it.

## What a reviewer does

Caller (`agent-interface --issue-review`) reads the issue, its comments and
each sub-issue with its comments through github-interface, clones a fresh
checkout of the repository's default branch with full history from a local
mirror, and starts the provider's CLI in it with no tool restrictions and no
sandbox. The mirror (`~/.cache/github-interface/mirrors`) and the checkout
(`~/.cache/agent-interface/issue-review`) are outside `~/dev`; the checkout
is deleted when the reviewer finishes. The reviewer does not post. It writes its
comments to a file; Caller posts them through github-interface as your agent
account — one comment per issue per reviewer (in parts when it is longer than
GitHub takes in one), only on the issue and its readable sub-issues, each
signed with the reviewer's model and the short revision it reviewed:

```
---
Issue review · `opus-5.5-max` · rev `d9da577c`
```

A comment covers only its marked revision: a later edit makes it historical
without starting another review, and a completed run never satisfies a
request for a different revision. Reviews from before revision markers have
an unknown revision and never count as a review of the current body.

Reviewers work independently, so the same finding can appear twice, as with
the PR review panel. When a reviewer finishes, anything still running in its
checkout — a dev server, a watcher, a process that detached — is stopped
before the checkout is deleted. The instruction names the provider deadline
and asks for the review file early; a timeout records what the file held and
never posts late work, and a posting timeout is reconciled through the
call marker before it counts as a failure.

Poise launches each reviewer with your agent account as `--actor` and in
`GITHUB_INTERFACE_AGENT_USER`, and nothing launches while it is not set. Caller
reads, checks out and comments as that account (`--token-user`), and refuses a
run whose actor is any other account, or whose agent account is not set, before
it reads or posts anything. A Claude reviewer runs through Poise's Claude
subscription wrapper, like every other Claude launch, keeping Claude Code's own
system prompt.

## In Swarm

Each reviewer is its own row, `issue_review`, with the same detail as a PR
review: live stage and heartbeat, provider reasoning, time elapsed, Stop, the
response (the comments it posted) and Replay. Its target links to the issue,
and a finished review reads *completed · posted*.
Stages specific to issue review are *Reading the issue*, *Preparing a fresh
checkout* and *Posting review comments*.

## When a reviewer fails

- Failed before posting anything: Poise launches that reviewer once more, then
  holds it.
- Out of time while the provider ran (one hour of wall-clock time, sleep
  included, with the one in-Caller recovery): the reviewer is tripped and the
  review runs once more with the next healthy reviewer, then holds. At most
  two launches per reviewer: the retry counts toward the same bound. The retry
  starts fresh — a timed-out run's partial file is diagnostic evidence only,
  never published or reused.
- Out of time before the provider started (reading the issue or preparing the
  checkout): held with the cause. The reviewer is not tripped — switching
  models cannot repair preparation — and nothing relaunches under another
  model.
- Began posting, then failed: held, never relaunched — it may already have
  commented. Caller records every comment the moment it is posted, and records
  that posting began before the first. An issue that refuses a comment (locked,
  deleted) does not stop the others from getting theirs.
- Stopped, recovery failed, or an issue too large to review: held.
- Out of balance (402) or not signed in: the reviewer is tripped, not held —
  the next configured reviewer takes its place, or the review waits when none
  is healthy. The trip retries on the usual backoff and clears when the
  reviewer succeeds again.
- A worker whose launch was never recorded — the process died in between — is
  taken over by a later scan after five minutes. One that has not yet
  registered its run is not relaunched while it is still alive.

A held reviewer is listed in the Behaviors diagnostics until the issue closes
or its repository is unticked; Replay in Swarm runs it again on purpose.

## Trust

The reviewers run as you, on this machine, with full access — the same as a
Chat session in unrestricted mode, except that what they read was written by
whoever opened the issue and its sub-issues. The trusted-author list is the
guard: keep it to accounts you trust. A disposable checkout keeps them away
from your working copies; it is not a sandbox. See SECURITY.md.

## Caller contract

- `agent-interface --issue-review OWNER/REPO#N --model M [--recovery-model R]
  --actor USER --source SOURCE --correlation-id ID [--expected-issue-revision
  SHA256] [--note TEXT]`. With the expected revision, Caller fails with
  `issue_revision_changed` and posts nothing when the title or body moved
  before reading or before posting; a revision-bound run with no comment for
  the requested issue fails instead of completing.
- `agent-interface --models` lists `issue_review_providers`; without it Poise
  reports *Update Caller: issue review is unavailable* and launches nothing.
  Revision-bound replays additionally need `issue_review_revisions`, else
  *Update Caller: issue re-review is unavailable*.
- Log rows: `behavior: issue_review`, the issue number in `pr_id`, no
  `expected_head` or `head_sha`, `action`/`outcome` `commented` when done,
  `issue_revision` — the SHA-256 of the exact title and body reviewed
  (`null` on runs from before revision markers) — and `receipts` — `null`
  until posting begins, then the comments posted (`issue`, `comment_id`,
  `url`, `author`).
- github-interface primitives: `--read-issue`, `--issue-comments`,
  `--sub-issues` and `--comment-issue`, each with `--repository OWNER/REPO`,
  and `--checkout-repo OWNER/REPO --path DIR`, every one with
  `--token-user` naming the agent account.

Poise must be deployed before a Caller that writes `issue_review` rows: an
older Poise cannot read them and would stop reading the whole agent log.
