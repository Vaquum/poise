# Poise repository specifics

Status: repository-only details for `autonomio/poise`.
Scope: narrows [AUTONOMIO_PR_GUIDELINE.md](AUTONOMIO_PR_GUIDELINE.md) for this repository.

## What this repository is

Poise as a self-hosted service. The application started as the single-user Poise from `mikkokotila/Poise` (history preserved up to #101). This repository adds what running it for several people needs: Caller in-tree, a login gateway, a per-person workspace image, and the Poise Link desktop companion. [docs/Service-architecture.md](docs/Service-architecture.md) is the contract between those parts.

Poise must keep working outside service mode too: `npm run dev` on a developer's machine is still how the application is built and tested.

## Layout

| Path | Surface |
| --- | --- |
| `src/`, `server/`, `scripts/`, `tests/`, `index.html`, `vite.config.ts` | Poise application |
| `caller/` | Caller: `agent_interface`, `github_interface` and `github_datastore`, the Python CLIs Poise drives ([caller/README.md](caller/README.md)) |
| `docs/` | Documentation; `docs/Service-architecture.md` is the interface contract |
| `.github/workflows/` | CI |
| `link/` | Poise Link, the desktop companion (Tauri 2: Rust in `link/src-tauri`, the window in `link/ui`); see [docs/Poise-Link.md](docs/Poise-Link.md) |

Slices that add `gateway/`, `deploy/` and `link/` add their rows and gates here in the same pull request.

## Toolchain

- Node 22 is the runtime line (the workspace image pins it). On a developer Mac put it first on `PATH`: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. The default Homebrew `node` (23) cannot load the `better-sqlite3` build and fails hundreds of tests for that reason alone.
- Python 3.13 for Caller. `npm run caller:setup` builds `caller/.venv`, which Poise runs Caller's CLIs from.
- Docker Engine 24 or newer for the workspace image and the deployment bundle.
- Rust for Poise Link: the toolchain pinned in `link/rust-toolchain.toml` (rustup installs it on first use). On Linux, Tauri's system libraries too; [docs/Poise-Link.md](docs/Poise-Link.md) lists them.

## Gates

| Touched surface | Required local gate |
| --- | --- |
| Poise application | `npm run check` (lint, unit and integration tests, production build) |
| Poise browser UI | `npm run check` and `npm run test:e2e` |
| Caller | `npm ci` and `npm run caller:setup`, then `caller/.venv/bin/python -m pytest caller/agent_interface/tests caller/github_interface/tests caller/github_datastore/tests` |
| Documentation only | Links and examples checked by hand against the code |
| Poise Link (`link/`) | In `link/src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` |

CI runs the Poise gates on Node 22 for pull requests and on Node 20, 22 and 24 for `main`. The Caller workflow runs Caller's tests on Python 3.13 for pull requests and `main`. The Poise Link workflow runs its gates on Ubuntu for pull requests and `main` pushes that touch `link/`, and builds the macOS, Windows and Linux installers only when run by hand or for a `link-v*` tag.

## Proof obligations

- A change to an interface in `docs/Service-architecture.md` updates the document and the tests on both sides of the interface.
- Service-mode behavior is tested with `POISE_MODE=service` and an isolated `HOME`; nothing in a test may read or write the developer's real `~/.poise`, `~/.claude`, `~/.codex`, gh configuration or Espanso folder.
- Security-relevant paths (identity assertions, sessions, device tokens, the terminal, replay checks) carry negative tests: forged, expired, wrong-audience, wrong-scope and missing credentials are each rejected.
