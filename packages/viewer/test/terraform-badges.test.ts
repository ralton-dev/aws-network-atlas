/**
 * `applyTerraformBadges` has three answers, not two (PROPOSAL-OVERLAY.md,
 * decision 45): a scanned resource a stack claims is managed (`true`), a
 * scanned one no stack claims is unmanaged (`false`), and a resource the
 * active proposal plans does not exist yet, so it is neither and stays
 * `undefined`. Stamping it `false` counted it under "Unmanaged", kept it under
 * "Unmanaged only", and put it in reach of the bulk import block — an import
 * of a resource AWS has never heard of.
 *
 * The planned VPC is indexed like any other because that is what the proposed
 * index does: the proposed snapshot holds it, so `byKey` finds it and
 * `terraformFor` finds no stack — the exact path that used to answer `false`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyGlobal, emptyRegionSnapshot, type Snapshot, type TerraformStackFile } from '@atlas/schema';
import { buildIndex } from '../src/data.js';
import type { AtlasGraph, AtlasNode } from '../src/model/graph-types.js';
import { applyTerraformBadges } from '../src/model/terraform.js';

const ACCOUNT = '111111111111';
const REGION = 'eu-west-1';
const MANAGED = 'vpc-0managed0000001';
const UNMANAGED = 'vpc-0unmanaged00001';
const PLANNED = 'proposed-vpc-data';

function snapshot(): Snapshot {
  const region = emptyRegionSnapshot(REGION);
  for (const id of [MANAGED, UNMANAGED, PLANNED]) {
    region.vpcs.push({ id, name: id, tags: {}, cidrBlocks: ['10.0.0.0/16'], ipv6CidrBlocks: [], isDefault: false });
  }
  return {
    version: 1,
    generatedAt: '2026-11-03T00:00:00Z',
    accounts: [
      {
        accountId: ACCOUNT,
        alias: 'acme-prod',
        profile: 'acme-prod',
        scannedAt: '2026-11-03T00:00:00Z',
        scannerVersion: 'test',
        regions: [region],
        emptyRegions: [],
        global: emptyGlobal(),
      },
    ],
  };
}

const stack: TerraformStackFile = {
  version: 1,
  stack: 'prod-network',
  repo: 'github.com/acme/infra-network',
  importedAt: '2026-11-03T00:00:00Z',
  resources: [{ address: 'aws_vpc.managed', type: 'aws_vpc', id: MANAGED }],
};

const node = (refId: string): AtlasNode => ({ id: `vpc:${refId}`, position: { x: 0, y: 0 }, data: { label: refId, kind: 'vpc', refId } });

test('a planned resource is neither managed nor unmanaged: tfManaged stays undefined', () => {
  const index = buildIndex(snapshot(), {}, [stack]);
  const graph: AtlasGraph = { nodes: [node(MANAGED), node(UNMANAGED), node(PLANNED)], edges: [] };
  applyTerraformBadges(graph, index);
  const stampOf = (refId: string): boolean | undefined => graph.nodes.find((n) => n.data.refId === refId)?.data.tfManaged;
  assert.equal(stampOf(MANAGED), true);
  assert.equal(stampOf(UNMANAGED), false);
  assert.equal(stampOf(PLANNED), undefined);
});
