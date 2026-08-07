/**
 * The state reader against states shaped like real ones.
 *
 * `awkward.tfstate.json` is a raw v4 state with one provider, no aliases, and a
 * populated `attributes` object on every instance. Real states are not like
 * that, and every defect this file pins lived in the gap:
 *
 *   - `terraform show -json` spells a deposed object completely differently
 *     from raw v4, and the show-json parser did not know the spelling.
 *   - a legacy flatmap instance keeps its attributes under `attributes_flat`,
 *     so reading only `attributes` sees an empty resource.
 *   - `status: "tainted"` / `"tainted": true` marks an object terraform will
 *     destroy and recreate. Far more common than deposed, and unmarked.
 *   - a state spanning two accounts distinguishes them with a provider alias,
 *     which is the one piece of cross-account provenance a state file actually
 *     carries — and nothing read it.
 *
 * Every format claim here was verified against terraform's own source on `main`
 * (2026-08-08), cited inline, because the two formats agree on nothing:
 *   internal/states/statefile/version4.go   — raw v4
 *   internal/command/jsonstate/state.go     — terraform show -json
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { emitBlocks, importsFromState, parseStateFile, type ResolvedImport } from '../src/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as unknown;
}

/** One resolved block by address; fails loudly rather than returning undefined. */
function blockAt(file: string, address: string): ResolvedImport {
  const items = importsFromState(fixture(file), file);
  const found = items.find((i) => i.address === address);
  assert.ok(found !== undefined, `${file}: no block at ${address}`);
  return found;
}

/** Addresses appearing more than once — the thing that makes HCL invalid. */
function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes].sort();
}

// ── deposed, on the terraform show -json path ──────────────────────────────
//
// jsonstate/state.go marshalResources (lines ~481-529): for every deposed
// object terraform appends a *separate* Resource entry whose `Address` is
// assigned `current.Address` — the same string as the live object's — and sets
// `DeposedKey`. There is no nesting and no address suffix; `deposed_key` is the
// only thing that distinguishes the two entries.
//
// The raw-v4 parser has always dropped deposed instances. The show-json parser
// pushed every entry, so one address produced two `import` blocks: HCL
// terraform rejects outright, and the second block adopts the object terraform
// is about to destroy. The skip count read 0 while they sat in the output, so
// the CLI's stderr summary said "no deposed instances" truthfully and wrongly.

test('show -json: a deposed entry is skipped, not emitted as a second block', () => {
  const parsed = parseStateFile(fixture('awkward-show.json'), 'awkward-show.json');

  assert.deepEqual(duplicates(parsed.resources.map((r) => r.address)), []);
  // Both deposed objects: one at the root, one inside module.net, so the child
  // walk is covered too. The second is also `"tainted": true` — terraform sets
  // Tainted on deposed objects as well (state.go ~526) — which must not stop it
  // being counted as deposed.
  assert.equal(parsed.skipped.deposed, 2);
  assert.equal(parsed.skipped.dataSources, 1);
  assert.equal(parsed.skipped.nonAws, 1);

  const hcl = emitBlocks(importsFromState(fixture('awkward-show.json'), 'awkward-show.json'));
  assert.equal(hcl.match(/^ {2}to = aws_nat_gateway\.ngw\[0\]$/gm)?.length, 1);
  assert.equal(hcl.match(/^ {2}to = module\.net\.aws_lb\.edge$/gm)?.length, 1);
  // The live object is adopted and the deposed one is nowhere in the output.
  assert.ok(hcl.includes('nat-05dba92075d71c408'));
  assert.ok(!hcl.includes('nat-0deadbeefdeadbeef'));
  assert.ok(!hcl.includes('9999dead8888beef'));
});

test('show -json: every emitted address is unique across the whole document', () => {
  // The invariant the CLI's duplicateAddresses warning exists to catch. Asserted
  // here too because the emitter never renames a state address (it is
  // authoritative), so a duplicate reaches the user as broken HCL.
  const items = importsFromState(fixture('awkward-show.json'), 'awkward-show.json');
  assert.deepEqual(duplicates(items.map((i) => i.address)), []);
  assert.deepEqual(
    items.map((i) => i.address),
    [
      'aws_instance.bastion',
      'aws_nat_gateway.ngw[0]',
      'aws_vpc.main',
      'module.net.aws_lb.edge',
      'module.net.aws_subnet.private["eu-west-1a"]',
    ],
  );
});

// ── legacy flatmap instances ───────────────────────────────────────────────
//
// version4.go:708-709 — an instance object carries EITHER `attributes` (raw
// JSON, every provider since 0.12) OR `attributes_flat` (map[string]string, the
// pre-0.12 flatmap a legacy SDK provider wrote and terraform still round-trips
// until the resource is next written). They are mutually exclusive.
//
// Reading only `attributes` yielded `{}` for a flatmap instance, so the block
// emitted `id = ""` and explained itself with "falling back to the state id" —
// while the state id was sitting one key away in `attributes_flat`. Both the id
// and the explanation were wrong, which is the pair that makes a defect
// expensive: the reader is told where to look and it is the wrong place.

test('a flatmap instance resolves from attributes_flat, not to an empty id', () => {
  // Every part of a route53 record id is a top-level flatmap key, so the
  // composite rule computes exactly what it computes from a modern instance.
  const record = blockAt('two-account.tfstate.json', 'aws_route53_record.legacy');
  assert.equal(record.id, 'Z4KAPRWWNC7JR_www.example.com_A');
  assert.equal(record.verified, true);
  assert.deepEqual(
    record.comments.filter((c) => c.startsWith('VERIFY')),
    [],
  );
});

test('a flatmap instance a rule cannot read says so, and still carries its id', () => {
  // Flatmap flattens lists: `cidr_blocks` is `cidr_blocks.#` / `cidr_blocks.0`,
  // which the security-group-rule resolver cannot read, so it declines. That is
  // the honest outcome — the fallback id `sgrule-<hash>` is not importable and
  // the block is flagged — but the comment must name the real reason, because
  // "could not compute an import id from this state" sends a reader to check a
  // rule that is working correctly.
  const rule = blockAt('two-account.tfstate.json', 'aws_security_group_rule.legacy_ingress');
  assert.equal(rule.id, 'sgrule-1859128000');
  assert.equal(rule.verified, false);
  const verify = rule.comments.filter((c) => c.startsWith('VERIFY')).join(' ');
  assert.match(verify, /flatmap/);
});
