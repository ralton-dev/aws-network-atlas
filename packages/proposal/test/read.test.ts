/**
 * `@atlas/proposal/read`: YAML → `Proposal`, and `site/data/*.js` → value with
 * no `eval`.
 *
 * `readScriptPayload` must reverse exactly what the scanner's
 * `jsonScriptPayload` (`packages/scanner/src/bundle.ts`) writes. That function
 * is reproduced below verbatim rather than imported — importing the scanner's
 * bundle module from this package would drag its config and AWS imports into
 * a pure package's tests — and the committed `site/data/data.js` is read too,
 * so a change to the real escaping fails here on real bytes.
 *
 * Shapes it still avoids: YAML anchors and aliases; a multi-document YAML
 * file; a `data.js` written by some other tool with different whitespace.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { applyProposal, diffSnapshots, validateProposal, type Proposal } from '../src/index.js';
import { parseProposal, ProposalParseError, readScriptPayload, readSiteData } from '../src/read.js';
import { GENERATED_AT, newSpoke } from './estate.js';

/** Verbatim from `packages/scanner/src/bundle.ts` at 35ebcbe. */
function jsonScriptPayload(globalName: string, value: unknown): string {
  const payload = JSON.stringify(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `window.${globalName}=JSON.parse('${payload}');\n`;
}

const ROOT = path.resolve(import.meta.dirname, '../../..');

test('readScriptPayload reverses jsonScriptPayload on the awkward strings', () => {
  const value = {
    quote: "it's",
    backslash: 'C:\\path\\to',
    newline: 'a\nb\tc',
    lineSeparators: 'x\u2028y\u2029z',
    literalEscapeText: 'the six characters \\u2028 and \\\'',
    script: '</script><script>alert(1)</script>',
    unicode: 'café ☕ 𝄞',
    nested: [{ deep: ["'\\'"] }],
  };
  const text = jsonScriptPayload('__ATLAS_DATA__', value);
  assert.deepEqual(readScriptPayload(text), value);
});

test('readScriptPayload rejects anything but the one-assignment script', () => {
  assert.throws(() => readScriptPayload('{"a":1}'), /window\.NAME/);
  assert.throws(() => readScriptPayload("alert(1);window.X=JSON.parse('{}');"), /window\.NAME/);
  assert.throws(() => readScriptPayload("window.X=JSON.parse('{}');alert(1)"), /after/);
  assert.throws(() => readScriptPayload("window.X=JSON.parse('{\\n}');"), /unexpected escape/);
  assert.throws(() => readScriptPayload("window.X=JSON.parse('{}"), /unterminated/);
});

test('readSiteData reads the committed site/data/data.js', () => {
  const snapshot = readSiteData(readFileSync(path.join(ROOT, 'site/data/data.js'), 'utf8'));
  assert.equal(snapshot.accounts.length, 3);
  assert.match(snapshot.generatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.throws(() => readSiteData(jsonScriptPayload('__ATLAS_ANNOTATIONS__', {})), /not a snapshot/);
});

const YAML = `
version: 1
title: Add a data-platform spoke joined to the core TGW
description: |
  Why this change.
base:
  generatedAt: ${GENERATED_AT}
accounts:
  - accountId: "555555555555"
    alias: acme-data
    regions: [eu-west-1]
changes:
  - op: add
    account: "555555555555"
    region: eu-west-1
    collection: vpcs
    resource:
      id: proposed-vpc-data
      name: data-vpc
      tags: {}
      cidrBlocks: ["10.3.0.0/16"]
      ipv6CidrBlocks: []
      isDefault: false
  - op: add
    account: "555555555555"
    region: eu-west-1
    collection: transitGatewayAttachments
    resource:
      id: proposed-attach-data
      tags: {}
      transitGatewayId: tgw-0a1b2c3d4e5f00001
      transitGatewayOwnerId: "222222222222"
      resourceOwnerId: "555555555555"
      resourceType: vpc
      resourceId: proposed-vpc-data
      subnetIds: []
`;

test('parseProposal: the decision-44 YAML becomes the typed proposal, id from the file stem, timestamp kept a string', () => {
  const parsed = parseProposal(YAML, 'new-spoke');
  const expected: Proposal = { ...newSpoke(), description: 'Why this change.\n' };
  assert.deepEqual(parsed, expected);
  assert.equal(typeof parsed.base.generatedAt, 'string', 'an unquoted ISO timestamp must not become a Date');
});

const issuesOf = (text: string): string[] => {
  try {
    parseProposal(text, 'x');
  } catch (error) {
    assert.ok(error instanceof ProposalParseError);
    return error.issues.map((i) => `${i.path ?? '-'}: ${i.message}`);
  }
  assert.fail('expected a ProposalParseError');
};

test('parseProposal reports bad YAML with its line, and bad shapes by path', () => {
  assert.match(issuesOf('version: 1\ntitle: [unclosed\n')[0] ?? '', /^line \d+, column \d+: not valid YAML/);
  assert.deepEqual(issuesOf('id: mine\nversion: 1\n'), ["id: do not write `id`; a proposal's id is its file name"]);
  const unquoted = issuesOf(YAML.replace('accountId: "555555555555"', 'accountId: 555555555555'));
  assert.equal(unquoted.length, 1);
  assert.match(unquoted[0] ?? '', /^accounts\[0\]\.accountId: expected a string; quote account ids/);
  assert.deepEqual(issuesOf(YAML.replace('changes:', 'chagnes:')), [
    'chagnes: unknown field `chagnes`; expected one of id, version, title, description, base, accounts, changes',
    'changes: required; expected a list of ops (`op: add | change | remove`)',
  ]);
});

test('measure: 200 ops applied to the committed fixture snapshot, then validated and diffed', () => {
  const base = readSiteData(readFileSync(path.join(ROOT, 'site/data/data.js'), 'utf8'));
  const first = base.accounts[0];
  const region = first?.regions[0];
  assert.ok(first && region);
  const changes: Proposal['changes'] = [];
  for (let i = 0; i < 100; i++) {
    changes.push({ op: 'add', account: first.accountId, region: region.region, collection: 'subnets', resource: { id: `proposed-subnet-${i}`, tags: {}, cidrBlock: `10.250.${i}.0/24` } });
    changes.push({ op: 'change', key: `proposed-subnet-${i}`, set: { name: `subnet ${i}` } });
  }
  const proposal: Proposal = { id: 'bench', version: 1, title: 'bench', base: { generatedAt: base.generatedAt }, changes };

  const runs: number[] = [];
  for (let r = 0; r < 7; r++) {
    const t0 = performance.now();
    applyProposal(base, proposal);
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  const median = runs[3] ?? Infinity;
  const t1 = performance.now();
  const issues = validateProposal(base, proposal);
  const validateMs = performance.now() - t1;
  const t2 = performance.now();
  const diff = diffSnapshots(base, applyProposal(base, proposal));
  const diffMs = performance.now() - t2;

  console.log(`# applyProposal 200 ops on site/data/data.js: median ${median.toFixed(2)} ms (min ${runs[0]?.toFixed(2)}, max ${runs[6]?.toFixed(2)}); validate ${validateMs.toFixed(2)} ms; apply+diff ${diffMs.toFixed(2)} ms`);
  assert.deepEqual(issues, []);
  assert.equal(diff.added.length, 100);
  // The plan's budget is 50 ms; the assertion is looser so a busy machine does not flake the gate.
  assert.ok(median < 200, `applyProposal took ${median} ms`);
});
