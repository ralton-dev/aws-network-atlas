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
  time more than once.
- `tsconfig.base.json` sets `strict` **and `noUncheckedIndexedAccess`**. Tell
  agents up front; it changes how they write array and record access, and
  retrofitting it at the end is miserable.

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

npm workspaces under `packages/*`:

| package | name | notes |
| --- | --- | --- |
| `packages/schema` | `@atlas/schema` | snapshot types; the cleanest template for a new package's `package.json` / `tsconfig.json` |
| `packages/scanner` | `@atlas/scanner` | AWS collectors + CLI (`src/cli.ts`); ~80 AWS SDK deps |
| `packages/viewer` | `@atlas/viewer` | React + Vite; consumes `@atlas/schema` as a workspace dep — follow that precedent for any new workspace dep |

`tsx` is a scanner devDependency that npm hoists to root `node_modules/.bin`,
so root scripts can use it without a new dependency.

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

`site/index.html` is a **committed build output** bundling the viewer *and*
`packages/tf-import-blocks/src/emit.ts` and `rules/registry.ts`
(`from-state.ts` is tree-shaken out). Any package that changes a bundled
source leaves it stale, and no package naturally owns rebuilding it — assign
the rebuild to the **last** package in the wave and verify it took.

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
