# Terraform import blocks — from state, and from drift

Base commit: `7cdb337`. Tree clean, `npm run typecheck` green across all three
workspaces (run `npm install` first — a stale install produces a wall of
`TS2307: Cannot find module '@aws-sdk/client-*'` that is **not** a code defect).

There is no `ORCHESTRATION.md` in this repo and no plan document preceded this
one, so the decisions below are numbered from 1 and nothing is carried forward.

---

## The defect

The repo already extracts Terraform identity from state (`packages/scanner/src/terraform.ts`)
and already marks every graph node as managed or unmanaged
(`packages/viewer/src/model/terraform.ts`). What neither can do is answer the
only question that matters once you've *found* drift: **what do I paste to adopt
it?**

The obvious answer — "use the resource's `id`" — is wrong for a large fraction
of the estate, and wrong differently per type. Verified against the AWS provider
docs on 2026-08-07 (`website/docs/r/*.html.markdown` on `main`):

| terraform type | real import ID | what atlas stores as `ref.id` | source (hint — verify) |
| --- | --- | --- | --- |
| `aws_sqs_queue` | queue **URL** `https://sqs.…/123/orders` | the queue **ARN** | `collect/messaging.ts:142` — `id: queueArn ?? queueUrl` |
| `aws_lambda_function` | function **name** `example` | the function **ARN** | `collect/compute.ts:90` — `id: fn.FunctionArn ?? …` |
| `aws_ecs_service` | `cluster-name/service-name` | the service **ARN** | `collect/containers.ts:66` — `id: s.serviceArn!` |
| `aws_wafv2_web_acl` | `<id>/<name>/<scope>` | the bare ACL id | `schema/src/snapshot.ts` — `WafWebAcl.scope` exists |
| `aws_route53_record` | `Z4KAPRWWNC7JR_dev.example.com_NS[_setid]` | not a node at all | `collect/global.ts` — records nest inside the zone |
| `aws_iam_role_policy_attachment` | `role-name/arn:aws:iam::…:policy/p` | not a node at all | — |
| `aws_db_instance` | the DB **identifier** | the DB identifier ✅ | `collect/data-stores.ts:56` |
| `aws_vpc` | `vpc-…` | `vpc-…` ✅ | — |
| `aws_route53_zone` | bare `Z123…` | bare `Z123…` ✅ | `collect/global.ts:65` strips `/hostedzone/` |

The last three rows are the trap: enough types work by accident that a
naive implementation looks correct on a demo and silently emits garbage for
SQS, Lambda, ECS and every attachment resource in the estate.

The README currently states this incorrectly and must be corrected (WP-H):

> Matching is by ARN, falling back to the AWS-native id — the same convention
> the AWS provider uses for its `id` attribute

That is true of *matching* (which has an ARN to fall back on) and false of
*importing* (which does not).

---

## The reframing

**A resource's Terraform identity is a `(type, import-id)` pair produced by a
per-type rule — not its AWS id.**

Everything falls out of that. The rule table becomes the asset; both features
the user asked for are thin adapters onto it, differing only in what they feed
it:

- **From a state file** (moving resources between states) → attributes are
  available, so composite ids are computable exactly.
- **From a scanned resource** (adopting drift) → only the atlas snapshot is
  available, so composite ids must be reconstructed from scanner fields.

Where a type supports both paths they must produce the **same string**. That
agreement is the plan's completion signal.

---

## Decisions — taken, do not relitigate

1. **The generator lives in a new standalone package `packages/tf-import-blocks`
   that imports nothing from `@atlas/*`.** The user's instinct — that this
   belongs in a `terraform-utils` repo — is correct, and this structure honours
   it: lifting it out later is `git mv packages/tf-import-blocks` plus a
   `package.json`. Do not "simplify" it by reaching into `@atlas/schema`.
2. **The package accepts a structural `ScannedSubject`, declared in the package
   itself** (`{ kind, id, arn?, name?, region, accountId, raw }`). The viewer's
   `ResourceRef` structurally satisfies it. Do not import `ResourceRef`; do not
   make the viewer convert. This is what keeps decision 1 true.
3. **Emit the `id = "…"` form only** (Terraform ≥ 1.5). The `identity = { … }`
   form needs Terraform ≥ 1.12 *and* a provider that publishes an identity
   schema for that resource; coverage is uneven and would need per-type
   tracking. Not to be "upgraded" without asking.
4. **Rule coverage is the union of two tiers.** Tier A: the ~138 `kind` values
   the viewer builds in `packages/viewer/src/data.ts` (needed by the panel).
   Tier B: the composite/attachment types that dominate real state files and
   are never drawn (needed by the CLI). Neither tier is complete without the
   other.
5. **Unknown types are emitted, not dropped.** Fallback is the state's own `id`
   with a `# VERIFY: no rule for <type> — import id may not be the state id`
   comment above the block. Silently skipping a resource during a state move is
   the worst possible failure; a wrong-but-flagged block is recoverable.
6. **Only identifiers leave the state file.** The existing posture
   (`scanner/src/terraform.ts` header, README, `.gitignore`) is absolute and
   extends here: rules may *read* attributes to compute an import id, and the
   emitter writes only the computed id and address. No attribute value is ever
   copied into output verbatim unless it is itself the import id.
7. **Generated `.tf` goes where the user says — never into `data/` and never
   into a committed default path.** The CLI writes to stdout unless `--out` is
   given. Import blocks belong in the *target* repo, not this one.
8. **Addresses generated for the panel are suggestions.** From a state file the
   address is authoritative (it comes from the state). From a scanned resource
   there is no address, so synthesise `<tf_type>.<sanitised name or id>` and say
   in the UI that it is a suggestion to rename. Sanitising: HCL identifiers
   match `[A-Za-z_][A-Za-z0-9_-]*`, so map invalid characters to `_` and prefix
   `r_` when the result starts with a digit. Within one bulk emit, dedupe
   collisions with `_2`, `_3`.
9. **HCL string escaping is the emitter's job and is not optional.** `\` → `\\`,
   `"` → `\"`, and **`${` → `$${`** — an import id containing `${` is otherwise
   interpolated by Terraform. This is a real hazard: S3 keys, tag values and
   Route 53 record names can all contain it.
10. **No `provider =` argument is emitted.** We cannot know the user's alias
    names. Instead emit a `# account <id> · region <region>` comment above each
    block. Importing into the wrong provider is silent and expensive; the
    comment is the honest mitigation.
11. **Data sources and non-`aws_` resources are skipped**, matching the existing
    `isManagedAws` predicate in `scanner/src/terraform.ts`. Reuse the behaviour;
    do not reuse the function (decision 1).
12. **The test runner is `node --test` via `tsx`** — no new dependency, `tsx` is
    already a scanner devDependency. Verified working: a failing assertion under
    `{ todo: true }` prints the full diff and still exits 0.
13. **`packages/tf-import-blocks` has no runtime dependencies.** Not `yaml`, not
    an HCL library. The emitter is string building.
14. **The existing `tf-import` command and its `data/terraform/*.json` sidecars
    are unchanged.** This plan adds a second, independent path. Nothing about
    the match/badge behaviour moves.

---

## Standing rules

- **Deletion belongs to the package that supersedes.** Any package that replaces
  something deletes it in the same commit and reports per symbol: deleted, or
  kept with the name of the caller that still needs it. "Nothing calls it any
  more so I left it" is not an acceptable report. A red build from a deletion is
  a *result* — it inventories callers better than grep.
- **Every `file:line` in this document is a hint that has already drifted or
  will.** Grep for the symbol, confirm it says what this plan claims, and report
  the drift in your summary rather than quietly working around it.
- **Verification gate for every package:** `npm install && npm run typecheck`
  green across all three (soon four) workspaces, and `npm test` green. A package
  that cannot make the gate green reports why rather than weakening the gate.
- Commit straight to `main`. No feature branches, no PRs. No `Co-Authored-By`
  or generated-with trailers in commit messages.

---

## The red pin

`packages/tf-import-blocks/test/golden.test.ts`, created by **WP-A** and flipped
by **WP-E**.

WP-A ships a deliberately naive generator that does exactly what a careless
implementation would: `id = <the state's id attribute>` for every type. It then
commits a synthetic awkward state fixture and a hand-written golden `.tf` file
holding the **correct** output, and asserts the two match under
`{ todo: true }`.

The test therefore fails, loudly and specifically — printing the exact per-type
disagreement the table at the top of this document describes — while
`npm test` still exits 0, so the tree documents the known defect without a red
build. Record the observed failing values in a comment inside the test.

WP-E removes `{ todo: true }`. When that assertion passes as a plain assertion,
the plan is done. There is no other definition.

---

## WP-A · Package skeleton, naive generator, and the pin

**Goal:** `packages/tf-import-blocks` exists, builds, is wired into the
workspace and the test script, and contains a failing golden test that states
exactly what correct output looks like.

- Create the package: `package.json` (private, `type: module`, exports
  `./src/index.ts`, **no dependencies** — decision 13), `tsconfig.json`
  extending `tsconfig.base.json` like the other three packages do.
- `src/types.ts` — `ImportRule`, `ScannedSubject` (decision 2), `StateSubject`,
  `ResolvedImport { type, address, id, comments[], verified }`.
- `src/emit.ts` — the HCL emitter. Owns escaping (decision 9), address
  sanitising and collision dedupe (decision 8), and the `# account · region`
  and `# VERIFY` comment forms (decisions 5, 10).
- `src/rules/registry.ts` — merges rule tables by terraform type and indexes
  them by type *and* by atlas `kind`. It imports three rule modules that WP-A
  creates **empty** (`export const RULES: ImportRule[] = []`) so B, C and D can
  each own one without touching this file:
  `src/rules/scanned-network.ts`, `src/rules/scanned-workload.ts`,
  `src/rules/state.ts`.
- `src/from-state.ts` — state parsing (raw v4 **and** `terraform show -json`,
  matching the two formats `scanner/src/terraform.ts` already accepts) plus the
  naive `id`-passthrough resolution that makes the pin red.
- `src/index.ts` — the public surface.
- **Root `package.json` is owned by this package and by nobody else.** Add the
  workspace entry, the test script, and the `"tf-blocks"` script WP-E will need.
  Adding them all now is what keeps root `package.json` off every other
  package's `Owns` list.
  The test invocation is **verified working on this tree** (node v23.11.0,
  tsx v4.23.0, which npm hoists to root `node_modules/.bin` from the scanner
  workspace — no new dependency needed):

  ```json
  "test": "tsx --test \"packages/*/test/**/*.test.ts\""
  ```

  Do **not** substitute `node --test --import tsx` (the specifier does not
  resolve) or `node --import tsx/esm --test` (exits 1 on a `{ todo: true }`
  failure, which would defeat the pin). If you change the invocation, re-verify
  that a `{ todo: true }` failing assertion still exits 0.
- `test/fixtures/awkward.tfstate.json` — a raw v4 state that is deliberately
  nasty. It must contain, at minimum: `aws_vpc` (control — must never move);
  `aws_sqs_queue`, `aws_lambda_function`, `aws_ecs_service`, `aws_wafv2_web_acl`,
  `aws_route53_record` (including one with an **empty record name**, whose id is
  `Z4KAPRWWNC7JR__NS` — note the double underscore), `aws_iam_role_policy_attachment`,
  `aws_security_group_rule`, `aws_route`, `aws_s3_bucket`, `aws_db_instance`;
  a `for_each` instance under a module with a quoted key
  (`module.net.aws_subnet.private["eu-west-1a"]`); a `count` instance
  (`aws_nat_gateway.ngw[0]`); a `data` source and a non-`aws_` resource (both
  must be skipped — decision 11); a type with **no rule at all** (must produce
  the `# VERIFY` fallback); and an id containing both `"` and `${` to exercise
  decision 9.
- `test/fixtures/awkward.expected.tf` — the golden output, hand-written. Each
  non-obvious id must carry a comment naming the provider doc page it came from.
  The five rows marked verified in the table above are confirmed; **verify every
  other type against `website/docs/r/<type>.html.markdown` in
  `hashicorp/terraform-provider-aws` on `main` before writing the golden value.**
  Do not guess an import id into a golden file.
- `test/golden.test.ts` — generate from the fixture, compare to the golden,
  `{ todo: true }`.

**Acceptance:** `npm test` exits 0 and reports the golden test as a TODO failure
whose output names at least `aws_sqs_queue`, `aws_lambda_function`,
`aws_ecs_service` and `aws_wafv2_web_acl` as disagreeing. `npm run typecheck`
green across four workspaces. The `aws_vpc` control row already agrees. Data
sources, the non-`aws_` resource, and both index-key forms are handled correctly
*by the naive generator* — the only thing the pin is red about is import ids.

Owns: all of `packages/tf-import-blocks/` (skeleton, `src/types.ts`,
`src/emit.ts`, `src/from-state.ts`, `src/index.ts`, `src/rules/registry.ts`,
three empty rule modules, `test/`), and root `package.json`.
Size **L**. Depends: none.

---

## WP-B · Tier A rules — network and edge kinds

**Goal:** every network/edge `kind` the viewer produces resolves to a correct
terraform type and import id from a scanned resource alone.

- Fill `src/rules/scanned-network.ts` with `fromScanned` rules for the network
  and edge half of the `add('<kind>', …)` calls in
  `packages/viewer/src/data.ts` (hint: roughly lines 61–135 — **grep, don't
  trust the numbers**): `vpc`, `subnet`, `route-table`, `igw`, `eigw`, `nat`,
  `eip`, `nacl`, `sg`, `eni`, `vpce`, `vpce-service`, `prefix-list`, `flow-log`,
  `dhcp-options`, `instance-connect-endpoint`, `pcx`, `tgw*`, `vgw`, `cgw`,
  `vpn`, `dx-*`, `lb`, `tg`, `zone`, `dxgw`, `resolver-*`, `dns-firewall-*`,
  `client-vpn`, `network-firewall*`, `apigw*`, `lattice-*`, `cloudfront*`,
  `global-accelerator`, `core-network`, `waf-*`.
- Most are id passthrough. **Verify against the provider docs any type whose
  import id is not plainly the AWS-native id** — `aws_wafv2_*` (`id/name/scope`),
  `aws_lb_*`, `aws_api_gateway_*` vs `aws_apigatewayv2_*`, `aws_vpc_endpoint_service`,
  and the Lattice family are the ones that will bite.
- The trap: `eip`. `console-link.ts:42` already records that EC2-classic EIPs
  have a bare IP as `id` and no ARN. `aws_eip` imports by allocation id, so a
  bare-IP id must resolve to *no rule*, not a wrong one.
- Where a kind has no sensible terraform type (e.g. `generic`, `ecr-registry`),
  register nothing and let the fallback handle it — do not invent a type.

**Acceptance:** for every kind listed above, a table-driven test in
`test/scanned-network.test.ts` asserts the resolved `(type, id)` pair for a
representative subject. `aws_wafv2_web_acl` from a scanned subject produces
`<id>/<name>/<scope>`. A bare-IP `eip` subject resolves to no rule and emits the
`# VERIFY` fallback rather than `id = "203.0.113.5"`. `npm test` green,
typecheck green.

Owns: `packages/tf-import-blocks/src/rules/scanned-network.ts`,
`packages/tf-import-blocks/test/scanned-network.test.ts`.
Size **M**. Depends: WP-A.

---

## WP-C · Tier A rules — workload, data, security and identity kinds

**Goal:** the remaining `kind` values resolve to a correct terraform type and
import id from a scanned resource alone.

- Fill `src/rules/scanned-workload.ts` with the rest of the `add(…)` and global
  kinds in `packages/viewer/src/data.ts`: `instance`, `asg`, `lambda`, `rds*`,
  `ecs`, `eks`, `elasticache*`, `efs`, `fsx`, `opensearch`, `msk`, `redshift*`,
  `mq`, `dynamodb-table`, `kms`, `acm`, `secret`, `log-group`, `cognito-*`,
  `directory-service`, `ecr-repository`, `sns-topic`, `sqs-queue`, `event-bus`,
  `eventbridge-*`, `sfn-state-machine`, `emr-cluster`, `batch-*`, `neptune-*`,
  `docdb-*`, `memorydb-*`, `transfer-server`, `beanstalk-environment`, `glue-*`,
  `dms-*`, `datasync-*`, `firehose-*`, `ram-share`, `config-*`, `cloudtrail-*`,
  `guardduty-*`, `backup-*`, `securityhub`, `access-analyzer`, `inspector2`,
  `macie2`, `s3`, `iam-*`, `sso-*`, `saml-provider`, `oidc-provider`, `org*`.
- The four confirmed traps live here and each needs real work, not a passthrough:
  - `sqs-queue` → **queue URL**. The scanner stores the ARN
    (`collect/messaging.ts:142`). The URL is deterministically derivable from
    the ARN — `arn:aws:sqs:<region>:<acct>:<name>` →
    `https://sqs.<region>.amazonaws.com/<acct>/<name>` — so derive it. Do **not**
    add a field to the snapshot schema for this; re-scanning the estate is not
    a prerequisite for this feature.
  - `lambda` → **function name**, not the ARN (`collect/compute.ts:90`).
  - `ecs` → `<clusterName>/<name>`. `EcsService` carries both (`clusterName` is
    derived from `clusterArn` at `collect/containers.ts:71`); if `clusterName`
    is absent, derive it from `clusterArn` rather than emitting a wrong id.
  - `wafv2` kinds appear in **both** regional and global collections in
    `data.ts` — scope must come from the resource's `scope` field, not from
    whether `ref.region` is empty.
- `iam-role`, `iam-user`, `iam-group`, `iam-instance-profile` import by **name**;
  `iam-policy` imports by **ARN**. They are not the same rule.
- Same instruction as WP-B: verify anything that is not plainly id passthrough
  against the provider docs before writing it.

**Acceptance:** a table-driven test in `test/scanned-workload.test.ts` asserts
the resolved pair per kind. Specifically: an SQS subject whose `id` is
`arn:aws:sqs:eu-west-1:111122223333:orders` resolves to
`https://sqs.eu-west-1.amazonaws.com/111122223333/orders`; a Lambda subject
resolves to the bare function name; an ECS subject resolves to
`prod-cluster/web`; `iam-role` resolves to a name and `iam-policy` to an ARN.
`npm test` green, typecheck green.

Owns: `packages/tf-import-blocks/src/rules/scanned-workload.ts`,
`packages/tf-import-blocks/test/scanned-workload.test.ts`.
Size **M**. Depends: WP-A.

---

## WP-D · Tier B — state-attribute resolvers and the awkward composites

**Goal:** a state file's resources resolve to correct import ids, including the
attachment and relationship types that never appear on the graph.

- Fill `src/rules/state.ts` with `fromState(attrs)` resolvers. This is the tier
  that addresses the user's actual complaint, so it is the tier that must be
  right.
- Confirmed formats (verified 2026-08-07 — re-confirm if the provider has moved):
  - `aws_route53_record` → `<zone_id>_<name>_<type>[_<set_identifier>]`,
    underscore-delimited, with an empty name yielding a double underscore.
  - `aws_iam_role_policy_attachment` → `<role>/<policy_arn>`.
  - `aws_wafv2_web_acl` / `_ip_set` / `_rule_group` → `<id>/<name>/<scope>`.
  - `aws_ecs_service` → `<cluster>/<name>`.
  - `aws_sqs_queue` → the `url` attribute.
  - `aws_lambda_function` → `function_name`.
- Cover at least, verifying each against the provider docs first: `aws_route`,
  `aws_route_table_association`, `aws_security_group_rule`,
  `aws_vpc_security_group_ingress_rule` / `_egress_rule`,
  `aws_iam_user_policy_attachment`, `aws_iam_group_policy_attachment`,
  `aws_iam_role_policy`, `aws_lb_listener_rule`, `aws_lb_target_group_attachment`,
  `aws_autoscaling_attachment`, `aws_network_acl_rule`,
  `aws_ec2_transit_gateway_route`, `aws_ec2_transit_gateway_route_table_association`,
  `aws_route53_zone_association`, `aws_volume_attachment`,
  `aws_cloudwatch_event_target`, `aws_lambda_permission`,
  `aws_s3_bucket_policy`, `aws_ecr_repository_policy`,
  `aws_secretsmanager_secret_version`, `aws_dynamodb_table_item`,
  `aws_elasticache_*`, `aws_glue_catalog_database` / `_table`,
  `aws_api_gateway_*` sub-resources, `aws_cognito_user_pool_client`,
  `aws_organizations_*`.
- **Name the ones you could not resolve.** Some types genuinely have no
  documented import support. Register them with an explicit "not importable"
  note so the emitter says so, instead of leaving them to the generic fallback
  which implies the id might work.
- Where a type also has a `fromScanned` rule in WP-B/WP-C, the two must produce
  the same string for the same real resource. You do not own those files — if
  you find a disagreement, report it; do not edit across the boundary.

**Acceptance:** `test/state-rules.test.ts` asserts each resolver against
attribute fixtures, including the empty-record-name Route 53 case producing
`Z4KAPRWWNC7JR__NS`. Every type named above either resolves or carries an
explicit not-importable note; a list of which is which appears in the package
README. `npm test` green, typecheck green.

Owns: `packages/tf-import-blocks/src/rules/state.ts`,
`packages/tf-import-blocks/test/state-rules.test.ts`,
`packages/tf-import-blocks/README.md`.
Size **L**. Depends: WP-A.

---

## WP-E · The `tf-blocks` CLI command — and flipping the pin

**Goal:** `npm run tf-blocks -- <statefile>` prints import blocks for every
resource in that state, and the golden test passes as a plain assertion.

- New subcommand in `packages/scanner/src/cli.ts` and a thin
  `packages/scanner/src/tf-blocks.ts` that calls the package. Add
  `tf-import-blocks` to `packages/scanner/package.json` dependencies. The root
  `package.json` script already exists (WP-A) — do not re-add it.
- Flags: positional state file(s); `--out <file>` (default stdout — decision 7);
  `--filter <prefix>` to emit only addresses matching a prefix, since moving a
  subtree out of a state is the common case.
- Output is ordered by address so re-running produces a stable diff.
- Print a summary to **stderr** (never stdout, which may be redirected into a
  `.tf` file): total blocks, how many used a real rule, how many fell back with
  `# VERIFY`, and the distinct types among the fallbacks.
- **Take ownership of `packages/tf-import-blocks/test/golden.test.ts` and remove
  `{ todo: true }`.** If it does not pass, the defect is in B/C/D — report which
  type disagrees and what you expected. Do not adjust the golden file to match
  the code; the golden file is the specification.

**Acceptance:** `npm test` green with `golden.test.ts` as a plain passing
assertion — this is the plan's completion signal. Running the command against
`test/fixtures/awkward.tfstate.json` writes output byte-identical to
`awkward.expected.tf`. Redirecting stdout to a file yields a file containing
only HCL — no summary text. A state containing a type with no rule still exits
0 and reports the fallback count on stderr.

Owns: `packages/scanner/src/tf-blocks.ts`, `packages/scanner/src/cli.ts`,
`packages/scanner/package.json`, `packages/tf-import-blocks/test/golden.test.ts`.
Size **M**. Depends: WP-B, WP-C, WP-D.

---

## WP-F · The details-panel import block

**Goal:** selecting an unmanaged resource shows a ready-to-copy import block
instead of only telling you it is unmanaged.

- `packages/viewer/src/model/tf-import.ts` — a thin adapter calling the package
  with the `ResourceRef` as a `ScannedSubject` (decision 2). Export both the
  single-resource form and a bulk form taking `ResourceRef[]`, because WP-G
  needs the bulk one and must not have to build it inside a component.
- `packages/viewer/src/components/DetailsPanel.tsx` — extend the existing
  unmanaged branch (hint: around lines 312–321, `tfBindings.length === 0 &&
  index.terraform.length > 0` — grep for it, WP-F may already have moved it).
  Add the rendered block, a copy button, and the "address is a suggestion"
  note (decision 8).
- When no rule matches the kind, say so plainly and show the `# VERIFY` block
  rather than hiding the section — decision 5 applies to the UI too.
- `packages/viewer/src/styles.css` — **this package owns the stylesheet for the
  whole plan.** Add every class the import-block UI needs, including anything
  WP-G will want for a bulk button, so WP-G never has to open this file. Reuse
  the existing `.terraform`, `.tf-heading` and `.link-btn` conventions.
- Add `tf-import-blocks` to `packages/viewer/package.json` dependencies. Confirm
  Vite resolves the workspace package in the browser build — `@atlas/schema` is
  already consumed this way, so follow that precedent exactly.

**Acceptance:** with the dev fixture loaded (`npm run fixture && npm run dev`),
selecting an unmanaged SQS queue shows a block whose `id` is an
`https://sqs.…` URL, not an ARN; selecting an unmanaged VPC shows
`id = "vpc-…"`; selecting a resource of a kind with no rule shows the
`# VERIFY` block and says why. The copy button puts exactly the block text on
the clipboard. A managed resource's panel is **unchanged**. `npm run build`
succeeds and `npm run typecheck` is green.

Owns: `packages/viewer/src/model/tf-import.ts`,
`packages/viewer/src/components/DetailsPanel.tsx`,
`packages/viewer/src/styles.css`, `packages/viewer/package.json`.
Size **M**. Depends: WP-B, WP-C.

---

## WP-G · Bulk copy for everything unmanaged in the view

**Goal:** adopting drift is one action, not one action per resource.

- `packages/viewer/src/components/LayersPanel.tsx` already computes
  `tf.unmanaged` (hint: around lines 128–144 — grep for `tfManaged`). Add a
  button beside the unmanaged filter that copies import blocks for every
  unmanaged node in the current graph.
- Resolve nodes to `ResourceRef` via `index.byKey.get(node.data.refId)`, the
  same route `applyTerraformBadges` uses in
  `packages/viewer/src/model/terraform.ts`.
- Call the bulk form WP-F exported. Bulk emit is where address collisions
  actually happen, so this is the first real exercise of decision 8's dedupe —
  two unmanaged security groups both named `default` must not both become
  `aws_security_group.default`.
- Group the output by account and region with comment headers, since a bulk
  paste crossing accounts is exactly the case decision 10 warns about.
- **Do not open `styles.css`** — WP-F owns it and has already added what you
  need. If a class you need is genuinely missing, report it rather than adding
  it here.

**Acceptance:** with the dev fixture, the button reports a count matching the
Layers panel's unmanaged count, and the copied text contains that many `import {`
blocks. Two same-named resources produce distinct addresses. Blocks are grouped
under `# account … · region …` headers. Nothing about the existing
managed/unmanaged filter behaviour moves.

Owns: `packages/viewer/src/components/LayersPanel.tsx`.
Size **S**. Depends: WP-F.

---

## WP-H · Documentation, and correcting the record

**Goal:** the README describes both new paths and stops asserting something the
rule table disproves.

- Document `npm run tf-blocks` in the command table and in a new section under
  "Terraform state mapping", with the state-to-state move as the worked example
  (that is the actual use case — export from stack A, generate blocks, paste
  into stack B, `terraform plan`).
- Document the details-panel block and the bulk copy.
- **Delete and rewrite** the "Matching is by ARN, falling back to the
  AWS-native id — the same convention the AWS provider uses for its `id`
  attribute" paragraph. Matching by id/arn is fine and stays; the *claim* that
  the provider's `id` follows the same convention is false for `aws_sqs_queue`,
  `aws_lambda_function` and `aws_ecs_service`, and this plan's rule table is the
  evidence. Say what is actually true.
- Note decision 1 in the README: the package is deliberately atlas-free and is
  expected to move to its own repo.
- Restate decision 6 for the new command: reading a state to compute an import
  id does not put attribute values in the output.

**Acceptance:** README documents both features; the incorrect paragraph is gone
(not softened); a reader can perform a state-to-state move from the README
alone. No code changes in this package.

Owns: `README.md`.
Size **S**. Depends: WP-E, WP-G.

---

## Waves

| Wave | Packages | Notes |
| --- | --- | --- |
| 1 | WP-A | **alone** — it owns root `package.json`, the whole new package skeleton, and the pin every other package builds on |
| 2 | WP-B + WP-C + WP-D | disjoint rule modules (`scanned-network.ts` / `scanned-workload.ts` / `state.ts`), each with its own test file; all three only *read* `registry.ts` |
| 3 | WP-E + WP-F | disjoint trees — scanner + the golden test vs viewer. WP-E flips the pin |
| 4 | WP-G + WP-H | `LayersPanel.tsx` vs `README.md`; disjoint |

Checked against the `Owns` lists, not the shape:

- Wave 2's three packages touch six files, no overlap. `registry.ts` is imported
  by all three and edited by none — WP-A creates it already importing the three
  (initially empty) modules, which is the whole reason it does that.
- Wave 3: WP-E owns `packages/scanner/*` plus `test/golden.test.ts`; WP-F owns
  `packages/viewer/*`. No intersection. Both read `packages/tf-import-blocks/src/`.
- Wave 4: no intersection.

**Choke points — a package that owns one runs without a co-owner of that file:**

- `packages/viewer/src/styles.css` — **WP-F only**, for the entire plan. WP-G is
  explicitly forbidden from touching it. Do not re-parallelise by letting
  another package "just add one class".
- Root `package.json` — **WP-A only**, which is why WP-A adds the `tf-blocks`
  script it does not itself use.
- `packages/tf-import-blocks/src/rules/registry.ts` — **WP-A only**. If a wave-2
  package believes it needs to edit the registry, the rule-module boundary is
  wrong; report that rather than editing it.
- `packages/viewer/src/data.ts` — nobody owns it. This plan does not change the
  snapshot schema or the index (decision 14). A package that finds itself
  wanting to edit `data.ts` or `packages/schema/` has misread the plan.

Four waves.

---

## The regression to fear

**What must provably not move:** every managed resource's details panel, the
Terraform mark on the graph, the managed/unmanaged Layers filter and its counts,
`npm run tf-import`, and the shape of `data/terraform/*.json`. This plan adds a
parallel path; decision 14 says the existing one is untouched. If a diff in
`packages/scanner/src/terraform.ts` or `packages/viewer/src/model/terraform.ts`
appears in any package other than as a read, something has gone wrong.

**What could break silently:** a wrong import id. It compiles, it renders, it
copies to the clipboard, and it fails hours later inside someone else's
`terraform plan` — or worse, succeeds against the wrong resource. This is why
decision 5 exists and why golden values must come from provider docs rather than
from memory. Every agent writing a rule: **fetch the doc page.**

**Hunt for the assumption, do not assume its absence.** The assumption this plan
relaxes is *"a resource's import id is its id."* It is load-bearing in more
places than the rule table. When you touch any file, ask where that assumption
is still encoded — in a variable named `id` that is actually an ARN, in a
fallback that "usually works", in a test fixture that only contains types where
it happens to hold. Name what you find even when it is outside your package.

**What the fixtures avoid — and where the live defect will therefore be.**

`awkward.tfstate.json` is synthetic, and every synthetic state is tidier than a
real one. It has one provider, no aliases, no workspaces, no `moved` blocks, and
every resource has a populated `id`. Real states have all of those and more.
Specifically:

- **Deposed instances.** A state-v4 instance object can carry a `deposed` key,
  and `scanner/src/terraform.ts` (hint: the `for (const inst of …)` loop around
  line 55) does not distinguish them — so a resource mid-replace may yield two
  entries at the same address. Confirm whether it does before assuming it
  doesn't, and decide deliberately rather than by omission.
- **Provider aliases**, which decision 10 mitigates with a comment rather than
  solves. A state spanning two accounts is the case where a careless paste does
  real damage.
- **Non-ASCII and shell-hostile names** in tags and Route 53 records.
  Decision 9 covers `${` and quotes; it does not cover a name that is valid HCL
  but surprising.

`packages/scanner/src/fixture.ts` — the dev estate WP-F and WP-G verify against
— is fabricated, tidy, and has exactly two Terraform stacks with round numbers.
It contains no EC2-classic EIP, no two resources sharing a name, and no resource
whose region disagrees with its ARN. WP-G's collision-dedupe acceptance
therefore cannot be checked against it as shipped: **build the awkward case**
rather than declaring the tidy one sufficient.
