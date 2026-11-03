/**
 * Deterministic JSON: object keys sorted at every level, `undefined` members
 * dropped. The same idea as the scanner's `stable-json.ts` (which writes the
 * committed snapshots), copied rather than imported because it is a different
 * package. Two values are "the same" to the diff when these strings are equal.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? 'undefined';
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}
