# Extensions

Extensions are the MCP servers Poise chats can use. Open them from the burger
menu (Extensions is a view of its own, placed in the menu by default; move it
to the top bar under Settings → Navigation).

## Installed

A grid of servers by workspace. A workspace is the repository a chat works in;
chats without one share **Poise · local**. The columns are the twelve most
recently used workspaces, Poise · local, and any workspace a server has a
switch of its own for. Each cell switches a server on or off for that
workspace's chats. **New workspaces** is the switch for
workspaces chats have not used yet: changing it leaves the workspaces already
shown as they were.

The status column says whether the last check connected (and how many tools
the server offers), needs a sign-in, or failed and why. Selecting a row opens
its details: **Overview** (status, connection, which agents it reaches,
where it is on), **Tools** (from the last check) and **Activity** (the last
100 events: added, edited, checked, signed in, delivered to which chat).
**Check now** connects the way an agent would and lists the tools; a local
server runs once in a scratch folder with the same command and environment.

Turning a server off, editing it or removing it applies from each chat's
next turn. A turn already running keeps the tools it started with. Removing a
server also removes its secrets and Activity; a check or sign-in still running
for it finishes without recording anything.
The row stays in place until removal is confirmed. A failed removal can be
retried; a server already removed in another tab is treated as removed.

## Directory

The directory is Poise's own copy of the official
[MCP Registry](https://registry.modelcontextprotocol.io). The registry's
search takes tens of seconds and single pages often take most of a minute, so
Poise crawls it in the background (when the view opens and the copy is a day
old, or on **Refresh**), resumes from the page that failed after an error, and
keeps the last complete catalog until a new crawl finishes. After a failed
crawl, opening the view waits ten minutes before trying again; Refresh tries
at once. Search covers the
title, the registry name and the description. A few well-known servers come
first when nothing is searched.

Each entry offers its remote endpoint, its package, or both. **Add to Poise**
asks only for what the entry declares: URL variables, header values (a
`Bearer {token}` template asks for the token), package arguments and
environment variables. Values the registry marks secret are stored as
secrets. Packages run with `npx` (npm) or `uvx` (PyPI); an option is shown as
unavailable, with the reason, when:

- its launcher is not installed where Poise runs (the workspace image has
  `npx`, not `uvx`);
- it is an OCI, NuGet or MCPB package, or runs its own HTTP server;
- it takes a secret as a command-line argument, which Poise does not store.

Add such a server as a custom one instead. Entries the registry marks
deprecated or deleted are not listed.

`POISE_MCP_REGISTRY_URL` points Poise at another registry with the same API
(the end-to-end tests serve one locally).

## Custom servers

**Remote URL** takes a Streamable HTTP or SSE endpoint and its
authentication: none, a bearer token (sent as `Authorization: Bearer …`),
headers of your choosing (any of them marked secret), or OAuth sign-in.
**Local command** takes a command, its arguments and its environment
(variables marked with the lock are secrets). **Paste JSON** reads an
`mcpServers` block as Claude Desktop, Cursor or VS Code write it; values whose
names or shapes look like keys or tokens become secrets.

Beside the form, **What chats receive** shows exactly what each agent gets for
the server being edited, with secrets shown as `‹secret›`.

A directory server's command or endpoint comes from the registry: editing it
changes its display name, its values and its secrets.

## OAuth sign-in

A remote server that answers a check with an OAuth challenge is marked as
needing a sign-in. A 401 is an OAuth challenge only when the server names an
authorization server (its protected-resource metadata, or OAuth metadata at
its own origin); otherwise the check fails asking for a token or headers.
**Sign in** runs the MCP SDK's client flow: Poise discovers
the authorization server from the server's protected-resource metadata,
registers itself as a public client, and sends the browser to the provider
with PKCE. The provider returns the browser to `/extensions/oauth` on this
Poise, which finishes the exchange and opens Extensions on the server (it is a
page, not an API route, because the API refuses cross-site navigations). The
return is accepted once, within ten minutes, only for a flow Poise started,
and only from an HTTPS origin or HTTP on localhost. Signing in again starts a
new authorization, and chats keep the current sign-in until it completes.
Poise renews the access
token before it expires; a refused renewal marks the server as needing a
sign-in again. Providers that do not support dynamic client registration
cannot sign in this way; use a token or headers if they offer one.

## Delivery to chats

Before a chat's agent starts, and before every turn, Poise collects the
servers switched on for the chat's workspace, with their secrets and current
OAuth token. When that set differs from the one the agent runs with, Poise
resumes the same native session with the new set before the turn. Each agent
receives the servers through its own protocol, never on a command line:

| Agent | How | Not supported |
| --- | --- | --- |
| Claude | Agent SDK `setMcpServers()` over the control channel | — |
| Codex | app-server `config` on `thread/start`, `thread/resume` and `thread/fork`: one `mcp_servers.<name>` key per server, so servers in `~/.codex/config.toml` stay | SSE |
| Grok | ACP `mcpServers` on `session/new` and `session/resume` | HTTP or SSE when its `initialize` does not advertise them |
| Muse | `config.mcpServers` on `session/start` and `session/resume`, after asking for the `sessionMcp` capability | SSE; every server when Muse does not grant `sessionMcp`. A fork takes no configuration, so it resumes with the servers before its first turn |

The [Switchboard](Switchboard.md)'s chat gets no servers: it reads other
chats only through Poise.

A server a chat does not get is never dropped silently. The chat shows a line
naming it and why, once per change: it needs a sign-in, a secret is missing,
the agent cannot take its transport, or the agent could not connect to it.
The server's Activity records each delivery.

Agents name tools `mcp__<name>__<tool>` (Codex and Grok show
`<name>: <tool>`). A server's name comes from the name you give it when you
add it; a directory or imported server takes `-2`, `-3` and so on when another
server has it already. Editing keeps it, so the tools agents know keep their
names.

## Secrets

- Secret values (secret environment variables and headers, OAuth tokens and
  client registrations) live only in the `extension_secrets` table of the
  workspace database, which is owner-only (`server/db.ts`) and uses
  `secure_delete`, so a removed secret's bytes are overwritten.
- They are write-only: no API response carries one. A view says only whether
  each is set, and an edit replaces a secret only when a new value is typed.
- Chat log lines, diagnostics, transcript events, Caller turn errors, check
  errors and Activity lines are scrubbed of every stored secret value before
  they are written.
- They are not encrypted at rest. Backups take the whole home volume, so a key
  stored beside them would protect nothing. Anyone who can read the
  workspace's home volume can read them, as with the agent CLIs' own logins
  there.

## API

`/api/extensions` serves the view:

| Method and path | Does |
| --- | --- |
| `GET /api/extensions` | servers, workspaces and the directory's status |
| `POST /api/extensions/servers` | add a custom server (`spec`, `secrets`, `enabled`) or a directory one (`install`) |
| `PUT /api/extensions/servers/:id` | edit; omitted secrets are kept |
| `DELETE /api/extensions/servers/:id` | remove, with its secrets |
| `PUT /api/extensions/servers/:id/enabled` | `{ workspace, on }` or `{ default }` |
| `POST /api/extensions/servers/:id/check` | check now |
| `GET /api/extensions/servers/:id/events` | Activity |
| `POST /api/extensions/servers/:id/sign-in` | start OAuth: `{ origin }` → `{ authorizationUrl }` |
| `POST /api/extensions/servers/:id/sign-out` | forget the sign-in |
| `POST /api/extensions/oauth` | finish OAuth: `{ state, code }` or `{ state, error }` |
| `GET /api/extensions/directory` | search: `q`, `kind` (`any`, `remote`, `local`), `limit`, `offset` |
| `POST /api/extensions/directory/sync` | crawl the registry now |
| `POST /api/extensions/import` | add the servers of a pasted `mcpServers` block |

## Tests

- `tests/extensions.test.ts`: definitions, the store and its secrets,
  delivery, mapping and installing real registry entries
  (`tests/fixtures/extensions/registry-sample.json`), crawling, and the API.
- `tests/extensions-oauth.test.ts`: OAuth against a local authorization
  server and a local stdio check.
- `tests/chat/adapter-extensions.test.ts`: what each adapter sends.
- `tests/chat/runtime.test.ts`: next-turn resumes, notices and scrubbing.
- `tests/e2e/extensions.spec.ts`: the view against the real server, including
  a browser OAuth sign-in.
