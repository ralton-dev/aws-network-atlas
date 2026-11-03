/**
 * What the five networking rules share: reading a collection across every
 * account copy, IPv4 CIDR arithmetic, and the one gate that keeps a rule to
 * what the proposal did (`proposalFindings`).
 *
 * A rule here is written as a pure `find(snapshot)` that reports every
 * problem of its kind in a snapshot, each with a stable `identity`. The gate
 * runs it on the base and on the applied snapshot and keeps only findings
 * that are (a) absent from the base by identity — so a pre-existing overlap or
 * a subnet that was already outside its VPC is never reported, even when the
 * proposal touched one of the resources involved — and (b) about at least one
 * resource the proposal added, changed or removed. (b) is the registry's
 * contract; (a) is what makes it hold for a resource the proposal touched for
 * an unrelated reason (a tag change on an already-overlapping VPC).
 *
 * Resources a proposal writes are untyped (they came from YAML), so every
 * field is read defensively: a missing array is empty, a non-string id is
 * absent.
 */
import type { Snapshot } from '@atlas/schema';

import { snapshotSlots } from '../collections.js';
import type { Issue } from '../types.js';
import type { DesignRuleContext } from './index.js';

export type Item = Record<string, unknown>;

/** One copy of a resource and where it sits. Shared resources have several. */
export interface Located {
  accountId: string;
  region: string;
  item: Item;
}

/** Every copy of every resource in `collection`, grouped by `id`, in snapshot order. */
export function byId(snapshot: Snapshot, collection: string): Map<string, Located[]> {
  const out = new Map<string, Located[]>();
  for (const slot of snapshotSlots(snapshot)) {
    if (slot.collection !== collection) continue;
    for (const item of slot.items) {
      const id = str(item['id']);
      if (!id) continue;
      const copies = out.get(id);
      const located = { accountId: slot.accountId, region: slot.region, item };
      if (copies) copies.push(located);
      else out.set(id, [located]);
    }
  }
  return out;
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');
export const obj = (v: unknown): Item => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Item) : {});

/** Peering and attachment states that no longer join anything. */
const DEAD = new Set(['deleted', 'deleting', 'rejected', 'failed', 'expired']);
export const isLive = (item: Item): boolean => {
  const state = str(item['status']) ?? str(item['state']);
  return state === undefined || !DEAD.has(state);
};

// ---------------------------------------------------------------------------
// IPv4 CIDRs
// ---------------------------------------------------------------------------

export interface Cidr {
  text: string;
  /** The address as an unsigned 32-bit integer (host bits as written). */
  base: number;
  prefix: number;
}

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** An IPv4 CIDR, or `undefined` for anything else (IPv6, a typo, `/33`). */
export function parseCidr(text: string): Cidr | undefined {
  const m = CIDR.exec(text.trim());
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  const [a, b, c, d, prefix] = parts as [number, number, number, number, number];
  if ([a, b, c, d].some((o) => o > 255) || prefix > 32) return undefined;
  return { text, base: ((a << 24) >>> 0) + (b << 16) + (c << 8) + d, prefix };
}

const network = (address: number, prefix: number): number => (prefix === 0 ? 0 : address >>> (32 - prefix));

/** True when the two ranges share at least one address. */
export function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  const p = Math.min(a.prefix, b.prefix);
  return network(a.base, p) === network(b.base, p);
}

/** True when every address of `inner` is in `outer` (so a superset is not contained). */
export function cidrContains(outer: Cidr, inner: Cidr): boolean {
  return inner.prefix >= outer.prefix && network(inner.base, outer.prefix) === network(outer.base, outer.prefix);
}

export const parseAll = (texts: string[]): Cidr[] => texts.map(parseCidr).filter((c): c is Cidr => c !== undefined);

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** A resource a finding is about, and optionally where in it to point. */
export interface Involved {
  key: string;
  /** Top-level field of the resource the finding is about (`cidrBlocks`, `routes`). */
  field?: string;
  /** Appended after `field` when the op wrote that field (`[2].targetId`). */
  suffix?: string;
}

export interface Finding {
  /** Stable across base and applied: the same problem has the same identity on both sides. */
  identity: string;
  message: string;
  /** Most specific first. The issue points at the first one the proposal touched. */
  involves: Involved[];
}

/**
 * The `Issue.path` for `key`: the op that last added or changed it (or that
 * removed it), narrowed to `field` + `suffix` when that op wrote `field`.
 * An `add` writes the whole resource and a `change` replaces a field whole, so
 * an index into an array the op wrote is an index into the applied array.
 */
export function pathTo(context: DesignRuleContext, involved: Involved): string | undefined {
  let at = context.pathFor(involved.key);
  if (at === undefined) {
    const changes = context.proposal.changes;
    for (let i = changes.length - 1; i >= 0; i--) {
      const change = changes[i];
      if (change?.op === 'remove' && change.key === involved.key) {
        at = `changes[${i}]`;
        break;
      }
    }
  }
  if (at === undefined || involved.field === undefined) return at;
  const index = Number(/^changes\[(\d+)\]$/.exec(at)?.[1]);
  const change = context.proposal.changes[index];
  const suffix = involved.suffix ?? '';
  if (change?.op === 'add' && involved.field in change.resource) return `${at}.resource.${involved.field}${suffix}`;
  if (change?.op === 'change' && involved.field in change.set) return `${at}.set.${involved.field}${suffix}`;
  return at;
}

/** Every key the proposal added, changed or removed. */
export function touchedKeys(context: DesignRuleContext): Set<string> {
  const keys = new Set<string>();
  const { added, changed, removed } = context.changes;
  for (const r of [...added, ...changed, ...removed]) {
    keys.add(r.key);
    if (r.arn) keys.add(r.arn);
  }
  return keys;
}

/**
 * `find` on the applied snapshot, minus every identity `find` also reports on
 * the base, minus every finding about nothing the proposal touched — as
 * warnings with the rule's code, pointing at the first touched resource.
 */
export function proposalFindings(code: string, context: DesignRuleContext, find: (snapshot: Snapshot) => Finding[]): Issue[] {
  const before = new Set(find(context.base).map((f) => f.identity));
  const touched = touchedKeys(context);
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const finding of find(context.applied)) {
    if (before.has(finding.identity) || seen.has(finding.identity)) continue;
    const blame = finding.involves.find((i) => touched.has(i.key));
    if (!blame) continue;
    seen.add(finding.identity);
    const path = pathTo(context, blame);
    issues.push({ level: 'warning', code, message: finding.message, key: blame.key, ...(path !== undefined ? { path } : {}) });
  }
  return issues;
}
