/**
 * The account picker's selection model: which scanned accounts the overview
 * builds and lays out (ACCOUNT-PICKER.md, decisions 33–35 and 37).
 *
 * The overview's unit is the *selected account set*, not the estate. The
 * filter is applied here, to the index the overview is built from — never to
 * the bundle, which still carries every account — so ELK and React Flow only
 * ever see what the reader switched on. `buildOverview` needs no change to
 * honour it: every one of its loops walks `index.snapshot.accounts`, and this
 * module is what narrows that array. Do not add an account filter of your own
 * to a loop in `overview.ts`; extend this module instead.
 *
 * Plain TypeScript, no DOM, no React: pinned by `test/selection.test.ts`.
 */
import type { AtlasIndex } from '../data.js';

/**
 * Scanned account ids each derived index left out, keyed by the derived index.
 * A `WeakMap` so the frozen `AtlasIndex` interface (`data.ts`) needs no new
 * member, and a dropped selection's entry goes with it.
 */
const omitted = new WeakMap<AtlasIndex, ReadonlySet<string>>();

const NONE: ReadonlySet<string> = new Set();

/** A 12-digit AWS account id — the only thing the selection ever holds. */
const ACCOUNT_ID = /^\d{12}$/;

/**
 * The index the overview builds from when only `ids` are selected.
 *
 * Returns a shallow copy of `index` whose `snapshot` is a shallow copy whose
 * `accounts` keeps only the selected accounts, **in the snapshot's original
 * order** (never the order of `ids`). The account objects are the originals.
 * Every other member — `all`, `byKey`, `annotations`, `terraform`,
 * `accountLabel`, `annotationFor`, `terraformFor`, `findRegion` — is the
 * original's, unchanged, so an unselected account can still be named
 * (`accountLabel`), and its resources still resolved (`byKey`, `findRegion`).
 * That is deliberate: a link from a selected account into an unselected one
 * must still be drawable, as a ghost (decision 36).
 *
 * When `ids` covers every scanned account, returns **`index` itself** — the
 * same object, not an equal copy — so show-all and the single-account estate
 * build exactly what they built before this module existed, and caches keyed
 * on the index object (`focus.ts`'s `WeakMap`) stay warm.
 *
 * Ids in `ids` that are not scanned accounts are ignored. The result is a new
 * object on every call that filters: callers that render (WP-3, `App.tsx`)
 * must memoise it on `[index, ids]` (decision 40), or the overview rebuilds on
 * every render. Pass the *full* index, not a derived one, to the VPC and focus
 * builders.
 */
export function withAccounts(index: AtlasIndex, ids: ReadonlySet<string>): AtlasIndex {
  const accounts = index.snapshot.accounts.filter((a) => ids.has(a.accountId));
  if (accounts.length === index.snapshot.accounts.length) return index;

  const left = new Set<string>();
  for (const a of index.snapshot.accounts) {
    if (!ids.has(a.accountId)) left.add(a.accountId);
  }
  const derived: AtlasIndex = { ...index, snapshot: { ...index.snapshot, accounts } };
  omitted.set(derived, left);
  return derived;
}

/**
 * The scanned account ids that `index` leaves out because the selection does
 * — empty for any index `withAccounts` did not derive (including show-all,
 * which returns the original).
 *
 * This is how WP-2's `ensureGhostAccount` (`overview.ts`) tells *scanned but
 * switched off* from *never scanned* without touching the frozen `AtlasIndex`
 * interface: an id in this set gets a ghost labelled `index.accountLabel(id)`,
 * subtitle `not shown · click to add` and `data.addAccountId`; an id not in it
 * keeps today's `Account <id>` / `not scanned`. Look it up once per build (it
 * is a `WeakMap` hit) — the `Builder` is the natural place to keep it.
 */
export function omittedAccounts(index: AtlasIndex): ReadonlySet<string> {
  return omitted.get(index) ?? NONE;
}

/**
 * The selection an estate opens on when neither the URL nor `localStorage`
 * has one (decision 35): **every account when exactly one is scanned**, so a
 * single-account estate opens exactly as it always has; otherwise **none**,
 * and the overview opens on the empty canvas with the Inventory panel open.
 * Do not raise the threshold — it was chosen on 2026-11-03.
 *
 * WP-3 precedence: `parseAccountsParam(hash) ?? loadAccountSelection() ??
 * defaultSelection(index)`. A fresh `Set` each call; the caller owns it.
 */
export function defaultSelection(index: AtlasIndex): Set<string> {
  const accounts = index.snapshot.accounts;
  return new Set(accounts.length === 1 ? accounts.map((a) => a.accountId) : []);
}

/**
 * The selection carried by an overview hash (decision 37), e.g.
 * `#/?accounts=333333333333,111111111111` → `{111111111111, 333333333333}`,
 * returned as a `Set` whose iteration order is sorted.
 *
 * Returns `undefined` — "the URL has no opinion, fall back to `localStorage`,
 * then the default" — for a hash with no `accounts` param (plain `#/`), for
 * the VPC and focus routes (`#/vpc/…`, `#/focus/…`), which never carry a
 * selection, and for a param in which no valid id survives. It never returns
 * an empty set: the empty selection is spelt plain `#/`.
 *
 * Tolerant of what a person pastes: the leading `#` is optional, whitespace
 * around ids is ignored, commas may be percent-encoded, duplicates collapse,
 * and anything that is not a 12-digit id is dropped. Whether an id is a
 * *scanned* account is not checked here; `withAccounts` ignores ones that are
 * not.
 */
export function parseAccountsParam(hash: string): Set<string> | undefined {
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  // Mirrors App.tsx `parseHash`: anything that is not a VPC or focus route is
  // the overview.
  if (path.startsWith('/vpc/') || path.startsWith('/focus/')) return undefined;
  const q = path.indexOf('?');
  if (q < 0) return undefined;
  const raw = new URLSearchParams(path.slice(q + 1)).get('accounts');
  if (raw === null) return undefined;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ACCOUNT_ID.test(s))
    .sort();
  return ids.length > 0 ? new Set(ids) : undefined;
}

/**
 * The query suffix of the overview hash for `ids` (decision 37):
 * `?accounts=<id>,<id>` sorted ascending, or `''` for the empty set. The
 * overview hash is `'#/' + formatAccountsParam(ids)`, so the empty selection
 * is plain `#/`, and `parseAccountsParam` round-trips any non-empty result.
 *
 * Ids are written as given (sorted, not validated); hand it the selection, not
 * user input. The same string is the natural overview view key (decision 39):
 * different selections must not share saved positions.
 */
export function formatAccountsParam(ids: ReadonlySet<string>): string {
  if (ids.size === 0) return '';
  return `?accounts=${[...ids].sort().join(',')}`;
}
