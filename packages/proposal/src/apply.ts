import { emptyGlobal, emptyRegionSnapshot, type AccountSnapshot, type Snapshot } from '@atlas/schema';

import { accountSlots, isCollectionFor, resourceArn, resourceKey, type Resource } from './collections.js';
import { GLOBAL_SCOPE, type Proposal } from './types.js';

/**
 * The proposed snapshot: `snapshot` with `proposal` applied (decision 44).
 *
 * Returns a new snapshot and never mutates `snapshot` or `proposal` — the
 * result shares no object with either (a structural clone, and every resource
 * a proposal supplies is cloned in). Steps, in order:
 *
 * 1. each `proposal.accounts` entry not already in the snapshot becomes an
 *    account with `emptyGlobal()` and one `emptyRegionSnapshot` per listed
 *    region (`profile` is `proposal:<id>`, `scannerVersion` is `proposal`,
 *    `scannedAt` is the snapshot's `generatedAt`), appended after the scanned
 *    accounts in the order listed;
 * 2. the ops, in order: `add` pushes onto the named collection (creating the
 *    region if the account has none of that name); `change` shallow-merges
 *    `set` onto every copy of the resource whose id or arn is `key`, ignoring
 *    `id` and `arn`; `remove` deletes every copy.
 *
 * It is lenient by design so a viewer can apply an imperfect proposal without
 * crashing: an op that `validateProposal` would report as an error (unknown
 * account or collection, unresolved key) is skipped, and an account that
 * already exists is left as scanned. Validate first when correctness matters.
 * `generatedAt` is unchanged — the proposed snapshot is "the base, plus".
 */
export function applyProposal(snapshot: Snapshot, proposal: Proposal): Snapshot {
  const out = structuredClone(snapshot);
  const accounts = new Map(out.accounts.map((a) => [a.accountId, a]));

  for (const pa of proposal.accounts ?? []) {
    if (accounts.has(pa.accountId)) continue;
    const account: AccountSnapshot = {
      accountId: pa.accountId,
      ...(pa.alias !== undefined ? { alias: pa.alias } : {}),
      profile: `proposal:${proposal.id}`,
      scannedAt: snapshot.generatedAt,
      scannerVersion: 'proposal',
      regions: [...new Set(pa.regions ?? [])].map((r) => emptyRegionSnapshot(r)),
      emptyRegions: [],
      global: emptyGlobal(),
    };
    out.accounts.push(account);
    accounts.set(account.accountId, account);
  }

  // key (id and arn) → the collection arrays holding a resource with that key.
  const where = new Map<string, Set<Resource[]>>();
  const register = (item: Resource, items: Resource[]): void => {
    for (const key of [resourceKey(item), resourceArn(item)]) {
      if (!key) continue;
      let set = where.get(key);
      if (!set) where.set(key, (set = new Set()));
      set.add(items);
    }
  };
  for (const account of out.accounts) {
    for (const slot of accountSlots(account)) for (const item of slot.items) register(item, slot.items);
  }
  const matches = (item: Resource, key: string): boolean => resourceKey(item) === key || resourceArn(item) === key;

  for (const change of proposal.changes) {
    if (change.op === 'add') {
      const account = accounts.get(change.account);
      if (!account || !isCollectionFor(change.region, change.collection)) continue;
      let container: Record<string, unknown>;
      if (change.region === GLOBAL_SCOPE) {
        container = account.global as unknown as Record<string, unknown>;
      } else {
        let region = account.regions.find((r) => r.region === change.region);
        if (!region) {
          region = emptyRegionSnapshot(change.region);
          account.regions.push(region);
          account.emptyRegions = account.emptyRegions.filter((r) => r !== change.region);
        }
        container = region as unknown as Record<string, unknown>;
      }
      const existing = container[change.collection];
      const items: Resource[] = Array.isArray(existing) ? (existing as Resource[]) : [];
      container[change.collection] = items;
      const resource = structuredClone(change.resource) as Resource;
      items.push(resource);
      register(resource, items);
    } else if (change.op === 'change') {
      const { id: _id, arn: _arn, ...set } = change.set;
      for (const items of where.get(change.key) ?? []) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item && matches(item, change.key)) items[i] = { ...item, ...structuredClone(set) };
        }
      }
    } else {
      for (const items of where.get(change.key) ?? []) {
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i];
          if (!item || !matches(item, change.key)) continue;
          items.splice(i, 1);
          for (const key of [resourceKey(item), resourceArn(item)]) if (key) where.get(key)?.delete(items);
        }
      }
    }
  }
  return out;
}
