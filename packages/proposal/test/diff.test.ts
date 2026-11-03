/**
 * `diffSnapshots` and `indexChangeSet` (PROPOSAL-OVERLAY.md, WP-1): what a
 * proposal changed, by location and field, deterministically.
 *
 * Shapes it still avoids: a resource that moves between collections (it is a
 * remove plus an add by design, but nothing renders that yet); a duplicate id
 * within one scanned collection; snapshots with tens of thousands of
 * resources (see the timing in `read.test.ts` for the fixture only).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyProposal, diffSnapshots, indexChangeSet } from '../src/index.js';
import { DEV, estate, GENERIC_ARN, HUB, NEW, newSpoke, only, PROD, REGION, TGW } from './estate.js';

test('identical snapshots, and the same snapshot after an empty proposal, diff to nothing', () => {
  const base = estate();
  const empty = { addedAccounts: [], removedAccounts: [], added: [], removed: [], changed: [] };
  assert.deepEqual(diffSnapshots(base, estate()), empty);
  assert.deepEqual(diffSnapshots(base, applyProposal(base, only())), empty);
});

test('a new account is an added account, and each of its resources is an added resource with its location', () => {
  const base = estate();
  const changes = diffSnapshots(base, applyProposal(base, newSpoke()));
  assert.deepEqual(changes.addedAccounts, [NEW]);
  assert.deepEqual(changes.removedAccounts, []);
  assert.deepEqual(
    changes.added.map((a) => [a.key, a.accountId, a.region, a.collection]),
    [
      ['proposed-vpc-data', NEW, REGION, 'vpcs'],
      ['proposed-attach-data', NEW, REGION, 'transitGatewayAttachments'],
    ],
  );
  assert.equal(changes.added[0]?.resource['name'], 'data-vpc');
  assert.deepEqual(changes.removed, []);
  assert.deepEqual(changes.changed, []);
});

test('a removed account lists its resources as removed, in snapshot order', () => {
  const base = estate();
  const without = { ...structuredClone(base), accounts: structuredClone(base.accounts).filter((a) => a.accountId !== DEV) };
  const changes = diffSnapshots(base, without);
  assert.deepEqual(changes.removedAccounts, [DEV]);
  assert.deepEqual(changes.removed.map((r) => r.key), ['vpc-0dev00000000001', 'tgw-attach-0dev0000000001']);
});

test('a changed resource lists only the fields that differ, with before/after for those fields only', () => {
  const base = estate();
  const applied = applyProposal(
    base,
    only({ op: 'change', key: 'vpc-0prod0000000001', set: { cidrBlocks: ['10.0.0.0/16', '10.20.0.0/16'], description: 'new', name: undefined } }),
  );
  // `name: undefined` deletes nothing in a shallow merge but leaves the key undefined: the field is gone.
  const changes = diffSnapshots(base, applied);
  assert.equal(changes.changed.length, 1);
  const entry = changes.changed[0];
  assert.ok(entry);
  assert.deepEqual(
    { key: entry.key, accountId: entry.accountId, region: entry.region, collection: entry.collection },
    { key: 'vpc-0prod0000000001', accountId: PROD, region: REGION, collection: 'vpcs' },
  );
  assert.deepEqual(entry.fields, ['cidrBlocks', 'description', 'name']);
  assert.deepEqual(entry.before, { cidrBlocks: ['10.0.0.0/16'], name: 'prod-vpc' }, 'description did not exist before');
  assert.deepEqual(entry.after, { cidrBlocks: ['10.0.0.0/16', '10.20.0.0/16'], description: 'new' }, 'name no longer exists');
});

test('key order inside nested objects is not a change; array order is', () => {
  const base = estate();
  const reordered = structuredClone(base);
  const vpc = reordered.accounts[0]?.regions[0]?.vpcs[0];
  assert.ok(vpc);
  vpc.tags = { env: 'prod' };
  const pcx = reordered.accounts[0]?.regions[0]?.peeringConnections[0];
  assert.ok(pcx);
  pcx.accepter = { cidrBlocks: pcx.accepter.cidrBlocks, region: pcx.accepter.region, accountId: pcx.accepter.accountId, vpcId: pcx.accepter.vpcId };
  assert.deepEqual(diffSnapshots(base, reordered).changed, []);

  vpc.cidrBlocks = ['10.20.0.0/16', '10.0.0.0/16'];
  const swapped = structuredClone(reordered);
  const twice = swapped.accounts[0]?.regions[0]?.vpcs[0];
  assert.ok(twice);
  twice.cidrBlocks = [...twice.cidrBlocks].reverse();
  assert.deepEqual(diffSnapshots(reordered, swapped).changed.map((c) => c.fields), [['cidrBlocks']]);
});

test('a shared resource changed in every copy yields one entry per account copy', () => {
  const base = estate();
  const changes = diffSnapshots(base, applyProposal(base, only({ op: 'change', key: TGW, set: { name: 'core-tgw-2' } })));
  assert.deepEqual(changes.changed.map((c) => [c.key, c.accountId]), [[TGW, PROD], [TGW, HUB]]);
});

test('an ARN-only resource is keyed by its arn', () => {
  const base = estate();
  const changes = diffSnapshots(base, applyProposal(base, only({ op: 'remove', key: GENERIC_ARN })));
  assert.deepEqual(changes.removed.map((r) => [r.key, r.arn, r.collection]), [[GENERIC_ARN, GENERIC_ARN, 'generic']]);
});

test('a collection missing from an older snapshot diffs as empty, not as removed', () => {
  const base = estate();
  const filled = structuredClone(base);
  const dev = filled.accounts[2]?.regions[0];
  assert.ok(dev);
  dev.instanceConnectEndpoints = [];
  assert.deepEqual(diffSnapshots(base, filled).changed, []);
  assert.deepEqual(diffSnapshots(base, filled).removed, []);
});

test('neither input is mutated, and the ChangeSet aliases neither', () => {
  const base = estate();
  const applied = applyProposal(base, newSpoke());
  const a = structuredClone(base);
  const b = structuredClone(applied);
  const changes = diffSnapshots(base, applied);
  assert.deepEqual(base, a);
  assert.deepEqual(applied, b);
  (changes.added[0]?.resource['cidrBlocks'] as string[]).push('x');
  assert.deepEqual(applied, b);
});

test('indexChangeSet answers by id and by arn; an unchanged key is absent', () => {
  const base = estate();
  const applied = applyProposal(
    base,
    only({ op: 'remove', key: GENERIC_ARN }, { op: 'change', key: 'deploy', set: { description: 'ci' } }, {
      op: 'add', account: PROD, region: REGION, collection: 'subnets', resource: { id: 'proposed-subnet', tags: {} },
    }),
  );
  const index = indexChangeSet(diffSnapshots(base, applied));
  assert.equal(index.get(GENERIC_ARN)?.state, 'removed');
  assert.equal(index.get('deploy')?.state, 'changed');
  assert.equal(index.get(`arn:aws:iam::${PROD}:role/deploy`)?.state, 'changed');
  assert.equal(index.get('proposed-subnet')?.state, 'added');
  assert.equal(index.get('vpc-0prod0000000001'), undefined);
});
