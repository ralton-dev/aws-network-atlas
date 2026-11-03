# Account picker — the overview is the selected accounts, not the estate

Written 2026-11-03 against `545df70` (clean tree). Inherits the standing rules and
definition of done of `TERRAFORM-IMPORT-BLOCKS.md` and `TERRAFORM-TOOLS-EXTRACTION.md`;
decision numbering continues from 32. Read `ORCHESTRATION.md` first — it names the gate,
the frozen files and the committed build artifact this plan has to rebuild.

## The defect

Opening the viewer, or returning to the overview, builds and lays out **every scanned
account** in the browser before anything is drawn. Nothing lets the reader choose.

| surface | what it does | figure |
| --- | --- | --- |
| `packages/viewer/src/components/App.tsx`, the `useEffect` on `[index, route]` (hint: grep `buildOverview(index)`) | builds the whole estate, then `layoutGraph` on all of it, on first load and on every return to `#/` | 19 synthetic accounts × 17 regions: 865 nodes, **0.48 s first render, 0.20 s repeat**, headless Chromium, measured 2026-11-03 |
| `packages/viewer/src/model/overview.ts`, `ensureGhostAccount` (hint: grep the name) | the only way an account can be *absent* from the overview is to be unscanned; the ghost it draws is labelled `Account <id>` / `not scanned` | — |
| `packages/viewer/src/model/overview.ts`, `buildOverview` | **21** loops over `index.snapshot.accounts` (grep it); there is no account filter anywhere in the viewer | — |
| Ben's work estate, GitLab Pages, reported 2026-11-02 | 19 hub-and-spoke accounts, ~48k indexed resources: first overview render "incredibly slow", and the reader cannot tell which account box is which | reported, not reproduced — see `atlas-render-speed-investigation` in memory |

The measured figures are small because the synthetic estate is tidy. The point of the
table is the second and third rows: the overview has one shape, *everything*, and the
reader has no instrument to change it. On a large estate that is both the slowness and
the "which box is which" problem.

The account label itself is **not** part of the defect. `data.ts` already labels an
account `alias (id)` and the scanner already takes a per-profile display `name` from
`atlas.config.json` (`packages/scanner/src/scan.ts`, grep `account.name ??`). The picker
makes the label matter; it does not have to invent one.

## The reframing

**The unit of the overview is the selected account set, not the estate.** The viewer
opens with no accounts selected, the Inventory panel is where accounts are switched on,
and the graph the browser builds and lays out is only the accounts that are on. The full
network overview is still one click away ("show all"); it stops being the default.

Everything else follows: the filter lives where the graph is built in the browser (not in
the bundle, which still ships every account); links to accounts that are off are drawn as
the existing dashed ghost box so the reader can see the link and add the account; a
single-account estate selects itself and must render exactly as it does today.

## Decisions — taken, do not relitigate

33. **The filter is applied to the in-browser graph build, never to the bundle.**
    `npm run bundle` and `site/data/*.js` are untouched and still carry every account.
    The point is that ELK and React Flow only ever see the selected accounts. Hiding
    boxes after a full build (the Layers-panel pattern) is explicitly *not* this plan: it
    gives the picker and none of the speed.
34. **Selection is a derived index, not 21 edited loops.** `withAccounts(index, ids)`
    returns an `AtlasIndex` whose `snapshot.accounts` is filtered and whose `all`,
    `byKey`, `accountLabel`, `annotationFor`, `terraformFor` and `findRegion` are the
    full-estate ones, unchanged. `buildOverview` takes that and needs no loop rewritten.
    `packages/viewer/src/data.ts` stays frozen (ORCHESTRATION.md): the helper lives in a
    new `packages/viewer/src/model/selection.ts`.
35. **Default selection: all accounts when the estate has exactly one, otherwise
    none.** A single-account estate must open exactly as it does today, node for node.
    Everyone else opens on an empty canvas with the Inventory panel open and the message
    *"Add at least one account from Inventory to get started."* The 3-account demo
    fixture therefore opens empty; the README changes to say so (WP-5). Ben chose this
    on 2026-11-03; do not raise the threshold.
36. **Links to unselected accounts are drawn as ghost boxes, not hidden.** The existing
    `ensureGhostAccount` path already fires for them once the index is filtered (trust,
    TGW attachment, peering and RAM edges all fall through `b.accounts.has(...)`). The
    only change is what the ghost says: a scanned-but-unselected account is labelled with
    `index.accountLabel(id)` and the subtitle *"not shown · click to add"*, and carries
    `data.addAccountId`; a genuinely unscanned account keeps `Account <id>` / `not
    scanned`. Clicking a ghost that carries `addAccountId` adds that account.
37. **The selection travels in the overview URL and is remembered locally.** Overview
    hash is `#/?accounts=<id>,<id>` (sorted, comma-separated, 12-digit ids; empty set is
    plain `#/`). On load the URL wins over `localStorage` (`atlas:accounts`), which wins
    over the default. VPC and focus routes do not carry it; they are single-VPC and
    single-resource views and are unaffected by this plan. Returning to the overview
    re-applies the remembered selection.
38. **An empty selection runs no build and no ELK.** The overview effect short-circuits
    to an empty graph and the canvas renders the empty-state message immediately. First
    paint on a large estate is therefore the data parse and the search index only.
39. **The overview's view key includes the selection**, so saved positions and hidden
    state are per selection (`#/?accounts=…`). A different selection is a different
    layout; positions dragged for one must not be applied to another.
40. **The derived index is memoised per selection in `App`** (`useMemo` on
    `[index, accounts]`). `focus.ts` caches relations in a `WeakMap` keyed on the index
    object; the VPC and focus builders keep receiving the *full* index, so that cache is
    unaffected, but the memo is still required so the overview does not rebuild a new
    index object on every render.
41. **The Inventory panel is the one place accounts are switched on and off.** An eye
    toggle on each account's summary line, plus *show all* / *show none* at the top.
    No new toolbar button, no new panel; the Layers panel is not touched.
42. **This plan does not touch VPC-detail layout.** The security-group density finding
    (800 SGs in one VPC = 17 s, 91% ELK) is a separate plan. Nothing here may be
    stretched to "while we're in there".

## Standing rules

Carried forward unchanged from the two earlier plans and `ORCHESTRATION.md`:

- Commit straight to `main`, no trailers; agents commit and do not push; the
  orchestrator runs the gate (`npm install && npm run typecheck && npm test`) before
  every push. The gate was green at `545df70` on 2026-11-03: **24 tests, 0 fail**, typecheck
  clean across all three workspaces. Re-run it before wave 1 and compare the count.
- `packages/schema/**` and `packages/viewer/src/data.ts` are frozen. Not one line.
- `tsconfig.base.json` sets `strict` and `noUncheckedIndexedAccess` — write array and
  record access accordingly from the first line.
- Every package that supersedes a symbol deletes it in the same commit and reports per
  symbol: deleted, or kept with the name of the caller.
- `site/index.html` is a committed build artifact. The **last** package rebuilds it and
  proves the rebuild took by grepping the bundle for a string that only exists after this
  plan (`click to add`), with a control grep for a tree-shaken string.
- `file:line` references in this document are hints. Grep for the symbol, confirm it says
  what the plan claims, and report drift rather than working around it.
- Emit output between steps; commit before the long final verification pass.

## The red pin

`packages/viewer/test/selection.test.ts` (WP-1) builds a three-account snapshot in
miniature — a hub (`222…`) that owns a TGW, two spokes (`111…`, `333…`) attached to it,
and a role in `111…` trusted by `333…` — with the same `buildIndex` shape the viewer
uses (set `window.__ATLAS_DATA__` on `globalThis` before importing `data.ts`, exactly as
the app does), and asserts:

1. `buildOverview(withAccounts(index, {111}))` draws exactly one non-ghost account
   container, `acct:111…`, and ghost containers for `222…` and `333…` that carry
   `data.addAccountId` and are labelled by `index.accountLabel`.
2. `buildOverview(withAccounts(index, allThree))` deep-equals `buildOverview(index)`
   on nodes and edges — the single-account and show-all cases must not move at all.
3. `defaultSelection(index)` is the full set for a one-account snapshot and empty for
   three.
4. `parseAccountsParam('#/?accounts=333333333333,111111111111')` returns the sorted set
   and `formatAccountsParam` round-trips it; `#/` and `#/vpc/x` parse to `undefined`.

Against `545df70` it fails at compile time (no `selection.ts`) — that is red enough.
WP-1 lands assertions 2–4 green and assertion 1 as `test(..., { todo: true })` with the
observed failure in its comment (the ghost is labelled `Account 111111111111` and has no
`addAccountId`); **WP-2 flips it to a plain `test` as part of its acceptance.**

## WP-1 · The selection model and the pin

**Goal:** a pure, tested module that turns an account set into the index the overview
builds from, with the URL and default rules of decisions 34, 35 and 37.

- New `packages/viewer/src/model/selection.ts` exporting, with doc comments aimed at
  WP-2 and WP-3:
  - `withAccounts(index: AtlasIndex, ids: ReadonlySet<string>): AtlasIndex` — spreads the
    index, replaces `snapshot` with a copy whose `accounts` is filtered **in the original
    order**. Every other member is the original's. Returns the original object unchanged
    when every account is selected (keeps `WeakMap`-keyed caches stable for show-all).
  - `omittedAccounts(index: AtlasIndex): ReadonlySet<string>` — the scanned account ids a
    derived index left out; empty for an index that is not derived. Implement with a
    module-level `WeakMap<AtlasIndex, ReadonlySet<string>>` populated by `withAccounts`;
    this is how WP-2 tells "scanned but off" from "never scanned" without touching the
    frozen `AtlasIndex` interface.
  - `defaultSelection(index): Set<string>` per decision 35.
  - `parseAccountsParam(hash: string): Set<string> | undefined` and
    `formatAccountsParam(ids: ReadonlySet<string>): string` per decision 37. Parsing
    tolerates whitespace and drops ids that are not 12 digits; formatting sorts.
- The red pin test as specified above. Mirror the header comment and the
  miniature-fixture approach of `packages/viewer/test/tf-import.test.ts` (which is the
  precedent for "plain TypeScript, no DOM, no React"). `node --test` via `tsx`, no new
  dependency.

**Acceptance:** `npm test` discovers one more file than before (record both counts);
assertions 2–4 pass; assertion 1 is `todo` with the observed current values in the
comment. `npm run typecheck` green.

Owns: `packages/viewer/src/model/selection.ts`, `packages/viewer/test/selection.test.ts`.
Size **S**. Depends: none.

## WP-2 · Ghosts that know they are only switched off

**Goal:** a link to an unselected account shows the account's real name and can be
clicked to add it (decision 36).

- `packages/viewer/src/model/graph-types.ts`: add `addAccountId?: string` to
  `AtlasNodeData` with a doc comment: *"Set on a ghost account container that stands
  for a scanned account the current selection leaves out; clicking it adds the account.
  Absent on genuinely unscanned accounts."*
- `packages/viewer/src/model/overview.ts`: `ensureGhostAccount` needs the index. Add
  `index: AtlasIndex` to the `Builder` interface (set once in `buildOverview`), and
  change the helper to label a ghost `index.accountLabel(accountId)` with subtitle
  `not shown · click to add` and `addAccountId` when `omittedAccounts(index).has(id)`,
  else exactly what it emits today. It is called from eight sites (grep); none of them
  need to change.
- Verify, and record in the hand-back, what happens to the hub's TGW when only a
  spoke is selected: the "TGWs: prefer placing under the owner account's region" loop
  (grep that comment) runs two passes, `owner` then `other`; with the owner filtered out
  the TGW should land via the `other` pass or as a ghost TGW. The fixture's `core-tgw`
  (`tgw-0a1b2c3d4e5f00001`, owned by `acme-shared`) is the case to check with
  `npm run dev` and the URL `#/?accounts=111111111111`.
- Flip red-pin assertion 1 from `todo` to a plain test.

**Acceptance:** assertion 1 passes; `buildOverview(index)` on the unfiltered fixture is
byte-identical to before (assertion 2 still green); the dev server at
`#/?accounts=111111111111` shows prod, a ghost `acme-shared (222222222222)` box with the
TGW edge, a ghost `acme-dev (333333333333)` box from the peering, and the pre-existing
unscanned `legacy` ghost still reading `not scanned`.

Owns: `packages/viewer/src/model/overview.ts`, `packages/viewer/src/model/graph-types.ts`,
and the flip of assertion 1 in `packages/viewer/test/selection.test.ts` (WP-1 is done
before this runs).
Size **S**. Depends: WP-1.

## WP-3 · The picker wired through App: route, state, empty canvas, ghost click

**Goal:** the viewer opens per decision 35, the selection lives in the URL and
`localStorage` per decision 37, an empty selection draws nothing per decision 38, and
the Inventory panel's eye toggles (WP-4) drive it.

- `packages/viewer/src/model/view-state.ts`: `loadAccountSelection(): Set<string> |
  undefined` and `saveAccountSelection(ids)` under key `atlas:accounts`, following the
  try/catch, session-only-on-failure pattern of `loadHiddenState`. Store a sorted array.
- `packages/viewer/src/components/App.tsx`:
  - `accounts` state, initialised `parseAccountsParam(hash) ?? loadAccountSelection() ??
    defaultSelection(index)`; every mutation goes through one `applyAccounts(next)`
    that saves and, when on the overview, rewrites the hash with
    `formatAccountsParam`. Keep the existing dedupe-by-value guard so the hashchange
    echo does not rebuild.
  - `routeHash({view:'overview'})` becomes `'#/'` + (`?accounts=…` when non-empty).
    `parseHash` keeps treating anything that is not `#/vpc/` or `#/focus/` as the
    overview and reads the param from it. The `FlowView` `key` and `viewKey` use the
    new overview hash (decision 39).
  - `const shown = useMemo(() => withAccounts(index, accounts), [index, accounts])`
    (decision 40). The overview branch of the build effect calls
    `buildOverview(shown)`; the VPC and focus branches keep `index`.
  - Decision 38: when `route.view === 'overview' && accounts.size === 0`, set an empty
    graph, `loading` false, and do not call `layoutGraph`. The canvas then renders
    `<div className="canvas-empty">` with the message and an *Open inventory* button
    (class names come from WP-4's stylesheet; use `canvas-empty`, `canvas-empty-title`,
    `canvas-empty-action`).
  - `showInventory` initial value is `accounts.size === 0`.
  - `onNodeClick`: before the existing `refId` lookup, if `node.data.addAccountId` is set
    and `index.snapshot.accounts.some(a => a.accountId === it)`, call
    `applyAccounts(new Set(accounts).add(it))` and return.
  - Pass `selectedAccounts`, `onToggleAccount`, `onSelectAllAccounts`,
    `onSelectNoAccounts` to `InventoryPanel` (interface fixed in WP-4; it is optional
    there so this package's typecheck does not depend on wave order).
- Delete nothing: no symbol is superseded here. Say so in the hand-back.

**Acceptance:** with the 3-account fixture, a cold load (clear `localStorage`) opens on
the empty canvas with the Inventory panel open and the message shown; no `Laying out
diagram…` flash. Toggling `acme-prod` on draws it with two ghost boxes and the hash
reads `#/?accounts=111111111111`. Reload keeps it. Clicking the `acme-shared` ghost adds
it and the hash gains the second id. Opening a VPC and pressing *Overview* restores the
selection. A hand-built single-account `data.js` (strip two accounts from the fixture
payload in the dev `site/data/`, then restore it) opens straight onto the diagram with
no empty state. `npm test` and `npm run typecheck` green.

Owns: `packages/viewer/src/components/App.tsx`, `packages/viewer/src/model/view-state.ts`.
Size **M**. Depends: WP-1, WP-2, WP-4.

## WP-4 · The eye in the Inventory panel, and the empty-canvas styles

**Goal:** the Inventory panel can switch accounts on and off (decision 41), and the
stylesheet has what WP-3's empty state needs.

- `packages/viewer/src/components/InventoryPanel.tsx`: extend `InventoryPanelProps`
  with, all optional, doc-commented for WP-3:
  ```ts
  /** Accounts currently drawn in the overview. Absent = no picker is shown. */
  selectedAccounts?: ReadonlySet<string>;
  onToggleAccount?(accountId: string): void;
  onSelectAllAccounts?(): void;
  onSelectNoAccounts?(): void;
  ```
  When present: an eye button on each account `<summary>` line (`aria-pressed`,
  `title` "Show in overview" / "Hide from overview"), which calls
  `event.preventDefault(); event.stopPropagation()` so it does not toggle the
  `<details>`; and a header row under the `h2` with *show all* / *show none* buttons and
  a `n of m shown` count. Accounts are listed in snapshot order, as now.
- `packages/viewer/src/styles.css`: `.inventory-eye`, `.inventory-eye[aria-pressed="true"]`,
  `.inventory-selection` for the header row, and `.canvas-empty`, `.canvas-empty-title`,
  `.canvas-empty-action` for WP-3's empty state, matching the existing `.loading` /
  `.empty-state` tone (muted text, centred, canvas background). `styles.css` is a
  choke-point file; this package is its only owner in this plan.

**Acceptance:** `npm run dev` with the panel open shows an eye per account that toggles
`aria-pressed` without collapsing the account's `<details>`; with the props absent the
panel renders exactly as today. `npm run typecheck` green.

Owns: `packages/viewer/src/components/InventoryPanel.tsx`, `packages/viewer/src/styles.css`.
Size **S**. Depends: none.

## WP-5 · Documentation, timing record, and the committed viewer

**Goal:** the README describes the new opening behaviour, the before/after overview
timing is recorded, and `site/index.html` is rebuilt and proven.

- `README.md`: *Try it without an AWS account* no longer promises the diagram
  immediately — it opens on the Inventory panel; add at least one account, or *show all*.
  *The viewer → Overview* gains a short paragraph on the picker, the `?accounts=` URL,
  and ghost boxes. *Configuration* notes that `name` per profile is what the picker and
  the boxes show. Keep the register of the surrounding text.
- `ORCHESTRATION.md`: one paragraph under *Repo shape* recording that the overview is
  built from `withAccounts(index, …)` and that `selection.ts` owns the account filter,
  so the next orchestrator does not add a 22nd account loop with its own filter.
- `tools/perf/time-views.cjs`: a Playwright harness that opens `site/index.html` from
  `file://`, waits for `.react-flow__node` to appear with `.loading` gone, and prints
  first and repeat timings for `#/` (empty), `#/?accounts=<one>`, `#/?accounts=<all>`
  and one VPC. Playwright is already a viewer devDependency; the browser is not
  installed — the harness must print the `npx playwright install chromium` instruction
  and exit non-zero rather than download anything itself. **The orchestrator runs the
  install and the harness**, and records the figures in this file under *Outcome*.
- Rebuild `site/index.html` with `npm run build` and prove it: grep the bundle for
  `click to add` (new) and confirm `from-state` (tree-shaken out of `tf-import-blocks`)
  is still absent.

**Acceptance:** README and ORCHESTRATION paragraphs present; `site/index.html` rebuilt
with both greps as stated; harness prints the four timings on the fixture; `npm test`
and `npm run typecheck` green.

Owns: `README.md`, `ORCHESTRATION.md`, `tools/perf/time-views.cjs`, `site/index.html`,
this file's *Outcome* section.
Size **S**. Depends: WP-3.

## Waves

| Wave | Packages | Notes |
| --- | --- | --- |
| 1 | WP-1 + WP-2 + WP-4 | WP-2 depends on WP-1's `omittedAccounts` and its test file, so run WP-1 first and WP-2 after it **within the wave**; WP-4 is disjoint from both (`InventoryPanel.tsx`, `styles.css`) and runs alongside. |
| 2 | WP-3 | alone — it owns `App.tsx`, the only file that imports every other package's work |
| 3 | WP-5 | alone — it owns the committed `site/index.html` and the docs |

Checked against the `Owns` lists: WP-1 (`selection.ts`, `selection.test.ts`), WP-2
(`overview.ts`, `graph-types.ts`, the flip in `selection.test.ts`), WP-4
(`InventoryPanel.tsx`, `styles.css`) share no file except the test file WP-2 edits after
WP-1 has committed. Choke points that must never be co-owned: `styles.css` (WP-4 only),
`App.tsx` (WP-3 only), `site/index.html` (WP-5 only), `data.ts` and `packages/schema/**`
(nobody). Three waves; the first is the only one with concurrency.

## The regression to fear

**A single-account estate must not move at all.** Red-pin assertion 2 is the proof, and
WP-3's hand-built single-account `data.js` check is the eye on it. Everything else moves
only for the reasons decisions 33–41 name. Watch specifically for:

- A view that starts rebuilding on every render because the derived index is a new
  object each time (decision 40) — the symptom is the `Laying out diagram…` placeholder
  flashing on an unrelated state change.
- Saved positions from a show-all layout being applied to a two-account layout because
  the view key did not change (decision 39).
- The hashchange echo rebuilding the overview twice when the selection is applied.

**Hunt for the assumption rather than assuming its absence.** The assumption is *"the
index I was handed is the whole estate."* Every helper in `overview.ts` that looks a
thing up by account — `index.snapshot.accounts.find` for an S3 origin's owner (grep it),
the two-pass TGW placement, the org-tree reverse lookups in `addRamShareEdges` and
`addSsoAssignmentEdges` — was written under it. With a filtered snapshot each one either
falls through to a ghost (fine, report it) or silently draws nothing (not fine: name it).
WP-2's hand-back must list every such site and say which it is.

**What the fixture avoids.** Three accounts, every one attached to the same hub, with
aliases set. It does not have: an account with no cross-account link at all (selecting
it alone must show no ghosts and no error); two accounts whose only link is a RAM share
or an SSO assignment (the ghost comes from a different helper); an account with no
alias (the label falls back to the bare id and the inventory must still be usable); or
nineteen accounts (the Inventory header's `n of m shown` and the show-all timing). WP-3
builds the no-alias and no-link cases by hand-editing the dev `site/data/data.js` for
its checks and says which shapes it still did not try.

## Outcome

Recorded 2026-11-03 by WP-5, on the 3-account fixture in the committed
`site/data/data.js`, against the rebuilt `site/index.html`. Harness:
`node tools/perf/time-views.cjs` — headless Chromium 149 (Playwright 1.61.1),
`file://`, the built page (no StrictMode), a fresh browser context per run, five
runs per view, median with range. *First* is navigation start to the view being
drawn (`.canvas-empty`, or `.react-flow__node` present with `.loading` gone), so
it includes parsing the 2.3 MB page and the data bundle. *Repeat* navigates away
(a VPC; `#/` for the VPC row) and back in the same page, timed from the hash
change.

| view | hash | first | repeat | drawn |
| --- | --- | --- | --- | --- |
| empty overview | `#/` | 125 ms (123–165) | 5 ms (4–10) | empty canvas |
| one account | `#/?accounts=111111111111` | 164 ms (160–174) | 17 ms (16–21) | 39 nodes |
| all three | `#/?accounts=111111111111,222222222222,333333333333` | 170 ms (166–175) | 26 ms (21–36) | 71 nodes |
| one VPC | `#/vpc/vpc-0prod00000000000a1` | 188 ms (186–197) | 37 ms (36–43) | 75 nodes |

**Before**, from the defect table: 0.48 s first / 0.20 s repeat — but on the
19-account × 17-region synthetic estate (865 nodes), not this fixture, so the
rows above are not a before/after pair. What compares like with like is the
shape: on any multi-account estate the first paint is now the empty row — the
page and data parse with no `buildOverview` and no ELK — and the cost of a
selection scales with the accounts switched on, not with the estate. The
three-account fixture is too small to show the difference between one account
and all (164 vs 170 ms first); the real estate is where it should show.

`localStorage` does persist on `file://` in Chromium here: a selection changed in
the page is stored as `atlas:accounts`, survives a reload, and makes bare `#/`
non-empty in the same context — which is why the harness opens a fresh context
for every run. (A selection that arrives only in the opening URL is not written
to storage until it changes; the harness's `atlas:accounts=null` column reflects
that, not a storage failure.)

**Commits.** WP-1 `ebc6d35`, WP-4 `f2dc839`, WP-2 `bc5bdef`, WP-3 `788ec2b`,
WP-2b `b3835b3` + `b3d1d61`, WP-2c `5e4fdc4` (WP-2b and WP-2c were not in this
plan: they fixed nine lookup sites in `overview.ts` that dropped or
misattributed links into switched-off accounts, and the grid-packing of a
leaf-only ghost — see their commit messages and `ORCHESTRATION.md`), then WP-5's
docs commit and the bundle rebuild after it. **Tests: 24 → 40**, 0 fail;
typecheck clean.

### Follow-ups

- **Nineteen accounts or more** — the Inventory header's `n of m shown` and the
  picker at scale have only been seen on three.
- **The real 19-account work estate has not been measured.** That is Ben's to
  run: `node tools/perf/time-views.cjs --one=<id> --all=<ids> --vpc=<vpc-id>`
  against a checkout carrying the GitLab Pages `site/data/`.
- Shapes every package said its fixture still avoids: two accounts linked
  **only** by a RAM share to an OU or the org, or only by peering; an SSO
  administrator that is not the org management account; a DNS alias to an API
  Gateway regional domain; duplicate DNS names across switched-off accounts.
- A ghost holding many unlinked leaves is now laid out by ELK and stacks them as
  a single column; fine on the fixture, untried with dozens.
- With only `acme-prod` selected, the prod→`core-tgw` attachment line still
  passes under `core-tgw-us` inside the `acme-shared` ghost: React Flow draws its
  own straight edges, not ELK's routes.
- Going from the overview to bare `#/` keeps the selection (correct) but leaves
  the URL at `#/` instead of writing `?accounts=` back; from a VPC to `#/` it
  does write it back. The route is deduped by value, so the URL-sync effect does
  not re-run. Cosmetic, but a link copied at that moment does not reproduce the
  view.
