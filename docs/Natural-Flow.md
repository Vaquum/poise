# Natural flow

Poise uses the Tactile spring selected in Eight-Characters: stiffness **180**,
damping **20**, mass **1**. `gateway/src/motion-model.ts` generates the CSS
`linear()` curve and settling duration from the same integrator used by
`src/motion.ts`. Control feedback is **100ms ease-out**. Hover intent,
confirmation windows, acknowledgement lifetimes, deadlines and polling
intervals belong to their operations.

## Ownership and geometry

Each semantic actor has named channels. Retargeting retains position and
velocity; an inactive channel restarts from presented geometry. Completion
belongs to the latest request. Layout offsets compose through individual
`translate`, preserving native full-bleed transforms. Fixed headers stay
outside transformed entrance owners. Chat and Writer view entry only fade;
their console and fixed selection geometry remain native. Ordinary entry
travels 20px; local information uses 8px.
Each motion actor owns its offsets; children never inherit an ancestor's
entry or layout offset into their own translation.

Keyed reconciliation retains controls, drafts, selections, native details and
active motion styles. View entrances run once per mounted view; returning to
cached content is immediate.
Structural layout measures every destination before writing animation styles;
frame visibility and target reads precede animation writes. View departure
batches presentation reads before settling channels. Only actors whose
old or new bounds intersect the viewport receive layout/entry motion. Clipped
departures use the captured geometry without reading styles after each removal.
Spatial offsets are non-inherited CSS properties: an actor moves its subtree
without recalculating every descendant's styles on each animation frame.
Swarm pages bounded history for search, grouping and counts, mounting at most
200 run rows per Previous/Next page, including expanded identical runs. Detail
rows belong only to mounted runs. Each history read costs its own page plus an
exact total that counts without loading; running statuses refresh from their
own indexed read. Page changes replace rows directly and load older pages on
demand; refresh retains keyed controls and follows a focused run across page
boundaries. Search and organization changes reset to the first page. Deep links
load their target's page. Leaving clears row DOM; late reads update only data.
Cached return restores the page and disclosure state without entry motion. No
offscreen rows are prepared. Refreshes recompute current values and skip
unchanged row markup.
Structural lists reveal new actors once and retire
departed visuals inertly. Changed text and elapsed time remain immediate.
Batch departures use geometry captured before the layout mutation; retiring
descendants retain their presented translations and transforms. Retiring
visuals retain intermediate ancestors' opacity; fully faded actors leave
without creating an invisible visual. Ancestor overflow bounds are captured
before mutation and stay fixed through retirement; fully clipped actors leave
without a visual.
Intrinsic disclosures animate height, padding and opacity and return to auto
sizing. Fixed measurement clones are removed synchronously and never shrink
the live document's native scroll bounds.

Logical close, focus restoration, input submission, saves and cancellation
occur immediately. Menu exit retains its departing words. Sliding panels
declare their anchor direction. Sidebar dragging takes over from presented
width. The console channel writes position and composer width together,
without trailing CSS interpolation.
Setup retirement captures the dialog's presented transform before releasing
modality, including an unfinished entrance.
Repository pickers fit inside the viewport and refit after asynchronous
content changes, keeping their confirmation controls reachable.

## Lifecycle and stationary behavior

Reduced motion removes spatial animation and feedback delays. Preference
changes, resizing and printing settle geometry and release temporary styles.
Detachment settles non-scroll channels. Hidden documents and view departure
cancel scrolling at the presented reading position. Visible guided scrolling
follows bounded live targets and yields to wheel, pointer, touch or keyboard
input. Nearest navigation to a tall actor settles once it covers the viewport,
without alternating between its edges. Chat retains its existing near-bottom reading policy.

Typing, IME composition, streaming, terminal output, native dragging, Writer
source offsets/table editing/selection marks and account operations remain
direct. Theme and typography apply directly. Keyboard option selection
scrolls its own list immediately. Native dialogs retain native focus,
cancellation and modality; supported browsers add CSS discrete visual
transitions. Native file choosers, confirmations, OAuth navigation and the
Poise Link desktop window remain stationary. Busy/error/selected states stay
meaningful without decorative repeating animation.

## Audited interaction coverage

These identifiers cover the 102 interaction families audited on 13 October
2026. They identify behaviors, not commits or independent slices.

| Families | Owner and treatment |
| --- | --- |
| I001–I009, I101–I102 | View lifecycle and anchored controls; retained account/release banner controls; native configuration and reading policies. |
| I010–I019 | Menu visibility/size channels and retained exits; settings/analytics collections; direct typography; delayed tooltip intent followed by restrained entry. |
| I020–I041 | Chat sidebar/console/Memories channels; retained session/attachment/queue actors; intrinsic history/model/native details; keyed transcript disclosures; direct drafts/streaming/requests; native file preview. |
| I042–I049 | Current retained cards across filters/lane changes and active edit drafts; shared live layout; intrinsic composers; native drag; inert departures. |
| I050–I053 | Archive arrivals/reorders and retained cells/actions; latest-request filter/loading semantics. |
| I054–I059 | Swarm retained grouped/detail/refusal actors; structural layout/native reasoning disclosure; bounded navigation; immediate elapsed/process text. |
| I060–I065 | Behaviors retained table/repository controls; anchored picker/memory channels; native diagnostics; authoritative saves and confirmations. |
| I066–I069 | Snippets retained rows, editor arrival/retirement and intrinsic import; immediate conflict/draft checks and Link standing. |
| I070–I078 | Writer document/annotation/selection composers and retained response controls; bounded edit navigation; direct text/tables/marks/Writer-mode geometry. |
| I079–I081 | Context Chat exits toward its left anchor; response controls persist; composer/resize input stays native. |
| I082–I085 | JEV keyed session/question/results actors, structural builder layout and native distributions/details; immediate input/evaluation/conflict ownership. |
| I086–I090 | Setup step entry/intrinsic content sizing and inert modal retirement; native device details; immediate account/terminal protocols; one finish cue. |
| I091–I095 | Retained service account/device/admin actors; menu geometry follows terminal mounting; immediate output/admin writes; shared update/sign-in presentation tokens. |
| I096–I098 | Gateway generated spring and feedback tokens; auto-refresh starting/updating pages stay stationary between refreshes. |
| I099–I100 | Poise Link's native window/status replacement remains stationary; protocols are unchanged. |

## Proof

`tests/motion-model.test.ts` checks reversal momentum, settling, generated CSS
and invalid numeric input. `tests/e2e/motion.spec.ts` exercises the reproduced
application defects in Chromium and WebKit, including narrow layouts, themes,
direct pointer input, reduced motion, resize and print.
`tests/e2e/motion-runtime.spec.ts` bundles the actual runtime under the existing
CSP and checks completion ownership, focused patches, background scroll
cancellation and retirement opacity. Existing browser suites retain functional
safeguards for drafts, native dialogs, submits, selection, authentication,
service operations and asynchronous loading. The settlement helper waits for
both runtime channels and native animations.

The Swarm browser tests retain 6,280 distinct calls while checking bounded page
DOM, bounded history reads with complete filtering, deep links,
disclosure/action state, refresh focus, and empty hidden DOM. Chromium
performance counters retain the long-task and navigation budgets, including
cold page transitions; other motion semantics remain covered by the runtime and
interaction suites.
