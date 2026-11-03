/**
 * Design rules (decision 48): warnings about a proposal that is well-formed but
 * probably wrong as a network design. This file is the registry. WP-1b adds
 * `cidr-overlap`, `subnet-in-vpc`, `attachment-locality`, `sg-rule-vpc` and
 * `route-target` as sibling files and lists them in `designRules`;
 * `validateProposal` runs whatever is listed and needs no edit to gain a rule.
 *
 * A rule runs only when the proposal has no errors (a rule may then assume
 * every op applied and every reference it checks resolved or was warned
 * about). It returns issues with `level: 'warning'`; the validator forces that
 * level regardless and promotes it to `error` under `--strict`.
 *
 * A rule may only warn about resources the proposal touched (`changes.added`
 * and `changes.changed`, matched by location) or that a touched resource
 * references — never about pre-existing problems in the base, which are the
 * scanner's business. Pre-existing overlaps in a real estate are common, and a
 * rule that reports them makes every proposal noisy and teaches the agent to
 * ignore warnings.
 */
import type { Snapshot } from '@atlas/schema';

import type { ChangeSet, Issue, Proposal } from '../types.js';

export interface DesignRuleContext {
  /** The scanned snapshot, untouched. */
  base: Snapshot;
  /** `applyProposal(base, proposal)` — what the estate would be. */
  applied: Snapshot;
  proposal: Proposal;
  /** `diffSnapshots(base, applied)` — what the proposal touched. */
  changes: ChangeSet;
  /**
   * The `Issue.path` of the op that last added or changed `key`
   * (`changes[3]`), so a warning points at the line the agent must edit.
   * `undefined` for a key no op touched.
   */
  pathFor(key: string): string | undefined;
}

export interface DesignRule {
  /** Stable `Issue.code`, kebab-case, e.g. `cidr-overlap`. */
  code: string;
  /** One sentence for a `--list-rules` style listing. */
  description: string;
  check(context: DesignRuleContext): Issue[];
}

/** The registered rules, run in this order. Empty until WP-1b. */
export const designRules: DesignRule[] = [];
