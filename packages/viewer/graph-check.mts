#!/usr/bin/env tsx
/**
 * Graph invariant check — runs the real graph builders (buildOverview /
 * buildVpcDetail) against the committed fixture data AND an adversarial
 * synthetic snapshot, then asserts the invariants React Flow silently
 * depends on:
 *
 *   1. every edge's source AND target id is a node that exists in the graph
 *      (React Flow silently drops dangling edges; ELK layout can throw);
 *   2. node ids are unique;
 *   3. edge ids are unique;
 *   4. every parentId refers to an existing node that appears EARLIER in the
 *      nodes array (React Flow parent-ordering requirement).
 *
 * Run from packages/viewer:  npx tsx graph-check.mts
 */
import { readFileSync } from 'node:fs';
import type { AccountSnapshot, Snapshot } from '@atlas/schema';
import { emptyGlobal, emptyRegionSnapshot } from '@atlas/schema';

// data.ts reads window.__ATLAS_DATA__ — provide a window in Node.
const g = globalThis as unknown as {
  window: { __ATLAS_DATA__?: Snapshot; __ATLAS_ANNOTATIONS__?: unknown };
};
g.window = g as unknown as typeof g.window;
// eslint-disable-next-line no-eval -- executes the committed data bundle (window.__ATLAS_DATA__=…)
eval(readFileSync(new URL('../../site/data/data.js', import.meta.url), 'utf8'));
g.window.__ATLAS_ANNOTATIONS__ = {};

const { buildIndex } = await import('./src/data.js');
const { buildOverview } = await import('./src/model/overview.js');
const { buildVpcDetail } = await import('./src/model/vpc-detail.js');
const { buildFocus } = await import('./src/model/focus.js');
type AtlasGraph = import('./src/model/graph-types.js').AtlasGraph;

let failures = 0;

function validate(name: string, graph: AtlasGraph, quiet = false): void {
  const problems: string[] = [];
  const ids = new Set<string>();
  const position = new Map<string, number>();

  graph.nodes.forEach((n, i) => {
    if (ids.has(n.id)) problems.push(`duplicate node id: ${n.id}`);
    ids.add(n.id);
    position.set(n.id, i);
  });
  graph.nodes.forEach((n, i) => {
    if (n.parentId === undefined) return;
    const p = position.get(n.parentId);
    if (p === undefined) problems.push(`node ${n.id} has missing parent ${n.parentId}`);
    else if (p > i) problems.push(`node ${n.id} appears before its parent ${n.parentId}`);
  });

  const edgeIds = new Set<string>();
  let dangling = 0;
  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) problems.push(`duplicate edge id: ${e.id}`);
    edgeIds.add(e.id);
    const missing = [e.source, e.target].filter((end) => !ids.has(end));
    if (missing.length > 0) {
      dangling++;
      problems.push(`dangling edge ${e.id} [${e.data?.edgeKind}]: missing ${missing.join(', ')}`);
    }
  }

  const summary = `${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.edges.length - dangling}/${graph.edges.length} edges resolve`;
  if (problems.length === 0) {
    if (!quiet) console.log(`PASS  ${name}: ${summary}`);
  } else {
    failures += problems.length;
    console.log(`FAIL  ${name}: ${summary}`);
    for (const p of problems) console.log(`      - ${p}`);
  }
}

function runAll(label: string): void {
  const index = buildIndex();
  validate(`${label} / overview`, buildOverview(index));
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const vpc of region.vpcs) {
        validate(`${label} / vpc ${vpc.id}`, buildVpcDetail(index, vpc.id));
      }
    }
  }

  // Focus view: EVERY scanned resource is a legal center (instances, VPCs,
  // SGs, roles, zones, TGWs…) — each ego graph must satisfy the invariants,
  // and the center must actually be on it. Quiet: only failures are logged.
  let centers = 0;
  for (const ref of index.all) {
    if (ref.kind === 'generic') continue;
    const graph = buildFocus(index, ref.id);
    validate(`${label} / focus ${ref.kind} ${ref.id}`, graph, true);
    const center = graph.nodes.find((n) => n.id === ref.id);
    if (!center) {
      failures++;
      console.log(`FAIL  ${label} / focus ${ref.kind} ${ref.id}: center node missing`);
    } else if (!center.data.emphasis) {
      failures++;
      console.log(`FAIL  ${label} / focus ${ref.kind} ${ref.id}: center node not emphasized`);
    }
    centers++;
  }
  // A center that was never scanned must yield a ghost-centered graph, not dangling edges.
  validate(`${label} / focus ghost center`, buildFocus(index, 'vpc-doesnotexist0000001'), true);
  console.log(`PASS  ${label} / focus: ${centers + 1} centers validated`);
}

/** Fixture-only neighborhood expectations: the ego graph must contain the
 *  relationships the feature promises (SGs, roles, routing, DNS, LB path) —
 *  and must NOT contain `absentNodes` (scoping: unrelated resources that a
 *  too-eager expansion would drag in). */
function expectFocus(
  centerKey: string,
  expectNodes: string[],
  expectEdgeLabels: string[],
  absentNodes: string[] = [],
): void {
  const index = buildIndex();
  const graph = buildFocus(index, centerKey);
  const ids = new Set(graph.nodes.map((n) => n.id));
  const labels = new Set(graph.edges.map((e) => e.data?.label).filter(Boolean));
  const problems: string[] = [];
  for (const id of expectNodes) {
    if (!ids.has(id)) problems.push(`missing node ${id}`);
  }
  for (const label of expectEdgeLabels) {
    if (!labels.has(label)) problems.push(`missing edge label "${label}"`);
  }
  for (const id of absentNodes) {
    if (ids.has(id)) problems.push(`unexpected node ${id} (scope leak)`);
  }
  if (problems.length === 0) {
    console.log(`PASS  fixture / focus ${centerKey}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, expectations hold`);
  } else {
    failures += problems.length;
    console.log(`FAIL  fixture / focus ${centerKey}`);
    for (const p of problems) console.log(`      - ${p}`);
  }
}

// --- 1. the committed fixture ------------------------------------------------
runAll('fixture');

// An EC2 instance: SG + subnet + role + LB + VPC context + routing + DNS.
expectFocus(
  'i-0prodapp0000000001',
  [
    'sg-0prodapp000000001', // its security group
    'subnet-0prodapp0000001', // placement
    'prod-app-role', // assumed IAM role
    'vpc-0prod00000000000a1', // VPC context
    'arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/app/prod-alb/abc123', // targets it
    'nat-0prod00000000001', // subnet default route
    'tgw-0a1b2c3d4e5f00001', // subnet TGW routes
    'Z0PRODPRIV0001', // private zone on the VPC
  ],
  ['in subnet', 'assumes role', 'applies to', 'private DNS'],
  [
    // Scoping: sibling/far-side subnets and THEIR routing must not leak in
    // through the peering or TGW hops.
    'subnet-0prodapp0000101', // sibling subnet (only reachable via pcx fan-out)
    'subnet-0devpriv0000001', // far side of the peering
    'nat-0prod00000000101', // sibling subnet's NAT
    'nat-0dev00000000001', // dev VPC's NAT
  ],
);
// A security group: blast radius (workloads) + rule graph + its VPC.
expectFocus(
  'sg-0prodapp000000001',
  [
    'i-0prodapp0000000001',
    'i-0prodapp0021000001',
    'sg-0prodalb000000001',
    'sg-0proddb0000000001',
    'vpc-0prod00000000000a1',
  ],
  ['tcp 8080', 'tcp 5432'],
);
// A VPC: subnets, gateways, peering/TGW spokes, DNS — without workload noise.
expectFocus(
  'vpc-0prod00000000000a1',
  ['subnet-0prodapp0000001', 'tgw-0a1b2c3d4e5f00001', 'pcx-0proddev000000001', 'Z0PRODPRIV0001',
    'vpc-0dev000000000000a1'], // the peer VPC, via the pcx leg
  ['private DNS'],
  ['subnet-0devpriv0000001', 'nat-0dev00000000001'], // the peer VPC's internals stay out
);
// An IAM role: who assumes it, via which instance profile.
expectFocus(
  'prod-app-role',
  ['i-0prodapp0000000001', 'prod-app-profile'],
  ['assumes role', 'instance profile'],
);
// A hub TGW: every attached VPC + routing subnets + VPN/DX/TGW-peering spokes,
// but NOT the spoke VPCs' internal routing (NATs, peering fan-out).
expectFocus(
  'tgw-0a1b2c3d4e5f00001',
  [
    'vpc-0prod00000000000a1',
    'vpc-0shared00000000a1',
    'vpc-0dev000000000000a1',
    'subnet-0prodapp0000001',
    'cgw-0aa11bb22cc330001', // site-to-site VPN spoke
    'dxgw-0f1e2d3c4b5a00001', // Direct Connect association
    'tgw-0a1b2c3d4e5f00002', // TGW peering (us-east-1)
  ],
  ['hq-vpn', 'DX association', 'TGW peering · eu-west-1'],
  ['nat-0prod00000000001', 'nat-0dev00000000001', 'pcx-0proddev000000001'],
);
// An Elastic IP held by a NAT gateway (association only visible on the NAT).
expectFocus('eipalloc-0prod00000001', ['nat-0prod00000000001'], ['198.51.100.10']);

// --- 2. adversarial snapshot — exercises every ghost/cap/malformed path ------
function adversarialAccount(): AccountSnapshot {
  const r = emptyRegionSnapshot('eu-west-1');
  const vpc = 'vpc-adv0000000000001';
  const otherVpc = 'vpc-adv0000000000002'; // same region, different VPC
  r.vpcs.push(
    { id: vpc, name: 'adv-vpc', tags: {}, cidrBlocks: ['10.50.0.0/16'], ipv6CidrBlocks: [], isDefault: false },
    { id: otherVpc, name: 'adv-vpc-2', tags: {}, cidrBlocks: ['10.51.0.0/16'], ipv6CidrBlocks: [], isDefault: false },
  );
  r.subnets.push({
    id: 'subnet-adv00000000001', name: 'adv-a', tags: {}, vpcId: vpc, cidrBlock: '10.50.0.0/24',
    ipv6CidrBlocks: [], availabilityZone: 'eu-west-1a', mapPublicIpOnLaunch: false,
    routeTableId: 'rtb-adv0000000000001', isPublic: false,
  });
  r.routeTables.push({
    id: 'rtb-adv0000000000001', name: 'adv-rt', tags: {}, vpcId: vpc, isMain: true,
    subnetAssociations: ['subnet-adv00000000001'], gatewayAssociations: [],
    routes: [
      { targetType: 'local', targetId: 'local', destinationCidr: '10.50.0.0/16', state: 'active' },
      { targetType: 'eni', targetId: 'eni-notdrawn0000001', destinationCidr: '0.0.0.0/0', state: 'active' },
      { targetType: 'tgw', targetId: 'tgw-unscanned000001', destinationCidr: '10.0.0.0/8', state: 'blackhole' },
      { targetType: 'pcx', targetId: 'pcx-unknown00000001', destinationCidr: '10.99.0.0/16', state: 'active' },
    ],
  });
  // SGs: refs to same-VPC, other-VPC (same region), other-account (unscanned),
  // self-reference, world-open v4+v6, all-protocol rule.
  r.securityGroups.push(
    {
      id: 'sg-adv0000000000001', name: 'adv-app', tags: {}, vpcId: vpc, description: 'app',
      ingress: [
        { protocol: 'tcp', fromPort: 8080, toPort: 8080, cidrs: [], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [{ groupId: 'sg-adv0000000000001' }], description: 'self' },
        { protocol: 'tcp', fromPort: 443, toPort: 443, cidrs: ['0.0.0.0/0'], ipv6Cidrs: ['::/0'], prefixListIds: [], securityGroupRefs: [] },
        { protocol: '-1', cidrs: [], ipv6Cidrs: ['::/0'], prefixListIds: [], securityGroupRefs: [] },
        { protocol: 'tcp', fromPort: 5432, toPort: 5433, cidrs: [], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [{ groupId: 'sg-othervpc00000001', vpcId: otherVpc }] },
      ],
      egress: [
        { protocol: 'tcp', fromPort: 443, toPort: 443, cidrs: [], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [{ groupId: 'sg-peeracct00000001', accountId: '999999999999', vpcId: 'vpc-peer000000000001' }] },
      ],
    },
    { id: 'sg-othervpc00000001', name: 'other-vpc-sg', tags: {}, vpcId: otherVpc, description: 'lives in another VPC', ingress: [], egress: [] },
  );
  // 15 instances in one subnet (over the 12 cap) all with instance profiles →
  // role edges must not dangle when the instance node was aggregated away.
  for (let i = 0; i < 15; i++) {
    r.instances.push({
      id: `i-adv00000000000${String(i).padStart(2, '0')}`, name: `adv-${i}`, tags: {},
      state: 'running', vpcId: vpc, subnetId: 'subnet-adv00000000001',
      availabilityZone: 'eu-west-1a', privateIp: `10.50.0.${10 + i}`,
      securityGroupIds: ['sg-adv0000000000001'],
      instanceProfileArn: 'arn:aws:iam::555555555555:instance-profile/adv-profile',
    });
  }
  // Lambdas: no vpcConfig (must be skipped), and in-VPC with role matched by name.
  r.lambdaFunctions.push(
    { id: 'arn:aws:lambda:eu-west-1:555555555555:function:novpc', name: 'novpc', tags: {}, roleArn: 'arn:aws:iam::555555555555:role/adv-role-0' },
    { id: 'arn:aws:lambda:eu-west-1:555555555555:function:invpc', name: 'invpc', tags: {}, roleArn: 'arn:aws:iam::555555555555:role/adv-role-9', vpcConfig: { vpcId: vpc, subnetIds: ['subnet-adv00000000001'], securityGroupIds: ['sg-adv0000000000001'] } },
  );
  // Cert used by an ARN that is not on the diagram + one that doesn't exist.
  r.acmCertificates.push({
    id: 'arn:aws:acm:eu-west-1:555555555555:certificate/adv', arn: 'arn:aws:acm:eu-west-1:555555555555:certificate/adv',
    name: 'adv.example', tags: {}, domainName: 'adv.example', subjectAlternativeNames: [],
    status: 'ISSUED', inUseBy: ['arn:aws:elasticloadbalancing:eu-west-1:555555555555:loadbalancer/app/ghost/xyz', 'arn:does:not:exist'],
  });
  // 7 customer KMS keys (over the 6 cap); a secret encrypted by the CAPPED key.
  for (let i = 0; i < 7; i++) {
    r.kmsKeys.push({ id: `key-adv-${i}`, tags: {}, aliases: [`alias/adv-${i}`], keyManager: 'CUSTOMER' });
  }
  r.secrets.push(
    { id: 'arn:aws:secretsmanager:eu-west-1:555555555555:secret:capped', name: 'capped', tags: {}, kmsKeyId: 'alias/adv-6' },
    { id: 'arn:aws:secretsmanager:eu-west-1:555555555555:secret:missingkey', name: 'missingkey', tags: {}, kmsKeyId: 'alias/nonexistent' },
  );
  // Private API GW pointing at a missing VPC endpoint; public one too.
  r.apiGateways.push(
    { id: 'advprivapi', name: 'adv-private', tags: {}, protocolType: 'REST', endpointType: 'PRIVATE', stages: [], vpcEndpointIds: ['vpce-missing0000001'] },
    { id: 'advpubapi', name: 'adv-public', tags: {}, protocolType: 'HTTP', endpointType: 'REGIONAL', stages: [], vpcEndpointIds: [] },
  );
  // Client VPN with one valid + one bogus subnet association.
  r.clientVpnEndpoints.push({
    id: 'cvpn-adv000000000001', name: 'adv-vpn', tags: {}, vpcId: vpc, clientCidrBlock: '10.60.0.0/22',
    dnsServers: [], securityGroupIds: ['sg-adv0000000000001'],
    associatedSubnetIds: ['subnet-adv00000000001', 'subnet-bogus0000001'], splitTunnel: false,
  });
  // FORWARD resolver rule associated with a VPC that was never scanned.
  r.resolverRules.push({
    id: 'rslvr-rr-adv00000001', name: 'adv-fwd', tags: {}, domainName: 'onprem.adv.', ruleType: 'FORWARD',
    targetIps: ['192.0.2.1'], vpcAssociationIds: [vpc, 'vpc-neverscanned0001'],
  });
  // RAM shares: an external-account principal (must become a ghost-account
  // edge), OU/organization principals with NO org tree drawn (must be skipped,
  // not dangling), a malformed account id, and a received share owned by an
  // unscanned account (must draw nothing from this snapshot).
  r.ramResourceShares.push(
    {
      id: 'arn:aws:ram:eu-west-1:555555555555:resource-share/adv-share-0001',
      arn: 'arn:aws:ram:eu-west-1:555555555555:resource-share/adv-share-0001',
      name: 'adv-share', tags: {}, status: 'ACTIVE', owningAccountId: '555555555555',
      allowExternalPrincipals: true,
      principals: [
        { id: '666666666666', type: 'account' },
        { id: 'arn:aws:organizations::555555555555:ou/o-adv00000001/ou-adv0-noorg0001', type: 'ou' },
        { id: 'arn:aws:organizations::555555555555:organization/o-adv00000001', type: 'organization' },
        { id: 'not-an-account-id', type: 'account' },
      ],
      resources: [{ arn: 'arn:aws:ec2:eu-west-1:555555555555:subnet/subnet-adv00000000001', type: 'ec2:subnet', status: 'ASSOCIATED' }],
    },
    {
      id: 'arn:aws:ram:eu-west-1:999999999999:resource-share/adv-received-01',
      arn: 'arn:aws:ram:eu-west-1:999999999999:resource-share/adv-received-01',
      name: 'adv-received', tags: {}, status: 'ACTIVE', owningAccountId: '999999999999',
      principals: [{ id: '555555555555', type: 'account' }],
      resources: [],
    },
  );

  return {
    accountId: '555555555555',
    alias: 'adversarial',
    profile: 'adv',
    scannedAt: '2026-07-06T00:00:00.000Z',
    scannerVersion: '0.0.0',
    regions: [r],
    emptyRegions: [],
    global: {
      ...emptyGlobal(),
      hostedZones: [{
        id: 'ZADV0001', name: 'adv.internal.', tags: {}, zoneName: 'adv.internal.', privateZone: true,
        vpcAssociations: [{ vpcId: vpc, region: 'eu-west-1' }, { vpcId: 'vpc-zoneghost000001', region: 'ap-south-1' }],
      }],
      // 10 roles (over the 8 cap). Roles 8/9 are beyond the cap but hold trust
      // policies + are referenced by workloads — edges must skip, not dangle.
      iamRoles: Array.from({ length: 10 }, (_, i) => ({
        id: `adv-role-${i}`, arn: `arn:aws:iam::555555555555:role/adv-role-${i}`, name: `adv-role-${i}`, tags: {},
        attachedManagedPolicyArns: [], inlinePolicyNames: [],
        assumeRolePolicyDocument: [
          'not-json-at-all{{{',
          '{"Statement":{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::666666666666:root"},"Action":"sts:AssumeRole"}}',
          '{"Statement":[{"Effect":"Allow","Principal":{"AWS":["arn:aws:iam::777777777777:root","888888888888"]},"Action":"sts:AssumeRole"}]}',
          '{"Statement":[{"Effect":"Deny","Principal":{"AWS":"arn:aws:iam::666666666666:root"}}]}',
          '{"Statement":[{"Effect":"Allow","Principal":"*"}]}',
          '{"Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"}}]}',
          '{"Statement":[{"Effect":"Allow"}]}',
          '{}',
          '{"Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::999999999999:root"},"Condition":{"Bool":{"aws:MultiFactorAuthPresent":"true"}}}]}',
          '{"Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::999999999999:root"}}]}',
        ][i],
      })),
      iamUsers: [{ id: 'adv-user', name: 'adv-user', tags: {}, groups: ['adv-missing-group', 'adv-group'], attachedManagedPolicyArns: [], inlinePolicyNames: [], mfaDeviceCount: 0, accessKeyIds: [] }],
      iamGroups: [{ id: 'adv-group', name: 'adv-group', tags: {}, attachedManagedPolicyArns: [], inlinePolicyNames: [], userNames: ['adv-user'] }],
      iamInstanceProfiles: [
        { id: 'adv-profile', arn: 'arn:aws:iam::555555555555:instance-profile/adv-profile', name: 'adv-profile', tags: {}, roleNames: ['adv-role-9', 'role-that-does-not-exist'] },
      ],
      cloudFrontDistributions: [{
        id: 'EADV000000001', name: 'adv-cdn', tags: {}, domainName: 'dadv.cloudfront.net', aliases: [],
        origins: ['unmatched-custom-origin.example.com', 'nobody-owns-this.s3.eu-west-1.amazonaws.com', 'bucket.s3.fakedomain.com'],
      }],
    },
  };
}

g.window.__ATLAS_DATA__ = {
  version: 1,
  generatedAt: '2026-07-06T00:00:00.000Z',
  accounts: [adversarialAccount()],
};
runAll('adversarial');

if (failures > 0) {
  console.error(`\n${failures} invariant violation(s).`);
  process.exit(1);
}
console.log('\nAll graph invariants hold.');
