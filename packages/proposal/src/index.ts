/**
 * `@atlas/proposal` — a planned change to a scanned estate (PROPOSAL-OVERLAY.md).
 *
 * Pure TypeScript with no runtime dependency beyond `@atlas/schema`, safe for
 * the viewer to bundle. Reading YAML or `site/data/*.js` text lives in the
 * separate `@atlas/proposal/read` entry so the `yaml` package is never pulled
 * into the viewer: import that only from Node (scanner, tests).
 */
export * from './types.js';
export { applyProposal } from './apply.js';
export { diffSnapshots, indexChangeSet, type ChangeLookup } from './diff.js';
export {
  ACCOUNT_FIELD,
  checkProposalShape,
  COLLECTED_ID_PREFIXES,
  ID_SHAPE,
  NON_REFERENCE_FIELDS,
  REFERENCE_FIELD,
  validateProposal,
  type ValidateOptions,
} from './validate.js';
export { GLOBAL_COLLECTIONS, isCollectionFor, REGION_COLLECTIONS } from './collections.js';
export { stableStringify } from './stable-json.js';
export { designRules, type DesignRule, type DesignRuleContext } from './rules/index.js';
