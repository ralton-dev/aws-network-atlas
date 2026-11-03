/**
 * The viewer's proposal model in `src/model/proposal.ts` (PROPOSAL-OVERLAY.md
 * WP-3), pinned: the proposed index is a stable object per (index, proposal)
 * and is built without touching the current index; the ChangeSet agrees with
 * it; accounts a proposal creates join the effective selection (decision 52);
 * and the `proposal=` URL param reads and writes on every route (decision 51).
 *
 * The estate is a two-account miniature — hub `222…` owning a TGW, spoke
 * `111…` attached — built through the real `buildIndex()` with no arguments
 * by setting `window.__ATLAS_DATA__`, as the app and `proposal.test.ts` do.
 * The proposal adds account `555…` with a VPC, and changes the spoke's VPC.
 *
 * Shapes it avoids: a proposal that removes an account, a proposal applied to
 * a `withAccounts` derivative (documented as wrong, not tested), global
 * collections (the `'global'` / `''` region mismatch is documented only), and
 * the graph builders — `proposal.test.ts` covers the diff over two graphs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Proposal } from '@atlas/proposal';
import { emptyGlobal, emptyRegionSnapshot, type AccountSnapshot, type Snapshot } from '@atlas/schema';
import { buildIndex, type AtlasIndex } from '../src/data.js';
import {
  changeSetFor,
  effectiveAccounts,
  loadProposals,
  parseProposalParam,
  proposedIndex,
  withProposalParam,
} from '../src/model/proposal.js';
import { withAccounts } from '../src/model/selection.js';

const SPOKE = '111111111111';
const HUB = '222222222222';
const NEW = '555555555555';
const REGION = 'eu-west-1';
const TGW = 'tgw-0a1b2c3d4e5f00001';
const GENERATED_AT = '2026-11-03T00:00:00Z';

function account(accountId: string, alias: string): AccountSnapshot {
  return {
    accountId, alias, profile: alias, scannedAt: GENERATED_AT, scannerVersion: 'test',
    regions: [emptyRegionSnapshot(REGION)], emptyRegions: [], global: emptyGlobal(),
  };
}

function estate(): Snapshot {
  const spoke = account(SPOKE, 'acme-prod');
  spoke.regions[0]!.vpcs.push({ id: 'vpc-0prod0000000001', name: 'prod-vpc', tags: {}, cidrBlocks: ['10.0.0.0/16'], ipv6CidrBlocks: [], isDefault: false });
  const hub = account(HUB, 'acme-shared');
  hub.regions[0]!.transitGateways.push({ id: TGW, name: 'core-tgw', tags: {}, ownerId: HUB });
  // A collection an older scanner never wrote: `buildIndex` fills it in place.
  delete (hub.regions[0] as Partial<(typeof hub.regions)[0]>).natGateways;
  return { version: 1, generatedAt: GENERATED_AT, accounts: [spoke, hub] };
}

function newSpoke(id = 'new-spoke'): Proposal {
  return {
    id,
    version: 1,
    title: 'A data spoke',
    base: { generatedAt: GENERATED_AT },
    accounts: [{ accountId: NEW, alias: 'acme-data', regions: [REGION] }],
    changes: [
      {
        op: 'add', account: NEW, region: REGION, collection: 'vpcs',
        resource: { id: 'proposed-vpc-data', name: 'data-vpc', tags: {}, cidrBlocks: ['10.3.0.0/16'], ipv6CidrBlocks: [], isDefault: false },
      },
      { op: 'change', key: 'vpc-0prod0000000001', set: { name: 'prod-vpc-renamed' } },
    ],
  };
}

function current(): AtlasIndex {
  (globalThis as { window?: Partial<Window> }).window = { __ATLAS_DATA__: estate() };
  return buildIndex();
}

test('proposedIndex is one stable object per (index, proposal id), and a new index builds a new one', () => {
  const index = current();
  const proposal = newSpoke();
  const a = proposedIndex(index, proposal);
  assert.equal(proposedIndex(index, proposal), a);
  assert.notEqual(a, index);

  // Another proposal on the same index, and the same proposal on another index, build afresh.
  const other = proposedIndex(index, newSpoke('other'));
  assert.notEqual(other, a);
  assert.equal(proposedIndex(index, newSpoke('other')) === other, false, 'a different object under an id rebuilds');
  assert.notEqual(proposedIndex(current(), proposal), a);
});

test('the proposed index sees the proposal and the current index is untouched', () => {
  const index = current();
  const before = structuredClone(index.snapshot);
  const allBefore = index.all.length;

  const proposed = proposedIndex(index, newSpoke());

  assert.deepStrictEqual(index.snapshot, before);
  assert.equal(index.all.length, allBefore);
  assert.equal(index.byKey.has('proposed-vpc-data'), false);
  assert.equal(index.byKey.get('vpc-0prod0000000001')?.name, 'prod-vpc');

  assert.equal(proposed.byKey.get('proposed-vpc-data')?.accountId, NEW);
  assert.equal(proposed.byKey.get('vpc-0prod0000000001')?.name, 'prod-vpc-renamed');
  assert.equal(proposed.accountLabel(NEW), `acme-data (${NEW})`);
  assert.equal(proposed.snapshot.accounts.find((a) => a.accountId === NEW)?.profile, 'proposal:new-spoke');
  assert.equal(proposed.annotations, index.annotations);
  assert.equal(proposed.terraform, index.terraform);
  // No snapshot object is shared, so normalising one can never reach the other.
  assert.notEqual(proposed.snapshot.accounts[0], index.snapshot.accounts[0]);
});

test('changeSetFor is memoised with the index and describes the same proposed snapshot', () => {
  const index = current();
  const proposal = newSpoke();
  const changes = changeSetFor(index, proposal);
  assert.equal(changeSetFor(index, proposal), changes);
  // Whichever is asked first, both come from one build.
  const proposed = proposedIndex(index, proposal);

  assert.deepStrictEqual(changes.addedAccounts, [NEW]);
  assert.deepStrictEqual(changes.removedAccounts, []);
  assert.deepStrictEqual(changes.added.map((d) => d.key), ['proposed-vpc-data']);
  assert.deepStrictEqual(changes.changed.map((c) => [c.key, c.fields]), [['vpc-0prod0000000001', ['name']]]);
  for (const d of changes.added) assert.ok(proposed.byKey.has(d.key));
  for (const c of changes.changed) assert.equal(proposed.byKey.get(c.key)?.raw['name'], c.after['name']);
});

test('an empty proposal builds an index equal to the current one, as a different object', () => {
  const index = current();
  const empty: Proposal = { id: 'empty', version: 1, title: 'nothing', base: { generatedAt: GENERATED_AT }, changes: [] };
  const proposed = proposedIndex(index, empty);
  assert.notEqual(proposed, index);
  assert.deepStrictEqual(proposed.snapshot, index.snapshot);
  assert.deepStrictEqual(proposed.all, index.all);
  assert.deepStrictEqual(changeSetFor(index, empty), { addedAccounts: [], removedAccounts: [], added: [], removed: [], changed: [] });
});

test('effectiveAccounts adds the accounts a proposal creates and is the selection itself otherwise', () => {
  const selected: ReadonlySet<string> = new Set([SPOKE]);
  assert.equal(effectiveAccounts(selected, undefined), selected);
  assert.equal(effectiveAccounts(selected, { ...newSpoke(), accounts: undefined }), selected);
  assert.equal(effectiveAccounts(new Set([SPOKE, NEW]), newSpoke()).has(NEW), true);
  const both = new Set([SPOKE, NEW]);
  assert.equal(effectiveAccounts(both, newSpoke()), both);

  const effective = effectiveAccounts(selected, newSpoke());
  assert.deepStrictEqual([...effective].sort(), [SPOKE, NEW]);
  assert.deepStrictEqual([...selected], [SPOKE], 'the selection is not mutated');
  assert.deepStrictEqual([...effectiveAccounts(new Set(), newSpoke())], [NEW]);

  // Over the proposed index, the new account is drawn; the hub stays off.
  const index = current();
  const shown = withAccounts(proposedIndex(index, newSpoke()), effective);
  assert.deepStrictEqual(shown.snapshot.accounts.map((a) => a.accountId), [SPOKE, NEW]);
});

test('parseProposalParam reads proposal= on every route, tolerantly', () => {
  assert.equal(parseProposalParam('#/?accounts=111111111111,222222222222&proposal=new-spoke'), 'new-spoke');
  assert.equal(parseProposalParam('#/?proposal=new-spoke'), 'new-spoke');
  assert.equal(parseProposalParam('#/vpc/vpc-0prod0000000001?proposal=x'), 'x');
  assert.equal(parseProposalParam(`#/focus/${encodeURIComponent('arn:aws:iam::1:role/a?b')}?proposal=x`), 'x');
  assert.equal(parseProposalParam('/?proposal=no-hash'), 'no-hash');
  assert.equal(parseProposalParam('#/?proposal=%20spaced%2Did%20'), 'spaced-id');
  assert.equal(parseProposalParam('#/?proposal=a&proposal=b'), 'b');

  assert.equal(parseProposalParam(''), undefined);
  assert.equal(parseProposalParam('#/'), undefined);
  assert.equal(parseProposalParam('#/?accounts=111111111111'), undefined);
  assert.equal(parseProposalParam('#/?proposal='), undefined);
  assert.equal(parseProposalParam('#/?proposal=%20'), undefined);
  assert.equal(parseProposalParam('#/focus/proposal=x'), undefined, 'a key that looks like a param is not one');
});

test('withProposalParam sets, replaces and removes the param, keeping the route and the rest', () => {
  assert.equal(withProposalParam('#/', 'x'), '#/?proposal=x');
  assert.equal(withProposalParam('', 'x'), '#?proposal=x');
  assert.equal(
    withProposalParam('#/?accounts=111111111111,222222222222', 'new-spoke'),
    '#/?accounts=111111111111,222222222222&proposal=new-spoke',
  );
  assert.equal(withProposalParam('#/?proposal=old&accounts=111111111111', 'new'), '#/?accounts=111111111111&proposal=new');
  assert.equal(withProposalParam('#/vpc/vpc-0prod0000000001', 'x'), '#/vpc/vpc-0prod0000000001?proposal=x');
  assert.equal(withProposalParam('#/focus/arn%3Aaws%3Aiam%3A%3A1%3Arole%2Fa?proposal=x', undefined), '#/focus/arn%3Aaws%3Aiam%3A%3A1%3Arole%2Fa');

  assert.equal(withProposalParam('#/?proposal=x', undefined), '#/');
  assert.equal(withProposalParam('#/?proposal=x', ''), '#/');
  assert.equal(withProposalParam('#/?proposal=a&proposal=b&accounts=111111111111', undefined), '#/?accounts=111111111111');

  for (const id of ['new-spoke', 'with space', 'a&b=c', 'ünï']) {
    for (const hash of ['#/', '#/?accounts=111111111111', '#/vpc/vpc-1', '#/focus/k%3Fq']) {
      assert.equal(parseProposalParam(withProposalParam(hash, id)), id, `${hash} ${id}`);
    }
  }
});

test('loadProposals tolerates absence and skips malformed or duplicate entries', () => {
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    (globalThis as { window?: Partial<Window> }).window = {};
    assert.deepStrictEqual(loadProposals(), []);
    (globalThis as { window?: unknown }).window = { __ATLAS_PROPOSALS__: 'nope' };
    assert.deepStrictEqual(loadProposals(), []);

    const good = newSpoke();
    (globalThis as { window?: unknown }).window = {
      __ATLAS_PROPOSALS__: [null, { id: '' , changes: [] }, { id: 'no-changes' }, { id: 'bad-accounts', changes: [], accounts: 'x' }, good, { ...newSpoke(), title: 'dupe' }],
    };
    const loaded = loadProposals();
    assert.deepStrictEqual(loaded, [good]);
    assert.equal(loaded[0], good);
    assert.equal(warnings.length, 5);
  } finally {
    console.warn = warn;
  }
});
