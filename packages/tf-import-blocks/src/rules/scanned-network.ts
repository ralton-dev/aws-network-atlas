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
 * **One kind, several terraform types.** `ImportRule.type` is a single string
 * that is both the merge key and the type emitted, so a kind that spans two
 * provider resources can only register the dominant one. Six do: `lb`
 * (`aws_lb` / `aws_elb`), `tgw-attachment` (vpc / peering / connect), `dx-vif`
 * (private / public / transit), `apigw` (REST / v2), `apigw-vpc-link` (v1/v2)
 * and `apigw-domain` (v1/v2). Each guards on the snapshot field that
 * discriminates them and yields `undefined` for the variants it cannot
 * represent, so the wrong type is always accompanied by a `# VERIFY`.
 */
import { parseArn, str, type ImportRule, type ScannedSubject } from '../types.js';

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
  nativeId('aws_security_group', ['sg'], 'security_group'),
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
   * All attachment kinds share the `tgw-attach-…` id, but each is a different
   * terraform resource: `_vpc_attachment`, `_peering_attachment`, `_connect`.
   * VPC is far and away the common case and is the one registered;
   * `TransitGatewayAttachment.resourceType` discriminates, so a peering or
   * connect attachment declines rather than claiming to be a VPC attachment.
   * A `vpn` or `direct-connect-gateway` attachment has no attachment resource
   * of its own at all — it is created by the VPN connection or the DX gateway
   * association — so those decline too.
   */
  {
    type: 'aws_ec2_transit_gateway_vpc_attachment',
    kinds: ['tgw-attachment'],
    doc: doc('ec2_transit_gateway_vpc_attachment'),
    fromScanned: (s) => (rawStr(s, 'resourceType') === 'vpc' ? str(s.id) : undefined),
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
   * All three VIF flavours import by the same `dxvif-…` id but are three
   * terraform types (plus three `_hosted_` variants for VIFs allocated to
   * another account). `DxVirtualInterface.vifType` is `private | public |
   * transit`; only `private` is claimed, and the other two decline so the
   * mismatch is flagged rather than pasted.
   */
  {
    type: 'aws_dx_private_virtual_interface',
    kinds: ['dx-vif'],
    doc: doc('dx_private_virtual_interface'),
    fromScanned: (s) => (rawStr(s, 'vifType') === 'private' ? str(s.id) : undefined),
  },
  // Account-global: `collect/global.ts:192` stores `directConnectGatewayId`.
  nativeId('aws_dx_gateway', ['dxgw'], 'dx_gateway'),

  // --- Load balancing ------------------------------------------------------
  /**
   * `aws_lb` imports by ARN, and `collect/elb.ts:81` stores the ARN in `id` —
   * one of the fifteen ARN-in-`id` cases in the tree that happens to be right.
   *
   * Classic ELBs share the `lb` kind but are `aws_elb`, a different type that
   * imports by *name*; `collect/elb.ts:250` stores the name in `id` and no
   * `arn` at all. Emitting `to = aws_lb.<name>` with `id = "<name>"` would be
   * two errors that cancel into a block that looks plausible, so `classic`
   * declines.
   */
  {
    type: 'aws_lb',
    kinds: ['lb'],
    doc: doc('lb'),
    fromScanned: (s) => {
      if (rawStr(s, 'lbType') === 'classic') return undefined;
      return str(s.arn) ?? (parseArn(s.id) !== undefined ? s.id : undefined);
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
    fromScanned: (s) => (rawStr(s, 'protocolType') === 'REST' ? str(s.id) : undefined),
  },
  /** `ApiGatewayVpcLink.version` is an explicit `'v1' | 'v2'` discriminator. */
  {
    type: 'aws_api_gateway_vpc_link',
    kinds: ['apigw-vpc-link'],
    doc: doc('api_gateway_vpc_link'),
    fromScanned: (s) => (rawStr(s, 'version') === 'v1' ? str(s.id) : undefined),
  },
  /**
   * Both `aws_api_gateway_domain_name` and `aws_apigatewayv2_domain_name`
   * import by the domain name, so the *id* is never in doubt — the *type* is.
   * `ApiGatewayDomainName` carries no version discriminator (unlike
   * `ApiGatewayVpcLink`, which does), and `collect/edge-network.ts:725` / `:766`
   * merge v1 and v2 domains into one collection behind a shared `seenDomains`
   * set. `endpointTypes` is the only signal: `EDGE` and `PRIVATE` exist on REST
   * custom domains alone, so those confirm v1; a `REGIONAL`-only domain could
   * be either and declines, which costs nothing — the fallback id is the same
   * string — and buys an honest `# VERIFY`.
   */
  {
    type: 'aws_api_gateway_domain_name',
    kinds: ['apigw-domain'],
    doc: doc('api_gateway_domain_name'),
    fromScanned: (s) => {
      const types = s.raw['endpointTypes'];
      const v1Only =
        Array.isArray(types) && types.some((t) => t === 'EDGE' || t === 'PRIVATE');
      if (!v1Only) return undefined;
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
