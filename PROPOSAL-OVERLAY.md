# Proposal overlay — the diagram shows a planned change, not only what exists

Written 2026-11-03 against `9d1f7e2` (clean tree apart from `package-lock.json` npm
noise — see ORCHESTRATION.md). Follows `ACCOUNT-PICKER.md`, which is **complete**;
inherits the standing rules and definition of done of `TERRAFORM-IMPORT-BLOCKS.md` and
`TERRAFORM-TOOLS-EXTRACTION.md`; decision numbering continues from 42. Read
`ORCHESTRATION.md` first — it names the gate, the frozen files, the committed build
artifact this plan has to rebuild, and the `overview.ts` lookup trap that this plan's
post-pass must not re-create.

Blitzit task `6ae4d61a119245e72f6b4d57`.

## The defect

The viewer renders scanned snapshots and nothing else. There is no second-snapshot
input anywhere, so the one thing a network diagram is most useful for — showing the
*next* change before it is made — cannot be done with it.

| surface | what it does | figure |
| --- | --- | --- |
| `packages/scanner/src/bundle.ts`, `bundle()` (hint: grep `jsonScriptPayload`) | writes exactly three globals: `__ATLAS_DATA__`, `__ATLAS_ANNOTATIONS__`, `__ATLAS_TERRAFORM__` | 3 files, 0 of them a proposal |
| `packages/viewer/src/data.ts`, `buildIndex()` (hint: grep `window.__ATLAS_DATA__`) | takes no arguments; reads the one global; **mutates** the snapshot it is given (fills empty collections) | 1 snapshot per page, ever |
| `packages/viewer/src/model/graph-types.ts`, `AtlasNodeData` | has `ghost`, `tfManaged`, `addAccountId` — flags for "not scanned", "managed", "switched off" — and no flag for "proposed" | 0 of 12 fields |
| `packages/viewer/src/components/AnnotatedEdge.tsx`, `EDGE_STYLES` | styles an edge from `edgeKind` only and **ignores `props.style` and `className`** | no per-edge override path |
| `packages/schema/src/snapshot.ts` | `RegionSnapshot` carries **118** arrays (117 typed kinds + `generic`), `AccountSnapshot.global` **24**; there is no runtime validator of any of it (`JSON.parse(...) as AccountSnapshot`, `bundle.ts:56`) | 142 collections, 0 validated |
| the repo | no `legend` string anywhere in `packages/viewer/src` | 0 |
| Ben, 2026-11-03 | "users won't be writing manual files for design — they'll use an LLM to create the designs; this should just render the difference" | reported |

The sizes to design against: the committed fixture is 3 accounts, 181 resources, 85 KB
of `data.js`; Ben's work estate is 19 accounts and ~48k resources. A proposal and its
validator must be cheap on the second; a design skill's context must be built from a
*summary* of it, never the raw snapshot.

## The reframing

**A proposal is a second snapshot, produced by applying a delta to the first; the
diagram is the union of the two, with each node and edge stamped added, removed,
changed or unchanged.** Nothing new is drawn by hand. The existing builders build both
snapshots exactly as they build one; a post-pass compares the two graphs by id (node ids
are already deterministic AWS ids — `acct:`, `region:`, `vpc:`, `tgw:`, `edge:<key>`);
the layout runs once on the union; the toggle between current / proposed / both is the
existing hidden mechanism.

The person does not write the delta. An agent does, from a plain-language request and a
compact description of the estate, and a validator tells it when it is wrong. The skill
that drives that loop ships in this repo for anyone's Claude Code or Codex.

## Decisions — taken, do not relitigate

43. **A fourth workspace, `packages/proposal` (`@atlas/proposal`), holds the proposal
    types, the delta application, the snapshot diff, the validator and the reader.**
    Pure TypeScript, no AWS SDK, consumed by the scanner and the viewer as a workspace
    dependency (precedent: `@atlas/schema`). `packages/schema/**` stays frozen; it
    imports schema *types* and does not touch them. ORCHESTRATION.md's "there is no
    fourth" is a statement of fact that this plan changes — WP-7 updates it.
44. **A proposal is one YAML file under `proposals/`, and its id is the file stem.**
    Shape (`@atlas/proposal` is the source of truth; this is the contract an LLM writes
    to, so it is verbose and exact rather than clever):

    ```yaml
    version: 1
    title: Add a data-platform spoke joined to the core TGW
    description: |            # markdown, optional
      Why this change…
    base:
      generatedAt: "2026-07-06T09:20:00.000Z"   # the scanned Snapshot.generatedAt
    accounts:                 # accounts the proposal creates (optional)
      - accountId: "555555555555"
        alias: acme-data
        regions: [eu-west-1]
    changes:
      - op: add
        account: "555555555555"
        region: eu-west-1     # or `global`
        collection: vpcs      # the RegionSnapshot / global array's own field name
        resource:
          id: proposed-vpc-data
          name: data-vpc
          cidrBlocks: ["10.3.0.0/16"]
          tags: {}
      - op: change
        key: sg-0a1b2c3d4e5f00001         # id or arn, resolved like byKey
        set:                              # shallow merge; arrays replace whole
          ingress: [...]
      - op: remove
        key: pcx-0prod0dev00000001
    ```
    `collection` is the snapshot's own vocabulary (`vpcs`, `transitGatewayAttachments`,
    `hostedZones`…), so the schema file is the documentation and no second vocabulary
    exists. Ops apply in order.
45. **Every id a proposal creates starts with `proposed-`.** The validator rejects an
    `add` whose `id` does not, and a `change` or `remove` whose key does not resolve.
    Nothing ever rewrites ids. This is how the viewer, the details panel and any later
    Terraform step tell a planned resource from a real one without a lookup.
46. **The base is identified by `generatedAt`.** A proposal whose `base.generatedAt`
    differs from the loaded snapshot's is **stale**: a warning in the CLI, a badge in
    the viewer, never an error — yesterday's design is usually still the design.
47. **Validation has two levels.** *Errors* (exit 1): malformed file, unknown
    collection for that scope, missing or non-`proposed-` id on add, duplicate id,
    unresolvable `change`/`remove` key, and an unresolvable **reference** — any field
    named `…Id`, `…Ids`, `…Arn` or `arn` holding an AWS-id-shaped string that resolves
    in neither the base nor the proposal. Account-id fields (`accountId`, `ownerId`,
    `…OwnerId`, peering sides) are exempt from that rule because links to unscanned
    accounts are legitimate; they warn instead. *Warnings* (exit 0): stale base, and the
    design rules of decision 48. `--strict` promotes warnings to errors. The agent loops
    until exit 0.
48. **Design rules exist for the networking core only, as warnings:** CIDR overlap
    between VPCs joined by a peering or a shared TGW; a subnet CIDR outside its VPC's; a
    TGW attachment whose VPC or subnets are in another region or account than it says;
    an SG rule referencing an SG in a different VPC; a route whose target does not
    resolve. Every other kind diffs and renders generically with no design rule. Rules
    live in `packages/proposal/src/rules/` behind one registry so a later plan can add
    more without touching the validator.
49. **The diff is a post-pass over two built graphs, for every view.** `diffGraphs(
    current, proposed, changes)` unions nodes and edges by id and stamps
    `changeState: 'added' | 'removed' | 'changed'` on node and edge `data`; absent means
    unchanged. A node present in both is *changed* when its `refId` is in the snapshot
    `ChangeSet` or its `label`, `subtitle` or `parentId` differ. The overview, VPC and
    focus builders are untouched: each is called twice, once per index, exactly as
    `applyTerraformBadges` wraps them today (`App.tsx`, grep it).
50. **Layout the union once; toggling never relayouts.** *Current* hides `added`,
    *proposed* hides `removed`, *both* hides neither — through the existing React Flow
    `hidden` path in `FlowView.tsx`, which already hides children of hidden parents.
    The union lays out differently from the current-only graph; that is accepted.
    Positions and hidden state are keyed per view **including the proposal id**.
51. **The active proposal travels in the URL as `proposal=<id>` on every route**
    (`#/?accounts=…&proposal=x`, `#/vpc/<id>?proposal=x`, `#/focus/<key>?proposal=x`)
    and is **not** remembered in `localStorage`. A proposal is something you open on
    purpose. Unknown id → ignored with a console warning, URL rewritten without it.
52. **Accounts a proposal creates are always drawn while it is active.** They are added
    to the effective selection (`withAccounts` over the proposed index) — otherwise the
    headline of a "new spoke" proposal is invisible. The Inventory lists the effective
    index while a proposal is active, so the new account has an eye like any other.
53. **`site/data/proposals.js` (`window.__ATLAS_PROPOSALS__`, an array) is written by
    `bundle`, by `fixture`, and by the new `propose bundle` subcommand.** The viewer
    tolerates its absence (the dev plugin already serves an empty stub for a missing
    `/data/*.js`). `propose bundle` writes **only** that file — it must be safe to run
    in a checkout with no `data/`, where `npm run bundle` would overwrite the demo
    `data.js` with zero accounts (a pre-existing trap; see Standing rules).
54. **`describe` is the skill's eyes.** `npm run describe` prints markdown from
    `site/data/data.js` (the same bytes the viewer shows): per account its id, alias,
    regions, VPCs with CIDRs and subnet/SG/endpoint counts, TGWs with their
    attachments, peerings, hosted zones, load balancers, and the org tree; every list
    capped with `+N more`; a closing table of counts per collection. Budget ~2 KB per
    account so nineteen fit in a context with room to think. `--account <id>` narrows;
    `--json` gives the same thing structured. It never reads `data/accounts/*.json`.
55. **The skill is a directory at the repo root, `atlas-propose/`, holding `SKILL.md`**
    in the Claude Skills format that Claude Code and Codex both read. No symlinks, no
    `.gitignore` change, no `AGENTS.md`; the README tells a user to point their agent at
    it or copy it into their skills directory. Ben chose this on 2026-11-03.
56. **Out of scope, do not stretch:** generating Terraform from a proposal (natural
    phase 3 — `tf-import-blocks`' `ruleForKind` already maps kinds to types), editing a
    proposal in the UI, side-by-side rendering, and any VPC-detail layout work
    (decision 42 still stands).
57. **`packages/viewer/src/data.ts` is unfrozen for exactly one change:** `buildIndex(
    snapshot?, annotations?, terraform?)` with each parameter defaulting to the global it
    reads today. Every existing call stays argument-less. Ben granted this on
    2026-11-03; the rest of the file stays frozen and a pin proves the no-argument call
    is byte-identical.
58. **Display caps are a known diff artifact.** `addCapped` draws at most N items then a
    `+N more` note (`overview.ts`, grep `CAP_`); a resource can be under the cap in one
    snapshot and over it in the other, so the note itself shows as *changed* and a real
    resource may be absent from both drawings. Accepted; the details panel still shows
    every change from the `ChangeSet`.

## Standing rules

Carried forward unchanged from the three earlier plans and `ORCHESTRATION.md`:

- Commit straight to `main`, no trailers; agents commit and do not push; the orchestrator
  runs the gate (`npm install && npm run typecheck && npm test`) before every push. The
  gate was green at `9d1f7e2` on 2026-11-03: **40 tests, 0 fail, 0 todo**, typecheck
  clean across all three workspaces. Re-run it before wave 1 and compare the count.
- `packages/schema/**` is frozen. `packages/viewer/src/data.ts` is frozen except for
  decision 57.
- `tsconfig.base.json` sets `strict` and `noUncheckedIndexedAccess`.
- Every package that supersedes a symbol deletes it in the same commit and reports per
  symbol: deleted, or kept with the name of the caller.
- `site/index.html` is a committed build artifact. The **last** package rebuilds it and
  proves it by grepping the bundle for a string that only exists after this plan
  (`__ATLAS_PROPOSALS__`) with a control grep for a tree-shaken string (`from-state`).
- `file:line` references here are hints. Grep for the symbol, confirm it says what the
  plan claims, report drift rather than working around it.
- Emit output between steps; commit before the long final verification pass; a browser
  pass goes first, not last.
- **Never run `npm run bundle` in this checkout.** There is no `data/` directory; it
  would rebuild `site/data/data.js` from zero accounts and destroy the demo. Use
  `npm run fixture` to regenerate the demo data, and `npm run propose -- bundle` (WP-2)
  for proposals alone. If `site/data/data.js` changes in your `git status` and you did
  not mean it to, stop and say so.
- **The new workspace changes `package-lock.json`.** WP-1 commits that change. The
  `"peer": true` noise from the current npm will ride along in the same hunk; say so in
  the commit body rather than fighting it.

## The red pin

`packages/viewer/test/proposal.test.ts` (WP-1) builds the same three-account miniature
estate as `selection.test.ts` (hub `222…` owning a TGW, spokes `111…` and `333…`
attached), indexes with a test-local `indexOf(snapshot)` that sets
`globalThis.window.__ATLAS_DATA__` and calls `buildIndex()` exactly as that file does
(**not** the decision-57 parameter — the pin must not depend on WP-3), and asserts:

1. `applyProposal(snapshot, newSpoke)` — a proposal adding account `555…` with one VPC
   and a TGW attachment to the hub — returns a snapshot with four accounts, the new one
   carrying `proposed-vpc-data` and `proposed-attach-data`, and leaves the input
   unchanged (deep-equal to a copy taken before).
2. `diffSnapshots(base, applied)` reports exactly those two adds and one added account,
   nothing removed, nothing changed. A `change` op on the hub VPC's `cidrBlocks` reports
   one changed resource with `before`/`after` for that field only.
3. `validateProposal(base, newSpoke)` returns no errors; the same proposal with an
   attachment whose `transitGatewayId` is `tgw-doesnotexist` returns one error naming the
   field and the key; with `base.generatedAt` moved it returns one `stale` warning.
4. `diffGraphs(buildOverview(idx(base)), buildOverview(idx(applied)), changes)` marks
   `acct:555…`, `vpc:proposed-vpc-data` and the attachment edge `added`, and **every
   other node and edge carries no `changeState`**; and with an *empty* proposal the
   result deep-equals `buildOverview(idx(base))` on nodes and edges — the "must not
   move" assertion.
5. **The committed demo.** Reads `proposals/new-spoke.yaml` and `site/data/data.js`
   from the repo root (`readSiteData` parses the `window.X=JSON.parse('…')` payload with
   no `eval`), validates with zero errors, applies, diffs the overviews, and finds at
   least one `added` account container and one `added` attachment edge. Against
   `9d1f7e2` that file does not exist; WP-1 lands it as `test(..., { todo: true })` with
   the observed failure (`ENOENT proposals/new-spoke.yaml`) in its comment.

WP-1 lands 1–4 green and 5 `todo`. **WP-6 flips 5 to a plain `test` as part of its
acceptance**, by running the skill for real. When that assertion passes as a plain
assertion, the plan is done. There is no other definition.

## WP-1 · `@atlas/proposal`: the contract, apply, diff, validate, and the pin

**Goal:** a pure, tested package that turns a proposal file into a second snapshot, says
what changed between two snapshots, and says whether a proposal is well-formed — plus
the viewer-side graph post-pass, which is pure too.

- New workspace `packages/proposal` with `package.json` (`@atlas/proposal`, `private`,
  `exports` of `./src/index.ts` and `./src/read.ts`, `typecheck` script) and
  `tsconfig.json`, copied from `packages/schema` (ORCHESTRATION.md names it the
  cleanest template). Depends on `@atlas/schema` (workspace) and `yaml` (same version
  the scanner pins; only `read.ts` imports it so the viewer never bundles it).
- `src/types.ts`: `Proposal`, `ProposalAccount`, `ProposalChange` (`add` | `change` |
  `remove` discriminated union), `ChangeSet { addedAccounts, added, removed, changed:
  { key, kind?, before, after, fields } }`, `Issue { level: 'error' | 'warning', code,
  message, path?, key? }`. Doc comments aimed at WP-2 (CLI) and WP-3/WP-5 (viewer).
- `src/apply.ts`: `applyProposal(snapshot, proposal): Snapshot` — structural clone,
  new accounts via `emptyRegionSnapshot` / `emptyGlobal` from `@atlas/schema`, ops in
  order, `change` as shallow merge with arrays replaced whole, `remove` by id-or-arn
  across every collection. Never mutates its input.
- `src/diff.ts`: `diffSnapshots(a, b): ChangeSet` — walk every collection of every
  account/region/global, key by `id` (and `arn` for `generic`), field-level `before` /
  `after` on changed resources using the same stable-JSON comparison the scanner's
  `stable-json.ts` uses (copy the idea, not the file — different package).
- `src/validate.ts`: `validateProposal(snapshot, proposal, { strict? }): Issue[]` per
  decisions 45–47, with the collection name list derived from `emptyRegionSnapshot('x')`
  and `emptyGlobal()` keys so it cannot drift from the schema. The reference rule's
  id-shape regex and account-field exemptions are exported constants with a comment
  saying why. A `rules` registry hook (`src/rules/index.ts`, exporting an empty array
  and the `DesignRule` interface) so WP-1b adds networking rules without editing this
  file.
- `src/read.ts`: `parseProposal(text, id): Proposal` (YAML → shape check → typed) and
  `readSiteData(text): Snapshot` (the `window.X=JSON.parse('…')` payload: locate the
  quoted string, reverse `jsonScriptPayload`'s escaping — grep it in `bundle.ts` — then
  `JSON.parse`; no `eval`, no `Function`).
- `packages/viewer/src/model/diff.ts`: `diffGraphs(current: AtlasGraph, proposed:
  AtlasGraph, changes: ChangeSet): AtlasGraph` per decision 49, returning a **new**
  graph (never mutating either input) ordered parents-before-children like the builders.
  `packages/viewer/src/model/graph-types.ts`: `ChangeState` type and `changeState?` on
  `AtlasNodeData` and `AtlasEdgeData`, doc-commented for WP-4.
- Tests: `packages/proposal/test/{apply,diff,validate,read}.test.ts` (`node:test` via
  `tsx`, miniature snapshots built from the schema factories as `tf-match-report.test.ts`
  does), and the red pin above. Before building anything run the pin alone against the
  parent commit and paste the failure.
- Add `packages/viewer` and `packages/scanner` dependencies on `@atlas/proposal`
  (`package.json` only — one line each; WP-2/3/4 import from it in wave 2).

**Acceptance:** `npm test` discovers five more files than before (record counts); pin
assertions 1–4 green, 5 `todo`; `npm run typecheck` green across **four** workspaces;
`npm run build` still succeeds (the viewer bundle must not grow by the `yaml` package —
grep `site/index.html` is not rebuilt here, so check `vite build` output size against
the parent commit's and report both numbers). `applyProposal` on the 85 KB fixture
snapshot with a 200-op proposal runs under 50 ms (measure; record).

Owns: `packages/proposal/**`, `packages/viewer/src/model/diff.ts`,
`packages/viewer/src/model/graph-types.ts`, `packages/viewer/test/proposal.test.ts`,
`package-lock.json`, the one-line dependency additions in `packages/viewer/package.json`
and `packages/scanner/package.json`.
Size **L**. Depends: none. Runs alone.

## WP-1b · Networking design rules

**Goal:** decision 48's warnings exist and are pinned.

- `packages/proposal/src/rules/{cidr-overlap,subnet-in-vpc,attachment-locality,
  sg-rule-vpc,route-target}.ts`, each a `DesignRule` registered in `rules/index.ts`.
  Each rule receives the *applied* snapshot and the `ChangeSet` and may only warn about
  resources the proposal touched or that a touched resource references — never about
  pre-existing problems in the base, which are the scanner's business.
- Tests per rule, each with the awkward case: an overlap that is only visible through a
  TGW (two spokes each fine with the hub, overlapping with each other); a subnet that
  is a superset of its VPC; an attachment in the right account but wrong region.

**Acceptance:** five rules, each with a test that fails with the rule unregistered;
`validateProposal` on the pin's `newSpoke` still returns zero warnings (the demo
proposal must be clean by design).

Owns: `packages/proposal/src/rules/**`, `packages/proposal/test/rules.test.ts`.
Size **S**. Depends: WP-1.

## WP-2 · The scanner side: `propose`, `describe`, and the bundle

**Goal:** the skill has a validator to loop on, eyes to design with, and a way to get a
proposal in front of the viewer without touching `data.js`.

- `packages/scanner/src/cli.ts`: subcommands `propose` (`validate <file>…` with
  `--strict`; `bundle`) and `describe` (`--account`, `--json`), following the existing
  `parseArgs` + `if` chain and the HELP block (grep `HELP`). `propose` and `describe`
  run before `loadConfig` like `tf-blocks` does — they need no AWS and no config beyond
  the repo root.
- `packages/scanner/src/propose.ts`: `readProposals(dir): Proposal[]` (every
  `proposals/*.yaml`, sorted, via `@atlas/proposal/read`; a file that fails to parse is
  reported with its path and skipped, never fatal to the bundle), `writeProposalsJs(
  proposals)` → `site/data/proposals.js` as `window.__ATLAS_PROPOSALS__` via the existing
  `jsonScriptPayload`, and the `validate` runner printing issues as `level code path:
  message` lines with a closing count and the exit code of decision 47.
- `packages/scanner/src/describe.ts` per decision 54. Read `site/data/data.js` through
  `readSiteData`. Measure the output on the fixture and record bytes per account.
- `bundle.ts` `bundle()` and `fixture.ts` both call `readProposals` + `writeProposalsJs`
  so every path that writes `site/data/` writes all four files. The bundle summary line
  gains `N proposal(s)`.
- Root `package.json` scripts: `"propose": "npm run --workspace @atlas/scanner propose --"`
  and `"describe": …`; scanner `package.json` the matching `tsx src/cli.ts …` entries.
- Tests: `packages/scanner/test/propose.test.ts` (validate exit codes and output on a
  temp dir with a good and a bad proposal; `bundle` writes `proposals.js` and nothing
  else; a checkout with no `proposals/` dir yields an empty array) and
  `describe.test.ts` (fixture-shaped miniature → markdown contains each account's alias,
  every VPC CIDR, and `+N more` once a list passes the cap).

**Acceptance:** `npm run propose -- validate` on a hand-made good file exits 0 with
`0 error(s), 0 warning(s)`; on a file with a non-`proposed-` id exits 1 naming the
path; `npm run propose -- bundle` in this checkout writes `site/data/proposals.js` and
**does not change `site/data/data.js`** (prove with `git status`); `npm run describe`
on the fixture prints under 6 KB for three accounts. `npm run fixture` now writes four
files. Gate green.

Owns: `packages/scanner/src/cli.ts`, `packages/scanner/src/bundle.ts`,
`packages/scanner/src/fixture.ts`, `packages/scanner/src/propose.ts`,
`packages/scanner/src/describe.ts`, `packages/scanner/test/propose.test.ts`,
`packages/scanner/test/describe.test.ts`, root `package.json`, `packages/scanner/package.json`.
Size **M**. Depends: WP-1.

## WP-3 · The viewer loads a proposal and indexes it

**Goal:** the viewer can hold a proposed index next to the current one.

- `packages/viewer/src/data.ts`: decision 57 and nothing else. The diff of this file
  must be the signature line, the three defaults, and a doc comment.
- `packages/viewer/src/global.d.ts`: `__ATLAS_PROPOSALS__?: Proposal[]`.
  `packages/viewer/index.html`: the fourth `<script vite-ignore>` tag for
  `./data/proposals.js` beside the other three.
- `packages/viewer/src/model/proposal.ts`: `loadProposals(): Proposal[]` (the global,
  tolerant of absence); `proposedIndex(index, proposal): AtlasIndex` — `applyProposal`
  then `buildIndex(applied, index.annotations, index.terraform)`; memoised in a
  `WeakMap<AtlasIndex, Map<proposalId, AtlasIndex>>` so a given (index, proposal) pair
  builds once (the `focus.ts` relations cache is keyed on the index object, so the
  proposed index must be a stable object too). `effectiveAccounts(selected, proposal)`
  per decision 52. `parseProposalParam(hash)` / `withProposalParam(hash, id)` per
  decision 51, tolerant like `parseAccountsParam`, exported for WP-5 with doc comments.
  `changeSetFor(index, proposal)` memoised the same way.
- Tests: `packages/viewer/test/data-index.test.ts` pins decision 57 — `buildIndex()`
  with no arguments deep-equals `buildIndex(window.__ATLAS_DATA__, …)` and deep-equals
  the index the parent commit built (record the parent's `all.length` and `byKey.size`
  for the miniature in the comment); `proposal-model.test.ts` for the memo identity, the
  URL helpers, and `effectiveAccounts`.

**Acceptance:** `git diff packages/viewer/src/data.ts` is under 10 lines and contains
no change outside `buildIndex`'s signature, defaults and comment; gate green.

Owns: `packages/viewer/src/data.ts` (decision 57 only), `packages/viewer/src/global.d.ts`,
`packages/viewer/index.html`, `packages/viewer/src/model/proposal.ts`,
`packages/viewer/test/data-index.test.ts`, `packages/viewer/test/proposal-model.test.ts`.
Size **S**. Depends: WP-1.

## WP-4 · Drawing a change: node and edge states, the bar, the legend, the field diff

**Goal:** a graph whose data carries `changeState` looks like a planned change to a
person, and a changed resource shows what changed.

- `packages/viewer/src/components/nodes.tsx`: `ResourceNode` and `ContainerNode` add
  `is-added` / `is-removed` / `is-changed` classes from `data.changeState`; the
  container label gains a small state word (`proposed`, `to remove`, `changed`) in the
  header where `not shown · click to add` sits for ghosts.
- `packages/viewer/src/components/AnnotatedEdge.tsx`: `changeState` overrides the stroke
  (green dashed for added, red dashed for removed, amber for changed) on top of
  `EDGE_STYLES`, and the label gets the matching class. This is the file that ignores
  `props.style` today — do not route the override through `style`; read `data`.
- `packages/viewer/src/styles.css`: the six classes above, `.proposal-bar`,
  `.proposal-bar select`, `.proposal-toggle` (segmented current / proposed / both),
  `.proposal-legend` with three swatches, `.proposal-stale` badge, and the details
  panel's `.field-diff` (before struck through, after beside it). Colours must survive
  on top of `.is-ghost` and `.style-ghost` — a proposed resource inside a ghost account
  box is the normal case for a new spoke. `styles.css` is a choke-point file; this
  package is its only owner.
- New `packages/viewer/src/components/ProposalBar.tsx`: props `proposals`, `activeId`,
  `mode`, `stale`, `onSelect(id | undefined)`, `onMode(mode)`; renders the select
  (`none` first), the segmented toggle, the legend, the stale badge with the base date,
  and the proposal's `title`. Pure presentational; WP-5 mounts it under the toolbar.
- `packages/viewer/src/components/DetailsPanel.tsx`: the resource view takes an optional
  `change?: ChangeSet['changed'][number] | { added: true } | { removed: true }` and,
  when present, heads the Properties block with the state and renders changed fields as
  a before/after pair, unchanged fields as today. Optional prop so WP-5 can wire it
  later and nothing renders differently without it.
- Browser pass first: Playwright + Chromium are installed (`packages/viewer`). Since
  nothing passes `changeState` yet, drive it by injecting a hand-built graph through a
  throwaway edit you revert by hand (never `git checkout --`/`restore`/`stash`), and
  screenshot added / removed / changed nodes and edges, the bar, and a field diff in the
  details panel. Confirm the panel and every node render byte-identically with no
  `changeState` present (compare `outerHTML` before/after as WP-4 of the picker did).

**Acceptance:** screenshots named in the hand-back; props-absent rendering byte-identical;
`git diff App.tsx` empty; gate green.

Owns: `packages/viewer/src/components/nodes.tsx`,
`packages/viewer/src/components/AnnotatedEdge.tsx`, `packages/viewer/src/styles.css`,
`packages/viewer/src/components/ProposalBar.tsx`,
`packages/viewer/src/components/DetailsPanel.tsx`.
Size **M**. Depends: WP-1 (types only).

## WP-5 · The overlay wired through App

**Goal:** opening `#/?accounts=…&proposal=new-spoke` shows the planned change on the
overview, the VPC view and the focus view; the bar switches proposals and modes; the
details panel explains a change.

- `packages/viewer/src/components/App.tsx`:
  - `proposals` from `loadProposals()` once; `proposalId` state initialised from the
    URL (decision 51), applied through one `applyProposal(id)` that rewrites the hash
    with `withProposalParam` on the current route and keeps the dedupe-by-value guard.
    `parseHash` / `routeHash` carry the param on all three routes; `viewKey` and
    `graphKey` include it (decision 50).
  - `proposed = proposalId ? proposedIndex(index, proposal) : undefined` and
    `changes = changeSetFor(...)`, both memoised by the WP-3 helpers; `shown` becomes
    `withAccounts(proposed ?? index, effectiveAccounts(accounts, proposal))`.
  - The build effect: when `proposed` is set, build the view twice — once from the
    current index (through `withAccounts` with the same effective selection) and once
    from the proposed — then `diffGraphs(...)`, then `applyTerraformBadges` on the
    union, then one `layoutGraph`. Without a proposal, exactly today's single build;
    the decision-38 empty short-circuit is unchanged.
  - `mode` state (`'both'` default) applied through the existing hidden path:
    extend the `hidden` computation in `FlowView.tsx` with a `hideStates` set rather
    than touching `HiddenState` storage — mode is view state, not remembered.
  - `onNodeClick`: resolve `refId` in `proposed?.byKey` first, then `index.byKey`
    (a removed resource exists only in the current index, an added one only in the
    proposed); pass `change` to `DetailsPanel` from `changes`.
  - Mount `ProposalBar` under the toolbar only when `proposals.length > 0`; pass
    `stale` from decision 46. Inventory receives `proposed ?? index` (decision 52).
- `packages/viewer/src/components/FlowView.tsx`: the `hideStates` prop only.
- Browser acceptance on the fixture with a hand-written `site/data/proposals.js`
  (copy the pin's `newSpoke` into the format `writeProposalsJs` emits — or run
  `npm run propose -- bundle` if WP-2 has landed) — restore `site/data/` by hand after:
  1. `#/?accounts=111111111111&proposal=new-spoke` draws prod, the hub ghost, and a
     new `acme-data (555555555555)` container marked *proposed* with its VPC and the
     attachment edge in green; the Inventory lists four accounts.
  2. Mode *current* hides the new account; *proposed* shows it and hides nothing else
     (no removals in this proposal); *both* is the default. No relayout between modes
     (node positions identical — assert via the DOM transform).
  3. A second hand-written proposal that removes `pcx-…` (the prod↔dev peering) and
     changes the prod VPC's `cidrBlocks` shows the peering edge red dashed, the VPC
     amber, and the details panel shows `cidrBlocks` before/after.
  4. Double-click the prod VPC: the VPC view carries `?proposal=` and shows the amber
     VPC; *Overview* returns with the proposal still active. Selecting `none` in the
     bar drops the param and rebuilds exactly today's view (compare node id set to a
     no-proposal load).
  5. The decision-39/40 regressions: switching proposals changes the view key (dragged
     positions do not bleed between proposals), and an unrelated state change does not
     rebuild (count builds as the picker's WP-3 did).
  6. A URL naming an unknown proposal loads today's view with a console warning.
- Deletions: none expected; say so.

**Acceptance:** all six, with screenshots; gate green; `npm test` count unchanged from
wave 2 (this package adds no tests — it is browser-verified; say that in the hand-back).

Owns: `packages/viewer/src/components/App.tsx`, `packages/viewer/src/components/FlowView.tsx`.
Size **M**. Depends: WP-2 (for `propose bundle`; otherwise hand-write the file), WP-3, WP-4.
Runs alone — it owns the only file that imports every other package's work.

## WP-6 · The skill, run for real

**Goal:** `atlas-propose/SKILL.md` exists, an agent following it produces
`proposals/new-spoke.yaml` on the fixture with no hand-holding, and the pin's assertion 5
passes as a plain test.

- `atlas-propose/SKILL.md` (decision 55) in the Claude Skills format (frontmatter `name:
  atlas-propose`, a `description` that says when to use it, then the body). The body is
  the loop, written for an agent that has never seen this repo:
  1. Confirm the checkout has `site/data/data.js` (a scan or the fixture); run
     `npm run describe` and read it — never read `data.js` raw.
  2. Restate the user's request as a list of resources to add, change or remove, in the
     snapshot's collection vocabulary; for each collection involved, read its type in
     `packages/schema/src/snapshot.ts` (grep the collection name) so the fields are the
     real ones.
  3. Write `proposals/<kebab-name>.yaml` per decision 44: `base.generatedAt` copied from
     `describe`'s header, every new id `proposed-…`, every reference to an existing
     thing by its real id from `describe`.
  4. `npm run propose -- validate proposals/<name>.yaml`; fix every error, read every
     warning and either fix it or explain it in the proposal's `description`; repeat
     until exit 0.
  5. `npm run propose -- bundle`; tell the user to open `site/index.html` at
     `#/?proposal=<name>` and which accounts to switch on.
  6. What the skill must not do: run `npm run bundle` (the Standing-rules trap), run
     `scan`, invent ids, or touch `site/data/data.js`.
- The author of this package **runs the skill as its first user** on the fixture with
  the request *"Add a new spoke account `acme-data` (555555555555) with a VPC
  10.3.0.0/16 in eu-west-1, attached to the core TGW, with a private subnet and a
  security group allowing 443 from prod"* and commits the result as
  `proposals/new-spoke.yaml` plus the regenerated `site/data/proposals.js` (via
  `npm run fixture` — check `git status` shows no change to `data.js`). Every place the
  instructions were ambiguous, wrong, or made the author look outside the skill is a
  defect in the skill: fix it, then record the list in the hand-back.
- Flip pin assertion 5 to a plain `test`.
- Deletions: none; say so.

**Acceptance:** assertion 5 passes plain; `npm run propose -- validate
proposals/new-spoke.yaml` exits 0 with zero warnings; opening the viewer at
`#/?accounts=111111111111&proposal=new-spoke` shows the new spoke (screenshot); the
hand-back lists the skill defects found by running it. Gate green.

Owns: `atlas-propose/SKILL.md`, `proposals/new-spoke.yaml`, `site/data/proposals.js`,
the flip in `packages/viewer/test/proposal.test.ts`.
Size **M**. Depends: WP-2, WP-5. Runs alone.

## WP-7 · Documentation and the committed viewer

**Goal:** a reader of the README can design a change with their agent and see it; the
orchestration doc knows about the fourth workspace; the bundle is rebuilt and proven.

- `README.md`: a new `## Planning a change (proposals)` section after *The viewer*:
  what a proposal is, the YAML shape in brief with a pointer to `@atlas/proposal`'s
  types as the source of truth, the `propose` and `describe` commands, the URL form,
  the legend, stale badges, and **how to use the skill** — point Claude Code or Codex at
  `atlas-propose/SKILL.md`, or copy the directory into the tool's skills folder. *Try it
  without an AWS account* gains one line: open `#/?accounts=…&proposal=new-spoke`.
  *Commands* and *What gets committed* tables gain `proposals/*.yaml` (owner: you or
  your agent) and `site/data/proposals.js` (scanner). Keep the register.
- `ORCHESTRATION.md`: *Repo shape* becomes four workspaces with a row for
  `@atlas/proposal`; a paragraph recording that the diff is a post-pass (decision 49)
  and that any new builder output must keep deterministic ids or the overlay silently
  loses it; the `npm run bundle` trap; and the stale "no `.github/` at all" sentence
  corrected (there is a dependency-audit workflow that checks no code). Keep its voice.
- Rebuild `site/index.html` with `npm run build`; prove with the two greps of the
  Standing rules; confirm the only changed file under `site/` is `index.html`.
- `## Outcome` in this file: final commit list, test count (40 → n), the `describe`
  byte figures from WP-2, the WP-1 timing, the skill defects WP-6 found, and
  *Follow-ups* (every shape the packages said their fixtures avoid, plus the
  Terraform-generation phase 3).

**Acceptance:** README section present and truthful against the source; ORCHESTRATION
rows and paragraphs present; both greps as stated; Outcome written; gate green.

Owns: `README.md`, `ORCHESTRATION.md`, `site/index.html`, this file's *Outcome* section.
Size **S**. Depends: WP-6. Runs alone.

## Waves

| Wave | Packages | Notes |
| --- | --- | --- |
| 1 | WP-1 | alone — everything imports it, and it owns `package-lock.json` |
| 2 | WP-1b + WP-2 + WP-3 + WP-4 | disjoint: `proposal/src/rules/**` · scanner files + root `package.json` · `data.ts`, `global.d.ts`, `index.html`, `model/proposal.ts` · components + `styles.css` |
| 3 | WP-5 | alone — `App.tsx` and `FlowView.tsx` |
| 4 | WP-6 | alone — runs the skill, owns the demo proposal and `proposals.js` |
| 5 | WP-7 | alone — owns the committed `site/index.html` and the docs |

Checked against the `Owns` lists: in wave 2 the only file two packages could both want
is `packages/viewer/src/model/graph-types.ts`, which WP-1 finished in wave 1 and nobody
in wave 2 owns — WP-4 reads `ChangeState` from it and must not add to it (route an
addition through the orchestrator). Choke points that must never be co-owned:
`styles.css` (WP-4), `App.tsx` (WP-5), `data.ts` (WP-3, decision 57 only),
`package-lock.json` (WP-1), `site/data/**` (WP-6 writes `proposals.js`; nobody writes
`data.js`), `site/index.html` (WP-7), `packages/schema/**` (nobody). Five waves; only the
second is concurrent.

## The regression to fear

**What must provably not move:** the viewer with no proposal active. Pin assertion 4's
empty-proposal deep-equal and WP-3's `buildIndex()` deep-equal are the proofs; WP-5's
acceptance 4 (selecting `none` rebuilds exactly today's view) is the eye on it. `npm
run fixture` must still write byte-identical `data.js`, `annotations.js` and
`terraform.js` — only `proposals.js` is new.

**What could break silently:**

- The overlay drawing a proposed resource in the wrong place because a builder lookup
  resolved it through the *current* index. The builders are called with one index at a
  time (decision 49) so this cannot happen inside a build — but `App.tsx`'s own lookups
  (`onNodeClick`, the Inventory, the details panel) can. WP-5's acceptance 1 and 3 are
  the checks.
- A node that exists in both graphs with a different `parentId` (a VPC moved between
  regions is not possible, but a leaf moving lanes because a cap shifted is — decision
  58). The post-pass must mark it `changed`, not draw it twice or lose it; WP-1's tests
  need this case.
- `layout.ts` grid-packing a container whose children are a mix of current and proposed
  leaves — it decides by "all children are non-containers", which still holds; but a
  ghost account box that gains a *proposed* VPC container stops being leaf-only and
  changes layout path. Accepted, but WP-5 should look at the new-spoke screenshot with
  this in mind.
- The `yaml` package landing in the viewer bundle through `@atlas/proposal`'s index.
  WP-1's size comparison is the check; WP-7's control grep is the backstop.

**Hunt for the assumption rather than assuming its absence.** The assumption this plan
relaxes is *"a resource id that resolves in `byKey` is a real, scanned resource."*
Every consumer of a `refId` — the details panel, the Terraform badge pass, the
import-block copy in the Layers panel, the search index, `tf-import.ts`'s
`resolveScanned` — was written under it. With a proposed index in play each one either
does something sensible with a `proposed-` id (fine — report what), or offers to copy
an import block for a resource that does not exist (not fine — name it). WP-5's
hand-back must list every such site and say which it is; the `proposed-` prefix
(decision 45) is what makes the check possible.

**What the fixtures avoid.** The pin's miniature is a hub and two spokes with aliases;
the demo proposal adds one account. Neither has: a proposal that *removes* an account;
a `change` to a resource that is referenced by an edge whose label derives from the
changed field (a route table's routes, an SG's rules — the edge should go amber, and
nothing tests that the label updates); two proposals in the same checkout; a proposal
against a stale base in the viewer; an estate large enough for `describe`'s caps to
fire on a real account; or any kind outside networking (an IAM role trusted by a
proposed account, an S3 bucket in one). WP-5 builds the removed-peering and
changed-CIDR cases by hand; WP-1b builds the TGW-mediated overlap. Everything else is
where the live defect will be found by a person, and WP-7's follow-ups must list it.

## Outcome

Complete on 2026-11-03. Pin assertion 5 passes as a plain test (WP-6, `a687864`), which is
this plan's definition of done, and the committed `site/index.html` now draws the demo
proposal. Nothing is pushed.

### Commits

| commit | package | subject |
| --- | --- | --- |
| `35ebcbe` | plan | Plan: A proposal overlay that draws a planned change over the scanned estate |
| `4ea0b85` | WP-1 | Proposal: Add @atlas/proposal, which applies, diffs and validates a delta |
| `18fb7ef` | WP-1 | Viewer: Stamp a proposal's changes on the union of two built graphs |
| `3bf2164` | WP-3 | Viewer: Index a proposed snapshot beside the scanned one |
| `532c457` | WP-1b | Proposal: Warn about overlaps, stray subnets and attachments, routes and SGs |
| `4687b9e` | WP-2 | Scanner: Add propose validate, propose bundle and describe |
| `6652683` | WP-4 | Viewer: Draw a proposal's added, removed and changed states |
| `d5c994f` | WP-5 | Viewer: Wire a proposal through the overview, VPC and focus views |
| `a687864` | WP-6 | Skill: Add atlas-propose and the new-spoke demo it wrote |
| `c48b986` | WP-5b | Viewer: Keep planned resources out of Terraform and import scanned rules |
| `c131314` | WP-7 | Viewer: Rebuild the committed bundle for the proposal overlay |
| the commit carrying this section | WP-7 | Docs: Describe proposals and the atlas-propose skill, and record the outcome |

WP-5b was built in its own worktree (`wp/5b`, `279c90f` on `d5c994f`) and landed on `main`
after WP-6, as `c48b986`.

### Figures

| measure | figure |
| --- | --- |
| `npm test` | **40 → 125** tests, 0 fail, 0 todo; **5 → 16** files |
| `npm run typecheck` | green across **four** workspaces (proposal, scanner, schema, viewer) |
| `applyProposal`, 200 ops (100 add, 100 change) on the 85 KB fixture (WP-1) | median **0.76 ms** over 7 runs (min 0.69, max 1.54) against a 50 ms budget; `validateProposal` 3.67 ms; apply + `diffSnapshots` 1.95 ms |
| `describe`, fixture, 3 accounts (WP-2) | **5,812 B** total: acme-prod 1,831, acme-shared 1,249, acme-dev 578, header 222, counts 1,928. `--account`: 3,601 / 2,210 / 1,274. `--json` 27,007 (pretty-printed, not budgeted). First draft 7,165 B, over the 6 KB budget until the counts table became two rows |
| `site/index.html` | 2,340,743 B at `9d1f7e2` (unchanged through WP-1, which nothing imported yet) → **2,359,990 B** at `c131314` |
| esbuild probe (WP-1) | `@atlas/proposal` main entry 16,039 B with no `YAMLParseError`; `./read` 105,305 B with it |

The rebuild's three greps, at `c131314`: `grep -c __ATLAS_PROPOSALS__ site/index.html` →
**1** (0 before); the control `grep -c from-state` → **0**; `grep -c YAMLParseError` →
**0**, so `yaml` did not reach the viewer. (`grep -c` counts lines and the bundle is one
line, so 1 is the most it can print.) `git status --short site/` after the build showed
only `M site/index.html`. Served by `vite preview` and opened from `file://` at
`#/?accounts=111111111111&proposal=new-spoke`, it draws acme-data, its region and data-vpc
marked added, with the bar and legend, and no console errors.

### The skill defects WP-6 found by running it

A fresh agent with no context followed `atlas-propose/SKILL.md` alone and wrote
`proposals/new-spoke.yaml`, clean on the first validate. Every place it had to guess was a
defect, fixed in the skill:

1. **Return path.** "443 from prod" needs a route back from prod; nothing said so, and a
   proposal without it still validated 0/0. The skill now says to design the whole path,
   and that the validator does not check whether traffic can flow.
2. **TGW route table.** Nothing said whether to set `associationRouteTableId` or change the
   TGW route table's associations, propagations and routes. Now it does.
3. **Route target.** Whether a `tgw` route's `targetId` is the TGW or the attachment id was
   unclear. It is the `tgw-` id.
4. **YAML type traps.** A numeric `transitGatewayOwnerId`, `protocol: -1` as a number and
   `fromPort: "443"` as a string all validated 0/0. The skill now spells out what to quote;
   the validator still does not type-check fields (follow-up below).
5. **Nested types.** `grep -A 14` truncated long types, and nested types (`Route`,
   `SecurityGroupRule`, `TransitGatewayRoute`…) were not mentioned. It now prints whole
   types with `sed` and says to follow every type a field names.
6. **`isMain`.** A new VPC's first route table is `isMain: true`.
7. **Organization and RAM membership.** The core TGW is shared by RAM to an OU the new
   account is not in. Out of scope unless asked; say what is needed in `description`.
8. **The `git status` expectation was too literal** (`?? proposals/`, and files dirty
   beforehand).
9. **No `git status` baseline.** It is now the first command.
10. **"prod" is ambiguous** (a eu-west-1 VPC and a us-east-1 DR VPC on another TGW). Prefer
    the same region and TGW, otherwise ask, and state the choice.

Three more came from writing it: `describe --json` holds no more ids than the markdown (the
skill ships a read-only query instead), the committed viewer could not show proposals until
this package, and `fixture` must be forbidden like `bundle`.

### The unplanned package, WP-5b

WP-5's hunt for "a `refId` that resolves in `byKey` is real" found two sites that were
wrong and sat in files WP-5 did not own. A **changed** resource's import block was built
from the *proposed* ref, so a changed security group offered `import` blocks for rules that
do not exist (`sg-0prodalb000000001_ingress_tcp_8443_…`, screenshotted); and
`applyTerraformBadges` gave `proposed-` nodes `tfManaged = false`, so planned resources
counted as *Unmanaged* in the Layers panel. Both are the not-fine case "The regression to
fear" asked to be named, so a seam package fixed them rather than leaving them as
follow-ups: `model/terraform.ts` skips `isProposedId` nodes, `DetailsPanel` takes a
`scannedRef` that `App.tsx`'s `detailsFor` fills for a changed resource, and
`terraform-badges.test.ts` (the 125th test) pins the first. It deleted `LayersPanel`'s
`changeState === 'added'` skip as superseded (a planned id now has no `tfManaged`) and too
broad (a *scanned* resource can be `added` to a focus graph through a planned route). With
no proposal the details panel's `outerHTML` is byte-identical before and after.

### What the plan said that turned out wrong

- **WP-1.** `ChangeSet.changed` cannot carry a viewer `kind` (that vocabulary lives in
  `viewer/src/data.ts`); entries carry account, region and collection instead, and
  `removedAccounts` was added. Diffing by id alone is wrong, because a shared resource has
  one id in several accounts' snapshots. Decision 47's "unresolvable reference is an error"
  needed a third bucket, an `unknown-reference` warning, for ids of kinds the scanner does
  not collect. The YAML must not carry its own `id:`.
- **WP-1b.** `validate.test.ts` asserted an empty rule registry, contradicting the package's
  goal. An SG reference across a same-region peering is legal in AWS and is exempt.
- **WP-2.** A counts table with a row per collection broke the 6 KB budget by itself.
  `describe` had to print more than decision 54 lists (subnets with CIDRs and AZs, each
  TGW's default route table) for an agent to design with.
- **WP-3.** An `AtlasIndex` holds fresh closures, so "deep-equal" is only possible on a
  plain-data projection. `App.tsx`'s focus-route regex captured the query string.
- **WP-4.** "The six classes" are three. The `outerHTML` method the brief cited is not in
  `ACCOUNT-PICKER.md`.
- **WP-5.** Terraform badges go on each side before the diff, not on the union. The
  decision-38 empty state must count the effective selection under a proposal. A focus view
  on an added centre must skip the scanned build, whose placeholder would read *changed*.
- **WP-5b.** The overview does not draw security groups; the check ran in the VPC view.
- **WP-6.** `npm run fixture` rewrites `data.js`, so it cannot be how `proposals.js` is
  regenerated; `propose bundle` is. `site/index.html` predated proposals, so step 5's URL did
  not work until WP-7.
- **WP-7.** The `.github/` correction was right: the one workflow audits the lock and runs
  no repo code. The root `npm run serve -- <flags>` passes nothing through (no trailing
  `--`); `--port 4199` became vite's root directory.

### Follow-ups

Shapes the fixtures avoid, from all eight hand-backs:

- **Proposal shapes never built:** a proposal that removes an account; a proposed resource
  inside a switched-off (ghost) account, which changes the ghost box's layout path; a new
  account reachable only through a TGW in an unselected account; a display cap firing on
  real data (decision 58 is modelled only by a hand-built graph); a change to an SG rule
  drawn as an edge label (the demo's route-table change does relabel prod's TGW edge, but
  no test pins a label); a proposal that adds and removes the same connection; any kind
  outside networking (an IAM role trusted by a proposed account, an S3 bucket in one).
- **Never exercised for real:** a stale base in the viewer (the badge was screenshotted only
  with injected props); two proposals in the committed checkout (WP-5 switched between two
  in a throwaway pass); `propose validate` with one good and one unparsable file through
  the CLI; a `proposals/` holding a subdirectory or a `*.yaml` symlink.
- **Apply and diff:** two proposals applied in sequence; `set` to `null`; a resource moving
  between collections; a duplicate id inside one scanned collection; YAML anchors and
  multi-document files; upper-case ids; applying to a `withAccounts` derivative (documented
  as wrong, unpinned); shared copies and `generic` resources in the data-index miniature.
- **Validator:** it does not type-check fields (WP-6 defect 4: a number where the schema
  says string passes); references left dangling by a `remove` are flagged only where
  `route-target` happens to look; references inside JSON-string fields (IAM policy
  documents) are not walked; `…Arns` (plural) is not a reference field.
- **Design rules:** IPv6 CIDRs; TGW route-table segmentation (an isolated pair on one TGW
  still warns); RAM-shared subnets or VPCs seen from a participant; prefix-list routes and
  the `carrier`, `localGateway`, `coreNetwork` and `other` target types; cross-region
  peering in `cidr-overlap`; `sg-rule-vpc` against a group in an unscanned account; the
  cost of `cidr-overlap`, which is n² per TGW.
- **Scale:** every timing is on the 181-resource fixture, not ~48k; **`describe` at 19
  accounts is unproven** (5,812 B for three does not show nineteen fit), and its caps never
  fire on the fixture.
- **`describe` content:** route tables and routes, IGW and NAT ids, SG ids and rules,
  endpoints, TGW route tables beyond the default, RAM shares, and which accounts are only
  referenced are all missing (the skill's query covers them); the counts table counts each
  account's copy of a shared resource; IPv6-only subnets, multi-CIDR VPCs, more than 8
  attachments, an org tree over 32 nodes, two organizations and hosted zones with more than
  8 associations are untested.
- **Viewer:** a **removed** resource's details panel still offers import blocks and a
  console link (truthful, pointless); choosing `none` while on `#/vpc/proposed-…` leaves a
  **blank canvas** with no message; **focus on a removed centre** keeps the placeholder, so
  neighbours that did not change read amber; in the VPC view a removed peering that routes
  still point at reads *changed*, not red; removed resources cannot be found by search while
  a proposal is active; the mode is not reset when switching proposals; the new account's
  header wraps ("acme-\ndata").
- **Code:** the `bundle.ts` ↔ `propose.ts` import cycle (harmless today; move
  `jsonScriptPayload` to its own module); `parseProposal`'s YAML syntax errors end with a
  dangling colon; the root `serve` script cannot take flags.
- **Out of scope by decision 56, and the natural next plan:** phase 3, generating Terraform
  from a proposal. `tf-import-blocks`' `ruleForKind` already maps kinds to types, and the
  `proposed-` prefix is how it would tell a planned resource from one to import. The new
  account's organization and RAM membership, which the demo notes in its description, would
  belong there too.
