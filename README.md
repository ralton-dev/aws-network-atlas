# AWS Network Atlas

Scan AWS accounts **read-only** and render an accurate, interactive, **committable** network
**and security** diagram — the full traffic path plus security-group posture, identity, and a
searchable inventory of everything in the account.

```
┌────────────┐   READ-ONLY APIs   ┌──────────────────┐    bundle    ┌──────────────────┐
│ AWS account│ ─────────────────▶ │ data/accounts/   │ ───────────▶ │ site/index.html  │
│ (profiles) │      scanner       │   <account>.json │  data.js     │ (open in browser)│
└────────────┘                    └──────────────────┘              └──────────────────┘
```

Everything the scanner produces is plain text in this repo — snapshots, annotations, and the
viewer itself are all reviewable in a diff and committable to git.

## Prerequisites

- Node.js ≥ 20
- AWS CLI v2 installed and configured (`~/.aws/config` profiles; SSO profiles supported)
- Read-only credentials — either the bundled least-privilege [`iam-policy.json`](iam-policy.json) (exactly the actions the scanner calls; see [Least-privilege IAM policy](#least-privilege-iam-policy)) or a broad AWS-managed policy such as `ReadOnlyAccess` or `SecurityAudit`.

## Try it without an AWS account

The repo ships with a **synthetic demo estate** already loaded, so you can see
the viewer immediately — no AWS, no scan:

```bash
open site/index.html            # or just double-click it
```

It renders a fabricated 3-account org (prod / shared-services / dev) with a
Transit Gateway hub-and-spoke, cross-account VPC peering, Site-to-Site VPN,
Direct Connect, inter-region TGW peering, a "ghost" unscanned account, a
3-tier security-group chain, CloudFront, IAM with cross-account trust, KMS/ACM/
secrets, and the other edge services — everything the tool can show.
Regenerate it any time with `npm run fixture`. It's all fake data
(RFC 5737 documentation IPs, placeholder account ids).

## Quick start (real accounts)

```bash
npm install
npm run scan                    # scans profiles from atlas.config.json (default: "default")
open site/index.html            # double-click works too — no server needed
```

Or scan specific profiles/regions ad hoc:

```bash
npm run scan -- --profile prod --profile shared-services
npm run scan -- --profile dev --region eu-west-1 --region us-east-1
```

Scan multiple accounts to light up cross-account links: transit gateway attachments and VPC
peering connections are stitched together across account snapshots automatically. Accounts
that are referenced but not scanned appear as dashed "ghost" nodes.

## What gets scanned

> **Coverage is audited against the entire AWS resource universe.** See
> **[`docs/coverage.html`](docs/coverage.html)** — the source of truth for what this tool sees.
> Open it in a browser (regenerate with `npm run coverage`). It lists every AWS resource type
> that can be created and, for each, whether the scanner **collects** it and whether the viewer
> **draws** it. The dedicated collectors below cover the traffic path and security posture in
> depth; the rest of the estate is caught as searchable **inventory** (tagged resources) or,
> for untagged / non-taggable types, **not at all**.

All read-only. Dedicated collectors capture these regardless of tags:

- **Networking** — VPCs (incl. DNS attributes + DHCP option sets), subnets, route tables
  (with per-subnet resolution + public/private), internet & egress-only gateways, NAT
  gateways, Elastic IPs, network ACLs, **security groups (full ingress/egress rules,
  SG-to-SG refs)**, ENIs, VPC endpoints (+ endpoint policies), **PrivateLink endpoint
  services you expose** (+ allowed principals & consumer connections), managed prefix
  lists (incl. RAM-shared entries), **VPC flow logs**, EC2 Instance Connect endpoints,
  **VPC Lattice** service networks & services.
- **Cross-account/-region connectivity** — VPC peering, Transit Gateways (+ attachments,
  route tables with associations/propagations, Connect peers, inter-region TGW peering),
  VPN (gateways/customer gateways/connections incl. static routes), **Direct Connect**
  (gateways, physical connections, LAGs, **virtual interfaces with BGP peers**),
  **Cloud WAN core networks**.
- **Edge & DNS** — **CloudFront** (+ origin detail & VPC origins), **Global Accelerator**,
  **API Gateway** (REST + HTTP, + **VPC links** and **custom domains with API mappings**),
  **Route 53 Resolver** endpoints & rules, **DNS Firewall rule groups** (+ VPC
  associations), resolver query-log configs, **Client VPN** (+ routes & authorization
  rules), **Network Firewall** (firewalls with per-AZ endpoints & log destinations,
  **policies, rule groups with the actual rules**, TLS inspection configs), Route 53
  hosted zones (+ A/AAAA/CNAME records for stitching DNS to resources).
- **Load balancing & workloads** — ALB/NLB/GWLB + listeners (**incl. listener rules and
  certificates**) + target groups + health, classic ELB (+ registered instances),
  EC2 instances, Auto Scaling groups, Lambda (VPC config + **function URLs**),
  RDS instances/clusters/**proxies**, ElastiCache (clusters, replication groups,
  serverless), ECS services, EKS clusters, **EFS** (+ mount targets), **OpenSearch**,
  **MSK**, **Redshift**, **Amazon MQ**.
- **Identity & security** — **IAM** roles/users/groups/customer-managed policies/instance
  profiles (with trust policies, attached/inline policies, MFA & access-key signals),
  **KMS** keys (+ aliases/rotation), **ACM** certificates, **Secrets Manager** (metadata
  only — the secret value is never fetched), **WAF v2** (web ACLs with rules + resource
  associations, IP sets, rule groups; REGIONAL + CLOUDFRONT scopes).
- **Everything else** — **CloudWatch log groups** (+ retention/KMS), a Resource Groups
  Tagging API sweep catches every *tagged* resource for search/inventory, and a
  **Cloud Control API** sweep over common types (incl. Kinesis/Firehose) catches
  **untagged** resources the tagging API misses. S3 buckets are listed directly.

## The viewer

The canvas shows what the scanner collects — the traffic path **and** the security posture —
not just core topology.

- **Overview** — accounts ▸ regions ▸ VPCs, stitched together by Transit Gateways, peering,
  VPN, and Direct Connect (edges annotated with routed CIDRs). An **Internet node** anchors
  the edge: internet → **CloudFront** → its ALB/S3 origins, public **API Gateway**, and
  **Client VPN**. Each account also gets an **Identity & security** lane (IAM, with badges
  like *no MFA* / *N access keys*) and an **Edge & global** lane (CloudFront, S3, hosted
  zones), plus cross-account **assume-role trust edges** between account boxes.
- **Drill-down** — double-click a VPC: AZs ▸ subnets (public/private per the route tables)
  with the workloads inside them (EC2, RDS, NAT, endpoints…), route-derived arrows
  (subnet → NAT/IGW/TGW/peering) labelled with destinations, plus Network Firewall,
  Resolver endpoints, and API Gateway in the traffic path. Click any edge for the full
  per-subnet route breakdown.
- **Security groups on the canvas** — SGs are nodes showing `N in / M out`. **SG-to-SG rule
  edges are labelled with the port/protocol** (e.g. `tcp 8080`), so you can trace the
  allow-path (`internet → 443 → alb → 8080 → app → 5432 → db`). A dedicated red **Internet
  exposure** edge flags any SG open to `0.0.0.0/0` (its own Layers toggle — "show me only
  what's world-reachable"). Faint attach edges link each SG to the workloads it protects.
  Click a rule edge for the full ingress/egress table.
- **Relationship edges** — secret → KMS key (*encrypted by*), VPC → ACM cert (*TLS*),
  IAM role → the instance/Lambda that assumes it, Resolver rule → on-prem DNS target.
- **Focus / connections view** — select any resource and hit **Focus on connections** (in
  the details panel) to open a view scoped to *just that resource and everything wired to
  it*, each edge labelled by the relationship. Focus an EC2 instance and you get its IAM
  role (*assumes role*), security groups (*applies to*, plus their allow-chain), subnet/VPC
  (*in subnet* / *in VPC*), NAT/IGW/TGW/peering routing, its load balancer + CloudFront
  path, and Route 53 — its dependency neighbourhood ("blast radius"), not the whole VPC.
  The breadcrumb walks you back.
- **Pan / Arrange toggle** — defaults to **Pan** (nodes locked, so click-drag pans the
  canvas); flip to **Arrange** to drag nodes around (positions persist per view).
- **Layers** — hide/show by resource kind or edge kind (with live counts), or hide an
  individual node (right-click or the details panel). Every category is toggleable, so a
  busy VPC declutters to just what you care about.
- **Search** — fuzzy search across names, IDs, ARNs, tags, annotations, **and every
  resource's field values**: a private IP, a subnet CIDR, a CloudFront alias
  (`www.acme.example`), an RDS endpoint host, a Resolver domain, a KMS alias, an ACM SAN —
  they all resolve to the owning resource (IPs/CIDRs/hostnames are kept intact as search
  terms; name/ID matches still rank first).
- **Inventory** — every resource found, grouped by account ▸ region ▸ service, including
  things that aren't on the diagram.
- **Details panel** — click anything for properties, tags, rules, and your notes.

The viewer is a single committed file (`site/index.html`). Re-scanning only rewrites
`site/data/*.js` — the viewer itself never needs rebuilding to pick up new data.

## Annotations (committable notes)

Add YAML files under `annotations/` keyed by ARN or resource id:

```yaml
"vpc-0123456789abcdef0":
  title: Production VPC
  description: |
    **Core prod network.** Peered to shared-services.
  links:
    - label: Terraform
      url: https://github.com/your-org/infra/blob/main/network/vpc.tf
  labels: [prod, networking]
```

Then rebuild the data bundle (no re-scan needed):

```bash
npm run bundle
```

Notes render in the details panel (markdown supported) and are searchable.

## Terraform state mapping

Map the scanned estate onto the Terraform stacks that manage it. Export each
stack's state and import it — large estates have many state files, so import
as many as you have, recording which repo/project each one came from:

```bash
# from each stack's Terraform working directory (any backend):
terraform state pull > /tmp/prod-network.tfstate

# then, from this repo:
npm run tf-import -- --repo github.com/acme/infra-network --stack prod-network /tmp/prod-network.tfstate
npm run tf-import -- --repo github.com/acme/platform states/*.tfstate   # stack names derive from file names
```

Both raw state (`terraform state pull` / the `.tfstate` file itself) and
`terraform show -json` output are accepted. `--repo` is required — it's how the
diagram answers "where is this managed from?".

**Only identifiers leave the state file** — address, type, `id`, `arn`, and the
derived `importId`. State attribute values (which routinely contain DB passwords
and the like) are never persisted; what's written to `data/terraform/<stack>.json`
is committable.

On the diagram, every resource claimed by an imported stack gets the Terraform
mark on its icon, and its details panel shows the resource address, stack, and a
link to the repo. Resources *not* claimed by any imported stack are called out
as such — ClickOps drift, visible at a glance — and the Layers panel gains a
filter to show only Terraform-managed or only unmanaged resources. The import
also prints a match report per stack, and it splits three ways rather than
lumping everything unmatched into one list. *Stale* — the scan indexes this type
and still didn't find it — is the actionable one, and the only one listed
resource by resource. *Not checkable* — nothing in the scan can produce a key of
that shape — is counted by type and kept **out of the ratio**, so a stack whose
remainder is relationship resources no longer reports itself half-drifted. A
type with no import rule at all is counted separately again, because the
registry can't say which of the two it is.

Matching is by ARN, falling back to the AWS-native id. That's a *matching* key
and nothing more: `tf-import` keeps both `id` and `arn` from every state entry
and the scanner records both for every resource, so a node and a state entry
join on whichever they have in common.

Relationship resources have neither. `aws_security_group_rule`'s state `id` is
`sgrule-<hash>` and `aws_route`'s is `r-<rtb><hash>` — strings the provider
synthesises, corresponding to nothing AWS ever returns — and the scanner keeps
those relationships *inside* their parent (`SecurityGroup.ingress`), where they
have no id of their own either. Neither side holds a key, so they could never
match. What both sides *can* compute is the documented **import** id, and for
security group rules both now do: the state side asks the type's rule, the
scanned side reconstructs the same string from the group via
`ImportRule.expand`. They agree because agreeing is what the rule table is
for. Routes and NACL entries are nested identically and will match the day
someone registers an expander for them.

That derived import id is written to the sidecar as `importId`, alongside `id`
and `arn`, whenever it differs from `id` — which is exactly the case where `id`
is useless. It is an identifier, which is why it may travel: it is the string
`terraform import` takes. It is *not* a channel for attribute values, and
nothing that is not itself an import id follows it. **Absent means "cannot
tell", not "unmanaged"** — most types' import id is their `id` and so is not
repeated, and a sidecar imported before this field existed has none at all.
Nothing needs regenerating; re-run `npm run tf-import` against the same state
file when you want the nested resources matchable, which needs no AWS
credentials.

**A matching key is not an import id, and the AWS provider has no single
convention for `id`.** `aws_lambda_function`'s `id` is the function *name*, not
its ARN. `aws_sqs_queue`'s is the queue URL. `aws_ecs_service`'s is the service
ARN, but it *imports* by `cluster-name/service-name`. `aws_wafv2_web_acl`
imports by `<id>/<name>/<scope>`. `aws_iam_role` imports by name while
`aws_iam_policy` imports by ARN — one service, two different rules. The scanner
stores the ARN for the first three, so pasting the thing it matched on as an
import id fails, or worse succeeds against something else. Matching and
importing are different problems: matching needs one key both sides happen to
hold, importing needs a per-type rule table. That table is what the next section
is built on.

## Generating Terraform `import` blocks

Finding drift tells you a resource is unmanaged. `npm run tf-blocks` tells you
what to paste to adopt it: `import { … }` blocks (Terraform ≥ 1.5), one per
resource, address and id ready to go.

```bash
npm run tf-blocks -- [--filter <address-prefix>] [--out <file>] <statefile>...
```

Raw state (`terraform state pull`, or the `.tfstate` itself) and
`terraform show -json` output are both accepted, including pre-0.12 flatmap
instances and the pre-0.13 provider-address spelling. HCL goes to stdout and the
summary to stderr — nothing but HCL ever reaches stdout, precisely so it can be
redirected into a `.tf`. Blocks are ordered by address, so re-running produces a
stable diff.

Every import id comes from a per-type rule table, never from the state's `id`
attribute. The formats, the provider doc page each was read from, and the types
with no documented import at all are listed in
**[`packages/tf-import-blocks/README.md`](packages/tf-import-blocks/README.md)** —
215 Terraform types resolve from a state file, four of them flagged as not
importable. That package is standalone and atlas-free by design (see
[Architecture](#architecture)).

**Only identifiers leave the state file.** A rule may *read* attributes to
compute an import id — `aws_ecs_service` needs `cluster`, `aws_route53_record`
needs `zone_id`, `name` and `type` — but the emitter writes only the computed id
and the address. No attribute value is copied into the output unless it *is* the
import id. The stderr summary is held to the same line: counts, Terraform types
and addresses, never a value and not even an id, because stderr is what gets
pasted into a ticket. Nothing is written into this repo — generated `.tf` goes
where `--out` says, and it belongs in the *target* repo.

### Worked example — moving a subtree from one state to another

`module.net` lives in the `prod-network` stack and belongs in `platform`.

**1. Take stack A's state.**

```bash
# in stack A's Terraform working directory (any backend)
terraform state pull > /tmp/prod-network.tfstate
```

Prefer `terraform state pull` to `terraform show -json` here. Both parse, but
only the raw state records which *provider configuration* each resource was
managed through; `terraform show -json` keeps the provider source address and
drops the alias. On a state that spans two accounts, that alias is the only
thing in the file that says so.

**2. Generate blocks for the subtree you're moving.**

```bash
# in this repo — no AWS credentials, no atlas.config.json, no snapshot needed
npm run --silent tf-blocks -- \
  --filter 'module.net.' \
  --out ~/repos/platform/imports.tf \
  /tmp/prod-network.tfstate
```

`--filter` keeps only addresses with that prefix, and the addresses it keeps are
exactly the ones you'll remove from stack A in step 5 — the same list, twice.
`--out` resolves relative to where you invoked the command. The command needs
nothing from this repo but the code, so it runs just as well from inside the
target repo (`npx tsx <path-to-atlas>/packages/scanner/src/cli.ts tf-blocks …`).

> **Don't use a bare `>` through `npm run`.** npm prints its own banner to
> stdout and it lands in your `.tf`. Use `--out`, or
> `npm run --silent tf-blocks -- … > imports.tf`. Invoked directly —
> `npx tsx packages/scanner/src/cli.ts tf-blocks …` — stdout is HCL and nothing
> else.

**3. Read the summary on stderr.** It is the whole story of what the run could
and couldn't do:

```
tf-blocks: 23 blocks from 2 state files
  21 resolved by a rule
  2 fell back to the state id, flagged # VERIFY
    no rule: aws_s3_object
    rule could not compute an id: aws_security_group_rule
  1 tainted object in the source state — emitted, not skipped
  17 withheld by --filter
  skipped: 1 deposed instance, 1 data source, 1 non-aws resource
```

(Abridged — the tainted and deposed lines each carry a couple of explanatory
lines under them in the real output. Zero-valued lines are omitted entirely, so
a clean run is two lines long.)

- **resolved by a rule** — the id was computed from a documented format.
- **fell back to the state id** — split by cause, because the fix differs. *No
  rule* means the type isn't in the table at all. *Rule could not compute an id*
  means the type is covered but this state didn't carry the attributes it needed
  (a pre-0.12 flatmap instance, most often; the block's own comment says so).
  Either way the block is still emitted, carrying `# VERIFY`, because silently
  dropping a resource during a state move is the worst possible failure.
- **not importable at all** — one of four types the AWS provider publishes no
  import for. Emitted and loudly flagged, but they will not apply.
- **withheld by `--filter`** — resolved fine, just outside the prefix you asked
  for. Worth a glance: a resource you meant to move that the prefix missed shows
  up here as a number that's larger than you expected.
- **tainted and skipped, and why they differ.** Data sources and non-`aws_`
  resources aren't ours to import. Deposed instances are dropped deliberately: a
  deposed object is the orphan of an interrupted create-before-destroy, it
  shares its address with the live object, and it's scheduled for destruction,
  so importing it would both collide and adopt something Terraform is about to
  delete — both input formats are checked for it. A **tainted** object is the
  opposite case — it's the only object at its address, it exists, and its id is
  real — so it *is* emitted, with a `# TAINTED` comment. (Taint is state
  metadata and doesn't travel with the resource, so the import is sound; stack A
  will still replace the object on its next apply unless you remove it there
  first.)
- **WARNING: N addresses emitted more than once** — two state files contributed
  the same address. State addresses are authoritative and never renamed, so the
  output is not valid HCL as it stands and you have to pick.

**4. Check the blocks by hand before pasting.** Four things need your eyes:

- **`# VERIFY`** — the id below it is a guess (the state's own `id`). Check it
  against that type's provider documentation.
- **`# NOT IMPORTABLE`** — delete the block and re-declare the resource in stack
  B's configuration instead. They're pure associations, so recreating them isn't
  destructive.
- **`# account 111122223333 · region eu-west-1`**, and where the state used an
  aliased or in-module provider, **`# source provider aws.<alias>`**. No
  `provider =` argument is emitted, because we can't know your alias names —
  these comments are the honest mitigation, and importing into the wrong account
  is silent and expensive. Note the advice differs by address shape: Terraform
  *rejects* a `provider` argument on an import block whose `to` address is
  inside a module, so for those you select the provider with the module block's
  `providers` argument instead.
- **The addresses.** They're copied verbatim from stack A. If stack B calls the
  module something else, rewrite every `to =` before pasting.

**5. Import into stack B, then release from stack A.** With the moved
configuration in place alongside `imports.tf`:

```bash
# in stack B
terraform plan          # expect: N to import, 0 to add, 0 to change, 0 to destroy
terraform apply
```

Then, and only then, take the same addresses out of stack A:

```bash
# in stack A
terraform state rm 'module.net.aws_subnet.private["eu-west-1a"]'
# …one per address --filter emitted
```

> **Remove stack A's configuration for those resources in the same change as the
> `state rm`.** An `apply` in stack A with the configuration deleted but the
> state entries still present destroys the real resources — which stack B is now
> managing. If a plan in stack A shows anything to destroy, stop.

**6. Delete `imports.tf`.** Import blocks are a record of a one-time migration,
not configuration. Once the apply is clean they've done their job.

### In the viewer

**Details panel.** Select a resource no imported stack claims and the Terraform
section shows an **Import block** with a Copy button — type and id from the same
rule table, so an unmanaged SQS queue offers
`id = "https://sqs.eu-west-1.amazonaws.com/…"` rather than its ARN. The Copy
button puts exactly the block text on the clipboard. 136 of the 139 resource
kinds the viewer can build resolve to a rule; the three that don't and why each
is deliberate are under "Coverage — atlas kinds" in
[`packages/tf-import-blocks/README.md`](packages/tf-import-blocks/README.md).

**Nested resources.** Some resources are more than one Terraform resource. A
security group's rules live *inside* the group in the snapshot, and are never
nodes on the graph — but Terraform models each as its own
`aws_security_group_rule` with its own import id, so a block that adopts the
group alone leaves every rule it contains unmanaged. Selecting an unmanaged
security group therefore offers the group's block **and one per rule**,
collapsible, with the address of each rule reading as a child of its group
(`aws_security_group_rule.web_ingress_tcp_443_cidr` beside
`aws_security_group.web`). Copy takes all of them.

The fan-out follows the provider's schema, not intuition: `cidr_blocks`,
`ipv6_cidr_blocks` and `prefix_list_ids` all live on one resource, so an ingress
rule allowing four ranges is **one** block, while each referenced security group
is a block of its own. Every rule block carries two provider notices —
`aws_security_group_rule` is the legacy type (the modern
`aws_vpc_security_group_ingress_rule` imports by an `sgr-…` id no scan collects,
so it is not derivable), and combining it with inline `ingress`/`egress` blocks
on the group "may cause rule conflicts, perpetual differences, and result in
rules being overwritten". That second one matters: these blocks arrive beside an
`aws_security_group` block, so if your configuration writes its rules inline,
pasting both is the documented way to lose rules. The panel states it once above
the list; the copied text repeats it on every block, because a `.tf` file is read
with no UI around it. Only security groups expand today.

This needs `npm run tf-import` to have been run at least once. The block is
gated on Terraform state being loaded on purpose: with no state imported the
viewer can't tell an unmanaged resource from one whose stack you simply haven't
imported yet, so it stays quiet rather than inviting you to adopt something
Terraform already owns. If you see no import block, that's why.

Two things differ from the CLI path, because a scan has no state file to read:

- **The address is a suggestion.** There's no real address to copy, so one is
  synthesised from the resource's name and sanitised to a valid HCL identifier:
  a VPC named `prod-core` becomes `aws_vpc.prod-core`, anything outside
  `[A-Za-z0-9_-]` becomes `_`, and a name that can't start an identifier gets an
  `r_` prefix. Rename it to suit your module — the panel says so.
- **The Terraform type isn't always knowable.** A resource's import id isn't its
  id, and its Terraform *type* isn't always determinable either: several atlas
  kinds cover more than one provider resource — `apigw` is REST or HTTP, `lb` is
  `aws_lb` or classic `aws_elb`, `fsx` has four variants, and `dx-vif`,
  `tgw-attachment`, `apigw-vpc-link`, `apigw-domain` and `datasync-location`
  likewise. Where the scanned fields don't identify one, the block is emitted
  **commented out**, naming the candidates. A commented-out block is
  recoverable; a confidently wrong type is not.

**Bulk copy.** The Layers panel's Terraform section has a **Copy N import
blocks** button beside the managed/unmanaged filter, grouped under
`# account … · region …` banners (a bulk paste crossing accounts being exactly
what those comments exist for), with colliding suggested addresses deduped `_2`,
`_3` — every VPC has a security group called `default`.

**N counts blocks, not nodes**, and it is deliberately the larger number: with
nested resources expanded, adopting 11 unmanaged resources can take 17 blocks,
and the number that matters when you paste is the number you are pasting. The
note under the button reconciles it against the unmanaged count directly above —
how many blocks, for how many resources, of which how many are nested — and says
how many pasted commented out. Each parent is followed immediately by its own
children, so a rule never ends up pages away from its group.

## Configuration — `atlas.config.json`

```jsonc
{
  "accounts": [
    { "profile": "prod", "name": "Production" },              // all enabled regions
    { "profile": "dev", "regions": ["eu-west-1"] },           // explicit region list
    { "profile": "sandbox", "excludeRegions": ["us-west-1"] } // discover, then exclude
  ],
  "emptyRegions": "exclude",   // or "annotate" to show them greyed-out
  "regionConcurrency": 4
}
```

Regions with nothing beyond an untouched default VPC count as *empty*; excluded ones are
listed in the snapshot (and shown as a note in the overview) so nothing disappears silently.

## Commands

| Command | What it does |
| --- | --- |
| `npm run scan` | Verify AWS CLI + credentials, scan accounts (read-only), write snapshots, rebuild `site/data/` |
| `npm run bundle` | Rebuild `site/data/` from committed snapshots + annotations + Terraform stacks only |
| `npm run tf-import` | Import Terraform state file(s) → `data/terraform/<stack>.json`, rebuild `site/data/` |
| `npm run tf-blocks` | Generate Terraform `import` blocks from state file(s) → stdout, or `--out <file>`; writes nothing into this repo |
| `npm run fixture` | Regenerate the synthetic demo estate (no AWS needed) into `site/data/` |
| `npm run dev` | Viewer dev server with hot reload (uses the same `site/data/`) |
| `npm run build` | Rebuild the committed single-file viewer `site/index.html` |
| `npm run serve` | Serve the built viewer over http (fallback if you'd rather not use `file://`) |
| `npm run typecheck` | Typecheck all packages |
| `npm run coverage` | Regenerate the full-estate coverage audit (`docs/coverage.html`) |

## What gets committed

| Path | Owner | Notes |
| --- | --- | --- |
| `data/accounts/*.json` | scanner | Deterministic (sorted keys/arrays) → clean diffs per scan |
| `data/terraform/*.json` | `tf-import` | Identifiers only (address/type/id/arn/importId) — never state attribute values |
| `site/data/*.js` | scanner | Derived data bundle the viewer loads |
| `site/index.html` | `npm run build` | The whole viewer, one file |
| `annotations/*.yaml` | **you** | Your notes, links to Terraform, etc. |
| `atlas.config.json` | **you** | Accounts/regions to scan |

## Read-only guarantee

The scanner only ever calls `Describe*`, `List*`, `Get*`, and `Search*` APIs
(plus `sts:GetCallerIdentity`). It never mutates anything, and it never reads secret
**values** — Secrets Manager is captured by metadata only (`ListSecrets`), never
`GetSecretValue`. Scan errors from missing permissions are recorded per region in the
snapshot (`errors[]`) and the scan continues, so a partial-access role still produces a
useful diagram. The `ReadOnlyAccess` (or `SecurityAudit` + read) managed policy covers
everything here.

## Least-privilege IAM policy

If you'd rather not hand the scanner the broad AWS-managed `ReadOnlyAccess`
policy, [`iam-policy.json`](iam-policy.json) grants **exactly** the read actions
this tool calls — nothing more. It's derived directly from the scanner's AWS SDK
command set (every collector under `packages/scanner/src/collect/`, plus preflight
and region discovery), grouped by service into per-service read-verb wildcards
(`Describe*` / `Get*` / `List*`, plus `ec2:Search*` and `inspector2:BatchGet*`), so
it stays strictly read-only and doesn't need editing every time a collector adds
another `Describe` call.

- **Coverage** — 62 IAM service prefixes. The scanner's 63 `@aws-sdk/client-*`
  packages collapse to 59 prefixes (DocumentDB and Neptune both authorize their
  control-plane `Describe*` calls via `rds:`; API Gateway v1/v2 share `apigateway:`;
  ELB v1/v2 share `elasticloadbalancing:`), plus `cloudformation`, `athena`, and
  `kinesis`. Those last three aren't called directly: the Cloud Control sweep
  (`cloudcontrol:ListResources`) proxies them, and Cloud Control needs the
  underlying service's own read permission to enumerate its resources.
- **No data-plane reads** — deliberately excludes `s3:GetObject`, `dynamodb:GetItem`,
  `kinesis:GetRecords`, and `secretsmanager:GetSecretValue`. S3 is scoped to
  bucket-configuration reads (`s3:GetBucket*`, `s3:GetEncryptionConfiguration`,
  `s3:ListAllMyBuckets`) and Secrets Manager to `secretsmanager:ListSecrets`.
- **Size** — a single document, ~4.4 KB pretty-printed (~2.9 KB minified), well
  under IAM's 6,144-character managed-policy limit, so it doesn't need splitting.

**Trade-off:** `ReadOnlyAccess` is one click and never goes stale, but it grants
thousands of actions across every AWS service. `iam-policy.json` is tighter and
auditable, at the cost of a manual update if the scanner ever starts calling a
brand-new service. Both are strictly read-only.

Attach it as a customer-managed policy and grant it to the role or user the
scanner runs as:

```bash
aws iam create-policy --policy-name AwsNetworkAtlasScan \
  --policy-document file://iam-policy.json
# then attach the returned policy ARN to your scanning principal, e.g.:
aws iam attach-role-policy --role-name <your-scanning-role> \
  --policy-arn arn:aws:iam::<account-id>:policy/AwsNetworkAtlasScan
```

## Architecture

npm workspaces monorepo:

- **`packages/schema`** — the TypeScript data model shared by scanner and viewer
  (snapshot format, annotations, config). Schema drift is a compile error.
- **`packages/scanner`** — CLI on AWS SDK v3. Collectors for networking, connectivity,
  edge/DNS services, load balancing, workloads, **identity & security (IAM/KMS/ACM/Secrets)**,
  a Resource Groups Tagging sweep, and a **Cloud Control API** sweep for untagged resources.
  Adaptive retry, paginated, per-region concurrency; every step is error-isolated and
  output is deterministically sorted for clean diffs.
- **`packages/tf-import-blocks`** — the per-type `(terraform type, import id)` rule
  table behind `npm run tf-blocks` and the viewer's import blocks, with the
  entry points (from a state file, from a scanned resource, and from a scanned
  resource *plus the terraform resources nested inside it*) as thin adapters onto
  it. It imports nothing from `@atlas/*` and has **no runtime dependencies** —
  not an HCL library, not a YAML parser — because it's expected to move to its
  own repository; lifting it out is `git mv packages/tf-import-blocks` plus a
  `package.json`. It accepts a structural subject
  (`{ kind, id, arn?, name?, region, accountId, raw }`) that the viewer's
  `ResourceRef` already satisfies, so nothing converts between the two.
- **`packages/viewer`** — React + React Flow (@xyflow/react) + ELK auto-layout
  (nested containers laid out in one pass), official AWS Architecture Icons,
  MiniSearch, react-markdown. Built with Vite into a single offline-capable HTML file.
  `graph-check.mts` asserts every rendered edge resolves to a real node (React Flow
  silently drops dangling edges) — run it with `npx tsx packages/viewer/graph-check.mts`.

## License

[MIT](LICENSE) © Ben Ralton.

### Third-party assets

This project renders the official **AWS Architecture Icons** (via the
[`aws-icons`](https://www.npmjs.com/package/aws-icons) package). The icon
artwork is © Amazon Web Services and is used under AWS's grant to customers and
partners to create architecture diagrams; it is **not** covered by the MIT
license above and remains subject to the
[AWS Site Terms](https://aws.amazon.com/terms/) and
[AWS Trademark Guidelines](https://aws.amazon.com/trademark-guidelines/). Do not
redistribute the icons as a standalone set or imply AWS endorsement.

Bundled runtime dependencies (React, Vite, React Flow, elkjs, MiniSearch,
react-markdown, the AWS SDK for JavaScript, …) are licensed under their
respective MIT / Apache-2.0 / EPL-2.0 terms.
