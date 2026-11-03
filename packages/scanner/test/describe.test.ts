/**
 * `atlas-scan describe` — the skill's eyes (decision 54). What matters is not
 * the layout but that an agent can copy from it: every id real (a name in a
 * `key:` is an unresolved reference), `generatedAt` present (it becomes
 * `base.generatedAt`), every list capped with a `+N more` it can see.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyGlobal, emptyRegionSnapshot, type AccountSnapshot, type RegionSnapshot, type Snapshot } from '@atlas/schema';

import { CAP, describeSnapshot, renderMarkdown } from '../src/describe.js';

const GENERATED_AT = '2026-07-06T09:20:00.000Z';
const HUB = '222222222222';
const SPOKE = '111111111111';

function account(accountId: string, alias: string | undefined, regions: RegionSnapshot[]): AccountSnapshot {
  return {
    accountId,
    ...(alias ? { alias } : {}),
    profile: accountId,
    scannedAt: GENERATED_AT,
    scannerVersion: 'test',
    regions,
    emptyRegions: ['us-west-2'],
    global: emptyGlobal(),
  };
}

function vpc(id: string, name: string, cidr: string) {
  return { id, name, cidrBlocks: [cidr], ipv6CidrBlocks: [], isDefault: false, tags: {} };
}

/** A hub that owns a shared TGW and the org, and a spoke whose VPC has more subnets than the cap. */
function miniEstate(): Snapshot {
  const hub = emptyRegionSnapshot('eu-west-1');
  hub.vpcs.push(vpc('vpc-0hub0000000000a1', 'hub-vpc', '10.1.0.0/16'));
  hub.transitGateways.push({ id: 'tgw-0core00000000001', name: 'core-tgw', ownerId: HUB, amazonSideAsn: 64512, associationDefaultRouteTableId: 'tgw-rtb-0core0000000001', tags: {} });
  hub.transitGatewayAttachments.push(
    { id: 'tgw-attach-0hub00000001', transitGatewayId: 'tgw-0core00000000001', resourceType: 'vpc', resourceId: 'vpc-0hub0000000000a1', resourceOwnerId: HUB, subnetIds: [], tags: {} },
    { id: 'tgw-attach-0spk00000001', transitGatewayId: 'tgw-0core00000000001', resourceType: 'vpc', resourceId: 'vpc-0spk0000000000a1', resourceOwnerId: SPOKE, subnetIds: [], tags: {} },
  );
  const hubAccount = account(HUB, 'acme-hub', [hub]);
  hubAccount.global.hostedZones.push({ id: 'Z0HUBPRIV0001', name: 'hub.internal.', zoneName: 'hub.internal.', privateZone: true, vpcAssociations: [{ vpcId: 'vpc-0hub0000000000a1', region: 'eu-west-1' }], tags: {} });
  hubAccount.global.organizations.push({ id: 'o-acme0000001', masterAccountId: HUB, roots: [{ id: 'r-ac1e', name: 'Root', policyTypes: [] }], trustedServices: [], delegatedAdministrators: [] });
  hubAccount.global.organizationalUnits.push({ id: 'ou-ac1e-work0001', name: 'Workloads', parentId: 'r-ac1e', tags: {} });
  hubAccount.global.organizationAccounts.push(
    { id: HUB, name: 'acme-hub', parentId: 'r-ac1e', tags: {} },
    { id: SPOKE, name: 'acme-spoke', parentId: 'ou-ac1e-work0001', tags: {} },
  );

  const spoke = emptyRegionSnapshot('eu-west-1');
  spoke.vpcs.push(vpc('vpc-0spk0000000000a1', 'spoke-vpc', '10.2.0.0/16'));
  for (let i = 0; i < CAP + 3; i += 1) {
    spoke.subnets.push({ id: `subnet-0spk${String(i).padStart(12, '0')}`, name: `spoke-${i}`, vpcId: 'vpc-0spk0000000000a1', cidrBlock: `10.2.${i}.0/24`, ipv6CidrBlocks: [], availabilityZone: 'eu-west-1a', mapPublicIpOnLaunch: false, isPublic: i === 0, tags: {} });
  }
  spoke.transitGatewayAttachments.push({ id: 'tgw-attach-0spk00000001', transitGatewayId: 'tgw-0core00000000001', resourceType: 'vpc', resourceId: 'vpc-0spk0000000000a1', resourceOwnerId: SPOKE, subnetIds: [], tags: {} });
  spoke.peeringConnections.push({
    id: 'pcx-0spkhub000000001',
    name: 'spoke-to-hub',
    status: 'active',
    requester: { vpcId: 'vpc-0spk0000000000a1', accountId: SPOKE, region: 'eu-west-1', cidrBlocks: ['10.2.0.0/16'] },
    accepter: { vpcId: 'vpc-0hub0000000000a1', accountId: HUB, region: 'eu-west-1', cidrBlocks: ['10.1.0.0/16'] },
    tags: {},
  });
  spoke.loadBalancers.push({ id: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/app/spoke-alb/1', name: 'spoke-alb', lbType: 'application', scheme: 'internal', vpcId: 'vpc-0spk0000000000a1', subnetIds: [], availabilityZones: [], securityGroupIds: [], listeners: [], tags: {} });

  return { version: 1, generatedAt: GENERATED_AT, accounts: [hubAccount, account(SPOKE, 'acme-spoke', [spoke])] };
}

test('the markdown has generatedAt, every alias, every VPC CIDR and real ids', () => {
  const md = renderMarkdown(describeSnapshot(miniEstate()));
  assert.match(md, new RegExp(`^generatedAt: ${GENERATED_AT.replace(/\./g, '\\.')}$`, 'm'));
  for (const alias of ['acme-hub', 'acme-spoke']) assert.match(md, new RegExp(`^## \\d{12} ${alias}$`, 'm'));
  for (const cidr of ['10.1.0.0/16', '10.2.0.0/16']) assert.ok(md.includes(cidr), cidr);
  // Ids, not names: these are what the agent copies into `key:` and reference fields.
  for (const id of ['vpc-0hub0000000000a1', 'tgw-0core00000000001', 'tgw-rtb-0core0000000001', 'tgw-attach-0spk00000001', 'pcx-0spkhub000000001', 'Z0HUBPRIV0001', 'subnet-0spk000000000000', 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/app/spoke-alb/1', 'ou-ac1e-work0001']) {
    assert.ok(md.includes(id), id);
  }
  // The spoke-side attachment points at the TGW it cannot list (owned by the hub).
  assert.match(md, /^- tgw-attach-0spk00000001 → tgw-0core00000000001 vpc vpc-0spk0000000000a1$/m);
  // Under the hub's TGW, the spoke's attachment names its owner; the hub's own does not.
  assert.match(md, /^ {2}- tgw-attach-0spk00000001 vpc vpc-0spk0000000000a1 owner 111111111111$/m);
  assert.match(md, /^ {2}- tgw-attach-0hub00000001 vpc vpc-0hub0000000000a1$/m);
  // The org tree nests the spoke under its OU.
  assert.match(md, /^ {2}- ou ou-ac1e-work0001 Workloads\n {4}- 111111111111 acme-spoke$/m);
});

test('a list past the cap prints CAP items then +N more, once', () => {
  const md = renderMarkdown(describeSnapshot(miniEstate()));
  const subnets = md.split('\n').filter((l) => /^ {2}- subnet-0spk/.test(l));
  assert.equal(subnets.length, CAP);
  assert.equal(md.match(/\+3 more/g)?.length, 1);
  assert.match(md, /11 subnets/);

  const wide = miniEstate();
  const region = wide.accounts[1]?.regions[0];
  assert.ok(region);
  for (let i = 0; i < CAP; i += 1) region.vpcs.push(vpc(`vpc-0extra${String(i).padStart(10, '0')}`, `extra-${i}`, `10.${100 + i}.0.0/16`));
  const d = describeSnapshot(wide, { account: SPOKE });
  assert.equal(d.accounts[0]?.detail[0]?.vpcs.items.length, CAP);
  assert.equal(d.accounts[0]?.detail[0]?.vpcs.more, 1);
  assert.match(renderMarkdown(d), /^- \+1 more$/m);
});

test('--account narrows the accounts and the counts; an unknown one names the known ones', () => {
  const d = describeSnapshot(miniEstate(), { account: 'acme-spoke' });
  assert.deepEqual(d.accounts.map((a) => a.accountId), [SPOKE]);
  assert.deepEqual(
    d.counts.find((c) => c.collection === 'subnets'),
    { collection: 'subnets', scope: 'region', count: CAP + 3 },
  );
  assert.equal(d.counts.find((c) => c.collection === 'transitGateways'), undefined);
  assert.throws(() => describeSnapshot(miniEstate(), { account: '999999999999' }), /known: 222222222222 \(acme-hub\), 111111111111 \(acme-spoke\)/);
});

test('the counts cover region and global collections, non-empty only', () => {
  const d = describeSnapshot(miniEstate());
  assert.deepEqual(d.counts.find((c) => c.collection === 'transitGatewayAttachments'), { collection: 'transitGatewayAttachments', scope: 'region', count: 3 });
  assert.deepEqual(d.counts.find((c) => c.collection === 'hostedZones'), { collection: 'hostedZones', scope: 'global', count: 1 });
  assert.equal(d.counts.find((c) => c.collection === 'natGateways'), undefined);
  const md = renderMarkdown(d);
  assert.match(md, /^\| region \| vpcs 2, subnets 11, .*transitGatewayAttachments 3/m);
  assert.match(md, /^\| global \| hostedZones 1, organizations 1, organizationalUnits 1, organizationAccounts 2 \|$/m);
});

test('the JSON is the same model the markdown renders, and round-trips', () => {
  const d = describeSnapshot(miniEstate());
  const json = JSON.parse(JSON.stringify(d)) as typeof d;
  assert.equal(json.generatedAt, GENERATED_AT);
  assert.equal(renderMarkdown(json), renderMarkdown(d));
});
