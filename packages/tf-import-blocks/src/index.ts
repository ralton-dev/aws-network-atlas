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
  ExpandedChild,
  ExpandedImport,
  ImportRule,
  ParsedArn,
  ResolvedImport,
  ScannedSubject,
  StateAttributes,
} from './types.js';
export { parseArn, str } from './types.js';

// `ProviderProvenance` is reachable through `StateResource.provider` below, so
// leaving it unexported meant a consumer could hold the value and had no way to
// write down its type. `providerComment` is the only thing the package does
// with one, and is the counterpart to the already-exported `contextComment`:
// exporting the type without it would hand callers a value they can name and
// still not use.
export type { ProviderProvenance } from './emit.js';
export {
  contextComment,
  dedupeAddresses,
  emitBlock,
  emitBlocks,
  escapeHcl,
  providerComment,
  sanitizeLabel,
  suggestAddress,
} from './emit.js';

export type { ParsedStateFile, StateResource, StateSkipCounts } from './from-state.js';
export { importsFromState, parseStateFile, resolveStateResource } from './from-state.js';

// `resolveScanned` answers one block per subject. `…Expanded` also answers the
// nested terraform resources the snapshot keeps *inside* that subject — a
// security group's rules today, NACL entries and routes on the same seam later.
// They are separate entry points rather than a flag because the state path must
// never expand: a state file already holds those as first-class resources, so
// expanding there would emit every one of them twice.
export {
  resolveScanned,
  resolveScannedExpanded,
  resolveScannedMany,
  resolveScannedManyExpanded,
} from './from-scanned.js';

export type { RuleConflict } from './rules/registry.js';
export { CONFLICTS, RULES, coveredKinds, ruleForKind, ruleForType } from './rules/registry.js';
