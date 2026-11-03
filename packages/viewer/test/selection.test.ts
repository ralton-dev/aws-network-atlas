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
 * Cases 6–12 add a richer hub (WP-2b): CloudFront origins, a private zone, a
 * VPN, Direct Connect and the reverse trust and RAM links that point *into*
 * the selection from a switched-off account.
 *
 * Shapes it still avoids: an account with no cross-account link at all; links
 * that exist only through SSO assignments, VPC peering or Route 53 aliases; RAM
 * shares to OUs or the organization; an account with no alias; and more than
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

// ---------------------------------------------------------------------------
// WP-2b · lookups that silently drew nothing under a filtered index.
//
// Every helper below was written under "the index I was handed is the whole
// estate". With the hub switched off, each either drew nothing or drew the
// hub's resource inside the selected account's own box. The shape: the hub
// owns a VPC behind an ALB, an S3 bucket, an attached and a detached VPN
// gateway, a second TGW, a role trusting prod and a RAM share into prod; prod
// fronts the ALB and the bucket with CloudFront, associates a private zone
// with the hub's VPC, runs a VPN to the hub's TGW, and has a DX gateway and
// two VIFs landing on the hub's VPN gateways. A VGW owned by an account that
// was never scanned is the control: it must keep reading `not scanned`.
// ---------------------------------------------------------------------------

const HUB_VPC = 'vpc-0hub000000000001';
const HUB_ALB_DNS = 'hub-alb-123.eu-west-1.elb.amazonaws.com';
const HUB_BUCKET = 'hub-assets';
const HUB_VGW = 'vgw-0hub00000000001';
const HUB_VGW_DETACHED = 'vgw-0hub00000000002';
const HUB_VPN_TGW = 'tgw-0a1b2c3d4e5f00003';
const NEVER = '999999999999';
const NEVER_VGW = 'vgw-0f0f0f0f0f0f0009';

function richEstate(): Snapshot {
  const estate = miniatureEstate();
  const [prod, hub] = estate.accounts;
  const prodRegion = prod?.regions[0];
  const hubRegion = hub?.regions[0];
  assert.ok(prod && hub && prodRegion && hubRegion);

  hubRegion.vpcs.push({ id: HUB_VPC, name: 'hub-vpc', tags: {}, cidrBlocks: ['10.9.0.0/16'], ipv6CidrBlocks: [], isDefault: false });
  hubRegion.loadBalancers.push({
    id: 'arn:aws:elasticloadbalancing:eu-west-1:222222222222:loadbalancer/app/hub-alb/1',
    name: 'hub-alb', tags: {}, lbType: 'application', vpcId: HUB_VPC, subnetIds: [], availabilityZones: [],
    securityGroupIds: [], dnsName: HUB_ALB_DNS, listeners: [],
  });
  hubRegion.vpnGateways.push({ id: HUB_VGW, name: 'hub-vgw', tags: {}, vpcIds: [HUB_VPC] });
  hubRegion.vpnGateways.push({ id: HUB_VGW_DETACHED, name: 'hub-spare-vgw', tags: {}, vpcIds: [] });
  hubRegion.transitGateways.push({ id: HUB_VPN_TGW, name: 'vpn-tgw', tags: {}, ownerId: HUB });
  hubRegion.ramResourceShares.push({
    id: 'arn:aws:ram:eu-west-1:222222222222:resource-share/core',
    name: 'core-tgw-share', tags: {}, owningAccountId: HUB,
    principals: [{ id: SPOKE_PROD, type: 'account' }, { id: NEVER, type: 'account' }],
    resources: [{ arn: `arn:aws:ec2:eu-west-1:222222222222:transit-gateway/${TGW}`, type: 'ec2:TransitGateway' }],
  });
  hub.global.s3Buckets.push({ id: HUB_BUCKET, name: HUB_BUCKET, tags: {}, region: REGION });
  hub.global.iamRoles.push({
    id: 'network-audit', name: 'network-audit', arn: `arn:aws:iam::${HUB}:role/network-audit`, tags: {},
    attachedManagedPolicyArns: [], inlinePolicyNames: [],
    assumeRolePolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${SPOKE_PROD}:root` }, Action: 'sts:AssumeRole' }],
    }),
  });

  prod.global.cloudFrontDistributions.push({
    id: 'E0PROD', name: 'prod-cdn', tags: {}, aliases: [], domainName: 'd0prod.cloudfront.net',
    origins: [HUB_ALB_DNS, `${HUB_BUCKET}.s3.eu-west-1.amazonaws.com`],
  });
  prod.global.hostedZones.push({
    id: 'Z0PROD', zoneName: 'internal.acme.', tags: {}, privateZone: true,
    vpcAssociations: [{ vpcId: HUB_VPC, region: REGION }],
  });
  prod.global.directConnectGateways.push({
    id: 'dxgw-prod', name: 'prod-dxgw', tags: {},
    associations: [
      { associatedGatewayId: HUB_VGW, associatedGatewayType: 'virtualPrivateGateway', associatedGatewayOwnerAccount: HUB, associatedGatewayRegion: REGION },
      { associatedGatewayId: HUB_VGW_DETACHED, associatedGatewayType: 'virtualPrivateGateway', associatedGatewayOwnerAccount: HUB, associatedGatewayRegion: REGION },
      { associatedGatewayId: NEVER_VGW, associatedGatewayType: 'virtualPrivateGateway', associatedGatewayOwnerAccount: NEVER, associatedGatewayRegion: REGION },
    ],
  });
  prodRegion.customerGateways.push({ id: 'cgw-0prod00000000001', name: 'office', tags: {}, ipAddress: '198.51.100.7' });
  prodRegion.vpnConnections.push({
    id: 'vpn-0prod00000000001', name: 'office-vpn', tags: {}, transitGatewayId: HUB_VPN_TGW,
    customerGatewayId: 'cgw-0prod00000000001', tunnels: [],
  });
  prodRegion.dxVirtualInterfaces.push(
    { id: 'dxvif-attached', tags: {}, connectionId: 'dxcon-prod', virtualGatewayId: HUB_VGW, routeFilterPrefixes: [], bgpPeers: [] },
    { id: 'dxvif-detached', tags: {}, connectionId: 'dxcon-prod', virtualGatewayId: HUB_VGW_DETACHED, routeFilterPrefixes: [], bgpPeers: [] },
  );
  return estate;
}

/** The rich estate with only prod switched on: the hub is omitted, never-scanned stays unscanned. */
function prodOnly(): { index: AtlasIndex; graph: AtlasGraph } {
  const index = indexOf(richEstate());
  return { index, graph: buildOverview(withAccounts(index, new Set([SPOKE_PROD]))) };
}

const node = (graph: AtlasGraph, id: string): AtlasNode | undefined => graph.nodes.find((n) => n.id === id);
const edgeBetween = (graph: AtlasGraph, source: string, target: string): boolean =>
  graph.edges.some((e) => e.source === source && e.target === target);

test('6 · CloudFront origins in a switched-off account land in its ghost, not in the distribution\'s own lane', () => {
  // Show-all is the reference: the ALB origin edge reaches the hub's VPC and
  // the bucket sits in the hub's own Edge & global lane.
  const full = buildOverview(indexOf(richEstate()));
  assert.ok(edgeBetween(full, 'cf:E0PROD', `vpc:${HUB_VPC}`));
  assert.equal(node(full, `s3:${HUB_BUCKET}`)?.parentId, `glb:${HUB}`);

  const { graph } = prodOnly();
  // (2) Was: no edge at all — lbByDns only held the selected accounts.
  assert.ok(edgeBetween(graph, 'cf:E0PROD', `vpc:${HUB_VPC}`), 'expected the CloudFront → hub VPC origin edge');
  const vpc = node(graph, `vpc:${HUB_VPC}`);
  assert.equal(vpc?.parentId, `acct:${HUB}`);
  assert.equal(vpc?.data.label, 'hub-vpc');
  assert.equal(vpc?.data.subtitle, `${REGION} · not shown`);

  // (3) Was: the bucket drawn in prod's own `glb:111…` lane — misattributed.
  const bucket = node(graph, `s3:${HUB_BUCKET}`);
  assert.equal(bucket?.parentId, `acct:${HUB}`);
  assert.equal(bucket?.data.ghost, true);
  assert.equal(bucket?.data.subtitle, `${REGION} · not shown`);
  assert.ok(edgeBetween(graph, 'cf:E0PROD', `s3:${HUB_BUCKET}`));
});

test('7 · a private zone associated with a switched-off account\'s VPC ghosts that VPC under its real owner', () => {
  const { graph } = prodOnly();
  // Was: `ensureVpcNode` got the zone's account, so the hub's VPC was drawn
  // inside prod's own box labelled `not scanned`.
  const vpc = node(graph, `vpc:${HUB_VPC}`);
  assert.equal(vpc?.parentId, `acct:${HUB}`);
  assert.ok(edgeBetween(graph, `zone:${SPOKE_PROD}:Z0PROD`, `vpc:${HUB_VPC}`));
});

test('7a · the zone association alone puts the VPC under its owner', () => {
  // Without the CloudFront origin, the zone association is the first to ghost
  // the VPC, so its parent is decided by the zone path alone.
  const estate = richEstate();
  const prod = estate.accounts[0];
  assert.ok(prod);
  prod.global.cloudFrontDistributions = [];
  const index = indexOf(estate);
  const graph = buildOverview(withAccounts(index, new Set([SPOKE_PROD])));
  const vpc = node(graph, `vpc:${HUB_VPC}`);
  assert.equal(vpc?.parentId, `acct:${HUB}`);
  assert.equal(vpc?.data.subtitle, `${REGION} · not shown`);
});

test('8 · a VPN to a switched-off account\'s TGW puts that TGW in the owner\'s click-to-add ghost', () => {
  const { graph } = prodOnly();
  const tgw = node(graph, `tgw:${HUB_VPN_TGW}`);
  // Was: no owner passed, so the TGW floated at the top level with no box.
  assert.equal(tgw?.parentId, `acct:${HUB}`);
  assert.equal(tgw?.data.label, 'vpn-tgw');
  assert.ok(edgeBetween(graph, `tgw:${HUB_VPN_TGW}`, 'cgw:cgw-0prod00000000001'));
});

test('9 · DX associations and VIFs to a switched-off account\'s VPN gateways are drawn, not dropped', () => {
  const { graph } = prodOnly();
  // (12) An attached VGW resolves to its VPC, exactly as in show-all.
  assert.ok(edgeBetween(graph, 'dxgw:dxgw-prod', `vpc:${HUB_VPC}`), 'expected DX gateway → hub VPC');
  // A detached one is a ghost VGW that knows it was scanned.
  const spare = node(graph, `vgw:${HUB_VGW_DETACHED}`);
  assert.equal(spare?.parentId, `acct:${HUB}`);
  assert.equal(spare?.data.label, 'hub-spare-vgw');
  assert.equal(spare?.data.subtitle, `VPN gateway · ${REGION} · not shown`);
  assert.ok(edgeBetween(graph, 'dxgw:dxgw-prod', `vgw:${HUB_VGW_DETACHED}`));
  // (13) Was: the VIF silently drew nothing.
  assert.ok(edgeBetween(graph, 'dxconn:dxcon-prod', `vpc:${HUB_VPC}`), 'expected DX VIF → hub VPC');
  assert.ok(edgeBetween(graph, 'dxconn:dxcon-prod', `vgw:${HUB_VGW_DETACHED}`), 'expected DX VIF → spare VGW ghost');
  // The control: a VGW nobody scanned still says so, in a not-scanned ghost.
  const never = node(graph, `vgw:${NEVER_VGW}`);
  assert.equal(never?.parentId, `acct:${NEVER}`);
  assert.equal(never?.data.subtitle, `VPN gateway · ${REGION} · not scanned`);
  assert.equal(node(graph, `acct:${NEVER}`)?.data.addAccountId, undefined);
});

test('10 · a role in a switched-off account that trusts a drawn one is drawn into its ghost', () => {
  // The base estate: prod's `deploy` role trusts dev. Select dev alone — the
  // role is in a switched-off account, so only drawn roles being walked meant
  // dev showed no link to prod at all.
  const index = indexOf(miniatureEstate());
  const graph = buildOverview(withAccounts(index, new Set([SPOKE_DEV])));
  const ghost = node(graph, `acct:${SPOKE_PROD}`);
  assert.equal(ghost?.data.addAccountId, SPOKE_PROD);
  const edge = graph.edges.find((e) => e.source === `acct:${SPOKE_DEV}` && e.target === `acct:${SPOKE_PROD}`);
  assert.ok(edge, 'expected dev → prod ghost assume-role edge');
  assert.equal(edge.data?.edgeKind, 'trust');
  assert.match(edge.data?.title ?? '', /deploy/);

  // And the rich estate's hub role trusting prod, with prod selected.
  const { graph: rich } = prodOnly();
  assert.ok(edgeBetween(rich, `acct:${SPOKE_PROD}`, `acct:${HUB}`), 'expected prod → hub ghost assume-role edge');
});

test('11 · a RAM share owned by a switched-off account into a drawn one is drawn from its ghost', () => {
  const { graph } = prodOnly();
  const share = graph.edges.find((e) => e.data?.edgeKind === 'ram-share');
  assert.ok(share, 'expected the hub → prod RAM share edge');
  assert.equal(share.source, `acct:${HUB}`);
  assert.equal(share.target, `acct:${SPOKE_PROD}`);
  // The share's other principal is neither drawn nor switched off: no edge,
  // and no ghost conjured for it by this pass.
  assert.equal(graph.edges.filter((e) => e.data?.edgeKind === 'ram-share').length, 1);
});

test('12 · switched-off accounts with no link to the selection add no ghost', () => {
  // Dev alone in the rich estate: the hub's trust and share name prod, not
  // dev, so neither reverse pass may draw prod or the hub on their account.
  const index = indexOf(richEstate());
  const graph = buildOverview(withAccounts(index, new Set([SPOKE_DEV])));
  assert.ok(!graph.edges.some((e) => e.data?.edgeKind === 'ram-share'));
  assert.ok(!edgeBetween(graph, `acct:${SPOKE_PROD}`, `acct:${HUB}`));
  assert.ok(!edgeBetween(graph, `acct:${SPOKE_DEV}`, `acct:${HUB}`));
});
