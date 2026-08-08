/**
 * The three-verdict classifier in `src/model/tf-import.ts`, pinned.
 *
 * The failure this module exists to prevent is offering an `import` block for a
 * resource that is **already in someone's state**: the paste plans clean, the
 * apply fights another stack, and the cost lands hours later in a repo nobody
 * here can see. `unproven` is the whole defence — it is not "low confidence
 * managed", it is *cannot tell*, and every rule below is a rule about when the
 * evidence does or does not support certainty.
 *
 * Only `model/tf-import.ts` is imported. It is plain TypeScript — the classifier
 * needs no DOM, no React and no renderer — so these assertions are about the
 * returned verdicts rather than about rendered strings, and survive rewording of
 * every sentence the panel shows.
 *
 * Two things are asserted on text anyway, because for those the text *is* the
 * behaviour: `ImportBlock.text` is the exact string the copy button puts on the
 * clipboard, where the UI stops existing, so the `CHECK BEFORE APPLYING` marker
 * has to be in it; and `NestedBlock.text` is what the panel draws beside its own
 * amber callout, so the same marker must **not** be in that.
 *
 * The evidence the fixture is built from — `packages/scanner/src/fixture.ts`'s
 * `dev-app` group and `devPlatformState` — is reproduced here in miniature
 * rather than imported, so a test failure names a rule of the classifier instead
 * of an edit to the estate.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TerraformResourceInstance, TerraformStackFile } from '@atlas/schema';
import type { ResourceRef } from '../src/data.js';
import {
  importBlockFor,
  importBlocksFor,
  type ImportBlock,
  type NestedBlock,
  type TerraformKnowledge,
} from '../src/model/tf-import.js';

const ACCOUNT = '111111111111';
const REGION = 'eu-west-1';
const PASTE_MARKER = 'CHECK BEFORE APPLYING:';

/** The scanned group every test below classifies the rules of. */
const SG = 'sg-0aaa0000000001';
/** Another group, referenced by one of its rules. Never the subject. */
const PEER = 'sg-0bbb0000000002';

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

/** https from one CIDR. Id: `<sg>_ingress_tcp_443_443_10.0.0.0/16`. */
const HTTPS = perm({ cidrs: ['10.0.0.0/16'] });
const HTTPS_ID = `${SG}_ingress_tcp_443_443_10.0.0.0/16`;

/** https from another group. Id: `<sg>_ingress_tcp_443_443_<peer>`. */
const FROM_PEER = perm({ securityGroupRefs: [{ groupId: PEER }] });
const FROM_PEER_ID = `${SG}_ingress_tcp_443_443_${PEER}`;

/**
 * The `self = true` rule — the reason `differsInOneField` exists. AWS reports
 * the group's own id as the source and the expander can only emit that; a
 * configuration written `self = true` puts the literal `self` in the state's
 * import id instead. The two strings agree on group, direction, protocol and
 * both ports, and differ in the source alone.
 */
const GOSSIP = perm({ fromPort: 9000, toPort: 9100, securityGroupRefs: [{ groupId: SG }] });
const GOSSIP_ID = `${SG}_ingress_tcp_9000_9100_${SG}`;
const GOSSIP_STATE_ID = `${SG}_ingress_tcp_9000_9100_self`;

/** Any/any egress. Id: `<sg>_egress_-1_0_0_0.0.0.0/0`. */
const EGRESS = perm({ protocol: '-1', fromPort: undefined, toPort: undefined, cidrs: ['0.0.0.0/0'] });
const EGRESS_ID = `${SG}_egress_-1_0_0_0.0.0.0/0`;

function group(
  ingress: readonly Record<string, unknown>[],
  egress: readonly Record<string, unknown>[] = [],
  id = SG,
): ResourceRef {
  return {
    kind: 'sg',
    id,
    name: 'app',
    accountId: ACCOUNT,
    region: REGION,
    raw: { id, name: 'app', vpcId: 'vpc-0000000000000001', ingress, egress },
  };
}

const rule = (name: string, importId?: string): TerraformResourceInstance => ({
  address: `aws_security_group_rule.${name}`,
  type: 'aws_security_group_rule',
  id: `sgrule-${name}`,
  ...(importId === undefined ? {} : { importId }),
});

function stack(name: string, resources: readonly TerraformResourceInstance[]): TerraformStackFile {
  return {
    version: 1,
    stack: name,
    repo: `github.com/acme/${name}`,
    importedAt: '2026-08-08T00:00:00.000Z',
    resources: [...resources],
  };
}

/**
 * `boundTo` is the half that cannot be derived from the state: which stacks the
 * viewer's matcher says claim **the parent**. It is what places an instance
 * carrying no `importId`, which can be placed no other way.
 */
function knowledgeOf(
  stacks: readonly TerraformStackFile[],
  boundTo: readonly string[] = [],
): TerraformKnowledge {
  return {
    terraform: stacks,
    terraformFor: () =>
      boundTo.map((name) => ({
        stack: name,
        repo: `github.com/acme/${name}`,
        address: 'aws_security_group.app',
        type: 'aws_security_group',
      })),
  };
}

const statuses = (block: ImportBlock): string[] => block.children.map((c) => c.status);

function child(block: ImportBlock, at: number): NestedBlock {
  const found = block.children[at];
  assert.ok(found !== undefined, `no child at index ${at}`);
  return found;
}

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// ── managed: the id is in state, verbatim ──────────────────────────────────

test('a child whose import id is in an imported state is managed, and is not offered', () => {
  const block = importBlockFor(
    group([HTTPS]),
    knowledgeOf([stack('app-stack', [rule('https', HTTPS_ID)])], ['app-stack']),
  );

  assert.deepEqual(statuses(block), ['managed']);
  assert.deepEqual(child(block, 0).claim, {
    stack: 'app-stack',
    repo: 'github.com/acme/app-stack',
    address: 'aws_security_group_rule.https',
    type: 'aws_security_group_rule',
    importId: HTTPS_ID,
  });
  assert.equal(block.uncertainty, undefined);
  // Nothing to adopt: the parent is claimed and its only rule is proven. The
  // copy button must promise nothing rather than a block that would conflict.
  assert.equal(block.offered, 0);
  assert.equal(block.text, '');
  assert.equal(child(block, 0).text, '');
});

test('proof survives doubt: a matched child stays managed while a sibling goes unproven', () => {
  // The blanket rule rewrites *unmanaged* verdicts, never a proven one — an
  // unexplained state entry cannot un-prove a verbatim id match.
  const block = importBlockFor(
    group([HTTPS], [EGRESS]),
    knowledgeOf(
      [stack('app-stack', [rule('https', HTTPS_ID), rule('legacy')])],
      ['app-stack'],
    ),
  );

  assert.deepEqual(statuses(block), ['managed', 'unproven']);
  assert.notEqual(block.uncertainty, undefined);
});

// ── unmanaged: derivable, absent from state, and nothing left unexplained ───

test('a child absent from a state that accounts for itself is unmanaged', () => {
  const block = importBlockFor(
    group([HTTPS]),
    // A rule in another stack, under another group. It is the same terraform
    // type, so it is considered — and it is placed by neither route: its
    // import id does not open with this parent's id, and its stack does not
    // claim this parent. It must not withhold certainty.
    knowledgeOf([stack('other', [rule('elsewhere', 'sg-0ccc0000000003_ingress_tcp_22_22_10.9.0.0/16')])]),
  );

  assert.deepEqual(statuses(block), ['unmanaged']);
  assert.equal(child(block, 0).claim, undefined);
  assert.equal(child(block, 0).doubt, undefined);
  assert.equal(block.uncertainty, undefined);
  // Parent unclaimed, so the group and its rule are both on offer.
  assert.equal(block.parentManaged, false);
  assert.equal(block.offered, 2);
  assert.ok(block.text.includes(HTTPS_ID));
  assert.ok(!block.text.includes(PASTE_MARKER));
});

// ── unproven (1): the old sidecar, and the case that protects real users ────

test('a state instance with no import id under a bound parent makes every child unproven', () => {
  // A sidecar written before `importId` existed carries none. It cannot match
  // anything, and it cannot be dismissed either — so nothing under the parent
  // its stack manages can be called unmanaged. Offering these blocks anyway is
  // right (decision 5: flag rather than hide); offering them *unmarked* is the
  // failure.
  const knowledge = knowledgeOf(
    [stack('prod-network', [rule('from_alb')])],
    ['prod-network'],
  );
  const block = importBlockFor(group([HTTPS], [EGRESS]), knowledge);

  assert.deepEqual(statuses(block), ['unproven', 'unproven']);
  // Nothing was located, so nothing may be named: an unproven child from this
  // route carries no claim and no per-child doubt, only the shared sentence.
  assert.deepEqual(
    block.children.map((c) => c.claim),
    [undefined, undefined],
  );
  assert.notEqual(block.uncertainty, undefined);
  assert.ok(block.uncertainty?.includes('prod-network'));
  // Both are still offered — hiding them would lose real drift.
  assert.equal(block.offered, 2);
});

test('the same instance in a stack that does not claim the parent cannot withhold certainty', () => {
  // Without an `importId` the only thing that places an instance against this
  // parent is the binding. Drop the binding and the identical state entry is
  // somebody else's problem, so the children are judged normally.
  const block = importBlockFor(
    group([HTTPS], [EGRESS]),
    knowledgeOf([stack('prod-network', [rule('from_alb')])]),
  );

  assert.deepEqual(statuses(block), ['unmanaged', 'unmanaged']);
  assert.equal(block.uncertainty, undefined);
});

// ── unproven (2): the near-match ───────────────────────────────────────────

test('a state id differing in exactly one field explains itself and names the address', () => {
  const block = importBlockFor(
    group([GOSSIP]),
    knowledgeOf([stack('app-stack', [rule('gossip', GOSSIP_STATE_ID)])], ['app-stack']),
  );

  assert.deepEqual(statuses(block), ['unproven']);
  assert.equal(child(block, 0).claim?.address, 'aws_security_group_rule.gossip');
  assert.equal(child(block, 0).claim?.importId, GOSSIP_STATE_ID);
  // A near-match raises doubt about *this* rule and settles the state entry, so
  // the reader checks one address instead of auditing a stack — and there is no
  // estate-wide sentence left to print.
  assert.notEqual(child(block, 0).doubt, undefined);
  assert.equal(block.uncertainty, undefined);
});

test('a state id differing in two fields does not near-match, and doubt stays anonymous', () => {
  // Same shape, one more difference: ports 9000-9200 against the scan's
  // 9000-9100 *and* `self` against the group id. The entry is still unexplained
  // — so the child is still unproven — but nothing may be said about which
  // rule it is, and the distinction between these two tests is exactly the
  // near-match rule.
  const block = importBlockFor(
    group([GOSSIP]),
    knowledgeOf(
      [stack('app-stack', [rule('gossip', `${SG}_ingress_tcp_9000_9200_self`)])],
      ['app-stack'],
    ),
  );

  assert.deepEqual(statuses(block), ['unproven']);
  assert.equal(child(block, 0).claim, undefined);
  assert.equal(child(block, 0).doubt, undefined);
  assert.notEqual(block.uncertainty, undefined);
  assert.ok(block.uncertainty?.includes('aws_security_group_rule.gossip'));
});

// ── the interaction: an explained pool is what permits `unmanaged` ──────────

test('explaining the last unaccounted state entry is what lets a sibling be unmanaged', () => {
  // `packages/scanner/src/fixture.ts`'s `dev-app` in miniature. Three rules:
  // one referencing another group (in no state at all), the `self` rule, and
  // egress (matched verbatim). The near-match settles the only unaccounted
  // entry, and *because* it does, the peer rule can be judged.
  const managed = stack('app-stack', [
    rule('egress', EGRESS_ID),
    rule('gossip', GOSSIP_STATE_ID),
  ]);
  const block = importBlockFor(
    group([FROM_PEER, GOSSIP], [EGRESS]),
    knowledgeOf([managed], ['app-stack']),
  );

  assert.deepEqual(statuses(block), ['unmanaged', 'unproven', 'managed']);
  assert.equal(block.uncertainty, undefined);
  assert.equal(child(block, 0).claim, undefined);

  // The control. One field further apart, the near-match does not fire, the
  // entry stays unaccounted — and the peer rule that was provably unmanaged a
  // moment ago is downgraded with it. Nothing about the peer rule changed.
  const control = importBlockFor(
    group([FROM_PEER, GOSSIP], [EGRESS]),
    knowledgeOf(
      [stack('app-stack', [rule('egress', EGRESS_ID), rule('gossip', `${SG}_ingress_tcp_9000_9200_self`)])],
      ['app-stack'],
    ),
  );

  assert.deepEqual(statuses(control), ['unproven', 'unproven', 'managed']);
  assert.notEqual(control.uncertainty, undefined);
});

// ── unproven (3): an id the scan could not build ───────────────────────────

test('a child whose import id could not be built is unproven whatever the state says', () => {
  // A permission with no source at all — `mapSgRules` drops a group pair with
  // no `GroupId`, which can empty one out. The id is incomplete, so it can be
  // checked against nothing; calling it unmanaged would be the confident half
  // of a guess. Still emitted, commented out so it cannot apply on paste.
  const block = importBlockFor(group([perm()]), knowledgeOf([]));

  assert.deepEqual(statuses(block), ['unproven']);
  assert.equal(child(block, 0).claim, undefined);
  assert.notEqual(child(block, 0).doubt, undefined);
  assert.equal(child(block, 0).resolved.commentedOut, true);
  assert.equal(block.uncertainty, undefined);
});

// ── a parent with nothing nested ───────────────────────────────────────────

test('a parent with no nested types is unaffected by state that would otherwise raise doubt', () => {
  // `types` is empty, so no state instance of any type is even considered. A
  // VPC beside the most doubt-inducing state there is — an importId-less rule
  // in a stack that claims it — classifies exactly as it would beside none.
  const vpc: ResourceRef = {
    kind: 'vpc',
    id: 'vpc-0000000000000001',
    name: 'dev',
    accountId: ACCOUNT,
    region: REGION,
    raw: { id: 'vpc-0000000000000001', name: 'dev' },
  };
  const hostile = knowledgeOf([stack('prod-network', [rule('from_alb')])], ['prod-network']);
  const quiet = knowledgeOf([]);

  for (const [label, block] of [
    ['bound to the sidecar stack', importBlockFor(vpc, hostile)],
    ['no state at all', importBlockFor(vpc, quiet)],
  ] as const) {
    assert.deepEqual(block.children, [], label);
    assert.equal(block.uncertainty, undefined, label);
    assert.equal(block.sharedChildComments.length, 0, label);
  }
  // Unclaimed, so the VPC itself is still on offer, unmarked.
  assert.equal(importBlockFor(vpc, quiet).offered, 1);
  assert.ok(!importBlockFor(vpc, quiet).text.includes(PASTE_MARKER));
});

// ── the marker travels with the paste, and only with the paste ─────────────

test('unproven blocks carry the CHECK marker in copied text, once each, and never on screen', () => {
  const knowledge = knowledgeOf([stack('prod-network', [rule('from_alb')])], ['prod-network']);
  const ref = group([HTTPS], [EGRESS]);
  const block = importBlockFor(ref, knowledge);

  assert.deepEqual(statuses(block), ['unproven', 'unproven']);
  // Copied text: the clipboard is where the UI stops existing, so every
  // unprovable block has to say so on its own — once, not twice.
  assert.equal(occurrences(block.text, PASTE_MARKER), 2);
  // Rendered text: the panel prints `uncertainty` above these, so repeating it
  // inside each stanza would state the same fact twice, three inches apart.
  for (const c of block.children) assert.ok(!c.text.includes(PASTE_MARKER));
  // And it is never hoisted as a comment every child shares, which would print
  // it a third time.
  assert.ok(!block.sharedChildComments.some((c) => c.includes(PASTE_MARKER)));

  // The bulk path runs the same plan, so the two can never disagree about what
  // a paste contains — the seam the classifier was factored out to close.
  const bulk = importBlocksFor([ref], knowledge);
  assert.equal(bulk.unproven, statuses(block).filter((s) => s === 'unproven').length);
  assert.equal(bulk.blocks.length, block.offered);
  assert.equal(occurrences(bulk.text, PASTE_MARKER), 2);
  assert.equal(bulk.partiallyManaged, 1);
  assert.equal(bulk.nestedUnderManaged, 2);
});

test('a near-matched block names the state address it may collide with in the paste', () => {
  const ref = group([GOSSIP]);
  const knowledge = knowledgeOf([stack('app-stack', [rule('gossip', GOSSIP_STATE_ID)])], ['app-stack']);
  const block = importBlockFor(ref, knowledge);

  assert.equal(occurrences(block.text, PASTE_MARKER), 1);
  assert.ok(block.text.includes('aws_security_group_rule.gossip'));
  assert.ok(!child(block, 0).text.includes(PASTE_MARKER));
  assert.equal(importBlocksFor([ref], knowledge).unproven, 1);
});
