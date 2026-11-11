# Settings, against the brief

Sources, all in ~/dev/poise as of 21 Oct, plus the live app on 22 Oct:
- **General:** `src/settings.ts`, `service-settings.ts` and `config.ts`, and the live General section. That build also has Concurrent local turns, which the checked-out branch does not.
- **Accounts:** `views/connected-accounts.ts`, `google-accounts.ts` and `poise-link.ts`, and `server/accounts/types.ts`.
- **Models:** the Models part of `src/settings.ts`, `server/models.ts`, and the fixed models in `server/cache-plugin.ts`.
- **Publishing:** `views/publishing-settings.ts`, `docs/Publishing.md`, and the Google Docs publishing in `google-accounts.ts`.
- **Navigation**, removed in round 11: `src/navigation-settings.ts` and `src/navigation.ts`.
- **Behaviors:** `src/behaviors.ts`, `views/behaviors-view.ts`, `server/behaviors.ts` and `docs/Behavior-Contract.md`.
- **Snippets:** `views/snippets-view.ts`.
- **Admin:** `views/admin-settings.ts`.
- **Style:** `src/typo.ts`, the live Typography panel; and the mock's Style panel, `style.js`, from round 4.
- **Manager:** brief section 6, and the Manager's controls in `manager.html`. Since 24 October the controls are stored on `main`, with live defaults of Rhythm 5, Balanced and Balanced, but not yet enforced.
- **Extensions**, added in round 13: `src/views/extensions-view.ts` and `docs/Extensions.md`.

Round 13 re-read every section against `main` at `e7b8fea` (1 November), and Behaviors and Storage again at `741d2c4` (4 November); [CHANGES-2026-11-03.md](CHANGES-2026-11-03.md) and [CHANGES-2026-11-04.md](CHANGES-2026-11-04.md) list what moved.

Round 8 built General to set the pattern. Round 9 applied it to the other seven sections. Round 10 adds Style and Manager, which until now lived only beside the work. Round 11 removes Navigation, adds Google Docs to Publishing and the release line to General, and calls Current by its new name, Board. Round 13 adds Extensions, builds Models on three slots, brings the behavior engine and the issue-to-merge chain into Behaviors, and adds SSH keys, storage and the Manager's wake-ups.

## How the brief lands

| Brief | In Settings |
|---|---|
| 1 · One vocabulary | The seven state words appear wherever something is in motion or wrong: an account activating, a sign-in terminal, a catalog check, a workspace, a behavior's last run. A settled thing says so quietly (Ready, Signed in as …, Connected), with no chip. "Concurrent local turns" becomes **Running at once**. |
| 2 · Reference | Every row, control and status carries a key; `refdefs-settings.js` holds Settings' entries. A setting's reference gives its current value, the other values, its scope, when a change applies and what it leaves alone. |
| 3 · Overview | The sections column counts, per section, the settings you changed from their defaults. |
| 4 · By purpose | Settings is a place under the top bar's Settings, like Board or Chat, with a route back. Behaviors and Snippets, top-bar rooms today, become sections of Settings: they configure what Poise does. Their run counts and success rates move to Overview. |
| 5 · Defaults and stability | Each row says whether it is the default. A changed row offers Reset and names the default. Rows never reorder, and a save never moves the page. Removing something leaves its row in place with Undo for eight seconds. |
| 6 · Manager controls | Settings → Manager holds Rhythm, Stability ↔ Expansion and Autonomy, what they add up to, the scope, the standing instructions and how often the Manager wakes. The same settings open from the Manager's header, over its work table; a change in one shows in the other. |
| 7 · Element review | G1–G17, A1–A11, M1–M7, P1–P7, N1–N6, B1–B9, S1–S8, D1–D7, X1–X28 and T1–T17 in the review: kept, moved, merged, removed or new. N1–N6 are all removed. What `main` added since, such as Random, the chain and SSH keys, has rows of its own. |
| 8 · Feedback and continuity | Each setting saves itself on its own row: Saving…, then Saved with when it applies, and Undo. Errors stay on the row they belong to. A snippet saved in Editor appears in Snippets. |

## The place

- **Left: a sections column.**
  - "Find a setting" sits at the top and searches every section by name, explanation or value. `/` focuses it.
  - Then the sections: General, Accounts, Models, Extensions, Publishing, Behaviors, Snippets, Admin, Style and Manager.
  - Then Elsewhere: the Style panel, which opens over the page you are on, and the Manager's controls in its place.
- **Right: the section.** It scrolls inside the view, so the top bar never moves.
- **Addresses.** `settings.html#models` opens a section. `?setting=timezone` lights one row. `?back=editor` adds a route back to Editor.
- **States, for review.** `?storage=partial`, `stale` or `failed`; `?ssh=none` or `error`; `?engine=v1`, `unsupported`, `unavailable` or `paused` (v2 owns new work but the setup can no longer prove its cleanup); `?directory=failed`; `?labels=error`.

## The setting row

One pattern for every setting:

```
Label  [This browser]          [ control              ]
What it does, in one line.      Default · or · Changed · Reset to 1 min
                                Saving… → Saved 19:42 · applies now · Undo
                                Not saved: must be a GitHub login, not a URL or email.
```

- **Explanation.** The live help text, always visible under the label. The full reference adds the rest.
- **Scope chip.** It appears only when a setting is kept in this browser only: Refresh rate and Theme. Notifications are kept by the server, which runs their checks whether or not a page is open.
- **Saving.**
  - Pickers save when you choose.
  - Text and number fields save on Enter or when you leave the field.
  - Esc puts back the saved value.
  - Nothing is saved while the value is invalid.
- **When it applies.** The Saved line says it in a few words: "applies now", "from the next chat", "from the next review".
- **Undo.** It stays on the row for eight seconds. After that, Reset is the way back.
- **Lists.** Accounts, sites, snippets and people are lists inside one row. Each item has its state on the right. × then Sure? removes it, and the item stays in place with Undo for eight seconds.

## General (G1–G16)

**Today**
- G1 Settings is a panel over the view, opened from the burger menu.
- G2 Your GitHub account. G3 GitHub automation account.
- G4 Following: Ready, Activating… with its stage, Waiting for GitHub, Sync failed or Activation failed, with Retry. There is no way to stop following.
- G5 Time zone. G6 Refresh rate (this browser). G7 Notifications On or Off.
- G8 Branch prefix. G9 Idle timeout (minutes). G10 Concurrent local turns.
- G11 Theme (this browser). G12 Run setup again (service mode). G13 Production updates (production installs).
- G14 One Save button for the text fields, with one status line. G15 Help in hover tooltips.
- G16 The release line at the top of the menu: the commit Poise runs (autonomio/poise@…) and since when.
- G17 Update wait: how long running turns may hold up a Poise update (#473).

Since then on `main`: the cap on concurrent turns is shared by chat turns and behavior runs, and background work always leaves one for the turns you send (#576). An idle timeout of 0 never expires. Storage reports failed, partial and stale readings, with their age and Retry (#631).

**Redesigned:** one row per setting, saving itself. Following gets Stop following, and keeps `main`'s states: northwind reads Sync failed, Waiting on GitHub's 502, with Retry, the same failing sync as Overview's notice. The release line moves under This install, in the same words.
- **Theme** is gone. The new interface is dark; classic keeps Light and Dark at `/classic.html` until it is removed (#556). Setup no longer asks for a theme.
- **Running at once.** The new name for Concurrent local turns, 1 to 64 as on `main`. Chats and behavior runs share it. From 2, one is always left for your own turns; from 3, workers' turns leave one for behavior runs, so the reviews that finish a worker's pull request can start. Past the limit, a turn or run shows Waiting, saying for what. This workspace runs 10.
- **Idle timeout.** 0 reads Never.
- **Update wait.** Beside Running at once. A chat it holds shows Waiting · *for the Poise update*.
- **Storage**, under This install. Free space and what uses it, with maintenance. A partial, stale or failed reading says so with its age, and offers Retry. This workspace reads 4.6 GB free of 100 GB, 95% used: the same reading as Overview's disk notice. The categories are `main`'s, word for word, with the shared ones marked *(retained)*: maintenance never removes them.

## Accounts (A1–A10)

**Today**
- A1 AI accounts: one row per agent CLI (Claude, Codex, Grok, Muse, Antigravity). Each shows its version and what its status command says: Signed in as …, Signed in here, Not signed in, Sign-in not reported or Not installed.
- A2 Connect or Reconnect opens a sign-in terminal that runs the CLI's login. One terminal at a time.
- A3 GitHub accounts:
  - the accounts gh holds;
  - which one is active, and which are your account and your automation account;
  - a warning when either of yours is not signed in.
- A4 A status line while accounts are checked, with any errors.
- A5 Google accounts:
  - each is Connected, Needs sign-in or Disconnected, with Disconnect or Reconnect;
  - Add Google account, up to ten;
  - unavailable until the operator enables Google.
- A6 Install Poise Link: the command with Copy, a Windows installer and a command without curl.
- A7 Approve or Deny the code Poise Link shows.
- A8 Paired computers: Connected, Not connected with when last seen, Revoked or Expired, with Revoke.
- A9 Terminal: Open a shell for connections the buttons do not cover. Two can run at once; an idle one closes after 15 minutes.
- A10 A sign-in alert opens Settings at Accounts.
- A11 Muse: which credential it holds, and Use an API key (#468).

Since then on `main`: SSH keys in Accounts (#793). Poise adds the agent account to every repository by itself, once a minute (#748). A provider you never set up raises no sign-in alert (#639).

**Redesigned**
- **Groups.** Agents, GitHub, Google, Poise Link and Terminal.
- **Agents.** Each row says what it signs in with, its state and its version.
  - "Not signed in" is in the Needs you colour, because only you can fix it.
  - Connect opens the sign-in terminal under that row and shows it working: Running while it waits for you, then Signed in.
  - While one terminal is open, the other Connect buttons say why they wait.
- **GitHub.** gh lists the accounts it holds, marked as active, your GitHub account or your automation account.
- **Google.** Each account is Connected or Needs sign-in, with Reconnect. Disconnect uses Sure?, then Undo.
- **Poise Link.**
  - The install command, with Copy.
  - The code to approve, with Approve and Deny. A pairing shows on the row: Running while it pairs, then the new computer at the top of Paired computers.
- **Terminal.** Open a shell, inline under its row.
- **SSH keys**, beside GitHub.
  - Each key in `~/.ssh` with its fingerprint. Poise lists public keys only and never reads a private key file.
  - A key whose permissions are too open says that ssh refuses it, and how to fix it.
  - Each of `main`'s other states reads in its words: a key with no `.pub` yet says how to derive it; a `.pub` that holds no readable key says so; a `.pub` with no private file is *Public key only*.
  - Add an SSH key opens a terminal under the row; the private key never leaves it.
- **Automation account**, in General. It says that Poise adds it to every repository in your organizations by itself.

## Models (M1–M7)

**Today**
- M1 Saved configurations: choose one, Use or Delete, or name the current choices and Save current.
- M2 Model choices for five places: Chat, Editor chat, PR review, PR approval and Issue review. Each has a Default and a Fallback, and explains what it is for on hover.
- M3 PR review and Issue review also name a secondary and a tertiary reviewer.
- M4 Notes on a place when a choice was retired or its provider is unavailable.
- M5 Fixed models set by Caller: /content, /consensus, Fix failing CI, Simplify issue and Sign-in check.
- M6 Model catalog: how many models and when they were checked. Check now updates the provider CLIs and then checks the models, showing the time elapsed. A daily check runs at 07:00.
- M7 Model choices are saved by General's Save button. Errors such as "the fallback must differ from the default" show beside that button.

Since 25 October on `main`: models are three slots, Primary, Secondary and Tertiary, chosen once. Every place picks a slot, never a model, and a failing model hands the run to a slot not yet tried (#670). There are seven places: Chat and Editor chat; PR review, PR approval and Issue review; Issue implementation and PR repair, which the chain added. Since 29 October each place can pick Random, which draws one of the three slots on every run (#751).

**Redesigned**
- **The three models.** Chosen once, at the top. Changing a slot changes it everywhere it runs.
- **Where each one runs.** One row per place: Primary, Secondary, Tertiary or Random.
  - Each choice saves on its own, says when it applies, and offers Reset.
  - PR review and Issue review take the slots after their own as further reviewers, when Behaviors asks for more than one. Random draws different models.
- **Saved configurations.** Use one, and every place changes at once, with Undo on the row. Save the current choices under a name. Delete uses Sure?.
- **Set by Caller.** The five fixed models, read-only, each saying what it does.
- **Catalog.**
  - Check now shows its progress: Running with the time elapsed, then Done with what changed. The daily check runs at 07:00 in your time zone.
  - A new model can be chosen for a slot at once.

## Publishing (P1–P7)

**Today**
- P1 Sites, one per repository: name, repository, and Ready, Ready · described here, or what is wrong.
- P2 Add a site by owner/repository or its GitHub address.
- P3 Describe or Edit: a site's publish.yaml, kept in Poise when the repository has none. It is saved only when it reads; otherwise the box keeps the text and shows the error.
- P4 Remove, then Confirm remove.
- P5 A warning under a site when something about it needs attention.
- P6 Google Docs: publish a document to a connected Google account's My Drive, as Markdown, for each account.
- P7 Google's edits and comments on a published document, checked every minute, to review, keep, publish over or import in Editor.

**Redesigned**
- **Sites.**
  - Each is one item: the site, its repository and its state.
  - A site whose repository has no publish.yaml says Needs you, with Describe.
- **Adding a site.** The site appears at once, Running while Poise reads the repository. It then becomes Ready, or Needs you with Describe.
- **Describing a site.**
  - The publish.yaml box opens under its site, with a starting description.
  - It is saved only when it reads. An error names the key and stays on that site.
- **Removing a site.** Sure?, then Undo.
- **Google Docs.** The same Google accounts as Accounts, beside the sites: each Connected or Needs sign-in, with Reconnect; Disconnect uses Sure?, then Undo. What happens to Google's edits and comments is said here, with a link to where it is done, in Editor.

## Navigation (N1–N6), removed

**Today**
- N1 Two areas, Top bar and Menu, each an ordered list of views.
- N2 All views: Current, Swarm, Chat, Archive, Behaviors, Snippets, Editor, Analytics and Logging. Each can be dragged into either area, or into both.
- N3 Views are arranged by dragging, or from the keyboard.
- N4 Remove a view from an area.
- N5 Restore defaults: everything in the top bar except Analytics and Logging, which go in the menu.
- N6 "Changes apply instantly", with a status line.

**Redesigned:** removed in round 11. The top bar is Overview, Board, Chat, Editor, Observe and Settings, in a fixed order that needs no arranging, and every view has one place.
- Analytics is part of Overview. Swarm, Archive and Logging are in Observe. Behaviors and Snippets are sections of Settings.

## Behaviors (B1–B9)

**Today**, a room of its own:
- B1 Six behaviors, each with an on/off toggle: Review New Pull Requests, Approve Pull Requests, Resolve Unblocking Conversations, Rerun Grey CI, Merge Pull Requests and Review New Issues.
- B2 Status: chips for problems.
- B3 Owner: the account it acts as.
- B4 Setting, which depends on the behavior:
  - the priority ceiling, for Review New Pull Requests;
  - repositories to skip, for the pull-request behaviors;
  - repositories and trusted authors, for Review New Issues.
- B5 Reviewers: how many of the review place's models review each new item.
- B6 Memory: a note added to the behavior's prompt, edited in a side panel.
- B7 Last triggered.
- B8 Total runs, duration and success for a chosen period.
- B9 When the state cannot be read, the toggles are disabled rather than shown as off.

Since then on `main`: Approve Pull Requests has a Review cap, 2 to 10 rounds (#626). The behavior chain carries an issue to its merge through issue review, implementation, PR review, repair and merge (#728). One action switches behaviors to v2, the chain, and Implement Issues and Repair Pull Requests join the table (#736, #737). A behavior can be paused for 15 minutes.

**Redesigned**
- **Groups.** Engine; Pull requests (five behaviors); Issues (one); and Issue to merge.
- **Engine.** Which engine owns new work, v1 or v2. Switch to v2 runs its setup check first, then lets v1's pull requests finish, and can be cancelled while it drains. Unsupported and unavailable say why.
- **Each row.**
  - On the left: what the behavior does and its last run, in the state words, with See it in Observe.
  - On the right: its switch, and its own settings as small labelled fields: Priority, Reviewers, Skips or Repositories and authors, and Memory. Pause 15 min says when the pause ends.
- **Review cap.** On Approve Pull Requests, marked *legacy only*, as on `main`: the chain repairs until every blocker is gone.
- **Review New Issues under v2.** Its row shows the chain's seed scope, *Label poise* or *All issues*, with Change leading to *Which issues enter*, as `main` does since #822. The repositories and authors apply to legacy work, and return under v1.
- **Issue to merge.** Run the chain; which issues enter, those with a label or every open issue in followed organizations; the label; Implement Issues and Repair Pull Requests; and Capacity, the reserved runs, memory and disk, with the Manager's workers counted apart. Each task is in Observe → Tasks.
- **Skips, and Repositories and authors.** These open a checklist under the row, saved on Done.
- **Memory.** It opens a note under the row, saved on Save.
- **Run counts and success.** These live in Overview.

## Snippets (S1–S7)

**Today**, a room of its own:
- S1 A table of snippets: trigger and text. Each is also a Chat skill.
- S2 Add snippet; edit inline with Save; Delete or Discard.
- S3 Import from an Espanso match file, pasted or chosen.
- S4 ;name expands anywhere through Espanso; /name adds it in Chat.
- S5 Skills saved with /create appear too.
- S6 A hint when Espanso is not installed.
- S7 Try again, when the snippets cannot be read.
- S8 The built-in `/manager` snippet, the Manager's standing instructions (#397, #452).

Since then on `main`: a second built-in, `/worker`, carried by every worker turn, and a slimmer default `/manager` text (#563).

**Redesigned**
- **Each snippet.** One item showing its trigger, both ways to use it (;name and /name) and its first line.
- **Editing.** Choosing a snippet opens its editor under it. Save checks that the trigger is unique.
- **Removing.** Delete uses Sure?, then Undo.
- **Import.** Paste Espanso matches; the row says how many were added.
- **From Editor.** A snippet saved from a selection in Editor arrives here.
- **Built in.** `/manager` and `/worker` come first, marked, with the text `main` ships, word for word (`server/chat/manager-default.ts`, `worker-default.ts`). Their text is edited like any snippet's; they cannot be renamed or deleted.

## Admin (D1–D7)

**Today**
- D1 People and workspaces. Each person shows:
  - an admin badge;
  - the workspace state;
  - how they have access, and their last sign-in;
  - the image;
  - disk use, with a warning over budget;
  - the last error.
- D2 Start, Stop or Restart a workspace; Disable or Enable a person (never yourself).
- D3 Server disk: free of total, with a warning when less than a tenth is free.
- D4 Who may sign in:
  - admins always;
  - members of the allowed organizations;
  - added logins, with who added them and Remove;
  - Allow a GitHub login.
- D5 Destructive changes ask once more.
- D6 A link to Gateway administration, for when your workspace is unavailable.
- D7 A warning when the gateway cannot reach Docker: workspaces cannot start or stop.

**Redesigned**
- **Workspaces.** Each speaks the state words: Running, Waiting while it starts or stops, Idle when stopped, Failed with its error.
- **Actions.** Start, Stop and Restart stay together on each person's row, as on `main` since #702. Each shows its progress there.
- **Disable.** Uses Sure?.
- **Who may sign in.** One list: logins from the server configuration are marked and cannot be removed, and the others say who added them.

## Extensions (X1–X28), new in round 13

**Today**, a view of its own in the burger menu (#347, #791):
- X1–X5 **Installed.** A grid of servers by workspace: the twelve most recently used workspaces, Poise · local, and any with a switch of its own. A switch per cell, and New workspaces for workspaces chats have not used yet. Each server's status: connected with its tools, needs a sign-in, or failed and why.
- X6–X10 **Details**, in a side panel: Overview (connection, each value set or missing, the agents it reaches, where it is on, its directory entry), Tools from the last check, and Activity, the last 100 events.
- X11–X15 Check now. Sign in, Sign in again and Sign out for OAuth. Edit, which replaces a secret only when a new value is typed. Remove, confirmed, which erases its secrets and Activity.
- X16–X20 **The directory.** Poise's copy of the MCP Registry, read in the background, with Refresh and search. Built-in servers come first, Remote Desktop Commander among them. Add asks only for what the entry declares, and an option Poise cannot run says why.
- X21–X26 **A custom server.** A remote URL with its transport and authentication, a local command with its arguments and environment, or a pasted `mcpServers` block. What chats receive shows what each agent gets. Use it in picks its workspaces. Agents name its tools `mcp__name__tool`.
- X27 A chat that does not get a server says so in its conversation, once per change, and why.
- X28 Secrets are write-only and scrubbed from logs, transcripts and Activity.

**Redesigned**
- **The grid.** Each switch saves itself and says it applies from each chat's next turn. Status is in the state words: Needs you to sign in, Failed with the reason.
- **Details**, under the row instead of a side panel, so the grid stays in view: Overview, Tools and Activity. Reaches marks an agent that cannot take the server *not sent*, with the reason. A secret reads only Saved or Missing.
- **Edit** opens the server in the custom form, which says what it edits. A directory server keeps how it runs; its name for agents never changes.
- **Remove.** × then Sure?, as everywhere; the row then says what went with it.
- **The directory.** Built in first, then well-known servers, then everything. Add opens a short setup under the entry when it has something to ask; an entry Poise cannot run is marked *Custom only*. A failed read keeps the last complete copy and says when Poise tries again.
- **A server of your own.** Remote URL, Local command or Paste JSON. SSE says before you add it that Codex and Muse take Streamable HTTP only. Each value can be marked Secret. Paste JSON reads the block first and lists what it found, then imports. What chats receive updates as you type, for Claude Code, Codex, Muse and Grok Build, with secrets as ‹secret›.
- **In Chat.** #475 shows the line: *Extensions: Sentry is not available in this chat: Muse takes local commands and Streamable HTTP servers, not SSE.*

## Style (T1–T17)

**Today**, a Typography panel from the burger menu:
- T1 The panel slides in over the view.
- T2 Font style: six coordinated sets of body and heading faces (Engineer, Editor, Writer, Minimalist, Companion, Auteur).
- T3 Base font size, 12–20 px.
- T4 Line height, 1.2–2.0.
- T5–T9 Editor:
  - T5 Paragraph spacing;
  - T6 Heading spacing;
  - T7 Heading line height;
  - T8 Heading size;
  - T9 Heading weight.
- T10–T12 Tables: T10 Content width, T11 Row text size, T12 Row density.
- T13–T15 Comments, in the card previews: T13 lines, T14 size, T15 weight.
- T16 Reset to defaults.
- T17 Kept in this browser. When the design system's defaults change, old choices are cleared once.

The mock's Style panel (round 4) added:
- presets;
- corners, route lines and status tints;
- motion;
- the meaning colours and the neutrals;
- Copy as CSS.

**Redesigned:** a page in Settings, with the panel kept for styling while you look at a view. Both are the same settings, so a change in one shows in the other.
- **Start from.** Calm, Compact, Comfortable or Large type. A preset changes its rows, each with Undo, and the row says which preset is in use.
- **Type.** Typeface (T2), Base size (T3) and Line height (T4), all in the token layer.
- **Space and shape.**
  - Density takes in Row density (T12).
  - Corners and Route lines.
  - Motion, a switch.
- **Writing.** Editor's page:
  - Reading width replaces Content width (T10). The other views fill the window.
  - Heading size takes in heading spacing and heading line height (T6–T8). Spacing scales with size, so headings stay one family.
  - Paragraph spacing (T5), in fractions of a line.
- **Colour.**
  - Status tints.
  - The meaning colours, one per state word (Needs you, Running, Waiting, Blocked, Done, Failed) plus Information and Poise acting on its own. Idle has no colour; it is hollow.
  - The eight neutrals, folded.
- **Keep and share.** Copy as CSS, the style guide, and Reset everything with Sure? and Undo.
- **Merged or removed.**
  - Row text size (T11) follows Base size, because every size derives from it.
  - Heading weight (T9) and the comment previews (T13–T15) are removed. Headings use the display face's own weight, and Current's cards show where an item stands instead of a comment preview.
- **Scope.** The section is marked This browser, once, at the top.

## Manager (new, brief 6)

There is nothing to inventory in the live app. The Manager's pane in the mock holds the controls beside its chat.

Since 24 October `main` stores the three controls, the scope and the pause, and carries them to every Manager turn as its policy, with the words of the positions chosen (`server/chat/manager-policy.ts`). Their enforcement is not delivered yet. Since 31 October the Manager wakes every 60, 30, 15, 10 or 5 minutes (#783). Since #782 Poise counts the Manager's open worker chats against Rhythm.

**The page**
- **In effect.** One sentence that reads the three controls together, with the scope.
- **Controls.**
  - Rhythm: 1–10 slots, with − and +, and capsules showing the limit. Each of the Manager's workers holds a slot from the moment it takes a task until you close its chat, between turns and after its task ends, as `main` counts them. A change applies from the Manager's next turn, which fills a free slot.
  - Stability ↔ Expansion: five stops on how the Manager takes a Poise release, each with `main`'s words, from *Keep this Poise on the version it has. Track releases; never ask to install.* to *Install releases automatically.*
  - Autonomy: five stops, each with what the Manager decides and what it brings to you, in `main`'s words.
  - Each saves on its row, says when it applies, and offers Undo. The defaults are the live ones: Rhythm 5, Balanced and Balanced. This workspace runs Rhythm 7, so the row says Changed · Reset to 5.
- **Scope.** Every followed repository by default, as on `main`, or the ones you choose from a checklist; with none, the Manager binds nothing.
- **Standing instructions.** The built-in `/manager` snippet, as on main since #397 and #452, with the slim text of 24 October: what the Manager always or never does, in your words, carried by every Manager turn. This row shows it and opens it in Snippets, where it is edited like any snippet and cannot be renamed or deleted.
- **Wake-ups.** Wake the Manager every 60, 30, 15, 10 or 5 minutes, the same control as in the Manager's header, with the day's cost and the next wake-up. There is no off: a hold stops them.
- **Pause new work.** `main`'s paused control, a switch: new work waits until you resume, and work in flight carries on. It is not Hold, which is the Manager chat's own: its timers skip, and the turns it would start in other chats wait.
- **In the Manager.** The work table and the Switchboard are observations of work in progress, not settings. They sit in the Manager place, linked from here.

## Open questions

1. **Running at once.** Settled by `main`: chat turns and behavior runs share it (#576), workers' turns run in the background lane, and the Switchboard's turn runs outside it. Rhythm is separate: it counts the Manager's workers, not their turns.
2. **Time zone.** Should it be kept per person (Everywhere) or per browser?
3. **Notifications.** Settled by `main`: one switch, kept by the server. Off stops notices and the check of pull requests at once; Behaviors' diagnostics stay (`docs/Notifications.md`). Answer here says so, and `?notifications=off` shows it.
4. **Navigation.** Settled in round 11: removed, with Board, Chat and Editor in that order.
5. **Behaviors.** Settled in round 11: run counts and success live in Overview, beside the rest of the day's numbers, each with its switch.
6. **Stop following**, **Undo after removing** and **sign-in terminals under their row** are proposals, not in the live app.
