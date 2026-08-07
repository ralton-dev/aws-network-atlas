/**
 * Tier B — state-attribute resolvers, including the composite and attachment
 * types that dominate real state files and never appear on the graph.
 *
 * Owned by WP-D. Intentionally empty until then: an empty table is what makes
 * `test/golden.test.ts` red, and `registry.ts` already imports this module so
 * filling it needs no edit anywhere else.
 */
import type { ImportRule } from '../types.js';

export const RULES: ImportRule[] = [];
