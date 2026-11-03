/**
 * The account picker's selection model in `src/model/selection.ts`, pinned.
 *
 * The failure this exists to prevent is the overview being *the estate*: every
 * scanned account built and laid out in the browser before anything is drawn,
 * with no way for the reader to choose (ACCOUNT-PICKER.md, "The defect"). The
 * picker narrows the overview by handing `buildOverview` a derived index whose
 * `snapshot.accounts` is only the selected accounts (decision 34), so that
 * module is the one place an account is switched off — and these assertions
 * are what keep it the one place.
 *
 * Only the model is imported: `data.ts` for the real `buildIndex`, `overview.ts`
 * for the real builder, and `selection.ts`. It is plain TypeScript — no DOM, no
 * React, no ELK — so the assertions are about the graph the builder returns,
 * not about anything drawn.
 *
 * The index is built through the same `buildIndex` path the app uses, by
 * setting `window.__ATLAS_DATA__` before calling it, exactly as
 * `site/data/data.js` does in the browser. The estate is a hub-and-spoke in
 * miniature, reproduced here rather than imported from the scanner's dev
 * fixture so a failure names a rule of the selection model instead of an edit
 * to the estate:
 *
 *   - `222222222222` (acme-shared) owns a transit gateway;
 *   - `111111111111` (acme-prod) and `333333333333` (acme-dev) each attach a
 *     VPC to it;
 *   - a role in `111…` trusts `333…`.
 *
 * Case 5 adds the shape real AWS produces for a shared TGW: the spoke's own
 * snapshot lists the hub's TGW too, so the placement loop's `other` pass would
 * otherwise put the hub's TGW under the spoke's region and draw no hub ghost.
 *
 * Shapes it still avoids: an account with no cross-account link at all; links
 * that exist only through RAM shares, SSO assignments, VPC peering, Route 53
 * aliases or CloudFront origins; an account with no alias; and more than
 * three accounts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyGlobal, emptyRegionSnapshot, type AccountSnapshot, type Snapshot } from '@atlas/schema';
import { buildIndex, type AtlasIndex } from '../src/data.js';
import type { AtlasGraph, AtlasNode } from '../src/model/graph-types.js';
import { buildOverview } from '../src/model/overview.js';
import {
  defaultSelection,
  formatAccountsParam,
  omittedAccounts,
  parseAccountsParam,
  withAccounts,
} from '../src/model/selection.js';

const SPOKE_PROD = '111111111111';
const HUB = '222222222222';
const SPOKE_DEV = '333333333333';
const REGION = 'eu-west-1';
const TGW = 'tgw-0a1b2c3d4e5f00001';

/** One spoke: a VPC attached to the hub's TGW, nothing else. */
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
    scannedAt: '2026-11-03T00:00:00Z',
    scannerVersion: 'test',
    regions: [region],
    emptyRegions: [],
    global: emptyGlobal(),
  };
}

function miniatureEstate(): Snapshot {
  const prod = spoke(SPOKE_PROD, 'acme-prod', 'vpc-0prod0000000001', 'tgw-attach-0prod000000001');
  prod.global.iamRoles.push({
    id: 'deploy',
    name: 'deploy',
    arn: `arn:aws:iam::${SPOKE_PROD}:role/deploy`,
    tags: {},
    attachedManagedPolicyArns: [],
    inlinePolicyNames: [],
    assumeRolePolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${SPOKE_DEV}:root` }, Action: 'sts:AssumeRole' }],
    }),
  });

  const hubRegion = emptyRegionSnapshot(REGION);
  hubRegion.transitGateways.push({ id: TGW, name: 'core-tgw', tags: {}, ownerId: HUB });
  const hub: AccountSnapshot = {
    accountId: HUB,
    alias: 'acme-shared',
    profile: 'acme-shared',
    scannedAt: '2026-11-03T00:00:00Z',
    scannerVersion: 'test',
    regions: [hubRegion],
    emptyRegions: [],
    global: emptyGlobal(),
  };

  const dev = spoke(SPOKE_DEV, 'acme-dev', 'vpc-0dev00000000001', 'tgw-attach-0dev0000000001');
  // Snapshot order is deliberately not id order, so "original order" is observable.
  return { version: 1, generatedAt: '2026-11-03T00:00:00Z', accounts: [prod, hub, dev] };
}

/** `buildIndex` reads the global the bundle's classic script sets; do the same. */
function indexOf(snapshot: Snapshot): AtlasIndex {
  (globalThis as { window?: Partial<Window> }).window = { __ATLAS_DATA__: snapshot };
  return buildIndex();
}

const accountContainers = (graph: AtlasGraph): AtlasNode[] =>
  graph.nodes.filter((n) => n.data.kind === 'group-account');

// Before WP-2 both ghosts already fired (333 via the trust edge, 222 via the
// TGW attachment) but read `Account <id>` / `not scanned`, carried no
// `addAccountId`, and the hub's TGW was labelled with its bare id.
test('1 · a one-spoke selection draws that spoke, and the hub and the other spoke as addable ghosts', () => {
  const index = indexOf(miniatureEstate());
  const graph = buildOverview(withAccounts(index, new Set([SPOKE_PROD])));
  const containers = accountContainers(graph);

  const drawn = containers.filter((n) => !n.data.ghost).map((n) => n.id);
  assert.deepEqual(drawn, [`acct:${SPOKE_PROD}`]);

  for (const id of [HUB, SPOKE_DEV]) {
    const ghost = containers.find((n) => n.id === `acct:${id}`);
    assert.ok(ghost, `expected a ghost container for ${id}`);
    assert.equal(ghost.data.ghost, true);
    assert.equal(ghost.data.label, index.accountLabel(id));
    assert.equal(ghost.data.addAccountId, id);
    assert.equal(ghost.data.subtitle, 'not shown · click to add');
  }

  // The hub's TGW is a scanned resource whose account is merely off: it is
  // named from the scan, not `not scanned`, and sits in the hub's ghost.
  const tgw = graph.nodes.find((n) => n.id === `tgw:${TGW}`);
  assert.equal(tgw?.parentId, `acct:${HUB}`);
  assert.equal(tgw?.data.label, 'core-tgw');
  assert.equal(tgw?.data.subtitle, `${REGION} · not shown`);
  assert.equal(tgw?.data.ghost, true);
});

test('2 · selecting every account builds exactly the unfiltered overview', () => {
  const index = indexOf(miniatureEstate());
  const all = new Set(index.snapshot.accounts.map((a) => a.accountId));
  const shown = withAccounts(index, all);

  // Show-all hands back the very same object, so WeakMap-keyed caches stay warm.
  assert.equal(shown, index);
  assert.equal(omittedAccounts(shown).size, 0);

  const filtered = buildOverview(shown);
  const full = buildOverview(index);
  assert.deepEqual(filtered.nodes, full.nodes);
  assert.deepEqual(filtered.edges, full.edges);

  // And the single-account estate, where show-all is the default (decision 35).
  const solo = indexOf({ ...miniatureEstate(), accounts: miniatureEstate().accounts.slice(0, 1) });
  const soloShown = withAccounts(solo, defaultSelection(solo));
  assert.equal(soloShown, solo);
  assert.deepEqual(buildOverview(soloShown).nodes, buildOverview(solo).nodes);
  assert.deepEqual(buildOverview(soloShown).edges, buildOverview(solo).edges);
});

test('2a · a partial selection filters accounts in snapshot order and shares everything else', () => {
  const index = indexOf(miniatureEstate());
  // Passed in reverse id order; the snapshot order (prod, hub, dev) must win.
  const shown = withAccounts(index, new Set([SPOKE_DEV, SPOKE_PROD]));

  assert.notEqual(shown, index);
  assert.deepEqual(shown.snapshot.accounts.map((a) => a.accountId), [SPOKE_PROD, SPOKE_DEV]);
  // The account objects themselves are the originals, not copies.
  assert.equal(shown.snapshot.accounts[0], index.snapshot.accounts[0]);
  assert.equal(shown.snapshot.version, index.snapshot.version);
  assert.equal(shown.snapshot.generatedAt, index.snapshot.generatedAt);
  // The original index is untouched.
  assert.deepEqual(index.snapshot.accounts.map((a) => a.accountId), [SPOKE_PROD, HUB, SPOKE_DEV]);

  // Every lookup stays full-estate, so the hub is still nameable and findable.
  assert.equal(shown.all, index.all);
  assert.equal(shown.byKey, index.byKey);
  assert.equal(shown.annotations, index.annotations);
  assert.equal(shown.terraform, index.terraform);
  assert.equal(shown.accountLabel, index.accountLabel);
  assert.equal(shown.annotationFor, index.annotationFor);
  assert.equal(shown.terraformFor, index.terraformFor);
  assert.equal(shown.findRegion, index.findRegion);
  assert.equal(shown.accountLabel(HUB), 'acme-shared (222222222222)');
  assert.ok(shown.findRegion(HUB, REGION));

  assert.deepEqual([...omittedAccounts(shown)], [HUB]);
  assert.equal(omittedAccounts(index).size, 0);
  // Ids that were never scanned are not "omitted" — they were never there.
  assert.deepEqual([...omittedAccounts(withAccounts(index, new Set([SPOKE_PROD, '999999999999'])))], [HUB, SPOKE_DEV]);
  // The empty selection omits everything and draws no scanned account.
  const none = withAccounts(index, new Set());
  assert.equal(none.snapshot.accounts.length, 0);
  assert.equal(omittedAccounts(none).size, 3);
});

test('3 · default selection: every account for a one-account estate, none otherwise', () => {
  const three = indexOf(miniatureEstate());
  assert.deepEqual([...defaultSelection(three)], []);

  const one = indexOf({ ...miniatureEstate(), accounts: miniatureEstate().accounts.slice(1, 2) });
  assert.deepEqual([...defaultSelection(one)], [HUB]);

  const empty = indexOf({ version: 1, generatedAt: '', accounts: [] });
  assert.deepEqual([...defaultSelection(empty)], []);
});

test('4 · the overview hash carries the selection, sorted, and round-trips', () => {
  const parsed = parseAccountsParam('#/?accounts=333333333333,111111111111');
  assert.deepEqual(parsed && [...parsed], [SPOKE_PROD, SPOKE_DEV]);

  assert.equal(formatAccountsParam(new Set([SPOKE_DEV, SPOKE_PROD])), '?accounts=111111111111,333333333333');
  assert.equal(formatAccountsParam(new Set()), '');
  const roundTrip = parseAccountsParam(`#/${formatAccountsParam(parsed ?? new Set())}`);
  assert.deepEqual(roundTrip && [...roundTrip], [SPOKE_PROD, SPOKE_DEV]);

  // No opinion: plain overview, other routes, and a param with nothing usable.
  assert.equal(parseAccountsParam('#/'), undefined);
  assert.equal(parseAccountsParam(''), undefined);
  assert.equal(parseAccountsParam('#/vpc/x'), undefined);
  assert.equal(parseAccountsParam('#/vpc/vpc-1?accounts=111111111111'), undefined);
  assert.equal(parseAccountsParam('#/focus/arn%3Aaws%3Aiam%3A%3A111111111111%3Arole%2Fx'), undefined);
  assert.equal(parseAccountsParam('#/?accounts='), undefined);
  assert.equal(parseAccountsParam('#/?accounts=nope,12345'), undefined);

  // Tolerant: whitespace, duplicates, encoded commas, junk ids dropped.
  const messy = parseAccountsParam('#/?accounts= 333333333333 ,junk,111111111111%2C333333333333,1234567890123');
  assert.deepEqual(messy && [...messy], [SPOKE_PROD, SPOKE_DEV]);
});

test('5 · a hub TGW listed in the spoke\'s own snapshot still draws the hub as an addable ghost', () => {
  const estate = miniatureEstate();
  const [prod] = estate.accounts;
  const prodRegion = prod?.regions[0];
  assert.ok(prodRegion);
  // Real AWS lists a TGW shared into an account in that account's
  // DescribeTransitGateways, owner id and all. Plus one owned by an account
  // that was never scanned, which must keep reading as such.
  prodRegion.transitGateways.push({ id: TGW, name: 'core-tgw', tags: {}, ownerId: HUB });
  const NEVER = '999999999999';
  const FOREIGN = 'tgw-0f0f0f0f0f0f00009';
  prodRegion.transitGateways.push({ id: FOREIGN, name: 'partner-tgw', tags: {}, ownerId: NEVER });
  const index = indexOf(estate);

  // Show-all: the owner pass places the hub's TGW in the hub's region, and the
  // never-scanned owner's TGW stays in the spoke's region — as before WP-2.
  const full = buildOverview(index);
  assert.equal(full.nodes.find((n) => n.id === `tgw:${TGW}`)?.parentId, `region:${HUB}:${REGION}`);
  assert.equal(full.nodes.find((n) => n.id === `tgw:${FOREIGN}`)?.parentId, `region:${SPOKE_PROD}:${REGION}`);

  // Spoke only: without WP-2 the `other` pass put the hub's TGW under prod's
  // region and no `acct:222…` ghost was drawn at all. Now it goes under the
  // hub's ghost, which can be clicked to add the hub.
  const shown = withAccounts(index, new Set([SPOKE_PROD]));
  const graph = buildOverview(shown);
  const hub = graph.nodes.find((n) => n.id === `acct:${HUB}`);
  assert.ok(hub, 'expected a ghost container for the hub');
  assert.equal(hub.data.ghost, true);
  assert.equal(hub.data.label, index.accountLabel(HUB));
  assert.equal(hub.data.addAccountId, HUB);

  const tgw = graph.nodes.find((n) => n.id === `tgw:${TGW}`);
  assert.equal(tgw?.parentId, `acct:${HUB}`);
  assert.equal(tgw?.data.label, 'core-tgw');
  assert.equal(tgw?.data.ghost, true);
  assert.ok(
    graph.edges.some((e) => e.source === 'vpc:vpc-0prod0000000001' && e.target === `tgw:${TGW}`),
    'expected the spoke VPC → hub TGW attachment edge',
  );

  // The unscanned owner is not "switched off": its TGW is placed exactly as in
  // the unfiltered build, and no ghost claims it can be added.
  assert.equal(graph.nodes.find((n) => n.id === `tgw:${FOREIGN}`)?.parentId, `region:${SPOKE_PROD}:${REGION}`);
  assert.equal(graph.nodes.find((n) => n.id === `acct:${NEVER}`), undefined);
  for (const n of graph.nodes) {
    if (n.data.addAccountId !== undefined) assert.ok(omittedAccounts(shown).has(n.data.addAccountId));
  }
});
