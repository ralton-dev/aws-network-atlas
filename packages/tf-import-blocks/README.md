# tf-import-blocks

Terraform `import` blocks for resources you have but your configuration does not.

**A resource's Terraform identity is a `(type, import-id)` pair produced by a
per-type rule — not its AWS id.** `aws_sqs_queue` imports by queue URL,
`aws_lambda_function` by function name, `aws_ecs_service` by
`cluster-name/service-name`, and `aws_route`'s state id is a synthetic hash that
is never a valid import id at all. Enough types work by accident that a naive
"use the `id`" generator looks correct on a demo and silently emits garbage for
the composite and attachment resources that make up the bulk of a real state.

The rule table in `src/rules/` is this package's asset. The entry points are thin
adapters onto it that differ only in what they can feed it.

| entry point | source | what it has |
| --- | --- | --- |
| `importsFromState(json, label)` | a Terraform state file | real attributes, so composite ids are computable exactly |
| `resolveScanned(subject)` | a scanned AWS resource | only a snapshot, so composite ids must be reconstructed |
| `resolveScannedExpanded(subject)` | the same | plus the terraform resources the snapshot keeps *inside* that one — see [Nested resources](#nested-resources--one-scanned-parent-several-import-blocks) |

Where a type supports both, the two **must produce the same string**.
`test/golden.test.ts` asserts it.

## Deliberately atlas-free

This package imports nothing from `@atlas/*` and has **no runtime dependencies**
— not an HCL library, not a YAML parser. It is expected to move to its own
repository, and lifting it out is `git mv packages/tf-import-blocks` plus a
`package.json`. Do not "simplify" it by reaching into `@atlas/schema`; the
structural `ScannedSubject` in `src/types.ts` exists precisely so the viewer's
`ResourceRef` satisfies it without a converter.

## Only identifiers leave the state file

Rules may **read** any attribute to compute an import id. The emitter writes
only the computed id, the Terraform address, and the account and region the
resource's own ARN disclosed. No attribute value is ever copied into output
unless it *is* the import id. Reading a state to compute an import id does not
put state values in the generated `.tf`.

There is no `provider =` argument in the output — we cannot know your alias
names. Each block carries a `# account <id> · region <region>` comment instead,
because importing into the wrong provider is silent and expensive.

## Unknown types are emitted, never dropped

A type with no rule still gets a block, built from the state's own `id` and
flagged:

```hcl
# VERIFY: no rule for aws_s3_object — import id may not be the state id
import {
  to = aws_s3_object.weird
  id = "acme-assets-eu-west-1/reports/\"q1\"/$${env}/summary.txt"
}
```

Silently skipping a resource during a state move is the worst possible failure;
a wrong-but-flagged block is recoverable. The same applies when a rule exists
but cannot compute an id from the attributes it was given — it says so rather
than guessing.

Escaping is the emitter's job and is not optional: `\` → `\\`, `"` → `\"`,
`${` → `$${` and `%{` → `%%{`. S3 keys, tag values and Route 53 record names all
contain these in the wild, and an unescaped `${` is interpolated by Terraform at
parse time.

## The two shapes of state rule, and why they differ

`src/rules/state.ts` writes rules in one of two shapes, and the difference is
load-bearing:

- **Single-attribute imports** read the documented attribute and fall back to
  the state `id`. The fallback is safe because for these types the provider's
  own `SetId` *is* that attribute — `sqs/queue.go` is `SetId(QueueUrl)` and
  `lambda/function.go` is `SetId(functionName)`, so on the state path plain
  passthrough was already right for both. Naming `url` and `function_name`
  documents *why* it works rather than leaving it to luck. (On the **scanned**
  path those two are wrong, because atlas stores the ARN. That is the other
  half of the rule table's job.)
- **Composite imports** compose strictly and return `undefined` when a part is
  missing — **no `id` fallback at all**. For `aws_route`,
  `aws_security_group_rule`, `aws_ecs_service` and the `aws_wafv2_*` family the
  state id is a synthetic hash or an ARN, a different string entirely, so
  falling back would emit a confident wrong answer. An honest `# VERIFY` is
  recoverable; a plausible wrong id is not.

Three attribute readers exist for reasons worth knowing before you write a rule:

| helper | why |
| --- | --- |
| `str()` (exported from `types.ts`) | the default: a non-empty string |
| `scalar()` | `from_port` is a number and `egress` a boolean, and both are parts of documented ids. `0` and `false` are values, not absences |
| `text()` | `str()` rejects `''`, and a Route 53 apex record imports as `Z4KAPRWWNC7JR__NS` — double underscore and all |
| `bareName()` | `aws_ecs_service.cluster` holds the cluster **ARN** while the import id wants `prod-cluster`. Applied to IAM attachment principals for the same reason |

## Coverage — atlas kinds (from a scanned resource)

**136 of the 139 `kind` values the viewer can build resolve to a rule.** This is
the figure the details panel and the bulk copy depend on, and it is a different
question from the terraform-type count below rather than a restatement of it.
The two overlap in 105 types and neither contains the other: 31 rules are
scanned-only, and the composite and attachment types that dominate a real state
file are never drawn on a graph.

**Derive this figure; do not count it by hand.** `kind` is assigned by four
separate routes in `packages/viewer/src/data.ts` — the local `add()` helper, the
`globalKinds` table, three inline `all.push` calls for `zone`, `dxgw` and `s3`,
and the `generic` literal. A regex over `add('…')` sees only the first: it finds
117 kinds of which all but `ecr-registry` resolve, and so reports **99.1%
against a true 97.8%** — flattering, because two of the three unresolved kinds
are assigned by routes it cannot see. (117 + 21 from `globalKinds` + 4 inline
literals = 142, less the three WAF kinds the viewer builds both regionally and
globally = 139.) The reliable method executes the builder rather than reading
it, and so cannot miss a route:

1. Fill every collection returned by `emptyRegionSnapshot()` and `emptyGlobal()`
   with one item.
2. Run the viewer's `buildIndex()` and take the distinct `kind` off the refs it
   produced.
3. Ask `ruleForKind()` about each; `coveredKinds()` is the same set from the
   other end.

Checked in both directions — `coveredKinds()` names no kind the viewer cannot
build, so a typo in a rule's `kinds` array cannot inflate the count.

### Kinds that resolve to nothing — 3

Each is deliberate. None is "we could not work it out", and all three still emit
a block — commented out, naming the kind — so a bulk copy cannot lose the
resource silently.

| kind | why there is no rule | what to do instead |
| --- | --- | --- |
| `generic` | the Resource Groups Tagging API and Cloud Control sweeps (`collect/generic.ts`, `collect/cloudcontrol.ts`) merge into one collection spanning every service in the estate — the kind is a catch-all for hundreds of AWS types, so no single terraform type can be named for it | the block carries the ARN it was discovered by; read the service and resource out of that and use the rule for its real type |
| `ecr-registry` | `r/ecr_registry.html.markdown` is a **404**: the registry is an account-level singleton and the provider has no resource for it, only configuration attached to it | its three sub-resources do import, all three by the registry id — which is your account id: `aws_ecr_registry_policy`, `aws_ecr_registry_scanning_configuration`, `aws_ecr_replication_configuration` |
| `sso-instance` | `r/ssoadmin_instance.html.markdown` is a **404**: Identity Center instances are exposed as a **data source** only, `d/ssoadmin_instances` | reference it with `data "aws_ssoadmin_instances"` and feed its ARN into the resources that take `instance_arn` — `aws_ssoadmin_permission_set` and the two `aws_ssoadmin_*_attachment` types are covered below |

`generic` has no entry in a rule module at all; the other two are named in
`NO_RULE_KINDS` in `rules/scanned-workload.ts`, and
`test/scanned-workload.test.ts` asserts that list is exactly those two.

### The terraform type is chosen per resource — 8 kinds

`ImportRule.type` is a constant, and for these eight it is the merge key and
nothing else — one atlas kind covers several provider resources and a collected
field decides which. `typeFromScanned` reads that field and is **authoritative
including when it answers `undefined`**, at which point `from-scanned.ts` emits
no type at all rather than the dominant one.

| kind | discriminator | candidates | when it cannot tell |
| --- | --- | --- | --- |
| `apigw` | `protocolType` | `aws_api_gateway_rest_api` (REST), `aws_apigatewayv2_api` (HTTP, WEBSOCKET) | id survives — both import by the bare API id |
| `apigw-vpc-link` | `version` | `aws_api_gateway_vpc_link` (v1), `aws_apigatewayv2_vpc_link` (v2) | id survives — both import by the bare link id |
| `apigw-domain` | `endpointTypes` | `aws_api_gateway_domain_name` (EDGE, PRIVATE), `aws_apigatewayv2_domain_name` | `REGIONAL` is valid on both, so the type is unknowable; the id (the domain name) survives. With **no** `endpointTypes` at all a private domain cannot be ruled out and the id is flagged too |
| `lb` | `lbType` | `aws_lb` (application, network, gateway), `aws_elb` (classic) | **id flagged as well** — `aws_lb` imports by ARN and `aws_elb` by name, so the variants disagree about the id, not just the type |
| `tgw-attachment` | `resourceType` | `aws_ec2_transit_gateway_vpc_attachment`, `_peering_attachment`, `aws_ec2_transit_gateway_connect` | id survives. `vpn` and `direct-connect-gateway` attachments have no attachment resource at all — they are created by `aws_vpn_connection` and `aws_dx_gateway_association` — so they decline here and stay declined |
| `dx-vif` | `vifType` | `aws_dx_private_virtual_interface`, `_public_`, `_transit_` | id survives — all three import by the same `dxvif-…` |
| `fsx` | `fileSystemType` | `aws_fsx_lustre_file_system`, `_windows_`, `_ontap_`, `_openzfs_` | id survives — all four import by the same `fs-…` |
| `datasync-location` | `locationType` | eleven `aws_datasync_location_*` types | **id flagged as well** — the eleven do not share one id form |

**The type and the id fail independently, and two kinds fail the other way
round** — type known, id not:

- `apigw-domain` with `PRIVATE` resolves to `aws_api_gateway_domain_name`, but a
  private custom domain imports by `<name>/<domain_name_id>` and `domainNameId`
  is not collected. Real `to =`, flagged id.
- The four FSx-backed `datasync-location` types resolve exactly, but import by
  `<location-arn>#<fsx-arn>` and the FSx ARN is not in the snapshot
  (`collect/datasync.ts` keeps only `SecurityGroupArns` from
  `DescribeLocationFsx*`). Nor can it be rebuilt from `locationUri`: the doc
  example puts the file system in a *different account*.

### Reading a commented-out block

A block with no type cannot be pasted, so the emitter comments the whole stanza
out rather than guessing at `to =`. This is what one looks like, and the comment
above it is the whole explanation — including whether the id is still good:

```hcl
# account 111122223333 · region eu-west-1
# VERIFY: the terraform resource type could not be determined — atlas kind "apigw-domain" covers several provider resources and the scanned fields do not identify one for this resource, so the block below is commented out. Candidates: aws_api_gateway_domain_name, aws_apigatewayv2_domain_name. The id below is right whichever of those it is
# import {
#   to = <replace with the terraform type and a name, e.g. aws_vpc.main>
#   id = "dev.example.com"
# }
```

Pick the candidate from the console or from what you know of the resource, put
it in `to =` with a name of your choosing, and uncomment. Where the id is also
flagged — the `lb` and `datasync-location` rows above — a second `VERIFY` line
says so, and that one you have to look up.

## Nested resources — one scanned parent, several import blocks

**A scanned resource is not always one terraform resource.** The snapshot nests
some relationships inside the resource they belong to — `SecurityGroup.ingress`
and `.egress` are the live case — while Terraform models each as a resource of
its own with its own import id. Nothing draws them on a graph, so they had
nothing to hang an import block on, and the result was a half-adoption that
looks complete: an `aws_security_group` block you can paste, and rules Terraform
still does not manage.

`resolveScannedExpanded(subject)` returns `{ parent, children }`;
`resolveScannedManyExpanded(subjects)` flattens for `emitBlocks`, **each parent
immediately followed by its own children** — that ordering is the contract, not
an implementation detail. `resolveScanned` is unchanged and never expands, so a
caller that wants one block per subject still gets exactly that.

**Only `sg` expands today.** `NetworkAcl.entries` and `RouteTable.routes` sit on
the same seam and are the obvious next two; nothing else is registered. A kind
with no expander returns no children, so callers can use the expanded form
unconditionally.

### The fan-out is not one child per source

One AWS `IpPermission` is **not** one rule resource per CIDR. From the provider
schema (`internal/service/ec2/vpc_security_group_rule.go`), `cidr_blocks` and
`ipv6_cidr_blocks` conflict with `source_security_group_id` and `self`, while
`prefix_list_ids` conflicts with nothing — so every CIDR-shaped source of one
permission belongs to a **single** resource carrying all of them, and each
referenced security group is a resource of its own.
`r/security_group_rule.html.markdown` documents exactly that with
`sg-4973616163_ingress_tcp_100_121_10.1.0.0/16_2001:db8::/48_…`. A permission
allowing three IPv4 ranges, an IPv6 range, a prefix list and one peer group is
therefore **two** blocks, not six.

### Why the emitted child type is the legacy one

`aws_security_group_rule` opens with `~> **NOTE:** Avoid using the
aws_security_group_rule resource`, recommending
`aws_vpc_security_group_ingress_rule` / `_egress_rule` instead. Those import by
`security_group_rule_id` — an `sgr-…` value that comes from
`DescribeSecurityGroupRules`, a call no collector in this repo makes and a field
the snapshot does not carry. Emitting a guessed `sgr-…` would be precisely the
confidently-wrong block this package exists to prevent, so the legacy composite
type — which composes exactly from fields the scan does hold — is the only
derivable one, and every child block says so rather than leaving the reader to
find out.

Every child block also carries the provider's `!> **WARNING:**`: combining
`aws_security_group_rule` with inline `ingress`/`egress` blocks on the
`aws_security_group`, or with the modern rule resources, "may cause rule
conflicts, perpetual differences, and result in rules being overwritten". That
is the one a reader genuinely needs, because these blocks ship **adjacent to an
`aws_security_group` block** — if the target configuration writes its rules
inline, pasting both is the documented way to lose rules. It stays on every
block: a `.tf` file is read with no UI around it.

A self-referencing rule names its own alternative rather than guessing. AWS
reports it as a `UserIdGroupPair` holding the group's own id, and
`expandIPPermission` issues the same API call for `self = true` and for
`source_security_group_id = <own id>` — a scan cannot tell which the
configuration used, so the id reports what AWS reported and the comment says how
to rewrite it.

### Writing an expander

The contract is in `ExpandedChild` in `src/types.ts`; read it first. In short:
**never throw and never drop** (a relationship you cannot express is a child with
`problem` set, which renders the stanza commented out — a dropped child is
invisible, and nothing in the UI would say it was ever considered); **one
relationship, one side**, because nothing detects a relationship registered on
both ends; and **scanned path only** — a state file already holds these as
first-class resources, so expanding there would emit every one of them twice.
`src/from-state.ts` does not import `src/from-scanned.ts`, and
`test/scanned-expand.test.ts` asserts it.

Expansion is one level: there are no grandchildren, an expander sees only its own
subject and cannot read the rest of the snapshot, and `import` blocks express no
ordering between children.

## Coverage — terraform types (from a state file)

215 terraform types: **211 resolve** and **4 carry an explicit not-importable
note**. Every format was read off
`https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/main/website/docs/r/<page>.html.markdown`
on 2026-08-07, and each rule records its page in `doc`.

> **Re-verifying:** those pages now print the `identity = { … }` form **first**
> and the `id = "…"` form second. This package emits the `id` form only
> (Terraform ≥ 1.5; the identity form needs ≥ 1.12 *and* a provider that
> publishes an identity schema for that resource, and coverage is uneven).
> Scroll past the first `import {` block or read the `terraform import` console
> line underneath it.

### Not importable — 4 types

These are not "we could not work it out". The provider publishes no import for
them. They still get a block, loudly flagged, so a state move cannot lose the
resource.

| type | what the provider says | what to do instead |
| --- | --- | --- |
| `aws_autoscaling_attachment` | no `## Import` section on the page at all | re-declare the attachment in the target configuration and apply — it is a pure association, so creating it again is not destructive |
| `aws_iam_group_membership` | no `## Import` section on the page at all | `aws_iam_user_group_membership` *does* import (`user/group[/group…]`) and is the per-user replacement |
| `aws_vpn_connection_route` | no `## Import` section on the page at all | re-declare the static route in the target configuration and apply |
| `aws_vpn_gateway_attachment` | states it outright: "You cannot import this resource." | attach from the target configuration, or use `aws_vpn_gateway`'s own `vpc_id` argument |

### Deliberately not registered — 1 type

`aws_s3_object` has no rule **on purpose**. It is `awkward.expected.tf`'s
no-rule case, exercising both the `# VERIFY` fallback and the `${`/quote
escaping above. Registering a rule for it — here or in either scanned rule
module — silently invalidates a golden file that no package owns.
`test/state-rules.test.ts` asserts it stays ruleless.

### Composite ids — 68 types

The ones a naive generator gets wrong. Separators are not interchangeable:
EKS uses `:` where ECS uses `/`, Backup uses `|`, RAM uses `,`, and transit
gateway routes use `_`.

| type | import id |
| --- | --- |
| `aws_route` | `<route_table_id>_<destination>` — CIDR, IPv6 CIDR or prefix-list id |
| `aws_route_table_association` | `<subnet_id\|gateway_id>/<route_table_id>` |
| `aws_security_group_rule` | `<sg_id>_<type>_<protocol>_<from_port>_<to_port>_<source>[_<source>…]` |
| `aws_network_acl_rule` | `<network_acl_id>:<rule_number>:<protocol>:<egress>` |
| `aws_vpc_endpoint_route_table_association` | `<vpc_endpoint_id>/<route_table_id>` |
| `aws_vpc_endpoint_subnet_association` | `<vpc_endpoint_id>/<subnet_id>` |
| `aws_ec2_managed_prefix_list_entry` | `<prefix_list_id>,<cidr>` |
| `aws_ec2_transit_gateway_route` | `<transit_gateway_route_table_id>_<destination_cidr_block>` |
| `aws_ec2_transit_gateway_route_table_association` | `<transit_gateway_route_table_id>_<transit_gateway_attachment_id>` |
| `aws_ec2_transit_gateway_route_table_propagation` | `<transit_gateway_route_table_id>_<transit_gateway_attachment_id>` |
| `aws_ec2_client_vpn_network_association` | `<client_vpn_endpoint_id>,<association_id>` |
| `aws_dx_gateway_association` | `<dx_gateway_id>/<associated_gateway_id>` |
| `aws_volume_attachment` | `<device_name>:<volume_id>:<instance_id>` |
| `aws_lb_listener_certificate` | `<listener_arn>_<certificate_arn>` |
| `aws_lb_target_group_attachment` | `<target_group_arn>,<target_id>[,<port>][,<availability_zone>]` |
| `aws_route53_record` | `<zone_id>_<name>_<type>[_<set_identifier>]` — an empty name gives `Z…__NS` |
| `aws_route53_zone_association` | `<zone_id>:<vpc_id>[:<vpc_region>]` |
| `aws_wafv2_web_acl` | `<id>/<name>/<scope>` — scope from the resource, never from region emptiness |
| `aws_wafv2_ip_set` | `<id>/<name>/<scope>` |
| `aws_wafv2_rule_group` | `<id>/<name>/<scope>` |
| `aws_wafv2_web_acl_association` | `<web_acl_arn>,<resource_arn>` |
| `aws_api_gateway_resource` | `<rest_api_id>/<id>` |
| `aws_api_gateway_deployment` | `<rest_api_id>/<id>` |
| `aws_api_gateway_authorizer` | `<rest_api_id>/<id>` |
| `aws_api_gateway_request_validator` | `<rest_api_id>/<id>` |
| `aws_api_gateway_model` | `<rest_api_id>/<name>` |
| `aws_api_gateway_stage` | `<rest_api_id>/<stage_name>` |
| `aws_api_gateway_gateway_response` | `<rest_api_id>/<response_type>` |
| `aws_api_gateway_usage_plan_key` | `<usage_plan_id>/<key_id>` |
| `aws_api_gateway_method` | `<rest_api_id>/<resource_id>/<http_method>` |
| `aws_api_gateway_integration` | `<rest_api_id>/<resource_id>/<http_method>` |
| `aws_api_gateway_method_response` | `<rest_api_id>/<resource_id>/<http_method>/<status_code>` |
| `aws_api_gateway_integration_response` | `<rest_api_id>/<resource_id>/<http_method>/<status_code>` |
| `aws_api_gateway_base_path_mapping` | `<domain_name>/<base_path>` — an empty base path leaves the trailing slash |
| `aws_apigatewayv2_route` | `<api_id>/<id>` |
| `aws_apigatewayv2_integration` | `<api_id>/<id>` |
| `aws_apigatewayv2_stage` | `<api_id>/<name>` |
| `aws_iam_role_policy_attachment` | `<role>/<policy_arn>` |
| `aws_iam_user_policy_attachment` | `<user>/<policy_arn>` |
| `aws_iam_group_policy_attachment` | `<group>/<policy_arn>` |
| `aws_iam_role_policy` | `<role>:<name>` — colon, not the attachment's slash |
| `aws_iam_user_policy` | `<user>:<name>` |
| `aws_iam_group_policy` | `<group>:<name>` |
| `aws_iam_user_group_membership` | `<user>/<group>[/<group>…]` |
| `aws_ssoadmin_permission_set` | `<arn>,<instance_arn>` |
| `aws_ssoadmin_managed_policy_attachment` | `<managed_policy_arn>,<permission_set_arn>,<instance_arn>` |
| `aws_ssoadmin_account_assignment` | `<principal_id>,<principal_type>,<target_id>,<target_type>,<permission_set_arn>,<instance_arn>` |
| `aws_identitystore_group` | `<identity_store_id>/<group_id>` |
| `aws_identitystore_user` | `<identity_store_id>/<user_id>` |
| `aws_organizations_policy_attachment` | `<target_id>:<policy_id>` |
| `aws_organizations_delegated_administrator` | `<account_id>/<service_principal>` |
| `aws_s3_bucket_versioning` | `<bucket>[,<expected_bucket_owner>]` |
| `aws_s3_bucket_lifecycle_configuration` | `<bucket>[,<expected_bucket_owner>]` |
| `aws_s3_bucket_server_side_encryption_configuration` | `<bucket>[,<expected_bucket_owner>]` |
| `aws_ecs_service` | `<cluster-name>/<service-name>` — **both halves derived**; see below |
| `aws_eks_node_group` | `<cluster_name>:<node_group_name>` — colon, not slash |
| `aws_eks_addon` | `<cluster_name>:<addon_name>` |
| `aws_lambda_alias` | `<function_name>/<name>` |
| `aws_lambda_permission` | `<function_name>[:<qualifier>]/<statement_id>` — the qualifier is glued to the function name, not appended |
| `aws_appautoscaling_target` | `<service_namespace>/<resource_id>/<scalable_dimension>` |
| `aws_appautoscaling_policy` | `<service_namespace>/<resource_id>/<scalable_dimension>/<name>` |
| `aws_dynamodb_table_item` | `<table_name>,<hash-key-value>[,<range-key-value>]` — the values come from the `item` JSON |
| `aws_secretsmanager_secret_version` | `<secret_id>\|<version_id>` |
| `aws_cloudwatch_event_rule` | `<event_bus_name>/<name>` |
| `aws_cloudwatch_event_target` | `<event_bus_name>/<rule>/<target_id>` |
| `aws_glue_catalog_database` | `<catalog_id>:<name>` |
| `aws_glue_catalog_table` | `<catalog_id>:<database_name>:<name>` |
| `aws_cognito_user_pool_client` | `<user_pool_id>/<id>` |
| `aws_ram_resource_association` | `<resource_share_arn>,<resource_arn>` |
| `aws_ram_principal_association` | `<resource_share_arn>,<principal>` |
| `aws_backup_selection` | `<plan_id>\|<id>` — pipe, not slash or comma |

**`aws_ecs_service` is the one to watch.** The state id is the *service* ARN
(`ecs/service.go`: `SetId(Service.ServiceArn)`) and the `cluster` attribute is
the *cluster* ARN, so neither half of `prod-cluster/web` is present as written.
The rule takes the last segment of the cluster ARN, and when `cluster` is absent
falls back to the long-form service ARN `…:service/<cluster>/<service>`. The
pre-2019 short form `…:service/<service>` names no cluster, so it resolves to
`undefined` and a `# VERIFY` rather than a guessed `default`.

### One named attribute — 80 types

The import id is the documented attribute in parentheses, with the state `id` as
a fallback.

`aws_accessanalyzer_analyzer` (analyzer_name), `aws_acm_certificate` (arn),
`aws_api_gateway_domain_name` (domain_name), `aws_api_gateway_rest_api_policy`
(rest_api_id), `aws_autoscaling_group` (name), `aws_backup_vault` (name),
`aws_cloudtrail` (arn), `aws_cloudwatch_event_bus` (name),
`aws_cloudwatch_log_group` (name), `aws_cloudwatch_metric_alarm` (alarm_name),
`aws_cognito_user_pool_domain` (domain), `aws_config_config_rule` (name),
`aws_config_configuration_recorder` (name), `aws_datasync_task` (arn),
`aws_db_instance` (identifier), `aws_db_parameter_group` (name),
`aws_db_subnet_group` (name), `aws_dms_endpoint` (endpoint_id),
`aws_docdb_cluster` (cluster_identifier), `aws_dynamodb_table` (name),
`aws_ecr_lifecycle_policy` (repository), `aws_ecr_repository` (name),
`aws_ecr_repository_policy` (repository), `aws_ecs_cluster` (name),
`aws_ecs_task_definition` (arn), `aws_eip` (allocation_id), `aws_eks_cluster`
(name), `aws_elasticache_cluster` (cluster_id), `aws_elasticache_parameter_group`
(name), `aws_elasticache_replication_group` (replication_group_id),
`aws_elasticache_serverless_cache` (name), `aws_elasticache_subnet_group` (name),
`aws_elasticache_user` (user_id), `aws_elasticache_user_group` (user_group_id),
`aws_globalaccelerator_accelerator` (arn), `aws_glue_crawler` (name),
`aws_glue_job` (name), `aws_iam_account_alias` (account_alias), `aws_iam_group`
(name), `aws_iam_instance_profile` (name), `aws_iam_openid_connect_provider`
(arn), `aws_iam_policy` (arn), `aws_iam_role` (name), `aws_iam_saml_provider`
(arn), `aws_iam_user` (name), `aws_kinesis_firehose_delivery_stream` (arn),
`aws_kinesis_stream` (name), `aws_kms_alias` (name), `aws_lambda_event_source_mapping`
(uuid), `aws_lambda_function` (function_name), `aws_lambda_layer_version` (arn),
`aws_lb` (arn), `aws_lb_listener` (arn), `aws_lb_listener_rule` (arn),
`aws_lb_target_group` (arn), `aws_memorydb_cluster` (name), `aws_msk_cluster`
(arn), `aws_neptune_cluster` (cluster_identifier), `aws_networkfirewall_firewall`
(arn), `aws_networkfirewall_firewall_policy` (arn), `aws_networkfirewall_rule_group`
(arn), `aws_opensearch_domain` (domain_name), `aws_ram_resource_share` (arn),
`aws_rds_cluster` (cluster_identifier), `aws_rds_cluster_instance` (identifier),
`aws_redshift_cluster` (cluster_identifier), `aws_s3_bucket` (bucket),
`aws_s3_bucket_notification` (bucket), `aws_s3_bucket_policy` (bucket),
`aws_s3_bucket_public_access_block` (bucket), `aws_secretsmanager_secret` (arn),
`aws_sfn_state_machine` (arn), `aws_sns_topic` (arn), `aws_sns_topic_subscription`
(arn), `aws_sqs_queue` (url), `aws_sqs_queue_policy` (queue_url),
`aws_vpc_dhcp_options_association` (vpc_id), `aws_vpc_security_group_egress_rule`
(security_group_rule_id), `aws_vpc_security_group_ingress_rule`
(security_group_rule_id), `aws_wafv2_web_acl_logging_configuration` (resource_arn).

Note that `aws_iam_role`, `aws_iam_user`, `aws_iam_group` and
`aws_iam_instance_profile` import by **name** while `aws_iam_policy`,
`aws_iam_saml_provider` and `aws_iam_openid_connect_provider` import by **ARN**.
They are not the same rule.

`aws_eip` deserves a note of its own: the import id is the **allocation id**, so
the rule reads `allocation_id` rather than `id`. An EC2-Classic address whose id
is a bare public IP therefore cannot leak into the output.

### Native id — 60 types

The AWS-native id really is the import id. Verified per type, not assumed.

`aws_api_gateway_api_key`, `aws_api_gateway_rest_api`, `aws_api_gateway_usage_plan`,
`aws_apigatewayv2_api`, `aws_backup_plan`, `aws_cloudfront_distribution`,
`aws_cognito_identity_pool`, `aws_cognito_user_pool`, `aws_customer_gateway`,
`aws_directory_service_directory`, `aws_dx_connection`, `aws_dx_gateway`,
`aws_ebs_volume`, `aws_ec2_client_vpn_endpoint`, `aws_ec2_instance_connect_endpoint`,
`aws_ec2_managed_prefix_list`, `aws_ec2_transit_gateway`,
`aws_ec2_transit_gateway_route_table`, `aws_ec2_transit_gateway_vpc_attachment`,
`aws_efs_access_point`, `aws_efs_file_system`, `aws_efs_mount_target`,
`aws_egress_only_internet_gateway`, `aws_eip_association`,
`aws_elastic_beanstalk_environment`, `aws_emr_cluster`, `aws_flow_log`,
`aws_guardduty_detector`, `aws_instance`, `aws_internet_gateway`, `aws_kms_key`,
`aws_launch_template`, `aws_macie2_account`, `aws_mq_broker`, `aws_nat_gateway`,
`aws_network_acl`, `aws_network_acl_association`, `aws_network_interface`,
`aws_network_interface_attachment`, `aws_networkmanager_core_network`,
`aws_organizations_account`, `aws_organizations_organization`,
`aws_organizations_organizational_unit`, `aws_organizations_policy`,
`aws_route53_resolver_endpoint`, `aws_route53_resolver_rule`,
`aws_route53_resolver_rule_association`, `aws_route53_zone`, `aws_route_table`,
`aws_securityhub_account`, `aws_security_group`, `aws_subnet`,
`aws_transfer_server`, `aws_vpc`, `aws_vpc_dhcp_options`, `aws_vpc_endpoint`,
`aws_vpc_endpoint_service`, `aws_vpc_peering_connection`, `aws_vpn_connection`,
`aws_vpn_gateway`.

## What a state file has that the fixture does not

`test/fixtures/awkward.tfstate.json` is synthetic, and every synthetic state is
tidier than a real one. Known gaps, so nobody has to rediscover them:

- **Deposed instances** are skipped and counted (`ParsedStateFile.skipped.deposed`).
  A `deposed` object is the old half of an interrupted create-before-destroy: it
  shares an address with the live instance and is scheduled for destruction, so
  importing it would both collide and adopt something Terraform is about to
  delete. Note that `packages/scanner/src/terraform.ts` does **not** make this
  distinction — the divergence is deliberate, because that path is matching
  rather than importing.
- **Provider aliases** are mitigated by the `# account · region` comment, not
  solved. A state spanning two accounts is where a careless paste does damage.
- **Non-ASCII and shell-hostile names** are escaped where decision 9 covers them
  (`\`, `"`, `${`, `%{`) and not otherwise normalised.

## Adding a rule

1. Fetch
   `https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/main/website/docs/r/<type_sans_aws_prefix>.html.markdown`.
   **Do not write an id format from memory** — a wrong one compiles, renders,
   copies to the clipboard, and fails hours later inside someone else's
   `terraform plan`, or worse succeeds against the wrong resource.
2. Read the `id = "…"` block, not the `identity = { … }` block above it.
3. Add the rule to the right module — `rules/state.ts` for `fromState`,
   `rules/scanned-network.ts` / `rules/scanned-workload.ts` for `fromScanned` —
   and set `doc` to the page. `rules/registry.ts` merges by type and needs no
   edit; if you think it does, the module boundary is wrong. The merge covers
   `expand` too, so a type declared in two modules keeps its expander whichever
   module declares it and whatever order `SOURCES` is in.
4. Add a case to that module's test. `test/state-rules.test.ts` asserts its case
   table is **complete**, so a resolver with no case fails the build.
5. If the type has no documented import, give it `notImportable` with a reason a
   user can act on — not silence, and not the generic fallback, which implies
   the id might work.

## Tests

```
npm test          # tsx --test "packages/*/test/**/*.test.ts", from the repo root
```

| file | what it pins |
| --- | --- |
| `test/emit.test.ts` | escaping, address sanitising, collision dedupe, state parsing |
| `test/state-rules.test.ts` | every `fromState` resolver, and that the table is complete |
| `test/scanned-network.test.ts`, `test/scanned-workload.test.ts` | every `fromScanned` resolver |
| `test/scanned-expand.test.ts` | expansion: the fan-out rule, the provider notes, that the state path never expands, and that every declared expander survives the registry merge |
| `test/golden.test.ts` | the whole thing, both paths, and that they agree |
