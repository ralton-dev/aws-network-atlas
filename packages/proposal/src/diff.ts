import type { AccountSnapshot, Snapshot } from '@atlas/schema';

import { accountSlots, resourceArn, resourceKey, type CollectionSlot, type Resource } from './collections.js';
import { stableStringify } from './stable-json.js';
import type { ChangedResource, ChangeSet, ResourceDelta } from './types.js';

/**
 * What differs between `current` and `proposed` (usually `applyProposal`'s
 * input and output, but any two snapshots will do).
 *
 * Resources are matched by *location and key*: the same account, the same
 * region (or `global`), the same collection, and the same `id` — or `arn` for
 * a resource with no id (`generic`). Matching by location rather than by key
 * alone matters because shared resources (a hub's TGW, a RAM-shared subnet)
 * appear under several accounts with one id; each copy is diffed against its
 * own counterpart. A resource that moved collection or account is therefore a
 * remove plus an add — which is what it is to AWS too.
 *
 * Field comparison is by `stableStringify`, so key order inside nested
 * objects never counts as a change. Neither input is mutated.
 *
 * Within one collection a key that appears twice is matched first-to-first;
 * scans do not produce that, and a proposal that does is a `duplicate-id`
 * error in `validateProposal`.
 */
export function diffSnapshots(current: Snapshot, proposed: Snapshot): ChangeSet {
  const out: ChangeSet = { addedAccounts: [], removedAccounts: [], added: [], removed: [], changed: [] };
  const before = new Map(current.accounts.map((a) => [a.accountId, a]));
  const after = new Map(proposed.accounts.map((a) => [a.accountId, a]));

  for (const account of current.accounts) {
    if (after.has(account.accountId)) continue;
    out.removedAccounts.push(account.accountId);
    for (const slot of accountSlots(account)) for (const item of slot.items) push(out.removed, slot, item);
  }
  for (const account of proposed.accounts) {
    const was = before.get(account.accountId);
    if (!was) {
      out.addedAccounts.push(account.accountId);
      for (const slot of accountSlots(account)) for (const item of slot.items) push(out.added, slot, item);
      continue;
    }
    diffAccount(was, account, out);
  }
  return out;
}

const slotId = (slot: CollectionSlot): string => `${slot.region}\u0000${slot.collection}`;

function diffAccount(was: AccountSnapshot, now: AccountSnapshot, out: ChangeSet): void {
  const beforeSlots = new Map(accountSlots(was).map((s) => [slotId(s), s]));
  const afterSlots = accountSlots(now);
  const afterById = new Map(afterSlots.map((s) => [slotId(s), s]));

  // Removed first, in the current snapshot's order, then added/changed in the proposed one's.
  for (const slot of beforeSlots.values()) {
    const counterpart = afterById.get(slotId(slot));
    const keep = new Set((counterpart?.items ?? []).map(resourceKey));
    for (const item of slot.items) if (!keep.has(resourceKey(item))) push(out.removed, slot, item);
  }
  for (const slot of afterSlots) {
    const old = new Map<string | undefined, Resource>();
    for (const item of beforeSlots.get(slotId(slot))?.items ?? []) {
      const key = resourceKey(item);
      if (!old.has(key)) old.set(key, item);
    }
    for (const item of slot.items) {
      const prior = old.get(resourceKey(item));
      if (!prior) {
        push(out.added, slot, item);
        continue;
      }
      const changed = diffFields(prior, item);
      if (changed) out.changed.push({ ...location(slot, item), ...changed });
    }
  }
}

function location(slot: CollectionSlot, item: Resource): Omit<ResourceDelta, 'resource'> {
  const arn = resourceArn(item);
  return {
    key: resourceKey(item) ?? '',
    ...(arn !== undefined ? { arn } : {}),
    accountId: slot.accountId,
    region: slot.region,
    collection: slot.collection,
  };
}

function push(list: ResourceDelta[], slot: CollectionSlot, item: Resource): void {
  list.push({ ...location(slot, item), resource: structuredClone(item) });
}

function diffFields(a: Resource, b: Resource): Pick<ChangedResource, 'fields' | 'before' | 'after'> | undefined {
  if (stableStringify(a) === stableStringify(b)) return undefined;
  const fields: string[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[field];
    const y = b[field];
    if (stableStringify(x) === stableStringify(y)) continue;
    fields.push(field);
    if (x !== undefined) before[field] = structuredClone(x);
    if (y !== undefined) after[field] = structuredClone(y);
  }
  return fields.length > 0 ? { fields, before, after } : undefined;
}

/** What one key's resource became in a `ChangeSet`, with the entry that says how. */
export type ChangeLookup =
  | { state: 'added'; entry: ResourceDelta }
  | { state: 'removed'; entry: ResourceDelta }
  | { state: 'changed'; entry: ChangedResource };

/**
 * The `ChangeSet` keyed by id *and* arn, for a consumer holding a `refId` —
 * the graph post-pass, the details panel. For a shared resource with entries
 * in several accounts the first entry wins (`changed` over `added`/`removed`
 * only by order of the lists: added, removed, changed — later lists do not
 * overwrite earlier ones). A key absent from the map is unchanged.
 */
export function indexChangeSet(changes: ChangeSet): Map<string, ChangeLookup> {
  const map = new Map<string, ChangeLookup>();
  const put = (lookup: ChangeLookup): void => {
    for (const key of [lookup.entry.key, lookup.entry.arn]) if (key && !map.has(key)) map.set(key, lookup);
  };
  for (const entry of changes.added) put({ state: 'added', entry });
  for (const entry of changes.removed) put({ state: 'removed', entry });
  for (const entry of changes.changed) put({ state: 'changed', entry });
  return map;
}
