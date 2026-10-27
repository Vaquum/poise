# Local v2 sandbox validation — 27 October 2026

Three fixture tasks completed through real GitHub issues, reviews, CI and native
merge-queue merges. The production instance kept running. Its configured
organizations and identities were unchanged, and its retained metadata recorded
zero sandbox pickups and zero sandbox Caller calls.

This validates the existing v2 decision function with a local test adapter and
scripted workers. It does not validate autonomous model reasoning or a production
v2 executor. The production module remains unregistered, with
`V2_EXECUTION_ENABLED=false`; neither default was changed.

## Candidate and isolation

- Source base: `144f47770a0124474a6795c4d48049192cdfc233`.
- Local decision-source SHA-256 after the approval-order fix:
  `a7614699795c1a7124892acc9b9e11e5cc0e1f51161e3383e5a76e673f772643`.
- Worktree: `/Users/mikkokotila/.codex/worktrees/poise-v2-shadow-proof/poise`.
- Actual local service: `127.0.0.1:15555`, isolated service mode, own home,
  SQLite databases, Caller data, mirrors, workspaces, CLI configuration and key.
- Only registered test organization: `test1234test1234test`.
- New repository: [poise-v2-local-20261027](https://github.com/test1234test1234test/poise-v2-local-20261027),
  repository ID `1436020366`; it contains generated toy code only, with no fork
  relationship or references back to production work.
- Runtime identities: author `zero-bang`, reviewer `llun-ved` (the actual
  authenticated spelling). `mikkokotila` provisioned only the excluded test
  repository, collaborator access and its ruleset.
- All existing v1 behavior enable switches were false in the local instance.
  Live model CLIs refused execution. The sandbox adapter rejected other
  repositories, production identities, missing isolation paths, and unsupported
  raw CLI operations before sending effects.

The existing OAuth credentials can have broader account permissions. Isolation
was enforced by the explicit repository/identity adapter and scripted workers;
the credentials were not made repository-scoped. The test did not hand them to
an unrestricted model worker.

Production's registered organizations were `autonomio`, `lotus-king-research`,
`mikkokotila`, `vaquum` and `velocinbio`. The test organization was absent.
Bounded read-only SQLite metadata snapshots at 16:56:38 and 17:34:22 UTC showed
identical organizations and identities, `sandboxSeen=0` and `sandboxCalls=0`.
These are specific pickup/Caller checks, not a claim of complete production
network tracing. No production restart, configuration change, deployment,
work migration or upstream Poise publication occurred.

## Real GitHub outcomes

The sandbox ruleset required `Sandbox checks`, one current-head approval,
resolved conversations and the native merge queue, with no bypass actors.
Each queue's `merge_group` workflow completed successfully on the actual merge
commit below. All three linked issues closed, and the final open-PR read was
empty.

| Case | PR / issue | Candidate head | Actual merge commit | Exact merge-queue CI |
| --- | --- | --- | --- | --- |
| Plan → issue → issue review → failed CI → repair → review finding → fix → approval → conversation resolution → queue | [#2](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/2) / #1 | `284e6d65de0d6ed7fe2d80b9c51a5f709a297ed4` | `ebef75aaf50f4c04027c91a9352c84d98681cc97` | [40548962648](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40548962648) |
| Accepted issue write followed by lost response; later artifact reconciliation; closed-without-merge refusal, then reopen | [#5](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/5) / #3 | `911ee576798824275353eead21228575178efa6a` | `37bbaf1d0ca7c9f5a48d24cae085af9bdcfd4144` | [40550166704](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40550166704) |
| Concurrent duplicate triggers; real add/add conflict and branch repair; restart while queued | [#6](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/6) / #4 | `ac96273750b5247bc5e9cbb8ce2fa6e36d801cbf` | `a549e9ccfeff13143bf3b2fdbfc77d56ed3ceedb` | [40550932440](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40550932440) |

The restart stopped only the verified local listener and restarted that local
service. The durable native receipt count stayed at 28. A fresh decision process
read the existing queue entry and returned `wait`, issuing no duplicate command.
GitHub queue admission, approval and closed state were never treated as a merge.

## Defect found and repaired locally

The original decision order proposed conversation resolution before approval.
Caller's existing strong resolver refused: the current head was not approved,
an earlier changes-requested review remained decisive, and zero threads were
resolved. This exposed a real sequencing gap in the offline rehearsal.

The minimal fix requests current-head approval after a clean current-head review,
then invokes strong conversation resolution. Two new headless/interactive
regressions failed on the old source and passed after the reorder. Active review
findings still require a fix first. The real #2 sequence then obtained approval,
resolved its one remaining thread and merged through the queue.

This source fix is local and unpublished. Publishing into `autonomio/poise`
would make the production work queue react, which was outside this test's
isolation authorization.

## Recovery, controls and local gates

The test used the real `advanceWork`, `WorkRehearsal` and native
`executeCommandOnce` receipts, with existing Caller readers/actions behind the
explicit sandbox adapter. Twenty-six fault/isolation assertions passed:
accepted-write and pre-send crashes stay uncertain without blind replay;
concurrent duplicate triggers produce one issue; settled receipts return the
same artifact; conflicting payload reuse is refused; production targets and
identities are refused; required isolation paths fail closed; and existing v1
ownership, Stop/Hold and admission pause prevent a new proposal.

| Local check | Result |
| --- | --- |
| Existing organization/credential isolation suites | 53 passed |
| Rehearsal decisions and existing v1 parity fixtures | 38 passed |
| Existing browser rehearsal/control/layout/load fixture | 4 passed, 52.2 seconds |
| Full `npm run check` | Lint passed; 4,727 tests passed, eight failed across 305 files; build not reached by this command |
| Separate final `npm run build` | Passed, including client/server/test type checks |

The eight failures are the exact same named `tests/chat/turn-stall.test.ts`
failures retained in `/tmp/poise-pr722-check-final.log`. The unchanged macOS
limitations are described in [the baseline report](V2-rehearsal.md). No test was
skipped, weakened or reclassified as passing. This is not a green full local gate
or exact-candidate Linux CI for the unpublished source fix.

The browser fixture preserved the existing v1/v2 control assertions for drafts,
permissions, questions, timers, Hold/Resume and Stop, plus the Manager/table/
Switchboard arrangement. Existing load assertions passed their one-second
budgets with 10,000 retained journal events and with 100 visible tasks / 2,000
transitions. These are bounded offline decision/render checks, not production
stall attribution or a sustained live-model load test.

Initial harness failures remain retained: startup rejected the initial local
owner/handle mismatch, the local organization request needed its correct origin
and body key, and the read-only datastore query guard needed the existing
batched-variable shape. One immediate issue-list read lagged an accepted write;
the action stayed held until the exact issue artifact appeared. None required
replaying an uncertain write or changing production.

## Retained evidence and cleanup

The private local evidence root is
`test-results/v2-local-sandbox-20261027/`. It retains the fixture adapter and
controller source, manifest, native and rehearsal databases, action receipts,
decisions, response artifacts, before/after production metadata and reports.
`reports/final-merges.json`, `edge-checks.json`, `ordering-defect.json`,
`closed-without-merge.json`, `queued-restart.json`, `isolation-summary.json` and
`validation-summary.json` pin the outcomes above. The audit recorded 346 entries:
157 Caller REST, 100 adapter REST, 84 Caller GraphQL and five refused targets.
GraphQL records retain operation labels; they are not a complete wire capture.

At 17:39:32 UTC the verified owned local service was stopped, port 15555 closed,
and the copied `gh/hosts.yml` credentials were removed. Original machine
authentication was not modified. The toy repository and merged PRs remain for
inspection. Production execution, a live model-worker trial, admissions,
migration and default changes remain outside this completed sandbox run.
