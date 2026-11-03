---
name: atlas-propose
description: Design a planned change to a scanned AWS estate in the aws-network-atlas repo (VPCs, subnets, security groups, route tables, transit gateway attachments, peerings, new accounts…) and write it as a proposal, proposals/<name>.yaml, that the Atlas viewer draws on top of the scanned diagram as added, removed and changed. Use when the user asks to "propose", "plan", "sketch", "what would it look like if we added/removed/changed…", or names a new account, VPC, spoke, subnet, attachment or SG rule they want to see drawn against the real estate. Validates with `npm run propose -- validate` until clean. Not for scanning AWS, generating Terraform, or editing the scanned data.
---

# Write an Atlas proposal

A **proposal** is a YAML file, `proposals/<name>.yaml`, that lists operations
(`add`, `change`, `remove`) against the scanned estate. The viewer applies them to
the scan, diffs the two, and draws the result. You write the YAML, run the
validator until it is clean, and bundle it for the viewer. You never touch the
scanned data.

Everything you need is in this repository. Run every command from the **repo
root** (the directory holding `package.json`, `proposals/`, `site/`). Paths you
pass to the CLI resolve against the directory you run `npm` from.

## Hard rules

- **Never run `npm run bundle`, `npm run scan`, `npm run fixture` or
  `npm run build`.** `bundle` rebuilds `site/data/data.js` from `data/`, which
  usually does not exist in the checkout, and silently replaces the estate with
  zero accounts. `scan` calls AWS. `fixture` and `build` rewrite committed files.
  The only commands this skill runs are `npm run describe`, `npm run propose --
  validate` and `npm run propose -- bundle`, plus the read-only query below.
- **Never edit, and never `cat`, `site/data/data.js`** (or `annotations.js` and
  `terraform.js`). It is one large JSON string; use `describe` and the query.
- **Never invent an id for something that already exists.** Every existing
  resource you name is copied verbatim from `describe` or the query. Every
  resource you *create* has an id starting `proposed-`. If you cannot find the
  real id of something the request depends on, ask the user. Do not guess.
- You write exactly two files: `proposals/<name>.yaml` and (by running
  `npm run propose -- bundle`) `site/data/proposals.js`. Compare `git status
  --short` with the one you took in step 1. If anything else changed, stop
  and say so.

## 1. Look at the estate

```sh
git status --short                          # note what is already dirty: it is not yours
test -f site/data/data.js && echo ok      # a scan or the demo fixture must be present
test -d node_modules || npm install         # only when dependencies are missing
npm run --silent describe                   # the whole estate, ~2 KB per account
npm run --silent describe -- --account acme-prod   # one account, by id or alias
```

If `site/data/data.js` is missing, stop and tell the user the repo needs a scan
(`npm run scan`, which they run, not you) before a proposal can be designed.
If `npm install` rewrites `package-lock.json`, do not commit that change.

`describe` prints, per account: id, alias, regions; each VPC with its id, name,
CIDRs, its subnets (id, CIDR, AZ, `public`) and its subnet/SG/endpoint counts;
TGWs with id, name, owner, ASN, default route table (`default-rt tgw-rtb-…`) and
the attachments recorded in that account; peerings with both sides' VPC,
account, region and CIDR; load balancers; hosted zones; the organization tree;
and a closing table of how many resources each collection holds. The header
line `generatedAt: …` is what goes into your proposal's `base.generatedAt`.

**What `describe` does not print** (and `--json` does not either; it is the same
data, structured): route tables and their routes, internet and NAT gateway ids,
security group ids and rules, VPC endpoint ids, TGW route tables other than the
default, RAM shares, and which accounts are only referenced (not scanned). For
any of those, query the collection by name. This reads `site/data/data.js`
through the repo's own parser, read-only:

```sh
npx tsx -e '
import { readFileSync } from "node:fs";
import { readSiteData } from "@atlas/proposal/read";
const [collection, account] = process.argv.slice(1);
const snap = readSiteData(readFileSync("site/data/data.js", "utf8"));
for (const a of snap.accounts) {
  if (account && a.accountId !== account && a.alias !== account) continue;
  const scopes = [...(a.regions ?? []).map((r) => [r.region, r]), ["global", a.global ?? {}]];
  for (const [region, s] of scopes) for (const item of s[collection] ?? []) console.log(JSON.stringify({ account: a.accountId, region, ...item }));
}' securityGroups acme-prod
```

The first argument is a collection name from `describe`'s counts table
(`routeTables`, `securityGroups`, `internetGateways`, `natGateways`,
`transitGatewayRouteTables`…). The second (optional) is an account id or alias.
Each line is one resource with the `account` and `region` it lives in. Those two
keys come from the query, not from the resource. Do not copy them into a
`resource:`.

A shared resource (a TGW shared by RAM, a cross-account attachment, a peering)
appears once in **each** account that sees it. It is still one resource with one
id.

## 2. Turn the request into operations

Restate the request as a list of resources to add, change or remove. Name each
one by its **collection**, which is the snapshot's own field name, the same word
`describe`'s counts table uses: `vpcs`, `subnets`, `routeTables`,
`securityGroups`, `transitGatewayAttachments`, `peeringConnections`,
`hostedZones`… A collection is either per-region (the region's name goes in
`region:`) or account-global (`region: global`): the counts table's `region` and
`global` rows tell you which.

For every collection you touch, read its TypeScript type in
`packages/schema/src/snapshot.ts`. The collection's name and its type's name
differ (`vpcs` → `Vpc`, `transitGatewayAttachments` →
`TransitGatewayAttachment`), so find the type through the region's field list:

```sh
grep -n "  transitGatewayAttachments:" packages/schema/src/snapshot.ts   # → TransitGatewayAttachment[]
sed -n '/^export interface TransitGatewayAttachment /,/^}/p' packages/schema/src/snapshot.ts
sed -n '/^export type TgwAttachmentResourceType/,/;$/p' packages/schema/src/snapshot.ts   # a union
```

**Follow every type a field names, too.** `RouteTable.routes` is a `Route[]`,
`Route.targetType` is the `RouteTargetType` union, `SecurityGroup.ingress` is a
`SecurityGroupRule[]`, `TransitGatewayRouteTable.routes` is a
`TransitGatewayRoute[]`, and `tags` is `Tags` (a string map). Print each one the
same way. A union's quoted strings are the only values allowed.

The fastest way to get a field right is to copy the shape of a scanned resource
of the same kind with the query in step 1. Then change its values.

Every type extends `BaseResource` (`id`, optional `arn`, optional `name`,
`tags`). **Write every field the type does not mark optional (`?`), with its
real type:** `tags: {}`, empty arrays as `[]`, booleans as `true`/`false`. The
validator does not check a resource's fields against the type. A wrong type
passes validation and then misdraws, so watch the YAML traps:

- **Account ids inside a resource are strings too.** Quote them:
  `transitGatewayOwnerId: "222222222222"`, `resourceOwnerId: "555555555555"`,
  `accountId: "…"`, `ownerId: "…"`.
- **Every SG rule's `protocol` is a string.** Write `"-1"` (all protocols),
  `tcp` or `udp`. A bare `-1` is a YAML number.
- **Ports are bare integers.** Write `fromPort: 443`, not `"443"`.
- CIDRs and ids are fine unquoted. Quote anything that would otherwise read as
  a number, a boolean (`yes`, `no`, `on`, `off`) or `null`. Nothing fills in
a missing field for you, and the viewer reads these fields as typed. Do not
invent fields the type does not have.

Where each new resource goes:

- **Its owner's account and region.** A VPC, its subnets, route tables and
  security groups live in the account that owns the VPC.
- **A TGW attachment for a VPC goes in the VPC owner's account**, with
  `resourceType: vpc`, `resourceId` the VPC, `resourceOwnerId` that account,
  `transitGatewayId` the TGW and `transitGatewayOwnerId` the TGW's owner (from
  `describe`: the `owner …` on the TGW line, else the account whose section
  lists the TGW). Add it **once**. A real scan would also show it in the TGW
  owner's account, but a second `add` with the same id is a `duplicate-id` error,
  and one copy is enough for the viewer to draw the edge. The TGW must be in the
  **same region** as the VPC.
- **A new account** goes under `accounts:` with the regions you will add to. Its
  id must not already be in `describe`. It is drawn whenever the proposal is
  open.

Typical shapes for a new networked VPC: `vpcs` → `subnets` (`vpcId` the new VPC,
a CIDR inside the VPC's, `availabilityZone` like `eu-west-1a`, `isPublic` and
`mapPublicIpOnLaunch` false for private) → `routeTables` (`vpcId`,
`subnetAssociations` the subnet ids, a `local` route for the VPC CIDR, plus
routes to whatever the subnet must reach) → `transitGatewayAttachments` →
`securityGroups` (`vpcId`, `ingress`, `egress`, each a list of
`SecurityGroupRule`). Set the subnet's `routeTableId` to the table you add.
A new VPC's first route table is its main table: `isMain: true`. Any further
tables are `isMain: false`.

Routes in a VPC route table name their target by its **own** id:
`targetType: tgw, targetId: <the tgw- id>` (not the `tgw-attach-` id),
`targetType: pcx, targetId: <the pcx- id>`, `targetType: local, targetId:
local` for the VPC's own CIDR. Scanned route tables are the examples: query
`routeTables`.

**Design the whole path, not just the new end.** The validator checks that each
thing exists and is usable. It does **not** check that traffic can actually
flow. So, for every "allow X from Y" or "reach Y":

- **Route forward.** The new VPC's route table sends Y's CIDR to the TGW or
  peering.
- **Route back.** Y's route tables (query `routeTables` for Y's VPC) send the
  new CIDR back the same way: `change` each relevant table, setting its whole
  `routes` array to the existing routes plus yours. Use the subnet tier that
  makes sense (app subnets, not public ones, for an internal service), and say
  which tables you changed in `description`.
- **The TGW route table.** Set the attachment's `associationRouteTableId` to
  the TGW's default route table (`default-rt tgw-rtb-…` on the TGW line in
  `describe`). To keep that table's record honest, also `change` it. Query
  `transitGatewayRouteTables`, then set its `associations` and `propagations`
  to the existing entries plus one for your attachment, and its `routes` to
  the existing routes plus a `propagated` route for the new CIDR.
- **The security group** allows the source's CIDR (see `sg-rule-vpc` below).

Out of scope unless the user asks: organization membership
(`organizationAccounts`) and RAM share principals for a new account. When the
TGW is RAM-shared (query `ramResourceShares`) and the new account is not
covered by the share, say in `description` that it must join the share's OU or
be added as a principal.

When a name in the request is ambiguous (for example "prod" when the prod
account has several VPCs), prefer the VPC in the **same region on the same TGW**
as the new resource. Otherwise ask. Either way, state the choice in
`description` and in your hand-back.

Changing an existing resource: `op: change`, `key:` its real id, `set:` the
fields to replace. **The merge is shallow: each field in `set` replaces the old
value whole.** To add one route or one rule, query the resource, copy its
current array, append yours, and `set` the whole array. `id` and `arn` cannot be
set. To replace a resource, `remove` it and `add` a `proposed-` one.

### Design so that the validator is clean

The validator runs these design rules over the **result** of applying your
proposal. Each one is a warning. Aim for zero, because a warning in a demo
usually means the design is wrong:

| code | warns when | how to stay clean |
| --- | --- | --- |
| `cidr-overlap` | two VPCs joined by a peering **or attached to the same TGW** overlap (every VPC on a TGW counts as joined to every other) | pick a CIDR disjoint from every VPC on that TGW and its peers; read them all from `describe` |
| `subnet-in-vpc` | a subnet's `cidrBlock` is not inside its VPC's `cidrBlocks` | carve subnets from the VPC block |
| `attachment-locality` | an attachment's VPC, subnets or TGW are in another region or account than the attachment says | the attachment's account, `resourceOwnerId` and region match the VPC's; the TGW is in that region; `subnetIds` are in that VPC; `transitGatewayOwnerId` is the TGW's owner |
| `sg-rule-vpc` | an SG rule's `securityGroupRefs` names a group in a different VPC that is not joined by a **same-region peering**. A group reached **through a TGW still warns** | for "allow X from <another VPC or account>" across a TGW, write a **CIDR** rule (`cidrs: [<that VPC's CIDR from describe>]`), not an SG reference |
| `route-target` | a route's `targetId` does not exist, or the route table's VPC cannot use it (a `tgw` target needs a live attachment of **this** VPC to that TGW; `igw`/`nat`/`vpce` must belong to this VPC; `pcx` must have this VPC as a side) | target only things this VPC is attached to, including the attachment you add |

These rules are the networking core only. Any other kind is applied and drawn
but has no design check.

## 3. Write the file

Name it `proposals/<kebab-name>.yaml`. The file name without `.yaml` is the
proposal's id, which is what goes in the viewer URL. Create `proposals/` if it
does not exist.

```yaml
version: 1                                  # always 1
title: Add a data-platform spoke joined to the core TGW   # one line, shown in the viewer
description: |                              # markdown, optional: why, and any trade-off kept
  Why this change is wanted…
base:
  generatedAt: "2026-07-06T09:20:00.000Z"   # copied from describe's header, quoted
accounts:                                   # only accounts the proposal CREATES; omit otherwise
  - accountId: "555555555555"               # always a quoted string
    alias: acme-data
    regions: [eu-west-1]
changes:                                    # applied in order
  - op: add
    account: "555555555555"                 # quoted; a scanned account or one under accounts:
    region: eu-west-1                       # a region name, or `global` for global collections
    collection: vpcs                        # the snapshot field name
    resource:                               # the schema type's fields
      id: proposed-vpc-data                 # every new id starts `proposed-`
      name: data-vpc
      tags: {}
      cidrBlocks: ["10.3.0.0/16"]
      ipv6CidrBlocks: []
      isDefault: false
  - op: change
    key: rtb-0123456789abcdef0              # an existing (or earlier proposed-) id
    set:                                    # each field replaced whole
      routes: [ ...every existing route..., { ...the new one... } ]
  - op: remove
    key: pcx-0123456789abcdef0
```

Rules the parser enforces:

- **Do not write a top-level `id:`.** The file name is the id.
- Top-level fields are only `version`, `title`, `description`, `base`,
  `accounts`, `changes`. An `add` has only `op`, `account`, `region`,
  `collection`, `resource`; a `change` has only `op`, `key`, `set`; a `remove`
  has only `op`, `key`. Any other field is an error, so a misspelling is caught.
- **Quote every account id** (`"111111111111"`). An unquoted one is a YAML
  number and an error. Quote `generatedAt` too.
- Ids you create: `proposed-<kind>-<name>` (`proposed-vpc-data`,
  `proposed-subnet-data-a`), unique within the file. Refer to them from later
  ops by exactly that string. Forward references are fine.
- Any field named `…Id`, `…Ids`, `…Arn` or `arn` (e.g. `vpcId`, `subnetIds`,
  `transitGatewayId`, `targetId`, `routeTableId`, `groupId`) is checked as a
  reference: it must be a real id from the estate or a `proposed-` id you add.
  `targetId: local` is fine.

## 4. Validate until clean

```sh
npm run --silent propose -- validate proposals/<name>.yaml
npm run --silent propose -- validate proposals/<name>.yaml --strict   # warnings count as errors
```

Each problem prints as one line, then a total:

```
proposals/<name>.yaml: <error|warning> <code> <path>: <message>
N error(s), M warning(s) in 1 proposal
```

`<path>` points into your file: `changes[2].resource.transitGatewayId` is the
third op's resource's `transitGatewayId`; `-` means the file as a whole. Exit
code 1 means at least one error. Loop: fix, re-run, until it exits 0 with **0
error(s), 0 warning(s)**.

**Fix the first error first, then re-run.** One wrong id, such as an `add` whose
id lacks `proposed-` or a typo in a `proposed-` id, makes every later reference
to it an `unresolved-reference` too. The cascade goes away with the first fix.
The design rules run only once there are no errors, so new warnings can appear
after the last error is gone.

| code | meaning | fix |
| --- | --- | --- |
| `malformed` | bad YAML, unknown or missing field, unquoted account id, `id:` at the top | as the message says |
| `unknown-account` | an `add` targets an account neither scanned nor under `accounts:` | add it under `accounts:`, or fix the id |
| `account-exists` | `accounts:` lists an account already scanned | remove it from `accounts:`; just `add` into it |
| `unknown-collection` | no such collection for that scope (the message lists the valid ones) | fix the name, or `region: global` vs a region |
| `missing-id` / `not-proposed-id` | an added resource has no `id`, or one not starting `proposed-` | |
| `duplicate-id` | the id exists already in the estate or earlier in the file | rename it |
| `unresolved-key` | a `change`/`remove` key exists neither in the estate nor in an earlier `add` (ops apply in order) | copy the real id from `describe` or the query |
| `immutable-field` | `set` contains `id` or `arn` | remove and re-add instead |
| `unresolved-reference` (error) | a reference field holds an id that resolves nowhere | copy the real id, or add the `proposed-` resource it names |
| `unknown-reference` (warning) | an id of a kind the scanner does not collect, so it cannot be checked | make sure it is right; mention it in `description` |
| `external-reference` (warning) | an account id, or an id in an account, that is not scanned | expected for links to third parties; say so in `description` |
| `stale` (warning) | `base.generatedAt` differs from the loaded estate's | copy it again from `describe` |
| design-rule codes | see the table in step 2 | change the design |

Fix a warning by changing the design. If the user really wants that design (for
example a deliberate overlap), keep it and explain the warning in
`description`, and tell the user it is there.

## 5. Bundle it for the viewer

```sh
npm run propose -- bundle     # writes site/data/proposals.js from every proposals/*.yaml, and nothing else
git status --short            # compare with step 1
```

The only new entries should be `proposals/<name>.yaml` (shown as `?? proposals/`
when the directory is new) and `site/data/proposals.js` (`??` or ` M`). Lines
that were already there in step 1 are not yours. If `site/data/data.js`,
`annotations.js` or `terraform.js` shows as changed, stop and tell the user.

`bundle` skips (with a message) any proposal file that does not parse, so a
bundle that reports fewer proposals than you expect means a file is broken.
Validate it.

Then tell the user how to see it. The proposal is selected by the URL's
`proposal=<name>` parameter, and `accounts=` picks which scanned accounts are
drawn (accounts the proposal creates are always drawn):

- `npm run dev` starts the viewer (Vite prints the URL; the port varies). Open
  `<that URL>#/?accounts=<ids,comma-separated>&proposal=<name>`.
- `site/index.html` opened directly works the same way **once it has been
  rebuilt with proposal support**. If `grep -c __ATLAS_PROPOSALS__
  site/index.html` prints 0, the committed viewer predates proposals: use
  `npm run dev`, and do not rebuild it yourself.

The bar at the top of the viewer switches between *current*, *proposed* and
*both*. Added things are drawn as added, removed things as removed, changed
things as changed, and the details panel lists every field change.

## 6. Hand back

Tell the user: the file you wrote, a one-line summary per op, the final
validate output (`0 error(s), 0 warning(s)`, or the warnings you kept and why),
the URL to open, and anything you had to assume (a CIDR, an AZ, which of an
account's VPCs "prod" meant). Do not commit unless asked.
