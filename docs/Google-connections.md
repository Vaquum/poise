# Google connections

In Accounts, choose **Connect Google**, select an account in Google's ordinary
browser page and approve access. Add Google account repeats that flow for another
email. Rows use the same components, type scale and theme tokens as agent accounts.
Connected, Needs sign-in and Disconnected describe the account grant; an individual
file can still have a separate access problem.

Connecting from Editor Publish saves text and annotations before leaving. The
Editor cannot change during that transition. A failed save leaves the draft on
screen and stops connection. Returning restores the saved draft, Publish panel
and the subject verified by Google, without publishing. Reconnect requires the
same subject. Cancellation does not install a grant. Incoming Google edits still
require [explicit review/import](Publishing.md#google-docs).

## Operator configuration

Enable Drive API and configure a Google web OAuth client once for the deployment.
Set `POISE_GOOGLE_CLIENT_ID` and `POISE_GOOGLE_CLIENT_SECRET` in its private
`deploy/.env`, with this exact registered redirect:

```
https://<POISE_DOMAIN>/auth/google/callback
```

No workspace redirect registration or user-entered client secret is needed. Both
variables absent leaves Google unavailable with an operator-facing explanation;
a partial or invalid pair stops gateway startup without printing values. Keep the
file private as described in [Operating](Operating.md). Add intended users to the
Google consent screen's test audience when its publishing status is Testing;
Google can expire those test grants. Production consent-screen status and branding
remain deployment responsibilities. Requests use `openid`, `email` and
`https://www.googleapis.com/auth/drive.file`; no broader Drive access is requested.

For a repeatable public home page, privacy notice and terms on your own domain,
use [public deployment pages](Public-pages.md). The operator supplies and reviews
the content; no installation-specific address or policy is shipped as a default.

On a personal computer, set the same client pair and `POISE_GOOGLE_ORIGIN` to the
literal local HTTP loopback origin (for example `http://127.0.0.1:5555`) in the
private application environment. Register that origin plus `/` with Google. All
three variables are required together. Local Poise retains compatibility with
previous private direct-client configuration and grants; Accounts has no setup
form and `/api/google/config` is no longer supported.

## Service trust and persistence

The existing gateway owns the app secret and long-lived grants. Workspace and
browser responses never contain that secret or refresh tokens. A workspace
receives only short-lived access tokens for its admitted document operation;
the browser receives account metadata and a verified completion outcome.

The private gateway `google-connections.sqlite3` partitions records by immutable
GitHub owner ID and Google `sub`, not email. AES-256-GCM encrypts offline grants,
PKCE verifiers and staged results with record/owner-associated data. A
domain-separated HKDF key derives from the gateway's protected Ed25519 identity
key. Back up the data and identity key together; the operator already controls
both. Identity-key rotation makes old grants unusable and requires reconnect.
Tampered/unreadable encrypted grants become Needs sign-in. Local direct grants
remain in the private local SQLite database under its existing OS-user trust
boundary. Existing unused direct service credentials are never a broker fallback.

The workspace identity guard removes `X-Poise-Identity` and privately retains the
verified browser assertion in a request-keyed weak map. Browser assertions add
signed `sid`, the hash reference to the exact authenticated workspace session, and
`gport`, the gateway listening port. The broker uses the actual verified TCP peer
and that signed port over the existing private workspace network, with the fixed
internal gateway host. It requires neither public-apex egress nor Docker DNS, so
the isolated-VM deployment remains supported. A missing signed port requires a
gateway update rather than a public-routing fallback.
The Google broker verifies signature, issuer/audience, current login/owner,
browser scope, bounded lifetime and that workspace session and its parent apex
login. Link/admin assertions, browser cookies, caller-supplied replacements and
ended sessions cannot admit Google operations.

`POST /_gateway/google` accepts bounded JSON, fixed actions and server delegation;
it is not a URL proxy. `open` uses the normal sixty-second assertion exactly once
per `jti`, admitting a random server-only operation credential for a fixed purpose.
The gateway stores its hash, owner, exact login and fixed twenty-minute deadline.
Subsequent `settings`, `begin`, `finish`, `token`, `disconnect` and `close` calls use
that credential. Purposes restrict mutations and token reads. Every action and
post-provider return rechecks the original login, owner/access and deadline.
Another live login cannot substitute after logout, expiry or disable→enable.
Workspaces neither accept expired assertions nor mint replacements. At most ten
operations, ten pending sign-ins and ten connected accounts per owner are admitted.
Cleanup closes operations; their fixed expiry bounds interrupted requests.

Each workspace Google request has its own async context. Connection-version
checks reread current broker metadata; credential requests require the admitted
version. Refresh is single-flight per owner, subject and connection version, with
compare-and-swap before installing results. Terminal `invalid_grant` requires
Reconnect; transient provider failures and file permission loss do not disconnect
an account. A Drive 401 probes refresh without replaying the original remote
request. Disconnect forgets this deployment owner's grant and invalidates older
flows; it does not globally revoke another owner's shared Google authorization.

## Browser completion

A flow uses a random 32-byte state, 48-byte PKCE verifier with S256, ten-minute
expiry, hashed browser proof, original sessions, connection epoch, expected
subject and client fingerprint. Apex start and callback require the exact parent
login. Callback stages an encrypted result; it cannot install a grant. It returns
only an opaque receipt to the recorded owner's workspace. The workspace consumes
that receipt and retained flow proof under its existing publication lock before
activating a connection. Cancellation/failure are consumed outcomes too; replay,
wrong sessions, missing proof and old generations cannot change a grant.

Tab storage retains state, intent, expected account, time and random proof for
that flow. It is a possession-based guarantee: an opener/duplicated tab can inherit
session storage. The first valid completion wins; later completions fail. A fresh
tab without proof cannot complete. Starting an Accounts flow clears an older
Publish intent. Missing, expired or unreadable context opens Accounts with recovery
instructions; a missing original draft never selects another one for publication.

The twenty-minute operation deadline includes publication-lock wait, provider
latency and response synchronization. Expiry stops further delegated work. If a
remote write completed before a later failure, keep the same reserved file ID and
report uncertainty; never replay a mutation automatically. A fresh explicit read
or review reconciles that destination under the existing revision guards.

## Existing files and app migration

Reconnecting an account establishes identity. It does not grant a different Google
app `drive.file` access to every existing document. Reuse the original Google app
where its file authorization must continue. A destination created with another
app can remain inaccessible even after the same Google subject reconnects.

Poise retains that destination's exact ID and baseline and shows a file-specific
blocked state. Repeating Reconnect is not a guaranteed repair. Preserve the
original file/comments; ask the operator to retain the authorized Google app, or
continue editing the original in Google Docs until app authorization is available.
Poise does not create a replacement, substitute an account, broaden scope, expose
a browser Picker token or use an old workspace grant as a service fallback.

The [provider proof](Google-markdown-proof.md) establishes the earlier local
Markdown/comment/conditional-write behavior. It does not establish this central
flow's live service acceptance. Real browser consent through the maintained
gateway, both return destinations and explicit publication to two independent
files remain release proof.
