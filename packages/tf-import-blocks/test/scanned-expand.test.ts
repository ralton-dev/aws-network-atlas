/**
 * The expansion mechanism, pinned: a scanned resource that *contains* other
 * terraform resources expands into them, and the first user of that mechanism
 * — security group rules — produces ids the provider accepts.
 *
 * The defect this closes: selecting an unmanaged security group offered an
 * `aws_security_group` block and nothing else, so pasting it adopted a group
 * whose rules Terraform does not manage — a half-adoption that looks complete.
 * The count assertion at the top of this file is the whole story: one block
 * before, three after.
 *
 * Every id format below was read off
 * `website/docs/r/security_group_rule.html.markdown` and the provider source
 * `internal/service/ec2/vpc_security_group_rule.go` in
 * `hashicorp/terraform-provider-aws` on `main` (2026-08-08). The doc page leads
 * with the `identity = { … }` form that decision 3 forbids; every value here
 * came from the `id = "…"` blocks below it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RULES,
  emitBlocks,
  importsFromState,
  resolveScanned,
  resolveScannedExpanded,
  resolveScannedManyExpanded,
  ruleForKind,
  ruleForType,
  type ScannedSubject,
} from '../src/index.js';

const subject = (
  id: string,
  raw: Record<string, unknown>,
  over: Partial<ScannedSubject> = {},
): ScannedSubject => ({
  kind: 'sg',
  id,
  region: 'eu-west-1',
  accountId: '111122223333',
  name: 'web',
  raw: { id, ...raw },
  ...over,
});

/** One `SecurityGroupRule` as `packages/schema/src/snapshot.ts` declares it. */
const perm = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: 'tcp',
  fromPort: 443,
  toPort: 443,
  cidrs: [],
  ipv6Cidrs: [],
  prefixListIds: [],
  securityGroupRefs: [],
  ...over,
});

// ── the defect, counted ────────────────────────────────────────────────────

/**
 * The before/after the user reported. `resolveScanned` is deliberately
 * unchanged — it still answers one block, and the golden test's scanned cases
 * depend on that — so the count moves only through the expanding entry point.
 */
test('a scanned security group with rules: one block unexpanded, three expanded', () => {
  const sg = subject('sg-0web', {
    ingress: [perm({ cidrs: ['10.0.0.0/8'] }), perm({ securityGroupRefs: [{ groupId: 'sg-0alb' }] })],
    egress: [perm({ protocol: '-1', fromPort: undefined, toPort: undefined, cidrs: ['0.0.0.0/0'] })],
  });

  // Before: the panel had one block to offer and the rules were invisible.
  const flat = resolveScanned(sg);
  assert.equal(flat.type, 'aws_security_group');
  assert.equal(flat.id, 'sg-0web');

  const { parent, children } = resolveScannedExpanded(sg);
  assert.equal(parent.type, 'aws_security_group');
  assert.equal(parent.id, 'sg-0web');
  assert.equal(children.length, 3);
  assert.deepEqual(
    children.map((c) => c.id),
    [
      'sg-0web_ingress_tcp_443_443_10.0.0.0/8',
      'sg-0web_ingress_tcp_443_443_sg-0alb',
      'sg-0web_egress_-1_0_0_0.0.0.0/0',
    ],
  );
  for (const child of children) assert.equal(child.type, 'aws_security_group_rule');
});

test('the parent block says its rules are separate resources', () => {
  const sg = subject('sg-0web', { ingress: [perm({ cidrs: ['10.0.0.0/8'] })], egress: [] });
  const { parent } = resolveScannedExpanded(sg);
  assert.ok(
    parent.comments.some((c) => c.includes('1 further block')),
    `parent comments did not name the child count: ${JSON.stringify(parent.comments)}`,
  );
  // A group with no rules must not grow a comment about rules it does not have.
  const bare = resolveScannedExpanded(subject('sg-0bare', { ingress: [], egress: [] }));
  assert.equal(bare.children.length, 0);
  assert.deepEqual(bare.parent.comments, resolveScanned(subject('sg-0bare', {})).comments);
});

// ── the fan-out rule ───────────────────────────────────────────────────────

/**
 * The fan-out is not "one resource per source". It is dictated by
 * `ConflictsWith` in the provider schema
 * (`internal/service/ec2/vpc_security_group_rule.go:67,96,129,137`):
 *
 *   cidr_blocks              ⊥ source_security_group_id, self
 *   ipv6_cidr_blocks         ⊥ source_security_group_id, self
 *   prefix_list_ids          ⊥ nothing
 *   source_security_group_id ⊥ cidr_blocks, ipv6_cidr_blocks, self  (TypeString — one)
 *
 * So the CIDR-shaped sources of one AWS `IpPermission` are **one** resource
 * carrying all of them, and each referenced security group is **another**
 * resource on its own. The doc's own example proves the first half:
 * `sg-4973616163_ingress_tcp_100_121_10.1.0.0/16_2001:db8::/48_10.2.0.0/16_2002:db8::/48`
 * is a single `aws_security_group_rule`.
 */
test('CIDR-shaped sources collapse into one rule resource', () => {
  const { children } = resolveScannedExpanded(
    subject('sg-4973616163', {
      ingress: [
        perm({
          fromPort: 100,
          toPort: 121,
          cidrs: ['10.1.0.0/16', '10.2.0.0/16'],
          ipv6Cidrs: ['2001:db8::/48', '2002:db8::/48'],
        }),
      ],
      egress: [],
    }),
  );
  assert.equal(children.length, 1);
  // Order is cidr_blocks, then ipv6_cidr_blocks, then prefix_list_ids —
  // the same order `rules/state.ts` composes them in, which is what makes the
  // two paths agree. The provider's importer classifies each trailing token by
  // content, so the grouping (not the order) is what has to be right.
  assert.equal(
    children[0]?.id,
    'sg-4973616163_ingress_tcp_100_121_10.1.0.0/16_10.2.0.0/16_2001:db8::/48_2002:db8::/48',
  );
});

test('prefix lists ride with the CIDR group and stand alone without one', () => {
  const withCidr = resolveScannedExpanded(
    subject('sg-0a', {
      ingress: [perm({ cidrs: ['10.0.0.0/8'], prefixListIds: ['pl-6469726b'] })],
      egress: [],
    }),
  );
  assert.equal(withCidr.children.length, 1);
  assert.equal(withCidr.children[0]?.id, 'sg-0a_ingress_tcp_443_443_10.0.0.0/8_pl-6469726b');

  // r/security_group_rule: "sg-62726f6479_egress_tcp_8000_8000_pl-6469726b"
  const alone = resolveScannedExpanded(
    subject('sg-62726f6479', {
      ingress: [],
      egress: [perm({ fromPort: 8000, toPort: 8000, prefixListIds: ['pl-6469726b'] })],
    }),
  );
  assert.equal(alone.children.length, 1);
  assert.equal(alone.children[0]?.id, 'sg-62726f6479_egress_tcp_8000_8000_pl-6469726b');
});

test('each referenced security group becomes its own rule resource', () => {
  const { children } = resolveScannedExpanded(
    subject('sg-0web', {
      ingress: [
        perm({
          cidrs: ['10.0.0.0/8'],
          securityGroupRefs: [{ groupId: 'sg-0alb' }, { groupId: 'sg-0bastion' }],
        }),
      ],
      egress: [],
    }),
  );
  // One IpPermission, three terraform resources: the CIDR group cannot carry a
  // source_security_group_id, and source_security_group_id is a single string.
  assert.equal(children.length, 3);
  assert.deepEqual(
    children.map((c) => c.id),
    [
      'sg-0web_ingress_tcp_443_443_10.0.0.0/8',
      'sg-0web_ingress_tcp_443_443_sg-0alb',
      'sg-0web_ingress_tcp_443_443_sg-0bastion',
    ],
  );
});

/**
 * `expandIPPermission` (`vpc_security_group_rule.go:815-828`) splits
 * `source_security_group_id` on `/` and reads `[OwnerID/]SecurityGroupID`, so a
 * peer-account source needs the account prefix and a same-account one must not
 * have it — AWS reports `UserId` on every pair, including our own.
 */
test('a cross-account group source carries the owner prefix, a same-account one does not', () => {
  const { children } = resolveScannedExpanded(
    subject('sg-0web', {
      ingress: [
        perm({
          securityGroupRefs: [
            { groupId: 'sg-0same', accountId: '111122223333' },
            { groupId: 'sg-0peer', accountId: '444455556666' },
          ],
        }),
      ],
      egress: [],
    }),
  );
  assert.deepEqual(
    children.map((c) => c.id),
    ['sg-0web_ingress_tcp_443_443_sg-0same', 'sg-0web_ingress_tcp_443_443_444455556666/sg-0peer'],
  );
});

/**
 * `protocolStateFunc` → `protocolForValue` (`vpc_security_group.go:1458-1503`)
 * normalises what the state holds; the scanner stores AWS's raw `IpProtocol`.
 * The scanned path applies the same normalisation so the two paths agree
 * byte-for-byte rather than merely importing the same rule.
 */
test('protocol and ports are normalised the way the provider normalises them', () => {
  const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
    // protocol -1 with no ports: r/security_group_rule's default any/any egress
    // example is `sg-…_egress_all_0_0_0.0.0.0/0`; the state holds the protocol
    // as `-1` (protocolForValue maps "all" → "-1") and both ports as 0.
    [{ protocol: '-1', fromPort: undefined, toPort: undefined }, 'sg-0a_ingress_-1_0_0_10.0.0.0/8'],
    [{ protocol: 'all', fromPort: undefined, toPort: undefined }, 'sg-0a_ingress_-1_0_0_10.0.0.0/8'],
    // A numeric protocol AWS could return for a well-known name.
    [{ protocol: '6', fromPort: 80, toPort: 80 }, 'sg-0a_ingress_tcp_80_80_10.0.0.0/8'],
    [{ protocol: '58', fromPort: -1, toPort: -1 }, 'sg-0a_ingress_icmpv6_-1_-1_10.0.0.0/8'],
    // MTP — no name, so the number stays. r/security_group_rule uses 92.
    [{ protocol: '92', fromPort: 0, toPort: 65536 }, 'sg-0a_ingress_92_0_65536_10.0.0.0/8'],
    // ICMP type/code, which the importer validates in -1..255.
    [{ protocol: 'icmp', fromPort: 8, toPort: -1 }, 'sg-0a_ingress_icmp_8_-1_10.0.0.0/8'],
  ];
  for (const [over, expected] of cases) {
    const { children } = resolveScannedExpanded(
      subject('sg-0a', { ingress: [perm({ ...over, cidrs: ['10.0.0.0/8'] })], egress: [] }),
    );
    assert.equal(children[0]?.id, expected, JSON.stringify(over));
  }
});

// ── agreement with the state resolver in rules/state.ts ────────────────────

/**
 * The plan's completion property, applied to the type this package now
 * produces from both sides: `rules/state.ts`'s `fromState` and this file's
 * expander must return the **same string** for the same real rule.
 *
 * The attribute maps below are what the provider writes into state for each
 * scanned permission — `flattenIpPermission` (`vpc_security_group_rule.go:857-860`)
 * sets `from_port`/`to_port` from the `IpPermission`, so a nil port lands as 0.
 */
test('the scanned expander and the state resolver produce the same id', () => {
  const fromState = ruleForType('aws_security_group_rule')?.fromState;
  assert.ok(fromState !== undefined, 'WP-D no longer registers aws_security_group_rule.fromState');

  const cases: ReadonlyArray<{
    readonly why: string;
    readonly permission: Record<string, unknown>;
    readonly direction: 'ingress' | 'egress';
    readonly attrs: Record<string, unknown>;
  }> = [
    {
      why: 'single IPv4 CIDR',
      direction: 'ingress',
      permission: perm({ fromPort: 8000, toPort: 8000, cidrs: ['10.0.3.0/24'] }),
      attrs: {
        security_group_id: 'sg-6e616f6d69',
        type: 'ingress',
        protocol: 'tcp',
        from_port: 8000,
        to_port: 8000,
        cidr_blocks: ['10.0.3.0/24'],
      },
    },
    {
      why: 'mixed IPv4 and IPv6 CIDRs in one resource',
      direction: 'ingress',
      permission: perm({
        fromPort: 100,
        toPort: 121,
        cidrs: ['10.1.0.0/16', '10.2.0.0/16'],
        ipv6Cidrs: ['2001:db8::/48', '2002:db8::/48'],
      }),
      attrs: {
        security_group_id: 'sg-6e616f6d69',
        type: 'ingress',
        protocol: 'tcp',
        from_port: 100,
        to_port: 121,
        cidr_blocks: ['10.1.0.0/16', '10.2.0.0/16'],
        ipv6_cidr_blocks: ['2001:db8::/48', '2002:db8::/48'],
      },
    },
    {
      why: 'any/any egress, where the state holds protocol -1 and both ports 0',
      direction: 'egress',
      permission: perm({
        protocol: '-1',
        fromPort: undefined,
        toPort: undefined,
        cidrs: ['0.0.0.0/0'],
      }),
      attrs: {
        security_group_id: 'sg-6e616f6d69',
        type: 'egress',
        protocol: '-1',
        from_port: 0,
        to_port: 0,
        cidr_blocks: ['0.0.0.0/0'],
      },
    },
    {
      why: 'prefix list destination',
      direction: 'egress',
      permission: perm({ fromPort: 8000, toPort: 8000, prefixListIds: ['pl-6469726b'] }),
      attrs: {
        security_group_id: 'sg-6e616f6d69',
        type: 'egress',
        protocol: 'tcp',
        from_port: 8000,
        to_port: 8000,
        prefix_list_ids: ['pl-6469726b'],
      },
    },
    {
      why: 'a security group source',
      direction: 'ingress',
      permission: perm({
        protocol: '-1',
        fromPort: 0,
        toPort: 65536,
        securityGroupRefs: [{ groupId: 'sg-6176657279' }],
      }),
      attrs: {
        security_group_id: 'sg-6e616f6d69',
        type: 'ingress',
        protocol: '-1',
        from_port: 0,
        to_port: 65536,
        source_security_group_id: 'sg-6176657279',
      },
    },
  ];

  for (const c of cases) {
    const { children } = resolveScannedExpanded(
      subject('sg-6e616f6d69', {
        ingress: c.direction === 'ingress' ? [c.permission] : [],
        egress: c.direction === 'egress' ? [c.permission] : [],
      }),
    );
    assert.equal(children.length, 1, c.why);
    assert.equal(children[0]?.id, fromState(c.attrs), `${c.why}: the two paths disagree`);
  }
});

/**
 * The one case where they provably **cannot** agree, pinned so it is a
 * recorded limitation rather than a latent surprise.
 *
 * AWS reports a self-reference as a `UserIdGroupPair` holding the group's own
 * id; terraform can express it as `self = true` *or* as
 * `source_security_group_id = <own id>`, and `expandIPPermission` sends the
 * same API call either way. A scan cannot tell which the configuration used.
 * The expander emits the group id — what AWS actually reported, no inference —
 * and says so on the block.
 */
test('a self-referencing rule emits the group id and names the self alternative', () => {
  const { children } = resolveScannedExpanded(
    subject('sg-656c65616e6f72', {
      ingress: [
        perm({ fromPort: 80, toPort: 80, securityGroupRefs: [{ groupId: 'sg-656c65616e6f72' }] }),
      ],
      egress: [],
    }),
  );
  assert.equal(children.length, 1);
  assert.equal(children[0]?.id, 'sg-656c65616e6f72_ingress_tcp_80_80_sg-656c65616e6f72');
  assert.ok(
    children[0]?.comments.some((c) => c.includes('self')),
    'the self-reference block does not name the self = true alternative',
  );
  // `rules/state.ts` would answer `…_self` for a state carrying self = true.
  // Both import ids resolve to the same AWS rule; only the recorded attribute
  // differs, which is why this divergence is documented, not reconciled.
  const fromState = ruleForType('aws_security_group_rule')?.fromState;
  assert.equal(
    fromState?.({
      security_group_id: 'sg-656c65616e6f72',
      type: 'ingress',
      protocol: 'tcp',
      from_port: 80,
      to_port: 80,
      self: true,
    }),
    'sg-656c65616e6f72_ingress_tcp_80_80_self',
  );
});

// ── the disclosure that is part of the deliverable ─────────────────────────

test('every emitted rule block says it is the legacy type and why', () => {
  const { children } = resolveScannedExpanded(
    subject('sg-0web', { ingress: [perm({ cidrs: ['10.0.0.0/8'] })], egress: [] }),
  );
  const comments = children[0]?.comments.join('\n') ?? '';
  // The modern types are not derivable: they import by security_group_rule_id
  // (`sgr-…`) and the scanner never calls DescribeSecurityGroupRules, so the
  // emitted block is the wrong *type* for a configuration that uses them.
  assert.match(comments, /aws_vpc_security_group_ingress_rule/);
  assert.match(comments, /sgr-/);
  // r/security_group_rule's `!> WARNING`: mixing this type with inline
  // ingress/egress on aws_security_group causes perpetual diffs.
  assert.match(comments, /inline/);
  // And the reader must be able to see which resource this hangs off.
  assert.match(comments, /aws_security_group\.web/);
});

test('no fabricated modern-type rule is ever registered', () => {
  // The scanner has no `sgr-…` to offer, so these must stay state-only: a
  // scanned subject reaching them would be a guessed id of exactly the shape
  // this package exists to prevent.
  for (const type of ['aws_vpc_security_group_ingress_rule', 'aws_vpc_security_group_egress_rule']) {
    const rule = ruleForType(type);
    assert.ok(rule !== undefined, `${type} lost its state rule`);
    assert.equal(rule.fromScanned, undefined, `${type} must not resolve from a scan`);
    assert.equal(rule.expand, undefined, `${type} is not a parent`);
    assert.deepEqual(rule.kinds, undefined, `${type} must not claim an atlas kind`);
  }
});

// ── children fail individually ─────────────────────────────────────────────

test('a rule whose id cannot be built is emitted, flagged, and commented out', () => {
  const { parent, children } = resolveScannedExpanded(
    subject('sg-0web', {
      ingress: [
        perm({ cidrs: ['10.0.0.0/8'] }),
        // A permission whose only source was a UserIdGroupPair with no GroupId:
        // `mapSgRules` drops it (`collect/network.ts:86`), leaving no source at
        // all. The provider's importer requires at least one.
        perm({ fromPort: 22, toPort: 22 }),
        perm({ cidrs: ['192.168.0.0/16'] }),
      ],
      egress: [],
    }),
  );
  assert.equal(children.length, 3);
  // The sibling before it and the sibling after it are untouched…
  assert.equal(children[0]?.verified, true);
  assert.equal(children[2]?.verified, true);
  assert.equal(children[0]?.commentedOut, undefined);
  // …and the parent is still a usable block.
  assert.equal(parent.verified, true);
  assert.equal(parent.id, 'sg-0web');

  const bad = children[1];
  assert.ok(bad !== undefined);
  assert.equal(bad.verified, false);
  assert.equal(bad.commentedOut, true);
  // The partial id is kept so the reader can complete it rather than rebuild it.
  assert.equal(bad.id, 'sg-0web_ingress_tcp_22_22');
  assert.ok(bad.comments.some((c) => c.includes('source')));
  // Commented out means it cannot be pasted by accident.
  const text = emitBlocks([bad]);
  assert.ok(!/^import \{/m.test(text), `a block with no source was emitted as live HCL:\n${text}`);
});

test('a group id the provider would reject does not produce a confident block', () => {
  // `resourceSecurityGroupRuleImport` rejects anything not prefixed `sg-`
  // (`vpc_security_group_rule.go:459`).
  const { children } = resolveScannedExpanded(
    subject('', { ingress: [perm({ cidrs: ['10.0.0.0/8'] })], egress: [] }),
  );
  assert.equal(children.length, 1);
  assert.equal(children[0]?.verified, false);
  assert.equal(children[0]?.commentedOut, true);
});

test('a malformed snapshot yields a parent and no throw', () => {
  for (const raw of [
    { ingress: 'not an array', egress: null },
    { ingress: [null, 7, 'x'], egress: [{}] },
    {},
  ] as Array<Record<string, unknown>>) {
    const { parent } = resolveScannedExpanded(subject('sg-0web', raw));
    assert.equal(parent.type, 'aws_security_group');
    assert.equal(parent.id, 'sg-0web');
  }
});

// ── addresses ──────────────────────────────────────────────────────────────

test('a child address reads as a child of its parent and dedupes across a batch', () => {
  const one = subject('sg-0aaa', {
    ingress: [perm({ cidrs: ['10.0.0.0/8'] })],
    egress: [],
  }, { name: 'default' });
  const two = subject('sg-0bbb', {
    ingress: [perm({ cidrs: ['10.0.0.0/8'] })],
    egress: [],
  }, { name: 'default' });

  const flat = resolveScannedManyExpanded([one, two]);
  assert.equal(flat.length, 4);
  // Parent first, then its own children — the contract bulk callers rely on.
  assert.equal(flat[0]?.type, 'aws_security_group');
  assert.equal(flat[1]?.type, 'aws_security_group_rule');
  assert.equal(flat[2]?.type, 'aws_security_group');
  assert.equal(flat[3]?.type, 'aws_security_group_rule');
  // The child names its parent's label, so the two read as a pair.
  assert.equal(flat[0]?.address, 'aws_security_group.default');
  assert.equal(flat[1]?.address, 'aws_security_group_rule.default_ingress_tcp_443_cidr');
  // Every address a suggestion, so decision 8's dedupe applies to children too.
  for (const item of flat) assert.equal(item.addressIsSuggestion, true);
  const text = emitBlocks(flat);
  assert.match(text, /to = aws_security_group\.default_2$/m);
  assert.match(text, /to = aws_security_group_rule\.default_ingress_tcp_443_cidr_2$/m);
});

// ── the constraint: expansion never reaches the state path ─────────────────

/**
 * A state file already contains `aws_security_group_rule` entries as their own
 * resources. If expansion fired there, every rule would be emitted twice — once
 * as itself and once as a child of its group — which is invalid HCL and would
 * move the golden. The separation is structural (`from-state.ts` does not
 * import `from-scanned.ts`), and this is the assertion that keeps it so.
 */
test('the state path emits one block per state resource and never expands', () => {
  const state = {
    version: 4,
    resources: [
      {
        mode: 'managed',
        type: 'aws_security_group',
        name: 'web',
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [
          {
            attributes: {
              id: 'sg-0web',
              ingress: [{ from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'] }],
              egress: [{ from_port: 0, to_port: 0, protocol: '-1', cidr_blocks: ['0.0.0.0/0'] }],
            },
          },
        ],
      },
      {
        mode: 'managed',
        type: 'aws_security_group_rule',
        name: 'https',
        provider: 'provider["registry.terraform.io/hashicorp/aws"]',
        instances: [
          {
            attributes: {
              id: 'sgrule-1234567890',
              security_group_id: 'sg-0web',
              type: 'ingress',
              protocol: 'tcp',
              from_port: 443,
              to_port: 443,
              cidr_blocks: ['10.0.0.0/8'],
            },
          },
        ],
      },
    ],
  };
  const blocks = importsFromState(state, 'scanned-expand.test.ts');
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((b) => `${b.address} ${b.id}`),
    // `importsFromState` sorts by address. The count is the assertion that
    // matters: the group's inline `ingress`/`egress` attributes produced no
    // extra blocks, and the one rule in the state was emitted exactly once.
    [
      'aws_security_group_rule.https sg-0web_ingress_tcp_443_443_10.0.0.0/8',
      'aws_security_group.web sg-0web',
    ],
  );
});

// ── the seam survives the registry ─────────────────────────────────────────

/**
 * `aws_security_group` is declared twice: in `rules/scanned-network.ts`, which
 * carries the expander, and in `rules/state.ts`, which carries the state
 * resolver. `rules/registry.ts` merges the two into a single rule keyed on the
 * terraform type, and a second declaration contributes only the fields named in
 * `MERGED_FIELDS`. `expand` is on that list, so the expander is merged by
 * design and the order of `SOURCES` does not affect it.
 *
 * It was not always. `expand` was missing from `MERGED_FIELDS` and survived
 * only because `scanned-network.ts` happened to come first and first
 * declarations are spread wholesale; reordering `SOURCES` would have taken the
 * expander out. That is the failure this test guards against recurring. A field
 * added to `ImportRule` but not to `MERGED_FIELDS` is dropped from every second
 * declaration silently — no type error, and no `CONFLICTS` entry either, since
 * conflicts are only recorded for fields the merge already knows about. This
 * fails the moment the merge stops delivering an expander, whatever the cause.
 */
test('every declared expander survives the registry merge', () => {
  const expanders = RULES.filter((r) => r.expand !== undefined).map((r) => r.type);
  assert.deepEqual(expanders, ['aws_security_group']);
  for (const type of expanders) {
    assert.notEqual(ruleForType(type)?.expand, undefined, `${type} lost its expander in the merge`);
  }
  // Reachable by kind, which is the route the viewer takes.
  assert.notEqual(ruleForKind('sg')?.expand, undefined);
  // And the same merge still carries `rules/state.ts`'s resolver onto that one
  // rule. Both fields have to arrive for the sg case to work from both sides.
  assert.notEqual(ruleForKind('sg')?.fromState, undefined);
});

test('resolveScanned is unchanged for an sg subject', () => {
  // The golden test's scanned cases go through `resolveScanned`. Expansion must
  // not leak a comment, an id or a type into it.
  const sg = subject('sg-0web', { ingress: [perm({ cidrs: ['10.0.0.0/8'] })], egress: [] });
  const resolved = resolveScanned(sg);
  assert.deepEqual(resolved, {
    type: 'aws_security_group',
    address: 'aws_security_group.web',
    id: 'sg-0web',
    comments: ['account 111122223333 · region eu-west-1'],
    verified: true,
    addressIsSuggestion: true,
    accountId: '111122223333',
    region: 'eu-west-1',
  });
});

test('a kind with no expander expands to nothing', () => {
  const vpc: ScannedSubject = {
    kind: 'vpc',
    id: 'vpc-0a1b',
    region: 'eu-west-1',
    accountId: '111122223333',
    raw: {},
  };
  const { parent, children } = resolveScannedExpanded(vpc);
  assert.equal(children.length, 0);
  assert.deepEqual(parent, resolveScanned(vpc));
});
