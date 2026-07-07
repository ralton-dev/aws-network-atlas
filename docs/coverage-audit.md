# Scanner coverage audit — what's missing

> **Implementation status (2026-07-07):** everything in §1–§4 plus most of §5 is now
> IMPLEMENTED on this branch — Network Firewall policies/rule groups/TLS configs/logging/
> endpoint sync-states, WAF v2 (both scopes), ALB listener rules + certificates, DNS
> Firewall + query-log configs, Client VPN routes/authz, VPC endpoint policies, VPN static
> routes, RAM-shared prefix-list entries, DX connections/LAGs/VIFs, PrivateLink provider
> side, Cloud WAN, Global Accelerator, API GW VPC links + custom domains, Lambda function
> URLs, flow logs, DHCP options, VPC DNS attributes, Instance Connect endpoints, Route 53
> record sets, TGW propagations/Connect peers, VPC Lattice, CloudWatch log groups, EFS,
> OpenSearch, MSK, Redshift, MQ, RDS Proxy, ElastiCache replication groups + serverless,
> classic ELB instances, CloudFront origin detail + VPC origins, and the Cloud Control
> Kinesis/Firehose types.
>
> **Deliberately deferred** (rare or fiddly; still open): Outposts local gateways /
> Wavelength carrier gateways, Verified Access, IPAM + subnet CIDR reservations, TGW
> multicast domains & policy tables, Shield Advanced / Firewall Manager, ECS standalone
> tasks, EKS node groups / Fargate profiles, per-bucket S3 public-access checks
> (regional-endpoint redirects), Route 53 health checks, per-CIDR SG rule descriptions
> (`DescribeSecurityGroupRules`), and legacy WAF Classic.
>
> Note: new resource kinds surface in the viewer's search/inventory/details/focus panels;
> first-class graph rendering (e.g. drawing the firewall policy chain on the canvas)
> remains viewer follow-up work.

Audit date: 2026-07-07. Method: every collector in `packages/scanner/src/collect/` was read
line-by-line and the exact set of AWS API calls made was compared against the AWS networking
surface. The trigger was a real-account finding: **the Network Firewall shows up, but none of
its policy, rule groups, or rules do** — this audit confirms that gap, explains it, and lists
every other one found.

Legend for each item: the missing API calls, why it matters, and where it would hook in.

---

## 1. Confirmed: Network Firewall is a shell (P0)

`collect/edge-network.ts` calls only `ListFirewalls` + `DescribeFirewall`. That yields the
firewall's name, VPC, subnets, and the **ARN** of its policy — and stops. Missing:

| Missing call | What it loses |
|---|---|
| `DescribeFirewallPolicy` (per `firewallPolicyArn`) | The policy itself: stateless/stateful **rule-group references** (with priorities), stateless default actions, stateful engine options (strict vs action order), TLS inspection config ref. |
| `ListRuleGroups` + `DescribeRuleGroup` | **Every rule group and every rule**: stateless rules (match attrs + actions), stateful 5-tuple/domain-list/Suricata rules, rule variables, capacity. Rule groups not referenced by any policy are also invisible today. |
| `DescribeLoggingConfiguration` (per firewall) | Where flow/alert/TLS logs go (S3 / CloudWatch / Firehose) — audit-relevant. |
| `ListTLSInspectionConfigurations` + `DescribeTLSInspectionConfiguration` | TLS inspection (decrypt/re-encrypt) configs. |

**Bonus routing bug hiding in the same collector:** `DescribeFirewall` returns
`FirewallStatus.SyncStates`, which contains the **per-AZ firewall endpoint IDs**
(`Attachment.EndpointId`, `vpce-…`) and attachment subnets. The collector keeps only
`FirewallStatus.Status` (a string) and throws the sync states away. Those `vpce-…` endpoints
are exactly what inspection route tables point at, so today a route through the firewall
renders as a route to an anonymous VPC endpoint — the atlas cannot attribute the hop to the
firewall. Capturing `SyncStates` closes the loop between route tables and the firewall.

---

## 2. P0 — rules/config for things the atlas already draws

These are the same shape as the firewall gap: the *container* is rendered, its *contents* are not.

### 2.1 WAF (missing entirely — no `@aws-sdk/client-wafv2` dependency)
CloudFront distributions store `webAclId`, but the Web ACL itself is never fetched, and
regional WAF (on ALBs, API Gateways, AppSync) isn't touched at all.
- `wafv2 ListWebACLs` (scope `REGIONAL` per region + `CLOUDFRONT` once in us-east-1), `GetWebACL`
- `ListResourcesForWebACL` / `GetWebACLForResource` — which ALBs/APIs each ACL protects
- `ListRuleGroups` + `GetRuleGroup`, `ListIPSets`/`GetIPSet`, `ListRegexPatternSets`
- Optionally classic WAF/WAF-regional for legacy estates.

### 2.2 ALB listener **rules** (`collect/elb.ts`)
`DescribeListeners` is called, but only `DefaultActions` are read. Any ALB using host/path/header
routing forwards most of its traffic via **listener rules**, which need
`elbv2 DescribeRules` per listener. Today those target groups appear orphaned and the
ALB → target-group graph is wrong for any non-trivial ALB. Also missing:
`DescribeListenerCertificates` (SNI certs beyond the default) and listener actions other than
forward (redirect / fixed-response / authenticate-oidc|cognito).

### 2.3 Route 53 Resolver **DNS Firewall** (`collect/edge-network.ts`)
Resolver endpoints and rules are collected; DNS Firewall — the *other* rules engine in the
same service — is not:
- `ListFirewallRuleGroups`, `ListFirewallRules`, `ListFirewallRuleGroupAssociations` (→ VPCs),
  `ListFirewallDomainLists`/`ListFirewallDomains`.
Also missing from Resolver: `ListResolverQueryLogConfigs` + associations.

### 2.4 Client VPN routes & authorization rules (`collect/edge-network.ts`)
Endpoints and target networks are collected, but the endpoint's own routing/authz layer isn't —
directly relevant to "what routing has been missed":
- `ec2 DescribeClientVpnRoutes` — the CVPN endpoint's route table
- `ec2 DescribeClientVpnAuthorizationRules` — which client CIDRs may reach which networks
- (endpoint detail already carries auth options / connection log config if wanted)

### 2.5 VPC endpoint policies (`collect/network.ts`)
`DescribeVpcEndpoints` already returns `PolicyDocument`; it's simply dropped. Gateway-endpoint
policies (S3/DynamoDB) are a common security control. Zero extra API calls to add it.

### 2.6 VPN connection static routes & tunnel options (`collect/network.ts`)
`DescribeVpnConnections` already returns `Routes` (static routes) and `Options`
(`StaticRoutesOnly`, tunnel inside CIDRs, local/remote IPv4 network CIDRs) — all dropped today.
Again zero extra calls.

---

## 3. P1 — missing routing / topology sources

### 3.1 Direct Connect is gateways-only (`collect/global.ts`)
Only `DescribeDirectConnectGateways` + associations are collected. The physical/logical path is
invisible:
- `DescribeConnections`, `DescribeLags` — the physical circuits (location, bandwidth, state)
- `DescribeVirtualInterfaces` — **the VIFs**: private/transit/public, VLAN, BGP ASN/peers,
  which connection they ride, which DX gateway they attach to. Without VIFs there is no
  actual on-prem ↔ AWS edge in the diagram, just a floating DX gateway.
- Note: these are regional APIs (per DX location's home region), unlike the gateway list.

### 3.2 PrivateLink provider side
The consumer side (`DescribeVpcEndpoints`) is collected; endpoint **services this account
exposes** are not:
- `ec2 DescribeVpcEndpointServiceConfigurations` — own services, their NLB/GWLB backends
- `DescribeVpcEndpointConnections` — who is connected in from other accounts
- `DescribeVpcEndpointServicePermissions` — allowed principals
This is a whole class of cross-account edges the atlas currently can't draw.

### 3.3 Cloud WAN / Network Manager
`mapRoute()` in `collect/network.ts` already recognizes `CoreNetworkArn` route targets, but no
collector exists (no `@aws-sdk/client-networkmanager` dependency), so any estate on Cloud WAN
gets routes pointing at a ghost. Needed (global service, us-west-2 endpoint):
`ListCoreNetworks`/`GetCoreNetwork`(+policy), `ListAttachments`, global networks/sites/links.

### 3.4 Global Accelerator (missing entirely)
A public entry point that routes straight to ALBs/NLBs/EIPs across regions — a first-class
"internet → workload" path like CloudFront, and completely invisible today.
`ListAccelerators`, `ListListeners`, `ListEndpointGroups` (global API, us-west-2).

### 3.5 API Gateway VPC links & custom domains (`collect/edge-network.ts`)
- `apigateway GetVpcLinks` (v1 → NLB ARNs) and `apigatewayv2 GetVpcLinks` (v2 → subnets/SGs):
  the piece that connects an API to the VPC interior. Missing today, so private integrations
  dead-end.
- `GetDomainNames` (+ v1 `GetBasePathMappings` / v2 `GetApiMappings`): without them, DNS
  records pointing at custom API domains can't be stitched to the API.

### 3.6 Lambda function URLs & permissions (`collect/compute.ts`)
`ListFunctionUrlConfigs`/`GetFunctionUrlConfig` — public HTTPS entry points to Lambdas
(auth type NONE = open to the internet). Cheap and security-relevant.

### 3.7 VPC plumbing not collected (`collect/network.ts`)
- `DescribeFlowLogs` — which VPCs/subnets/ENIs have flow logs and where they deliver.
  A top-3 network-audit question.
- `DescribeDhcpOptions` (+ VPC association) — custom DNS servers explain a lot of traffic.
- `DescribeVpcAttribute` (`enableDnsSupport`/`enableDnsHostnames`) — needed to know whether
  private-DNS endpoints actually resolve. Per-VPC, 2 calls each.
- `DescribeCarrierGateways`, `DescribeLocalGatewayRouteTables`(+VPC associations, +routes) —
  `mapRoute()` already emits `carrier` and `localGateway` targets with no matching resources
  (Wavelength/Outposts estates only).
- `GetSubnetCidrReservations`; EC2 IPAM (`DescribeIpamPools` etc.) — lower priority.
- VPC Block Public Access (`DescribeVpcBlockPublicAccessOptions`/`-Exclusions`) — new-ish,
  changes IGW/EIGW reachability semantics globally.

### 3.8 Route 53 record sets (`collect/global.ts`)
Zones are collected with a record *count* only. Without `ListResourceRecordSets`
(at least A/AAAA/CNAME/ALIAS), DNS names can't be stitched to ALBs, CloudFront, APIs, or
accelerators. Needs care with the ~5 rps Route 53 limit and very large zones (cap + annotate).
Also `ListHealthChecks` for failover routing.

### 3.9 Transit Gateway secondary surfaces (`collect/tgw.ts`)
Core TGW coverage is good. Missing: `DescribeTransitGatewayConnectPeers` (GRE/BGP peers on
`connect` attachments — the attachment shows up, its peers don't), TGW **policy tables**
(`DescribeTransitGatewayPolicyTables`), multicast domains, and
`GetTransitGatewayRouteTablePropagations` (associations are collected; propagations are not,
so you can't see *why* a propagated route exists).

### 3.10 VPC Lattice (missing entirely)
`ENDPOINT_TYPES` already whitelists `ServiceNetwork`/`Resource` endpoint types, but there is no
Lattice collector: `ListServiceNetworks`, `ListServices`, service-network VPC associations,
target groups. Any Lattice estate is invisible.

---

## 4. P2 — VPC-attached services visible only as anonymous ENIs

The ENI sweep catches their network interfaces, but nothing attributes them, so they render as
unexplained ENIs with SGs. Dedicated collectors (each cheap) would make them first-class:

- **EFS** — `DescribeFileSystems` + `DescribeMountTargets` (+ SGs): mount targets are classic
  "mystery ENIs".
- **OpenSearch** — `ListDomainNames` + `DescribeDomains` (VPC options, SGs, endpoints).
- **MSK** — `ListClustersV2` (subnets, SGs, broker endpoints).
- **Redshift** — `DescribeClusters` (+ subnet groups, SGs, publicly accessible flag).
- **Amazon MQ** — `ListBrokers`/`DescribeBroker` (subnets, SGs, public accessibility).
- **RDS Proxy** — `DescribeDBProxies` (+ target groups): sits in subnets with SGs.
- **ElastiCache serverless** — `DescribeServerlessCaches`; also `DescribeReplicationGroups`
  for a cleaner Redis topology than node-level cache clusters.
- **EC2 Instance Connect Endpoints** — `DescribeInstanceConnectEndpoints`.
- **Verified Access** — instances/endpoints/groups (zero-trust ingress; newer estates).
- DocumentDB/Neptune already surface through the RDS API (engine `docdb`/`neptune`) — fine.

---

## 5. Smaller correctness/completeness notes found on the way

1. **RAM-shared prefix lists lose their entries** (`collect/network.ts`): entries are fetched
   only when `pl.OwnerId === accountId`. The AWS-managed-list rationale in the comment doesn't
   apply to lists shared from a sibling account via RAM, which are routinely referenced in SG
   rules and routes — they're typically small and their entries are exactly what you need for
   an atlas. Better test: skip only `AWS`-owned lists, or cap entries.
2. **SG rule descriptions are lossy** (`mapSgRules`): one description is picked per permission
   block (first CIDR/SG that has one); per-CIDR descriptions are merged away. Consider
   `DescribeSecurityGroupRules`, which also yields stable rule IDs.
3. **Classic ELB**: instances/health (`DescribeInstanceHealth`) and SG/subnet detail are
   collected, but not the registered instances — classic ELBs render with no targets.
4. **NAT/route data is fine**, but `DescribeAddresses` isn't paginated (it doesn't paginate —
   OK) and `DescribeVpnGateways`/`DescribeCustomerGateways`/`DescribeVpnConnections` likewise
   (also non-paginating APIs — OK). No action.
5. **ECS**: only *services* are collected; standalone tasks (`ListTasks`/`DescribeTasks`) with
   `awsvpc` ENIs and public IPs are invisible except as anonymous ENIs.
6. **EKS**: cluster only; node groups and Fargate profiles (subnets) aren't attributed.
7. **CloudFront**: origins are captured as bare domain names. Origin config (S3 vs custom,
   OAC/OAI, origin path) and **VPC origins** (CloudFront → private ALB/NLB/EC2, GA 2024) are
   not; VPC origins are a genuine topology edge when used. Continuous deployment/staging
   distributions and CloudFront Functions are inventory-only concerns.
8. **S3**: names only. For a security atlas, `GetPublicAccessBlock`/`GetBucketPolicyStatus`
   ("is this bucket public?") is the one bit worth adding; website endpoints feed the
   CloudFront origin edge.
9. **Cloud Control sweep type list** (`collect/cloudcontrol.ts`) could cheaply add types like
   `AWS::EFS::FileSystem`, `AWS::MSK::Cluster`, `AWS::GlobalAccelerator::Accelerator` as a
   stopgap until dedicated collectors exist — but they'd land in `generic` (search only),
   not the graph.

---

## 6. Suggested implementation order

| Wave | Items | Rationale |
|---|---|---|
| 1 | §1 Network Firewall policy/rule groups/logging + SyncStates endpoint IDs | The reported bug; makes existing firewall node meaningful and fixes route attribution. |
| 2 | §2.2 ALB listener rules; §2.5 endpoint policies; §2.6 VPN static routes (both are dropped fields, zero new calls) | Biggest correctness wins per line of code. |
| 3 | §2.1 WAF v2; §2.3 DNS Firewall; §2.4 Client VPN routes/authz | Completes the "rules for rendered resources" class. |
| 4 | §3.1 DX VIFs/connections; §3.2 PrivateLink provider side; §3.5 API GW VPC links/domains; §3.4 Global Accelerator | Missing topology edges. |
| 5 | §3.7 flow logs/DHCP/VPC attrs; §3.8 Route 53 records; §3.9 TGW extras; §3.6 Lambda URLs | Audit depth. |
| 6 | §4 workload attribution; §3.3 Cloud WAN; §3.10 Lattice; the rest of §5 | As estates need them. |

Each new resource kind needs: schema type (`packages/schema/src/snapshot.ts`), collector,
`emptyRegionSnapshot`/`emptyGlobal` entry, deterministic sort in the derive step, fixture
coverage, and (for graph-worthy kinds) viewer support — the scanner half is the smaller part.
