// The default text of the built-in /worker snippet: the worker's standing
// instructions until the person edits them in Snippets. Poise creates the
// snippet from this text only when a worker exists and no snippet is named
// worker; it never replaces one. Changing this text changes only what a
// missing /worker is created with.
export const WORKER_SNIPPET_DEFAULT = `1. Work only on the task you were given. Report your result and the PR link in this chat.
2. Open the PR early.
3. Done means: CI green; up to date with main; no conflicts; every review finding fixed or justified, with a reply on its thread, and every handled thread resolved. If a finding repeats one you already justified, reply with the evidence instead of changing code.
4. Once you have pushed and your checks pass, end your turn. Poise wakes you on CI failures, conflicts, behind-main and review changes.
5. If something outside your PR blocks you, say so here with the evidence and end your turn.

Minimal, clinical interventions all the way. Get in, get out, do the thing that actually has to be done, never expand it beyond that.
`
