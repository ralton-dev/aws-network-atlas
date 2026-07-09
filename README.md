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

**Only identifiers leave the state file** — address, type, `id`, `arn`. State
attribute values (which routinely contain DB passwords and the like) are never
persisted; what's written to `data/terraform/<stack>.json` is committable.

On the diagram, every resource claimed by an imported stack gets the Terraform
mark on its icon, and its details panel shows the resource address, stack, and a
link to the repo. Resources *not* claimed by any imported stack are called out
as such — ClickOps drift, visible at a glance — and the Layers panel gains a
filter to show only Terraform-managed or only unmanaged resources. The import
also prints a match report: state entries the scanner couldn't find (stale state
or an uncollected resource type) are listed per stack.

Matching is by ARN, falling back to the AWS-native id — the same convention the
AWS provider uses for its `id` attribute, so VPCs, subnets, instances, buckets,
and ARN-only resources (Lambda, SNS, IAM…) all join without per-type rules.
Relationship-only resources (`aws_route`, `aws_security_group_rule`,
attachment/association resources) have synthetic ids that don't correspond to a
drawable resource; they're imported but simply never match a node.

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
| `data/terraform/*.json` | `tf-import` | Identifiers only (address/type/id/arn) — never state attribute values |
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
