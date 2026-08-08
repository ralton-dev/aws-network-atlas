/**
 * `atlas-scan tf-import` — extract resource identifiers from Terraform state
 * files and write committable data/terraform/<stack>.json sidecars that the
 * bundler merges into the viewer payload.
 *
 * Two input formats are accepted (auto-detected):
 *   - raw state v4, i.e. the *.tfstate file itself or `terraform state pull`
 *   - `terraform show -json` output (format_version + values.root_module)
 *
 * Only identifiers (address, type, id, arn, importId) leave the state file. Raw
 * state attributes routinely contain secrets (DB passwords, private keys…) and
 * are deliberately never persisted.
 *
 * `importId` is the fifth of those and the newest. It is *an identifier* — the
 * string `terraform import` takes — computed from the attributes by the type's
 * rule, and it is the only key a resource nested inside another has on both
 * sides. It was previously derived, used for the match report, and thrown away
 * before writing; a reader of the sidecar therefore could not tell a managed
 * security group rule from an unmanaged one. It now travels. Nothing else does:
 * `sidecarResource` is a field-by-field projection and is the line, so a value
 * that is not an identifier cannot reach a written file by accident.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { RULES, ruleForType } from 'tf-import-blocks';
import type { ExpandedChild, ScannedSubject } from 'tf-import-blocks';
import type {
  AccountSnapshot,
  TerraformResourceInstance,
  TerraformStackFile,
} from '@atlas/schema';
import type { ResolvedConfig } from './config.js';
import { stableStringify } from './stable-json.js';

export function terraformDir(config: ResolvedConfig): string {
  return path.join(config.rootDir, config.outDir, 'terraform');
}

interface ParsedState {
  resources: TerraformResourceInstance[];
  terraformVersion?: string;
  serial?: number;
  lineage?: string;
}

/**
 * The type's documented import id, or `undefined` when it is the state `id`
 * again (which the caller already has) or cannot be computed.
 *
 * Guarded: a rule that throws on a malformed attribute map would otherwise take
 * down `tf-import` itself, and this feeds an informational report.
 */
function importIdFor(
  type: string,
  attrs: Record<string, unknown>,
  id: string | undefined,
): string | undefined {
  const fromState = ruleForType(type)?.fromState;
  if (fromState === undefined) return undefined;
  let computed: string | undefined;
  try {
    computed = fromState(attrs);
  } catch {
    return undefined;
  }
  return computed === undefined || computed === '' || computed === id ? undefined : computed;
}

/** `[0]` / `["blue"]` suffix for for_each/count instances, TF-address style. */
function indexSuffix(indexKey: unknown): string {
  if (typeof indexKey === 'number') return `[${indexKey}]`;
  if (typeof indexKey === 'string') return `[${JSON.stringify(indexKey)}]`;
  return '';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Managed AWS-provider resources only: skip data sources and other providers. */
function isManagedAws(mode: unknown, type: unknown): type is string {
  return mode === 'managed' && typeof type === 'string' && type.startsWith('aws_');
}

/** Raw state v4 — the *.tfstate format, also what `terraform state pull` emits. */
function parseRawState(state: Record<string, unknown>): ParsedState {
  const resources: TerraformResourceInstance[] = [];
  for (const res of (state['resources'] as Array<Record<string, unknown>> | undefined) ?? []) {
    if (!isManagedAws(res['mode'], res['type'])) continue;
    const type = res['type'] as string;
    const base = `${res['module'] ? `${String(res['module'])}.` : ''}${type}.${String(res['name'])}`;
    for (const inst of (res['instances'] as Array<Record<string, unknown>> | undefined) ?? []) {
      const attrs = (inst['attributes'] as Record<string, unknown> | undefined) ?? {};
      const id = str(attrs['id']);
      resources.push({
        address: base + indexSuffix(inst['index_key']),
        type,
        id,
        arn: str(attrs['arn']),
        importId: importIdFor(type, attrs, id),
      });
    }
  }
  return {
    resources,
    terraformVersion: str(state['terraform_version']),
    serial: typeof state['serial'] === 'number' ? state['serial'] : undefined,
    lineage: str(state['lineage']),
  };
}

/** `terraform show -json` — values.root_module with nested child_modules. */
function parseShowJson(state: Record<string, unknown>): ParsedState {
  const resources: TerraformResourceInstance[] = [];
  const walk = (mod: Record<string, unknown> | undefined): void => {
    if (!mod) return;
    for (const res of (mod['resources'] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (!isManagedAws(res['mode'], res['type'])) continue;
      const values = (res['values'] as Record<string, unknown> | undefined) ?? {};
      const type = res['type'] as string;
      const id = str(values['id']);
      resources.push({
        address: String(res['address']),
        type,
        id,
        arn: str(values['arn']),
        importId: importIdFor(type, values, id),
      });
    }
    for (const child of (mod['child_modules'] as Array<Record<string, unknown>> | undefined) ?? []) {
      walk(child);
    }
  };
  walk((state['values'] as Record<string, unknown> | undefined)?.['root_module'] as
    | Record<string, unknown>
    | undefined);
  return { resources, terraformVersion: str(state['terraform_version']) };
}

export function parseTerraformState(raw: unknown, sourceLabel: string): ParsedState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: not a JSON object — expected a Terraform state file`);
  }
  const state = raw as Record<string, unknown>;
  if (Array.isArray(state['resources']) && typeof state['version'] === 'number') {
    if (state['version'] !== 4) {
      throw new Error(
        `${sourceLabel}: unsupported state version ${String(state['version'])} — ` +
          'only v4 (Terraform ≥ 0.12) is supported; run `terraform state pull` with a current CLI',
      );
    }
    return parseRawState(state);
  }
  if (typeof state['format_version'] === 'string' && 'values' in state) {
    return parseShowJson(state);
  }
  throw new Error(
    `${sourceLabel}: unrecognized format — expected raw state v4 (terraform state pull) ` +
      'or `terraform show -json` output',
  );
}

/** Stack name → safe, unique-per-stack filename. */
function stackFileName(stack: string): string {
  return `${stack.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`;
}

export interface TfImportOptions {
  files: string[];
  /** Explicit stack name; only valid with a single file (else derived from filename). */
  stack?: string;
  repo: string;
  /** Base dir CLI paths are relative to (the invocation dir). */
  cwd: string;
}

export interface TfImportResult {
  file: string;
  /** Exactly what was written — identifiers only (decisions 6 and 14). */
  stack: TerraformStackFile;
  /** As parsed, before the projection below — the match report's input. */
  resources: TerraformResourceInstance[];
}

/**
 * Project a parsed resource down to the committed shape — **and this projection
 * is the guarantee, not a formality.**
 *
 * Decision 6 says only identifiers leave the state file, and the way that is
 * enforced is that this function names every field that may travel, one at a
 * time. A parser that grew an extra key, a rule that returned an attribute map,
 * a `Record<string, unknown>` cast anywhere upstream: none of them can reach
 * `data/terraform/<stack>.json` without a line being added here, which is a line
 * a reviewer sees. `test/tf-match-report.test.ts` asserts the written keys are
 * exactly this list and that a secret-shaped attribute never appears in the
 * bytes.
 *
 * `importId` joined the list in 2026-08 because it is an identifier and because
 * without it a nested resource cannot be told from a missing one. Everything
 * else about the file is unchanged: `stableStringify` drops `undefined`, so a
 * resource whose import id is its `id` writes exactly the bytes it wrote before.
 */
function sidecarResource(r: TerraformResourceInstance): TerraformResourceInstance {
  return { address: r.address, type: r.type, id: r.id, arn: r.arn, importId: r.importId };
}

export async function tfImport(
  config: ResolvedConfig,
  opts: TfImportOptions,
): Promise<TfImportResult[]> {
  if (opts.stack !== undefined && opts.files.length > 1) {
    throw new Error(
      '--stack names a single state file; import multiple files without it ' +
        '(stack names derive from the file names) or run tf-import once per stack',
    );
  }

  const results: TfImportResult[] = [];
  const dir = terraformDir(config);
  await mkdir(dir, { recursive: true });

  for (const file of opts.files) {
    const abs = path.resolve(opts.cwd, file);
    const label = path.relative(opts.cwd, abs) || abs;
    const parsed = parseTerraformState(JSON.parse(await readFile(abs, 'utf8')), label);
    const stackName =
      opts.stack ?? path.basename(abs).replace(/\.(tfstate|json)$/i, '').replace(/\.tfstate$/i, '');
    const resources = parsed.resources.sort((a, b) => a.address.localeCompare(b.address));
    const stack: TerraformStackFile = {
      version: 1,
      stack: stackName,
      repo: opts.repo,
      source: label,
      importedAt: new Date().toISOString(),
      terraformVersion: parsed.terraformVersion,
      serial: parsed.serial,
      lineage: parsed.lineage,
      resources: resources.map(sidecarResource),
    };
    const outFile = path.join(dir, stackFileName(stackName));
    await writeFile(outFile, stableStringify(stack) + '\n', 'utf8');
    results.push({ file: outFile, stack, resources });
  }
  return results;
}

/** All committed stack files, for the bundler and the match report. */
export async function readTerraformStacks(config: ResolvedConfig): Promise<TerraformStackFile[]> {
  const dir = terraformDir(config);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const stacks: TerraformStackFile[] = [];
  for (const f of files) {
    stacks.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')) as TerraformStackFile);
  }
  return stacks;
}

/**
 * Every id/arn the scanner knows about, deep-walked from the raw snapshots.
 * Heuristic on purpose: it only feeds the human-readable match report, never
 * the viewer (which matches per-resource via its own byKey index).
 */
export function collectSnapshotKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectSnapshotKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['id'] === 'string') keys.add(obj['id']);
    if (typeof obj['arn'] === 'string') keys.add(obj['arn']);
    for (const v of Object.values(obj)) {
      if (v !== null && typeof v === 'object') collectSnapshotKeys(v, keys);
    }
  }
  return keys;
}

/**
 * Where the scanner keeps the records for an atlas kind whose schema type
 * *contains* other terraform resources.
 *
 * The deep walk above harvests `id` and `arn`, which is every key a resource
 * that is a node has and none of the keys a resource nested inside one has:
 * `SecurityGroupRule`, `Route`, `NetworkAclEntry` and `DnsRecord` carry
 * neither field, because in the snapshot they are fields of their parent rather
 * than resources in their own right. `tf-import-blocks` can reconstruct their
 * composite ids from the parent — `ImportRule.expand` — and this table is the
 * one thing that path needs and cannot derive: which collection holds the
 * parents of a given kind. The viewer's `pushRegionRefs` is the same mapping
 * for the same reason, and cannot be shared (this package must not depend on
 * the viewer).
 *
 * It is a table of *nesting* kinds, not of expanders, so an expander added for
 * any kind listed here is picked up with no edit at all. One added for a kind
 * that is not listed is reported by `SnapshotKeyIndex.unreachableExpanders`
 * rather than silently doing nothing — a gap that names itself is the only kind
 * that survives contact with a later author.
 */
const NESTING_COLLECTIONS: ReadonlyArray<{
  readonly kind: string;
  readonly scope: 'region' | 'global';
  readonly collection: string;
}> = [
  { kind: 'sg', scope: 'region', collection: 'securityGroups' },
  { kind: 'nacl', scope: 'region', collection: 'networkAcls' },
  { kind: 'route-table', scope: 'region', collection: 'routeTables' },
  { kind: 'vpce', scope: 'region', collection: 'vpcEndpoints' },
  { kind: 'zone', scope: 'global', collection: 'hostedZones' },
];

/** Every scanned record of one kind, in the shape `ImportRule.expand` wants. */
function subjectsOfKind(
  snapshots: readonly AccountSnapshot[],
  source: (typeof NESTING_COLLECTIONS)[number],
): ScannedSubject[] {
  const out: ScannedSubject[] = [];
  const push = (records: unknown, accountId: string, region: string): void => {
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
      const raw = record as Record<string, unknown>;
      const id = str(raw['id']);
      if (id === undefined) continue;
      out.push({
        kind: source.kind,
        id,
        arn: str(raw['arn']),
        name: str(raw['name']),
        region,
        accountId,
        raw,
      });
    }
  };
  // Every lookup is defensive for one reason: a snapshot committed by an older
  // scanner predates whichever collection was added since, and `global` itself
  // predates nothing but is absent from the very oldest. The viewer fills those
  // in from the empty factories at load; nothing does that here, and a match
  // report is not worth crashing an import over. `push` treats a non-array as
  // an absent collection, so this only has to survive reaching it.
  for (const account of snapshots) {
    if (source.scope === 'global') {
      const global = account.global as unknown as Record<string, unknown> | undefined;
      push(global?.[source.collection], account.accountId, '');
      continue;
    }
    for (const region of account.regions ?? []) {
      push(
        (region as unknown as Record<string, unknown>)[source.collection],
        account.accountId,
        region.region,
      );
    }
  }
  return out;
}

/**
 * The keys a stack's resources are matched against, and what the scan proved it
 * can see while building them.
 */
export interface SnapshotKeyIndex {
  /** Every scanned `id`/`arn`, plus every composite id an expander derived. */
  readonly keys: Set<string>;
  /**
   * Terraform types an expander produced at least one usable id for. Evidence,
   * not a declaration: it says this snapshot yielded keys of that type's shape,
   * so a state resource of that type failing to match means something.
   */
  readonly expandedTypes: Set<string>;
  /**
   * Registered expanders whose records this file cannot locate — a kind missing
   * from `NESTING_COLLECTIONS`, or an expander on a rule that declares no kinds
   * at all (which `ruleForKind` could never reach either). Surfaced so the gap
   * is a line of output rather than a quiet loss of coverage.
   */
  readonly unreachableExpanders: string[];
}

/**
 * Build the match key set: the deep walk, plus every nested terraform resource
 * the registry's expanders can reconstruct from a scanned parent.
 *
 * This is the half of the fix on the snapshot side. The other half is on the
 * state side, in `parseTerraformState`: an `aws_security_group_rule`'s state
 * `id` is `sgrule-<hash>`, not the composite, so both sides have to compute the
 * documented import id for the two to meet. That they meet at all is the
 * property `tf-import-blocks/test/golden.test.ts` exists to hold.
 */
export function snapshotKeyIndex(snapshots: readonly AccountSnapshot[]): SnapshotKeyIndex {
  const keys = collectSnapshotKeys(snapshots);
  const expandedTypes = new Set<string>();
  const unreachableExpanders: string[] = [];

  for (const rule of RULES) {
    if (rule.expand === undefined) continue;
    const kinds = rule.kinds ?? [];
    if (kinds.length === 0) {
      unreachableExpanders.push(rule.type);
      continue;
    }
    for (const kind of kinds) {
      const source = NESTING_COLLECTIONS.find((c) => c.kind === kind);
      if (source === undefined) {
        unreachableExpanders.push(kind);
        continue;
      }
      for (const subject of subjectsOfKind(snapshots, source)) {
        // The expander contract says never throw, and this is a report: a rule
        // that breaks it must not take the import down with it.
        let children: readonly ExpandedChild[] = [];
        try {
          children = rule.expand(subject);
        } catch {
          continue;
        }
        for (const child of children) {
          // A child with a `problem` carries a deliberately partial id, and a
          // partial id can only ever match something by accident.
          if (child.problem !== undefined || child.type === '' || child.id === '') continue;
          keys.add(child.id);
          expandedTypes.add(child.type);
        }
      }
    }
  }

  return { keys, expandedTypes, unreachableExpanders };
}

/**
 * Why one state resource went unmatched. The whole point of the split: the
 * first of these is alarming and actionable, the other two are not, and one
 * list holding all three is read as forty lines of the first.
 */
export type UnmatchedReason =
  /** The scanner does index this type, and this resource still was not found. */
  | 'stale'
  /** Nothing in the scan can produce a key of this shape, so absence proves nothing. */
  | 'not-indexed'
  /** No import rule for the type at all — the registry cannot say either way. */
  | 'unknown-type';

/**
 * Is a terraform type one the scan could have found, had the resource existed?
 *
 * Derived from the rule registry and from this run, never from a hand-kept
 * list, which would rot the first time a collector was added. Two independent
 * signals, and neither is sound alone:
 *
 *  - **`ImportRule.kinds`.** A rule carries `kinds` when the atlas draws the
 *    type, which means a collector writes a snapshot record for it and
 *    `collectSnapshotKeys` harvests that record's `id`/`arn`. Verified rather
 *    than assumed: all 136 rules that declare `kinds` declare kinds that
 *    `viewer/src/data.ts` actually indexes, so `kinds` ⇒ indexed holds. The
 *    converse does **not**: `RegionSnapshot.generic` is an ARN sweep over the
 *    Resource Groups Tagging and Cloud Control APIs, so a Tier-B type with no
 *    `kinds` — `aws_ecs_cluster`, `aws_kinesis_stream`, `aws_launch_template` —
 *    is routinely in the key set anyway. Reading "no kinds" as "never indexed"
 *    would file a genuinely stale resource under "expected".
 *  - **A sibling matched, or an expander covered the type.** If any resource of
 *    the same type in this stack matched, the scan demonstrably produces keys
 *    of that type's shape; `SnapshotKeyIndex.expandedTypes` says the same thing
 *    for a type reconstructed from a scanned parent, and says it even when this
 *    particular stack holds none that matched. This is what repairs the
 *    generic-sweep hole above, and it costs nothing to maintain.
 *
 * Where neither fires we say `not-indexed` — and it means "this scan produced
 * no evidence it can see this type", not "this type is invisible forever". A
 * type with no rule at all gets its own answer rather than being folded into
 * either: the registry knows nothing about it, and saying so is the honest
 * report.
 */
function unmatchedReason(
  type: string,
  matchedTypes: ReadonlySet<string>,
  expandedTypes: ReadonlySet<string>,
): UnmatchedReason {
  const rule = ruleForType(type);
  if (rule === undefined) return 'unknown-type';
  if (matchedTypes.has(type) || expandedTypes.has(type)) return 'stale';
  return (rule.kinds?.length ?? 0) > 0 ? 'stale' : 'not-indexed';
}

export interface StackMatchReport {
  stack: string;
  /** Every managed AWS resource in the state file. */
  total: number;
  matched: number;
  /**
   * `matched + stale` — the denominator that means something.
   *
   * `matched/total` was the headline and it was materially misleading: a stack
   * whose every drawable resource matched and whose remainder is security group
   * rules reported something like 50/100, which reads as half the stack being
   * stale. The types we never index cannot be matched by anyone and belong
   * beside the ratio, not inside it.
   */
  checkable: number;
  /** Indexed type, still not found: stale state, drift, or an unscanned region. */
  stale: TerraformResourceInstance[];
  /** Nothing in the scan can produce a key of this shape. Expected; no action. */
  notIndexed: TerraformResourceInstance[];
  /** No import rule for the type — we cannot say whether it is stale. */
  unknownType: TerraformResourceInstance[];
}

export function matchReport(
  stack: string,
  resources: readonly TerraformResourceInstance[],
  snapshot: SnapshotKeyIndex,
): StackMatchReport {
  const { keys } = snapshot;
  // `importId` is tried last and only when it differs from `id`, so a type
  // whose state id already is the import id matches by exactly the route it
  // always did.
  const matches = (r: TerraformResourceInstance): boolean =>
    Boolean(r.arn && keys.has(r.arn)) ||
    Boolean(r.id && keys.has(r.id)) ||
    Boolean(r.importId && keys.has(r.importId));

  // Two passes: the first pass is what tells the second which types this scan
  // has been shown to produce keys for.
  const matchedTypes = new Set<string>();
  let matched = 0;
  for (const r of resources) {
    if (!matches(r)) continue;
    matchedTypes.add(r.type);
    matched += 1;
  }

  const stale: TerraformResourceInstance[] = [];
  const notIndexed: TerraformResourceInstance[] = [];
  const unknownType: TerraformResourceInstance[] = [];
  for (const r of resources) {
    if (matches(r)) continue;
    const reason = unmatchedReason(r.type, matchedTypes, snapshot.expandedTypes);
    if (reason === 'stale') stale.push(r);
    else if (reason === 'not-indexed') notIndexed.push(r);
    else unknownType.push(r);
  }

  return {
    stack,
    total: resources.length,
    matched,
    checkable: matched + stale.length,
    stale,
    notIndexed,
    unknownType,
  };
}

/** `aws_security_group_rule ×30, aws_route ×4`, commonest type first. */
function byTypeCounts(resources: readonly TerraformResourceInstance[]): string {
  const counts = new Map<string, number>();
  for (const r of resources) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${type} ×${n}`)
    .join(', ');
}

/**
 * The console report, as lines — the caller prefixes each with the stack name.
 *
 * Only the stale list names individual resources, because it is the only list
 * anyone has to act on. The other two are summarised by type and count: a
 * reader who has just been told 34 security group rules cannot be checked does
 * not need 34 addresses to know what to do about it, which is nothing. Decision
 * 6 bounds what may appear here — addresses, terraform types, counts, and the
 * `id`/`arn` identifiers `tf-import` already persists; never an attribute value.
 */
export function formatMatchReport(report: StackMatchReport, snapshotCount: number): string[] {
  const lines = [
    `matched ${report.matched}/${report.checkable} checkable against ` +
      `${snapshotCount} scanned account snapshot(s)`,
  ];
  const unCheckable = report.total - report.checkable;
  if (unCheckable > 0) {
    lines.push(
      `  ${unCheckable} of ${report.total} are not checkable against a scan — counted ` +
        'beside the ratio rather than inside it, so they cannot read as drift',
    );
  }
  if (report.stale.length > 0) {
    lines.push(
      `${report.stale.length} in state that the scan should have found — stale state, ` +
        'drift, or a region/account this scan does not cover:',
    );
    for (const r of report.stale.slice(0, 20)) {
      lines.push(`  - ${r.address} (${r.arn ?? r.id ?? 'no id'})`);
    }
    if (report.stale.length > 20) lines.push(`  … and ${report.stale.length - 20} more`);
  }
  if (report.notIndexed.length > 0) {
    lines.push(
      `${report.notIndexed.length} of a type this scan produces no key for — expected, not drift:`,
      `    ${byTypeCounts(report.notIndexed)}`,
    );
  }
  if (report.unknownType.length > 0) {
    lines.push(
      `${report.unknownType.length} of a type with no import rule, so this cannot say ` +
        'whether they are stale:',
      `    ${byTypeCounts(report.unknownType)}`,
    );
  }
  return lines;
}
