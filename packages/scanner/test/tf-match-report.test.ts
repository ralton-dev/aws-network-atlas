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
  type TerraformResourceInstance,
  type TerraformStackFile,
} from '@atlas/schema';

import type { ResolvedConfig } from '../src/config.js';
import {
  formatMatchReport,
  matchReport,
  parseTerraformState,
  snapshotKeyIndex,
  tfImport,
  type StackMatchReport,
} from '../src/terraform.js';

const ACCOUNT = '111122223333';
const REGION = 'eu-west-1';
const SG = 'sg-0web0000000000000';

/**
 * Two attribute values planted in the state below, on resources that *are*
 * written to the sidecar, to give decision 6 a value-level assertion and not
 * only a key-level one.
 *
 * `aws_s3_object.content` is a real Terraform footgun — it is stored in state
 * verbatim — and the rule description is the ordinary case: an attribute of a
 * resource whose import id is composed from *other* attributes, so a projection
 * that widened by one field would carry it.
 */
const SECRET = 'BEGIN RSA PRIVATE KEY — must never reach data/terraform';
const RULE_DESCRIPTION = 'https from the build fleet';

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
        // Not part of any import id, and must not travel with the one that is.
        description: RULE_DESCRIPTION,
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
        // `aws_s3_object` stores `content` in state verbatim.
        content: SECRET,
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

function resources(): TerraformResourceInstance[] {
  return parseTerraformState(stateFile(), 'awkward.tfstate').resources;
}

function report(account: AccountSnapshot = snapshot()): StackMatchReport {
  return matchReport('awkward', resources(), snapshotKeyIndex([account]));
}

function addresses(list: ReadonlyArray<{ address: string }>): string[] {
  return list.map((r) => r.address).sort();
}

test('the match report separates stale state from types it cannot check', () => {
  const r = report();

  assert.equal(r.total, 12);

  // Stale: alarming, actionable, and nothing else is in here. `web_self` is a
  // false positive and a known limit, not an accident — see the test below.
  assert.deepEqual(addresses(r.stale), [
    'aws_ecs_cluster.green',
    'aws_s3_bucket.gone',
    'aws_security_group_rule.web_self',
  ]);

  // Not indexed: expected, needs no action, and must not drag the ratio down.
  // `RouteTable.routes` and `NetworkAcl.entries` are nested exactly as security
  // group rules are, and stay here until someone registers an expander for
  // them — at which point this file needs no edit at all.
  assert.deepEqual(addresses(r.notIndexed), ['aws_network_acl_rule.deny', 'aws_route.default']);

  // No rule at all — folding this into either of the above would be a claim
  // the registry cannot support.
  assert.deepEqual(addresses(r.unknownType), ['aws_s3_object.readme']);

  // The honest ratio: 6 of 9 checkable, with 3 counted beside it. The same
  // stack reported `matched 4/12` before this fix — see the commit body.
  assert.equal(r.matched, 6);
  assert.equal(r.checkable, 9);
  assert.equal(r.total - r.checkable, 3);
});

test('security group rules match the ids reconstructed from the scanned group', () => {
  const matched = new Set(
    resources()
      .filter((res) => snapshotKeyIndex([snapshot()]).keys.has(res.importId ?? ' '))
      .map((res) => res.address),
  );
  // Neither of these can match on `id`: the provider stores `sgrule-<hash>`,
  // which corresponds to nothing AWS ever returns.
  assert.deepEqual(
    [...matched].sort(),
    ['aws_security_group_rule.web_egress', 'aws_security_group_rule.web_ingress'],
  );
  assert.equal(
    resources().find((res) => res.address === 'aws_security_group_rule.web_ingress')?.importId,
    `${SG}_ingress_tcp_8000_8000_10.0.3.0/24`,
  );

  // The known limit. The configuration wrote `self = true`, so the state's
  // import id ends in `self`; AWS reports the group's own id and the expander
  // can only emit that, and no scan can tell the two spellings apart. It is
  // reported as stale — a false alarm we can see and explain, rather than one
  // hidden in a list of forty.
  const selfRule = resources().find((res) => res.address === 'aws_security_group_rule.web_self');
  assert.equal(selfRule?.importId, `${SG}_ingress_tcp_443_443_self`);
  assert.ok(snapshotKeyIndex([snapshot()]).keys.has(`${SG}_ingress_tcp_443_443_${SG}`));
});

test('an unmatched resource is stale when a sibling of its type matched', () => {
  assert.ok(addresses(report().stale).includes('aws_ecs_cluster.green'));

  // `aws_ecs_cluster` declares no kinds — the viewer never draws it — so the
  // registry alone says "not indexed". It is only checkable because the tagging
  // sweep put a sibling's ARN in the key set. Drop that one record and the
  // honest answer changes with it.
  const withoutSweep = snapshot();
  withoutSweep.regions[0]!.generic = [];
  const r = report(withoutSweep);
  assert.ok(addresses(r.notIndexed).includes('aws_ecs_cluster.blue'));
  assert.ok(addresses(r.notIndexed).includes('aws_ecs_cluster.green'));
  assert.deepEqual(addresses(r.stale), ['aws_s3_bucket.gone', 'aws_security_group_rule.web_self']);
  assert.equal(r.matched, 5);
  assert.equal(r.checkable, 7);
});

test('every registered expander can be fed from a snapshot', () => {
  // The gap this would catch: an expander added for a kind `NESTING_COLLECTIONS`
  // has no entry for silently stops contributing keys, and the resources it
  // covers go quietly back to being reported as unmatchable.
  assert.deepEqual(snapshotKeyIndex([snapshot()]).unreachableExpanders, []);
});

test('the console report names stale resources and only counts the rest', () => {
  const lines = formatMatchReport(report(), 1);
  const text = lines.join('\n');

  assert.match(text, /^matched 6\/9 checkable against 1 scanned account snapshot\(s\)$/m);
  assert.match(text, /3 of 12 are not checkable against a scan/);
  assert.match(text, /- aws_s3_bucket\.gone \(arn:aws:s3:::atlas-gone\)/);
  assert.match(text, /aws_route ×1/);
  assert.match(text, /aws_s3_object ×1/);
  // The lists that need no action are summarised by type: no addresses.
  assert.ok(!text.includes('aws_route.default'), 'not-indexed resources are counted, not listed');
});

/** The complete set of keys decision 6 permits in a written sidecar resource. */
const IDENTIFIER_KEYS = ['address', 'arn', 'id', 'importId', 'type'];

/** Every attribute name the state file above uses, at any depth. */
function stateAttributeKeys(): Set<string> {
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        keys.add(k);
        walk(v);
      }
    }
  };
  for (const res of stateFile()['resources'] as Array<Record<string, unknown>>) {
    for (const inst of (res['instances'] as Array<Record<string, unknown>>) ?? []) {
      walk(inst['attributes']);
    }
  }
  return keys;
}

/** Run the real command against the state above and read back what it wrote. */
async function writeSidecar(
  dir: string,
): Promise<{ readonly stack: TerraformStackFile; readonly text: string }> {
  const config = { rootDir: dir, outDir: 'data' } as ResolvedConfig;
  const state = path.join(dir, 'awkward.tfstate');
  await writeFile(state, JSON.stringify(stateFile()), 'utf8');
  const [result] = await tfImport(config, { files: [state], repo: 'org/infra', cwd: dir });
  assert.ok(result);
  const text = await readFile(result.file, 'utf8');
  return { stack: JSON.parse(text) as TerraformStackFile, text };
}

/**
 * Decision 6, after `importId` was allowed to travel.
 *
 * The guarantee has not been weakened, it has been re-stated at the level it
 * was always about: **no key that is not an identifier ever appears in a
 * written sidecar.** `importId` is an identifier — it is the string
 * `terraform import` takes — so it joins the four that were already there, and
 * every other key in the state is still forbidden. Two things enforce that here
 * and neither is a hand-kept list of banned names: the permitted set is closed
 * (anything outside `IDENTIFIER_KEYS` fails), and the forbidden set is derived
 * from the state file's own attribute names, so an attribute added to the
 * fixture is checked without anyone remembering to check it.
 */
test('tf-import writes only identifiers, and the sidecar shape is unchanged', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atlas-tf-'));
  try {
    const { stack: written, text } = await writeSidecar(dir);

    // Closed set: no key outside the identifiers, whatever it is called.
    for (const r of written.resources) {
      assert.deepEqual(
        Object.keys(r).sort().filter((k) => !IDENTIFIER_KEYS.includes(k)),
        [],
        `${r.address} carries a key that is not an identifier`,
      );
    }

    // And from the other direction: every attribute name the state uses, minus
    // the ones that are identifiers, must be absent from every resource.
    const forbidden = [...stateAttributeKeys()].filter((k) => !IDENTIFIER_KEYS.includes(k));
    assert.ok(forbidden.length >= 10, `the state fixture stopped exercising this: ${forbidden}`);
    for (const r of written.resources) {
      for (const key of forbidden) {
        assert.ok(!(key in r), `${r.address} carries the state attribute ${key}`);
      }
    }

    // Value level, which is what decision 6 is finally about. An import id
    // *composes* attribute values — a rule's ends in its CIDRs — but nothing
    // that is not itself an import id may travel, and these two never can.
    assert.ok(!text.includes(SECRET), 'an s3 object body reached the sidecar');
    assert.ok(!text.includes(RULE_DESCRIPTION), 'a rule description reached the sidecar');

    // Decision 14: the file's own structure is untouched.
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

/**
 * The inversion. `importId` used to be asserted *absent* from the written file;
 * a viewer reading the sidecar therefore saw `id: "sgrule-<hash>"` for a
 * security group rule — a provider-synthesised string corresponding to nothing
 * AWS returns — and could not tell a managed rule from an unmanaged one. It now
 * travels, and this pins both halves: the derived value reaches the file, and
 * it is the same string the in-memory match report used.
 */
test('the derived import id reaches the sidecar, unchanged from the one that matched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atlas-tf-'));
  try {
    const { stack: written } = await writeSidecar(dir);
    const byAddress = new Map(written.resources.map((r) => [r.address, r]));

    // The composite that no `id` could ever carry.
    assert.equal(
      byAddress.get('aws_security_group_rule.web_ingress')?.importId,
      `${SG}_ingress_tcp_8000_8000_10.0.3.0/24`,
    );
    assert.equal(byAddress.get('aws_security_group_rule.web_ingress')?.id, 'sgrule-1859128000');
    assert.equal(
      byAddress.get('aws_route.default')?.importId,
      'rtb-0aaa0000000000000_0.0.0.0/0',
    );

    // Absent where the import id *is* the state id, which is most types. That
    // is what keeps the file byte-identical for a stack of ordinary resources,
    // and why a reader must read absent as "cannot tell", never "unmanaged".
    for (const address of ['aws_vpc.main', 'aws_security_group.web', 'aws_s3_bucket.live']) {
      assert.equal(byAddress.get(address)?.importId, undefined, address);
    }
    // No rule at all: nothing to derive from, so nothing is written.
    assert.equal(byAddress.get('aws_s3_object.readme')?.importId, undefined);

    // The written value is the matched value — one derivation, not two.
    for (const parsed of resources()) {
      assert.equal(byAddress.get(parsed.address)?.importId, parsed.importId, parsed.address);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Backward compatibility, which is the whole reason the field is optional.
 *
 * A sidecar committed before this change simply has no `importId` anywhere. It
 * must still parse, still match everything it always matched, and — the part
 * that matters to a reader — must not be mistaken for a stack whose nested
 * resources are absent. Absent is "cannot tell".
 */
test('a sidecar written before importId existed still parses and still matches', () => {
  const oldFormat = JSON.parse(
    JSON.stringify({
      version: 1,
      stack: 'awkward',
      repo: 'org/infra',
      importedAt: '2026-07-01T00:00:00.000Z',
      resources: resources().map((r) => ({
        address: r.address,
        type: r.type,
        id: r.id,
        arn: r.arn,
      })),
    }),
  ) as TerraformStackFile;

  for (const r of oldFormat.resources) assert.equal(r.importId, undefined);

  // Everything that matched on id/arn still does; only the two rules that
  // needed the derived key are lost, exactly as before the fix.
  const index = snapshotKeyIndex([snapshot()]);
  const old = matchReport('awkward', oldFormat.resources, index);
  assert.equal(old.matched, 4);
  assert.equal(matchReport('awkward', resources(), index).matched, 6);
});
