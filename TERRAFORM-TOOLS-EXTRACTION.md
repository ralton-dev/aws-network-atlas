# Extracting `tf-import-blocks` into its own repository

Base commit as written: `06648fa` — tree clean, typecheck green across four
workspaces, `npm test` 278 passing. **Orchestration began sixteen commits
later, at `90c8cfe`**, where the gate is 298 passing / 0 failing / 0 todo. See
amendment 31; the title and destination changed too, see amendment 27.

This plan follows `TERRAFORM-IMPORT-BLOCKS.md`, which is **complete**. Its
decisions 1–14 still bind; decisions here are numbered from **15** and carry
forward the ones that matter. Read `ORCHESTRATION.md` first — its gate, its
commit voice and its standing lessons apply unchanged inside this repo, and
partly do not apply in the new one (decision 21).

---

## The state, and why it is a defect

Decision 1 of the previous plan said the package was to be liftable by
`git mv` plus a `package.json`. That claim is **half true**, and the half that
is false is the whole job.

| claim | check | verdict |
| --- | --- | --- |
| No `@atlas/*` imports | `grep -rn "@atlas/" src/` → 2 hits, both doc comments *about* not importing | ✅ true |
| No third-party imports at all | `grep -rhoE "from '[^.][^']*'" src/` → **empty** | ✅ true |
| Zero runtime dependencies | `package.json` `dependencies` absent | ✅ true |
| Consumable outside the monorepo | `"exports": { ".": "./src/index.ts" }`, `"private": true` | ❌ **false** |

The package exports **raw TypeScript**. That works today only because npm
workspaces symlink it into `node_modules` and both consumers happen to compile
TypeScript themselves — the scanner through `tsx`, the viewer through Vite. An
installed dependency gets neither. `tsconfig.base.json` sets `noEmit: true`, so
there is not merely no build output; there is no build *configuration*.

So the package is architecturally free and mechanically stuck.

**The second defect is smaller and worth naming now**, because it makes the
first one dangerous: **nothing has ever consumed this package as a built
artifact.** All 278 tests run against raw source through `tsx`. The build this
plan introduces is the single least-exercised thing in the entire codebase on
the day it ships.

---

## The reframing

**A workspace sibling and a published dependency are different artifacts, and
only one of them has ever been tested.**

Everything falls out of that. The build is not a packaging chore at the end;
it is the risk, so it goes first, lands *in this repo*, and is proved against
both real consumers **before** a single file moves. The move itself is then
mechanical.

---

## Decisions — taken, do not relitigate

Continuing the numbering from `TERRAFORM-IMPORT-BLOCKS.md`.

15. **The build lands in `aws-network-atlas` first, before anything moves.**
    Introduce the emit config, build `dist/`, repoint `exports` at it, and
    prove both consumers and all 278 tests work against the built artifact
    while the package is still a workspace sibling. A build defect then
    surfaces against a full test suite and a working viewer, not in a fresh
    repo with no history and no CI. This ordering is the plan's main risk
    control and is not to be "simplified" by doing the build after the move.
16. **New repo `ralton-dev/terraform-tools`**, public, MIT (Copyright Ben
    Ralton, matching this repo's `LICENSE` verbatim), **monorepo layout**
    (`packages/tf-import-blocks`) so a second tool lands beside it without
    restructuring.
17. **Published to public npm as `tf-import-blocks`**, unscoped. Verified free
    on 2026-08-08: the registry returns 404 for both `tf-import-blocks` and
    `terraform-import-blocks`. **npm publish is effectively permanent** —
    unpublishing is unrestricted only within 72 hours, and after that requires
    no dependents, negligible downloads and sole ownership. Treat it as
    irreversible (decision 24).
18. **Starting version `0.1.0`, not `1.0.0`.** The public API changed twice
    during the previous plan alone — WP-I added `typeFromScanned`, WP-M added
    `expand` and `ResolvedImport.commentedOut`. It is demonstrably not stable,
    and `0.x` says so honestly while letting breaking changes land without
    major bumps. Matches the current `package.json`.
19. **Git history is preserved** via `git subtree split`. The commit bodies are
    the audit trail for a rule table built from ~250 provider doc pages — they
    record which page each id format came from, that
    `aws_security_group_rule` carries a deprecation *and* a conflict warning,
    and WP-J's before/after evidence for four state-parser bugs. A squashed
    import throws that away and it cannot be reconstructed.
20. **No `bin` entry, and no CLI in this plan.** `npx tf-import-blocks
    state.tfstate` is desirable and is the obvious *second* package in
    `terraform-tools` — but today the CLI is `packages/scanner/src/tf-blocks.ts`
    plus `cli.ts`, entangled with the scanner's argument parsing and help text,
    and it is not moving. Extracting it is its own plan. **Do not design
    anything here that blocks it**, and do not half-do it.
21. **The new repo requires pull requests; this repo does not.** Replicate the
    protection read off `aws-network-atlas` on 2026-08-08 — classic branch
    protection, not a ruleset: 1 approving review, `dismiss_stale_reviews`,
    `required_conversation_resolution`, force-pushes and deletions blocked,
    **`enforce_admins: false`**. That last flag is why direct pushes here
    succeed with a "Bypassed rule violations" notice. `ORCHESTRATION.md`'s
    "commit straight to main, no PRs" rule is **scoped to this repo** and does
    not travel.
22. **The new repo gets CI; this one still has none.** `aws-network-atlas` has
    no `.github/` at all. A public repo whose protection requires review needs
    at least typecheck + test on pull request, or the protection is theatre.
23. **`aws-network-atlas` consumes `^0.1.0` and deletes its local copy in the
    same commit.** Caret, not an exact pin: on `0.x` a caret already means
    `>=0.1.0 <0.2.0`, which is tight, and `package-lock.json` supplies exact
    reproducibility. Two copies must never both exist on `main` — that is the
    superseding rule below, and it is what stops them drifting.
24. **Three steps are outward-facing and need Ben.** Creating the GitHub repo,
    applying branch protection, and `npm publish`. An agent may *prepare*
    each — write the workflow, draft the `gh` commands, get the package to the
    point where `npm pack` is clean — but **must not execute them**, and must
    say plainly what it has left for a human. Publishing is irreversible;
    creating a public repo puts code under an org name permanently enough to
    matter.
25. **Attribution for the provider docs.** The rule table's id formats were
    derived from `hashicorp/terraform-provider-aws`, which is **MPL-2.0,
    Copyright IBM Corp. 2014–2026** — *not* BUSL; that relicense hit Terraform
    core, not the providers. No provider source is copied and the emitted
    strings are paraphrases, so there is no licence conflict with MIT (MPL-2.0
    is file-level copyleft and §3.3 permits a Larger Work under other terms).
    A `NOTICE` and a README section stating the provenance is honest and
    costs nothing. This is attribution, not a licence obligation — do not
    relicense anything.
26. **The design decisions travel with the package.** They are referenced 52
    times from inside it and defined only in a root document that stays behind.
    WP-4 copies them into the package README, numbered to match so no in-code
    reference needs editing. This is not documentation polish — one of those
    pointers is already dangling and the package has not even moved yet.

---

## Amendments — 2026-08-08, from Ben, after the plan was written

These **supersede** the decisions they name. Where an amendment and an earlier
decision disagree, the amendment wins. The rest of the plan stands.

27. **Its own repository, not a `terraform-tools` monorepo. Supersedes 16.**
    The new repo is `ralton-dev/tf-import-blocks` — public, MIT, and it holds
    exactly one package **at the repository root**. No `packages/` directory, no
    workspaces array, no root-vs-package `package.json` split: `src/`, `test/`,
    `package.json`, `tsconfig.json`, `LICENSE`, `NOTICE`, `README.md` all sit at
    the top level. This makes WP-2 *simpler*, not harder —
    `git subtree split --prefix=packages/tf-import-blocks` already produces a
    history whose tree root is the package, so the restructure step decision 16
    required is deleted rather than rewritten. The repo name matches the npm
    name deliberately. A second tool later gets its own repo too.
28. **Publishing happens in CI, not on a laptop. Supersedes the "no publish
    workflow" sentence of decisions 20 and 24.** Ben's reasoning, and it is
    right: a local `npm publish` is an unreproducible artifact built from
    whatever happened to be in one working tree. WP-3 therefore ships a release
    workflow that publishes on a version tag, from a clean `npm ci` checkout,
    after the same gate a pull request runs. Nothing publishes on a push to
    `main`.
29. **Repo creation and branch protection are no longer Ben's. Supersedes 24.**
    The orchestrator creates `ralton-dev/tf-import-blocks`, pushes the split
    history, and applies the decision-21 protection. Decision 24's caution was
    about irreversibility, and that caution now attaches to exactly one thing:
    **the npm credential**. Creating a repo is reversible; publishing a version
    is not.
30. **The one remaining human step is the npm credential.** Publishing from CI
    needs either an npm automation token stored as a repository secret or a
    trusted-publisher (OIDC) configuration on npmjs.com. Both require npm
    account access no agent has. An agent **prepares** the workflow and writes
    down the exact steps; it must never ask for, echo, or store a token value.
    The first release tag is pushed only once Ben confirms the credential is in
    place.
31. **The plan's test count has drifted; do not trust it.** The plan says 278
    tests against base `06648fa`. Sixteen commits later, at `90c8cfe`, the gate
    is **298 passing / 0 failing / 0 todo**. Every "all 278 tests" acceptance
    criterion means "every test that passes today, and no regression". Read the
    number from `npm test`, not from this document — a worked example of the
    standing rule immediately below.

---

## Standing rules

- **Deletion belongs to the package that supersedes.** WP-6 deletes
  `packages/tf-import-blocks/` in the same commit that adds the npm
  dependency. A red build from that deletion is a *result* — it inventories
  the consumers better than grep. Report per symbol: deleted, or kept with the
  name of whoever still calls it.
- **Every `file:line` in this document is a hint that has already drifted or
  will.** Grep for the symbol, confirm it says what this plan claims, and
  report the drift rather than quietly working around it.
- **Verification gate inside `aws-network-atlas`:** `npm install && npm run
  typecheck` green across every workspace, `npm test` green with **0 todo**,
  `npm run build` succeeding. A package that cannot make the gate green
  reports why rather than weakening the gate.
- **`test/golden.test.ts` must stay a plain passing assertion throughout.** It
  is the previous plan's definition of done and it travels with the package.
  If it goes red at any point in this plan, stop — something about the build
  or the move has changed behaviour, which is the exact thing being guarded
  against.
- Inside this repo: commit straight to `main`, no PRs, no commit trailers,
  subject `Area: what changed` plus a substantive body on *why*, wrapped ~78
  cols. In the new repo: PRs, per decision 21.

---

## The red pin

`packages/scanner/test/consumed-from-npm.test.ts`, created by **WP-1** and
flipped by **WP-6**.

It asserts two things that are jointly true only when the extraction is
complete:

1. **The package resolves outside the source tree.**
   `fs.realpathSync(require.resolve('tf-import-blocks'))` must not be under
   `<repo>/packages/`. Today npm workspaces symlink `node_modules/tf-import-blocks`
   straight back to `packages/tf-import-blocks`, so the realpath *is* under
   `packages/` and this fails. **Resolve the realpath — a naive
   `require.resolve` sees `node_modules/…` and passes for the wrong reason.**
2. **The CLI still reproduces the golden**, byte-for-byte against
   `awkward.expected.tf` after `##` annotation stripping — i.e. consuming the
   package as a dependency changed nothing observable.

Land it under `{ todo: true }` so `npm test` keeps exiting 0 while the split
is in flight, with the observed failure recorded in a comment inside the test.
**WP-6 removes `{ todo: true }`.** When that passes as a plain assertion, the
extraction is done. There is no other definition.

The pin lives in `packages/scanner/test/` deliberately: it must survive the
deletion of `packages/tf-import-blocks/`, so it cannot live inside it.

---

## WP-1 · The build, in place, and the pin

**Goal:** `packages/tf-import-blocks` emits JavaScript and type declarations,
both consumers use the built artifact, and a failing test states what "fully
extracted" means.

- Give the package its own emit configuration. `tsconfig.base.json` sets
  `noEmit: true`, so overriding it is the point — a separate
  `tsconfig.build.json` is cleaner than mutating the shared base, which the
  other three workspaces depend on.
- Emit **ESM only**, `"type": "module"` (already set), target ES2022 to match
  `tsconfig.base.json`, `declaration: true`, `declarationMap` and `sourceMap`
  on so a consumer can step into it.
- Repoint `exports` from `./src/index.ts` to the built entry with a `types`
  condition. Keep `private: true` **for now** — WP-4 flips it, and an
  accidental publish from this repo is exactly the irreversible mistake
  decision 24 guards against.
- Add `files`, and verify with `npm pack --dry-run` that the tarball contains
  `dist/` **and** `test/fixtures/` if the golden travels — decide deliberately
  whether fixtures ship to consumers or only live in the repo, and say which.
- Add a `build` script and wire it into whatever must run before typecheck.
  **The consumers must not silently fall back to source**: prove the built
  artifact is what they load, do not assume it.
- Create the red pin described above.

**Acceptance:** `npm run build` produces `dist/index.js` + `dist/index.d.ts`;
all 278 existing tests still pass with **0 todo** other than the new pin;
`npm run typecheck` green ×4; `npm run build` (the viewer bundle) succeeds and
`site/index.html` still contains the emitter's strings; the scanner CLI
reproduces the golden. `npm pack --dry-run` lists exactly the intended files
and nothing else — no `src/*.ts` leaking unless deliberate, no `node_modules`.
The pin fails as a TODO naming both assertions.

Owns: `packages/tf-import-blocks/package.json`, `tsconfig.json`,
`tsconfig.build.json` (new), `.gitignore` if `dist/` needs ignoring,
`packages/scanner/test/consumed-from-npm.test.ts` (new), root `package.json`
(build wiring only).
Size **L**. Depends: none.

---

## WP-2 · History split and the new repo, prepared but not created

**Goal:** a branch containing only the package's history, restructured for the
new repo, ready for a human to push.

- `git subtree split --prefix=packages/tf-import-blocks` to produce a branch
  whose history is only the package's commits. **Verify the result**: the
  commit count, that the bodies survived intact (spot-check WP-J's before/after
  evidence and WP-M's deprecation finding), and that no `@atlas` file came
  along.
- **No restructure (decision 27).** The split branch's tree root is already the
  package, which is exactly the layout the new repo wants. What it is missing is
  everything `tsconfig.base.json` used to supply from two directories up: fold
  the base compiler options into the package's own `tsconfig.json` (`strict`,
  `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`,
  `forceConsistentCasingInFileNames`, `skipLibCheck`, `esModuleInterop`,
  `resolveJsonModule`, `isolatedModules`, ES2022 target and lib) and drop the
  `extends`. **A missing `noUncheckedIndexedAccess` is the failure to fear
  here** — it silently *weakens* typechecking, so everything still compiles and
  the loss is invisible. Prove it is on by asserting a known indexed access
  still errors, not by reading the config back.
- Add `.gitignore`, `LICENSE` (copied verbatim from this repo), `NOTICE`
  (decision 25) and the README. There is no root `package.json` and no
  workspaces array — the package's own `package.json` is the repo's.
- The new repo needs its **own test invocation**. This repo's is
  `tsx --test "packages/*/test/**/*.test.ts"` in the root `package.json`, and
  `tsx` is hoisted there from the *scanner's* devDependencies — a dependency
  that does not exist in the new repo. **`tsx` must become an explicit
  devDependency there**, as must `typescript` and `@types/node`. The glob
  becomes `test/**/*.test.ts`. Re-verify that a `{ todo: true }` failing
  assertion still exits 0 under whatever invocation you ship; the previous plan
  records two plausible invocations that break this.
- **Do not create the GitHub repo and do not push.** Not because a human must
  (decision 29 moved that to the orchestrator) but because WP-3 and WP-4 have
  not run yet: the branch is incomplete until CI and the publish metadata land
  on it. WP-5 pushes. Leave the branch local and named, and say what it is
  called.

**Acceptance:** a local branch that `npm install && npm test` passes on
**standalone**, outside the workspace, with all the package's tests green and
the golden a plain passing assertion. History contains the package's commits
with bodies intact and nothing from the scanner, viewer or schema. Nothing is
pushed and no GitHub repo is created — WP-5 does that once WP-3 and WP-4 have
landed on the branch.

Owns: nothing in `main`'s working tree. This package works on a split branch
checked out at **`/Users/benralton/repos/BEN_WORKING/tf-import-blocks/`** — a
sibling of this repo, and where the new repo lives permanently, rather than a
scratch directory that gets discarded. Ben asked for that explicitly on
2026-08-08: only WP-1 and WP-6 have any business inside `aws-network-atlas`,
and the plan read as though all five waves did. It must not modify
`packages/tf-import-blocks/` on `main`.
Size **M**. Depends: WP-1.

---

## WP-3 · CI for the new repo

**Goal:** the new repo's protection is enforced by something real.

- A GitHub Actions workflow running `npm ci`, `npm run typecheck`, `npm test`
  and `npm run build` on pull request and on push to `main`.
- Node version matching the engines field (decision: `>=20`, matching this
  repo's root `package.json`; the local toolchain is Node 23).
- **This repo has no CI to copy from**, so there is no house style to match —
  keep it minimal and readable rather than elaborate.
- **Also ship a release workflow (decision 28).** It publishes to npm on a
  version tag (`v*`), never on a push to `main`, and only after running the same
  gate the pull-request workflow runs — a tag that fails typecheck or tests must
  not reach the registry. Use `npm ci`, not `npm install`, and publish the
  package built in that job rather than anything committed.
- **The credential is not yours to create (decision 30).** Design for whichever
  of the two mechanisms you judge correct — an `NPM_TOKEN` repository secret, or
  npm's OIDC trusted publishing — and **check the current state of trusted
  publishing before choosing**, including whether it can be configured for a
  package that does not exist on the registry yet, and what npm CLI version the
  runner needs (the local CLI is 10.9.2, which predates it). Report the exact
  steps Ben must take, and never ask for or echo a token value. If you pick
  OIDC, `id-token: write` permission and a modern npm on the runner are load
  bearing — say so.
- Add `--provenance` only if the chosen mechanism actually supports it; a
  provenance flag with the wrong auth mode fails the publish rather than
  degrading.
- **Routed from WP-1 — the trap most likely to bite here.** `dist/` is
  gitignored and rebuilt by a `prepare` script. WP-1 verified `prepare` fires on
  `npm install` **for a workspace package**; it did not verify `npm ci` fires it
  for a **root** package, which is what `tf-import-blocks` becomes in the new
  repo (decision 27). Different code path. If it does not fire, CI runs `npm
  test` against a missing `dist/` and every consumer-facing test fails with
  `TS2307: Cannot find module 'tf-import-blocks'`. Either prove it fires, or —
  better — run `npm run build` as an explicit step before typecheck and test, so
  the workflow does not depend on the answer at all.

**Acceptance:** the workflow file is syntactically valid (`actionlint` or
equivalent) and its steps are exactly the gate this project already uses. It
cannot be run until the repo exists, so **do not claim it passes** — state
that it is unexercised and that WP-5 is where it first runs.

Owns: `.github/workflows/` on WP-2's split branch — both the pull-request gate
and the release workflow.
Size **M**. Depends: WP-2.

---

## WP-4 · Publish preparation

**Goal:** `npm publish` is a single command a human can run with confidence.

- Flip `private: true` → `false`, set `version` to `0.1.0` (decision 18), add
  `repository`, `homepage`, `bugs`, `keywords`, `license: MIT`, `author`, and
  `engines`.
- `publishConfig.access: "public"` — an unscoped package does not strictly
  need it, but it is explicit and harmless.
- Add the README section and `NOTICE` of decision 25.
- **Routed from WP-1: the package has no `LICENSE` file of its own.** WP-1's
  `npm pack --dry-run` shows 52 files and not one of them is a licence — the
  MIT text lives only at this repo's root, which does not travel. Declaring
  `license: MIT` in `package.json` while shipping no licence text is the exact
  gap to close, and it is WP-4's, not WP-2's, because it is a publish concern.
- **Routed from WP-1: the package README has no install or build section at
  all**, and `packages/tf-import-blocks/README.md:517` documents `npm test` as
  `tsx --test "packages/*/test/**/*.test.ts"` run "from the repo root", which
  is this repo's invocation and does not travel either.
- **Carry the design decisions into the package README** (decision 26). Measured
  on 2026-08-08: the package contains **52 references to 9 distinct decisions**
  (8, 5, 9, 6, 3, 10, 14, 11, 13) across `src/`, `test/` and its own README —
  and the package README defines **none** of them. They live in
  `TERRAFORM-IMPORT-BLOCKS.md` at *this* repo's root, which does not travel.
  `packages/tf-import-blocks/README.md:491` ("escaped where decision 9 covers
  them") is therefore **a dangling pointer already**, in the file a new reader
  starts from. Add a "Design decisions" section numbered to match, so all 52
  in-code references resolve without editing one of them. Decisions **3** and
  **5** matter most at the point of use — 3 is why every id was read off the
  `id = "…"` block rather than the `identity = { … }` form the provider docs now
  print first, and 5 is why a guard returns `undefined` and earns a `# VERIFY`
  rather than a plausible wrong answer. A contributor who cannot resolve those
  two may well "fix" a guard into a passthrough, which is the precise defect
  this package exists to prevent.
- **Verify the tarball, not the intent**: `npm pack`, extract it into a scratch
  directory, `npm install` it into a throwaway project, and `import` from it —
  proving the `exports` map, the `.d.ts` and the ESM resolution all work from
  outside. This is the only test in the plan that exercises the artifact the
  way a stranger will.
- **Do not run `npm publish`** — not even `--dry-run` against the network with
  credentials. Publishing is CI's job now (decision 28); WP-4's job is to make
  the artifact correct so that when CI publishes it, it is right the first time.
  `npm publish --dry-run` locally is fine and expected: it reports the file list
  without contacting the registry.

**Acceptance:** a packed tarball installs into a clean project outside this
repo and `import { emitBlocks } from 'tf-import-blocks'` resolves, typechecks
and runs. `npm publish --dry-run` reports the intended file list and version
`0.1.0`. Nothing is published.

Owns: `package.json`, `README.md`, `NOTICE` at the **root** of WP-2's split
branch (decision 27 — there is no `packages/` directory there).
Size **M**. Depends: WP-2.

---

## WP-5 · Create, protect, release

**Goal:** the repo exists, is protected, CI is green, and `0.1.0` is on npm.

**The orchestrator runs this, not an agent and not Ben** (decision 29) — it is
the one package that acts on the world, and it is ordered so that each step is
verified before the next becomes possible.

1. `gh repo create ralton-dev/tf-import-blocks --public` and push WP-2's branch
   to `main`. **Push before protecting**, so the first push is not fighting a
   rule it would have to bypass.
2. Watch CI's first run to a **conclusion**, per job, by run id. This is the
   first time WP-3's workflow has ever executed; treat a failure here as
   expected work, not as a surprise. Fix forward on `main` before protection
   lands, because after it lands every fix is a pull request.
3. Apply the decision-21 protection, then **verify it by reading it back** from
   the API rather than trusting the write's exit code.
4. **Stop and confirm the npm credential with Ben** (decision 30). Only then
   push the `v0.1.0` tag that triggers the release workflow.
5. Confirm the published artifact from the outside: `npm view tf-import-blocks
   version` and a fresh `npm install tf-import-blocks` in a scratch directory.

**Acceptance:** `npm view tf-import-blocks version` returns `0.1.0`; the CI of
WP-3 has run at least once and is green; branch protection reads back with 1
required review, `dismiss_stale_reviews`, `required_conversation_resolution`,
force-pushes and deletions blocked, `enforce_admins: false`.

Owns: nothing in this repo.
Size **M**. Depends: WP-3, WP-4.

---

## WP-6 · Consume from npm, delete the copy, flip the pin

**Goal:** `aws-network-atlas` depends on the published package and no longer
contains it.

- Change `"tf-import-blocks": "*"` to `"^0.1.0"` in **both**
  `packages/scanner/package.json` and `packages/viewer/package.json`, remove
  the workspace entry if one is needed, and `npm install` so the lock file
  records the registry resolution rather than a symlink.
- **Delete `packages/tf-import-blocks/` entirely, in the same commit**
  (standing rule). Report per symbol what the consumers still import — the
  scanner takes `emitBlocks`, `parseStateFile`, `resolveStateResource`,
  `ruleForType` and the `ResolvedImport` type; the viewer takes
  `contextComment`, `dedupeAddresses`, `emitBlock`, `resolveScannedExpanded`
  and more (**grep `packages/viewer/src/model/tf-import.ts`, do not trust this
  list**). Anything the published `exports` does not surface is a defect in
  WP-4, not a reason to keep the directory.
- **Rebuild `site/index.html`.** It bundles `emit.ts` and `rules/registry.ts`,
  which now come from `node_modules` rather than `packages/`. The minified
  diff is unreadable — prove the rebuild took by grepping the bundle for a
  string that only exists in the new build, and grep for a string from a
  tree-shaken module as a control. `ORCHESTRATION.md` records the technique.
- Update `README.md` and `ORCHESTRATION.md` — the repo layout table, the
  workspace list and the "four workspaces" phrasing in the gate all become
  wrong.
- **Remove `{ todo: true }` from the pin.**

**Routed from WP-1 — found by hunting, not in the original bullet list:**

- **`packages/scanner/test/tf-blocks.test.ts:21`** builds `FIXTURES` from
  `packages/tf-import-blocks/test/fixtures`. Deleting the directory takes
  **three passing tests** with it (assertions at ~32, ~50, ~62). This is the
  largest thing WP-6 must handle and the original plan missed it entirely. The
  fix already exists, at the top of `consumed-from-npm.test.ts`: resolve
  `tf-import-blocks/package.json`, `path.dirname`, then `test/fixtures`. It
  works before *and* after the split, which is why the package ships its
  fixtures (WP-1's deliberate `files` decision).
- Stale docs WP-1's change created, all WP-6's to fix:
  `ORCHESTRATION.md:107` (the bundle now carries `dist/emit.js` and
  `dist/rules/registry.js`, not the `src/*.ts` it names);
  `ORCHESTRATION.md:22-24` (`TS2307` has a second cause now — `Cannot find
  module 'tf-import-blocks'` means `dist/` is unbuilt; same remedy, so add a
  clause rather than rewriting the lesson); `ORCHESTRATION.md:47-53` (the
  repo-shape table **already omits** `tf-import-blocks` — pre-existing, so
  there is no row to delete, but the `packages/viewer` row's "consumes
  `@atlas/schema` as a workspace dep" needs updating); `README.md:632` and
  `packages/viewer/src/model/tf-import.ts:11` (both still claim lifting the
  package out is `git mv` plus a `package.json`, now measurably falser);
  `README.md:548` and `README.md:560` (`npm run build` no longer rebuilds only
  `site/index.html`).

**Acceptance:** `packages/tf-import-blocks/` does not exist; `npm test` green
with **0 todo** and the pin passing as a plain assertion; `npm run typecheck`
green across the **three** remaining workspaces; `npm run build` succeeds and
the rebuilt `site/index.html` is proved current; the scanner CLI reproduces
`awkward.expected.tf`; the viewer's details panel still shows an import block
for an unmanaged SQS queue with an `https://sqs.…` id **checked in a real
browser**, because that is the acceptance the previous plan proved and this
one must not silently break.

Owns: `packages/scanner/package.json`, `packages/viewer/package.json`, root
`package.json`, `package-lock.json`, `packages/tf-import-blocks/` (deletion),
`packages/scanner/test/consumed-from-npm.test.ts`, `site/`, `README.md`,
`ORCHESTRATION.md`.
Size **L**. Depends: WP-5.

---

## Waves

| Wave | Packages | Notes |
| --- | --- | --- |
| 1 | WP-1 | **alone** — it owns the package's `package.json` and root build wiring, and everything downstream builds on the emit config |
| 2 | WP-2 | **alone** — it splits history from a tree WP-1 has settled |
| 3 | WP-3 + WP-4 | disjoint on the split branch: `.github/workflows/` vs `package.json` / `README.md` / `NOTICE` |
| 4 | WP-5 | **the orchestrator, not an agent** (decision 29); one confirmation from Ben before the release tag |
| 5 | WP-6 | **alone** — it owns three `package.json` files, the lock file, `site/`, both docs and a directory deletion |

Checked against the `Owns` lists, not the shape:

- Wave 3's two packages touch four files with no overlap. Both operate on
  WP-2's branch, so they must be told it is shared and stage by name.
- Every other wave is a single package, because every one of them owns either
  root `package.json`, the lock file, or the repo's existence.

**Choke points — a package that owns one runs alone:**

- Root `package.json` and `package-lock.json` — WP-1 and WP-6 only, never
  concurrently.
- The package's `package.json` — WP-1 edits it at
  `packages/tf-import-blocks/package.json` in this repo; WP-4 edits it at the
  **root** of the split branch (decision 27). Same file, two paths, two
  branches. Do not let that fool anyone into running them together, and note
  that WP-4 is editing a file whose content WP-1 authored — a WP-4 that
  contradicts WP-1's `exports`, `files` or `type` has broken the build WP-1
  proved, and must say so rather than quietly overwriting it.
- `site/` — WP-6 only. It is a committed build artifact and the last viewer
  change in the plan owns rebuilding it.
- `packages/scanner/src/terraform.ts`, `packages/viewer/src/model/terraform.ts`,
  `packages/viewer/src/data.ts`, `packages/schema/**` — **nobody owns these in
  any wave.** They have held a zero-line diff across fifteen packages and two
  plans. A diff in any of them means something has gone wrong.

Five waves. None is a human's any more (decision 29) — but wave 4 pauses once,
for Ben to confirm the npm credential is in place before a tag triggers an
irreversible publish.

---

## The regression to fear

**What must provably not move:** the emitted HCL, byte for byte. The golden
test travels with the package, so after WP-6 this repo no longer holds its own
copy of that assertion — which is precisely why the pin asserts the CLI
reproduces `awkward.expected.tf` from *this* side of the boundary. Also: the
details panel, the bulk copy, the Terraform badges, the managed/unmanaged
filter and `npm run tf-import` all continue to work unchanged. This plan
changes *where the code lives*, not what it does.

**What could break silently — and this is the real risk.** The package has
**never** been consumed as a built artifact. Every one of its 278 tests runs
against raw TypeScript through `tsx`. Module resolution, the `exports` map,
`.d.ts` correctness, ESM interop and Vite's treatment of a `node_modules`
dependency versus a workspace symlink are all completely unexercised today and
all become load-bearing on the day WP-1 lands. A subtly wrong build typechecks,
bundles, renders, and produces different bytes. WP-4's "install the tarball
into a throwaway project" step exists for exactly this and is not optional.

**Hunt for the assumption, do not assume its absence.** The assumption this
plan relaxes is *"the package is a folder in this repo."* It is encoded in more
places than the two `package.json` files: in relative paths in tests, in the
root test glob `packages/*/test/**/*.test.ts`, in `tsconfig` project
references, in the viewer's Vite config, in `ORCHESTRATION.md`'s "all
workspaces" phrasing, and in every doc sentence that says "four workspaces".
When you touch any file, ask where that assumption still lives. Name what you
find even when it is outside your package.

**What the fixtures avoid.** Every state fixture here is synthetic and every
one of them is tidier than a real state — that warning from the previous plan
still stands. But the shape *this* plan avoids is different and sharper: there
is **no fixture at all for a consumer that installs the package from a
registry**. WP-4's throwaway-project check is the only thing in five waves that
looks at the artifact the way a stranger will, and it runs once, by hand, near
the end. If a defect survives this plan, that is where it will be — and it will
be found by someone running `npm install tf-import-blocks` in a repo none of us
has seen.
