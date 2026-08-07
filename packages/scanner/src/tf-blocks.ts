/**
 * `atlas-scan tf-blocks` — Terraform `import` blocks for every resource in a
 * state file, so a subtree can be moved into another configuration.
 *
 * This is a thin adapter over `tf-import-blocks`; every import id comes from
 * that package's per-type rule table, never from this file. The rule table is
 * the point: a resource's import id is **not** its `id` attribute for a large
 * fraction of the estate (`aws_sqs_queue` imports by queue URL,
 * `aws_lambda_function` by function name, `aws_route` by
 * `<route-table>_<destination>`), and the naive reading is wrong quietly.
 *
 * Two rules govern the output plumbing:
 *
 *   - **HCL to stdout, summary to stderr.** stdout is expected to be redirected
 *     into a `.tf` file, so a single line of prose on it corrupts the result.
 *     Nothing but HCL is ever written to stdout.
 *   - **Only identifiers leave the state file** (decision 6). Rules *read*
 *     attributes to compute an import id; the emitter writes the computed id
 *     and the address, and nothing else. The summary below deliberately reports
 *     only counts, terraform types and addresses — never an attribute value,
 *     and not even an import id, because stderr is frequently the thing that
 *     ends up pasted into a ticket.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { emitBlocks, parseStateFile, resolveStateResource, ruleForType } from 'tf-import-blocks';
import type { ResolvedImport } from 'tf-import-blocks';

export interface TfBlocksOptions {
  /** State files, relative to `cwd` or absolute. Raw v4 or `terraform show -json`. */
  readonly files: readonly string[];
  /** Emit only addresses starting with this prefix, e.g. `module.net.`. */
  readonly filter?: string | undefined;
  /** Where the user invoked the CLI — npm scripts run from the package dir. */
  readonly cwd: string;
}

/**
 * Counts only. Every field here is safe to print: numbers, terraform types and
 * Terraform addresses, all of which are already public in the generated HCL.
 */
export interface TfBlocksSummary {
  readonly files: number;
  /** Blocks actually emitted, after `--filter`. */
  readonly total: number;
  /** Blocks whose id a rule computed. */
  readonly viaRule: number;
  /** Blocks that fell back to the state id and carry `# VERIFY`. */
  readonly fallback: number;
  /**
   * Blocks for types with no documented import at all. Emitted (decision 5
   * forbids dropping a resource during a state move) but they will not apply,
   * which is a different problem from "we don't know the id" and is counted
   * separately so it can be acted on differently.
   */
  readonly notImportable: number;
  /**
   * Blocks whose source object is tainted. Emitted and counted as resolved —
   * taint is state metadata, so the id is real and the import is sound — but
   * the source configuration destroys and recreates the object on its next
   * apply, which is worth knowing before a move rather than after. Counted over
   * the blocks actually emitted, not over the parse, because unlike a skip a
   * tainted object *is* in the output and `--filter` can remove it.
   */
  readonly tainted: number;
  /** Distinct types among fallbacks that have no state rule. */
  readonly noRuleTypes: readonly string[];
  /** Distinct types whose rule ran but could not compute an id from this state. */
  readonly unresolvedTypes: readonly string[];
  /** Distinct types registered as explicitly not importable. */
  readonly notImportableTypes: readonly string[];
  /** Instances dropped as deposed — the orphan half of an interrupted replace. */
  readonly skippedDeposed: number;
  /** `mode: "data"` (decision 11). */
  readonly skippedDataSources: number;
  /** Resources from another provider (decision 11). */
  readonly skippedNonAws: number;
  /** Blocks withheld by `--filter`. */
  readonly filteredOut: number;
  /** Addresses emitted more than once — invalid HCL, so it must be shouted about. */
  readonly duplicateAddresses: readonly string[];
}

export interface TfBlocksResult {
  readonly hcl: string;
  readonly summary: TfBlocksSummary;
}

/**
 * The shorter of the relative and absolute forms. A state file is routinely
 * somewhere else entirely — /tmp, a sibling repo — where the relative form is a
 * stack of `../` that is harder to read than the path the user typed. Used for
 * parse-error labels and for the `--out` confirmation.
 */
export function displayPath(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs);
  return rel === '' || rel.startsWith('..') ? abs : rel;
}

type Bucket = 'viaRule' | 'notImportable' | 'unresolved' | 'noRule';

/**
 * Which of `resolveStateResource`'s three answers produced this block.
 *
 * The branch order mirrors that function exactly: `notImportable` is checked
 * before `verified`, and a rule that exists but returned `undefined` is a
 * different report from a type no rule module claims.
 */
function classify(item: ResolvedImport): Bucket {
  const rule = ruleForType(item.type);
  if (rule?.notImportable !== undefined) return 'notImportable';
  if (item.verified) return 'viaRule';
  return rule?.fromState !== undefined ? 'unresolved' : 'noRule';
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Read every state file, resolve every resource, emit one HCL document.
 *
 * Ordering is by address across the whole batch so re-running produces a stable
 * diff. That comparator must stay identical to the one inside
 * `importsFromState`, because `packages/scanner/test/tf-blocks.test.ts` asserts
 * this command reproduces the golden file byte for byte and would otherwise be
 * the only thing standing between the two paths and a silent divergence.
 */
export async function tfBlocks(opts: TfBlocksOptions): Promise<TfBlocksResult> {
  const resolved: ResolvedImport[] = [];
  // `ResolvedImport` carries no tainted flag — the state parser exposes the
  // count as `ParsedStateFile.tainted` and the taint itself only reaches the
  // output as a comment. Identity is the honest join: `resolveStateResource`
  // returns a fresh object per resource, so this set survives the sort and the
  // filter without matching on comment text or on an address that two states
  // can share.
  const taintedItems = new Set<ResolvedImport>();
  let skippedDeposed = 0;
  let skippedDataSources = 0;
  let skippedNonAws = 0;

  for (const file of opts.files) {
    const abs = path.resolve(opts.cwd, file);
    const label = displayPath(abs, opts.cwd);
    const parsed = parseStateFile(JSON.parse(await readFile(abs, 'utf8')), label);
    skippedDeposed += parsed.skipped.deposed;
    skippedDataSources += parsed.skipped.dataSources;
    skippedNonAws += parsed.skipped.nonAws;
    for (const res of parsed.resources) {
      const item = resolveStateResource(res);
      if (res.tainted === true) taintedItems.add(item);
      resolved.push(item);
    }
  }
  resolved.sort((a, b) => a.address.localeCompare(b.address));

  const prefix = opts.filter;
  const kept =
    prefix === undefined ? resolved : resolved.filter((i) => i.address.startsWith(prefix));

  const counts: Record<Bucket, number> = { viaRule: 0, notImportable: 0, unresolved: 0, noRule: 0 };
  const noRuleTypes: string[] = [];
  const unresolvedTypes: string[] = [];
  const notImportableTypes: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let tainted = 0;
  for (const item of kept) {
    const bucket = classify(item);
    counts[bucket] += 1;
    if (taintedItems.has(item)) tainted += 1;
    if (bucket === 'noRule') noRuleTypes.push(item.type);
    else if (bucket === 'unresolved') unresolvedTypes.push(item.type);
    else if (bucket === 'notImportable') notImportableTypes.push(item.type);
    // A state address is authoritative and the emitter never renames it, so two
    // states contributing the same address produce HCL Terraform will reject.
    if (seen.has(item.address)) duplicates.push(item.address);
    seen.add(item.address);
  }

  return {
    hcl: emitBlocks(kept),
    summary: {
      files: opts.files.length,
      total: kept.length,
      viaRule: counts.viaRule,
      fallback: counts.noRule + counts.unresolved,
      notImportable: counts.notImportable,
      tainted,
      noRuleTypes: sorted(noRuleTypes),
      unresolvedTypes: sorted(unresolvedTypes),
      notImportableTypes: sorted(notImportableTypes),
      skippedDeposed,
      skippedDataSources,
      skippedNonAws,
      filteredOut: resolved.length - kept.length,
      duplicateAddresses: sorted(duplicates),
    },
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The stderr summary, as lines. Zero-valued lines are omitted — except the
 * headline and the rule-coverage line, which are the two numbers a reader needs
 * even when they are boring.
 */
export function formatSummary(s: TfBlocksSummary): string[] {
  const lines = [
    `tf-blocks: ${plural(s.total, 'block')} from ${plural(s.files, 'state file')}`,
    `  ${s.viaRule} resolved by a rule`,
  ];
  if (s.fallback > 0) {
    lines.push(`  ${s.fallback} fell back to the state id, flagged # VERIFY`);
    if (s.noRuleTypes.length > 0) lines.push(`    no rule: ${s.noRuleTypes.join(', ')}`);
    if (s.unresolvedTypes.length > 0) {
      lines.push(`    rule could not compute an id: ${s.unresolvedTypes.join(', ')}`);
    }
  }
  if (s.notImportable > 0) {
    // Not a fallback: we know the id is unusable, rather than not knowing the
    // id. The block is emitted so the resource is not lost from a state move,
    // but it will not apply and the operator has to recreate it by hand.
    lines.push(
      `  ${s.notImportable} not importable at all — emitted but will not apply: ` +
        s.notImportableTypes.join(', '),
    );
  }
  if (s.tainted > 0) {
    // The opposite conclusion to the deposed line below, and they read as a
    // pair when a state has both: deposed is skipped because the object is
    // already doomed and duplicated, tainted is emitted because it is the only
    // object at its address and its id is real.
    lines.push(
      `  ${plural(s.tainted, 'tainted object')} in the source state — emitted, not skipped`,
      '    taint is state metadata and does not travel with the resource, so the id is',
      '    real and the import is sound; the source configuration will still destroy',
      '    and recreate the object on its next apply unless it is removed there first',
    );
  }
  if (s.filteredOut > 0) lines.push(`  ${s.filteredOut} withheld by --filter`);

  const skips: string[] = [];
  if (s.skippedDeposed > 0) skips.push(plural(s.skippedDeposed, 'deposed instance'));
  if (s.skippedDataSources > 0) skips.push(plural(s.skippedDataSources, 'data source'));
  if (s.skippedNonAws > 0) skips.push(plural(s.skippedNonAws, 'non-aws resource'));
  if (skips.length > 0) lines.push(`  skipped: ${skips.join(', ')}`);
  if (s.skippedDeposed > 0) {
    lines.push(
      '    a deposed instance is the orphan of an interrupted create-before-destroy;',
      '    it shares its address with the live object and is scheduled for destruction',
    );
  }
  if (s.duplicateAddresses.length > 0) {
    lines.push(
      `  WARNING: ${plural(s.duplicateAddresses.length, 'address')} emitted more than once — ` +
        'the output is not valid HCL as it stands:',
      ...s.duplicateAddresses.map((a) => `    ${a}`),
    );
  }
  return lines;
}

/** Write the HCL where the user asked, creating the parent directory if needed. */
export async function writeBlocks(hcl: string, out: string, cwd: string): Promise<string> {
  const abs = path.resolve(cwd, out);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, hcl, 'utf8');
  return abs;
}
