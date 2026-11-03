/**
 * The miniature estate the `@atlas/proposal` tests share, built from the
 * schema's own factories as `tf-match-report.test.ts` does. (Not a
 * `*.test.ts`, so the root `find` does not run it as a test file.)
 *
 * The hub-and-spoke of the viewer's `selection.test.ts`, made awkward in the
 * ways a real scan is and a tidy fixture is not:
 *
 *   - the hub's TGW appears **twice** — in the hub's snapshot and as a shared
 *     copy in prod's — so one id lives at two locations;
 *   - prod peers with an **unscanned** account `999…` (a peering side whose
 *     `vpcId` can never resolve);
 *   - prod has a `generic` resource keyed by ARN only, and an IAM role whose
 *     `id` is a bare name with an `arn` beside it;
 *   - dev's region comes from an **older scanner**: `instanceConnectEndpoints`
 *     is missing entirely, not empty;
 *   - accounts are deliberately not in id order.
 */
import { emptyGlobal, emptyRegionSnapshot, type AccountSnapshot, type Snapshot } from '@atlas/schema';

import type { Proposal } from '../src/index.js';

export const PROD = '111111111111';
export const HUB = '222222222222';
export const DEV = '333333333333';
export const NEW = '555555555555';
export const STRANGER = '999999999999';
export const REGION = 'eu-west-1';
export const TGW = 'tgw-0a1b2c3d4e5f00001';
export const GENERATED_AT = '2026-11-03T00:00:00.000Z';
export const GENERIC_ARN = `arn:aws:dynamodb:${REGION}:${PROD}:table/orders`;
export const ROLE_ARN = `arn:aws:iam::${PROD}:role/deploy`;

function account(accountId: string, alias: string): AccountSnapshot {
  return {
    accountId,
    alias,
    profile: alias,
    scannedAt: GENERATED_AT,
    scannerVersion: 'test',
    regions: [emptyRegionSnapshot(REGION)],
    emptyRegions: ['us-east-1'],
    global: emptyGlobal(),
  };
}

const region = (a: AccountSnapshot) => {
  const r = a.regions[0];
  if (!r) throw new Error('no region');
  return r;
};

export function estate(): Snapshot {
  const prod = account(PROD, 'acme-prod');
  const p = region(prod);
  p.vpcs.push({ id: 'vpc-0prod0000000001', name: 'prod-vpc', tags: { env: 'prod' }, cidrBlocks: ['10.0.0.0/16'], ipv6CidrBlocks: [], isDefault: false });
  p.transitGateways.push({ id: TGW, name: 'core-tgw', tags: {}, ownerId: HUB });
  p.transitGatewayAttachments.push({
    id: 'tgw-attach-0prod000000001', tags: {}, transitGatewayId: TGW, transitGatewayOwnerId: HUB,
    resourceOwnerId: PROD, resourceType: 'vpc', resourceId: 'vpc-0prod0000000001', subnetIds: [],
  });
  p.peeringConnections.push({
    id: 'pcx-0prod0stranger0001', tags: {}, status: 'active',
    requester: { vpcId: 'vpc-0prod0000000001', accountId: PROD, region: REGION, cidrBlocks: ['10.0.0.0/16'] },
    accepter: { vpcId: 'vpc-0stranger00000001', accountId: STRANGER, region: REGION, cidrBlocks: ['10.50.0.0/16'] },
  });
  p.generic.push({ arn: GENERIC_ARN, service: 'dynamodb', resourceType: 'table', name: 'orders', tags: {}, source: 'tagging' });
  prod.global.iamRoles.push({
    id: 'deploy', name: 'deploy', arn: ROLE_ARN, tags: {}, attachedManagedPolicyArns: [], inlinePolicyNames: [], assumeRolePolicyDocument: '{}',
  });

  const hub = account(HUB, 'acme-shared');
  const h = region(hub);
  h.transitGateways.push({ id: TGW, name: 'core-tgw', tags: {}, ownerId: HUB });
  h.vpcs.push({ id: 'vpc-0hub00000000001', name: 'hub-vpc', tags: {}, cidrBlocks: ['10.9.0.0/16'], ipv6CidrBlocks: [], isDefault: false });

  const dev = account(DEV, 'acme-dev');
  const d = region(dev);
  d.vpcs.push({ id: 'vpc-0dev00000000001', name: 'dev-vpc', tags: {}, cidrBlocks: ['10.1.0.0/16'], ipv6CidrBlocks: [], isDefault: false });
  d.transitGatewayAttachments.push({
    id: 'tgw-attach-0dev0000000001', tags: {}, transitGatewayId: TGW, transitGatewayOwnerId: HUB,
    resourceOwnerId: DEV, resourceType: 'vpc', resourceId: 'vpc-0dev00000000001', subnetIds: [],
  });
  delete (d as unknown as Record<string, unknown>)['instanceConnectEndpoints'];

  return { version: 1, generatedAt: GENERATED_AT, accounts: [prod, hub, dev] };
}

/** The pin's proposal: a new spoke with one VPC attached to the hub's TGW. */
export function newSpoke(): Proposal {
  return {
    id: 'new-spoke',
    version: 1,
    title: 'Add a data-platform spoke joined to the core TGW',
    base: { generatedAt: GENERATED_AT },
    accounts: [{ accountId: NEW, alias: 'acme-data', regions: [REGION] }],
    changes: [
      {
        op: 'add', account: NEW, region: REGION, collection: 'vpcs',
        resource: { id: 'proposed-vpc-data', name: 'data-vpc', tags: {}, cidrBlocks: ['10.3.0.0/16'], ipv6CidrBlocks: [], isDefault: false },
      },
      {
        op: 'add', account: NEW, region: REGION, collection: 'transitGatewayAttachments',
        resource: {
          id: 'proposed-attach-data', tags: {}, transitGatewayId: TGW, transitGatewayOwnerId: HUB,
          resourceOwnerId: NEW, resourceType: 'vpc', resourceId: 'proposed-vpc-data', subnetIds: [],
        },
      },
    ],
  };
}

/** A proposal over the estate with only `changes` (no new accounts). */
export function only(...changes: Proposal['changes']): Proposal {
  return { id: 'test', version: 1, title: 'test', base: { generatedAt: GENERATED_AT }, changes };
}
