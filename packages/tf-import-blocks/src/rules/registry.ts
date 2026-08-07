/**
 * The rule table: three source modules merged by terraform type and indexed by
 * type *and* by atlas kind.
 *
 * This file is owned by WP-A for the whole plan and is not edited by anyone
 * else. A rule module that believes it needs to change the registry has found
 * a boundary problem — report it rather than editing here.
 *
 * Merging by type is what lets a single type be declared twice: once with
 * `fromScanned` (WP-B / WP-C) and once with `fromState` (WP-D). The merged rule
 * carries both, and `test/golden.test.ts` asserts the two agree.
 */
import type { ImportRule } from '../types.js';
import { RULES as SCANNED_NETWORK } from './scanned-network.js';
import { RULES as SCANNED_WORKLOAD } from './scanned-workload.js';
import { RULES as STATE } from './state.js';

/**
 * Every field merged per-declaration rather than per-rule.
 *
 * `type` is the merge key, `kinds` is unioned, and `doc` takes the first
 * non-empty answer — everything else is here. `typeFromScanned` and
 * `typeChoices` were missing from this list, so a second module declaring a
 * type with either had it dropped silently and recorded no conflict for it.
 * With one module declaring each type today that could not bite, which is
 * exactly why it would have: the day it stopped being true, an ambiguous kind
 * would quietly fall back to `ImportRule.type`, which for such a kind is an
 * arbitrary member of the set rather than a claim about the resource.
 */
const MERGED_FIELDS = [
  'fromScanned',
  'fromState',
  'notImportable',
  'typeFromScanned',
  'typeChoices',
] as const;

type MergedField = (typeof MERGED_FIELDS)[number];

/** Two modules claimed the same field for the same type; the first one won. */
export interface RuleConflict {
  readonly type: string;
  readonly field: MergedField;
}

const SOURCES: ReadonlyArray<readonly ImportRule[]> = [
  SCANNED_NETWORK,
  SCANNED_WORKLOAD,
  STATE,
];

type MutableRule = {
  -readonly [K in keyof ImportRule]: ImportRule[K];
};

/**
 * One field across, generic in the field so the compiler checks the pairing
 * once instead of the list being retyped by hand per field — the shape of
 * mistake that lost `typeFromScanned` in the first place.
 */
function copyField<K extends MergedField>(target: MutableRule, source: ImportRule, field: K): void {
  target[field] = source[field];
}

export interface MergedRules {
  readonly rules: ImportRule[];
  readonly byType: Map<string, ImportRule>;
  readonly byKind: Map<string, ImportRule>;
  readonly conflicts: RuleConflict[];
}

/**
 * Exported for its own test rather than for callers: the merge is the one part
 * of this file with behaviour, and with a single module declaring each type
 * today every branch of it is unreachable from the real tables. A defect in
 * here cannot be seen at all until the day a second module declares a type,
 * which is the worst possible time to discover it.
 */
export function mergeRules(sources: ReadonlyArray<readonly ImportRule[]>): MergedRules {
  const byType = new Map<string, MutableRule>();
  const conflicts: RuleConflict[] = [];

  for (const source of sources) {
    for (const rule of source) {
      const existing = byType.get(rule.type);
      if (existing === undefined) {
        byType.set(rule.type, { ...rule, kinds: rule.kinds ? [...rule.kinds] : undefined });
        continue;
      }
      // First declaration wins per field, so a conflict is a bug worth naming
      // rather than a silent last-write.
      for (const field of MERGED_FIELDS) {
        if (rule[field] === undefined) continue;
        if (existing[field] === undefined) copyField(existing, rule, field);
        else conflicts.push({ type: rule.type, field });
      }
      if (rule.kinds !== undefined) {
        existing.kinds = [...new Set([...(existing.kinds ?? []), ...rule.kinds])];
      }
      existing.doc ??= rule.doc;
    }
  }

  const byKind = new Map<string, ImportRule>();
  for (const rule of byType.values()) {
    for (const kind of rule.kinds ?? []) {
      if (!byKind.has(kind)) byKind.set(kind, rule);
    }
  }

  return {
    rules: [...byType.values()].sort((a, b) => a.type.localeCompare(b.type)),
    byType: new Map(byType),
    byKind,
    conflicts,
  };
}

const built = mergeRules(SOURCES);

/** Every merged rule, sorted by terraform type. */
export const RULES: readonly ImportRule[] = built.rules;

/** Fields two modules both claimed for one type. Empty means the tables agree. */
export const CONFLICTS: readonly RuleConflict[] = built.conflicts;

export function ruleForType(type: string): ImportRule | undefined {
  return built.byType.get(type);
}

export function ruleForKind(kind: string): ImportRule | undefined {
  return built.byKind.get(kind);
}

/** Every atlas kind the tables cover — used by the viewer to decide what it can offer. */
export function coveredKinds(): string[] {
  return [...built.byKind.keys()].sort();
}
