/**
 * The networking design rules (PROPOSAL-OVERLAY.md, decision 48): warnings
 * about a proposal that is well-formed but probably wrong as a design.
 *
 * Every rule's test asserts the warning with the full registry, then runs the
 * same proposal with that one rule left out and asserts the warning is gone —
 * the control that shows the test is red without the rule. The awkward cases
 * the plan names are here: an overlap visible only through a shared TGW (each
 * spoke fine against the hub, overlapping each other); a subnet that is a
 * superset of its VPC; an attachment in the right account but the wrong
 * region. And the negative the rules exist under: an estate whose base already
 * has every one of these problems produces no warning from a proposal that
 * merely touches the resources involved.
 *
 * Shapes still avoided: IPv6 CIDRs (not compared); TGW route-table
 * segmentation (any two attachments on one TGW count as joined); RAM-shared
 * subnets seen from a participant account; a route to a prefix list; SG
 * referencing over a TGW with the feature enabled (warns — the schema cannot
 * tell).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Snapshot } from '@atlas/schema';

import { designRules, diffSnapshots, validateProposal, type Issue, type Proposal } from '../src/index.js';
import { DEV, estate, GENERATED_AT, HUB, newSpoke, only, PROD, REGION, TGW } from './estate.js';

const PROD_VPC = 'vpc-0prod0000000001';
const DEV_VPC = 'vpc-0dev00000000001';
const HUB_VPC = 'vpc-0hub00000000001';
const EAST = 'us-east-1';

const codes = (issues: Issue[]): string[] => issues.map((i) => `${i.level}:${i.code}${i.path ? `@${i.path}` : ''}`);

/** Warnings with the registry, and with the rule `code` left out (the red control). */
function withAndWithout(base: Snapshot, proposal: Proposal, code: string): { on: Issue[]; off: Issue[] } {
  const on = validateProposal(base, proposal);
  const off = validateProposal(base, proposal, { rules: designRules.filter((r) => r.code !== code) });
  assert.ok(on.every((i) => i.level === 'warning'), `expected only warnings, got ${codes(on).join(', ')}`);
  assert.deepEqual(off.filter((i) => i.code === code), [], 'the control must not see the rule');
  return { on, off };
}

const region = (snapshot: Snapshot, accountId: string) => {
  const r = snapshot.accounts.find((a) => a.accountId === accountId)?.regions.find((x) => x.region === REGION);
  if (!r) throw new Error(`no ${REGION} for ${accountId}`);
  return r;
};

/** `estate()` with the hub's own VPC attached to its TGW, so hub and both spokes share it. */
function hubAttached(): Snapshot {
  const base = estate();
  region(base, HUB).transitGatewayAttachments.push({
    id: 'tgw-attach-0hub0000000001', tags: {}, transitGatewayId: TGW, transitGatewayOwnerId: HUB,
    resourceOwnerId: HUB, resourceType: 'vpc', resourceId: HUB_VPC, subnetIds: [],
  });
  return base;
}

/**
 * Every rule's problem already present in the base: prod and dev overlap
 * across the TGW, a prod subnet lies outside its VPC, dev's attachment names
 * the wrong owner, a dev SG references a prod SG, and a prod route points at
 * a TGW the hub VPC is not attached to.
 */
function brokenBase(): Snapshot {
  const base = hubAttached();
  const dev = region(base, DEV);
  const prod = region(base, PROD);
  const hub = region(base, HUB);
  const devVpc = dev.vpcs[0];
  if (!devVpc) throw new Error('no dev vpc');
  devVpc.cidrBlocks = ['10.0.0.0/16'];
  prod.subnets.push({
    id: 'subnet-0prod00000outside', tags: {}, vpcId: PROD_VPC, cidrBlock: '10.7.0.0/24', ipv6CidrBlocks: [],
    availabilityZone: 'eu-west-1a', mapPublicIpOnLaunch: false, isPublic: false,
  });
  const devAttach = dev.transitGatewayAttachments[0];
  if (!devAttach) throw new Error('no dev attachment');
  devAttach.resourceOwnerId = PROD;
  prod.securityGroups.push({ id: 'sg-0prod000000000001', tags: {}, vpcId: PROD_VPC, ingress: [], egress: [] });
  dev.securityGroups.push({
    id: 'sg-0dev0000000000001', tags: {}, vpcId: DEV_VPC, egress: [],
    ingress: [{ protocol: 'tcp', fromPort: 443, toPort: 443, cidrs: [], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [{ groupId: 'sg-0prod000000000001' }] }],
  });
  hub.routeTables.push({
    id: 'rtb-0hub00000000001', tags: {}, vpcId: HUB_VPC, isMain: true, subnetAssociations: [], gatewayAssociations: [],
    routes: [{ destinationCidr: '10.0.0.0/8', targetType: 'pcx', targetId: 'pcx-0prod0stranger0001', state: 'active' }],
  });
  return base;
}

test('the registry holds the five networking rules, and the pin proposal is clean under them', () => {
  assert.deepEqual(
    designRules.map((r) => r.code),
    ['cidr-overlap', 'subnet-in-vpc', 'attachment-locality', 'sg-rule-vpc', 'route-target'],
  );
  for (const rule of designRules) assert.ok(rule.description.length > 0);
  assert.deepEqual(validateProposal(estate(), newSpoke()), []);
  assert.deepEqual(validateProposal(hubAttached(), newSpoke()), []);
});

test('pre-existing problems are never reported, even when the proposal touches the resources involved', () => {
  const base = brokenBase();
  // Not vacuous: with the whole broken base counted as added, every rule fires on it.
  const empty: Snapshot = { version: 1, generatedAt: GENERATED_AT, accounts: [] };
  const everything = { base: empty, applied: base, proposal: only(), changes: diffSnapshots(empty, base), pathFor: () => undefined };
  assert.deepEqual(
    designRules.filter((rule) => rule.check(everything).length > 0).map((r) => r.code),
    designRules.map((r) => r.code),
  );
  const touchAll = only(
    { op: 'change', key: DEV_VPC, set: { tags: { touched: 'yes' } } },
    { op: 'change', key: 'subnet-0prod00000outside', set: { tags: { touched: 'yes' } } },
    { op: 'change', key: 'tgw-attach-0dev0000000001', set: { tags: { touched: 'yes' } } },
    { op: 'change', key: 'sg-0dev0000000000001', set: { description: 'touched' } },
    { op: 'change', key: 'rtb-0hub00000000001', set: { tags: { touched: 'yes' } } },
  );
  assert.deepEqual(validateProposal(base, touchAll), []);
  assert.deepEqual(validateProposal(base, newSpoke()), []);
});

test('cidr-overlap: two spokes each fine against the hub overlap each other through the shared TGW', () => {
  const proposal = newSpoke();
  const vpc = proposal.changes[0];
  assert.ok(vpc?.op === 'add');
  vpc.resource['cidrBlocks'] = ['10.1.128.0/17']; // inside dev's 10.1.0.0/16; clear of hub 10.9/16 and prod 10.0/16

  const { on } = withAndWithout(hubAttached(), proposal, 'cidr-overlap');
  assert.deepEqual(codes(on), ['warning:cidr-overlap@changes[0].resource.cidrBlocks']);
  assert.equal(on[0]?.key, 'proposed-vpc-data');
  assert.match(on[0]?.message ?? '', new RegExp(`${DEV_VPC}.*transit gateway ${TGW}`));
});

test('cidr-overlap: widening a VPC into a TGW neighbour, and a new peering between overlapping VPCs', () => {
  const widen = only({ op: 'change', key: HUB_VPC, set: { cidrBlocks: ['10.9.0.0/16', '10.0.128.0/17'] } });
  const { on } = withAndWithout(hubAttached(), widen, 'cidr-overlap');
  assert.deepEqual(codes(on), ['warning:cidr-overlap@changes[0].set.cidrBlocks']);
  assert.equal(on[0]?.key, HUB_VPC);

  // Not on the TGW; joined only by the peering the proposal adds — which is what the warning blames
  // after the VPC itself, the first touched resource.
  const peer = only(
    { op: 'add', account: PROD, region: REGION, collection: 'vpcs', resource: { id: 'proposed-vpc-side', tags: {}, cidrBlocks: ['10.0.64.0/18'], ipv6CidrBlocks: [], isDefault: false } },
    {
      op: 'add', account: PROD, region: REGION, collection: 'peeringConnections',
      resource: {
        id: 'proposed-pcx-side', tags: {}, status: 'active',
        requester: { vpcId: PROD_VPC, accountId: PROD, region: REGION, cidrBlocks: ['10.0.0.0/16'] },
        accepter: { vpcId: 'proposed-vpc-side', accountId: PROD, region: REGION, cidrBlocks: ['10.0.64.0/18'] },
      },
    },
  );
  assert.deepEqual(codes(withAndWithout(estate(), peer, 'cidr-overlap').on), ['warning:cidr-overlap@changes[0].resource.cidrBlocks']);

  // The same overlapping VPC with no peering joins nothing: no warning.
  assert.deepEqual(validateProposal(estate(), only(peer.changes[0]!)), []);
});

const subnet = (id: string, cidrBlock: string, vpcId = PROD_VPC) =>
  ({
    op: 'add', account: PROD, region: REGION, collection: 'subnets',
    resource: { id, tags: {}, vpcId, cidrBlock, ipv6CidrBlocks: [], availabilityZone: 'eu-west-1a', mapPublicIpOnLaunch: false, isPublic: false },
  }) as const;

test('subnet-in-vpc: a superset of its VPC, one outside it, and an invalid CIDR warn; one inside does not', () => {
  const proposal = only(
    subnet('proposed-subnet-inside', '10.0.1.0/24'),
    subnet('proposed-subnet-superset', '10.0.0.0/15'),
    subnet('proposed-subnet-outside', '10.2.0.0/24'),
    subnet('proposed-subnet-typo', '10.0.1.0/33'),
  );
  const { on } = withAndWithout(estate(), proposal, 'subnet-in-vpc');
  assert.deepEqual(codes(on), [
    'warning:subnet-in-vpc@changes[1].resource.cidrBlock',
    'warning:subnet-in-vpc@changes[2].resource.cidrBlock',
    'warning:subnet-in-vpc@changes[3].resource.cidrBlock',
  ]);
  assert.deepEqual(on.map((i) => i.key), ['proposed-subnet-superset', 'proposed-subnet-outside', 'proposed-subnet-typo']);
  assert.match(on[2]?.message ?? '', /not a valid IPv4 CIDR/);
});

test('subnet-in-vpc: shrinking a VPC strands a subnet the proposal never touched, and blames the VPC', () => {
  const base = estate();
  region(base, PROD).subnets.push({
    id: 'subnet-0prod000000high', tags: {}, vpcId: PROD_VPC, cidrBlock: '10.0.200.0/24', ipv6CidrBlocks: [],
    availabilityZone: 'eu-west-1a', mapPublicIpOnLaunch: false, isPublic: false,
  });
  const shrink = only({ op: 'change', key: PROD_VPC, set: { cidrBlocks: ['10.0.0.0/17'] } });
  const { on } = withAndWithout(base, shrink, 'subnet-in-vpc');
  assert.deepEqual(codes(on), ['warning:subnet-in-vpc@changes[0].set.cidrBlocks']);
  assert.equal(on[0]?.key, PROD_VPC);
  assert.match(on[0]?.message ?? '', /subnet-0prod000000high/);
});

const attachment = (account: string, inRegion: string, resource: Record<string, unknown>) =>
  ({
    op: 'add', account, region: inRegion, collection: 'transitGatewayAttachments',
    resource: { id: 'proposed-attach-x', tags: {}, transitGatewayId: TGW, transitGatewayOwnerId: HUB, resourceType: 'vpc', subnetIds: [], ...resource },
  }) as const;
const eastVpc = {
  op: 'add', account: PROD, region: EAST, collection: 'vpcs',
  resource: { id: 'proposed-vpc-east', tags: {}, cidrBlocks: ['10.20.0.0/16'], ipv6CidrBlocks: [], isDefault: false },
} as const;

test('attachment-locality: an attachment in the right account but the wrong region', () => {
  const proposal = only(eastVpc, attachment(PROD, REGION, { resourceOwnerId: PROD, resourceId: 'proposed-vpc-east' }));
  const { on } = withAndWithout(estate(), proposal, 'attachment-locality');
  assert.deepEqual(codes(on), ['warning:attachment-locality@changes[1].resource.resourceId']);
  assert.equal(on[0]?.key, 'proposed-attach-x');
  assert.match(on[0]?.message ?? '', /eu-west-1 but its VPC proposed-vpc-east is in us-east-1/);
});

test('attachment-locality: the wrong owner account, a subnet from another VPC, and a TGW in another region', () => {
  const base = estate();
  region(base, DEV).subnets.push({
    id: 'subnet-0dev00000000001', tags: {}, vpcId: DEV_VPC, cidrBlock: '10.1.0.0/24', ipv6CidrBlocks: [],
    availabilityZone: 'eu-west-1a', mapPublicIpOnLaunch: false, isPublic: false,
  });
  const owner = only(attachment(PROD, REGION, { resourceOwnerId: DEV, resourceId: PROD_VPC, subnetIds: ['subnet-0dev00000000001'] }));
  const { on } = withAndWithout(base, owner, 'attachment-locality');
  assert.deepEqual(codes(on), [
    'warning:attachment-locality@changes[0].resource.resourceOwnerId',
    'warning:attachment-locality@changes[0].resource.subnetIds[0]',
  ]);
  assert.match(on[1]?.message ?? '', new RegExp(`subnet-0dev00000000001 is in VPC ${DEV_VPC}`));

  const farTgw = only(eastVpc, attachment(PROD, EAST, { resourceOwnerId: PROD, resourceId: 'proposed-vpc-east' }));
  const far = withAndWithout(base, farTgw, 'attachment-locality').on;
  assert.deepEqual(codes(far), ['warning:attachment-locality@changes[1].resource.transitGatewayId']);
  assert.match(far[0]?.message ?? '', /peering attachment/);
});

const sgBase = (): Snapshot => {
  const base = estate();
  region(base, DEV).securityGroups.push({ id: 'sg-0dev0000000000001', tags: {}, vpcId: DEV_VPC, ingress: [], egress: [] });
  return base;
};
const prodSg = {
  op: 'add', account: PROD, region: REGION, collection: 'securityGroups',
  resource: {
    id: 'proposed-sg-app', tags: {}, vpcId: PROD_VPC, egress: [],
    ingress: [
      { protocol: 'tcp', fromPort: 80, toPort: 80, cidrs: ['10.0.0.0/16'], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [] },
      { protocol: 'tcp', fromPort: 443, toPort: 443, cidrs: [], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [{ groupId: 'sg-0dev0000000000001' }] },
    ],
  },
} as const;

test('sg-rule-vpc: a rule referencing a group in another VPC warns at the reference', () => {
  const { on } = withAndWithout(sgBase(), only(prodSg), 'sg-rule-vpc');
  assert.deepEqual(codes(on), ['warning:sg-rule-vpc@changes[0].resource.ingress[1].securityGroupRefs[0].groupId']);
  assert.equal(on[0]?.key, 'proposed-sg-app');
  assert.match(on[0]?.message ?? '', new RegExp(`sg-0dev0000000000001 in VPC ${DEV_VPC}`));
});

test('sg-rule-vpc: the same reference across a same-region peering is fine; across a TGW it is not', () => {
  const peering = {
    op: 'add', account: PROD, region: REGION, collection: 'peeringConnections',
    resource: {
      id: 'proposed-pcx-dev', tags: {}, status: 'active',
      requester: { vpcId: PROD_VPC, accountId: PROD, region: REGION, cidrBlocks: ['10.0.0.0/16'] },
      accepter: { vpcId: DEV_VPC, accountId: DEV, region: REGION, cidrBlocks: ['10.1.0.0/16'] },
    },
  } as const;
  assert.deepEqual(validateProposal(sgBase(), only(prodSg, peering)), []);
  // prod and dev already share the TGW in the base; that alone does not excuse the reference.
  assert.deepEqual(codes(validateProposal(sgBase(), only(prodSg))), ['warning:sg-rule-vpc@changes[0].resource.ingress[1].securityGroupRefs[0].groupId']);
});

const hubTable = (routes: Record<string, unknown>[], vpcId = HUB_VPC) =>
  ({
    op: 'add', account: HUB, region: REGION, collection: 'routeTables',
    resource: {
      id: 'proposed-rtb-x', tags: {}, vpcId, isMain: false, subnetAssociations: [], gatewayAssociations: [],
      routes: [{ destinationCidr: '10.9.0.0/16', targetType: 'local', targetId: 'local', state: 'active' }, ...routes],
    },
  }) as const;

test('route-target: a route to a TGW the VPC is not attached to, and a target id of the wrong type', () => {
  const toTgw = { destinationCidr: '10.0.0.0/8', targetType: 'tgw', targetId: TGW, state: 'active' };
  const { on } = withAndWithout(estate(), only(hubTable([toTgw])), 'route-target');
  assert.deepEqual(codes(on), ['warning:route-target@changes[0].resource.routes[1].targetId']);
  assert.match(on[0]?.message ?? '', /transit gateway .* not attached/);

  // Attach the hub VPC and the same route is fine.
  assert.deepEqual(validateProposal(hubAttached(), only(hubTable([toTgw]))), []);

  const mistyped = only(hubTable([{ destinationCidr: '0.0.0.0/0', targetType: 'igw', targetId: TGW, state: 'active' }]));
  const typo = withAndWithout(hubAttached(), mistyped, 'route-target').on;
  assert.deepEqual(codes(typo), ['warning:route-target@changes[0].resource.routes[1].targetId']);
  assert.match(typo[0]?.message ?? '', /no internet gateway with that id/);
});

test('route-target: removing a peering leaves an untouched route dangling, and blames the remove', () => {
  const base = estate();
  region(base, PROD).routeTables.push({
    id: 'rtb-0prod00000000001', tags: {}, vpcId: PROD_VPC, isMain: true, subnetAssociations: [], gatewayAssociations: [],
    routes: [{ destinationCidr: '10.50.0.0/16', targetType: 'pcx', targetId: 'pcx-0prod0stranger0001', state: 'active' }],
  });
  const { on } = withAndWithout(base, only({ op: 'remove', key: 'pcx-0prod0stranger0001' }), 'route-target');
  assert.deepEqual(codes(on), ['warning:route-target@changes[0]']);
  assert.equal(on[0]?.key, 'pcx-0prod0stranger0001');
  assert.match(on[0]?.message ?? '', /rtb-0prod00000000001 routes 10\.50\.0\.0\/16/);
});

test('every rule only warns, and --strict promotes its warnings to errors', () => {
  const proposal = only(subnet('proposed-subnet-superset', '10.0.0.0/15'));
  assert.deepEqual(codes(validateProposal(estate(), proposal, { strict: true })), ['error:subnet-in-vpc@changes[0].resource.cidrBlock']);
});
