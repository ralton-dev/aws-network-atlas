# AWS Network Atlas

Scan AWS accounts **read-only** and render an accurate, interactive, **committable** network
diagram — plus a searchable inventory of everything in the account.

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
- Read-only credentials (e.g. the `ReadOnlyAccess` managed policy, or `SecurityAudit`)

## Quick start

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

## The viewer

- **Overview** — accounts ▸ regions ▸ VPCs, with transit gateways, peering, VPN, and
  Direct Connect links between them. Edges are annotated with the routed CIDRs.
- **Drill-down** — double-click a VPC to open its detail diagram: AZs ▸ subnets
  (public/private per the route tables) with the workloads inside them (EC2, RDS, NAT,
  endpoints…) and route-derived arrows (subnet → NAT/IGW/TGW/peering) labelled with
  destinations. Click any edge for the full per-subnet route breakdown.
- **Search** — fuzzy search across names, IDs, ARNs, tags, and your annotations.
- **Inventory** — every resource found by the full-account sweep, grouped by
  account ▸ region ▸ service, including things that aren't on the network diagram.
- **Details panel** — click anything; shows properties, tags, and your notes.

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
| `npm run bundle` | Rebuild `site/data/` from committed snapshots + annotations only |
| `npm run dev` | Viewer dev server with hot reload (uses the same `site/data/`) |
| `npm run build` | Rebuild the committed single-file viewer `site/index.html` |
| `npm run typecheck` | Typecheck all packages |

## What gets committed

| Path | Owner | Notes |
| --- | --- | --- |
| `data/accounts/*.json` | scanner | Deterministic (sorted keys/arrays) → clean diffs per scan |
| `site/data/*.js` | scanner | Derived data bundle the viewer loads |
| `site/index.html` | `npm run build` | The whole viewer, one file |
| `annotations/*.yaml` | **you** | Your notes, links to Terraform, etc. |
| `atlas.config.json` | **you** | Accounts/regions to scan |

## Read-only guarantee

The scanner only ever calls `Describe*`, `List*`, `Get*`, and `Search*` APIs
(plus `sts:GetCallerIdentity`). It never mutates anything. Scan errors from missing
permissions are recorded per region in the snapshot (`errors[]`) and the scan continues.

## Architecture

npm workspaces monorepo:

- **`packages/schema`** — the TypeScript data model shared by scanner and viewer
  (snapshot format, annotations, config). Schema drift is a compile error.
- **`packages/scanner`** — CLI on AWS SDK v3. Detailed collectors for all networking
  primitives (VPC, subnets, route tables, TGW + route tables, peering, VPN, DX, ELB, …)
  and network-placed workloads, plus a Resource Groups Tagging API sweep for the
  full "everything" inventory. Adaptive retry, paginated, per-region concurrency.
- **`packages/viewer`** — React + React Flow (@xyflow/react) + ELK auto-layout
  (nested containers laid out in one pass), official AWS Architecture Icons,
  MiniSearch, react-markdown. Built with Vite into a single offline-capable HTML file.

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
