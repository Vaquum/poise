# Agent instructions

Read [CLAUDE.md](CLAUDE.md) before acting. It is the repository constitution for humans and agents.
Read [AUTONOMIO_PR_GUIDELINE.md](AUTONOMIO_PR_GUIDELINE.md) for the rules every Autonomio pull request follows.
Read [POISE_REPO_SPECIFICS.md](POISE_REPO_SPECIFICS.md) for this repository's layout, toolchain, gates and proof obligations.
Read [docs/Service-architecture.md](docs/Service-architecture.md) before touching the gateway, the workspace runtime, Poise Link, or any interface between them.

User and higher-priority session instructions take precedence. Repository instructions do not authorize remote writes, messages, merges or publication by themselves.

## Poise MCP

The production `poise` MCP endpoint is `https://poise.vaquum.fi/mcp`.
Call the `poise_describe` tool with `{}` to see the connected workspace, running
release, effective grants, available tools, and coverage for each Poise surface.

In Codex, run `codex mcp list` to check whether `poise` is configured and signed
in. If it is missing, install the deployment's
[private Poise plugin](docs/Poise-MCP.md#private-plugin). If sign-in is needed,
run `codex mcp login poise` and have the workspace owner approve the grant in
the browser.
