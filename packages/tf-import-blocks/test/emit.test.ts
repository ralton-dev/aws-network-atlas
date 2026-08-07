/**
 * The emitter's own contract: escaping (decision 9), address sanitising and
 * collision dedupe (decision 8), and the state-parsing behaviour the rule
 * modules build on. These are WP-A's alone — no other package tests them, and
 * every one of them fails silently rather than loudly if it regresses.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dedupeAddresses,
  emitBlock,
  emitBlocks,
  escapeHcl,
  parseArn,
  parseStateFile,
  sanitizeLabel,
  suggestAddress,
  type ResolvedImport,
} from '../src/index.js';

const block = (over: Partial<ResolvedImport>): ResolvedImport => ({
  type: 'aws_vpc',
  address: 'aws_vpc.main',
  id: 'vpc-123',
  comments: [],
  verified: true,
  addressIsSuggestion: false,
  ...over,
});

test('escapeHcl escapes backslash, quote and both template openers', () => {
  assert.equal(escapeHcl('plain'), 'plain');
  assert.equal(escapeHcl('a\\b'), 'a\\\\b');
  assert.equal(escapeHcl('say "hi"'), 'say \\"hi\\"');
  // The one that bites: a replacement *string* of '$${' collapses to '${'
  // because $$ is the literal-dollar escape, so this must stay a real test.
  assert.equal(escapeHcl('${env}'), '$${env}');
  assert.equal(escapeHcl('%{if x}'), '%%{if x}');
  assert.equal(escapeHcl('a/"q"/${e}'), 'a/\\"q\\"/$${e}');
});

test('sanitizeLabel produces valid HCL identifiers', () => {
  assert.equal(sanitizeLabel('web'), 'web');
  assert.equal(sanitizeLabel('my.bucket/name'), 'my_bucket_name');
  assert.equal(sanitizeLabel('2fa-secret'), 'r_2fa-secret');
  assert.equal(sanitizeLabel('-leading-dash'), 'r_-leading-dash');
  assert.equal(sanitizeLabel(''), 'resource');
  // `_` is a legal first character, so an all-punctuation name needs no prefix.
  assert.equal(sanitizeLabel('...'), '___');
  assert.equal(suggestAddress('aws_sqs_queue', 'orders.fifo'), 'aws_sqs_queue.orders_fifo');
});

test('dedupeAddresses renames suggestions only, never state addresses', () => {
  const items = [
    block({ address: 'aws_security_group.default', addressIsSuggestion: true }),
    block({ address: 'aws_security_group.default', addressIsSuggestion: true }),
    block({ address: 'aws_security_group.default', addressIsSuggestion: true }),
  ];
  assert.deepEqual(
    dedupeAddresses(items).map((i) => i.address),
    ['aws_security_group.default', 'aws_security_group.default_2', 'aws_security_group.default_3'],
  );

  // An authoritative address wins; the suggestion moves out of its way.
  const mixed = [
    block({ address: 'aws_vpc.main', addressIsSuggestion: true }),
    block({ address: 'aws_vpc.main', addressIsSuggestion: false }),
  ];
  assert.deepEqual(
    dedupeAddresses(mixed).map((i) => i.address),
    ['aws_vpc.main_2', 'aws_vpc.main'],
  );
});

test('emitBlock writes comments above the block and never a provider argument', () => {
  const text = emitBlock(
    block({ comments: ['account 111122223333 · region eu-west-1', 'VERIFY: no rule for aws_vpc'] }),
  );
  assert.equal(
    text,
    [
      '# account 111122223333 · region eu-west-1',
      '# VERIFY: no rule for aws_vpc',
      'import {',
      '  to = aws_vpc.main',
      '  id = "vpc-123"',
      '}',
    ].join('\n'),
  );
  assert.ok(!text.includes('provider ='));
});

test('a resolution with no terraform type is emitted fully commented out', () => {
  const text = emitBlock(block({ type: '', address: '', comments: ['VERIFY: unknown kind'] }));
  assert.equal(
    text,
    [
      '# VERIFY: unknown kind',
      '# import {',
      '#   to = <replace with the terraform type and a name, e.g. aws_vpc.main>',
      '#   id = "vpc-123"',
      '# }',
    ].join('\n'),
  );
  // The two properties that make the placeholder worth having, asserted rather
  // than left to the string above: no line ends in whitespace (`  to = ` did,
  // which some editors strip and every reviewer queries), and the stand-in
  // cannot parse as HCL, so uncommenting without filling it in fails loudly at
  // this line instead of resolving to something.
  for (const line of text.split('\n')) assert.equal(line, line.trimEnd());
  assert.ok(text.includes('to = <'));
});

test('an empty address is filled even when the block is not commented out', () => {
  // The placeholder keys on the address, not the type. Nothing in this package
  // produces a typed resolution with no address — `from-scanned.ts` clears both
  // together and the state path takes its type from the state file — but this
  // is the case where a dangling `to = ` would reach a .tf file *uncommented*,
  // as live invalid HCL, so the guard covers it rather than assuming the two
  // fields stay coupled.
  const text = emitBlock(block({ address: '' }));
  assert.ok(!text.startsWith('#'));
  assert.match(text, /^ {2}to = <replace with the terraform type and a name/m);
});

test('emitBlocks separates blocks by a blank line and ends with one newline', () => {
  assert.equal(emitBlocks([]), '');
  const text = emitBlocks([block({}), block({ address: 'aws_vpc.other', id: 'vpc-456' })]);
  assert.equal(text.split('\n\n').length, 2);
  assert.ok(text.endsWith('}\n'));
  assert.ok(!text.endsWith('}\n\n'));
});

test('parseArn splits ARNs and rejects everything else', () => {
  assert.deepEqual(parseArn('arn:aws:sqs:eu-west-1:111122223333:orders'), {
    partition: 'aws',
    service: 'sqs',
    region: 'eu-west-1',
    accountId: '111122223333',
    resource: 'orders',
  });
  // S3 discloses neither region nor account; the resource keeps its slashes.
  assert.deepEqual(parseArn('arn:aws:s3:::bucket/some/key'), {
    partition: 'aws',
    service: 's3',
    region: '',
    accountId: '',
    resource: 'bucket/some/key',
  });
  // Colons inside the resource are part of it, not extra fields.
  assert.equal(
    parseArn('arn:aws:lambda:eu-west-1:111122223333:function:worker')?.resource,
    'function:worker',
  );
  assert.equal(parseArn('vpc-123'), undefined);
  assert.equal(parseArn(undefined), undefined);
  assert.equal(parseArn('arn:aws:s3'), undefined);
});

test('parseStateFile skips data sources, other providers and deposed instances', () => {
  const parsed = parseStateFile(
    {
      version: 4,
      resources: [
        {
          mode: 'managed',
          type: 'aws_vpc',
          name: 'main',
          instances: [
            { attributes: { id: 'vpc-live' } },
            { deposed: 'a1b2c3d4', attributes: { id: 'vpc-deposed' } },
          ],
        },
        { mode: 'data', type: 'aws_ami', name: 'x', instances: [{ attributes: { id: 'ami-1' } }] },
        {
          mode: 'managed',
          type: 'random_password',
          name: 'p',
          instances: [{ attributes: { id: 'none' } }],
        },
      ],
    },
    'inline',
  );
  assert.deepEqual(
    parsed.resources.map((r) => r.attributes['id']),
    ['vpc-live'],
  );
  assert.deepEqual(parsed.skipped, { deposed: 1, dataSources: 1, nonAws: 1 });
});

test('parseStateFile accepts terraform show -json and walks child modules', () => {
  const parsed = parseStateFile(
    {
      format_version: '1.0',
      terraform_version: '1.9.8',
      values: {
        root_module: {
          resources: [
            { address: 'aws_vpc.main', mode: 'managed', type: 'aws_vpc', values: { id: 'vpc-1' } },
          ],
          child_modules: [
            {
              resources: [
                {
                  address: 'module.net.aws_subnet.a',
                  mode: 'managed',
                  type: 'aws_subnet',
                  values: { id: 'subnet-1' },
                },
              ],
            },
          ],
        },
      },
    },
    'inline',
  );
  assert.deepEqual(
    parsed.resources.map((r) => r.address),
    ['aws_vpc.main', 'module.net.aws_subnet.a'],
  );
});

test('parseStateFile rejects formats it cannot read rather than guessing', () => {
  assert.throws(() => parseStateFile({ version: 3, resources: [] }, 'old.tfstate'), /version 3/);
  assert.throws(() => parseStateFile({ hello: 'world' }, 'junk.json'), /unrecognized format/);
  assert.throws(() => parseStateFile([], 'array.json'), /not a JSON object/);
});
