/**
 * Tier A — network and edge kinds, resolved from a scanned resource alone.
 *
 * Every id format below was read off
 * `website/docs/r/<type>.html.markdown` in `hashicorp/terraform-provider-aws`
 * on `main` (2026-08-07), from the `id = "…"` / `terraform import` console
 * example — **not** from the `identity = { … }` block those pages now show
 * first, which decision 3 forbids this package from emitting.
 *
 * Three shapes of rule live here, and the split is deliberate:
 *
 *  - **Native-id passthrough.** The collector stored the AWS-native id and the
 *    provider imports by it. Most of the estate.
 *  - **ARN.** `aws_lb`, `aws_lb_target_group`, the Network Firewall family and
 *    Global Accelerator import by ARN. For the firewall family the collector
 *    stores the *name* in `id` (`collect/edge-network.ts:324` and friends), so
 *    reading `subject.id` would be silently wrong — these read `arn`.
 *  - **Guarded.** A guard exists exactly where the collector has a `??`
 *    fallback that can put a differently-shaped value in `id`, or where one
 *    atlas kind covers several terraform types. A guard returns `undefined`
 *    rather than a plausible-looking wrong answer; `from-scanned.ts` then
 *    flags the block `# VERIFY` (decision 5) instead of claiming it is right.
 *
 * **One kind, several terraform types.** Six kinds here span more than one
 * provider resource: `lb` (`aws_lb` / `aws_elb`), `tgw-attachment` (vpc /
 * peering / connect), `dx-vif` (private / public / transit), `apigw` (REST /
 * v2), `apigw-vpc-link` (v1 / v2) and `apigw-domain` (v1 / v2). Each resolves
 * its type per subject through `typeFromScanned`, off the collected field that
 * discriminates.
 *
 * They used to register the dominant type and decline the *id* to signal the
 * mismatch, which emitted `aws_api_gateway_rest_api` for an HTTP API under a
 * comment blaming the id — and the id (`abc123`) was exactly right. The guard
 * has moved to where the ambiguity actually is: `fromScanned` now returns the
 * id these variants share, and `typeFromScanned` returns the type or
 * `undefined`. A subject it cannot place emits no type at all rather than the
 * dominant one.
 */
import {
  parseArn,
  str,
  type ExpandedChild,
  type ImportRule,
  type ScannedSubject,
} from '../types.js';

const DOC_BASE =
  'https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/main/website/docs/r/';

/** The provider doc page an id format was verified against. */
const doc = (page: string): string => `${DOC_BASE}${page}.html.markdown`;

/** Read a non-empty string field off the collected record. */
function rawStr(subject: ScannedSubject, field: string): string | undefined {
  return str(subject.raw[field]);
}

/**
 * The plain case: the collector stored the AWS-native id and the provider
 * imports by exactly that.
 */
function nativeId(type: string, kinds: readonly string[], page: string): ImportRule {
  return { type, kinds, doc: doc(page), fromScanned: (s) => str(s.id) };
}

/**
 * Imports by ARN. Prefers the collected `arn`; accepts `id` only when `id` is
 * itself an ARN (several collectors fall back to the ARN when the descriptive
 * call fails). Never returns a bare name — that is the failure this package
 * exists to prevent.
 */
function arnId(type: string, kinds: readonly string[], page: string): ImportRule {
  return {
    type,
    kinds,
    doc: doc(page),
    fromScanned: (s) => str(s.arn) ?? (parseArn(s.id) !== undefined ? s.id : undefined),
  };
}

/**
 * WAFv2: `<id>/<name>/<scope>`, verified against `wafv2_web_acl`,
 * `wafv2_ip_set` and `wafv2_rule_group`.
 *
 * **Scope comes from the resource's own `scope` field and from nowhere else.**
 * `data.ts` adds these kinds twice — once per region for `REGIONAL` and once
 * per account for `CLOUDFRONT` — so it is tempting to infer the scope from
 * `subject.region === ''`. That inference is wrong in both directions: a
 * CLOUDFRONT ACL read out of a regional collection keeps a region, and a
 * snapshot loaded from an older scanner can carry `''`. The value is on
 * `WafWebAcl.scope` / `WafIpSet.scope` / `WafRuleGroup.scope`; anything that is
 * not one of the two documented literals yields `undefined`.
 */
function wafv2(type: string, kind: string, page: string): ImportRule {
  return {
    type,
    kinds: [kind],
    doc: doc(page),
    fromScanned: (s) => {
      const id = str(s.id);
      const name = str(s.name) ?? rawStr(s, 'name');
      const scope = rawStr(s, 'scope');
      if (id === undefined || name === undefined) return undefined;
      if (scope !== 'REGIONAL' && scope !== 'CLOUDFRONT') return undefined;
      return `${id}/${name}/${scope}`;
    },
  };
}

// ── security group rules: the first expander ───────────────────────────────
//
// `SecurityGroup` nests its rules (`ingress` / `egress`), so they are not nodes
// in the viewer and had nothing to hang an import block on. Selecting an
// unmanaged group offered `aws_security_group` and nothing else — a
// half-adoption that looks complete. See `ExpandedChild` in `types.ts` for the
// mechanism and what it can and cannot express.

/**
 * `securityGroupProtocolIntegers` from
 * `internal/service/ec2/vpc_security_group.go:1511`. Insertion order matters:
 * `protocolForValue` returns the first name whose number matches, exactly as
 * the provider's `range` over this map does.
 */
const SG_PROTOCOL_NUMBERS: ReadonlyMap<string, number> = new Map([
  ['icmpv6', 58],
  ['udp', 17],
  ['tcp', 6],
  ['icmp', 1],
  ['all', -1],
]);

/**
 * The provider's `protocolForValue` (`vpc_security_group.go:1473-1503`),
 * reimplemented rather than approximated.
 *
 * The scanner stores AWS's raw `IpProtocol` (`collect/network.ts:79`); the
 * state stores whatever `protocolStateFunc` normalised it to. Without this the
 * two paths would import the same rule under different strings — `6` here,
 * `tcp` there — and the plan's agreement property would hold only by luck of
 * what the API happened to return.
 */
function protocolForValue(raw: string): string {
  const protocol = raw.toLowerCase();
  if (protocol === '-1' || protocol === 'all') return '-1';
  if (SG_PROTOCOL_NUMBERS.has(protocol)) return protocol;
  const asNumber = Number.parseInt(protocol, 10);
  if (Number.isNaN(asNumber)) return protocol;
  for (const [name, value] of SG_PROTOCOL_NUMBERS) if (value === asNumber) return name;
  return protocol;
}

/**
 * A list-of-strings field. `undefined` means *malformed* — mirroring
 * `list()` in `rules/state.ts`, an element that is not a non-empty string makes
 * the whole list unreadable rather than silently shortening the import id.
 * An absent field is an empty list, which is different and common.
 */
function strList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) return undefined;
    out.push(item);
  }
  return out;
}

interface SgRef {
  readonly groupId: string;
  readonly accountId: string | undefined;
}

/** `SecurityGroupRule.securityGroupRefs`; `undefined` when malformed. */
function sgRefs(value: unknown): SgRef[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  const out: SgRef[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const record = item as Record<string, unknown>;
    const groupId = str(record['groupId']);
    if (groupId === undefined) return undefined;
    out.push({ groupId, accountId: str(record['accountId']) });
  }
  return out;
}

/** A port field. AWS omits both for `IpProtocol: "-1"`; the state holds 0. */
function portValue(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '0';
}

/**
 * Emitted on every rule block, because the block is only honest with it.
 *
 * `r/security_group_rule` opens with `~> **NOTE:** Avoid using the
 * aws_security_group_rule resource … use the current best practice of the
 * aws_vpc_security_group_egress_rule and aws_vpc_security_group_ingress_rule
 * resources`. Those modern types import by `security_group_rule_id` (`sgr-…`),
 * which requires `DescribeSecurityGroupRules` — a call no collector in this
 * repo makes, and a field `SecurityGroupRule` does not carry. Emitting a
 * guessed `sgr-…` would be precisely the confidently-wrong block this package
 * exists to prevent, so the legacy composite type is the only derivable one and
 * the reader is told that rather than left to discover it.
 */
const SGR_LEGACY_NOTE =
  'aws_security_group_rule is the legacy composite type, and the only one derivable from a ' +
  'scan. The provider docs recommend aws_vpc_security_group_ingress_rule / ' +
  'aws_vpc_security_group_egress_rule instead, but those import by security_group_rule_id ' +
  '(sgr-…), which this scan does not collect — so if your configuration uses the modern ' +
  'types, this block names the wrong resource type for it and must not be pasted as-is';

/**
 * `r/security_group_rule`'s `!> **WARNING:**` — mixing this type with the
 * modern rule resources, or with inline rules on the group, "may cause rule
 * conflicts, perpetual differences, and result in rules being overwritten".
 * The parent block this ships beside is an `aws_security_group`, so a reader
 * whose configuration writes inline `ingress` / `egress` blocks is one paste
 * away from that.
 */
const SGR_INLINE_NOTE =
  'do not combine aws_security_group_rule with inline ingress/egress blocks on the ' +
  'aws_security_group itself, or with the modern rule resources — the provider warns this ' +
  'causes rule conflicts, perpetual diffs and overwritten rules';

/**
 * A rule whose source is the group itself. AWS reports it as a
 * `UserIdGroupPair` holding the group's own id, and terraform accepts either
 * `self = true` or `source_security_group_id = <own id>` —
 * `expandIPPermission` (`vpc_security_group_rule.go:806-828`) issues the same
 * API call for both. A scan cannot tell which the configuration used, so the
 * id below reports what AWS reported and names the alternative rather than
 * guessing.
 */
const SGR_SELF_NOTE =
  "this rule's source is the group itself. Terraform writes that either as self = true or " +
  'as source_security_group_id = <the group id>; the id below uses the group id, which is ' +
  'what AWS reports. If your configuration uses self = true, replace the trailing group id ' +
  'with the literal self';

/**
 * One AWS `IpPermission` — one entry in `SecurityGroup.ingress` / `.egress` —
 * turned into the terraform resources that can represent it.
 *
 * **The fan-out rule, and it is not "one resource per source".** From the
 * provider schema (`vpc_security_group_rule.go:67,96,129,137`):
 * `cidr_blocks` and `ipv6_cidr_blocks` each conflict with
 * `source_security_group_id` and `self`; `prefix_list_ids` conflicts with
 * nothing; `source_security_group_id` is a `TypeString`, so one per resource.
 * Therefore the CIDR-shaped sources of one permission are a **single**
 * resource carrying all of them — `r/security_group_rule` documents exactly
 * that with `sg-4973616163_ingress_tcp_100_121_10.1.0.0/16_2001:db8::/48_…` —
 * and each referenced security group is a resource of its own.
 *
 * Source order is `cidr_blocks`, `ipv6_cidr_blocks`, `prefix_list_ids`, which
 * is the order `rules/state.ts` composes them in. The importer classifies each
 * trailing token by content, so order does not change *meaning*; it is matched
 * so the two paths produce the same string, which is the plan's agreement
 * property.
 */
function permissionRules(
  subject: ScannedSubject,
  groupId: string,
  entry: Record<string, unknown>,
  direction: 'ingress' | 'egress',
): ExpandedChild[] {
  const protocol = protocolForValue(str(entry['protocol']) ?? '-1');
  const fromPort = portValue(entry['fromPort']);
  const toPort = portValue(entry['toPort']);
  const head = [groupId, direction, protocol, fromPort, toPort];

  const protocolLabel = protocol === '-1' ? 'all' : protocol;
  const portLabel =
    protocol === '-1' && fromPort === '0' && toPort === '0'
      ? ''
      : fromPort === toPort
        ? fromPort
        : `${fromPort}_${toPort}`;
  const stem = [direction, protocolLabel, portLabel].filter((p) => p !== '').join('_');

  const cidrs = strList(entry['cidrs']);
  const ipv6Cidrs = strList(entry['ipv6Cidrs']);
  const prefixListIds = strList(entry['prefixListIds']);
  const refs = sgRefs(entry['securityGroupRefs']);
  const unreadable =
    cidrs === undefined ||
    ipv6Cidrs === undefined ||
    prefixListIds === undefined ||
    refs === undefined;

  // `resourceSecurityGroupRuleImport` rejects anything without the prefix
  // (`vpc_security_group_rule.go:459`), so a group id that never had one — an
  // empty `id`, a snapshot written by hand — cannot produce a usable block.
  const badGroupId = groupId.startsWith('sg-')
    ? undefined
    : `the scanned security group id ${JSON.stringify(groupId)} is not an sg-… identifier, ` +
      'so the provider will reject this import id';

  const child = (
    sources: readonly string[],
    label: string,
    extra: readonly string[] = [],
  ): ExpandedChild => ({
    type: 'aws_security_group_rule',
    label: `${stem}_${label}`,
    id: [...head, ...sources].join('_'),
    comments: [SGR_LEGACY_NOTE, SGR_INLINE_NOTE, ...extra],
    problem:
      badGroupId ??
      (unreadable
        ? 'this rule\'s source fields could not be read from the snapshot, so the import id ' +
          'below is missing at least one source — complete it before using it'
        : sources.length === 0
          ? 'no source or destination was collected for this rule, so the import id below is ' +
            'incomplete — append the source (an IPv4 CIDR, an IPv6 CIDR, a pl-… prefix list, ' +
            'an sg-… group id, or the literal self) after a final underscore'
          : undefined),
  });

  const out: ExpandedChild[] = [];
  const network = [...(cidrs ?? []), ...(ipv6Cidrs ?? []), ...(prefixListIds ?? [])];
  if (network.length > 0) {
    // Prefix lists ride with the CIDRs because nothing forbids it and it keeps
    // one permission to one resource. With no CIDRs they stand alone, which is
    // the doc's `sg-62726f6479_egress_tcp_8000_8000_pl-6469726b` example.
    const label = (cidrs?.length ?? 0) + (ipv6Cidrs?.length ?? 0) > 0 ? 'cidr' : 'prefix';
    out.push(child(network, label));
  }
  for (const ref of refs ?? []) {
    // `[OwnerID/]SecurityGroupID` — `expandIPPermission` splits on `/`
    // (`vpc_security_group_rule.go:815-828`). AWS reports `UserId` on every
    // pair including our own, so the prefix goes on only when it is genuinely
    // another account; adding it everywhere would disagree with the state path,
    // where a same-account config simply holds `sg-…`.
    const crossAccount = ref.accountId !== undefined && ref.accountId !== subject.accountId;
    const token = crossAccount ? `${ref.accountId}/${ref.groupId}` : ref.groupId;
    const isSelf = !crossAccount && ref.groupId === groupId;
    out.push(child([token], ref.groupId, isSelf ? [SGR_SELF_NOTE] : []));
  }
  // Neither a network source nor a group reference: still emitted, still
  // flagged. `mapSgRules` (`collect/network.ts:85-87`) drops a `UserIdGroupPair`
  // with no `GroupId`, which can empty a permission out entirely.
  if (out.length === 0) out.push(child([], 'no_source'));
  return out;
}

/**
 * `SecurityGroup.ingress` / `.egress` → `aws_security_group_rule` resources.
 *
 * Ingress before egress, snapshot order within each, so re-running produces a
 * stable diff. Malformed entries are skipped rather than thrown on: an expander
 * that throws costs its parent its own block, and a snapshot written by an
 * older scanner is not a reason to lose the group.
 */
function expandSecurityGroupRules(subject: ScannedSubject): ExpandedChild[] {
  const out: ExpandedChild[] = [];
  for (const direction of ['ingress', 'egress'] as const) {
    const entries = subject.raw[direction];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      out.push(
        ...permissionRules(subject, subject.id, entry as Record<string, unknown>, direction),
      );
    }
  }
  return out;
}

export const RULES: ImportRule[] = [
  // --- VPC building blocks -------------------------------------------------
  nativeId('aws_vpc', ['vpc'], 'vpc'),
  nativeId('aws_subnet', ['subnet'], 'subnet'),
  nativeId('aws_route_table', ['route-table'], 'route_table'),
  nativeId('aws_internet_gateway', ['igw'], 'internet_gateway'),
  nativeId('aws_egress_only_internet_gateway', ['eigw'], 'egress_only_internet_gateway'),
  nativeId('aws_nat_gateway', ['nat'], 'nat_gateway'),

  /**
   * The trap the plan names. `collect/network.ts:252` stores
   * `AllocationId ?? PublicIp ?? ''`, so an address with no allocation id — a
   * pre-VPC (EC2-Classic) EIP — arrives here as a bare `203.0.113.5`.
   * `aws_eip` imports by allocation id and the provider dropped EC2-Classic
   * support entirely, so there is no import id for those at all. Returning the
   * IP would produce a block that plans cleanly and adopts nothing.
   * `console-link.ts:42` already carves the same case out for ARN synthesis.
   */
  {
    type: 'aws_eip',
    kinds: ['eip'],
    doc: doc('eip'),
    fromScanned: (s) => (s.id.startsWith('eipalloc-') ? s.id : undefined),
  },

  nativeId('aws_network_acl', ['nacl'], 'network_acl'),
  /**
   * The group imports by its own id — and *contains* its rules, which
   * terraform models as separate resources. `expand` is what stops the panel
   * offering a block that adopts the group and silently leaves its rules
   * unmanaged. Declared here rather than in `rules/state.ts` because
   * `scanned-network.ts` comes first in the registry's `SOURCES` and only the
   * first declaration of a type is spread wholesale — see `ImportRule.expand`.
   */
  {
    ...nativeId('aws_security_group', ['sg'], 'security_group'),
    expand: expandSecurityGroupRules,
  },
  nativeId('aws_network_interface', ['eni'], 'network_interface'),
  nativeId('aws_vpc_endpoint', ['vpce'], 'vpc_endpoint'),
  // The consumer-side endpoint is `vpce-…`; this is the provider-side service
  // configuration, whose import id is the `vpce-svc-…` service id.
  // `collect/network.ts:386` stores `ServiceId`, not `ServiceName`.
  nativeId('aws_vpc_endpoint_service', ['vpce-service'], 'vpc_endpoint_service'),
  nativeId('aws_ec2_managed_prefix_list', ['prefix-list'], 'ec2_managed_prefix_list'),
  nativeId('aws_flow_log', ['flow-log'], 'flow_log'),
  nativeId('aws_vpc_dhcp_options', ['dhcp-options'], 'vpc_dhcp_options'),
  nativeId(
    'aws_ec2_instance_connect_endpoint',
    ['instance-connect-endpoint'],
    'ec2_instance_connect_endpoint',
  ),
  nativeId('aws_vpc_peering_connection', ['pcx'], 'vpc_peering_connection'),

  // --- Transit Gateway -----------------------------------------------------
  nativeId('aws_ec2_transit_gateway', ['tgw'], 'ec2_transit_gateway'),

  /**
   * All attachment kinds share the `tgw-attach-…` id — verified identical on
   * all three pages — but each is a different terraform resource.
   * `TransitGatewayAttachment.resourceType` (`TgwAttachmentResourceType` in
   * `schema/src/snapshot.ts`) selects it.
   *
   * `vpn` and `direct-connect-gateway` attachments have no attachment resource
   * of their own at all: they are created by `aws_vpn_connection` and
   * `aws_dx_gateway_association` respectively, so there is no type to name and
   * the subject declines. `other` is the collector's catch-all and declines for
   * the same reason.
   */
  {
    type: 'aws_ec2_transit_gateway_vpc_attachment',
    kinds: ['tgw-attachment'],
    doc: doc('ec2_transit_gateway_vpc_attachment'),
    typeChoices: [
      'aws_ec2_transit_gateway_vpc_attachment',
      'aws_ec2_transit_gateway_peering_attachment',
      'aws_ec2_transit_gateway_connect',
    ],
    typeFromScanned: (s) => {
      switch (rawStr(s, 'resourceType')) {
        case 'vpc':
          return 'aws_ec2_transit_gateway_vpc_attachment';
        // The collector emits both spellings; they are the same resource.
        case 'peering':
        case 'tgw-peering':
          return 'aws_ec2_transit_gateway_peering_attachment';
        case 'connect':
          return 'aws_ec2_transit_gateway_connect';
        default:
          return undefined;
      }
    },
    fromScanned: (s) => str(s.id),
  },

  nativeId('aws_ec2_transit_gateway_route_table', ['tgw-rt'], 'ec2_transit_gateway_route_table'),
  nativeId(
    'aws_ec2_transit_gateway_connect_peer',
    ['tgw-connect-peer'],
    'ec2_transit_gateway_connect_peer',
  ),

  // --- Site-to-site VPN ----------------------------------------------------
  nativeId('aws_vpn_gateway', ['vgw'], 'vpn_gateway'),
  nativeId('aws_customer_gateway', ['cgw'], 'customer_gateway'),
  nativeId('aws_vpn_connection', ['vpn'], 'vpn_connection'),

  // --- Direct Connect ------------------------------------------------------
  nativeId('aws_dx_connection', ['dx-connection'], 'dx_connection'),
  nativeId('aws_dx_lag', ['dx-lag'], 'dx_lag'),
  /**
   * All three VIF flavours import by the same `dxvif-…` id — the three doc
   * pages print the identical `id = "dxvif-33cc44dd"` example — and
   * `DxVirtualInterface.vifType` is `private | public | transit`, so the type
   * resolves exactly.
   *
   * The three `aws_dx_hosted_*_virtual_interface` variants are deliberately not
   * modelled. Those describe a VIF *allocated to another account*, which is a
   * property of the relationship rather than of the interface, and the snapshot
   * has no field that distinguishes an owned VIF from an allocated one
   * (`ownerAccount` is the VIF's owner, which is the scanned account in both
   * cases). Scanning the account that owns the VIF — the only case the atlas
   * sees — the plain type is the right one.
   */
  {
    type: 'aws_dx_private_virtual_interface',
    kinds: ['dx-vif'],
    doc: doc('dx_private_virtual_interface'),
    typeChoices: [
      'aws_dx_private_virtual_interface',
      'aws_dx_public_virtual_interface',
      'aws_dx_transit_virtual_interface',
    ],
    typeFromScanned: (s) => {
      switch (rawStr(s, 'vifType')) {
        case 'private':
          return 'aws_dx_private_virtual_interface';
        case 'public':
          return 'aws_dx_public_virtual_interface';
        case 'transit':
          return 'aws_dx_transit_virtual_interface';
        default:
          return undefined;
      }
    },
    fromScanned: (s) => str(s.id),
  },
  // Account-global: `collect/global.ts:192` stores `directConnectGatewayId`.
  nativeId('aws_dx_gateway', ['dxgw'], 'dx_gateway'),

  // --- Load balancing ------------------------------------------------------
  /**
   * The only one of these six where the two variants disagree about the *id* as
   * well as the type, so it is the only one whose `fromScanned` still branches.
   *
   * `aws_lb` (application / network / gateway) imports by ARN, and
   * `collect/elb.ts:85` stores the ARN in `id` — one of the ARN-in-`id` cases
   * that happens to be right. `aws_elb` (classic) imports by **name**
   * (`r/elb.html.markdown`: `id = "elb-production-12345"`), and
   * `collect/elb.ts:253` stores the name in `id` with no `arn` at all.
   *
   * Registering only `aws_lb` used to emit `to = aws_lb.my-classic-elb` with
   * `id = "my-classic-elb"` under a comment blaming the id — but the name *is*
   * the right id, for `aws_elb`. Both halves are now answered from `lbType`.
   */
  {
    type: 'aws_lb',
    kinds: ['lb'],
    doc: doc('lb'),
    typeChoices: ['aws_lb', 'aws_elb'],
    typeFromScanned: (s) => {
      switch (rawStr(s, 'lbType')) {
        case 'classic':
          return 'aws_elb';
        case 'application':
        case 'network':
        case 'gateway':
          return 'aws_lb';
        default:
          return undefined;
      }
    },
    fromScanned: (s) => {
      switch (rawStr(s, 'lbType')) {
        case 'classic': {
          // The name, never an ARN: a classic ELB carries none, so an ARN here
          // means the field is not what this rule thinks it is.
          const name = str(s.name) ?? str(s.id);
          return name !== undefined && parseArn(name) === undefined ? name : undefined;
        }
        case 'application':
        case 'network':
        case 'gateway':
          return str(s.arn) ?? (parseArn(s.id) !== undefined ? s.id : undefined);
        default:
          // `lb` is the one kind here whose variants disagree about the *id*
          // form as well as the type, so an unknown `lbType` leaves both
          // unknown. Returning the ARN would let `from-scanned.ts` tell the
          // reader the id is right whichever candidate this is — and for
          // `aws_elb` it would not be.
          return undefined;
      }
    },
  },
  // `collect/elb.ts:208` stores the ARN in `id`; aws_lb_target_group imports by ARN.
  arnId('aws_lb_target_group', ['tg'], 'lb_target_group'),

  // --- Route 53 ------------------------------------------------------------
  // `collect/global.ts:65` already strips the `/hostedzone/` prefix, which is
  // what makes the bare `Z…` the import id here.
  nativeId('aws_route53_zone', ['zone'], 'route53_zone'),
  nativeId('aws_route53_resolver_endpoint', ['resolver-endpoint'], 'route53_resolver_endpoint'),
  nativeId('aws_route53_resolver_rule', ['resolver-rule'], 'route53_resolver_rule'),
  nativeId(
    'aws_route53_resolver_query_log_config',
    ['resolver-query-log-config'],
    'route53_resolver_query_log_config',
  ),
  nativeId(
    'aws_route53_resolver_firewall_rule_group',
    ['dns-firewall-rule-group'],
    'route53_resolver_firewall_rule_group',
  ),

  // --- Client VPN ----------------------------------------------------------
  nativeId('aws_ec2_client_vpn_endpoint', ['client-vpn'], 'ec2_client_vpn_endpoint'),

  // --- Network Firewall ----------------------------------------------------
  // Every one of these imports by ARN while the collector stores the *name* in
  // `id` (`collect/edge-network.ts:324`, `:363`, `:402`, `:460` — each reads
  // `<Name> ?? <name> ?? <arn>`). Reading `subject.id` here is the single
  // easiest way to emit a confidently wrong block in this half of the table.
  arnId('aws_networkfirewall_firewall', ['network-firewall'], 'networkfirewall_firewall'),
  arnId(
    'aws_networkfirewall_firewall_policy',
    ['network-firewall-policy'],
    'networkfirewall_firewall_policy',
  ),
  arnId(
    'aws_networkfirewall_rule_group',
    ['network-firewall-rule-group'],
    'networkfirewall_rule_group',
  ),
  arnId(
    'aws_networkfirewall_tls_inspection_configuration',
    ['network-firewall-tls-config'],
    'networkfirewall_tls_inspection_configuration',
  ),

  // --- API Gateway ---------------------------------------------------------
  /**
   * REST (v1) and HTTP/WebSocket (v2) APIs land in one `apigw` collection with
   * one id shape but two terraform types — `aws_api_gateway_rest_api` and
   * `aws_apigatewayv2_api`, both importing by the bare API id.
   * `ApiGateway.protocolType` is set to `'REST'` by the v1 collector
   * (`collect/edge-network.ts:485`) and to the API's own protocol by the v2
   * one, so it discriminates exactly.
   */
  {
    type: 'aws_api_gateway_rest_api',
    kinds: ['apigw'],
    doc: doc('api_gateway_rest_api'),
    typeChoices: ['aws_api_gateway_rest_api', 'aws_apigatewayv2_api'],
    typeFromScanned: (s) => {
      switch (rawStr(s, 'protocolType')) {
        case 'REST':
          return 'aws_api_gateway_rest_api';
        case 'HTTP':
        case 'WEBSOCKET':
          return 'aws_apigatewayv2_api';
        default:
          return undefined;
      }
    },
    // `r/apigatewayv2_api.html.markdown` prints `id = "aabbccddee"`, the same
    // bare API identifier the v1 page does — the id was never the ambiguity.
    fromScanned: (s) => str(s.id),
  },
  /**
   * `ApiGatewayVpcLink.version` is an explicit `'v1' | 'v2'` discriminator —
   * one of the few places the snapshot says outright which API family a record
   * came from — and both pages import by the bare link id
   * (`aws_apigatewayv2_vpc_link`: `id = "aabbccddee"`).
   */
  {
    type: 'aws_api_gateway_vpc_link',
    kinds: ['apigw-vpc-link'],
    doc: doc('api_gateway_vpc_link'),
    typeChoices: ['aws_api_gateway_vpc_link', 'aws_apigatewayv2_vpc_link'],
    typeFromScanned: (s) => {
      switch (rawStr(s, 'version')) {
        case 'v1':
          return 'aws_api_gateway_vpc_link';
        case 'v2':
          return 'aws_apigatewayv2_vpc_link';
        default:
          return undefined;
      }
    },
    fromScanned: (s) => str(s.id),
  },
  /**
   * The one kind here that is **genuinely unresolvable** for its commonest
   * variant, and the reason `typeFromScanned` had to be allowed to answer
   * `undefined` rather than being required to pick.
   *
   * `ApiGatewayDomainName` carries no version discriminator — unlike
   * `ApiGatewayVpcLink`, which does — and `collect/edge-network.ts:717` / `:756`
   * merge v1 and v2 domains into one collection behind a shared `seenDomains`
   * set, so provenance is gone by the time the snapshot is written.
   * `endpointTypes` is the only signal left, and it separates the three cases
   * unevenly:
   *
   *  - `EDGE` exists on REST custom domains alone, so it confirms
   *    `aws_api_gateway_domain_name` *and* the plain `dev.example.com` id.
   *  - `PRIVATE` also confirms v1 —
   *    `r/apigatewayv2_domain_name.html.markdown` documents `endpoint_type`
   *    with valid values `REGIONAL` only, so v2 cannot be private. The **type**
   *    therefore resolves; the **id** does not, because a private custom domain
   *    imports by `<name>/<domain_name_id>` (second example on the v1 page) and
   *    the snapshot has no `domainNameId` field. This subject gets a real
   *    `to =` and a flagged id, which is the honest split.
   *  - `REGIONAL` is valid on both, so the type is unknowable from a snapshot.
   *    The id is the domain name for either type, so the emitted block is
   *    commented out with a correct id and a named shortlist.
   */
  {
    type: 'aws_api_gateway_domain_name',
    kinds: ['apigw-domain'],
    doc: doc('api_gateway_domain_name'),
    typeChoices: ['aws_api_gateway_domain_name', 'aws_apigatewayv2_domain_name'],
    typeFromScanned: (s) => {
      const types = s.raw['endpointTypes'];
      if (!Array.isArray(types)) return undefined;
      // PRIVATE and EDGE are both v1-exclusive; PRIVATE is checked first
      // because it also changes the id form.
      if (types.includes('PRIVATE') || types.includes('EDGE')) {
        return 'aws_api_gateway_domain_name';
      }
      return undefined;
    },
    fromScanned: (s) => {
      const types = s.raw['endpointTypes'];
      // With no endpoint types at all a private domain cannot be ruled out, so
      // neither half is knowable — decline both rather than let the caller
      // report the bare name as right whichever candidate this is.
      if (!Array.isArray(types) || types.length === 0) return undefined;
      // A private domain's id is `<name>/<domain_name_id>` and `domainNameId`
      // is not collected. Emitting the bare name would produce a block that
      // parses and adopts the wrong thing — decline the id, keep the type.
      if (types.includes('PRIVATE')) return undefined;
      return rawStr(s, 'domainName') ?? str(s.id);
    },
  },

  // --- VPC Lattice ---------------------------------------------------------
  // The Lattice list APIs return both a short native id and an ARN; the
  // collector stores the short id (`collect/lattice.ts:46` and friends) and
  // every one of these types imports by it.
  nativeId('aws_vpclattice_service_network', ['lattice-service-network'], 'vpclattice_service_network'),
  nativeId('aws_vpclattice_service', ['lattice-service'], 'vpclattice_service'),
  nativeId('aws_vpclattice_target_group', ['lattice-target-group'], 'vpclattice_target_group'),
  nativeId('aws_vpclattice_resource_gateway', ['lattice-resource-gateway'], 'vpclattice_resource_gateway'),
  nativeId(
    'aws_vpclattice_resource_configuration',
    ['lattice-resource-configuration'],
    'vpclattice_resource_configuration',
  ),

  // --- Global edge ---------------------------------------------------------
  nativeId('aws_cloudfront_distribution', ['cloudfront'], 'cloudfront_distribution'),
  nativeId('aws_cloudfront_vpc_origin', ['cloudfront-vpc-origin'], 'cloudfront_vpc_origin'),
  // `collect/global-accelerator.ts:34` stores the ARN in `id` — correct here,
  // because the accelerator genuinely imports by ARN.
  arnId('aws_globalaccelerator_accelerator', ['global-accelerator'], 'globalaccelerator_accelerator'),
  nativeId('aws_networkmanager_core_network', ['core-network'], 'networkmanager_core_network'),

  // --- WAFv2 ---------------------------------------------------------------
  wafv2('aws_wafv2_web_acl', 'waf-web-acl', 'wafv2_web_acl'),
  wafv2('aws_wafv2_ip_set', 'waf-ip-set', 'wafv2_ip_set'),
  wafv2('aws_wafv2_rule_group', 'waf-rule-group', 'wafv2_rule_group'),
];
