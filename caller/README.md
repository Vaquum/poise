# Caller

Caller is the three Python command-line tools Poise drives. They came from
`mikkokotila/caller` at `a6a4c4c`, with their package layout, tests and
contract documents.

| Package | CLI | What Poise uses it for |
| --- | --- | --- |
| `agent_interface/` | `agent-interface` | Runs the model CLIs for PR reviews, approvals, issue reviews, `/content` and `/consensus`; keeps the calls log Swarm shows; exports the model catalog |
| `github_interface/` | `github-interface` | Repository lists, checkouts, pull request state and sub-issues for the behaviors; resolves non-blocking review conversations. `agent-interface` posts its reviews and comments through it |
| `github_datastore/` | `github-datastore` | The per-account SQLite index of issues and pull requests behind Current, Archive and the behaviors |

Each package's own README, AGENTS and (for the datastore) CONSUMER_CONTRACT
describe its contract.

## How Poise runs them

Poise runs the three CLIs from `caller/.venv/bin` and runs `agent-interface`
with `caller/agent_interface` as its working directory. `CALLER_BIN_ROOT` and
`AGENT_INTERFACE_ROOT` (absolute paths) name another installation instead.
`/api/health` reports Caller as `callerRelease`: `ready` when the three CLIs
are runnable, with each package's version from its `pyproject.toml`. The
production server does not start without it, and `npm run install:production`
builds the same virtualenv in the production checkout.

## Setup

Caller needs Python 3.13 (`brew install python@3.13`; `POISE_PYTHON` names
another interpreter).

```bash
npm run caller:setup
```

This creates `caller/.venv` (rebuilding one that is not Python 3.13), installs
the three packages into it editable, plus pytest, and checks the installed
versions against `caller/`. Run it again when a Caller change adds a
dependency.

Without `AGENT_INTERFACE_DATA_DIR`, `agent-interface` keeps its calls and
responses in `caller/agent_interface/data`, which Git ignores.

## Tests

```bash
npm ci
caller/.venv/bin/python -m pytest caller/agent_interface/tests caller/github_interface/tests caller/github_datastore/tests
```

The checkout-lock interop tests drive this repository's TypeScript lock with
Node 22, so `npm ci` comes first. The Caller workflow
(`.github/workflows/caller.yml`) runs the same suites on Python 3.13, parses
every Python file and checks each CLI's `--help`.
