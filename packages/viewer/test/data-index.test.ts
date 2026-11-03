/**
 * Decision 57 of PROPOSAL-OVERLAY.md, pinned: `buildIndex(snapshot?,
 * annotations?, terraform?)` takes what it used to read from `window` as
 * optional parameters, each defaulting to the global it reads today, so the
 * viewer can index a *proposed* snapshot (`model/proposal.ts`) beside the
 * scanned one. `data.ts` is otherwise frozen; this file is what proves the
 * argument-less call — every call the app makes — did not move.
 *
 * Three checks over one miniature estate:
 *
 *   1. `buildIndex()` reading the globals deep-equals `buildIndex(snapshot,
 *      annotations, terraform)` called with `window` emptied, so the result
 *      can only have come from the arguments;
 *   2. both deep-equal the index the parent commit (`18fb7ef`, before decision
 *      57) built for the same estate, recorded below as literals: for this
 *      miniature that commit built **`all.length` 6** and **`byKey.size` 9**;
 *   3. omitting one argument falls back to that one global only.
 *
 * An `AtlasIndex` carries closures (`accountLabel`, `annotationFor`,
 * `terraformFor`, `findRegion`), which no deep-equal can compare, so the
 * index is projected first: its data members verbatim, `byKey` as entries,
 * and each closure as the table of its answers over every ref and account.
 *
 * `buildIndex` fills missing collections into the snapshot it is given, so
 * every call indexes its own `structuredClone`.
 *
 * Shapes it avoids: shared (RAM / TGW) copies across accounts, where `byKey`
 * prefers the owner's copy; `generic` resources; and any global collection
 * besides IAM roles and hosted zones.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  emptyGlobal,
  emptyRegionSnapshot,
  type AccountSnapshot,
  type AnnotationMap,
  type Snapshot,
  type TerraformStackFile,
} from '@atlas/schema';
import { buildIndex, type AtlasIndex } from '../src/data.js';

const PROD = '111111111111';
const HUB = '222222222222';
const REGION = 'eu-west-1';
const GENERATED_AT = '2026-11-03T00:00:00Z';

function account(accountId: string, alias: string | undefined): AccountSnapshot {
  return {
    accountId,
    ...(alias !== undefined ? { alias } : {}),
    profile: alias ?? accountId,
    scannedAt: GENERATED_AT,
    scannerVersion: 'test',
    regions: [emptyRegionSnapshot(REGION)],
    emptyRegions: [],
    global: emptyGlobal(),
  };
}

function miniature(): Snapshot {
  const prod = account(PROD, 'acme-prod');
  const r = prod.regions[0]!;
  r.vpcs.push({ id: 'vpc-0prod0000000001', name: 'prod-vpc', tags: {}, cidrBlocks: ['10.0.0.0/16'], ipv6CidrBlocks: [], isDefault: false });
  r.subnets.push({
    id: 'subnet-0prod00000001',
    arn: `arn:aws:ec2:${REGION}:${PROD}:subnet/subnet-0prod00000001`,
    name: 'prod-a',
    tags: {},
    vpcId: 'vpc-0prod0000000001',
    cidrBlock: '10.0.1.0/24',
    availabilityZone: `${REGION}a`,
  } as never);
  r.lambdaFunctions.push({
    id: 'prod-fn',
    arn: `arn:aws:lambda:${REGION}:${PROD}:function:prod-fn`,
    name: 'prod-fn',
    tags: {},
    vpcConfig: { vpcId: 'vpc-0prod0000000001', subnetIds: [], securityGroupIds: [] },
  } as never);
  prod.global.iamRoles.push({ id: 'AROAPROD', arn: `arn:aws:iam::${PROD}:role/deploy`, name: 'deploy', tags: {} } as never);

  // An account with no alias whose region predates a collection: the
  // normalisation pass in `buildIndex` must fill it back in.
  const hub = account(HUB, undefined);
  const h = hub.regions[0]!;
  h.transitGateways.push({ id: 'tgw-0hub000000000001', name: 'core-tgw', tags: {}, ownerId: HUB });
  delete (h as Partial<typeof h>).natGateways;
  hub.global.hostedZones.push({ id: 'Z0HUB', zoneName: 'acme.internal.', tags: {} } as never);

  return { version: 1, generatedAt: GENERATED_AT, accounts: [prod, hub] };
}

const annotations: AnnotationMap = {
  'vpc-0prod0000000001': { title: 'Production' },
  [`arn:aws:iam::${PROD}:role/deploy`]: { description: 'CI deploy role' },
};

const terraform: TerraformStackFile[] = [
  {
    version: 1,
    stack: 'prod-network',
    repo: 'acme/network',
    importedAt: GENERATED_AT,
    resources: [
      { address: 'aws_vpc.main', type: 'aws_vpc', id: 'vpc-0prod0000000001' },
      { address: 'aws_subnet.a', type: 'aws_subnet', arn: `arn:aws:ec2:${REGION}:${PROD}:subnet/subnet-0prod00000001` },
    ],
  } as TerraformStackFile,
];

type Globals = Pick<Window, '__ATLAS_DATA__' | '__ATLAS_ANNOTATIONS__' | '__ATLAS_TERRAFORM__'>;

function setWindow(globals: Partial<Globals>): void {
  (globalThis as { window?: Partial<Window> }).window = globals;
}

/** Every member of the index, with each closure replaced by its answers. */
function project(index: AtlasIndex): unknown {
  const accountIds = [...index.snapshot.accounts.map((a) => a.accountId), '999999999999'];
  return {
    snapshot: index.snapshot,
    annotations: index.annotations,
    terraform: index.terraform,
    all: index.all,
    byKey: [...index.byKey].map(([key, ref]) => [key, index.all.indexOf(ref)]),
    accountLabel: accountIds.map((id) => index.accountLabel(id)),
    annotationFor: index.all.map((ref) => index.annotationFor(ref) ?? null),
    terraformFor: index.all.map((ref) => index.terraformFor(ref)),
    findRegion: accountIds.map((id) => index.findRegion(id, REGION)?.region ?? null),
  };
}

test('buildIndex() reading the globals equals buildIndex(snapshot, annotations, terraform) with window empty', () => {
  setWindow({ __ATLAS_DATA__: miniature(), __ATLAS_ANNOTATIONS__: annotations, __ATLAS_TERRAFORM__: terraform });
  const fromGlobals = project(buildIndex());

  setWindow({});
  const fromArgs = project(buildIndex(miniature(), annotations, terraform));

  assert.deepStrictEqual(fromArgs, fromGlobals);
});

test('buildIndex() builds exactly what the parent commit built for the miniature', () => {
  setWindow({ __ATLAS_DATA__: miniature(), __ATLAS_ANNOTATIONS__: annotations, __ATLAS_TERRAFORM__: terraform });
  const index = buildIndex();
  setWindow({});
  const explicit = buildIndex(miniature(), annotations, terraform);

  // Recorded by running the argument-less call at `18fb7ef`, where
  // `buildIndex` took no arguments (6 refs: 6 ids + 3 arns = 9 keys).
  const parent = {
    allLength: 6,
    byKeySize: 9,
    refs: [
      'vpc:vpc-0prod0000000001:111111111111:eu-west-1:vpc-0prod0000000001',
      'subnet:subnet-0prod00000001:111111111111:eu-west-1:vpc-0prod0000000001',
      'lambda:prod-fn:111111111111:eu-west-1:vpc-0prod0000000001',
      'iam-role:AROAPROD:111111111111::',
      'tgw:tgw-0hub000000000001:222222222222:eu-west-1:',
      'zone:Z0HUB:222222222222::',
    ],
    accountLabel: ['acme-prod (111111111111)', '222222222222', '999999999999'],
    annotated: ['vpc-0prod0000000001=Production', 'AROAPROD=CI deploy role'],
    terraformed: ['vpc-0prod0000000001=prod-network:aws_vpc.main', 'subnet-0prod00000001=prod-network:aws_subnet.a'],
    natGatewaysFilled: true,
  };

  for (const built of [index, explicit]) {
    assert.deepStrictEqual(
      {
        allLength: built.all.length,
        byKeySize: built.byKey.size,
        refs: built.all.map((r) => `${r.kind}:${r.id}:${r.accountId}:${r.region}:${r.vpcId ?? ''}`),
        accountLabel: [PROD, HUB, '999999999999'].map((id) => built.accountLabel(id)),
        annotated: built.all.flatMap((r) => {
          const a = built.annotationFor(r);
          return a ? [`${r.id}=${a.title ?? a.description}`] : [];
        }),
        terraformed: built.all.flatMap((r) => built.terraformFor(r).map((b) => `${r.id}=${b.stack}:${b.address}`)),
        natGatewaysFilled: Array.isArray(built.findRegion(HUB, REGION)?.natGateways),
      },
      parent,
    );
  }
});

test('an omitted argument falls back to its own global and no other', () => {
  setWindow({ __ATLAS_DATA__: miniature(), __ATLAS_ANNOTATIONS__: annotations, __ATLAS_TERRAFORM__: terraform });
  const expected = project(buildIndex());

  setWindow({ __ATLAS_ANNOTATIONS__: annotations, __ATLAS_TERRAFORM__: terraform });
  assert.deepStrictEqual(project(buildIndex(miniature())), expected);

  setWindow({ __ATLAS_DATA__: miniature(), __ATLAS_TERRAFORM__: terraform });
  assert.deepStrictEqual(project(buildIndex(undefined, annotations)), expected);

  // Nothing anywhere: the empty index the viewer has always opened on.
  setWindow({});
  const empty = buildIndex();
  assert.equal(empty.all.length, 0);
  assert.deepStrictEqual(empty.snapshot, { version: 1, generatedAt: '', accounts: [] });
  assert.deepStrictEqual(empty.terraform, []);
});
