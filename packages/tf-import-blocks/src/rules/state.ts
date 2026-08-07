/**
 * Tier B — state-attribute resolvers, including the composite and attachment
 * types that dominate real state files and never appear on the graph.
 *
 * Every `fromState` here was read off
 * `website/docs/r/<page>.html.markdown` in `hashicorp/terraform-provider-aws`
 * on `main` (fetched 2026-08-07), not recalled. `doc` records which page.
 *
 * **The pages now print the `identity = { … }` form first and the `id = "…"`
 * form second.** Decision 3 forbids the identity form, so every value below
 * came from the `id = "…"` block or the `terraform import` console line
 * underneath it. Anyone re-verifying must scroll past the first `import {`.
 *
 * Two shapes of rule live here and the difference is deliberate:
 *
 *   - **Single-attribute imports** read the documented attribute and fall back
 *     to the state `id`. The fallback is safe because for these types the
 *     provider's own `SetId` is that same attribute — `aws_sqs_queue`'s `url`
 *     and `aws_lambda_function`'s `function_name` are exactly this case, and
 *     naming the attribute is what documents *why* the id happens to work.
 *   - **Composite imports** compose strictly and return `undefined` when a part
 *     is missing. They get **no `id` fallback**: for `aws_route`,
 *     `aws_security_group_rule`, `aws_ecs_service` and the `aws_wafv2_*` family
 *     the state id is a different string entirely (a synthetic hash, or an
 *     ARN), so falling back to it would emit a confident wrong answer. An
 *     honest `# VERIFY` is better.
 *
 * Decision 6 still holds: rules *read* attributes freely and the emitter writes
 * only the computed id. Nothing else from the state leaves this package.
 *
 * `aws_s3_object` is deliberately absent — it is `awkward.expected.tf`'s
 * no-rule case, exercising both the `# VERIFY` fallback and decision 9's
 * escaping. Registering it here silently invalidates the golden file.
 */
import { parseArn, str, type ImportRule, type StateAttributes } from '../types.js';

// ── attribute readers ──────────────────────────────────────────────────────
//
// `str()` from types.ts is the intended reader and is used wherever a value is
// a non-empty string. The two helpers below exist for the cases it cannot
// cover, and both are needed by types the golden file asserts.

/**
 * A scalar attribute as a string. State holds `from_port` as a number and
 * `egress` as a boolean, and both are parts of documented import ids
 * (`aws_security_group_rule`, `aws_network_acl_rule`), so `str()` alone is not
 * enough. `0` and `false` are meaningful values, not absences.
 */
function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * A string attribute where the **empty string is a real value**. `str()`
 * rejects `''`, which is right almost everywhere and wrong for exactly the case
 * the fixture leads with: a Route 53 apex record has `name = ""` and imports as
 * `Z4KAPRWWNC7JR__NS`, double underscore and all. `aws_api_gateway_base_path_mapping`
 * has the same shape (`example.com/`).
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A list-of-strings attribute (`cidr_blocks`, `groups`), or `undefined`. */
function list(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const s = scalar(item);
    if (s === undefined) return undefined;
    out.push(s);
  }
  return out;
}

/**
 * The bare name an attribute holds, even when the attribute holds an ARN.
 *
 * `aws_ecs_service.cluster` is the headline case: the provider stores the
 * *cluster ARN* there, and the import id wants `prod-cluster`. `aws_iam_*`
 * attachment `role` / `user` / `group` attributes can be written as ARNs too.
 * A non-ARN value is returned untouched, so this is safe to apply to anything
 * that is documented as a name.
 */
function bareName(value: unknown): string | undefined {
  const raw = str(value);
  if (raw === undefined) return undefined;
  const arn = parseArn(raw);
  if (arn === undefined) return raw;
  const cut = Math.max(arn.resource.lastIndexOf('/'), arn.resource.lastIndexOf(':'));
  return cut === -1 ? arn.resource : arn.resource.slice(cut + 1);
}

// ── rule constructors ──────────────────────────────────────────────────────

/** The import id really is the state `id` — verified per type, not assumed. */
function byId(type: string, page: string): ImportRule {
  return { type, doc: `r/${page}`, fromState: (a) => str(a['id']) };
}

/**
 * The import id is one documented attribute. Falls back to the state `id`,
 * which for these types is the same string by another route (see the header).
 */
function byAttr(type: string, key: string, page: string): ImportRule {
  return { type, doc: `r/${page}`, fromState: (a) => str(a[key]) ?? str(a['id']) };
}

/**
 * The import id is several attributes joined by a separator. Every part is
 * required; a missing one yields `undefined` and an honest `# VERIFY` rather
 * than a plausible-looking id built from what happened to be present.
 */
function byJoin(type: string, sep: string, keys: readonly string[], page: string): ImportRule {
  return {
    type,
    doc: `r/${page}`,
    fromState: (a) => {
      const parts: string[] = [];
      for (const key of keys) {
        const value = scalar(a[key]);
        if (value === undefined) return undefined;
        parts.push(value);
      }
      return parts.join(sep);
    },
  };
}

/** The provider publishes no import for this type. Decision 5: still emitted. */
function noImport(type: string, reason: string, page: string): ImportRule {
  return { type, doc: `r/${page}`, notImportable: reason };
}

// ── the awkward composites, written out ────────────────────────────────────

/**
 * `<zone_id>_<name>_<type>[_<set_identifier>]`.
 *
 * r/route53_record: "If the record name is the empty string, it can be
 * omitted" — the doc's own example is `Z4KAPRWWNC7JR__NS`, which is why `name`
 * is read with `text()` and not `str()`.
 */
const route53Record: ImportRule = {
  type: 'aws_route53_record',
  doc: 'r/route53_record',
  fromState: (a) => {
    const zoneId = str(a['zone_id']);
    const name = text(a['name']);
    const recordType = str(a['type']);
    if (zoneId === undefined || name === undefined || recordType === undefined) return undefined;
    const setIdentifier = str(a['set_identifier']);
    const parts = [zoneId, name, recordType];
    if (setIdentifier !== undefined) parts.push(setIdentifier);
    return parts.join('_');
  },
};

/**
 * `<cluster-name>/<service-name>`.
 *
 * Both halves need work. The state `id` is the *service ARN*
 * (`ecs/service.go`: `SetId(Service.ServiceArn)`), and the `cluster` attribute
 * is the *cluster ARN*, not the cluster name — this is the single most likely
 * place to emit a plausible-but-wrong id. If `cluster` is absent (it is
 * Optional and defaults to the account's `default` cluster), the service ARN
 * itself carries the cluster: `…:service/<cluster>/<service>`.
 */
const ecsService: ImportRule = {
  type: 'aws_ecs_service',
  doc: 'r/ecs_service',
  fromState: (a) => {
    const name = str(a['name']);
    if (name === undefined) return undefined;
    const cluster = bareName(a['cluster']);
    if (cluster !== undefined) return `${cluster}/${name}`;
    // Fall back to the long-form service ARN: `service/<cluster>/<service>`.
    // The pre-2019 short form is `service/<service>` and names no cluster, so
    // it tells us nothing and must not be guessed at.
    const arn = parseArn(a['arn'] ?? a['id']);
    const segments = arn?.resource.split('/') ?? [];
    return segments.length === 3 && segments[1] !== undefined && segments[1] !== ''
      ? `${segments[1]}/${name}`
      : undefined;
  },
};

/**
 * `<id>/<name>/<scope>` for every WAFv2 resource that has a scope.
 *
 * The scope comes from the resource's own `scope` attribute — never from
 * whether a region is empty. A CLOUDFRONT-scoped ACL still lives in a state
 * whose provider block has a region.
 */
function wafv2(type: string, page: string): ImportRule {
  return {
    type,
    doc: `r/${page}`,
    fromState: (a) => {
      const id = str(a['id']);
      const name = str(a['name']);
      const scope = str(a['scope']);
      if (id === undefined || name === undefined || scope === undefined) return undefined;
      return `${id}/${name}/${scope}`;
    },
  };
}

/**
 * `<route_table_id>_<destination>`.
 *
 * The state id is the provider's synthetic `r-<rtb><hashcode>` (`ec2/id.go`:
 * `routeCreateID`) and is never a valid import id, so there is no fallback.
 * The destination is whichever of the three destination attributes is set;
 * r/route documents all three (IPv4 CIDR, IPv6 CIDR, prefix list).
 */
const route: ImportRule = {
  type: 'aws_route',
  doc: 'r/route',
  fromState: (a) => {
    const routeTableId = str(a['route_table_id']);
    const destination =
      str(a['destination_cidr_block']) ??
      str(a['destination_ipv6_cidr_block']) ??
      str(a['destination_prefix_list_id']);
    if (routeTableId === undefined || destination === undefined) return undefined;
    return `${routeTableId}_${destination}`;
  },
};

/**
 * `<security_group_id>_<type>_<protocol>_<from_port>_<to_port>_<source>[_<source>…]`.
 *
 * The state id is `sgrule-<hashcode>` and is never importable. Source ordering
 * does not matter: `resourceSecurityGroupRuleImport` classifies each trailing
 * token by content (`sg-` → source security group, `pl-` → prefix list, `:` →
 * IPv6 CIDR, `self` → self, otherwise IPv4 CIDR), so this emits them in a
 * stable documented order. "All parts are required" — with no source at all the
 * id is unusable, so that yields `undefined`.
 */
const securityGroupRule: ImportRule = {
  type: 'aws_security_group_rule',
  doc: 'r/security_group_rule',
  fromState: (a) => {
    const head: string[] = [];
    for (const part of [
      str(a['security_group_id']),
      str(a['type']),
      str(a['protocol']),
      scalar(a['from_port']),
      scalar(a['to_port']),
    ]) {
      if (part === undefined) return undefined;
      head.push(part);
    }
    const sources = [
      ...(list(a['cidr_blocks']) ?? []),
      ...(list(a['ipv6_cidr_blocks']) ?? []),
      ...(list(a['prefix_list_ids']) ?? []),
    ];
    const sourceSecurityGroup = str(a['source_security_group_id']);
    if (sourceSecurityGroup !== undefined) sources.push(sourceSecurityGroup);
    if (a['self'] === true) sources.push('self');
    if (sources.length === 0) return undefined;
    return [...head, ...sources].join('_');
  },
};

/**
 * `<target_group_arn>,<target_id>[,<port>][,<availability_zone>]`.
 *
 * The optional parts are positional, so an availability zone with no port would
 * land in the port's slot. That combination yields `undefined` rather than a
 * subtly wrong id.
 */
const lbTargetGroupAttachment: ImportRule = {
  type: 'aws_lb_target_group_attachment',
  doc: 'r/lb_target_group_attachment',
  fromState: (a) => {
    const targetGroupArn = str(a['target_group_arn']);
    const targetId = str(a['target_id']);
    if (targetGroupArn === undefined || targetId === undefined) return undefined;
    const parts = [targetGroupArn, targetId];
    const port = scalar(a['port']);
    const availabilityZone = str(a['availability_zone']);
    if (port !== undefined && port !== '0') parts.push(port);
    if (availabilityZone !== undefined) {
      if (parts.length !== 3) return undefined;
      parts.push(availabilityZone);
    }
    return parts.join(',');
  },
};

/**
 * `<function_name>[:<qualifier>]/<statement_id>` — the qualifier is glued to the
 * function name with a colon, not appended at the end.
 */
const lambdaPermission: ImportRule = {
  type: 'aws_lambda_permission',
  doc: 'r/lambda_permission',
  fromState: (a) => {
    const functionName = bareName(a['function_name']);
    const statementId = str(a['statement_id']);
    if (functionName === undefined || statementId === undefined) return undefined;
    const qualifier = str(a['qualifier']);
    return `${qualifier === undefined ? functionName : `${functionName}:${qualifier}`}/${statementId}`;
  },
};

/**
 * `<zone_id>:<vpc_id>[:<vpc_region>]` — the region is appended only when the
 * VPC is not in the provider's own region, but state always records it and
 * including it is accepted in both cases.
 */
const route53ZoneAssociation: ImportRule = {
  type: 'aws_route53_zone_association',
  doc: 'r/route53_zone_association',
  fromState: (a) => {
    const zoneId = str(a['zone_id']);
    const vpcId = str(a['vpc_id']);
    if (zoneId === undefined || vpcId === undefined) return undefined;
    const vpcRegion = str(a['vpc_region']);
    return vpcRegion === undefined ? `${zoneId}:${vpcId}` : `${zoneId}:${vpcId}:${vpcRegion}`;
  },
};

/**
 * `<subnet_id|gateway_id>/<route_table_id>` — the association is to a subnet or
 * to a gateway, never both, and the id leads with whichever it is.
 */
const routeTableAssociation: ImportRule = {
  type: 'aws_route_table_association',
  doc: 'r/route_table_association',
  fromState: (a) => {
    const target = str(a['subnet_id']) ?? str(a['gateway_id']);
    const routeTableId = str(a['route_table_id']);
    if (target === undefined || routeTableId === undefined) return undefined;
    return `${target}/${routeTableId}`;
  },
};

/**
 * `<bucket>[,<expected_bucket_owner>]` — the family of `aws_s3_bucket_*`
 * sub-resources that hang off a bucket name and take an optional owner when the
 * bucket lives in another account.
 */
function s3BucketSubresource(type: string, page: string): ImportRule {
  return {
    type,
    doc: `r/${page}`,
    fromState: (a) => {
      const bucket = str(a['bucket']) ?? str(a['id']);
      if (bucket === undefined) return undefined;
      const owner = str(a['expected_bucket_owner']);
      return owner === undefined ? bucket : `${bucket},${owner}`;
    },
  };
}

/**
 * `<table_name>,<hash-key-value>[,<range-key-value>]`.
 *
 * The key *values* are not attributes of their own — they live inside the
 * `item` JSON, keyed by the attribute names `hash_key` and `range_key` name.
 * Reading them is exactly what decision 6 permits (the value *is* the import
 * id) and nothing else from `item` is touched. A value containing a comma
 * cannot be expressed in this form at all, per the provider's own note, so that
 * case yields `undefined`.
 */
const dynamodbTableItem: ImportRule = {
  type: 'aws_dynamodb_table_item',
  doc: 'r/dynamodb_table_item',
  fromState: (a) => {
    const tableName = str(a['table_name']);
    const hashKey = str(a['hash_key']);
    const rawItem = str(a['item']);
    if (tableName === undefined || hashKey === undefined || rawItem === undefined) return undefined;
    let item: unknown;
    try {
      item = JSON.parse(rawItem);
    } catch {
      return undefined;
    }
    if (item === null || typeof item !== 'object') return undefined;
    const record = item as Record<string, unknown>;
    const valueOf = (attribute: string): string | undefined => {
      const typed = record[attribute];
      if (typed === null || typeof typed !== 'object') return undefined;
      const only = Object.values(typed as Record<string, unknown>);
      return only.length === 1 ? scalar(only[0]) : undefined;
    };
    const hashValue = valueOf(hashKey);
    if (hashValue === undefined || hashValue.includes(',')) return undefined;
    const rangeKey = str(a['range_key']);
    if (rangeKey === undefined) return `${tableName},${hashValue}`;
    const rangeValue = valueOf(rangeKey);
    if (rangeValue === undefined || rangeValue.includes(',')) return undefined;
    return `${tableName},${hashValue},${rangeValue}`;
  },
};

/** `<user>/<group>[/<group>…]` — the group list is part of the id. */
const iamUserGroupMembership: ImportRule = {
  type: 'aws_iam_user_group_membership',
  doc: 'r/iam_user_group_membership',
  fromState: (a) => {
    const user = bareName(a['user']);
    const groups = list(a['groups']);
    if (user === undefined || groups === undefined || groups.length === 0) return undefined;
    return [user, ...groups].join('/');
  },
};

/** `<role|user|group>/<policy_arn>` — the three IAM attachment types. */
function iamPolicyAttachment(type: string, principalKey: string, page: string): ImportRule {
  return {
    type,
    doc: `r/${page}`,
    fromState: (a) => {
      const principal = bareName(a[principalKey]);
      const policyArn = str(a['policy_arn']);
      if (principal === undefined || policyArn === undefined) return undefined;
      return `${principal}/${policyArn}`;
    },
  };
}

/** `<role|user|group>:<policy_name>` — the three IAM inline-policy types. */
function iamInlinePolicy(type: string, principalKey: string, page: string): ImportRule {
  return {
    type,
    doc: `r/${page}`,
    fromState: (a) => {
      const principal = bareName(a[principalKey]);
      const name = str(a['name']);
      if (principal === undefined || name === undefined) return undefined;
      return `${principal}:${name}`;
    },
  };
}

// ── the table ──────────────────────────────────────────────────────────────

export const RULES: ImportRule[] = [
  // ── EC2 / VPC: the native id really is the import id ─────────────────────
  byId('aws_vpc', 'vpc'),
  byId('aws_subnet', 'subnet'),
  byId('aws_route_table', 'route_table'),
  byId('aws_internet_gateway', 'internet_gateway'),
  byId('aws_egress_only_internet_gateway', 'egress_only_internet_gateway'),
  byId('aws_nat_gateway', 'nat_gateway'),
  byId('aws_network_acl', 'network_acl'),
  byId('aws_network_acl_association', 'network_acl_association'),
  byId('aws_security_group', 'security_group'),
  byId('aws_network_interface', 'network_interface'),
  byId('aws_network_interface_attachment', 'network_interface_attachment'),
  byId('aws_vpc_endpoint', 'vpc_endpoint'),
  byId('aws_vpc_endpoint_service', 'vpc_endpoint_service'),
  byId('aws_ec2_managed_prefix_list', 'ec2_managed_prefix_list'),
  byId('aws_flow_log', 'flow_log'),
  byId('aws_vpc_dhcp_options', 'vpc_dhcp_options'),
  byId('aws_ec2_instance_connect_endpoint', 'ec2_instance_connect_endpoint'),
  byId('aws_vpc_peering_connection', 'vpc_peering_connection'),
  byId('aws_ec2_transit_gateway', 'ec2_transit_gateway'),
  byId('aws_ec2_transit_gateway_route_table', 'ec2_transit_gateway_route_table'),
  byId('aws_ec2_transit_gateway_vpc_attachment', 'ec2_transit_gateway_vpc_attachment'),
  byId('aws_vpn_gateway', 'vpn_gateway'),
  byId('aws_customer_gateway', 'customer_gateway'),
  byId('aws_vpn_connection', 'vpn_connection'),
  byId('aws_dx_connection', 'dx_connection'),
  byId('aws_dx_gateway', 'dx_gateway'),
  byId('aws_ec2_client_vpn_endpoint', 'ec2_client_vpn_endpoint'),
  byId('aws_instance', 'instance'),
  byId('aws_launch_template', 'launch_template'),
  byId('aws_ebs_volume', 'ebs_volume'),
  byId('aws_eip_association', 'eip_association'),
  // r/eip: "import EIPs in a VPC using their Allocation ID" — never the public
  // IP, which is what an EC2-Classic address stored instead.
  byAttr('aws_eip', 'allocation_id', 'eip'),
  // r/vpc_dhcp_options_association: "using the VPC ID associated with the options"
  byAttr('aws_vpc_dhcp_options_association', 'vpc_id', 'vpc_dhcp_options_association'),
  // r/vpc_security_group_(in|e)gress_rule: "using the `security_group_rule_id`"
  byAttr(
    'aws_vpc_security_group_ingress_rule',
    'security_group_rule_id',
    'vpc_security_group_ingress_rule',
  ),
  byAttr(
    'aws_vpc_security_group_egress_rule',
    'security_group_rule_id',
    'vpc_security_group_egress_rule',
  ),

  // ── EC2 / VPC composites ─────────────────────────────────────────────────
  route,
  routeTableAssociation,
  securityGroupRule,
  // r/network_acl_rule: `NETWORK_ACL_ID:RULE_NUMBER:PROTOCOL:EGRESS`
  byJoin(
    'aws_network_acl_rule',
    ':',
    ['network_acl_id', 'rule_number', 'protocol', 'egress'],
    'network_acl_rule',
  ),
  // r/vpc_endpoint_route_table_association: `vpc_endpoint_id` with `route_table_id`
  byJoin(
    'aws_vpc_endpoint_route_table_association',
    '/',
    ['vpc_endpoint_id', 'route_table_id'],
    'vpc_endpoint_route_table_association',
  ),
  byJoin(
    'aws_vpc_endpoint_subnet_association',
    '/',
    ['vpc_endpoint_id', 'subnet_id'],
    'vpc_endpoint_subnet_association',
  ),
  // r/ec2_managed_prefix_list_entry: `prefix_list_id` and `cidr`, comma-separated
  byJoin('aws_ec2_managed_prefix_list_entry', ',', ['prefix_list_id', 'cidr'], 'ec2_managed_prefix_list_entry'),
  // r/ec2_transit_gateway_route: route table id, an underscore, the destination
  byJoin(
    'aws_ec2_transit_gateway_route',
    '_',
    ['transit_gateway_route_table_id', 'destination_cidr_block'],
    'ec2_transit_gateway_route',
  ),
  byJoin(
    'aws_ec2_transit_gateway_route_table_association',
    '_',
    ['transit_gateway_route_table_id', 'transit_gateway_attachment_id'],
    'ec2_transit_gateway_route_table_association',
  ),
  byJoin(
    'aws_ec2_transit_gateway_route_table_propagation',
    '_',
    ['transit_gateway_route_table_id', 'transit_gateway_attachment_id'],
    'ec2_transit_gateway_route_table_propagation',
  ),
  // r/ec2_client_vpn_network_association: endpoint ID and association ID, `,`
  byJoin(
    'aws_ec2_client_vpn_network_association',
    ',',
    ['client_vpn_endpoint_id', 'association_id'],
    'ec2_client_vpn_network_association',
  ),
  // r/dx_gateway_association: `dx_gateway_id` together with `associated_gateway_id`
  byJoin('aws_dx_gateway_association', '/', ['dx_gateway_id', 'associated_gateway_id'], 'dx_gateway_association'),
  // r/volume_attachment: `DEVICE_NAME:VOLUME_ID:INSTANCE_ID`
  byJoin('aws_volume_attachment', ':', ['device_name', 'volume_id', 'instance_id'], 'volume_attachment'),

  // ── load balancing ───────────────────────────────────────────────────────
  byAttr('aws_lb', 'arn', 'lb'),
  byAttr('aws_lb_listener', 'arn', 'lb_listener'),
  byAttr('aws_lb_listener_rule', 'arn', 'lb_listener_rule'),
  byAttr('aws_lb_target_group', 'arn', 'lb_target_group'),
  // r/lb_listener_certificate: listener arn and certificate arn, `_`-separated
  byJoin('aws_lb_listener_certificate', '_', ['listener_arn', 'certificate_arn'], 'lb_listener_certificate'),
  lbTargetGroupAttachment,

  // ── DNS ──────────────────────────────────────────────────────────────────
  byId('aws_route53_zone', 'route53_zone'),
  route53Record,
  route53ZoneAssociation,
  byId('aws_route53_resolver_endpoint', 'route53_resolver_endpoint'),
  byId('aws_route53_resolver_rule', 'route53_resolver_rule'),
  byId('aws_route53_resolver_rule_association', 'route53_resolver_rule_association'),

  // ── WAF / edge ───────────────────────────────────────────────────────────
  wafv2('aws_wafv2_web_acl', 'wafv2_web_acl'),
  wafv2('aws_wafv2_ip_set', 'wafv2_ip_set'),
  wafv2('aws_wafv2_rule_group', 'wafv2_rule_group'),
  // r/wafv2_web_acl_association: `WEB_ACL_ARN,RESOURCE_ARN`
  byJoin('aws_wafv2_web_acl_association', ',', ['web_acl_arn', 'resource_arn'], 'wafv2_web_acl_association'),
  // r/wafv2_web_acl_logging_configuration: the ARN of the WAFv2 Web ACL
  byAttr('aws_wafv2_web_acl_logging_configuration', 'resource_arn', 'wafv2_web_acl_logging_configuration'),
  byId('aws_cloudfront_distribution', 'cloudfront_distribution'),
  byAttr('aws_globalaccelerator_accelerator', 'arn', 'globalaccelerator_accelerator'),
  byId('aws_networkmanager_core_network', 'networkmanager_core_network'),
  byAttr('aws_networkfirewall_firewall', 'arn', 'networkfirewall_firewall'),
  byAttr('aws_networkfirewall_firewall_policy', 'arn', 'networkfirewall_firewall_policy'),
  byAttr('aws_networkfirewall_rule_group', 'arn', 'networkfirewall_rule_group'),

  // ── API Gateway v1 ───────────────────────────────────────────────────────
  byId('aws_api_gateway_rest_api', 'api_gateway_rest_api'),
  byId('aws_api_gateway_api_key', 'api_gateway_api_key'),
  byId('aws_api_gateway_usage_plan', 'api_gateway_usage_plan'),
  byAttr('aws_api_gateway_rest_api_policy', 'rest_api_id', 'api_gateway_rest_api_policy'),
  byAttr('aws_api_gateway_domain_name', 'domain_name', 'api_gateway_domain_name'),
  byJoin('aws_api_gateway_resource', '/', ['rest_api_id', 'id'], 'api_gateway_resource'),
  byJoin('aws_api_gateway_deployment', '/', ['rest_api_id', 'id'], 'api_gateway_deployment'),
  byJoin('aws_api_gateway_authorizer', '/', ['rest_api_id', 'id'], 'api_gateway_authorizer'),
  byJoin('aws_api_gateway_request_validator', '/', ['rest_api_id', 'id'], 'api_gateway_request_validator'),
  byJoin('aws_api_gateway_model', '/', ['rest_api_id', 'name'], 'api_gateway_model'),
  byJoin('aws_api_gateway_stage', '/', ['rest_api_id', 'stage_name'], 'api_gateway_stage'),
  byJoin('aws_api_gateway_gateway_response', '/', ['rest_api_id', 'response_type'], 'api_gateway_gateway_response'),
  byJoin('aws_api_gateway_usage_plan_key', '/', ['usage_plan_id', 'key_id'], 'api_gateway_usage_plan_key'),
  byJoin('aws_api_gateway_method', '/', ['rest_api_id', 'resource_id', 'http_method'], 'api_gateway_method'),
  byJoin('aws_api_gateway_integration', '/', ['rest_api_id', 'resource_id', 'http_method'], 'api_gateway_integration'),
  byJoin(
    'aws_api_gateway_method_response',
    '/',
    ['rest_api_id', 'resource_id', 'http_method', 'status_code'],
    'api_gateway_method_response',
  ),
  byJoin(
    'aws_api_gateway_integration_response',
    '/',
    ['rest_api_id', 'resource_id', 'http_method', 'status_code'],
    'api_gateway_integration_response',
  ),
  // r/api_gateway_base_path_mapping: "the domain name and base path" — an empty
  // base path is legal and gives the documented trailing slash (`example.com/`).
  {
    type: 'aws_api_gateway_base_path_mapping',
    doc: 'r/api_gateway_base_path_mapping',
    fromState: (a: StateAttributes) => {
      const domainName = str(a['domain_name']);
      if (domainName === undefined) return undefined;
      return `${domainName}/${text(a['base_path']) ?? ''}`;
    },
  },

  // ── API Gateway v2 ───────────────────────────────────────────────────────
  byId('aws_apigatewayv2_api', 'apigatewayv2_api'),
  byJoin('aws_apigatewayv2_route', '/', ['api_id', 'id'], 'apigatewayv2_route'),
  byJoin('aws_apigatewayv2_integration', '/', ['api_id', 'id'], 'apigatewayv2_integration'),
  byJoin('aws_apigatewayv2_stage', '/', ['api_id', 'name'], 'apigatewayv2_stage'),

  // ── IAM ──────────────────────────────────────────────────────────────────
  byAttr('aws_iam_role', 'name', 'iam_role'),
  byAttr('aws_iam_user', 'name', 'iam_user'),
  byAttr('aws_iam_group', 'name', 'iam_group'),
  byAttr('aws_iam_instance_profile', 'name', 'iam_instance_profile'),
  // Not the same rule as the four above: policies import by ARN, principals by name.
  byAttr('aws_iam_policy', 'arn', 'iam_policy'),
  byAttr('aws_iam_saml_provider', 'arn', 'iam_saml_provider'),
  byAttr('aws_iam_openid_connect_provider', 'arn', 'iam_openid_connect_provider'),
  byAttr('aws_iam_account_alias', 'account_alias', 'iam_account_alias'),
  iamPolicyAttachment('aws_iam_role_policy_attachment', 'role', 'iam_role_policy_attachment'),
  iamPolicyAttachment('aws_iam_user_policy_attachment', 'user', 'iam_user_policy_attachment'),
  iamPolicyAttachment('aws_iam_group_policy_attachment', 'group', 'iam_group_policy_attachment'),
  iamInlinePolicy('aws_iam_role_policy', 'role', 'iam_role_policy'),
  iamInlinePolicy('aws_iam_user_policy', 'user', 'iam_user_policy'),
  iamInlinePolicy('aws_iam_group_policy', 'group', 'iam_group_policy'),
  iamUserGroupMembership,

  // ── IAM Identity Center / Organizations ──────────────────────────────────
  byJoin('aws_ssoadmin_permission_set', ',', ['arn', 'instance_arn'], 'ssoadmin_permission_set'),
  byJoin(
    'aws_ssoadmin_managed_policy_attachment',
    ',',
    ['managed_policy_arn', 'permission_set_arn', 'instance_arn'],
    'ssoadmin_managed_policy_attachment',
  ),
  byJoin(
    'aws_ssoadmin_account_assignment',
    ',',
    ['principal_id', 'principal_type', 'target_id', 'target_type', 'permission_set_arn', 'instance_arn'],
    'ssoadmin_account_assignment',
  ),
  byJoin('aws_identitystore_group', '/', ['identity_store_id', 'group_id'], 'identitystore_group'),
  byJoin('aws_identitystore_user', '/', ['identity_store_id', 'user_id'], 'identitystore_user'),
  byId('aws_organizations_organization', 'organizations_organization'),
  byId('aws_organizations_organizational_unit', 'organizations_organizational_unit'),
  byId('aws_organizations_account', 'organizations_account'),
  byId('aws_organizations_policy', 'organizations_policy'),
  // r/organizations_policy_attachment: "using the target ID and policy ID"
  byJoin('aws_organizations_policy_attachment', ':', ['target_id', 'policy_id'], 'organizations_policy_attachment'),
  byJoin(
    'aws_organizations_delegated_administrator',
    '/',
    ['account_id', 'service_principal'],
    'organizations_delegated_administrator',
  ),

  // ── S3 ───────────────────────────────────────────────────────────────────
  // NOTE: aws_s3_object is deliberately absent — see the module header.
  byAttr('aws_s3_bucket', 'bucket', 's3_bucket'),
  byAttr('aws_s3_bucket_policy', 'bucket', 's3_bucket_policy'),
  byAttr('aws_s3_bucket_notification', 'bucket', 's3_bucket_notification'),
  byAttr('aws_s3_bucket_public_access_block', 'bucket', 's3_bucket_public_access_block'),
  s3BucketSubresource('aws_s3_bucket_versioning', 's3_bucket_versioning'),
  s3BucketSubresource('aws_s3_bucket_lifecycle_configuration', 's3_bucket_lifecycle_configuration'),
  s3BucketSubresource(
    'aws_s3_bucket_server_side_encryption_configuration',
    's3_bucket_server_side_encryption_configuration',
  ),

  // ── ECR ──────────────────────────────────────────────────────────────────
  byAttr('aws_ecr_repository', 'name', 'ecr_repository'),
  byAttr('aws_ecr_repository_policy', 'repository', 'ecr_repository_policy'),
  byAttr('aws_ecr_lifecycle_policy', 'repository', 'ecr_lifecycle_policy'),

  // ── compute and containers ───────────────────────────────────────────────
  byAttr('aws_autoscaling_group', 'name', 'autoscaling_group'),
  byAttr('aws_ecs_cluster', 'name', 'ecs_cluster'),
  ecsService,
  byAttr('aws_ecs_task_definition', 'arn', 'ecs_task_definition'),
  byAttr('aws_eks_cluster', 'name', 'eks_cluster'),
  // r/eks_node_group and r/eks_addon: colon-separated, not slash.
  byJoin('aws_eks_node_group', ':', ['cluster_name', 'node_group_name'], 'eks_node_group'),
  byJoin('aws_eks_addon', ':', ['cluster_name', 'addon_name'], 'eks_addon'),
  byAttr('aws_lambda_function', 'function_name', 'lambda_function'),
  byJoin('aws_lambda_alias', '/', ['function_name', 'name'], 'lambda_alias'),
  byAttr('aws_lambda_event_source_mapping', 'uuid', 'lambda_event_source_mapping'),
  byAttr('aws_lambda_layer_version', 'arn', 'lambda_layer_version'),
  lambdaPermission,
  // The state id is the bare `resource_id`, not the triple — no `id` fallback.
  byJoin(
    'aws_appautoscaling_target',
    '/',
    ['service_namespace', 'resource_id', 'scalable_dimension'],
    'appautoscaling_target',
  ),
  byJoin(
    'aws_appautoscaling_policy',
    '/',
    ['service_namespace', 'resource_id', 'scalable_dimension', 'name'],
    'appautoscaling_policy',
  ),

  // ── data stores ──────────────────────────────────────────────────────────
  byAttr('aws_db_instance', 'identifier', 'db_instance'),
  byAttr('aws_db_subnet_group', 'name', 'db_subnet_group'),
  byAttr('aws_db_parameter_group', 'name', 'db_parameter_group'),
  byAttr('aws_rds_cluster', 'cluster_identifier', 'rds_cluster'),
  byAttr('aws_rds_cluster_instance', 'identifier', 'rds_cluster_instance'),
  byAttr('aws_elasticache_cluster', 'cluster_id', 'elasticache_cluster'),
  byAttr('aws_elasticache_replication_group', 'replication_group_id', 'elasticache_replication_group'),
  byAttr('aws_elasticache_subnet_group', 'name', 'elasticache_subnet_group'),
  byAttr('aws_elasticache_parameter_group', 'name', 'elasticache_parameter_group'),
  byAttr('aws_elasticache_user', 'user_id', 'elasticache_user'),
  byAttr('aws_elasticache_user_group', 'user_group_id', 'elasticache_user_group'),
  byAttr('aws_elasticache_serverless_cache', 'name', 'elasticache_serverless_cache'),
  byId('aws_efs_file_system', 'efs_file_system'),
  byId('aws_efs_mount_target', 'efs_mount_target'),
  byId('aws_efs_access_point', 'efs_access_point'),
  byAttr('aws_opensearch_domain', 'domain_name', 'opensearch_domain'),
  byAttr('aws_msk_cluster', 'arn', 'msk_cluster'),
  byAttr('aws_redshift_cluster', 'cluster_identifier', 'redshift_cluster'),
  byId('aws_mq_broker', 'mq_broker'),
  byAttr('aws_dynamodb_table', 'name', 'dynamodb_table'),
  dynamodbTableItem,
  byAttr('aws_neptune_cluster', 'cluster_identifier', 'neptune_cluster'),
  byAttr('aws_docdb_cluster', 'cluster_identifier', 'docdb_cluster'),
  byAttr('aws_memorydb_cluster', 'name', 'memorydb_cluster'),
  byId('aws_transfer_server', 'transfer_server'),
  byId('aws_elastic_beanstalk_environment', 'elastic_beanstalk_environment'),
  byId('aws_emr_cluster', 'emr_cluster'),

  // ── keys, certificates, secrets ──────────────────────────────────────────
  byId('aws_kms_key', 'kms_key'),
  byAttr('aws_kms_alias', 'name', 'kms_alias'),
  byAttr('aws_acm_certificate', 'arn', 'acm_certificate'),
  byAttr('aws_secretsmanager_secret', 'arn', 'secretsmanager_secret'),
  // r/secretsmanager_secret_version: "the secret ID and version ID", `|`-joined.
  byJoin('aws_secretsmanager_secret_version', '|', ['secret_id', 'version_id'], 'secretsmanager_secret_version'),

  // ── logs, events, messaging ──────────────────────────────────────────────
  byAttr('aws_cloudwatch_log_group', 'name', 'cloudwatch_log_group'),
  byAttr('aws_cloudwatch_metric_alarm', 'alarm_name', 'cloudwatch_metric_alarm'),
  byAttr('aws_cloudwatch_event_bus', 'name', 'cloudwatch_event_bus'),
  // r/cloudwatch_event_rule and r/cloudwatch_event_target: the bus name leads.
  // State always records `event_bus_name` (it defaults to `default`), so the
  // long form is always available and is accepted for the default bus too.
  byJoin('aws_cloudwatch_event_rule', '/', ['event_bus_name', 'name'], 'cloudwatch_event_rule'),
  byJoin('aws_cloudwatch_event_target', '/', ['event_bus_name', 'rule', 'target_id'], 'cloudwatch_event_target'),
  byAttr('aws_sns_topic', 'arn', 'sns_topic'),
  byAttr('aws_sns_topic_subscription', 'arn', 'sns_topic_subscription'),
  // r/sqs_queue: "import SQS Queues using the queue `url`". The state id is the
  // same string (`sqs/queue.go`: SetId(QueueUrl)); it is the *scanned* path that
  // stores the ARN and needs real work. Naming `url` documents the agreement.
  byAttr('aws_sqs_queue', 'url', 'sqs_queue'),
  byAttr('aws_sqs_queue_policy', 'queue_url', 'sqs_queue_policy'),
  byAttr('aws_sfn_state_machine', 'arn', 'sfn_state_machine'),
  byAttr('aws_kinesis_stream', 'name', 'kinesis_stream'),
  byAttr('aws_kinesis_firehose_delivery_stream', 'arn', 'kinesis_firehose_delivery_stream'),

  // ── analytics and integration ────────────────────────────────────────────
  // r/glue_catalog_*: colon-separated, leading with the catalog id (the account
  // id when it was never set explicitly).
  byJoin('aws_glue_catalog_database', ':', ['catalog_id', 'name'], 'glue_catalog_database'),
  byJoin('aws_glue_catalog_table', ':', ['catalog_id', 'database_name', 'name'], 'glue_catalog_table'),
  byAttr('aws_glue_job', 'name', 'glue_job'),
  byAttr('aws_glue_crawler', 'name', 'glue_crawler'),
  byAttr('aws_dms_endpoint', 'endpoint_id', 'dms_endpoint'),
  byAttr('aws_datasync_task', 'arn', 'datasync_task'),

  // ── identity and directory ───────────────────────────────────────────────
  byId('aws_cognito_user_pool', 'cognito_user_pool'),
  byJoin('aws_cognito_user_pool_client', '/', ['user_pool_id', 'id'], 'cognito_user_pool_client'),
  byAttr('aws_cognito_user_pool_domain', 'domain', 'cognito_user_pool_domain'),
  byId('aws_cognito_identity_pool', 'cognito_identity_pool'),
  byId('aws_directory_service_directory', 'directory_service_directory'),

  // ── sharing, governance, security posture ────────────────────────────────
  byAttr('aws_ram_resource_share', 'arn', 'ram_resource_share'),
  byJoin('aws_ram_resource_association', ',', ['resource_share_arn', 'resource_arn'], 'ram_resource_association'),
  byJoin('aws_ram_principal_association', ',', ['resource_share_arn', 'principal'], 'ram_principal_association'),
  byAttr('aws_config_config_rule', 'name', 'config_config_rule'),
  byAttr('aws_config_configuration_recorder', 'name', 'config_configuration_recorder'),
  byAttr('aws_cloudtrail', 'arn', 'cloudtrail'),
  byId('aws_guardduty_detector', 'guardduty_detector'),
  byAttr('aws_backup_vault', 'name', 'backup_vault'),
  byId('aws_backup_plan', 'backup_plan'),
  // r/backup_selection: `plan_id` and `id` separated by `|` — not `/`, not `,`.
  byJoin('aws_backup_selection', '|', ['plan_id', 'id'], 'backup_selection'),
  byId('aws_securityhub_account', 'securityhub_account'),
  byAttr('aws_accessanalyzer_analyzer', 'analyzer_name', 'accessanalyzer_analyzer'),
  byId('aws_macie2_account', 'macie2_account'),

  // ── no documented import ─────────────────────────────────────────────────
  //
  // These four are not "we could not work it out" — the provider publishes no
  // import for them. Decision 5 still emits the block, loudly flagged, because
  // silently dropping a resource during a state move is the worse failure.
  noImport(
    'aws_autoscaling_attachment',
    'the provider publishes no import section for this type. Re-declare the ' +
      'attachment in the target configuration and apply; it is a pure association, ' +
      'so creating it again is not destructive',
    'autoscaling_attachment',
  ),
  noImport(
    'aws_iam_group_membership',
    'the provider publishes no import section for this type. ' +
      'aws_iam_user_group_membership does import (`user/group[/group…]`) and is ' +
      'the per-user replacement for it',
    'iam_group_membership',
  ),
  noImport(
    'aws_vpn_connection_route',
    'the provider publishes no import section for this type. Re-declare the ' +
      'static route in the target configuration and apply',
    'vpn_connection_route',
  ),
  noImport(
    'aws_vpn_gateway_attachment',
    'the provider documents this explicitly: "You cannot import this resource". ' +
      'Attach the gateway from the target configuration instead, or use ' +
      "aws_vpn_gateway's own vpc_id argument",
    'vpn_gateway_attachment',
  ),
];
