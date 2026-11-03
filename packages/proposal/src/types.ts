/**
 * The proposal contract (PROPOSAL-OVERLAY.md, decision 44).
 *
 * A proposal is a planned change to a scanned estate, written as a delta: a
 * list of ops that, applied in order to the scanned `Snapshot`, produce the
 * *proposed* snapshot. Nothing is drawn by hand — the viewer builds both
 * snapshots with its ordinary builders and stamps the difference
 * (`packages/viewer/src/model/diff.ts`).
 *
 * The people who read these types:
 *
 * - **an LLM writing `proposals/<id>.yaml`** (the `atlas-propose` skill). The
 *   YAML is exactly the `Proposal` below minus `id`, which is the file stem.
 *   Every field is spelled out; nothing is inferred. `collection` is the
 *   snapshot's own field name (`vpcs`, `transitGatewayAttachments`,
 *   `hostedZones`…) so `packages/schema/src/snapshot.ts` is the documentation
 *   of what a resource looks like — there is no second vocabulary.
 * - **the CLI** (`propose validate`, WP-2), which prints `Issue`s.
 * - **the viewer** (WP-3/4/5), which applies a proposal, diffs, and shows a
 *   `ChangeSet` entry in the details panel.
 *
 * A worked example, the shape the skill writes:
 *
 * ```yaml
 * version: 1
 * title: Add a data-platform spoke joined to the core TGW
 * description: |                 # markdown, optional
 *   Why this change…
 * base:
 *   generatedAt: "2026-07-06T09:20:00.000Z"   # the scanned Snapshot.generatedAt
 * accounts:                      # accounts the proposal creates (optional)
 *   - accountId: "555555555555"  # always quoted: 12 digits, a string
 *     alias: acme-data
 *     regions: [eu-west-1]
 * changes:
 *   - op: add
 *     account: "555555555555"
 *     region: eu-west-1          # or `global` for account-global collections
 *     collection: vpcs
 *     resource:
 *       id: proposed-vpc-data    # every new id starts `proposed-`
 *       name: data-vpc
 *       cidrBlocks: ["10.3.0.0/16"]
 *       tags: {}
 *   - op: change
 *     key: sg-0a1b2c3d4e5f00001  # an existing id or arn
 *     set:                       # shallow merge; arrays replace whole
 *       ingress: [...]
 *   - op: remove
 *     key: pcx-0prod0dev00000001
 * ```
 */

/** Every id a proposal creates starts with this (decision 45). Nothing ever rewrites ids. */
export const PROPOSED_PREFIX = 'proposed-';

/** The `region` value that addresses an account's `global` collections instead of a region. */
export const GLOBAL_SCOPE = 'global';

/** True for an id (or arn) that a proposal created rather than a scan found. */
export function isProposedId(key: string): boolean {
  // An ARN is proposed when its final resource segment is: `arn:…:role/proposed-x`.
  const tail = key.slice(Math.max(key.lastIndexOf(':'), key.lastIndexOf('/')) + 1);
  return key.startsWith(PROPOSED_PREFIX) || tail.startsWith(PROPOSED_PREFIX);
}

/**
 * A resource as a proposal writes it: any object with a string `id`. Its other
 * fields are the snapshot type's fields for that collection (see
 * `packages/schema/src/snapshot.ts`). The applier does not fill defaults: an
 * LLM that omits `tags` produces a resource without `tags`, exactly as written.
 * For the `generic` collection, which is keyed by ARN, `id` must equal `arn`.
 */
export type ProposedResource = Record<string, unknown> & { id: string };

/**
 * An account the proposal creates. It is drawn like a scanned account; its
 * `regions` are created empty so `add` ops can target them (an `add` into any
 * other region of the account creates that region too).
 */
export interface ProposalAccount {
  /** 12 digits, as a string. A YAML number here is an error, not coerced. */
  accountId: string;
  alias?: string;
  regions?: string[];
}

/**
 * Create a resource. `account` must be a scanned account or one in
 * `Proposal.accounts`; `region` is a region name or `global`; `collection` must
 * be a `RegionSnapshot` array (for a region) or an `AccountSnapshot.global`
 * array (for `global`) — see `REGION_COLLECTIONS` / `GLOBAL_COLLECTIONS`.
 */
export interface AddChange {
  op: 'add';
  account: string;
  region: string;
  collection: string;
  resource: ProposedResource;
}

/**
 * Modify an existing resource — scanned, or added earlier in the same
 * proposal. `key` is an id or an arn, resolved like the viewer's `byKey`.
 * `set` is a *shallow* merge onto the resource: each top-level field is
 * replaced whole (an array is replaced, not appended to; a nested object is
 * replaced, not merged). `id` and `arn` cannot be set. A resource that appears
 * in several accounts' snapshots (a shared TGW, a RAM-shared subnet) is
 * changed in every copy.
 */
export interface ChangeChange {
  op: 'change';
  key: string;
  set: Record<string, unknown>;
}

/** Delete a resource by id or arn, from every collection and every account copy it appears in. */
export interface RemoveChange {
  op: 'remove';
  key: string;
}

/** One op. Ops apply in order, so a later op can change or remove an earlier op's `add`. */
export type ProposalChange = AddChange | ChangeChange | RemoveChange;

export interface Proposal {
  /** The file stem of `proposals/<id>.yaml`. Not written in the YAML; `parseProposal` sets it. */
  id: string;
  /** Always 1. */
  version: 1;
  /** One line; the viewer's proposal bar shows it. */
  title: string;
  /** Markdown, optional; why the change is wanted, and any warning the author chose to keep. */
  description?: string;
  /**
   * The scanned snapshot this proposal was designed against, by its
   * `Snapshot.generatedAt`. When it differs from the loaded snapshot's the
   * proposal is *stale* (decision 46): a warning and a badge, never an error.
   */
  base: { generatedAt: string };
  /** Accounts the proposal creates. Optional; absent means none. */
  accounts?: ProposalAccount[];
  changes: ProposalChange[];
}

/**
 * Where a resource lives in a snapshot. `region` is a region name, or
 * `GLOBAL_SCOPE` (`'global'`) for `AccountSnapshot.global`.
 */
export interface ResourceLocation {
  accountId: string;
  region: string;
  collection: string;
}

/**
 * A resource present on one side of a diff only. `key` is the resource's `id`
 * (for `generic`, its arn — which is also its id in the viewer's index).
 * `resource` is the whole resource as it is on the side it exists on.
 */
export interface ResourceDelta extends ResourceLocation {
  key: string;
  arn?: string;
  resource: Record<string, unknown>;
}

/**
 * A resource present on both sides with at least one field different.
 *
 * For a details panel (WP-4): `fields` lists every top-level field that
 * differs, sorted. `before` and `after` hold *only* those fields — a field
 * listed in `fields` but missing from `before` did not exist before (it was
 * added); missing from `after`, it was removed. Fields not in `fields` are
 * unchanged; read them from the resource itself. Comparison is by stable JSON
 * (object key order ignored, array order significant).
 *
 * A shared resource that appears in several accounts' snapshots yields one
 * entry per copy; they share `key` and differ in `accountId`.
 */
export interface ChangedResource extends ResourceLocation {
  key: string;
  arn?: string;
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * What differs between two snapshots (`diffSnapshots(current, proposed)`).
 * Every list is in snapshot order (accounts, then regions, then
 * collections in schema order, then resources) so it is deterministic.
 *
 * A resource inside an added account is listed in `added` as well as its
 * account being in `addedAccounts`; likewise for removals.
 */
export interface ChangeSet {
  addedAccounts: string[];
  removedAccounts: string[];
  added: ResourceDelta[];
  removed: ResourceDelta[];
  changed: ChangedResource[];
}

/**
 * One finding from `validateProposal` or `parseProposal`.
 *
 * For a CLI (WP-2): print `${level} ${code} ${path ?? '-'}: ${message}`. `path`
 * addresses the offending value inside the proposal in JavaScript accessor
 * form, rooted at the proposal — `changes[1].resource.transitGatewayId`,
 * `accounts[0].accountId`, `base.generatedAt` — and is absent for findings
 * about the proposal as a whole. `key` is the id or arn the finding is about,
 * when there is one (the unresolvable reference, the duplicate id). Errors
 * mean exit 1; warnings exit 0 unless `--strict` (decision 47).
 *
 * Codes are stable strings a test or a skill may match on:
 * `malformed`, `unknown-account`, `account-exists`, `unknown-collection`,
 * `missing-id`, `not-proposed-id`, `duplicate-id`, `unresolved-key`,
 * `immutable-field`, `unresolved-reference`, `unknown-reference`,
 * `external-reference`, `stale`, and each design rule's own code.
 */
export interface Issue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  key?: string;
}
