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

`packages/scanner/src/fixture.ts` is the dev estate. It is fabricated and
tidy: two Terraform stacks with round numbers, no duplicate names, no
EC2-classic EIP, no resource whose region disagrees with its ARN. Any
acceptance criterion about collisions, malformed ids or cross-account
awkwardness **cannot be checked against it as shipped**. Make the agent build
the awkward case rather than accept the tidy one as sufficient.

This is the failure this repo keeps having: every fixture avoids some shape,
and that shape is where the defect lives.
