# Setup, and the states any page can be in

Sources, in ~/dev/poise as of 21 Oct:
- **Setup:** `src/onboarding.ts`.
- **Page states:** `src/updating.ts` and `src/signed-out.ts`.
- **The gateway's own pages:** `gateway/src/pages.ts`.
- Round 13: `main` at `e7b8fea` (1 Nov), for the three model slots and Random (#670, #751) and the agent account added to every repository (#748).
- 4 Nov: `main` at `741d2c4`: Setup is unchanged there.

## First-run setup (F1–F12): `setup.html`

A new workspace opens a dialog over the dimmed app. It takes you through what Poise needs, in the order it needs it. Each step checks that its connection works before the next one opens.
- F1 It opens on a new workspace, and resumes at the step you left.
- F2 Theme: light or dark, applied at once. Removed on 3 November: the new interface is dark, so setup starts at GitHub. Classic keeps Light and Dark at `/classic.html` until it is removed.
- F3 Your GitHub account, by GitHub's device sign-in: a one-time code, then approval at GitHub, then the connection is checked.
- F4 The agent account, which can wait. It cannot be your own account. Since #748, Poise invites it to every repository in your organizations and accepts each invitation for it; the step says so.
- F5 Organizations, each activating in steps until it is Ready. They keep activating if you go on.
- F6 Time zone and refresh rate.
- F7 AI accounts. Each signs in with its own login, in a terminal inside the dialog. Antigravity cannot report whether it finished, so it asks you.
- F8 Models. Since #670, three slots chosen once, then which slot each of the seven places runs; since #751, any place can run Random, which draws one of the three on every run. Models from providers you have not signed in to are dimmed, not hidden.
- F9 This computer: Poise Link, which can wait.
- F10 Done: what was set, what waits, and Open Poise.
- F11 Back, Skip for now and Continue. Escape does not end setup; Finish later does.
- F12 Settings → General → Run setup again opens it with today's choices filled in, and returns you to Settings.

## States any page can be in (U1–U2)

Add `?state=updating` or `?state=signedout` to any page's address to see them; `?state=claude-reauth` and `?state=build` show the two notices at the foot of a page.
- U1 **Updating.** The page dims under "Updating to the latest version…", says that running agents and reviews carry on, and reloads into the new version when Poise answers again.
- U2 **Sign-in ended.** "Your sign-in has ended", with Sign in again. Signing in brings you back to the page you were on.

## The gateway's pages (Y1–Y6): `gateway.html?state=…`

The gateway is the sign-in in front of every workspace. It stays plain on purpose, on the same tokens.
- Y1 **Sign in:** Sign in with GitHub.
- Y2 **Your workspace:** its address, Open your workspace, and Sign out.
- Y3 **Starting your workspace:** reloads by itself, and shows the last failure with a link for admins.
- Y4 **Updating Poise:** the same words as the in-page notice.
- Y5 **Sign out of Poise?:** asks once.
- Y6 **Not allowed:** for an account that may not sign in, saying where an admin adds it.

A strip of links under the card shows every page side by side. It is a reviewing aid, not part of the design.
