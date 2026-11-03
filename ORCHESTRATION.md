# Orchestration notes

Project-specific facts an orchestrator needs and cannot derive from a plan
document. Keep this current — it exists so the next orchestrator does not
relearn it expensively.

## The gate

```
npm install && npm run typecheck   # must be green across ALL four workspaces
npm test                            # 125 tests in 16 files after PROPOSAL-OVERLAY.md
```

**Run the gate yourself.** Agents report honestly and are occasionally wrong
about the wider repo.

- **No CI runs this repo's code.** There is one workflow,
  `.github/workflows/dependency-audit.yml`, and it is a dependency audit only:
  on Node 24 it runs `npm audit --json` against the committed lock — it
  installs nothing and runs no lifecycle scripts, typecheck or test — and fails
  when the report counts any high or critical vulnerability (or the audit feed
  itself fails), keeping the JSON report as an artifact for 30 days. It runs
  daily at 05:37 UTC, on manual dispatch, and on a pull request or a push to
  `main` that touches a `package.json`, a lockfile or the workflow itself. So a
  push that moves `package-lock.json` does produce a run worth watching, but
  nothing downstream ever compiles or tests a change: the local gate is the only
  gate for code. Verify before pushing.
- `npm run typecheck` runs `tsc -p tsconfig.json` per workspace via
  `--workspaces --if-present`.
- A wall of `TS2307: Cannot find module '@aws-sdk/client-*'` means a **stale
  install**, not a code defect. Run `npm install` and re-run. This has cost
  time more than once. The same remedy covers `TS2307: Cannot find module
  'tf-import-blocks'`, which has a second cause — that package is consumed from
  npm and ships its own `dist/`, so the error means the dependency is not
  installed rather than that anything in this repo is wrong.
- `tsconfig.base.json` sets `strict` **and `noUncheckedIndexedAccess`**. Tell
  agents up front; it changes how they write array and record access, and
  retrofitting it at the end is miserable.
- **The root `test` script must not rely on the runner expanding a glob.** It
  used to be `tsx --test "packages/*/test/**/*.test.ts"`; Node only learned to
  expand that itself in 22, so on the Node 20 this repo's `engines` promises to
  support it arrived as a literal path and the whole suite did not run. It is
  now a `find … -exec tsx --test {} +`, which discovers the same files on 20 and
  23 and still exits non-zero when a test fails. The failure mode of getting
  this wrong is **silence**, not redness — a sibling repo saw `# tests 0` with
  exit 0 — so anyone touching it should compare the discovered count before and
  after, and check that a deliberately failing test still turns the gate red.

## Workflow

- **Commit straight to `main`.** No feature branches, no PRs — confirmed
  preference, and a PR gets asked about.
- **No commit trailers.** No `Co-Authored-By`, no "Generated with", nothing.
- **The orchestrator pushes, not the agents.** Brief every agent with "commit,
  do not push". Push only after running the gate yourself.
- Never force-push.

## Commit voice

Subject `Area: what changed` in sentence case, then a blank line, then a
substantive body wrapped ~78 cols explaining **why** — the failure it fixes,
the evidence, what was verified. See `7cdb337` and `593cc41` for the register.
Bodies here are paragraphs, not bullet lists.

## Repo shape

**Four** npm workspaces under `packages/*` (the fourth arrived with
`PROPOSAL-OVERLAY.md`, 2026-11):

| package | name | notes |
| --- | --- | --- |
| `packages/schema` | `@atlas/schema` | snapshot types; the cleanest template for a new package's `package.json` / `tsconfig.json` |
| `packages/proposal` | `@atlas/proposal` | the proposal contract (`src/types.ts`), `applyProposal`, `diffSnapshots`, `validateProposal` and the networking design rules (`src/rules/`, one registry); pure TypeScript, no AWS SDK. Two entries: the main one is safe for the browser, `./read` is Node-only and the **only** module that imports `yaml` |
| `packages/scanner` | `@atlas/scanner` | AWS collectors + CLI (`src/cli.ts`); ~80 AWS SDK deps |
| `packages/viewer` | `@atlas/viewer` | React + Vite; consumes `@atlas/schema` as a workspace dep and `tf-import-blocks` from npm — two different precedents, pick the one that matches |

`tsx` is a scanner devDependency that npm hoists to root `node_modules/.bin`,
so root scripts can use it without a new dependency.

### The proposal overlay is a post-pass

Since `PROPOSAL-OVERLAY.md` the viewer can draw a planned change. It does not
draw it with new builder code: `App.tsx` calls the ordinary overview, VPC or
focus builder twice, once over the scanned index and once over the proposed one
(`model/proposal.ts`), and `model/diff.ts`'s `diffGraphs` unions the two graphs
**by node and edge id** and stamps `changeState` on what differs (decision 49).
The builders never learn a proposal exists. The consequence is the rule to keep:
**any new builder output must have a deterministic id derived from the
resource** (`vpc:<id>`, `edge:<key>` — never a counter, an index into an array
or anything that depends on what else was built). An id that differs between
two builds of the same resource makes the overlay draw it twice, once *added*
and once *removed*, and an id that collides hides a real change; neither fails
a test unless someone writes one. A builder that draws a placeholder for an
unknown key (`buildFocus` does) puts the same id on both sides and reads as
*changed*; `App.tsx` already special-cases the focus centre for this.

Each side is badged for Terraform from its own index *before* the diff, and the
no-proposal path is literally the old single build, which is how the "nothing
moves without a proposal" proofs stay byte-identical.

**`ChangeSet` and `ResourceRef` spell a global resource's region differently.**
`@atlas/proposal` uses `'global'` (the YAML's word, decision 44); the viewer's
`ResourceRef.region` is `''`. Never compare the two directly: look a change up
by id or arn through `indexChangeSet`, which needs no region at all.

### The overview is built from the selected accounts

Since `ACCOUNT-PICKER.md` (2026-11) `App.tsx` builds the overview from
`withAccounts(index, selected)`, a derived index whose `snapshot.accounts` is
filtered and whose `all`, `byKey` and `accountLabel` still span the estate.
`packages/viewer/src/model/selection.ts` **owns the account filter**: never add
a loop to `overview.ts` with a filter of its own — extend `selection.ts`. The
trap is the other way round. Any lookup in `overview.ts` that resolves a thing
*by account* (an owner, a target, a reverse grant) must either fall through to
`ensureGhostAccount`, or build its map from `index.all` rather than from
`index.snapshot.accounts`; otherwise it silently draws nothing, or draws a
switched-off account's resource inside a selected one. Nine sites had to be
fixed for exactly this (`b3835b3`, `5e4fdc4`: CloudFront→LB, S3 origin owner,
private zone→VPC, VPN→TGW, DX gateway and VIF→VGW, reverse trust, reverse RAM
share, DNS alias targets, reverse SSO grant) — they are the precedent, and the
cases in `test/selection.test.ts` are the pattern for pinning a new one.

### The published dependency

`tf-import-blocks` was `packages/tf-import-blocks` until 2026-08. It is now an
ordinary npm dependency of both the scanner and the viewer, pinned `^0.1.0`, and
its source and CI live in **its own repo**, `ralton-dev/tf-import-blocks`
(public, MIT, `main` protected, CI on Node 20 and 24). It is **not** in this
repo and must not come back: `packages/scanner/test/consumed-from-npm.test.ts`
fails the moment it resolves from inside `packages/`.

Consequences a cold orchestrator will otherwise hit:

- **A change to import-block behaviour is not a change to this repo.** It is a
  release there and a version bump here. No agent should be briefed to "fix the
  emitter" in this tree — there is nothing to fix in it.
- Its test suite travels with it. The golden-file assertion that used to be the
  regression signal is no longer run by `npm test` here; what remains is the
  consumed-from-npm pin, which asserts the CLI still reproduces
  `awkward.expected.tf` from this side of the boundary.
- Test fixtures are read out of the **installed** package
  (`resolver.resolve('tf-import-blocks/package.json')`, then `test/fixtures`) —
  it ships them for exactly this, and exports `./package.json` so the package
  root is nameable. Never reintroduce a path into `packages/`.
- `npm install` will **not** reconcile a lock that still carries the old
  workspace entries: it silently keeps `"resolved": "packages/tf-import-blocks",
  "link": true` and leaves a dead symlink in `node_modules`. The fix is to drop
  those entries from `package-lock.json` and reinstall. Check the lock records a
  registry tarball URL before believing an install did what you asked.

## Verifying Terraform import IDs

Provider docs, raw, verified reachable:

```
https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/main/website/docs/r/<type_sans_aws_prefix>.html.markdown
```

The import section is at the bottom of each page. **Require agents to fetch
it** for any id that is not plainly the AWS-native id — a wrong import id
compiles, renders, copies to the clipboard, and fails hours later inside
someone else's `terraform plan`, or worse succeeds against the wrong resource.

## Subagents

- Editing subagents spawned from a **background job** land in the shared `main`
  checkout and the write-guard blocks Write/Edit. Pass `isolation: "worktree"`
  in that case. From an **interactive** session this has not been a problem.
- Prefer the shared checkout when you can: a git worktree here has no
  `node_modules`, and `npm install` against the scanner's dependency tree is
  slow enough to dominate a small package's runtime. When a package does need
  its own worktree — in `PROPOSAL-OVERLAY.md` one served a browser from a dev
  build while another package needed a different `site/data/proposals.js` in
  the main checkout — `cp -c -R node_modules <worktree>/` (an APFS clone, near
  instant) gives it a working install. It works because npm's workspace links
  in `node_modules/@atlas/*` are **relative** symlinks, so in the copy they
  resolve to the worktree's own `packages/`, not the main checkout's.
- **Several agents in one checkout commit with a pathspec**: `git add <paths>`
  then `git commit -m "…" -- <paths>`. A bare `git commit` takes everything
  staged, including another agent's files staged a second earlier; the pathspec
  form commits only the named paths whatever else is in the index. Four agents
  shared the checkout in wave 2 of `PROPOSAL-OVERLAY.md` this way with no
  swept file. (One agent's first attempt staged nothing because zsh does not
  word-split an unquoted `$P`; spell the paths out.)
- Agents get killed by silence, almost always during a long final
  verification. Put in every brief: emit output between steps, don't run the
  full suite more than twice in a row, **commit before the long final pass**.
  A killed agent has lost nothing — resume it with `SendMessage` scoped to
  "commit what you have and report". Do not respawn it.

## Fixtures — the standing weakness

`packages/scanner/src/fixture.ts` is the dev estate, and it is fabricated.
Historically it was tidy in exactly the ways real estates are not, so any
acceptance criterion about collisions or malformed ids could not be checked
against it. The import-blocks plan (2026-08) fixed part of that: it now
carries an unmanaged SQS queue, **two unmanaged ECS services both named
`web`** (clusters built as `` `dev-${colour}` `` — grep for the literal
`dev-blue` and you will wrongly conclude it is absent), two `default`
security groups across two VPCs, and an unmanaged no-rule `generic` resource.

The habit that matters is unchanged: **make the agent build the awkward case
rather than accept the tidy one as sufficient**, and have it say which shapes
its fixture still avoids. Every fixture avoids some shape, and that shape is
where the defect lives. In this plan every package that found a serious bug
found it by refusing to test only against the fixture — the state parser's
worst defect surfaced only against a hand-built state with provider aliases,
a deposed instance and a legacy flatmap resource.

**2026-11-03, the account picker.** The plan pointed the hunt for "the index I
was handed is the whole estate" at a few named helpers; it found more than the
plan named — nine lookup sites, fixed in two unplanned packages. The pattern that kept it safe: a
new branch runs only when the selection left accounts out (gated on
`b.omitted`), so the show-all build cannot move — prove it by hashing
`JSON.stringify(buildOverview(index))` on `HEAD:site/data/data.js` before and
after. Two more things it learned. A ghost account box holding only leaves is
grid-packed by `layout.ts`, which drops any edge between them as a self-loop;
a container that must keep its internal edges has to be marked for ELK, as
`addAccountId` ghosts now are. And a fresh `npm install` with current npm
rewrites `package-lock.json` with `"peer": true` markers — that is noise from
the npm version, not a plan change; do not stage it with a package's work.

## Never run `npm run bundle` here

This checkout has **no `data/` directory** — the demo estate exists only as the
committed `site/data/*.js`. `npm run bundle` rebuilds `site/data/` from
`data/accounts/*.json`, finds none (`readAccountSnapshots` returns `[]` for a
missing directory), and overwrites `data.js` with an estate of zero accounts,
without an error. The safe commands are `npm run fixture`, which regenerates the
whole demo (all four files, byte-identical apart from `proposals.js`
following `proposals/`), and `npm run propose -- bundle`, which writes
`site/data/proposals.js` and nothing else. Brief every agent with this, and treat
a `site/data/data.js` line in `git status` that nobody meant as a stop. The
`atlas-propose` skill forbids `bundle`, `scan`, `fixture` and `build` outright.

## Committed build artifacts

`site/index.html` is a **committed build output** bundling the viewer *and*, from
the installed `tf-import-blocks` dependency, `dist/emit.js` and
`dist/rules/registry.js` (`dist/from-state.js` is tree-shaken out). Those last
two now come from `node_modules/`, not from `packages/` — so a bundled source
can change without a single file in this repo changing, simply by the dependency
moving. Any package that changes a bundled source leaves it stale, and no
package naturally owns rebuilding it — assign the rebuild to the **last**
package in the wave and verify it took.

The minified diff is unreadable, so do not eyeball it. Grep the bundle for a
string that only exists after the change, and grep for a string from a
tree-shaken module as a control that the rebuild did not quietly pull in more
than expected. A logic-only change with no new strings is not grep-provable —
say so rather than claiming a probe you do not have. Since the proposal overlay
there is a standing third control: `grep -c YAMLParseError site/index.html`
must be 0, proving the `yaml` package behind `@atlas/proposal/read` stayed out
of the viewer. Do not grep for the bare string `yaml` — it is already in the
bundle for unrelated reasons.

To look at the built file over http, run `npx vite preview --open false --port
<n>` from `packages/viewer`. The root `npm run serve` script has no trailing
`--`, so `npm run serve -- --port 4199` hands vite `4199` as its root directory
and every page 404s; and `vite.config.ts` sets `preview.open`, so without
`--open false` it opens a browser on the user's desktop.

## The frozen files, and when the freeze expired

`packages/scanner/src/terraform.ts`, `packages/viewer/src/model/terraform.ts`,
`packages/viewer/src/data.ts` and `packages/schema/**` were held at a zero-line
diff across `TERRAFORM-IMPORT-BLOCKS.md` (fifteen packages) as that plan's
stated regression signal. The reason was specific: it was building a *parallel*
path and did not want the existing one disturbed.

**That freeze expired with the plan.** On 2026-08-08 `scanner/src/terraform.ts`
was edited deliberately, with the user's explicit go-ahead, to fix the
match-report defect below. A future orchestrator should treat a diff there as
worth questioning — not as an automatic regression. The freeze that still
stands unconditionally is `packages/schema/**` and `packages/viewer/src/data.ts`,
which no package has owned across two plans.

## A signal that only works one way

Deriving "is this terraform type indexed by the scanner?" from whether its
registry rule declares `kinds` is sound **forwards only**. All 136 rules that
declare `kinds` declare ones `viewer/src/data.ts` really indexes — zero
orphans. The converse is false: `RegionSnapshot.generic` is an ARN sweep over
Resource Groups Tagging and Cloud Control, so `aws_ecs_cluster` and many others
land in the key set with **no** `kinds` at all. Reading "no kinds" as "never
indexed" files a genuinely stale resource under "expected, not drift" — a
confidently wrong answer in place of a merely unhelpful one.

The general lesson, which this project keeps relearning: when a classifier
cannot tell, a third "cannot tell" bucket beats a wrong binary. The same
instinct produced decision 5 of the import-blocks plan.

## Seams worth designing before you fan out

The one that cost the most here: a rule keyed by a single `type` string could
not express an atlas kind that maps to several terraform types depending on a
collected field. Two agents hit it independently in the same wave and
mitigated it in **opposite** directions — one emitted a confidently wrong
type, one emitted none. Neither was wrong to; the seam was.

When several agents build against one interface concurrently, they cannot
renegotiate it. Ask the package that defines it to write its doc comment
*aimed at* the packages that will implement against it, and expect to spend a
serial package fixing the seam once real rules have exercised it.
