/**
 * The collection vocabulary, derived from the schema's own empty factories so
 * it cannot drift from `packages/schema/src/snapshot.ts`: a collection is any
 * array field of `emptyRegionSnapshot(…)` or `emptyGlobal()` except `errors`
 * (scan errors are not resources).
 */
import { emptyGlobal, emptyRegionSnapshot, type AccountSnapshot, type RegionSnapshot, type Snapshot } from '@atlas/schema';

import { GLOBAL_SCOPE, type ResourceLocation } from './types.js';

const arrayFields = (value: object): string[] =>
  Object.entries(value)
    .filter(([key, v]) => Array.isArray(v) && key !== 'errors')
    .map(([key]) => key);

/** Every `RegionSnapshot` resource array, in schema order (`vpcs`, `subnets`, … `generic`). */
export const REGION_COLLECTIONS: readonly string[] = Object.freeze(arrayFields(emptyRegionSnapshot('x')));

/** Every `AccountSnapshot.global` resource array, in schema order (`hostedZones`, … `wafRuleGroups`). */
export const GLOBAL_COLLECTIONS: readonly string[] = Object.freeze(arrayFields(emptyGlobal()));

const REGION_SET = new Set(REGION_COLLECTIONS);
const GLOBAL_SET = new Set(GLOBAL_COLLECTIONS);

/** True when `collection` exists for `region` (a region name, or `'global'`). */
export function isCollectionFor(region: string, collection: string): boolean {
  return region === GLOBAL_SCOPE ? GLOBAL_SET.has(collection) : REGION_SET.has(collection);
}

export type Resource = Record<string, unknown>;

/**
 * The key a resource is known by: its `id`, or its `arn` when it has no id
 * (the `generic` collection). Matches the viewer's `byKey`, which indexes both.
 */
export function resourceKey(resource: Resource): string | undefined {
  const id = resource['id'];
  if (typeof id === 'string' && id !== '') return id;
  const arn = resource['arn'];
  return typeof arn === 'string' && arn !== '' ? arn : undefined;
}

export function resourceArn(resource: Resource): string | undefined {
  const arn = resource['arn'];
  return typeof arn === 'string' && arn !== '' ? arn : undefined;
}

/** One collection array in place, with where it lives. */
export interface CollectionSlot extends ResourceLocation {
  items: Resource[];
}

function regionSlots(account: AccountSnapshot, region: RegionSnapshot): CollectionSlot[] {
  const r = region as unknown as Record<string, unknown>;
  const out: CollectionSlot[] = [];
  for (const collection of REGION_COLLECTIONS) {
    const items = r[collection];
    if (Array.isArray(items)) out.push({ accountId: account.accountId, region: region.region, collection, items: items as Resource[] });
  }
  return out;
}

function globalSlots(account: AccountSnapshot): CollectionSlot[] {
  const g = (account.global ?? {}) as unknown as Record<string, unknown>;
  const out: CollectionSlot[] = [];
  for (const collection of GLOBAL_COLLECTIONS) {
    const items = g[collection];
    if (Array.isArray(items)) out.push({ accountId: account.accountId, region: GLOBAL_SCOPE, collection, items: items as Resource[] });
  }
  return out;
}

/**
 * Every collection of one account: its regions in snapshot order, then its
 * global collections. A collection missing from an older snapshot is skipped
 * (the viewer fills it empty at load; absence and emptiness diff the same).
 */
export function accountSlots(account: AccountSnapshot): CollectionSlot[] {
  return [...(account.regions ?? []).flatMap((region) => regionSlots(account, region)), ...globalSlots(account)];
}

/** Every collection of every account. */
export function snapshotSlots(snapshot: Snapshot): CollectionSlot[] {
  return snapshot.accounts.flatMap(accountSlots);
}

/** Every key (id and arn) a snapshot holds. */
export function snapshotKeys(snapshot: Snapshot): Set<string> {
  const keys = new Set<string>();
  for (const slot of snapshotSlots(snapshot)) {
    for (const item of slot.items) {
      const key = resourceKey(item);
      if (key) keys.add(key);
      const arn = resourceArn(item);
      if (arn) keys.add(arn);
    }
  }
  return keys;
}
