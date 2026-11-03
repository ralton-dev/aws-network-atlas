/**
 * The red pin for PROPOSAL-OVERLAY.md ("The red pin"): a proposal is a second
 * snapshot produced by applying a delta to the first, and the diagram is the
 * union of the two graphs with each node and edge stamped added, removed or
 * changed (decision 49).
 *
 * The estate is the same hub-and-spoke miniature as `selection.test.ts` — hub
 * `222…` owning a TGW, spokes `111…` and `333…` attached — reproduced here so a
 * failure names a rule of the overlay rather than an edit to another test. It
 * is indexed through the real `buildIndex()` with **no arguments**, by setting
 * `window.__ATLAS_DATA__` first, exactly as that file does; the pin must not
 * depend on decision 57's parameters (WP-3).
 *
 * Assertions 1–4 are green from WP-1. Assertion 5 reads the committed demo
 * proposal, which WP-6 writes by running the skill for real; until then it is
 * a `todo` and WP-6 flips it to a plain `test`. When it passes plainly, the
 * plan is done.
 *
 * Shapes it still avoids: a proposal that removes an account or a resource
 * that an edge label derives from; a change whose field drives an edge label
 * (routes, SG rules); proposed resources in a switched-off account; and any
 * kind outside networking.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { applyProposal, diffSnapshots, validateProposal, type Proposal } from '@atlas/proposal';
import { parseProposal, readSiteData } from '@atlas/proposal/read';
import { emptyGlobal, emptyRegionSnapshot, type AccountSnapshot, type Snapshot } from '@atlas/schema';
import { buildIndex, type AtlasIndex } from '../src/data.js';
import { diffGraphs } from '../src/model/diff.js';
import type { AtlasGraph } from '../src/model/graph-types.js';
import { buildOverview } from '../src/model/overview.js';

const SPOKE_PROD = '111111111111';
const HUB = '222222222222';
const SPOKE_DEV = '333333333333';
const NEW_SPOKE = '555555555555';
const REGION = 'eu-west-1';
const TGW = 'tgw-0a1b2c3d4e5f00001';
const GENERATED_AT = '2026-11-03T00:00:00Z';

function spoke(accountId: string, alias: string, vpcId: string, attachmentId: string): AccountSnapshot {
  const region = emptyRegionSnapshot(REGION);
  region.vpcs.push({ id: vpcId, name: `${alias}-vpc`, tags: {}, cidrBlocks: ['10.0.0.0/16'], ipv6CidrBlocks: [], isDefault: false });
  region.transitGatewayAttachments.push({
    id: attachmentId,
    tags: {},
    transitGatewayId: TGW,
    transitGatewayOwnerId: HUB,
    resourceOwnerId: accountId,
    resourceType: 'vpc',
    resourceId: vpcId,
    subnetIds: [],
  });
  return {
    accountId,
    alias,
    profile: alias,
    scannedAt: GENERATED_AT,
    scannerVersion: 'test',
    regions: [region],
    emptyRegions: [],
    global: emptyGlobal(),
  };
}

function miniatureEstate(): Snapshot {
  const prod = spoke(SPOKE_PROD, 'acme-prod', 'vpc-0prod0000000001', 'tgw-attach-0prod000000001');
  const hubRegion = emptyRegionSnapshot(REGION);
  hubRegion.transitGateways.push({ id: TGW, name: 'core-tgw', tags: {}, ownerId: HUB });
  hubRegion.vpcs.push({ id: 'vpc-0hub00000000001', name: 'hub-vpc', tags: {}, cidrBlocks: ['10.9.0.0/16'], ipv6CidrBlocks: [], isDefault: false });
  const hub: AccountSnapshot = {
    accountId: HUB,
    alias: 'acme-shared',
    profile: 'acme-shared',
    scannedAt: GENERATED_AT,
    scannerVersion: 'test',
    regions: [hubRegion],
    emptyRegions: [],
    global: emptyGlobal(),
  };
  const dev = spoke(SPOKE_DEV, 'acme-dev', 'vpc-0dev00000000001', 'tgw-attach-0dev0000000001');
  return { version: 1, generatedAt: GENERATED_AT, accounts: [prod, hub, dev] };
}

/** The pin's proposal: a new spoke account with one VPC attached to the hub's TGW. */
function newSpoke(): Proposal {
  return {
    id: 'new-spoke',
    version: 1,
    title: 'Add a data-platform spoke joined to the core TGW',
    base: { generatedAt: GENERATED_AT },
    accounts: [{ accountId: NEW_SPOKE, alias: 'acme-data', regions: [REGION] }],
    changes: [
      {
        op: 'add',
        account: NEW_SPOKE,
        region: REGION,
        collection: 'vpcs',
        resource: { id: 'proposed-vpc-data', name: 'data-vpc', tags: {}, cidrBlocks: ['10.3.0.0/16'], ipv6CidrBlocks: [], isDefault: false },
      },
      {
        op: 'add',
        account: NEW_SPOKE,
        region: REGION,
        collection: 'transitGatewayAttachments',
        resource: {
          id: 'proposed-attach-data',
          tags: {},
          transitGatewayId: TGW,
          transitGatewayOwnerId: HUB,
          resourceOwnerId: NEW_SPOKE,
          resourceType: 'vpc',
          resourceId: 'proposed-vpc-data',
          subnetIds: [],
        },
      },
    ],
  };
}

/** `buildIndex` reads the global the bundle's classic script sets; do the same. */
function indexOf(snapshot: Snapshot): AtlasIndex {
  (globalThis as { window?: Partial<Window> }).window = { __ATLAS_DATA__: snapshot };
  return buildIndex();
}

/** `buildIndex` fills missing collections in place; index a copy so the caller's snapshot is untouched. */
const overviewOf = (snapshot: Snapshot): AtlasGraph => buildOverview(indexOf(structuredClone(snapshot)));

const stamped = (graph: AtlasGraph): string[] => [
  ...graph.nodes.filter((n) => n.data.changeState).map((n) => `${n.id}=${n.data.changeState}`),
  ...graph.edges.filter((e) => e.data?.changeState).map((e) => `${e.id}=${e.data?.changeState}`),
];

test('1 · applyProposal adds the new spoke account with its VPC and attachment, and leaves the input alone', () => {
  const base = miniatureEstate();
  const before = structuredClone(base);
  const applied = applyProposal(base, newSpoke());

  assert.deepEqual(base, before, 'the input snapshot must not be mutated');
  assert.equal(applied.accounts.length, 4);
  const added = applied.accounts.find((a) => a.accountId === NEW_SPOKE);
  assert.ok(added, 'expected the proposed account');
  assert.equal(added.alias, 'acme-data');
  const region = added.regions.find((r) => r.region === REGION);
  assert.ok(region);
  assert.deepEqual(region.vpcs.map((v) => v.id), ['proposed-vpc-data']);
  assert.deepEqual(region.transitGatewayAttachments.map((a) => a.id), ['proposed-attach-data']);
});

test('2 · diffSnapshots reports the two adds and the added account; a cidrBlocks change reports that field only', () => {
  const base = miniatureEstate();
  const applied = applyProposal(base, newSpoke());
  const changes = diffSnapshots(base, applied);
  assert.deepEqual(changes.addedAccounts, [NEW_SPOKE]);
  assert.deepEqual(changes.added.map((r) => r.key).sort(), ['proposed-attach-data', 'proposed-vpc-data']);
  assert.deepEqual(changes.removed, []);
  assert.deepEqual(changes.changed, []);

  const widened: Proposal = {
    ...newSpoke(),
    accounts: [],
    changes: [{ op: 'change', key: 'vpc-0hub00000000001', set: { cidrBlocks: ['10.9.0.0/16', '10.10.0.0/16'] } }],
  };
  const changed = diffSnapshots(base, applyProposal(base, widened));
  assert.deepEqual(changed.added, []);
  assert.equal(changed.changed.length, 1);
  const entry = changed.changed[0];
  assert.ok(entry);
  assert.equal(entry.key, 'vpc-0hub00000000001');
  assert.deepEqual(entry.fields, ['cidrBlocks']);
  assert.deepEqual(entry.before, { cidrBlocks: ['10.9.0.0/16'] });
  assert.deepEqual(entry.after, { cidrBlocks: ['10.9.0.0/16', '10.10.0.0/16'] });
});

test('3 · validateProposal: clean, then an unresolvable transitGatewayId, then a stale base', () => {
  const base = miniatureEstate();
  assert.deepEqual(validateProposal(base, newSpoke()), []);

  const broken = newSpoke();
  const attach = broken.changes[1];
  assert.ok(attach && attach.op === 'add');
  attach.resource['transitGatewayId'] = 'tgw-doesnotexist';
  const errors = validateProposal(base, broken).filter((i) => i.level === 'error');
  assert.equal(errors.length, 1);
  const error = errors[0];
  assert.ok(error);
  assert.equal(error.key, 'tgw-doesnotexist');
  assert.match(error.path ?? '', /transitGatewayId$/);
  assert.match(error.message, /transitGatewayId/);

  const stale = { ...newSpoke(), base: { generatedAt: '2026-01-01T00:00:00Z' } };
  const issues = validateProposal(base, stale);
  assert.deepEqual(issues.map((i) => `${i.level}:${i.code}`), ['warning:stale']);
});

test('4 · diffGraphs stamps exactly the new spoke, and an empty proposal does not move the overview', () => {
  const base = miniatureEstate();
  const applied = applyProposal(base, newSpoke());
  const changes = diffSnapshots(base, applied);
  const union = diffGraphs(overviewOf(base), overviewOf(applied), changes);

  assert.deepEqual(stamped(union).sort(), [
    `acct:${NEW_SPOKE}=added`,
    'edge:proposed-attach-data=added',
    'vpc:proposed-vpc-data=added',
    // The new account's region container is part of the new account.
    `region:${NEW_SPOKE}:${REGION}=added`,
  ].sort());

  const empty: Proposal = { ...newSpoke(), accounts: [], changes: [] };
  const appliedEmpty = applyProposal(base, empty);
  const same = diffGraphs(overviewOf(base), overviewOf(appliedEmpty), diffSnapshots(base, appliedEmpty));
  const today = overviewOf(base);
  assert.deepEqual(same.nodes, today.nodes);
  assert.deepEqual(same.edges, today.edges);
});

// "What could break silently" (PROPOSAL-OVERLAY.md): a leaf that moved lanes
// because a display cap shifted (decision 58) is in both graphs under
// different parents. It must be drawn once, under its proposed parent, as
// `changed` — not twice, and not lost.
test('4b · a node in both graphs with a different parentId is changed, drawn once, under its proposed parent', () => {
  const node = (id: string, parentId?: string): AtlasGraph['nodes'][number] => ({
    id,
    position: { x: 0, y: 0 },
    ...(parentId ? { parentId } : {}),
    data: { label: id, kind: parentId ? 'iam-role' : 'group-account', ...(parentId ? {} : { isContainer: true }) },
  });
  const current: AtlasGraph = { nodes: [node('lane:a'), node('lane:b'), node('role:x', 'lane:a')], edges: [] };
  const proposed: AtlasGraph = { nodes: [node('lane:a'), node('lane:b'), node('role:x', 'lane:b')], edges: [] };
  const empty = { addedAccounts: [], removedAccounts: [], added: [], removed: [], changed: [] };
  const union = diffGraphs(current, proposed, empty);

  assert.deepEqual(union.nodes.map((n) => `${n.id}<${n.parentId ?? ''}=${n.data.changeState ?? ''}`), [
    'lane:a<=',
    'lane:b<=',
    'role:x<lane:b=changed',
  ]);
});

test('4c · a removal is stamped on the current graph`s nodes, after the proposed ones, and neither input graph is touched', () => {
  const base = miniatureEstate();
  const proposal: Proposal = {
    ...newSpoke(),
    accounts: [],
    changes: [
      { op: 'remove', key: 'tgw-attach-0dev0000000001' },
      { op: 'remove', key: 'vpc-0dev00000000001' },
    ],
  };
  const applied = applyProposal(base, proposal);
  const current = overviewOf(base);
  const proposed = overviewOf(applied);
  const before = structuredClone({ current, proposed });
  const union = diffGraphs(current, proposed, diffSnapshots(base, applied));

  assert.deepEqual(stamped(union).sort(), ['edge:tgw-attach-0dev0000000001=removed', 'vpc:vpc-0dev00000000001=removed']);
  assert.equal(union.nodes.at(-1)?.id, 'vpc:vpc-0dev00000000001', 'removed nodes follow the proposed graph');
  const seen = new Set<string>();
  for (const n of union.nodes) {
    if (n.parentId) assert.ok(seen.has(n.parentId), `${n.id} is drawn before its parent ${n.parentId}`);
    seen.add(n.id);
  }

  // A later pass that writes to data (applyTerraformBadges does) must not reach the inputs.
  for (const n of union.nodes) n.data.tfManaged = true;
  for (const n of union.nodes) n.position.x = 99;
  assert.deepEqual({ current, proposed }, before);
});

test('4d · a resource in the ChangeSet is changed even when nothing it draws differs', () => {
  const base = miniatureEstate();
  const proposal: Proposal = { ...newSpoke(), accounts: [], changes: [{ op: 'change', key: 'vpc-0hub00000000001', set: { tags: { owner: 'net' } } }] };
  const applied = applyProposal(base, proposal);
  const union = diffGraphs(overviewOf(base), overviewOf(applied), diffSnapshots(base, applied));
  assert.deepEqual(stamped(union), ['vpc:vpc-0hub00000000001=changed']);
});

// A `todo` until WP-6, which flipped it to a plain `test` when it committed
// `proposals/new-spoke.yaml`. Observed before that file existed (35ebcbe, and
// again at d5c994f with the flip in place): ENOENT: no such file or
// directory, open '<repo>/proposals/new-spoke.yaml'.
test('5 · the committed demo proposal validates, applies and draws a new account and attachment', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const proposalFile = path.join(root, 'proposals', 'new-spoke.yaml');
  const proposal = parseProposal(readFileSync(proposalFile, 'utf8'), 'new-spoke');
  const site = path.join(root, 'site', 'data', 'data.js');
  assert.ok(existsSync(site));
  const base = readSiteData(readFileSync(site, 'utf8'));

  const errors = validateProposal(base, proposal).filter((i) => i.level === 'error');
  assert.deepEqual(errors, []);
  const applied = applyProposal(base, proposal);
  const union = diffGraphs(overviewOf(base), overviewOf(applied), diffSnapshots(base, applied));
  assert.ok(union.nodes.some((n) => n.data.kind === 'group-account' && n.data.changeState === 'added'));
  assert.ok(union.edges.some((e) => e.data?.edgeKind === 'tgw' && e.data.changeState === 'added'));
});
