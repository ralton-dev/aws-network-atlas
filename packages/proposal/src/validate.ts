import type { Snapshot } from '@atlas/schema';

import { applyProposal } from './apply.js';
import {
  GLOBAL_COLLECTIONS,
  isCollectionFor,
  REGION_COLLECTIONS,
  resourceArn,
  resourceKey,
  snapshotKeys,
} from './collections.js';
import { diffSnapshots } from './diff.js';
import { designRules, type DesignRule } from './rules/index.js';
import { GLOBAL_SCOPE, isProposedId, PROPOSED_PREFIX, type Issue, type Proposal } from './types.js';

/**
 * Field names that hold a *reference* to another resource (decision 47):
 * `arn`, or any camelCase name ending `Id`, `Ids` or `Arn` (`vpcId`,
 * `subnetIds`, `roleArn`). The resource's own top-level `id` and `arn` are
 * its identity, not a reference, and are never checked as one. `…Arns`
 * (plural) is deliberately not matched — those lists are mostly AWS-managed
 * policy ARNs the scanner never collects.
 */
export const REFERENCE_FIELD = /^arn$|^[a-z][A-Za-z0-9]*(?:Id|Ids|Arn)$/;

/**
 * Field names that hold an *account id*: `accountId`, `ownerId`,
 * `requesterId`, and any name ending `AccountId` or `OwnerId`
 * (`transitGatewayOwnerId`, `resourceOwnerId`, `ownerAccountId`). Exempt from
 * the reference rule because a link to an account nobody scanned is
 * legitimate (a vendor's TGW, a partner's peering); a 12-digit value naming
 * an account in neither the base nor the proposal is an `external-reference`
 * *warning*. The same exemption covers the object it sits in: a peering side
 * `{ accountId: <unscanned>, vpcId: … }` cannot be expected to resolve, so its
 * unresolved references warn rather than err.
 */
export const ACCOUNT_FIELD = /^(?:accountId|ownerId|requesterId)$|[a-z](?:AccountId|OwnerId)$/;

/**
 * Reference-shaped names whose values the scanner never collects as resources
 * (AMIs, association ids, Identity Center principals, AZ ids…). They are not
 * checked at all; listing one here is how to silence a false error.
 */
export const NON_REFERENCE_FIELDS: ReadonlySet<string> = new Set([
  'imageId',
  'associationId',
  'identityStoreId',
  'principalId',
  'clientId',
  'clientIds',
  'accessKeyIds',
  'authorizerId',
  'availabilityZoneId',
]);

/**
 * An AWS-native id: lower-case `prefix-suffix` where the prefix is one or more
 * dash-joined segments and the suffix at least 4 characters — `vpc-0a1b…`,
 * `tgw-attach-0a1b…`, `i-0abc…`, and the made-up `tgw-doesnotexist`. Region
 * names (`eu-west-1`) and AZ ids (`euw1-az1`) have a short final segment and
 * do not match; names, UUIDs and `alias/…` strings are not references to
 * check. The capture is the prefix.
 */
export const ID_SHAPE = /^([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-[0-9a-z]{4,}$/;

/**
 * Id prefixes of resources the scanner collects, so an unresolved id with one
 * of these prefixes is a definite `unresolved-reference` *error* even when the
 * base happens to hold none of that kind. Any prefix seen in the base is added
 * at validation time. An unresolved id with a prefix in neither is an
 * `unknown-reference` *warning*: the validator cannot tell whether the scanner
 * would have found it, and a confident wrong error is worse than a "cannot
 * tell" (ORCHESTRATION.md, "A signal that only works one way").
 */
export const COLLECTED_ID_PREFIXES: ReadonlySet<string> = new Set([
  'vpc', 'subnet', 'rtb', 'igw', 'eigw', 'nat', 'eipalloc', 'acl', 'sg', 'eni', 'vpce', 'vpce-svc', 'pl', 'fl',
  'dopt', 'eice', 'pcx', 'tgw', 'tgw-attach', 'tgw-rtb', 'vgw', 'cgw', 'vpn', 'dxcon', 'dxlag', 'dxvif', 'i',
  'cvpn-endpoint', 'lt',
]);

const ACCOUNT_ID = /^\d{12}$/;

export interface ValidateOptions {
  /** Promote every warning to an error (decision 47's `--strict`). */
  strict?: boolean;
  /** Rules to run instead of the registry; tests use this. */
  rules?: readonly DesignRule[];
}

/**
 * Every problem with `proposal` against `snapshot` (decisions 45–47), errors
 * first in op order, then warnings. An empty array means valid; any `error`
 * means exit 1. The proposal is first checked for shape (`checkProposalShape`)
 * — it may have come from JSON or YAML, not from typed code — and a malformed
 * proposal returns only its shape errors. Design rules run only when there are
 * no other errors. Neither input is mutated.
 */
export function validateProposal(snapshot: Snapshot, proposal: Proposal, options: ValidateOptions = {}): Issue[] {
  const shape = checkProposalShape(proposal);
  if (shape.length > 0) return shape;

  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const issue = (i: Issue): void => void (i.level === 'error' ? errors : warnings).push(i);

  if (proposal.base.generatedAt !== snapshot.generatedAt) {
    issue({
      level: 'warning',
      code: 'stale',
      path: 'base.generatedAt',
      message: `proposal was designed against the snapshot of ${proposal.base.generatedAt}; the loaded snapshot is ${snapshot.generatedAt || '(none)'}`,
    });
  }

  const scanned = new Set(snapshot.accounts.map((a) => a.accountId));
  const created = new Set<string>();
  (proposal.accounts ?? []).forEach((a, i) => {
    const path = `accounts[${i}].accountId`;
    if (scanned.has(a.accountId)) {
      issue({ level: 'error', code: 'account-exists', path, key: a.accountId, message: `account ${a.accountId} is already in the scanned snapshot; list only accounts the proposal creates` });
    } else if (created.has(a.accountId)) {
      issue({ level: 'error', code: 'duplicate-id', path, key: a.accountId, message: `account ${a.accountId} is listed twice` });
    }
    created.add(a.accountId);
  });
  const knownAccounts = new Set([...scanned, ...created]);

  // Reference resolution sees the whole proposal (a reference may point forward);
  // change/remove keys resolve in op order against what exists at that op.
  const baseKeys = snapshotKeys(snapshot);
  const proposalKeys = new Set<string>();
  for (const change of proposal.changes) {
    if (change.op !== 'add') continue;
    for (const key of [resourceKey(change.resource), resourceArn(change.resource)]) if (key) proposalKeys.add(key);
  }
  const prefixes = new Set(COLLECTED_ID_PREFIXES);
  const arnFamilies = new Set<string>();
  for (const key of baseKeys) {
    const m = ID_SHAPE.exec(key);
    if (m?.[1]) prefixes.add(m[1]);
    const family = arnFamily(key);
    if (family) arnFamilies.add(family);
  }
  const resolves = (key: string): boolean => baseKeys.has(key) || proposalKeys.has(key);
  const refs = { resolves, knownAccounts, prefixes, arnFamilies, issue };

  const live = new Set(baseKeys);
  const lastTouch = new Map<string, string>();
  proposal.changes.forEach((change, i) => {
    const at = `changes[${i}]`;
    if (change.op === 'add') {
      if (!knownAccounts.has(change.account)) {
        issue({ level: 'error', code: 'unknown-account', path: `${at}.account`, key: change.account, message: `account ${change.account} is neither scanned nor listed under \`accounts:\`` });
      }
      if (!isCollectionFor(change.region, change.collection)) {
        const scope = change.region === GLOBAL_SCOPE ? 'global' : 'region';
        issue({
          level: 'error',
          code: 'unknown-collection',
          path: `${at}.collection`,
          message: `\`${change.collection}\` is not a ${scope} collection; ${scope === 'global' ? 'global' : `region (${change.region})`} collections are: ${(scope === 'global' ? GLOBAL_COLLECTIONS : REGION_COLLECTIONS).join(', ')}`,
        });
      }
      const key = change.collection === 'generic' ? resourceArn(change.resource) ?? change.resource.id : change.resource.id;
      if (!key) {
        issue({ level: 'error', code: 'missing-id', path: `${at}.resource.id`, message: 'an added resource needs a string `id`' });
      } else {
        if (!isProposedId(key)) {
          issue({ level: 'error', code: 'not-proposed-id', path: `${at}.resource.id`, key, message: `a created id must start with \`${PROPOSED_PREFIX}\`; got \`${key}\`` });
        }
        if (live.has(key)) {
          issue({ level: 'error', code: 'duplicate-id', path: `${at}.resource.id`, key, message: `\`${key}\` already exists ${baseKeys.has(key) ? 'in the scanned snapshot' : 'earlier in this proposal'}` });
        }
        live.add(key);
        lastTouch.set(key, at);
        const arn = resourceArn(change.resource);
        if (arn) {
          live.add(arn);
          lastTouch.set(arn, at);
        }
      }
      checkReferences(change.resource, `${at}.resource`, true, refs);
    } else if (change.op === 'change') {
      if (!live.has(change.key)) {
        issue({ level: 'error', code: 'unresolved-key', path: `${at}.key`, key: change.key, message: `no resource has id or arn \`${change.key}\` at this point in the proposal` });
      }
      for (const field of ['id', 'arn']) {
        if (field in change.set) {
          issue({ level: 'error', code: 'immutable-field', path: `${at}.set.${field}`, key: change.key, message: `\`${field}\` cannot be changed; remove the resource and add a \`${PROPOSED_PREFIX}\` one instead` });
        }
      }
      lastTouch.set(change.key, at);
      checkReferences(change.set, `${at}.set`, false, refs);
    } else {
      if (!live.has(change.key)) {
        issue({ level: 'error', code: 'unresolved-key', path: `${at}.key`, key: change.key, message: `no resource has id or arn \`${change.key}\` at this point in the proposal` });
      }
      live.delete(change.key);
    }
  });

  if (errors.length === 0) {
    const applied = applyProposal(snapshot, proposal);
    const changes = diffSnapshots(snapshot, applied);
    const context = { base: snapshot, applied, proposal, changes, pathFor: (key: string) => lastTouch.get(key) };
    for (const rule of options.rules ?? designRules) {
      for (const found of rule.check(context)) warnings.push({ ...found, level: 'warning' });
    }
  }

  const all = [...errors, ...warnings];
  return options.strict ? all.map((i) => ({ ...i, level: 'error' as const })) : all;
}

interface RefContext {
  resolves(key: string): boolean;
  knownAccounts: Set<string>;
  prefixes: Set<string>;
  arnFamilies: Set<string>;
  issue(i: Issue): void;
}

/** `service:resource-type` of an ARN (`ec2:vpc`, `iam:role`), the ARN analogue of an id prefix. */
function arnFamily(arn: string): string | undefined {
  if (!arn.startsWith('arn:')) return undefined;
  const parts = arn.split(':');
  const service = parts[2];
  const resource = parts.slice(5).join(':');
  if (!service || !resource) return undefined;
  return `${service}:${resource.split(/[/:]/)[0] ?? ''}`;
}

function checkReferences(value: Record<string, unknown>, path: string, isResourceRoot: boolean, ctx: RefContext): void {
  // An object naming an unscanned account (a peering side, a cross-account
  // attachment) cannot be expected to resolve its references.
  let external = false;
  for (const [field, v] of Object.entries(value)) {
    if (!ACCOUNT_FIELD.test(field) || typeof v !== 'string' || !ACCOUNT_ID.test(v)) continue;
    if (!ctx.knownAccounts.has(v)) {
      external = true;
      ctx.issue({ level: 'warning', code: 'external-reference', path: `${path}.${field}`, key: v, message: `\`${field}\` names account ${v}, which is neither scanned nor created by this proposal` });
    }
  }
  for (const [field, v] of Object.entries(value)) {
    const at = `${path}.${field}`;
    if (isResourceRoot && (field === 'id' || field === 'arn')) continue;
    if (ACCOUNT_FIELD.test(field)) continue;
    if (REFERENCE_FIELD.test(field) && !NON_REFERENCE_FIELDS.has(field)) {
      if (typeof v === 'string') checkReference(v, field, at, external, ctx);
      else if (Array.isArray(v)) v.forEach((x, j) => typeof x === 'string' && checkReference(x, field, `${at}[${j}]`, external, ctx));
      continue;
    }
    descend(v, at, ctx);
  }
}

function descend(value: unknown, path: string, ctx: RefContext): void {
  if (Array.isArray(value)) value.forEach((x, j) => descend(x, `${path}[${j}]`, ctx));
  else if (value !== null && typeof value === 'object') checkReferences(value as Record<string, unknown>, path, false, ctx);
}

function checkReference(value: string, field: string, path: string, external: boolean, ctx: RefContext): void {
  if (value === '' || ctx.resolves(value)) return;
  const unresolved = (level: Issue['level'], code: string, why: string): void =>
    ctx.issue({ level, code, path, key: value, message: `\`${field}\` is \`${value}\`, which ${why}` });

  if (isProposedId(value)) return unresolved('error', 'unresolved-reference', 'no op in this proposal adds');

  if (value.startsWith('arn:')) {
    const account = value.split(':')[4] ?? '';
    if (account === 'aws') return; // AWS-owned (managed policies): exists, and is never scanned
    if (ACCOUNT_ID.test(account) && !ctx.knownAccounts.has(account)) {
      return unresolved('warning', 'external-reference', `is in account ${account}, which is not scanned`);
    }
    const family = arnFamily(value);
    if (ACCOUNT_ID.test(account) && family && ctx.arnFamilies.has(family) && !external) {
      return unresolved('error', 'unresolved-reference', 'resolves in neither the scanned snapshot nor this proposal');
    }
    return unresolved('warning', 'unknown-reference', 'is not in the snapshot; the scanner may not collect it, so this cannot be checked');
  }

  const m = ID_SHAPE.exec(value);
  if (!m?.[1]) return; // a name, a UUID, an alias — not a reference this rule can check
  if (external) return unresolved('warning', 'external-reference', 'cannot resolve: it belongs to an unscanned account');
  if (ctx.prefixes.has(m[1])) return unresolved('error', 'unresolved-reference', 'resolves in neither the scanned snapshot nor this proposal');
  return unresolved('warning', 'unknown-reference', `has prefix \`${m[1]}-\`, which the scanner does not collect, so this cannot be checked`);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

const TOP_FIELDS = new Set(['id', 'version', 'title', 'description', 'base', 'accounts', 'changes']);
const OP_FIELDS: Record<string, Set<string>> = {
  add: new Set(['op', 'account', 'region', 'collection', 'resource']),
  change: new Set(['op', 'key', 'set']),
  remove: new Set(['op', 'key']),
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Structural check of an untyped value against `Proposal` — what `parseProposal`
 * runs on parsed YAML and `validateProposal` runs first. Returns `malformed`
 * errors only; an empty array means the value is a well-typed `Proposal`.
 * Unknown fields are errors (a misspelt field is otherwise silently ignored),
 * and an account id written as a YAML number is an error with a hint to quote it.
 */
export function checkProposalShape(value: unknown): Issue[] {
  const issues: Issue[] = [];
  const bad = (path: string | undefined, message: string): void =>
    void issues.push({ level: 'error', code: 'malformed', message, ...(path !== undefined ? { path } : {}) });
  const str = (v: unknown, path: string, required: boolean): void => {
    if (v === undefined) {
      if (required) bad(path, 'required; expected a string');
    } else if (typeof v === 'number' && /accountId$|account$/.test(path)) {
      bad(path, `expected a string; quote account ids in YAML ("${v}") or leading zeros are lost`);
    } else if (typeof v !== 'string') {
      bad(path, `expected a string, got ${describe(v)}`);
    }
  };

  if (!isObject(value)) {
    bad(undefined, `a proposal must be a mapping, got ${describe(value)}`);
    return issues;
  }
  for (const k of Object.keys(value)) if (!TOP_FIELDS.has(k)) bad(k, `unknown field \`${k}\`; expected one of ${[...TOP_FIELDS].join(', ')}`);
  str(value['id'], 'id', true);
  if (value['version'] !== 1) bad('version', `must be 1, got ${describe(value['version'])}`);
  str(value['title'], 'title', true);
  str(value['description'], 'description', false);

  const base = value['base'];
  if (!isObject(base)) bad('base', 'required; expected a mapping with `generatedAt`');
  else {
    for (const k of Object.keys(base)) if (k !== 'generatedAt') bad(`base.${k}`, `unknown field \`${k}\`; expected generatedAt`);
    str(base['generatedAt'], 'base.generatedAt', true);
  }

  const accounts = value['accounts'];
  if (accounts !== undefined) {
    if (!Array.isArray(accounts)) bad('accounts', 'expected a list');
    else
      accounts.forEach((a, i) => {
        const at = `accounts[${i}]`;
        if (!isObject(a)) return bad(at, 'expected a mapping with `accountId`');
        for (const k of Object.keys(a)) if (!['accountId', 'alias', 'regions'].includes(k)) bad(`${at}.${k}`, `unknown field \`${k}\`; expected accountId, alias, regions`);
        str(a['accountId'], `${at}.accountId`, true);
        if (typeof a['accountId'] === 'string' && !ACCOUNT_ID.test(a['accountId'])) bad(`${at}.accountId`, 'expected 12 digits');
        str(a['alias'], `${at}.alias`, false);
        const regions = a['regions'];
        if (regions !== undefined && (!Array.isArray(regions) || regions.some((r) => typeof r !== 'string'))) {
          bad(`${at}.regions`, 'expected a list of region names');
        }
      });
  }

  const changes = value['changes'];
  if (!Array.isArray(changes)) bad('changes', 'required; expected a list of ops (`op: add | change | remove`)');
  else
    changes.forEach((c, i) => {
      const at = `changes[${i}]`;
      if (!isObject(c)) return bad(at, 'expected a mapping with `op`');
      const op = c['op'];
      const fields = typeof op === 'string' ? OP_FIELDS[op] : undefined;
      if (!fields) return bad(`${at}.op`, `expected add, change or remove, got ${describe(op)}`);
      for (const k of Object.keys(c)) if (!fields.has(k)) bad(`${at}.${k}`, `unknown field \`${k}\` for op ${op}; expected ${[...fields].join(', ')}`);
      if (op === 'add') {
        str(c['account'], `${at}.account`, true);
        str(c['region'], `${at}.region`, true);
        str(c['collection'], `${at}.collection`, true);
        const resource = c['resource'];
        if (!isObject(resource)) bad(`${at}.resource`, 'required; expected a mapping (the resource, with `id`)');
        else str(resource['id'], `${at}.resource.id`, true);
      } else {
        str(c['key'], `${at}.key`, true);
        if (op === 'change' && !isObject(c['set'])) bad(`${at}.set`, 'required; expected a mapping of fields to replace');
      }
    });
  return issues;
}

function describe(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  return typeof v === 'object' ? 'a mapping' : `${typeof v} ${JSON.stringify(v)}`;
}
