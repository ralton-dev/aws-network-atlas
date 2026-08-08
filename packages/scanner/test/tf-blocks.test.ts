/**
 * `atlas-scan tf-blocks` — the CLI half of the golden assertion.
 *
 * `tf-import-blocks/test/golden.test.ts` proves the *package* emits the golden
 * file. This proves the *command* does too, which is not the same claim: the
 * command reads and sorts the state itself (it needs the parse's skip counts
 * for the stderr summary, which `importsFromState` does not return), so the two
 * orderings could drift apart with both halves still looking correct. This test
 * is the thing that would notice.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatSummary, tfBlocks } from '../src/tf-blocks.js';

const resolver = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Read out of *whatever copy of the package is installed*, never out of a path
 * inside this repo. `tf-import-blocks` is an npm dependency now, so
 * `packages/tf-import-blocks/test/fixtures` does not exist; the package ships
 * `test/fixtures/` in its tarball and exports `./package.json` precisely so the
 * package root is nameable from here (without that export Node answers
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` and there is no supported way to find it).
 *
 * It also keeps the golden honest: the file compared against is the one
 * versioned with the emitter that produced it, so a local copy cannot go stale
 * the first time the package legitimately changes its output.
 */
const FIXTURES = path.join(
  path.dirname(resolver.resolve('tf-import-blocks/package.json')),
  'test',
  'fixtures',
);
const STATE = path.join(FIXTURES, 'awkward.tfstate.json');

/** `##` lines in the golden are annotations for the reader, not expected output. */
function stripAnnotations(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('##'))
    .join('\n');
}

test('tf-blocks reproduces the golden file from the awkward state', async () => {
  const { hcl, summary } = await tfBlocks({ files: [STATE], cwd: REPO_ROOT });
  const golden = stripAnnotations(await readFile(path.join(FIXTURES, 'awkward.expected.tf'), 'utf8'));
  assert.equal(hcl, golden);

  assert.equal(summary.total, 15);
  assert.equal(summary.viaRule, 14);
  assert.equal(summary.fallback, 1);
  assert.deepEqual(summary.noRuleTypes, ['aws_s3_object']);
  // The deposed aws_nat_gateway. One address, one block — and the count is
  // surfaced, because a silently dropped resource is the worst failure mode of
  // a state move.
  assert.equal(summary.skippedDeposed, 1);
  assert.equal(summary.skippedDataSources, 1);
  assert.equal(summary.skippedNonAws, 1);
  assert.deepEqual(summary.duplicateAddresses, []);
});

test('--filter emits only the matching address subtree', async () => {
  const { hcl, summary } = await tfBlocks({
    files: [STATE],
    filter: 'module.net.',
    cwd: REPO_ROOT,
  });
  assert.equal(summary.total, 1);
  assert.equal(summary.filteredOut, 14);
  assert.match(hcl, /to = module\.net\.aws_subnet\.private\["eu-west-1a"\]/);
  assert.equal(hcl.match(/^import \{$/gm)?.length, 1);
});

test('a not-importable type is counted apart from a # VERIFY fallback', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tf-blocks-'));
  const file = path.join(dir, 'terraform.tfstate');
  await writeFile(
    file,
    JSON.stringify({
      version: 4,
      terraform_version: '1.9.8',
      resources: [
        {
          mode: 'managed',
          type: 'aws_vpn_gateway_attachment',
          name: 'vgw',
          instances: [{ attributes: { id: 'vpn-gateway-attachment-id', vpc_id: 'vpc-1' } }],
        },
        {
          mode: 'managed',
          type: 'aws_totally_made_up_thing',
          name: 'x',
          instances: [{ attributes: { id: 'made-up-1' } }],
        },
      ],
    }),
    'utf8',
  );
  try {
    const { hcl, summary } = await tfBlocks({ files: [file], cwd: dir });
    // "we know this cannot be imported" and "we don't know the id" are different
    // problems with different remedies, so they are never pooled into one count.
    assert.equal(summary.notImportable, 1);
    assert.deepEqual(summary.notImportableTypes, ['aws_vpn_gateway_attachment']);
    assert.equal(summary.fallback, 1);
    assert.deepEqual(summary.noRuleTypes, ['aws_totally_made_up_thing']);
    assert.equal(summary.viaRule, 0);
    assert.match(hcl, /# NOT IMPORTABLE: aws_vpn_gateway_attachment/);
    assert.match(hcl, /# VERIFY: no rule for aws_totally_made_up_thing/);

    const lines = formatSummary(summary).join('\n');
    assert.match(lines, /not importable at all/);
    assert.match(lines, /flagged # VERIFY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
