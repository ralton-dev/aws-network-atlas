/**
 * `validateProposal` (PROPOSAL-OVERLAY.md, decisions 45–47): the loop an agent
 * runs until exit 0, so every error must name the path to edit and every
 * "cannot tell" must be a warning rather than a confident wrong error.
 *
 * Against `estate.ts`: the peering to an unscanned account is the case that
 * proves the account exemption; the shared TGW is why a key can resolve in
 * two places; the ARN-only generic resource proves ARN keys.
 *
 * Shapes it still avoids: a reference inside a JSON-string field (an IAM
 * policy document — not walked, by design); a proposal that removes a
 * resource another op still references; ids with upper-case letters.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { designRules, validateProposal, type DesignRule, type Issue, type Proposal } from '../src/index.js';
import { estate, GENERATED_AT, GENERIC_ARN, HUB, NEW, newSpoke, only, PROD, REGION, STRANGER, TGW } from './estate.js';

const codes = (issues: Issue[]): string[] => issues.map((i) => `${i.level}:${i.code}${i.path ? `@${i.path}` : ''}`);

const addTo = (collection: string, resource: Record<string, unknown> & { id: string }, region = REGION, account = PROD) =>
  ({ op: 'add', account, region, collection, resource }) as const;

test('the pin proposal is clean, and validating mutates neither input', () => {
  const base = estate();
  const proposal = newSpoke();
  const a = structuredClone(base);
  const b = structuredClone(proposal);
  assert.deepEqual(validateProposal(base, proposal), []);
  assert.deepEqual(base, a);
  assert.deepEqual(proposal, b);
});

test('a malformed proposal returns only its shape errors, each with a path', () => {
  const bad = {
    id: 'x', version: 2, title: 'x', base: {}, extra: true,
    accounts: [{ accountId: 555555555555 }],
    changes: [{ op: 'add', account: NEW, region: REGION, collection: 'vpcs', resource: { name: 'no id' } }, { op: 'rename', key: 'x' }, { op: 'change', key: TGW, resource: {} }],
  } as unknown as Proposal;
  assert.deepEqual(codes(validateProposal(estate(), bad)), [
    'error:malformed@extra',
    'error:malformed@version',
    'error:malformed@base.generatedAt',
    'error:malformed@accounts[0].accountId',
    'error:malformed@changes[0].resource.id',
    'error:malformed@changes[1].op',
    'error:malformed@changes[2].resource',
    'error:malformed@changes[2].set',
  ]);
  const quoted = validateProposal(estate(), bad).find((i) => i.path === 'accounts[0].accountId');
  assert.match(quoted?.message ?? '', /quote/);
});

test('decision 45: an add needs a proposed- id that is not already taken', () => {
  const base = estate();
  const issues = validateProposal(
    base,
    only(
      addTo('vpcs', { id: 'vpc-0new0000000001', tags: {} }),
      addTo('vpcs', { id: 'vpc-0prod0000000001', tags: {} }),
      addTo('subnets', { id: 'proposed-a', tags: {} }),
      addTo('subnets', { id: 'proposed-a', tags: {} }),
      addTo('generic', { id: 'arn:aws:sqs:eu-west-1:111111111111:proposed-queue', arn: 'arn:aws:sqs:eu-west-1:111111111111:proposed-queue', tags: {} }),
    ),
  );
  assert.deepEqual(codes(issues), [
    'error:not-proposed-id@changes[0].resource.id',
    'error:not-proposed-id@changes[1].resource.id',
    'error:duplicate-id@changes[1].resource.id',
    'error:duplicate-id@changes[3].resource.id',
  ]);
});

test('an add names a known account and a collection of the right scope', () => {
  const issues = validateProposal(
    estate(),
    only(
      addTo('vpcs', { id: 'proposed-v', tags: {} }, REGION, '444444444444'),
      addTo('vpcs', { id: 'proposed-w', tags: {} }, 'global'),
      addTo('hostedZones', { id: 'proposed-z', tags: {} }),
      addTo('hostedZones', { id: 'proposed-zz', tags: {} }, 'global'),
      addTo('vpc', { id: 'proposed-typo', tags: {} }),
    ),
  );
  assert.deepEqual(codes(issues), [
    'error:unknown-account@changes[0].account',
    'error:unknown-collection@changes[1].collection',
    'error:unknown-collection@changes[2].collection',
    'error:unknown-collection@changes[4].collection',
  ]);
  assert.match(issues[3]?.message ?? '', /vpcs, subnets/, 'the message lists the vocabulary');
});

test('change and remove keys resolve in op order, by id or arn; id and arn are immutable', () => {
  const issues = validateProposal(
    estate(),
    only(
      { op: 'change', key: 'proposed-later', set: { name: 'x' } },
      addTo('subnets', { id: 'proposed-later', tags: {} }),
      { op: 'change', key: 'proposed-later', set: { name: 'y' } },
      { op: 'remove', key: GENERIC_ARN },
      { op: 'remove', key: GENERIC_ARN },
      { op: 'change', key: TGW, set: { id: 'tgw-other' } },
      { op: 'remove', key: 'pcx-doesnotexist' },
    ),
  );
  assert.deepEqual(codes(issues), [
    'error:unresolved-key@changes[0].key',
    'error:unresolved-key@changes[4].key',
    'error:immutable-field@changes[5].set.id',
    'error:unresolved-key@changes[6].key',
  ]);
});

test('decision 47: an unresolvable id-shaped reference is an error naming the field and the key', () => {
  const broken = newSpoke();
  const attach = broken.changes[1];
  assert.ok(attach?.op === 'add');
  attach.resource['transitGatewayId'] = 'tgw-doesnotexist';
  const issues = validateProposal(estate(), broken);
  assert.deepEqual(codes(issues), ['error:unresolved-reference@changes[1].resource.transitGatewayId']);
  assert.equal(issues[0]?.key, 'tgw-doesnotexist');
  assert.match(issues[0]?.message ?? '', /transitGatewayId/);
});

test('references are found in nested objects and lists, may point forward, and proposed- ids must resolve', () => {
  const issues = validateProposal(
    estate(),
    only(
      addTo('routeTables', {
        id: 'proposed-rtb', vpcId: 'proposed-vpc-later', tags: {},
        routes: [{ destinationCidr: '10.9.0.0/16', transitGatewayId: TGW }, { destinationCidr: '0.0.0.0/0', natGatewayId: 'nat-0missing00000001' }],
        associations: [{ subnetId: 'proposed-nothing', associationId: 'rtbassoc-0abc12345' }],
      }),
      addTo('vpcs', { id: 'proposed-vpc-later', tags: {}, cidrBlocks: ['10.30.0.0/16'] }),
    ),
  );
  assert.deepEqual(codes(issues), [
    'error:unresolved-reference@changes[0].resource.routes[1].natGatewayId',
    'error:unresolved-reference@changes[0].resource.associations[0].subnetId',
  ]);
});

test('a change`s set is checked for references too', () => {
  const issues = validateProposal(estate(), only({ op: 'change', key: 'tgw-attach-0prod000000001', set: { subnetIds: ['subnet-0nope0000001', 'proposed-x'] } }));
  assert.deepEqual(codes(issues), [
    'error:unresolved-reference@changes[0].set.subnetIds[0]',
    'error:unresolved-reference@changes[0].set.subnetIds[1]',
  ]);
});

test('account fields are exempt: an unscanned account warns, and references beside it warn rather than err', () => {
  const issues = validateProposal(
    estate(),
    only(
      addTo('peeringConnections', {
        id: 'proposed-pcx', tags: {},
        requester: { vpcId: 'vpc-0prod0000000001', accountId: PROD, cidrBlocks: [] },
        accepter: { vpcId: 'vpc-0stranger00000002', accountId: STRANGER, cidrBlocks: [] },
      }),
      addTo('transitGatewayAttachments', {
        id: 'proposed-vendor-attach', tags: {}, transitGatewayId: 'tgw-0vendor000000001', transitGatewayOwnerId: '888888888888',
        resourceOwnerId: PROD, resourceType: 'vpc', resourceId: 'vpc-0prod0000000001', subnetIds: [],
      }),
    ),
  );
  assert.deepEqual(codes(issues), [
    'warning:external-reference@changes[0].resource.accepter.accountId',
    'warning:external-reference@changes[0].resource.accepter.vpcId',
    'warning:external-reference@changes[1].resource.transitGatewayOwnerId',
    'warning:external-reference@changes[1].resource.transitGatewayId',
  ]);
});

test('a reference the validator cannot check is a warning, not an error', () => {
  const issues = validateProposal(
    estate(),
    only(
      addTo('instances', { id: 'proposed-i', tags: {}, imageId: 'ami-0abc1234def567890', widgetId: 'widget-0abc1234', name: 'not-a-ref-1234' }),
      addTo('lambdaFunctions', {
        id: 'proposed-fn', tags: {},
        roleArn: `arn:aws:iam::${PROD}:role/missing`,
        deadLetterTargetArn: `arn:aws:sqs:${REGION}:${PROD}:dlq`,
        kmsKeyArn: `arn:aws:kms:${REGION}:${STRANGER}:key/abc`,
        policyArn: 'arn:aws:iam::aws:policy/ReadOnlyAccess',
      }),
    ),
  );
  assert.deepEqual(codes(issues), [
    // iam:role ARNs are collected in a scanned account: a missing one is definitely wrong.
    'error:unresolved-reference@changes[1].resource.roleArn',
    'warning:unknown-reference@changes[0].resource.widgetId',
    'warning:unknown-reference@changes[1].resource.deadLetterTargetArn',
    'warning:external-reference@changes[1].resource.kmsKeyArn',
  ]);
});

test('decision 46: a moved base is one stale warning; --strict promotes warnings to errors', () => {
  const stale = { ...newSpoke(), base: { generatedAt: '2026-01-01T00:00:00Z' } };
  assert.deepEqual(codes(validateProposal(estate(), stale)), ['warning:stale@base.generatedAt']);
  assert.deepEqual(codes(validateProposal(estate(), stale, { strict: true })), ['error:stale@base.generatedAt']);
});

test('accounts: one that is already scanned, or listed twice, is an error', () => {
  const issues = validateProposal(estate(), {
    ...only(),
    accounts: [{ accountId: HUB }, { accountId: NEW }, { accountId: NEW }],
  });
  assert.deepEqual(codes(issues), ['error:account-exists@accounts[0].accountId', 'error:duplicate-id@accounts[2].accountId']);
});

test('design rules: the registry holds the five networking rules; a rule sees the applied snapshot and the change set, and only warns', () => {
  assert.deepEqual(
    designRules.map((r) => r.code),
    ['cidr-overlap', 'subnet-in-vpc', 'attachment-locality', 'sg-rule-vpc', 'route-target'],
  );
  const seen: string[] = [];
  const rule: DesignRule = {
    code: 'test-rule',
    description: 'flags every added VPC',
    check: ({ applied, changes, pathFor }) => {
      seen.push(`${applied.accounts.length} accounts`);
      return changes.added
        .filter((a) => a.collection === 'vpcs')
        .map((a) => ({ level: 'error', code: 'test-rule', message: 'a VPC', key: a.key, path: pathFor(a.key) }) satisfies Issue);
    },
  };
  assert.deepEqual(codes(validateProposal(estate(), newSpoke(), { rules: [rule] })), ['warning:test-rule@changes[0]']);
  assert.deepEqual(seen, ['4 accounts']);
  assert.deepEqual(codes(validateProposal(estate(), newSpoke(), { rules: [rule], strict: true })), ['error:test-rule@changes[0]']);

  const broken = only(addTo('vpcs', { id: 'vpc-not-proposed', tags: {} }));
  validateProposal(estate(), broken, { rules: [rule] });
  assert.equal(seen.length, 2, 'rules do not run while there are errors');
  assert.equal(GENERATED_AT, estate().generatedAt);
});
