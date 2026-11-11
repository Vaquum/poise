# Editor, against the brief

Sources:
- `src/views/editor-view.ts`, `editor-publish.ts`, `editor-reviews.ts` and `google-documents.ts` in ~/dev/poise (21 Oct).
- The live Editor (22 Oct), with HELIOS open: 1,918 words, grouped under Yesterday, This week and This month.
- Round 13: `main` at `e7b8fea` (1 Nov), for Import (#785), the undo cap (#627) and the autosave status (#579).
- 4 Nov: `main` at `741d2c4`, for no sites to publish to (`?tab=publish&sites=none`), a save conflict (`?save=conflict`), publishing refused while unsaved, and a review's suggested reply.

## What Editor does today (E1–E23)

**Header**
- E1 Writer mode: the chrome goes away and only the page remains.
- E2 New document (⌘N).
- E3 Copy the document.
- E4 Chat about this document, in a pane beside it.
- E5 Chat about this document, as a chat in Chat.
- E6 Publish, in a panel.
- E7 Delete the document.
- E8 Document picker: the title with ▾, and a menu grouped by Today, Yesterday, This week, This month and Earlier, each document with its age.
- E9 Word count and save state.

**Writing**
- E10 Markdown drawn as you type: headings, lists (renumbered), quotes, rules, code, tables (Tab, Enter and arrows move between cells), bold, links. Markers stay in the text and are hidden.
- E11 ⌘B bold. ⌘Z / ⌘⇧Z / ⌘Y undo and redo; history survives a reload.
- E12 Saves as you type and with ⌘S, with versions and conflict detection.
- E13 Empty-document state.

**On a selection**
- E14 Comment: underlined in the text, with a panel to write in.
- E15 Ask an agent about the passage in the comment panel. Replies can carry suggested edits, shown in the text on hover and applied with a check for conflicts.
- E16 Create an issue from the selection.
- E17 Save the selection as a snippet.
- E18 Comments re-anchor when the text around them changes.

**Publishing and feedback**
- E19 Publish panel:
  - sites from Settings → Publishing;
  - title, description and date once, then each site's slug and fields;
  - Publish or Update opens a pull request per site, shown with its state;
  - "Replace with mine" on conflicts.
- E20 Google Docs:
  - publish with a chosen account;
  - shows whether the published version matches, the draft changed, or Google's copy changed;
  - Google comments with replies;
  - review Google's changes: import them, publish yours, or keep your draft.
- E21 Article reviews: review comments from each site's pull request.
  - Each shows Resolved, Outdated, Unresolved or Document feedback, and when it was last checked.
  - You can reply on GitHub, resolve the thread, or ask an agent privately.

**Safety**
- E22 Saves are flushed before leaving a document; there is a reload guard.
- E23 Errors and confirmations go to the notification rail.

Since then on `main`:
- Import, beside New, opens a Markdown or text file as a new document (#785).
- Undo keeps 1 MiB per document, with a one-time note when older steps are dropped (#627).
- The autosave status left the header; failures go to notices (#579).
- Passage and review threads open inline, on the page under their text (#443).

## How the brief lands

| Brief | In Editor |
|---|---|
| 1 · One vocabulary | A document has a save state; a publication has one of the seven states. Checks running on a site's pull request is Waiting; ready to merge is Needs you; merged is Done; a failed publish is Failed; a site that changed under you is Blocked. Review comments that wait for you are Needs you; resolved ones are Done. Comment, suggested edit, review comment and publication each have one name. |
| 2 · Reference | Every control and display carries a key; `refdefs-editor.js` holds Editor's entries. |
| 3 · Overview | A status line under the page reads the document at a glance: save state, words, comments, reviews and where it is published. Each part opens its place in the side pane. |
| 4 · By purpose | The same top bar as every view: Overview, Board, Chat, Editor, Observe, Settings. The header groups the document's own actions (Document, Write, Ask, Share), with labels. Comments, Reviews, Publish and Chat live in one side pane, on demand. |
| 5 · Defaults and ordering | Documents stay grouped by recency, the current one marked. Comments follow the text's order. New review comments never move the text or the pane while you write: they are counted and shown when you open Reviews. |
| 6 · Manager | Not a Manager surface. Issues created from a selection appear on Board, where the Manager can take them. |
| 7 · Review | Editor joins the element review, with each of E1–E23 accounted for. |
| 8 · Feedback and continuity | Saving shows Saving…, then Saved with the time. Asking an agent, applying a suggested edit, creating an issue and publishing show accepted, executing and completed where you acted. Delete uses "Delete → Sure?". Chat about the document returns you to the same place. Writer mode keeps a visible way out. |

## Round 13: what Editor adds

- **Import**, beside New. It takes a Markdown or text file up to 5 MiB that reads as UTF-8, opens it as a new document, saved as it opens, and only its line endings change. A refusal says why: *Not imported: … is 6.2 MiB. Choose a file smaller than 5 MiB.*, or that it could not be read as text.
- **Undo** keeps the last 1 MiB of changes in each document; an import larger than that says so once.
- **Threads on the page.** A comment or review thread opens under its passage, on the page. Every action stays in the side pane, and Escape closes the thread.
- **The status line** stays under the page at one height, so a save never moves the text.
