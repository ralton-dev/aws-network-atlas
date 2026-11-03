/**
 * The viewer's side of a proposal (PROPOSAL-OVERLAY.md, decisions 44, 46 and
 * 49–52): load the proposals the bundle carries, build the *proposed* index
 * beside the scanned one, and carry the active proposal in the URL.
 *
 * A proposal is never drawn by hand. `proposedIndex` applies it to the scanned
 * snapshot and indexes the result with the ordinary `buildIndex` (decision
 * 57), so the overview, VPC and focus builders run once per index exactly as
 * they do today, and `diffGraphs` (`diff.ts`) stamps the difference.
 *
 * For WP-5 (`App.tsx`), the intended wiring, in order:
 *
 * 1. `const proposals = loadProposals()` once, beside `buildIndex()`.
 * 2. `const active = proposals.find((p) => p.id === parseProposalParam(hash))`;
 *    an id that matches nothing is warned about and dropped from the URL with
 *    `withProposalParam(hash, undefined)` (decision 51).
 * 3. `proposedIndex(index, active)` and `changeSetFor(index, active)` with the
 *    **full** index — never a `withAccounts` derivative, which would apply the
 *    proposal to a filtered estate and report every switched-off account as
 *    removed.
 * 4. The overview builds from `withAccounts(current, sel)` and
 *    `withAccounts(proposed, effectiveAccounts(sel, active))`.
 *
 * Plain TypeScript, no DOM beyond reading `window`: pinned by
 * `test/proposal-model.test.ts`.
 */
import { applyProposal, diffSnapshots, type ChangeSet, type Proposal } from '@atlas/proposal';
import { buildIndex, type AtlasIndex } from '../data.js';

/** What one (index, proposal) pair builds: the proposed index and the snapshot diff, from one applied snapshot. */
interface Built {
  /** The proposal object this was built from, so a different object under the same id rebuilds. */
  proposal: Proposal;
  index: AtlasIndex;
  changes: ChangeSet;
}

/**
 * Builds keyed by the current index object, then by proposal id. A `WeakMap`
 * so the frozen `AtlasIndex` interface needs no new member and a dropped
 * index takes its proposed indexes with it.
 */
const builds = new WeakMap<AtlasIndex, Map<string, Built>>();

function build(index: AtlasIndex, proposal: Proposal): Built {
  let byId = builds.get(index);
  if (!byId) builds.set(index, (byId = new Map()));
  const cached = byId.get(proposal.id);
  if (cached && cached.proposal === proposal) return cached;

  // `buildIndex` fills missing collections into the snapshot it is given, so
  // it must only ever see `applyProposal`'s fresh clone — never a snapshot the
  // current index shares. The diff reads the same object after indexing, so
  // the ChangeSet and the proposed index describe one snapshot.
  const applied = applyProposal(index.snapshot, proposal);
  const proposed = buildIndex(applied, index.annotations, index.terraform);
  const built: Built = { proposal, index: proposed, changes: diffSnapshots(index.snapshot, applied) };
  byId.set(proposal.id, built);
  return built;
}

/**
 * The proposals the bundle carries (`window.__ATLAS_PROPOSALS__`, written to
 * `site/data/proposals.js` — decision 53), in bundle order.
 *
 * Tolerant of absence: no global, or one that is not an array, is `[]` (the
 * dev server serves an empty stub for a missing `/data/*.js`, and a committed
 * `site/` from before this plan has no such file). An entry that is not an
 * object with a non-empty string `id`, an array `changes` and, if present, an
 * array `accounts` is skipped with a console warning, as is a second entry
 * reusing an `id` (the first wins) — the id is the URL param and the memo key.
 * Entries are not otherwise validated: `applyProposal` is lenient and the CLI
 * is where validation happens. Returns a fresh array; call it once.
 */
export function loadProposals(): Proposal[] {
  const raw: unknown = typeof window === 'undefined' ? undefined : window.__ATLAS_PROPOSALS__;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Proposal[] = [];
  for (const entry of raw as unknown[]) {
    const p = entry as Partial<Proposal> | null;
    const ok =
      typeof p === 'object' && p !== null &&
      typeof p.id === 'string' && p.id !== '' &&
      Array.isArray(p.changes) &&
      (p.accounts === undefined || Array.isArray(p.accounts));
    if (!ok) {
      console.warn('atlas: skipping a malformed entry in __ATLAS_PROPOSALS__', entry);
      continue;
    }
    if (seen.has(p.id!)) {
      console.warn(`atlas: skipping a second proposal with id "${p.id}"`);
      continue;
    }
    seen.add(p.id!);
    out.push(p as Proposal);
  }
  return out;
}

/**
 * The index of the estate as it would be with `proposal` applied: the
 * scanned snapshot with the proposal's accounts and ops applied
 * (`applyProposal`, lenient — invalid ops are skipped), indexed by
 * `buildIndex` with the current index's annotations and Terraform stacks.
 *
 * **A stable object**: the same `(index, proposal)` pair returns the same
 * index on every call, so `focus.ts`'s relations cache (a `WeakMap` keyed on
 * the index) stays warm and a `useMemo` downstream does not churn. A
 * different proposal object under the same id (a reloaded bundle) rebuilds.
 *
 * Pass the **full** index the app built, not a `withAccounts` derivative.
 * The current index is never touched. Resources the proposal creates have ids
 * starting `proposed-` (decision 45); accounts it creates have `profile`
 * `proposal:<id>` and `scannerVersion` `proposal`. `accountLabel` in the
 * result names them by the alias the proposal gave.
 */
export function proposedIndex(index: AtlasIndex, proposal: Proposal): AtlasIndex {
  return build(index, proposal).index;
}

/**
 * What `proposal` changes, as `diffSnapshots(index.snapshot, applied)` over
 * the very snapshot `proposedIndex(index, proposal)` indexed, so the two
 * always agree. Memoised alongside it: the same pair returns the same object.
 *
 * Its `ResourceLocation.region` is `'global'` for account-global resources,
 * where the viewer's `ResourceRef.region` is `''` — do not compare the two.
 * Look an entry up by key instead: `indexChangeSet(changes)` from
 * `@atlas/proposal` maps every id and arn to its entry and state, which is
 * what the details panel (WP-4) and `diffGraphs` want.
 */
export function changeSetFor(index: AtlasIndex, proposal: Proposal): ChangeSet {
  return build(index, proposal).changes;
}

/**
 * The selection the *proposed* overview builds from while `proposal` is
 * active (decision 52): `selected` plus every `proposal.accounts[].accountId`,
 * so the headline of a "new spoke" proposal is never switched off.
 *
 * Returns `selected` itself (the same object) when there is no proposal or it
 * adds nothing new, so a `useMemo` on the result is as stable as the
 * selection; otherwise a fresh `Set`. Hand the result to `withAccounts` over
 * the **proposed** index — the accounts it adds exist only there. It is not
 * the selection to store or put in `?accounts=` (App's `scannedOnly` would
 * drop the unscanned ids anyway), and the current overview keeps `selected`.
 */
export function effectiveAccounts(
  selected: ReadonlySet<string>,
  proposal: Proposal | undefined,
): ReadonlySet<string> {
  const created = (proposal?.accounts ?? []).map((a) => a.accountId).filter((id) => !selected.has(id));
  if (created.length === 0) return selected;
  return new Set([...selected, ...created]);
}

/** The hash split into its route path (without `#`) and its query (without `?`). */
function splitHash(hash: string): { path: string; query: string } {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = body.indexOf('?');
  return q < 0 ? { path: body, query: '' } : { path: body.slice(0, q), query: body.slice(q + 1) };
}

/**
 * The active proposal id carried by a hash (decision 51), on **every** route:
 * `#/?accounts=…&proposal=x`, `#/vpc/<id>?proposal=x` and
 * `#/focus/<key>?proposal=x` all give `'x'`.
 *
 * Returns `undefined` for no `proposal` param, or one that is empty or
 * whitespace. Tolerant like `parseAccountsParam`: the leading `#` is optional,
 * the value is percent-decoded and trimmed, and the last `proposal` param wins
 * if a person pasted two. Whether the id names a loaded proposal is not
 * checked here — the caller warns and drops an unknown one.
 *
 * WP-5 note: `App.tsx`'s `parseHash` focus regex (`/^#\/focus\/(.+)$/`)
 * captures everything after `/focus/`, query included, so it must strip the
 * `?…` before decoding the key once a focus hash can carry `?proposal=`. A
 * focus key is written with `encodeURIComponent`, so the first `?` is always
 * the query.
 */
export function parseProposalParam(hash: string): string | undefined {
  const { query } = splitHash(hash);
  if (query === '') return undefined;
  const values = new URLSearchParams(query).getAll('proposal');
  const id = values[values.length - 1]?.trim();
  return id ? id : undefined;
}

/**
 * `hash` with its `proposal` param set to `id`, or removed when `id` is
 * `undefined` or empty (decision 51). The route path and every other param
 * are kept byte for byte and in order — in particular `accounts=` keeps its
 * literal commas, which `URLSearchParams.toString()` would encode — and
 * `proposal=` always goes last. The result always starts with `#`; with no
 * params left it has no `?`, so `withProposalParam('#/?proposal=x',
 * undefined)` is `'#/'`, the plain overview.
 *
 * The id is written with `encodeURIComponent`, so `parseProposalParam`
 * round-trips it. Use it to add the active proposal to whatever `routeHash`
 * returns, and to drop an unknown id from the URL.
 */
export function withProposalParam(hash: string, id: string | undefined): string {
  const { path, query } = splitHash(hash);
  const kept = query
    .split('&')
    .filter((part) => part !== '' && part.split('=')[0] !== 'proposal');
  if (id) kept.push(`proposal=${encodeURIComponent(id)}`);
  return `#${path}${kept.length > 0 ? `?${kept.join('&')}` : ''}`;
}
