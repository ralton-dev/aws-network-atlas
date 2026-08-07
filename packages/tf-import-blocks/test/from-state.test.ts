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
import { CONFLICTS, mergeRules } from '../src/rules/registry.js';

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

// ── tainted objects ────────────────────────────────────────────────────────
//
// version4.go:704 spells it `instances[].status: "tainted"`; jsonstate/state.go
// :111 spells it `"tainted": true` on the resource entry. Same hazard class as
// deposed — terraform is going to destroy and recreate the object — and far
// more common, since any failed provisioner or interrupted apply leaves one.
//
// The decision is deliberately NOT the deposed one, because the two differ in
// the only way that matters. A deposed object is the old half of a replace: it
// has a live sibling at the same address, so emitting it is both invalid HCL
// and an adoption of something scheduled for destruction, and there is a
// correct block to emit in its place. A tainted object is the ONLY object at
// its address, it exists in AWS right now, and its id is the real id. Skipping
// it would drop a resource from a state move with no substitute — precisely
// what decision 5 forbids.
//
// So it is emitted, flagged, and counted. Counted apart from `skipped`, because
// it is not skipped and pooling the two would make both numbers lies.

test('a tainted instance is emitted and flagged, not skipped (raw v4)', () => {
  const parsed = parseStateFile(fixture('two-account.tfstate.json'), 'two-account.tfstate.json');
  assert.equal(parsed.tainted, 1);
  assert.equal(parsed.skipped.deposed, 0);

  const web = blockAt('two-account.tfstate.json', 'aws_instance.web');
  assert.equal(web.id, 'i-0f9e8d7c6b5a40312');
  // The id is real and the block is usable: taint is state metadata, it does
  // not travel through an import, and the adopting state gets a clean entry.
  assert.equal(web.verified, true);
  assert.equal(web.comments.filter((c) => c.startsWith('TAINTED')).length, 1);
});

test('a tainted resource entry is flagged on the show -json path too', () => {
  const parsed = parseStateFile(fixture('awkward-show.json'), 'awkward-show.json');
  // Three entries carry taint in that fixture — but one of them is the deposed
  // aws_lb, which is skipped, and a skipped instance must not also be counted
  // as emitted-and-flagged. Deposed wins; the count is of blocks in the output.
  assert.equal(parsed.tainted, 1);
  const bastion = blockAt('awkward-show.json', 'aws_instance.bastion');
  assert.equal(bastion.comments.filter((c) => c.startsWith('TAINTED')).length, 1);

  const hcl = emitBlocks(importsFromState(fixture('awkward-show.json'), 'awkward-show.json'));
  assert.equal(hcl.match(/^# TAINTED/gm)?.length, 1);
});

// ── provenance: the provider configuration address ─────────────────────────
//
// Decision 10 forbids emitting a `provider =` argument, because we cannot know
// the user's alias names, and mitigates the wrong-account paste with a comment
// instead. But the only thing that fired was `# account … · region …`, computed
// from an `arn` *attribute* — and plenty of types have none. On this two-account
// state four of eight blocks carried no provenance whatsoever, and the worst of
// them was module.dr.aws_route.dr_default: a resource in the DR account, no
// `arn` attribute, and therefore silent. That is exactly the cross-account paste
// decision 10 exists to warn about, unmitigated.
//
// The state does carry the answer. `resources[].provider` (version4.go:698) is
// the provider *configuration* address, alias and all, and nothing in the repo
// read it. Naming an alias is not an attribute value, so decision 6 is intact.

test('an aliased provider is named, and the root default provider is not', () => {
  const provOf = (address: string): string[] =>
    blockAt('two-account.tfstate.json', address).comments.filter((c) =>
      c.startsWith('source provider'),
    );

  // The block that had nothing at all: no arn attribute, other account.
  const route = provOf('module.dr.aws_route.dr_default');
  assert.equal(route.length, 1);
  assert.match(route[0] ?? '', /aws\.usw2/);
  assert.match(provOf('aws_vpc.dr')[0] ?? '', /aws\.usw2/);

  // Silence for the root default provider is the point, not an oversight: it is
  // the provider the target already uses, so a line would be noise — and this
  // is what keeps awkward.expected.tf byte-identical.
  assert.deepEqual(provOf('aws_vpc.main'), []);
  assert.deepEqual(provOf('aws_instance.web'), []);

  // A provider configured inside a module is not the root provider either. Its
  // resources are necessarily inside that module too — a provider cannot be
  // passed upward — so the fixture puts the bucket where such a config can
  // actually reach it.
  assert.match(provOf('module.legacy.aws_s3_bucket.logs')[0] ?? '', /module\.legacy\.aws/);
});

test('the provider advice matches where terraform will accept it', () => {
  // internal/configs/import.go:80-90 — the `provider` argument is rejected with
  // "Invalid import provider argument" when the `to` address is inside a
  // module, and the user is directed to the module block's `providers` instead.
  // Advice that ignores that sends someone to paste a config terraform refuses.
  const root = blockAt('two-account.tfstate.json', 'aws_vpc.dr').comments.join(' ');
  assert.match(root, /provider = aws\./);

  const inModule = blockAt('two-account.tfstate.json', 'module.dr.aws_route.dr_default').comments
    .join(' ');
  assert.doesNotMatch(inModule, /provider = aws\./);
  assert.match(inModule, /providers argument/);
});

test('every block outside the root default provider carries provenance', () => {
  // The invariant worth holding: a resource reached through an aliased or
  // module-scoped provider is never silent about it. Root-default resources
  // with no ARN stay silent, because the state genuinely says nothing about
  // them — and they are the least dangerous case, being the provider the target
  // already uses.
  const items = importsFromState(fixture('two-account.tfstate.json'), 'two-account.tfstate.json');
  const silent = items.filter(
    (i) => !i.comments.some((c) => c.startsWith('account') || c.startsWith('source provider')),
  );
  assert.deepEqual(
    silent.map((i) => i.address),
    ['aws_route53_record.legacy', 'aws_security_group_rule.legacy_ingress'],
  );
});

test('an empty ARN region means global for a global service, not unknown', () => {
  // `arn:aws:iam::111122223333:role/app-task` has an empty region field because
  // IAM is global, and the answer is knowable. It read "region unknown", which
  // is ignorance where there is none. S3 is the reason the general rule cannot
  // be "empty means global" — a bucket ARN omits the region and buckets are
  // regional — so this is a whitelist of services that are themselves global,
  // and aws_s3_bucket.logs is in the fixture to prove S3 stays out of it.
  const role = blockAt('two-account.tfstate.json', 'aws_iam_role.app');
  assert.equal(role.region, '');
  assert.ok(role.comments.includes('account 111122223333 · region global'));

  const bucket = blockAt('two-account.tfstate.json', 'module.legacy.aws_s3_bucket.logs');
  assert.equal(bucket.region, undefined);
  assert.deepEqual(
    bucket.comments.filter((c) => c.startsWith('account')),
    [],
  );
});

test('decision 6: no attribute value reaches the output but the import id', () => {
  // The guard on everything above: provenance may name an account, a region or
  // an alias, and nothing else. Raw state attributes routinely hold secrets.
  const awkward = emitBlocks(importsFromState(fixture('awkward.tfstate.json'), 'awkward'));
  assert.ok(!awkward.includes('never-emitted-decision-6'));

  const twoAccount = emitBlocks(
    importsFromState(fixture('two-account.tfstate.json'), 'two-account'),
  );
  for (const attributeValue of ['10.0.0.0/16', '10.9.0.0/16', 't3.micro', '10.0.1.9']) {
    assert.ok(!twoAccount.includes(attributeValue), `leaked attribute value ${attributeValue}`);
  }
});

test('the 0.12 spelling of a provider config address is read too', () => {
  // Pre-0.13 states write `provider.aws[.alias]` rather than
  // `provider["registry.terraform.io/hashicorp/aws"][.alias]`. A state old
  // enough to hold flatmap instances is exactly the state old enough to hold
  // this spelling, so refusing to read it would strand the two together.
  const items = importsFromState(
    {
      version: 4,
      resources: [
        {
          mode: 'managed',
          type: 'aws_vpc',
          name: 'dr',
          provider: 'provider.aws.usw2',
          instances: [{ attributes: { id: 'vpc-legacy' } }],
        },
        {
          mode: 'managed',
          type: 'aws_vpc',
          name: 'main',
          provider: 'provider.aws',
          instances: [{ attributes: { id: 'vpc-root' } }],
        },
        {
          // Unparseable: no claim is better than a wrong claim about which
          // account a resource lives in.
          mode: 'managed',
          type: 'aws_vpc',
          name: 'odd',
          provider: 'something else entirely',
          instances: [{ attributes: { id: 'vpc-odd' } }],
        },
      ],
    },
    'inline',
  );
  const prov = (address: string): string[] =>
    items.find((i) => i.address === address)?.comments.filter((c) => c.startsWith('source')) ?? [];
  assert.match(prov('aws_vpc.dr')[0] ?? '', /source provider aws\.usw2/);
  assert.deepEqual(prov('aws_vpc.main'), []);
  assert.deepEqual(prov('aws_vpc.odd'), []);
});

// ── the rule registry's merge ──────────────────────────────────────────────
//
// Not state parsing, and it lives here only because there is nowhere else: the
// registry is this package's file and every other test file in it is owned
// elsewhere. It is tested at all because with one module declaring each type,
// every branch of the merge is unreachable from the real tables — a defect in
// it is invisible until the day a second module declares a type, which is the
// worst possible moment to find one.

test('the merge carries every field a second declaration adds', () => {
  // `typeFromScanned` and `typeChoices` were not in the per-field loop, so a
  // second module declaring the same type with one had it dropped — silently,
  // and with no CONFLICTS entry to show for it. The type would then resolve
  // through `ImportRule.type`, which for an ambiguous kind is explicitly an
  // arbitrary member of the set rather than a claim (see types.ts) — a
  // confidently wrong `to =`, arrived at by omission.
  const merged = mergeRules([
    [{ type: 'aws_lb', kinds: ['lb'], fromScanned: (s) => s.id }],
    [
      {
        type: 'aws_lb',
        typeFromScanned: () => 'aws_elb',
        typeChoices: ['aws_lb', 'aws_elb'],
        fromState: (a) => (typeof a['id'] === 'string' ? a['id'] : undefined),
      },
    ],
  ]);
  const rule = merged.byType.get('aws_lb');
  assert.ok(rule !== undefined);
  assert.equal(rule.fromScanned?.({ kind: 'lb', id: 'x', region: '', accountId: '', raw: {} }), 'x');
  assert.equal(rule.fromState?.({ id: 'y' }), 'y');
  assert.deepEqual(rule.typeChoices, ['aws_lb', 'aws_elb']);
  assert.equal(
    rule.typeFromScanned?.({ kind: 'lb', id: 'x', region: '', accountId: '', raw: {} }),
    'aws_elb',
  );
  assert.deepEqual(merged.conflicts, []);
});

test('two declarations of one field are a conflict, first wins', () => {
  const merged = mergeRules([
    [{ type: 'aws_lb', typeFromScanned: () => 'aws_lb', typeChoices: ['aws_lb', 'aws_elb'] }],
    [{ type: 'aws_lb', typeFromScanned: () => 'aws_elb', typeChoices: ['aws_elb'] }],
  ]);
  assert.deepEqual(merged.conflicts, [
    { type: 'aws_lb', field: 'typeFromScanned' },
    { type: 'aws_lb', field: 'typeChoices' },
  ]);
  assert.equal(
    merged.byType.get('aws_lb')?.typeFromScanned?.({
      kind: 'lb',
      id: 'x',
      region: '',
      accountId: '',
      raw: {},
    }),
    'aws_lb',
  );
});

test('the real rule tables agree with each other', () => {
  // The guard the above exists to make meaningful: with the merge now covering
  // every field, an empty CONFLICTS is a statement about all five of them.
  assert.deepEqual(CONFLICTS, []);
});

test('a resource with no id at all says so rather than emitting a bare id = ""', () => {
  // The residue of the assumption the whole package relaxes: "the import id is
  // the id" also assumes there is one. `terraform show -json` omits `values`
  // entirely for a resource whose state could not be read, and the flatmap
  // defect produced the same shape from the other direction — a block reading
  // `id = ""` under a comment about a rule, which is easy to skim past.
  const items = importsFromState(
    {
      format_version: '1.0',
      values: {
        root_module: {
          resources: [{ address: 'aws_vpc.main', mode: 'managed', type: 'aws_vpc' }],
        },
      },
    },
    'inline',
  );
  assert.equal(items[0]?.id, '');
  assert.equal(items[0]?.verified, false);
  assert.match(items[0]?.comments.join(' ') ?? '', /no id for aws_vpc\.main/);
});
