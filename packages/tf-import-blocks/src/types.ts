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
 * One nested terraform resource a scanned parent expands into.
 *
 * **The seam for expansion. Read this before writing an expander.**
 *
 * The snapshot nests some relationships inside the resource they belong to:
 * `SecurityGroup.ingress` / `.egress`, `NetworkAcl.entries`,
 * `RouteTable.routes`. Terraform does not — each is its own resource with its
 * own import id. The viewer indexes only what it draws, so those nested
 * relationships are not nodes and have nothing to hang an import block on. The
 * result was a half-adoption that looks complete: an `aws_security_group` block
 * you can paste, and rules terraform still does not manage.
 *
 * An expander closes that by turning one scanned parent into N children, where
 * **N is data-dependent** — it is a function of the collected fields, not a
 * property of the type. `from-scanned.ts` gives each child an address, applies
 * the same sanitising and collision dedupe parents get (decision 8), and emits
 * it whether or not its id could be built.
 *
 * Contract for an expander:
 *
 *  - **Never throw and never drop.** A relationship you cannot express is a
 *    child with `problem` set, not a missing child. Decision 5 in the plan is
 *    about resources; it applies with more force here, because a dropped child
 *    is invisible — nothing in the UI says it was ever considered.
 *  - **One relationship, one side.** An expander sees only its own subject, so
 *    a relationship recorded on both ends (a route table association nested
 *    under the route table *and* under the subnet) must be registered on
 *    exactly one of them. Nothing detects the duplicate: the two children would
 *    be emitted twice and address dedupe would rename rather than merge them.
 *  - **Scanned path only.** A state file already carries these as first-class
 *    resources, so expanding there would emit every one of them twice. The
 *    separation is structural — `from-state.ts` does not import
 *    `from-scanned.ts` — and `test/scanned-expand.test.ts` asserts it.
 *
 * What the mechanism deliberately cannot express, so the next author knows
 * before starting: **grandchildren** (expansion is one level, and no
 * relationship in this domain needs two); **cross-resource composition** (an
 * expander is handed one subject and cannot read the rest of the snapshot, so a
 * child needing a field off a *different* resource is out of reach); and
 * **ordering or dependency** between children, which `import` blocks do not
 * express at all.
 */
export interface ExpandedChild {
  /**
   * Terraform resource type, e.g. `aws_security_group_rule`. `''` is allowed
   * and renders the block commented out, for an expander that knows a
   * relationship exists but not which provider resource represents it.
   */
  readonly type: string;
  /**
   * The child-specific half of the suggested address. `from-scanned.ts`
   * prefixes the parent's own label and sanitises the result, so a child reads
   * as `aws_security_group_rule.<parent label>_<this>` and sorts beside its
   * parent. Legibility is the only requirement — uniqueness is dedupe's job.
   */
  readonly label: string;
  /**
   * The import id, unescaped (`emit.ts` owns escaping — decision 9). When
   * `problem` is set this may be a **partial** id: a reader completing three
   * characters is better served than one handed an empty string.
   */
  readonly id: string;
  /** Type-specific disclosure, one comment body per entry, no leading `# `. */
  readonly comments?: readonly string[] | undefined;
  /**
   * Why this child is not importable as written. Setting it is the single
   * switch that marks the child unverified and renders it commented out, so it
   * survives a bulk paste as visible evidence and cannot be applied by
   * accident. A child failing here never affects its siblings or its parent.
   */
  readonly problem?: string | undefined;
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
  /**
   * Terraform resource type, e.g. `aws_sqs_queue`. **The merge key**, and the
   * emitted type for every rule that does not declare `typeFromScanned`.
   *
   * For a rule that *does* declare `typeFromScanned` this string is the merge
   * key and nothing else — it is never emitted, and for a kind with no dominant
   * variant (`fsx`, `datasync-location`) it is an arbitrary member of the set
   * rather than a claim about the resource. `test/scanned-*.test.ts` pins that
   * distinction so deleting `typeFromScanned` fails loudly instead of quietly
   * restoring the arbitrary member as an answer.
   */
  readonly type: string;
  /** Atlas kinds this rule serves; drives `ruleForKind`. Omit for state-only. */
  readonly kinds?: readonly string[];
  /**
   * The terraform type *for this subject*, when one atlas kind covers several
   * provider resources and a collected field says which.
   *
   * `ImportRule.type` alone cannot express `apigw` (REST vs HTTP/WebSocket),
   * `lb` (`aws_lb` vs `aws_elb`), `tgw-attachment`, `dx-vif`, `apigw-vpc-link`,
   * `fsx` or `datasync-location`. Before this hook existed those kinds had two
   * bad options: declare the dominant type and emit it for every variant (a
   * confidently wrong `to =`), or decline the whole kind and emit nothing.
   *
   * When present this function is **authoritative, including when it answers
   * `undefined`** — which means "the scanned fields do not identify a single
   * terraform resource type for this subject". `from-scanned.ts` then emits no
   * type at all (`ResolvedImport.type === ''`, rendered commented out) rather
   * than falling back to `type`. A guess is unrecoverable; a commented-out
   * block is not.
   *
   * It is deliberately independent of `fromScanned`: the type and the import id
   * fail separately and a caller has to be told which one is missing. Most of
   * these kinds share one id form across all their variants, so the id is
   * usually right even when the type is unknown.
   */
  readonly typeFromScanned?: (subject: ScannedSubject) => string | undefined;
  /**
   * Every terraform type `typeFromScanned` can return. Emitted in the comment
   * when it returns `undefined`, so a commented-out block names the shortlist
   * the reader has to choose from instead of leaving them to guess. Required
   * alongside `typeFromScanned` and meaningless without it.
   */
  readonly typeChoices?: readonly string[];
  readonly fromScanned?: (subject: ScannedSubject) => string | undefined;
  readonly fromState?: (attrs: StateAttributes) => string | undefined;
  /**
   * Nested relationship resources this scanned parent contains — see
   * `ExpandedChild`. Only `resolveScannedExpanded` calls it, so `resolveScanned`
   * is unaffected and the state path can never reach it.
   *
   * **Registry caveat, and it is load-bearing.** `rules/registry.ts` merges two
   * declarations of one type field by field from a fixed list that does not
   * include `expand`; only the *first* declaration is spread wholesale.
   * `aws_security_group` survives because `scanned-network.ts` is declared
   * before `state.ts` in `SOURCES`. That is ordering, not design. The registry
   * belongs to WP-A and this package may not edit it, so
   * `test/scanned-expand.test.ts` asserts every declared expander is still
   * reachable after the merge — declare your expander in the module that
   * declares the type *first*, and check that test stays green.
   */
  readonly expand?: (subject: ScannedSubject) => readonly ExpandedChild[];
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
 * `type === ''` means the terraform type itself is unknown — either a scanned
 * kind with no rule at all, or a kind whose `typeFromScanned` could not tell
 * which of several provider resources this subject is. The emitter renders
 * those fully commented out, because a block with no type cannot be pasted.
 * `id` may still be correct in the second case, and the comments say so.
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
  /**
   * Render the whole stanza commented out even though the type is known.
   *
   * `type === ''` already forces that, but it conflates two different failures.
   * An expanded child can know its terraform type exactly and still be
   * unpastable — a security group rule with no source, a route with no
   * destination — and telling a reader the *type* is in doubt sends them to
   * check the half that never was. Additive and optional: every producer that
   * predates expansion omits it, and `emit.ts` keeps the `type === ''`
   * behaviour untouched.
   */
  readonly commentedOut?: boolean | undefined;
}

/**
 * A scanned resource and the nested relationship resources it contains.
 *
 * Returned by `resolveScannedExpanded` for the single-resource case (a details
 * panel wanting to show a parent and its rules as a group). Bulk callers want
 * `resolveScannedManyExpanded`, which flattens to the order `emitBlocks`
 * expects.
 *
 * `children` is empty for the overwhelming majority of kinds — no expander
 * registered, or a parent with nothing nested inside it — so a caller can treat
 * the expanded form as the default without special-casing.
 */
export interface ExpandedImport {
  readonly parent: ResolvedImport;
  readonly children: readonly ResolvedImport[];
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
