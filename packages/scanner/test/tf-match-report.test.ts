/**
 * The `tf-import` match report, against a state file built to be awkward.
 *
 * The dev fixture's stacks are tidy and the defect lives exactly where they are
 * not: nested resources that are not nodes, a Tier-B type the generic ARN sweep
 * happens to index, a type with no rule at all, and a security group rule whose
 * source the scan cannot express the way the configuration wrote it. Every one
 * of those is in the state below, and each is asserted for the *reason* it
 * lands where it does, not just the count.
 *
 * The state's `id` attributes are the real ones — `sgrule-<hash>` for a
 * security group rule, `r-<rtb><hash>` for a route — which is the whole reason
 * the match report needed a second key. See `awkward.tfstate.json`'s header in
 * `tf-import-blocks/test/fixtures`, which documents the same trap for the
 * import-block path.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  emptyGlobal,
  emptyRegionSnapshot,
  type AccountSnapshot,
  type TerraformStackFile,
} from '@atlas/schema';

import type { ResolvedConfig } from '../src/config.js';
import {
  collectSnapshotKeys,
  formatMatchReport,
  matchReport,
  parseTerraformState,
  tfImport,
} from '../src/terraform.js';

const ACCOUNT = '111122223333';
const REGION = 'eu-west-1';
const SG = 'sg-0web0000000000000';

/**
 * One account, one region. Carries a security group whose rules are nested
 * inside it (so they are not nodes and have no key of their own), and two
 * `generic` records — the Resource Groups Tagging sweep, which indexes types no
 * collector draws and is why "the rule declares no kinds" cannot mean "the
 * scanner never indexes it".
 */
function snapshot(): AccountSnapshot {
  const region = emptyRegionSnapshot(REGION);
  region.vpcs.push({
    id: 'vpc-0aaa0000000000000',
    arn: `arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/vpc-0aaa0000000000000`,
    name: 'main',
    tags: {},
    cidrBlocks: ['10.0.0.0/16'],
    ipv6CidrBlocks: [],
    isDefault: false,
    state: 'available',
  });
  region.securityGroups.push({
    id: SG,
    name: 'web',
    tags: {},
    vpcId: 'vpc-0aaa0000000000000',
    description: 'web tier',
    ingress: [
      {
        protocol: 'tcp',
        fromPort: 8000,
        toPort: 8000,
        cidrs: ['10.0.3.0/24'],
        ipv6Cidrs: [],
        prefixListIds: [],
        securityGroupRefs: [],
      },
      // Self-referencing: AWS reports the group's own id as a UserIdGroupPair,
      // and a scan cannot tell whether the configuration wrote `self = true` or
      // `source_security_group_id = <own id>`. The state below writes `self`.
      {
        protocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        cidrs: [],
        ipv6Cidrs: [],
        prefixListIds: [],
        securityGroupRefs: [{ groupId: SG, accountId: ACCOUNT }],
      },
    ],
    egress: [
      {
        protocol: '-1',
        cidrs: ['0.0.0.0/0'],
        ipv6Cidrs: [],
        prefixListIds: [],
        securityGroupRefs: [],
      },
    ],
  });
  region.generic.push({
    arn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/dev-blue`,
    service: 'ecs',
    resourceType: 'cluster',
    name: 'dev-blue',
    tags: {},
    source: 'tagging',
  });

  const global = emptyGlobal();
  global.s3Buckets.push({ id: 'atlas-live', name: 'atlas-live', tags: {}, region: REGION });

  return {
    accountId: ACCOUNT,
    profile: 'test',
    scannedAt: '2026-08-08T00:00:00.000Z',
    scannerVersion: '0.1.0',
    regions: [region],
    emptyRegions: [],
    global,
  };
}

/**
 * Raw state v4. Every `id` is the string the provider really stores, which for
 * three of these is not the import id and for two is not an AWS identifier at
 * all.
 */
function stateFile(): Record<string, unknown> {
  const managed = (
    type: string,
    name: string,
    attributes: Record<string, unknown>,
  ): Record<string, unknown> => ({
    mode: 'managed',
    type,
    name,
    provider: 'provider["registry.terraform.io/hashicorp/aws"]',
    instances: [{ schema_version: 1, attributes }],
  });
  return {
    version: 4,
    terraform_version: '1.9.8',
    serial: 7,
    lineage: '0f6d1b1a-1111-2222-3333-444455556666',
    outputs: {},
    resources: [
      // --- match on id/arn, as they always did ------------------------------
      managed('aws_vpc', 'main', {
        id: 'vpc-0aaa0000000000000',
        arn: `arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/vpc-0aaa0000000000000`,
      }),
      managed('aws_security_group', 'web', { id: SG }),
      managed('aws_s3_bucket', 'live', {
        id: 'atlas-live',
        arn: 'arn:aws:s3:::atlas-live',
      }),
      // A type with no `kinds` that the generic ARN sweep indexes anyway.
      managed('aws_ecs_cluster', 'blue', {
        id: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/dev-blue`,
        arn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/dev-blue`,
      }),

      // --- genuinely stale: drawn type, scanned region, simply not there ----
      managed('aws_s3_bucket', 'gone', {
        id: 'atlas-gone',
        arn: 'arn:aws:s3:::atlas-gone',
      }),
      // Stale, and only provable by a sibling: `aws_ecs_cluster` declares no
      // kinds, so the registry alone would file this under "not indexed".
      managed('aws_ecs_cluster', 'green', {
        id: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/dev-green`,
        arn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/dev-green`,
      }),

      // --- nested in the snapshot, first-class in terraform -----------------
      managed('aws_security_group_rule', 'web_ingress', {
        id: 'sgrule-1859128000',
        security_group_id: SG,
        type: 'ingress',
        protocol: 'tcp',
        from_port: 8000,
        to_port: 8000,
        cidr_blocks: ['10.0.3.0/24'],
      }),
      managed('aws_security_group_rule', 'web_egress', {
        id: 'sgrule-2039127001',
        security_group_id: SG,
        type: 'egress',
        protocol: '-1',
        from_port: 0,
        to_port: 0,
        cidr_blocks: ['0.0.0.0/0'],
      }),
      // The one the expansion cannot reach: the configuration wrote `self`,
      // AWS reports the group id, and no scan can tell the two apart.
      managed('aws_security_group_rule', 'web_self', {
        id: 'sgrule-1122334455',
        security_group_id: SG,
        type: 'ingress',
        protocol: 'tcp',
        from_port: 443,
        to_port: 443,
        self: true,
      }),
      // Nested with no expander at all: `RouteTable.routes` is still invisible.
      managed('aws_route', 'default', {
        id: 'r-rtb-0aaa00000000000001080289494',
        route_table_id: 'rtb-0aaa0000000000000',
        destination_cidr_block: '0.0.0.0/0',
      }),
      managed('aws_network_acl_rule', 'deny', {
        id: 'nacl-1234567890',
        network_acl_id: 'acl-0aaa0000000000000',
        rule_number: 100,
        egress: false,
        protocol: '-1',
      }),

      // --- the registry knows nothing about this type -----------------------
      managed('aws_s3_object', 'readme', {
        id: 'atlas-live/README.md',
        bucket: 'atlas-live',
        key: 'README.md',
      }),

      // Ignored by the parser and so absent from every count below.
      {
        mode: 'data',
        type: 'aws_caller_identity',
        name: 'current',
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [{ attributes: { id: ACCOUNT } }],
      },
    ],
  };
}

function stack(): TerraformStackFile {
  const parsed = parseTerraformState(stateFile(), 'awkward.tfstate');
  return {
    version: 1,
    stack: 'awkward',
    repo: 'org/infra',
    importedAt: '2026-08-08T00:00:00.000Z',
    resources: parsed.resources,
  };
}

function addresses(resources: ReadonlyArray<{ address: string }>): string[] {
  return resources.map((r) => r.address).sort();
}

test('the match report separates stale state from types it cannot check', () => {
  const report = matchReport(stack(), collectSnapshotKeys([snapshot()]));

  assert.equal(report.total, 12);

  // Stale: alarming, actionable, and nothing else is in here.
  assert.deepEqual(addresses(report.stale), ['aws_ecs_cluster.green', 'aws_s3_bucket.gone']);

  // Not indexed: expected, needs no action, and must not drag the ratio down.
  // Security group rules are here because nothing in the scan can produce their
  // composite id yet — matching them is the second half of this fix.
  assert.deepEqual(addresses(report.notIndexed), [
    'aws_network_acl_rule.deny',
    'aws_route.default',
    'aws_security_group_rule.web_egress',
    'aws_security_group_rule.web_ingress',
    'aws_security_group_rule.web_self',
  ]);

  // No rule at all — folding this into either of the above would be a claim
  // the registry cannot support.
  assert.deepEqual(addresses(report.unknownType), ['aws_s3_object.readme']);

  // The honest ratio: 4 of 6 checkable, with 6 counted beside it. The old
  // headline for this stack was 4/12, which reads as two thirds of it drifting.
  assert.equal(report.matched, 4);
  assert.equal(report.checkable, 6);
  assert.equal(report.total - report.checkable, 6);
});

test('an unmatched resource is stale when a sibling of its type matched', () => {
  const full = matchReport(stack(), collectSnapshotKeys([snapshot()]));
  assert.ok(addresses(full.stale).includes('aws_ecs_cluster.green'));

  // `aws_ecs_cluster` declares no kinds — the viewer never draws it — so the
  // registry alone says "not indexed". It is only checkable because the tagging
  // sweep put a sibling's ARN in the key set. Drop that one record and the
  // honest answer changes with it.
  const withoutSweep = snapshot();
  withoutSweep.regions[0]!.generic = [];
  const report = matchReport(stack(), collectSnapshotKeys([withoutSweep]));
  assert.ok(addresses(report.notIndexed).includes('aws_ecs_cluster.blue'));
  assert.ok(addresses(report.notIndexed).includes('aws_ecs_cluster.green'));
  assert.deepEqual(addresses(report.stale), ['aws_s3_bucket.gone']);
  assert.equal(report.matched, 3);
  assert.equal(report.checkable, 4);
});

test('the console report names stale resources and only counts the rest', () => {
  const lines = formatMatchReport(matchReport(stack(), collectSnapshotKeys([snapshot()])), 1);
  const text = lines.join('\n');

  assert.match(text, /^matched 4\/6 checkable against 1 scanned account snapshot\(s\)$/m);
  assert.match(text, /6 of 12 are not checkable against a scan/);
  assert.match(text, /- aws_s3_bucket\.gone \(arn:aws:s3:::atlas-gone\)/);
  assert.match(text, /aws_route ×1/);
  assert.match(text, /aws_s3_object ×1/);
  // The lists that need no action are summarised by type: no addresses.
  assert.ok(!text.includes('aws_route.default'), 'not-indexed resources are counted, not listed');
});

test('tf-import writes only identifiers, and the sidecar shape is unchanged', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atlas-tf-'));
  try {
    const config = { rootDir: dir, outDir: 'data' } as ResolvedConfig;
    const state = path.join(dir, 'awkward.tfstate');
    await writeFile(state, JSON.stringify(stateFile()), 'utf8');

    const [result] = await tfImport(config, {
      files: [state],
      repo: 'org/infra',
      cwd: dir,
    });
    assert.ok(result);
    const written = JSON.parse(await readFile(result.file, 'utf8')) as TerraformStackFile;

    // Decision 14: `data/terraform/<stack>.json` keeps its exact structure, and
    // decision 6 bounds it to identifiers. A resource carrying anything else —
    // a computed import id, an attribute — would fail here.
    for (const r of written.resources) {
      assert.deepEqual(
        Object.keys(r).sort().filter((k) => !['address', 'arn', 'id', 'type'].includes(k)),
        [],
        `${r.address} carries a key that is not an identifier`,
      );
    }
    assert.deepEqual(Object.keys(written).sort(), [
      'importedAt',
      'lineage',
      'repo',
      'resources',
      'serial',
      'source',
      'stack',
      'terraformVersion',
      'version',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
