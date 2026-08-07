/**
 * The types every other module in this package is built on.
 *
 * This package is deliberately free of `@atlas/*` imports so it can be lifted
 * into its own repository unchanged. Nothing here may reference the snapshot
 * schema, the viewer, or the scanner.
 */

/**
 * Raw Terraform attributes for one resource instance, exactly as they appear
 * in state (`instances[].attributes` in raw v4, `values` in `terraform show
 * -json`). Values are `unknown`: rules must narrow before use, and `str()`
 * below is the intended way to do it.
 */
export type StateAttributes = Readonly<Record<string, unknown>>;

/**
 * A scanned resource, described structurally so this package never has to
 * import the viewer's `ResourceRef` (which satisfies this shape as-is — do not
 * write a converter).
 *
 * `id` is what the atlas scanner chose to store, which for several types is an
 * ARN rather than the AWS-native identifier. That is precisely the trap this
 * package exists to close: `id` is *not* the import id.
 */
export interface ScannedSubject {
  /** Atlas kind, e.g. `vpc`, `sqs-queue`, `lambda` (viewer `data.ts`). */
  readonly kind: string;
  /** Whatever the collector stored as `id` — often, but not always, native. */
  readonly id: string;
  readonly arn?: string | undefined;
  readonly name?: string | undefined;
  /** `''` for account-global resources (IAM, Route 53, CloudFront…). */
  readonly region: string;
  readonly accountId: string;
  /** The collected record itself; rules read type-specific fields from here. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * One resource type's import-id rule. **This interface is the seam between
 * WP-A and WP-B / WP-C / WP-D — it is fixed; build against it.**
 *
 * A rule may carry `fromScanned`, `fromState`, both, or neither (`notImportable`).
 *
 * - `fromScanned` is the drift-adoption path: only the atlas snapshot exists,
 *   so composite ids must be reconstructed from the collected fields. Rules
 *   registered in `rules/scanned-network.ts` (WP-B) and
 *   `rules/scanned-workload.ts` (WP-C) live here.
 * - `fromState` is the state-move path: real Terraform attributes are present,
 *   so composite ids are computable exactly. Rules registered in
 *   `rules/state.ts` (WP-D) live here.
 *
 * Where a type ends up with both, the registry merges the two declarations
 * into a single rule and **both functions must return the same string for the
 * same real resource**. That agreement is the plan's completion signal and
 * `test/golden.test.ts` asserts it.
 *
 * Returning `undefined` from either function means "this rule cannot compute
 * an id for this input". The caller then falls back to the raw identifier and
 * flags the block with `# VERIFY` (decision 5) — a wrong-but-flagged block,
 * never a dropped one.
 *
 * `notImportable` is the third answer: the type genuinely has no documented
 * import support. Set it (with the reason) instead of leaving the type to the
 * generic fallback, which would imply the id might work. Such blocks are still
 * emitted, carrying a loud `NOT IMPORTABLE:` comment — decision 5 forbids
 * silently dropping a resource during a state move.
 *
 * `doc` records where the format came from. Every non-obvious id must have
 * been read off `website/docs/r/<type>.html.markdown` in
 * `hashicorp/terraform-provider-aws`, not recalled.
 */
export interface ImportRule {
  /** Terraform resource type, e.g. `aws_sqs_queue`. Also the merge key. */
  readonly type: string;
  /** Atlas kinds this rule serves; drives `ruleForKind`. Omit for state-only. */
  readonly kinds?: readonly string[];
  readonly fromScanned?: (subject: ScannedSubject) => string | undefined;
  readonly fromState?: (attrs: StateAttributes) => string | undefined;
  /** Why this type cannot be imported at all. Mutually exclusive with the above. */
  readonly notImportable?: string;
  /** Provider doc page the id format was verified against. */
  readonly doc?: string;
}

/**
 * One resource resolved to something the emitter can write.
 *
 * `id` is the *unescaped* import id — `emit.ts` owns HCL escaping (decision 9)
 * and callers must not pre-escape.
 *
 * `comments` are comment bodies without the leading `# `; the emitter adds it.
 *
 * `type === ''` means the terraform type itself is unknown (a scanned kind with
 * no rule). The emitter renders those fully commented out, because a block with
 * no type cannot be pasted.
 */
export interface ResolvedImport {
  readonly type: string;
  readonly address: string;
  readonly id: string;
  readonly comments: readonly string[];
  /** True when a rule produced the id; false when this is a flagged fallback. */
  readonly verified: boolean;
  /**
   * True when the address was synthesised rather than read from state
   * (decision 8) — the UI must present it as a suggestion, and only these
   * participate in collision dedupe.
   */
  readonly addressIsSuggestion: boolean;
  readonly accountId?: string | undefined;
  /** `''` for global; `undefined` when the source could not tell us. */
  readonly region?: string | undefined;
}

/** Narrow an attribute to a non-empty string. The intended way to read `attrs`. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface ParsedArn {
  readonly partition: string;
  readonly service: string;
  /** `''` for global services (IAM, S3, Route 53). */
  readonly region: string;
  /** `''` for services that omit it (S3 bucket ARNs). */
  readonly accountId: string;
  /** Everything after the account field, `:` and `/` separators intact. */
  readonly resource: string;
}

/**
 * Split an ARN into its six fields. Returns `undefined` for anything that is
 * not `arn:<partition>:<service>:<region>:<account>:<resource…>`, so a caller
 * can use it as an "is this an ARN?" test.
 */
export function parseArn(value: unknown): ParsedArn | undefined {
  const arn = str(value);
  if (arn === undefined || !arn.startsWith('arn:')) return undefined;
  const parts = arn.split(':');
  if (parts.length < 6) return undefined;
  const [, partition, service, region, accountId] = parts;
  if (partition === undefined || service === undefined) return undefined;
  if (partition === '' || service === '') return undefined;
  return {
    partition,
    service,
    region: region ?? '',
    accountId: accountId ?? '',
    resource: parts.slice(5).join(':'),
  };
}
