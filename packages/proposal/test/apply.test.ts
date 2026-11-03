/**
 * `applyProposal` (PROPOSAL-OVERLAY.md, WP-1): a proposal turns the scanned
 * snapshot into a second snapshot, in order, without touching the first.
 *
 * Against `estate.ts`'s awkward miniature: the shared TGW copy, the ARN-only
 * generic resource, the region from an older scanner that lacks a collection.
 *
 * Shapes it still avoids: two proposals applied in sequence; a `change` that
 * sets a field to `null`; an `add` into a region listed in `emptyRegions` of a
 * *scanned* account other than via the account it names.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyProposal, type Proposal } from '../src/index.js';
import { DEV, estate, GENERIC_ARN, HUB, NEW, newSpoke, only, PROD, REGION, ROLE_ARN, TGW } from './estate.js';

const regionOf = (s: ReturnType<typeof estate>, accountId: string, name = REGION) =>
  s.accounts.find((a) => a.accountId === accountId)?.regions.find((r) => r.region === name);

test('a new account is created with its regions, after the scanned accounts, and the input is untouched', () => {
  const base = estate();
  const proposal = newSpoke();
  const before = structuredClone(base);
  const proposalBefore = structuredClone(proposal);
  const applied = applyProposal(base, proposal);

  assert.deepEqual(base, before);
  assert.deepEqual(proposal, proposalBefore);
  assert.deepEqual(applied.accounts.map((a) => a.accountId), [PROD, HUB, DEV, NEW]);
  const created = applied.accounts[3];
  assert.ok(created);
  assert.equal(created.alias, 'acme-data');
  assert.equal(created.profile, 'proposal:new-spoke');
  assert.equal(created.scannedAt, base.generatedAt);
  assert.equal(applied.generatedAt, base.generatedAt);
  assert.deepEqual(regionOf(applied, NEW)?.vpcs.map((v) => v.id), ['proposed-vpc-data']);
  assert.deepEqual(regionOf(applied, NEW)?.transitGatewayAttachments.map((v) => v.id), ['proposed-attach-data']);
});

test('the result shares no object with either input', () => {
  const base = estate();
  const proposal = newSpoke();
  const applied = applyProposal(base, proposal);
  const before = structuredClone(base);
  const proposalBefore = structuredClone(proposal);

  const vpc = regionOf(applied, NEW)?.vpcs[0];
  assert.ok(vpc);
  vpc.cidrBlocks.push('10.4.0.0/16');
  regionOf(applied, PROD)?.vpcs[0]?.cidrBlocks.push('10.200.0.0/16');
  assert.deepEqual(base, before);
  assert.deepEqual(proposal, proposalBefore);
});

test('change is a shallow merge: arrays and nested objects are replaced whole; id and arn cannot move', () => {
  const base = estate();
  const applied = applyProposal(
    base,
    only({ op: 'change', key: 'pcx-0prod0stranger0001', set: { status: 'deleted', requester: { cidrBlocks: [] }, id: 'pcx-other', arn: 'arn:x' } }),
  );
  const pcx = regionOf(applied, PROD)?.peeringConnections[0];
  assert.ok(pcx);
  assert.equal(pcx.id, 'pcx-0prod0stranger0001');
  assert.equal(pcx.arn, undefined);
  assert.equal(pcx.status, 'deleted');
  assert.deepEqual(pcx.requester, { cidrBlocks: [] }, 'a nested object is replaced, not merged');
  assert.equal(pcx.accepter.accountId, '999999999999', 'fields not in `set` are kept');

  const widened = applyProposal(base, only({ op: 'change', key: 'vpc-0prod0000000001', set: { cidrBlocks: ['10.0.0.0/15'] } }));
  assert.deepEqual(regionOf(widened, PROD)?.vpcs[0]?.cidrBlocks, ['10.0.0.0/15'], 'an array is replaced, not appended to');
});

test('a shared resource is changed, and removed, in every account copy', () => {
  const base = estate();
  const renamed = applyProposal(base, only({ op: 'change', key: TGW, set: { name: 'core-tgw-2' } }));
  assert.equal(regionOf(renamed, HUB)?.transitGateways[0]?.name, 'core-tgw-2');
  assert.equal(regionOf(renamed, PROD)?.transitGateways[0]?.name, 'core-tgw-2');

  const gone = applyProposal(base, only({ op: 'remove', key: TGW }));
  assert.deepEqual(regionOf(gone, HUB)?.transitGateways, []);
  assert.deepEqual(regionOf(gone, PROD)?.transitGateways, []);
});

test('remove and change resolve by arn: an ARN-only generic resource and an IAM role named by its arn', () => {
  const base = estate();
  const applied = applyProposal(base, only({ op: 'remove', key: GENERIC_ARN }, { op: 'change', key: ROLE_ARN, set: { description: 'ci' } }));
  assert.deepEqual(regionOf(applied, PROD)?.generic, []);
  const role = applied.accounts[0]?.global.iamRoles[0];
  assert.equal((role as unknown as Record<string, unknown> | undefined)?.['description'], 'ci');
});

test('ops apply in order: an add, then a change to it, then its removal, then a second add', () => {
  const base = estate();
  const proposal: Proposal = only(
    { op: 'add', account: PROD, region: REGION, collection: 'subnets', resource: { id: 'proposed-subnet-a', vpcId: 'vpc-0prod0000000001', cidrBlock: '10.0.1.0/24', tags: {} } },
    { op: 'change', key: 'proposed-subnet-a', set: { cidrBlock: '10.0.2.0/24' } },
    { op: 'add', account: PROD, region: REGION, collection: 'subnets', resource: { id: 'proposed-subnet-b', vpcId: 'vpc-0prod0000000001', cidrBlock: '10.0.3.0/24', tags: {} } },
    { op: 'remove', key: 'proposed-subnet-a' },
  );
  const subnets = regionOf(applyProposal(base, proposal), PROD)?.subnets ?? [];
  assert.deepEqual(subnets.map((s) => [s.id, s.cidrBlock]), [['proposed-subnet-b', '10.0.3.0/24']]);
});

test('an add creates a missing region, and a collection missing from an older snapshot', () => {
  const base = estate();
  const applied = applyProposal(
    base,
    only(
      { op: 'add', account: PROD, region: 'us-east-1', collection: 'vpcs', resource: { id: 'proposed-vpc-us', tags: {}, cidrBlocks: ['10.8.0.0/16'] } },
      { op: 'add', account: DEV, region: REGION, collection: 'instanceConnectEndpoints', resource: { id: 'proposed-eice', tags: {} } },
      { op: 'add', account: DEV, region: 'global', collection: 'hostedZones', resource: { id: 'proposed-zone', tags: {} } },
    ),
  );
  const prod = applied.accounts[0];
  assert.deepEqual(prod?.regions.map((r) => r.region), [REGION, 'us-east-1']);
  assert.deepEqual(prod?.emptyRegions, [], 'a region the proposal populates is no longer an empty region');
  assert.deepEqual(regionOf(applied, DEV)?.instanceConnectEndpoints.map((e) => e.id), ['proposed-eice']);
  assert.deepEqual(applied.accounts[2]?.global.hostedZones.map((z) => z.id), ['proposed-zone']);
});

test('ops validation would reject are skipped, never thrown', () => {
  const base = estate();
  const before = structuredClone(base);
  const applied = applyProposal(
    base,
    {
      ...only(
        { op: 'add', account: '444444444444', region: REGION, collection: 'vpcs', resource: { id: 'proposed-orphan' } },
        { op: 'add', account: PROD, region: 'global', collection: 'vpcs', resource: { id: 'proposed-wrong-scope' } },
        { op: 'change', key: 'vpc-doesnotexist', set: { name: 'x' } },
        { op: 'remove', key: 'pcx-doesnotexist' },
      ),
      accounts: [{ accountId: PROD, alias: 'renamed' }],
    },
  );
  assert.deepEqual(applied, before, 'every op was invalid, and an account that exists is left as scanned');
});
