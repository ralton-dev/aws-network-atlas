# Orchestration notes

Project-specific facts an orchestrator needs and cannot derive from a plan
document. Keep this current — it exists so the next orchestrator does not
relearn it expensively.

## The gate

```
npm install && npm run typecheck   # must be green across ALL workspaces
npm test                            # once a test script exists
```

**Run the gate yourself.** Agents report honestly and are occasionally wrong
about the wider repo.

- **There is no CI in this repo.** No `.github/` at all. There is no run to
  watch, no conclusion to read. The local gate is the only gate — which means
  a bad push is not caught by anything downstream. Verify before pushing.
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

**Three** npm workspaces under `packages/*` — there is no fourth:

| package | name | notes |
| --- | --- | --- |
| `packages/schema` | `@atlas/schema` | snapshot types; the cleanest template for a new package's `package.json` / `tsconfig.json` |
| `packages/scanner` | `@atlas/scanner` | AWS collectors + CLI (`src/cli.ts`); ~80 AWS SDK deps |
| `packages/viewer` | `@atlas/viewer` | React + Vite; consumes `@atlas/schema` as a workspace dep and `tf-import-blocks` from npm — two different precedents, pick the one that matches |

`tsx` is a scanner devDependency that npm hoists to root `node_modules/.bin`,
so root scripts can use it without a new dependency.

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
  slow enough to dominate a small package's runtime.
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
say so rather than claiming a probe you do not have.

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
