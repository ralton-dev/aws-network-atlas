/**
 * WP-B's pin: every network/edge `kind` the viewer builds resolves to the
 * terraform type and import id the provider documents.
 *
 * The table below is the specification, not a sample. Each id was read off
 * `website/docs/r/<type>.html.markdown` in `hashicorp/terraform-provider-aws`
 * on `main` (2026-08-07), from the `id = "…"` / `terraform import` console
 * form — the `identity = { … }` block those pages now print *first* is
 * forbidden by decision 3 and is not what this package emits.
 *
 * `EXPECTED_KINDS` is the other half of the contract: it is the network/edge
 * half of the `add('<kind>', …)` calls in `packages/viewer/src/data.ts`, kept
 * here by hand so that a kind appearing in the viewer and not in the rule
 * table fails here rather than silently emitting a `# VERIFY` block forever.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RULES,
  emitBlock,
  resolveScanned,
  ruleForKind,
  type ScannedSubject,
} from '../src/index.js';

const subject = (
  kind: string,
  id: string,
  over: Partial<ScannedSubject> = {},
): ScannedSubject => ({
  kind,
  id,
  region: 'eu-west-1',
  accountId: '111122223333',
  raw: {},
  ...over,
});

const NFW = 'arn:aws:network-firewall:eu-west-1:111122223333';

interface Case {
  readonly subject: ScannedSubject;
  readonly type: string;
  readonly id: string;
}

/** One representative subject per kind, with the pair it must resolve to. */
const CASES: readonly Case[] = [
  // --- VPC building blocks (native-id passthrough) -------------------------
  { subject: subject('vpc', 'vpc-0a1b2c3d4e5f67890'), type: 'aws_vpc', id: 'vpc-0a1b2c3d4e5f67890' },
  {
    subject: subject('subnet', 'subnet-0a1b2c3d4e5f67890'),
    type: 'aws_subnet',
    id: 'subnet-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('route-table', 'rtb-0a1b2c3d4e5f67890'),
    type: 'aws_route_table',
    id: 'rtb-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('igw', 'igw-0a1b2c3d4e5f67890'),
    type: 'aws_internet_gateway',
    id: 'igw-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('eigw', 'eigw-0a1b2c3d4e5f67890'),
    type: 'aws_egress_only_internet_gateway',
    id: 'eigw-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('nat', 'nat-0a1b2c3d4e5f67890'),
    type: 'aws_nat_gateway',
    id: 'nat-0a1b2c3d4e5f67890',
  },
  // The VPC case; the EC2-Classic case has its own test below.
  {
    subject: subject('eip', 'eipalloc-0a1b2c3d4e5f67890'),
    type: 'aws_eip',
    id: 'eipalloc-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('nacl', 'acl-0a1b2c3d4e5f67890'),
    type: 'aws_network_acl',
    id: 'acl-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('sg', 'sg-0a1b2c3d4e5f67890'),
    type: 'aws_security_group',
    id: 'sg-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('eni', 'eni-0a1b2c3d4e5f67890'),
    type: 'aws_network_interface',
    id: 'eni-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('vpce', 'vpce-0a1b2c3d4e5f67890'),
    type: 'aws_vpc_endpoint',
    id: 'vpce-0a1b2c3d4e5f67890',
  },
  // Provider side, not consumer side: the import id is the `vpce-svc-…`
  // service id, never the `com.amazonaws.vpce.…` service name.
  {
    subject: subject('vpce-service', 'vpce-svc-0f97a19d3fa8220bc', {
      name: 'com.amazonaws.vpce.eu-west-1.vpce-svc-0f97a19d3fa8220bc',
      raw: { serviceName: 'com.amazonaws.vpce.eu-west-1.vpce-svc-0f97a19d3fa8220bc' },
    }),
    type: 'aws_vpc_endpoint_service',
    id: 'vpce-svc-0f97a19d3fa8220bc',
  },
  {
    subject: subject('prefix-list', 'pl-0570a1d2d725c16be'),
    type: 'aws_ec2_managed_prefix_list',
    id: 'pl-0570a1d2d725c16be',
  },
  { subject: subject('flow-log', 'fl-1a2b3c4d'), type: 'aws_flow_log', id: 'fl-1a2b3c4d' },
  {
    subject: subject('dhcp-options', 'dopt-0a1b2c3d4e5f67890'),
    type: 'aws_vpc_dhcp_options',
    id: 'dopt-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('instance-connect-endpoint', 'eice-0a1b2c3d4e5f67890'),
    type: 'aws_ec2_instance_connect_endpoint',
    id: 'eice-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('pcx', 'pcx-0a1b2c3d4e5f67890'),
    type: 'aws_vpc_peering_connection',
    id: 'pcx-0a1b2c3d4e5f67890',
  },

  // --- Transit Gateway -----------------------------------------------------
  {
    subject: subject('tgw', 'tgw-0a1b2c3d4e5f67890'),
    type: 'aws_ec2_transit_gateway',
    id: 'tgw-0a1b2c3d4e5f67890',
  },
  {
    subject: subject('tgw-attachment', 'tgw-attach-0a1b2c3d4e5f6789', {
      raw: { resourceType: 'vpc' },
    }),
    type: 'aws_ec2_transit_gateway_vpc_attachment',
    id: 'tgw-attach-0a1b2c3d4e5f6789',
  },
  {
    subject: subject('tgw-rt', 'tgw-rtb-0a1b2c3d4e5f6789'),
    type: 'aws_ec2_transit_gateway_route_table',
    id: 'tgw-rtb-0a1b2c3d4e5f6789',
  },
  {
    subject: subject('tgw-connect-peer', 'tgw-connect-peer-0a1b2c3d4e5f6'),
    type: 'aws_ec2_transit_gateway_connect_peer',
    id: 'tgw-connect-peer-0a1b2c3d4e5f6',
  },

  // --- Site-to-site VPN ----------------------------------------------------
  { subject: subject('vgw', 'vgw-9a4cacf3'), type: 'aws_vpn_gateway', id: 'vgw-9a4cacf3' },
  { subject: subject('cgw', 'cgw-b4dc3961'), type: 'aws_customer_gateway', id: 'cgw-b4dc3961' },
  { subject: subject('vpn', 'vpn-40f41529'), type: 'aws_vpn_connection', id: 'vpn-40f41529' },

  // --- Direct Connect ------------------------------------------------------
  {
    subject: subject('dx-connection', 'dxcon-ffre0ec3'),
    type: 'aws_dx_connection',
    id: 'dxcon-ffre0ec3',
  },
  { subject: subject('dx-lag', 'dxlag-fgnsp5rq'), type: 'aws_dx_lag', id: 'dxlag-fgnsp5rq' },
  {
    subject: subject('dx-vif', 'dxvif-33cc44dd', { raw: { vifType: 'private' } }),
    type: 'aws_dx_private_virtual_interface',
    id: 'dxvif-33cc44dd',
  },
  {
    subject: subject('dxgw', 'abcd1234-dcba-5678-be23-cdef9876ab45', { region: '' }),
    type: 'aws_dx_gateway',
    id: 'abcd1234-dcba-5678-be23-cdef9876ab45',
  },

  // --- Load balancing (ARN, not id — though here they coincide) ------------
  {
    subject: subject(
      'lb',
      'arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/web/50dc6c495c0c9188',
      {
        arn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/web/50dc6c495c0c9188',
        name: 'web',
        raw: { lbType: 'application' },
      },
    ),
    type: 'aws_lb',
    id: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/web/50dc6c495c0c9188',
  },
  {
    subject: subject(
      'tg',
      'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/web/20cfe21448b66314',
      {
        arn: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/web/20cfe21448b66314',
        name: 'web',
      },
    ),
    type: 'aws_lb_target_group',
    id: 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/web/20cfe21448b66314',
  },

  // --- Route 53 ------------------------------------------------------------
  // Bare `Z…`: `collect/global.ts:65` has already stripped `/hostedzone/`.
  {
    subject: subject('zone', 'Z1D633PJN98FT9', { region: '', name: 'example.com.' }),
    type: 'aws_route53_zone',
    id: 'Z1D633PJN98FT9',
  },
  {
    subject: subject('resolver-endpoint', 'rslvr-in-abcdef01234567890'),
    type: 'aws_route53_resolver_endpoint',
    id: 'rslvr-in-abcdef01234567890',
  },
  {
    subject: subject('resolver-rule', 'rslvr-rr-0123456789abcdef0'),
    type: 'aws_route53_resolver_rule',
    id: 'rslvr-rr-0123456789abcdef0',
  },
  {
    subject: subject('resolver-query-log-config', 'rqlc-92edc3b1838248bf'),
    type: 'aws_route53_resolver_query_log_config',
    id: 'rqlc-92edc3b1838248bf',
  },
  {
    subject: subject('dns-firewall-rule-group', 'rslvr-frg-0123456789abcdef'),
    type: 'aws_route53_resolver_firewall_rule_group',
    id: 'rslvr-frg-0123456789abcdef',
  },

  // --- Client VPN ----------------------------------------------------------
  {
    subject: subject('client-vpn', 'cvpn-endpoint-0ac3a1abbccddd666'),
    type: 'aws_ec2_client_vpn_endpoint',
    id: 'cvpn-endpoint-0ac3a1abbccddd666',
  },

  // --- Network Firewall: `id` is the NAME, the import id is the ARN --------
  {
    subject: subject('network-firewall', 'prod-inspection', {
      arn: `${NFW}:firewall/prod-inspection`,
      name: 'prod-inspection',
    }),
    type: 'aws_networkfirewall_firewall',
    id: `${NFW}:firewall/prod-inspection`,
  },
  {
    subject: subject('network-firewall-policy', 'prod-policy', {
      arn: `${NFW}:firewall-policy/prod-policy`,
      name: 'prod-policy',
    }),
    type: 'aws_networkfirewall_firewall_policy',
    id: `${NFW}:firewall-policy/prod-policy`,
  },
  {
    subject: subject('network-firewall-rule-group', 'block-bad-domains', {
      arn: `${NFW}:stateful-rulegroup/block-bad-domains`,
      name: 'block-bad-domains',
    }),
    type: 'aws_networkfirewall_rule_group',
    id: `${NFW}:stateful-rulegroup/block-bad-domains`,
  },
  {
    subject: subject('network-firewall-tls-config', 'tls-inspect', {
      arn: `${NFW}:tls-configuration/tls-inspect`,
      name: 'tls-inspect',
    }),
    type: 'aws_networkfirewall_tls_inspection_configuration',
    id: `${NFW}:tls-configuration/tls-inspect`,
  },

  // --- API Gateway ---------------------------------------------------------
  {
    subject: subject('apigw', '12345abcde', { name: 'orders-rest', raw: { protocolType: 'REST' } }),
    type: 'aws_api_gateway_rest_api',
    id: '12345abcde',
  },
  {
    subject: subject('apigw-vpc-link', '12345abcde', { raw: { version: 'v1' } }),
    type: 'aws_api_gateway_vpc_link',
    id: '12345abcde',
  },
  {
    subject: subject('apigw-domain', 'dev.example.com', {
      name: 'dev.example.com',
      raw: { domainName: 'dev.example.com', endpointTypes: ['EDGE'] },
    }),
    type: 'aws_api_gateway_domain_name',
    id: 'dev.example.com',
  },

  // --- VPC Lattice ---------------------------------------------------------
  {
    subject: subject('lattice-service-network', 'sn-0158f91c1e3358dba', {
      arn: 'arn:aws:vpc-lattice:eu-west-1:111122223333:servicenetwork/sn-0158f91c1e3358dba',
    }),
    type: 'aws_vpclattice_service_network',
    id: 'sn-0158f91c1e3358dba',
  },
  {
    subject: subject('lattice-service', 'svc-06728e2357ea55f8a', {
      arn: 'arn:aws:vpc-lattice:eu-west-1:111122223333:service/svc-06728e2357ea55f8a',
    }),
    type: 'aws_vpclattice_service',
    id: 'svc-06728e2357ea55f8a',
  },
  {
    subject: subject('lattice-target-group', 'tg-0c11d4dc16ed96bdb', {
      arn: 'arn:aws:vpc-lattice:eu-west-1:111122223333:targetgroup/tg-0c11d4dc16ed96bdb',
    }),
    type: 'aws_vpclattice_target_group',
    id: 'tg-0c11d4dc16ed96bdb',
  },
  {
    subject: subject('lattice-resource-gateway', 'rgw-0a1b2c3d4e5f'),
    type: 'aws_vpclattice_resource_gateway',
    id: 'rgw-0a1b2c3d4e5f',
  },
  {
    subject: subject('lattice-resource-configuration', 'rcfg-1234567890abcdef1'),
    type: 'aws_vpclattice_resource_configuration',
    id: 'rcfg-1234567890abcdef1',
  },

  // --- Global edge ---------------------------------------------------------
  {
    subject: subject('cloudfront', 'E74FTE3EXAMPLE', { region: '' }),
    type: 'aws_cloudfront_distribution',
    id: 'E74FTE3EXAMPLE',
  },
  {
    subject: subject('cloudfront-vpc-origin', 'vo_JQEa410sssUFoY6wMkx69j', { region: '' }),
    type: 'aws_cloudfront_vpc_origin',
    id: 'vo_JQEa410sssUFoY6wMkx69j',
  },
  {
    subject: subject(
      'global-accelerator',
      'arn:aws:globalaccelerator::111122223333:accelerator/1a2b3c4d-5e6f-7788-99aa-bbccddeeff00',
      {
        region: '',
        arn: 'arn:aws:globalaccelerator::111122223333:accelerator/1a2b3c4d-5e6f-7788-99aa-bbccddeeff00',
      },
    ),
    type: 'aws_globalaccelerator_accelerator',
    id: 'arn:aws:globalaccelerator::111122223333:accelerator/1a2b3c4d-5e6f-7788-99aa-bbccddeeff00',
  },
  {
    subject: subject('core-network', 'core-network-0d47f6t230mz46dy4', { region: '' }),
    type: 'aws_networkmanager_core_network',
    id: 'core-network-0d47f6t230mz46dy4',
  },

  // --- WAFv2: `<id>/<name>/<scope>` ---------------------------------------
  {
    subject: subject('waf-web-acl', 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbb', {
      name: 'edge-acl',
      raw: { scope: 'REGIONAL' },
    }),
    type: 'aws_wafv2_web_acl',
    id: 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbb/edge-acl/REGIONAL',
  },
  {
    subject: subject('waf-ip-set', 'b2c3d4e5-d5f6-7777-8888-9999aaaabbbb', {
      name: 'office-ips',
      raw: { scope: 'REGIONAL' },
    }),
    type: 'aws_wafv2_ip_set',
    id: 'b2c3d4e5-d5f6-7777-8888-9999aaaabbbb/office-ips/REGIONAL',
  },
  {
    subject: subject('waf-rule-group', 'c3d4e5f6-d5f6-7777-8888-9999aaaabbbb', {
      name: 'custom-rules',
      raw: { scope: 'REGIONAL' },
    }),
    type: 'aws_wafv2_rule_group',
    id: 'c3d4e5f6-d5f6-7777-8888-9999aaaabbbb/custom-rules/REGIONAL',
  },
];

/**
 * The network/edge half of `packages/viewer/src/data.ts`, by hand. The
 * workload/data/security/identity half belongs to `scanned-workload.ts`; these
 * two lists must stay disjoint, because `registry.ts` indexes by kind
 * first-wins and *silently* — a kind claimed twice records no conflict.
 */
const EXPECTED_KINDS: readonly string[] = [
  'vpc', 'subnet', 'route-table', 'igw', 'eigw', 'nat', 'eip', 'nacl', 'sg', 'eni',
  'vpce', 'vpce-service', 'prefix-list', 'flow-log', 'dhcp-options',
  'instance-connect-endpoint', 'pcx',
  'tgw', 'tgw-attachment', 'tgw-rt', 'tgw-connect-peer',
  'vgw', 'cgw', 'vpn',
  'dx-connection', 'dx-lag', 'dx-vif', 'dxgw',
  'lb', 'tg',
  'zone', 'resolver-endpoint', 'resolver-rule', 'resolver-query-log-config',
  'dns-firewall-rule-group', 'client-vpn',
  'network-firewall', 'network-firewall-policy', 'network-firewall-rule-group',
  'network-firewall-tls-config',
  'apigw', 'apigw-vpc-link', 'apigw-domain',
  'lattice-service-network', 'lattice-service', 'lattice-target-group',
  'lattice-resource-gateway', 'lattice-resource-configuration',
  'cloudfront', 'cloudfront-vpc-origin', 'global-accelerator', 'core-network',
  'waf-web-acl', 'waf-ip-set', 'waf-rule-group',
];

for (const c of CASES) {
  test(`${c.subject.kind} → ${c.type}`, () => {
    const resolved = resolveScanned(c.subject);
    assert.equal(resolved.type, c.type);
    assert.equal(resolved.id, c.id);
    assert.equal(
      resolved.verified,
      true,
      `${c.subject.kind} fell back instead of using its rule: ${resolved.comments.join(' | ')}`,
    );
  });
}

test('the table covers every network/edge kind exactly once', () => {
  const covered = CASES.map((c) => c.subject.kind).sort();
  assert.deepEqual(covered, [...EXPECTED_KINDS].sort());
  assert.equal(new Set(covered).size, covered.length, 'a kind is represented twice');
});

test('every network/edge kind has a rule', () => {
  const missing = EXPECTED_KINDS.filter((k) => ruleForKind(k) === undefined);
  assert.deepEqual(missing, [], `kinds with no rule: ${missing.join(', ')}`);
});

test('every rule names the provider doc page its id format came from', () => {
  const undocumented = RULES.filter(
    (r) => r.fromScanned !== undefined && EXPECTED_KINDS.some((k) => (r.kinds ?? []).includes(k)),
  ).filter((r) => r.doc === undefined);
  assert.deepEqual(undocumented.map((r) => r.type), []);
});

/**
 * The boundary `registry.ts` cannot police. Its `byKind` index is built
 * first-wins and records no `CONFLICTS` entry, so if two rule modules claim one
 * kind under different terraform types the first module in source order wins
 * invisibly. This is the only place that would say so.
 */
test('no atlas kind is claimed by two different terraform types', () => {
  const owner = new Map<string, string>();
  const clashes: string[] = [];
  for (const rule of RULES) {
    for (const kind of rule.kinds ?? []) {
      const prev = owner.get(kind);
      if (prev !== undefined && prev !== rule.type) clashes.push(`${kind}: ${prev} vs ${rule.type}`);
      else owner.set(kind, rule.type);
    }
  }
  assert.deepEqual(clashes, [], `kinds claimed by two types: ${clashes.join('; ')}`);
});

// --- The EIP trap ----------------------------------------------------------

/**
 * `collect/network.ts:252` stores `AllocationId ?? PublicIp ?? ''`, so a
 * pre-VPC (EC2-Classic) address arrives with a bare IP as its `id`. `aws_eip`
 * imports by allocation id and the provider no longer supports EC2-Classic at
 * all, so there is no import id for one of these.
 *
 * The rule therefore returns `undefined`. Note what that does and does not do:
 * decision 5 forbids dropping a resource, so `from-scanned.ts` still emits the
 * block and still falls back to the scanned identifier — the difference is
 * that `verified` is false and the block carries a `# VERIFY` line saying the
 * rule could not build an id. The plan's phrasing ("rather than
 * `id = "203.0.113.5"`") is delivered as a flag on that line, not as its
 * absence; an unflagged bare IP is the failure, not the IP itself.
 */
test('a bare-IP EIP resolves to no id and is flagged, not silently emitted', () => {
  const classic = subject('eip', '203.0.113.5', { raw: { publicIp: '203.0.113.5' } });
  assert.equal(ruleForKind('eip')?.fromScanned?.(classic), undefined);

  const resolved = resolveScanned(classic);
  assert.equal(resolved.type, 'aws_eip');
  assert.equal(resolved.verified, false);
  const text = emitBlock(resolved);
  assert.match(text, /# VERIFY: the aws_eip rule could not build an import id/);
  assert.match(text, /id = "203\.0\.113\.5"/);
});

test('a VPC EIP resolves to its allocation id', () => {
  const vpc = subject('eip', 'eipalloc-00a10e96', { raw: { publicIp: '203.0.113.5' } });
  const resolved = resolveScanned(vpc);
  assert.equal(resolved.id, 'eipalloc-00a10e96');
  assert.equal(resolved.verified, true);
});

// --- WAFv2 scope -----------------------------------------------------------

/**
 * `data.ts` adds `waf-*` twice — per region for `REGIONAL`, per account for
 * `CLOUDFRONT` — which makes `subject.region === ''` look like a scope test.
 * It is not one, in either direction. These two assertions are the pin.
 */
test('WAFv2 scope comes from the resource, not from whether region is empty', () => {
  const globalAcl = resolveScanned(
    subject('waf-web-acl', 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbb', {
      region: '',
      name: 'cdn-acl',
      raw: { scope: 'CLOUDFRONT' },
    }),
  );
  assert.equal(globalAcl.id, 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbb/cdn-acl/CLOUDFRONT');

  // A CLOUDFRONT-scope ACL that still carries a region must NOT become REGIONAL.
  const misregioned = resolveScanned(
    subject('waf-web-acl', 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbb', {
      region: 'us-east-1',
      name: 'cdn-acl',
      raw: { scope: 'CLOUDFRONT' },
    }),
  );
  assert.equal(misregioned.id, 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbb/cdn-acl/CLOUDFRONT');

  // ...and a REGIONAL ACL that lost its region must not become CLOUDFRONT.
  const regionless = resolveScanned(
    subject('waf-web-acl', 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbb', {
      region: '',
      name: 'app-acl',
      raw: { scope: 'REGIONAL' },
    }),
  );
  assert.equal(regionless.id, 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbb/app-acl/REGIONAL');
});

test('WAFv2 declines rather than guessing when scope or name is missing', () => {
  const noScope = resolveScanned(
    subject('waf-ip-set', 'b2c3d4e5-d5f6-7777-8888-9999aaaabbbb', { name: 'office-ips' }),
  );
  assert.equal(noScope.verified, false);
  assert.equal(noScope.id, 'b2c3d4e5-d5f6-7777-8888-9999aaaabbbb');

  const noName = resolveScanned(
    subject('waf-rule-group', 'c3d4e5f6-d5f6-7777-8888-9999aaaabbbb', {
      raw: { scope: 'REGIONAL' },
    }),
  );
  assert.equal(noName.verified, false);
});

// --- Kinds that cover more than one terraform type -------------------------

/**
 * WP-I's pin, and the defect that produced it.
 *
 * Six kinds here span more than one provider resource. They used to register
 * the dominant type and decline the *id* to signal a variant they could not
 * represent, which emitted exactly this for an HTTP API:
 *
 *     # VERIFY: the aws_api_gateway_rest_api rule could not build an import id
 *     #   from the scanned fields — falling back to the scanned id
 *     import {
 *       to = aws_api_gateway_rest_api.orders
 *       id = "abc123"
 *     }
 *
 * `abc123` is exactly the right import id — for `aws_apigatewayv2_api`. The
 * comment blamed the half that was right, so a reader who checked the id found
 * it correct and pasted a block importing an HTTP API as a REST API. `lb` ran
 * the same way: `my-classic-elb` is exactly right for `aws_elb`.
 *
 * The guard now sits where the ambiguity is. `typeFromScanned` answers the
 * type per subject and `fromScanned` answers the id, and the table below pins
 * **every** variant of all six — including the ones that must emit no type at
 * all. `type: ''` is the assertion that matters: an empty type is what makes
 * `emitBlock` comment the whole stanza out, and a wrong type is unrecoverable
 * where a commented-out block is not.
 */
interface Variant {
  /** Reads as the test name. */
  readonly what: string;
  readonly subject: ScannedSubject;
  /** `''` asserts that no terraform type may be emitted for this subject. */
  readonly type: string;
  readonly id: string;
  /** Only a block with both halves is pasteable, so only it is verified. */
  readonly verified: boolean;
}

const ALB_ARN =
  'arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/web/50dc6c495c0c9188';
const NLB_ARN =
  'arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/net/ingest/f2710a2d3e1c5b44';
const GWLB_ARN =
  'arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/gwy/inspect/a1b2c3d4e5f60718';
const TGW_ATTACH = 'tgw-attach-0a1b2c3d4e5f6789';

const VARIANTS: readonly Variant[] = [
  // --- lb — the only pair here that disagrees about the id as well ----------
  {
    what: 'an application load balancer',
    subject: subject('lb', ALB_ARN, { arn: ALB_ARN, name: 'web', raw: { lbType: 'application' } }),
    type: 'aws_lb',
    id: ALB_ARN,
    verified: true,
  },
  {
    what: 'a network load balancer',
    subject: subject('lb', NLB_ARN, { arn: NLB_ARN, name: 'ingest', raw: { lbType: 'network' } }),
    type: 'aws_lb',
    id: NLB_ARN,
    verified: true,
  },
  {
    what: 'a gateway load balancer',
    subject: subject('lb', GWLB_ARN, { arn: GWLB_ARN, name: 'inspect', raw: { lbType: 'gateway' } }),
    type: 'aws_lb',
    id: GWLB_ARN,
    verified: true,
  },
  {
    // The headline case. `collect/elb.ts:253` stores the name and no ARN, and
    // `r/elb.html.markdown` imports by `name` — both halves were available all
    // along, under a type the rule could not name.
    what: 'a classic ELB',
    subject: subject('lb', 'my-classic-elb', {
      name: 'my-classic-elb',
      raw: { lbType: 'classic' },
    }),
    type: 'aws_elb',
    id: 'my-classic-elb',
    verified: true,
  },
  {
    what: 'a classic ELB with no name field',
    subject: subject('lb', 'legacy-web-elb', { raw: { lbType: 'classic' } }),
    type: 'aws_elb',
    id: 'legacy-web-elb',
    verified: true,
  },
  {
    // A classic ELB has no ARN, so an ARN in `name` means the field is not what
    // the rule thinks it is: `aws_elb` imports by name and an ARN is not one.
    what: 'a classic ELB whose name is an ARN',
    subject: subject('lb', ALB_ARN, { name: ALB_ARN, raw: { lbType: 'classic' } }),
    type: 'aws_elb',
    id: ALB_ARN,
    verified: false,
  },
  {
    what: 'a load balancer with no lbType',
    subject: subject('lb', ALB_ARN, { arn: ALB_ARN, name: 'web' }),
    type: '',
    id: ALB_ARN,
    verified: false,
  },

  // --- tgw-attachment — one id, three types, two non-resources -------------
  {
    what: 'a VPC transit gateway attachment',
    subject: subject('tgw-attachment', TGW_ATTACH, { raw: { resourceType: 'vpc' } }),
    type: 'aws_ec2_transit_gateway_vpc_attachment',
    id: TGW_ATTACH,
    verified: true,
  },
  {
    what: 'a peering transit gateway attachment',
    subject: subject('tgw-attachment', TGW_ATTACH, { raw: { resourceType: 'peering' } }),
    type: 'aws_ec2_transit_gateway_peering_attachment',
    id: TGW_ATTACH,
    verified: true,
  },
  {
    // `TgwAttachmentResourceType` carries both spellings for the same resource.
    what: 'a tgw-peering transit gateway attachment',
    subject: subject('tgw-attachment', TGW_ATTACH, { raw: { resourceType: 'tgw-peering' } }),
    type: 'aws_ec2_transit_gateway_peering_attachment',
    id: TGW_ATTACH,
    verified: true,
  },
  {
    what: 'a connect transit gateway attachment',
    subject: subject('tgw-attachment', TGW_ATTACH, { raw: { resourceType: 'connect' } }),
    type: 'aws_ec2_transit_gateway_connect',
    id: TGW_ATTACH,
    verified: true,
  },
  {
    // Created by `aws_vpn_connection`; there is no attachment resource to name.
    what: 'a VPN transit gateway attachment',
    subject: subject('tgw-attachment', TGW_ATTACH, { raw: { resourceType: 'vpn' } }),
    type: '',
    id: TGW_ATTACH,
    verified: false,
  },
  {
    // Created by `aws_dx_gateway_association`, likewise.
    what: 'a Direct Connect gateway transit gateway attachment',
    subject: subject('tgw-attachment', TGW_ATTACH, {
      raw: { resourceType: 'direct-connect-gateway' },
    }),
    type: '',
    id: TGW_ATTACH,
    verified: false,
  },
  {
    what: 'a transit gateway attachment of an unmodelled resource type',
    subject: subject('tgw-attachment', TGW_ATTACH, { raw: { resourceType: 'other' } }),
    type: '',
    id: TGW_ATTACH,
    verified: false,
  },

  // --- dx-vif — one id, three types ---------------------------------------
  {
    what: 'a private virtual interface',
    subject: subject('dx-vif', 'dxvif-33cc44dd', { raw: { vifType: 'private' } }),
    type: 'aws_dx_private_virtual_interface',
    id: 'dxvif-33cc44dd',
    verified: true,
  },
  {
    what: 'a public virtual interface',
    subject: subject('dx-vif', 'dxvif-33cc44dd', { raw: { vifType: 'public' } }),
    type: 'aws_dx_public_virtual_interface',
    id: 'dxvif-33cc44dd',
    verified: true,
  },
  {
    what: 'a transit virtual interface',
    subject: subject('dx-vif', 'dxvif-33cc44dd', { raw: { vifType: 'transit' } }),
    type: 'aws_dx_transit_virtual_interface',
    id: 'dxvif-33cc44dd',
    verified: true,
  },
  {
    what: 'a virtual interface with no vifType',
    subject: subject('dx-vif', 'dxvif-33cc44dd'),
    type: '',
    id: 'dxvif-33cc44dd',
    verified: false,
  },

  // --- apigw — REST vs v2, sharing the bare API id ------------------------
  {
    what: 'a REST API',
    subject: subject('apigw', 'abc123', { name: 'orders', raw: { protocolType: 'REST' } }),
    type: 'aws_api_gateway_rest_api',
    id: 'abc123',
    verified: true,
  },
  {
    what: 'an HTTP API',
    subject: subject('apigw', 'abc123', { name: 'orders', raw: { protocolType: 'HTTP' } }),
    type: 'aws_apigatewayv2_api',
    id: 'abc123',
    verified: true,
  },
  {
    what: 'a WebSocket API',
    subject: subject('apigw', 'abc123', { name: 'events', raw: { protocolType: 'WEBSOCKET' } }),
    type: 'aws_apigatewayv2_api',
    id: 'abc123',
    verified: true,
  },
  {
    what: 'an API with no protocolType',
    subject: subject('apigw', 'abc123', { name: 'orders' }),
    type: '',
    id: 'abc123',
    verified: false,
  },

  // --- apigw-vpc-link — the one kind whose snapshot states its version ----
  {
    what: 'a v1 VPC link',
    subject: subject('apigw-vpc-link', 'aabbccddee', { raw: { version: 'v1' } }),
    type: 'aws_api_gateway_vpc_link',
    id: 'aabbccddee',
    verified: true,
  },
  {
    what: 'a v2 VPC link',
    subject: subject('apigw-vpc-link', 'aabbccddee', { raw: { version: 'v2' } }),
    type: 'aws_apigatewayv2_vpc_link',
    id: 'aabbccddee',
    verified: true,
  },
  {
    what: 'a VPC link with no version',
    subject: subject('apigw-vpc-link', 'aabbccddee'),
    type: '',
    id: 'aabbccddee',
    verified: false,
  },

  // --- apigw-domain — genuinely unresolvable for its commonest variant ----
  {
    what: 'an edge-optimised custom domain',
    subject: subject('apigw-domain', 'dev.example.com', {
      name: 'dev.example.com',
      raw: { domainName: 'dev.example.com', endpointTypes: ['EDGE'] },
    }),
    type: 'aws_api_gateway_domain_name',
    id: 'dev.example.com',
    verified: true,
  },
  {
    // The reverse split: the type resolves (v2 cannot be private) and the id
    // does not (`<name>/<domain_name_id>`, and `domainNameId` is not collected).
    what: 'a private custom domain',
    subject: subject('apigw-domain', 'api.internal.example.com', {
      name: 'api.internal.example.com',
      raw: { domainName: 'api.internal.example.com', endpointTypes: ['PRIVATE'] },
    }),
    type: 'aws_api_gateway_domain_name',
    id: 'api.internal.example.com',
    verified: false,
  },
  {
    what: 'a regional custom domain',
    subject: subject('apigw-domain', 'ws-api.example.com', {
      name: 'ws-api.example.com',
      raw: { domainName: 'ws-api.example.com', endpointTypes: ['REGIONAL'] },
    }),
    type: '',
    id: 'ws-api.example.com',
    verified: false,
  },
  {
    what: 'a custom domain with no endpoint types',
    subject: subject('apigw-domain', 'dev.example.com', {
      name: 'dev.example.com',
      raw: { domainName: 'dev.example.com' },
    }),
    type: '',
    id: 'dev.example.com',
    verified: false,
  },
];

for (const v of VARIANTS) {
  test(`${v.what} resolves to ${v.type === '' ? 'no terraform type' : v.type}`, () => {
    const resolved = resolveScanned(v.subject);
    assert.equal(resolved.type, v.type, `${v.what}: wrong terraform type`);
    assert.equal(resolved.id, v.id, `${v.what}: wrong import id`);
    assert.equal(resolved.verified, v.verified, `${v.what}: ${resolved.comments.join(' | ')}`);
  });
}

test('every variant of these kinds is covered, and none is guessed', () => {
  // `RULES` is the merged registry, so scope to this half of the table —
  // `fsx` and `datasync-location` resolve their types the same way but belong
  // to `scanned-workload.ts` and are pinned in its test file.
  const ambiguous = RULES.filter(
    (r) => r.typeFromScanned !== undefined && EXPECTED_KINDS.some((k) => (r.kinds ?? []).includes(k)),
  );
  assert.deepEqual(
    ambiguous.map((r) => r.type).sort(),
    [
      'aws_api_gateway_domain_name',
      'aws_api_gateway_rest_api',
      'aws_api_gateway_vpc_link',
      'aws_dx_private_virtual_interface',
      'aws_ec2_transit_gateway_vpc_attachment',
      'aws_lb',
    ],
    'a kind gained or lost a per-subject type resolver',
  );
  for (const rule of ambiguous) {
    const choices = rule.typeChoices ?? [];
    assert.ok(choices.length > 1, `${rule.type}: typeFromScanned without candidates`);
    // The declared type is the merge key and a member of the set, never a
    // claim: nothing may emit it except `typeFromScanned` choosing it.
    assert.ok(choices.includes(rule.type), `${rule.type}: merge key is not a candidate`);
  }
  // Every type any of them can emit appears in the table above, so a new
  // variant cannot be added without a row pinning its id.
  //
  // The single exception is the one candidate this package can *never* emit:
  // `aws_apigatewayv2_domain_name` is only ever reached through a `REGIONAL`
  // domain, and `REGIONAL` is exactly the value that fails to discriminate —
  // v1 accepts it too. There is no snapshot a v2 domain resolves from, which
  // is the honest end state, not a gap to fill. Any *other* unreachable
  // candidate is a rule that cannot produce a type it advertises.
  const UNREACHABLE = ['aws_apigatewayv2_domain_name'];
  const emitted = new Set(VARIANTS.map((v) => v.type).filter((t) => t !== ''));
  const declared = new Set(ambiguous.flatMap((r) => [...(r.typeChoices ?? [])]));
  assert.deepEqual([...declared].filter((t) => !emitted.has(t)).sort(), UNREACHABLE);
});

// --- The comment has to blame the right half -------------------------------

/**
 * The regression this package exists to prevent, in its subtlest form. An HTTP
 * API's id was always right; saying otherwise sent the reader to check the one
 * thing that was not wrong and let them paste the one that was.
 */
test('an HTTP API is no longer flagged for an id that was always correct', () => {
  const http = resolveScanned(
    subject('apigw', 'abc123', { name: 'orders', raw: { protocolType: 'HTTP' } }),
  );
  const text = emitBlock(http);
  assert.match(text, /to = aws_apigatewayv2_api\.orders/);
  assert.match(text, /id = "abc123"/);
  assert.doesNotMatch(text, /could not build an import id/);
  assert.doesNotMatch(text, /aws_api_gateway_rest_api/);
  // Nothing is commented out: this block is pasteable as it stands.
  assert.doesNotMatch(text, /# import \{/);
});

test('a classic ELB is no longer flagged for an id that was always correct', () => {
  const classic = resolveScanned(
    subject('lb', 'my-classic-elb', { name: 'my-classic-elb', raw: { lbType: 'classic' } }),
  );
  const text = emitBlock(classic);
  assert.match(text, /to = aws_elb\.my-classic-elb/);
  assert.match(text, /id = "my-classic-elb"/);
  assert.doesNotMatch(text, /could not build an import id/);
  assert.doesNotMatch(text, /aws_lb\./);
});

/**
 * When the type genuinely cannot be determined the block must be commented out
 * — decision 5's "wrong-but-flagged" only holds for ids, because a reader can
 * check an id. A `to =` naming the wrong resource looks identical to a right
 * one, so the block is made unpasteable and the candidates are named instead.
 */
test('an unresolvable type is commented out, blamed correctly, and recoverable', () => {
  const regional = resolveScanned(
    subject('apigw-domain', 'ws-api.example.com', {
      name: 'ws-api.example.com',
      raw: { domainName: 'ws-api.example.com', endpointTypes: ['REGIONAL'] },
    }),
  );
  const text = emitBlock(regional);
  for (const line of text.split('\n')) {
    assert.ok(line.startsWith('# '), `line is pasteable but has no type: ${line}`);
  }
  assert.match(text, /VERIFY: the terraform resource type could not be determined/);
  assert.match(
    text,
    /Candidates: aws_api_gateway_domain_name, aws_apigatewayv2_domain_name/,
    'a commented-out block must name what to fill in',
  );
  assert.match(text, /The id below is right whichever of those it is/);
  assert.match(text, /id = "ws-api\.example\.com"/);
  // The id is not the problem here and must not be reported as one.
  assert.doesNotMatch(text, /could not build an import id/);
});

/**
 * The reverse split, and the reason the two halves are resolved independently:
 * a private custom domain's *type* is known exactly (`endpoint_type` on
 * `r/apigatewayv2_domain_name.html.markdown` accepts `REGIONAL` only, so v2
 * cannot be private) while its *id* is `<name>/<domain_name_id>` and
 * `ApiGatewayDomainName` has no `domainNameId`.
 */
test('a private custom domain keeps its type and flags only the id', () => {
  const priv = resolveScanned(
    subject('apigw-domain', 'api.internal.example.com', {
      name: 'api.internal.example.com',
      raw: { domainName: 'api.internal.example.com', endpointTypes: ['PRIVATE'] },
    }),
  );
  const text = emitBlock(priv);
  assert.match(text, /^ {2}to = aws_api_gateway_domain_name\./m);
  assert.match(text, /the aws_api_gateway_domain_name rule could not build an import id/);
  assert.doesNotMatch(text, /type could not be determined/);
});

/**
 * `lb` is the one kind here whose variants disagree about the id form too, so
 * an unknown `lbType` leaves both halves unknown. The block must not tell the
 * reader the ARN is right whichever candidate this is — for `aws_elb` it is not.
 */
test('an unknown lbType declines both halves rather than vouching for the id', () => {
  const unknown = resolveScanned(subject('lb', ALB_ARN, { arn: ALB_ARN, name: 'web' }));
  const text = emitBlock(unknown);
  assert.match(text, /VERIFY: the terraform resource type could not be determined/);
  assert.match(text, /Candidates: aws_lb, aws_elb/);
  assert.doesNotMatch(text, /right whichever of those it is/);
  assert.match(text, /the aws_lb rule could not build an import id/);
});

// --- Network Firewall ------------------------------------------------------

test('Network Firewall imports by ARN even though the collector stores the name', () => {
  const byName = subject('network-firewall', 'prod-inspection', {
    arn: `${NFW}:firewall/prod-inspection`,
    name: 'prod-inspection',
  });
  assert.equal(resolveScanned(byName).id, `${NFW}:firewall/prod-inspection`);

  // `collect/edge-network.ts:324` falls back to the ARN when DescribeFirewall
  // fails, so `id` is sometimes already an ARN and must still work.
  const arnInId = subject('network-firewall', `${NFW}:firewall/prod-inspection`);
  assert.equal(resolveScanned(arnInId).id, `${NFW}:firewall/prod-inspection`);

  // With neither an ARN nor an ARN-shaped id there is nothing to import by.
  const nameOnly = resolveScanned(subject('network-firewall', 'prod-inspection'));
  assert.equal(nameOnly.verified, false);
  assert.equal(nameOnly.id, 'prod-inspection');
});
