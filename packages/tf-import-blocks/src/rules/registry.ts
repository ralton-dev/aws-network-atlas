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

/** Two modules claimed the same field for the same type; the first one won. */
export interface RuleConflict {
  readonly type: string;
  readonly field: 'fromScanned' | 'fromState' | 'notImportable';
}

const SOURCES: ReadonlyArray<readonly ImportRule[]> = [
  SCANNED_NETWORK,
  SCANNED_WORKLOAD,
  STATE,
];

type MutableRule = {
  -readonly [K in keyof ImportRule]: ImportRule[K];
};

function build(): {
  rules: ImportRule[];
  byType: Map<string, ImportRule>;
  byKind: Map<string, ImportRule>;
  conflicts: RuleConflict[];
} {
  const byType = new Map<string, MutableRule>();
  const conflicts: RuleConflict[] = [];

  for (const source of SOURCES) {
    for (const rule of source) {
      const existing = byType.get(rule.type);
      if (existing === undefined) {
        byType.set(rule.type, { ...rule, kinds: rule.kinds ? [...rule.kinds] : undefined });
        continue;
      }
      // First declaration wins per field, so a conflict is a bug worth naming
      // rather than a silent last-write.
      for (const field of ['fromScanned', 'fromState', 'notImportable'] as const) {
        if (rule[field] === undefined) continue;
        if (existing[field] === undefined) {
          // Narrowing per-field keeps this assignment honest under `strict`.
          if (field === 'fromScanned') existing.fromScanned = rule.fromScanned;
          else if (field === 'fromState') existing.fromState = rule.fromState;
          else existing.notImportable = rule.notImportable;
        } else {
          conflicts.push({ type: rule.type, field });
        }
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

const built = build();

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
