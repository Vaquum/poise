# CLAUDE.md

The repository law, operating discipline and code stance for every contributor, human or agent.

## Authority

User and higher-priority session instructions take precedence over this repository contract. [AUTONOMIO_PR_GUIDELINE.md](AUTONOMIO_PR_GUIDELINE.md) holds the universal Autonomio rules; [POISE_REPO_SPECIFICS.md](POISE_REPO_SPECIFICS.md) narrows them for this repository. [docs/Service-architecture.md](docs/Service-architecture.md) is the interface contract between the gateway, the workspace runtime, Poise and Poise Link; a change to one of those interfaces changes that document in the same pull request.

A repository rule is not permission to open a PR, request review, post comments, merge, publish or change remote settings. That permission comes from the task.

## Motivation

The needle is what people actually get from Poise: their own agents, data and automations, reachable from anywhere, without a personal computer having to stay awake. Ask of every change: which usage path does this move, and how? Work that only checks boxes does not count.

## The laws

1. **One pull request, one slice.** Every PR closes exactly one open slice issue, and its title equals that issue's title. The diff stays inside the slice's declared surfaces.
2. **Conventional Commits, no assistant attribution.** The PR title and every non-merge commit use Conventional Commits v1.0.0 (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`). No commit message or PR title names an AI or LLM assistant.
3. **The gates pass on the exact candidate.** Run the gates [POISE_REPO_SPECIFICS.md](POISE_REPO_SPECIFICS.md) names for every surface you touched. CI is authoritative for merge.
4. **Fail loud.** Never paper over missing or contradictory state with fallbacks, swallowed errors or silent defaults. Required configuration that is absent stops the process with a message naming it.
5. **Every fix and capability carries its regression guard.** A test fails on the old behavior or on silent removal. User-facing changes carry end-to-end proof.
6. **Documentation is current truth.** A PR that changes behavior updates the documentation describing it. Docs describe what runs, not what is planned.
7. **No direct push to `main`.** Branch from `main`, keep the branch up to date, and merge only when CI is green and review threads are resolved.

## Workflow

Branch from `main` with a Conventional Commit style branch name (`feat/…`, `fix/…`, `docs/…`). Make the change concrete and locally verified. Open the PR early when CI time is useful, continue local verification while CI runs, and read your own full diff before asking anyone to review it. Prefer new commits to amends. Keep one logical change per commit.

When a gate fails, its output names the reason: fix the code, or fix the gate in its own PR if the gate is wrong.

## Code stance

Choose the smallest honest implementation that satisfies the requirement. Prefer the standard library and existing dependencies; a new dependency names the concern it solves. Comments explain non-obvious decisions, never narrate the line. Match the surrounding code's idiom. Validate against the stated expectation — "did it return what the slice promised", not "did it run".
