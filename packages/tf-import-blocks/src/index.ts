/**
 * `tf-import-blocks` — Terraform `import` blocks for resources you have but
 * your configuration does not.
 *
 * A resource's Terraform identity is a `(type, import-id)` pair produced by a
 * per-type rule, *not* its AWS id. `aws_sqs_queue` imports by queue URL,
 * `aws_lambda_function` by function name, `aws_ecs_service` by
 * `cluster/service`. The rule table in `rules/` is the asset; the two entry
 * points below are thin adapters onto it that differ only in what they can
 * feed it:
 *
 *   - `importsFromState`   — a state file, so attributes are available
 *   - `resolveScanned`     — a scanned resource, so they are not
 *
 * The package has no runtime dependencies and imports nothing from the atlas
 * it currently lives beside; it is expected to move to its own repository.
 */
export type {
  ImportRule,
  ParsedArn,
  ResolvedImport,
  ScannedSubject,
  StateAttributes,
} from './types.js';
export { parseArn, str } from './types.js';

export {
  contextComment,
  dedupeAddresses,
  emitBlock,
  emitBlocks,
  escapeHcl,
  sanitizeLabel,
  suggestAddress,
} from './emit.js';

export type { ParsedStateFile, StateResource, StateSkipCounts } from './from-state.js';
export { importsFromState, parseStateFile, resolveStateResource } from './from-state.js';

export { resolveScanned, resolveScannedMany } from './from-scanned.js';

export type { RuleConflict } from './rules/registry.js';
export { CONFLICTS, RULES, coveredKinds, ruleForKind, ruleForType } from './rules/registry.js';
