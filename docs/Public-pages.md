# Public deployment pages

The gateway can host a deployment's public description, privacy notice and terms
at its apex. No domain, operator contact or policy text is built into the image.
An installation without approved content keeps its existing sign-in page and
returns 404 for `/privacy` and `/terms`.

## Prepare and publish

After installing Poise, copy `deploy/public-pages.example.json` somewhere outside
the checkout. Replace its app name, contact email and example paragraphs with
the content approved for your deployment. The example is a writing aid, not a
policy automatically adopted by installation. The operator remains responsible
for accurate data-use, sharing, retention and backup statements and service terms.

```bash
cp deploy/public-pages.example.json /path/to/reviewed-public-pages.json
# Edit and review every field before publishing.
deploy/public-pages.sh validate /path/to/reviewed-public-pages.json
deploy/public-pages.sh publish /path/to/reviewed-public-pages.json
```

Validation does not publish. `publish` installs the explicitly supplied content
into `public-pages.json` in the existing gateway data volume, then restarts the
gateway and checks its health and workspace networks. It builds no image and
recreates no workspace. A refused input stops before restart and leaves the last
approved file intact. Upgrades never install the example or overwrite this file;
normal gateway backups and restores include it.

The version-1 JSON has exactly `version`, `appName`, `contactEmail`, `description`,
`privacy` and `terms`. The last two are nonempty arrays of plain-text paragraphs;
HTML is escaped. `description` and policy paragraphs may contain `{{domain}}`,
`{{origin}}`, `{{appName}}` and `{{contactEmail}}`. The gateway resolves the domain
and origin from its current `POISE_DOMAIN` and HTTPS configuration. Unknown
substitutions, malformed content, symlinks and files larger than 128 KiB are
refused. Missing optional content is distinct from unreadable or invalid content:
the latter stops gateway startup with an operator error, without echoing policy
or credential data.

## Routes and proxies

Only the configured apex exposes `/privacy` and `/terms`, with GET and HEAD.
The raw request path must be canonical: dot segments, backslash aliases,
network-path and absolute-form targets cannot select these public pages. Query
strings do not change the selected page. They accept no mutation and provide no directory or arbitrary file access.
The anonymous apex home page shows the operator's description, policy/contact
links and the existing GitHub sign-in. Signed-in home behavior is unchanged.
Workspace hosts and every authentication, device and admin route retain their
existing access checks and security headers.

The standard bundled Caddy already forwards these routes to the gateway. With
an external proxy that adds its own login, allow **GET and HEAD on exactly `/`,
`/privacy` and `/terms` on the apex** through to the same gateway without that
extra login. Do not exempt workspace hosts, arbitrary path prefixes or any
additional methods. A Caddy named matcher can preserve the original URI, avoiding
its normal path cleaning:

```caddyfile
@public {
    method GET HEAD
    expression `{orig_uri}.matches('^/(privacy|terms)?([?].*)?$')`
}
```

Use that matcher only within your configured apex block and forward it to the
same gateway before the extra login handler. This serves the gateway's public content; it grants no
workspace access. Other proxy requirements remain in [Operating](Operating.md#behind-your-own-proxy).

## Google consent configuration

Use your own deployment origin for Google's application home page and append
`/privacy` and `/terms` for the corresponding policy links. Register its existing
`/auth/google/callback` on your Google web client. Verify these three public pages
over HTTPS without a signed-in browser before changing the consent publishing
status. Google scopes, branding review and publishing status are still configured
in your own Google Cloud project; page publication alone does not change them.
Google's Testing status can impose seven-day grants. Follow the provider's actual
production requirements rather than leaving Testing as an undisclosed finished
configuration. See [Google connections](Google-connections.md).

Before publishing in Google Cloud, follow [Google's brand-verification
requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).
Verify ownership of the authorized domain using the linked Google Search Console
procedure, use the same app identity in the consent screen and public pages,
and register your deployment's actual HTTPS homepage, privacy and terms links.
Save Branding, then complete Audience's publishing flow and any applicable
Verification Center steps. Verify the resulting production status separately;
this command neither verifies a domain nor publishes a Google Cloud app.
