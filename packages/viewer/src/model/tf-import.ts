/**
 * Adapter between the viewer's `ResourceRef` and the standalone
 * `tf-import-blocks` package: given a resource the graph knows about, produce
 * the `import { … }` block you would paste to adopt it.
 *
 * The package is deliberately atlas-free (decision 1) and accepts a structural
 * `ScannedSubject` (decision 2). `ResourceRef` already *is* that shape — same
 * `kind`, `id`, `arn`, `name`, `region`, `accountId`, `raw` — so it is passed
 * straight through. There is no converter here on purpose: writing one would
 * couple the package to the viewer and is the thing that would stop
 * `git mv packages/tf-import-blocks` from working.
 *
 * Nothing in this module renders. Both entry points return plain strings so the
 * details panel (single) and the Layers panel (bulk) can each present them
 * however they like.
 */
import {
  contextComment,
  dedupeAddresses,
  emitBlock,
  resolveScanned,
  resolveScannedExpanded,
  type ResolvedImport,
} from 'tf-import-blocks';
import type { TerraformBinding, TerraformStackFile } from '@atlas/schema';
import type { ResourceRef } from '../data.js';

/**
 * What the classifier below needs to know about the imported state.
 *
 * Structural on purpose: `AtlasIndex` satisfies it as-is, so nothing here
 * imports the index, and a caller with a narrower object (a test, a future
 * side panel) can supply one.
 */
export interface TerraformKnowledge {
  readonly terraform: readonly TerraformStackFile[];
  terraformFor(ref: ResourceRef): readonly TerraformBinding[];
}

/**
 * What we can *prove* about one nested resource — never what we assume.
 *
 * The three values are not a confidence ranking, they are three different
 * epistemic states, and collapsing the third into either of the others is the
 * failure this whole module exists to avoid:
 *
 * - `managed` — its import id is in an imported state, verbatim. Offer nothing.
 * - `unmanaged` — its import id is derivable, is not in any state, and nothing
 *   in the state we can see is unaccounted for. Offer the block plainly.
 * - `unproven` — **cannot tell.** Offer the block *and say so*, because the
 *   costly mistake is pasting an `import` block for a resource already in
 *   someone else's state. Decision 5 of `TERRAFORM-IMPORT-BLOCKS.md` — flag
 *   rather than hide — applied to a verdict rather than to a block.
 */
export type NestedStatus = 'managed' | 'unproven' | 'unmanaged';

/** A state instance that claims, or might claim, a nested resource. */
export interface StateClaim {
  readonly stack: string;
  readonly repo: string;
  readonly address: string;
  readonly type: string;
  /** Absent on a sidecar written before import ids were recorded. */
  readonly importId?: string | undefined;
}

/** One nested terraform resource the selected resource contains. */
export interface NestedBlock {
  readonly resolved: ResolvedImport;
  /**
   * The child's HCL **with the comments every sibling repeats removed** — see
   * `sharedChildComments`. Never what gets copied; `ImportBlock.text` is.
   * Empty for a `managed` child: there is nothing to offer, so there is
   * nothing to render.
   */
  readonly text: string;
  readonly status: NestedStatus;
  /** Where it is (`managed`) or may be (`unproven`) in state. */
  readonly claim?: StateClaim | undefined;
  /** Why this one specifically cannot be told apart from a state entry. */
  readonly doubt?: string | undefined;
}

export interface ImportBlock {
  /** What the rule table made of this resource — type, address, id, comments. */
  readonly resolved: ResolvedImport;
  /**
   * The rendered HCL for **everything this panel is offering** — the parent
   * when no state claims it, plus every nested resource that is not provably
   * already managed. This exact string is what the copy button copies: a block
   * pasted into a `.tf` file is read with no UI around it, so every comment
   * stays on it.
   *
   * `''` when there is nothing left to adopt.
   */
  readonly text: string;
  /** The parent stanza alone, for rendering above the children. */
  readonly parentText: string;
  /** True when an imported state already claims the parent itself. */
  readonly parentManaged: boolean;
  /** How many blocks `text` holds — what the copy button should promise. */
  readonly offered: number;
  /**
   * Terraform resources the snapshot nests inside this one — a security
   * group's rules today. Empty for almost every kind, so a caller can render
   * the expanded form unconditionally.
   *
   * **Every** child is here, including the provably managed ones, so the panel
   * can say "2 of these 4 are already in state" rather than silently showing
   * two. Only the non-managed ones contribute to `text`.
   */
  readonly children: readonly NestedBlock[];
  /**
   * One sentence naming what could not be checked, or `undefined` when the
   * state we can see accounts for itself completely. Rendered once above the
   * children rather than repeated on each, because it is a fact about the
   * imported state, not about any one rule.
   */
  readonly uncertainty?: string | undefined;
  /**
   * Comment bodies **every** child carries, hoisted out so the UI can state
   * them once instead of a dozen times.
   *
   * This is what stops expansion turning the panel into a wall. The provider's
   * warning about mixing `aws_security_group_rule` with inline rules is three
   * lines long and is on every rule block, correctly — it is the warning a
   * reader most needs and it must survive the paste. Repeating it on screen
   * next to twelve near-identical stanzas is how a reader learns to skip it.
   */
  readonly sharedChildComments: readonly string[];
}

/**
 * Opens the comment that travels with an unprovable block.
 *
 * On screen the same warning is a paragraph beside the stanza, so the stanza
 * itself is rendered without it — the panel would otherwise state it twice,
 * three inches apart, in two registers. It stays on every copied block, because
 * the clipboard is where the UI stops existing.
 */
const PASTE_NOTE_PREFIX = 'CHECK BEFORE APPLYING:';

/** Split a composite import id into the fields the two sides compose it from. */
const idFields = (id: string): string[] => id.split('_');

/**
 * Do two composite import ids describe the same resource with **one** field
 * written differently?
 *
 * The one thing the scanned side and the state side can legitimately disagree
 * about is how a single field is spelled. `aws_security_group_rule`'s
 * `self = true` is the case this repo has met: the state's id ends `_self`, AWS
 * reports the group's own id, and the expander can only emit what AWS reported
 * — so the two strings agree on group, direction, protocol and both ports and
 * differ in the source alone.
 *
 * Deliberately *not* a table of per-type aliases. Encoding `self` here would
 * put a slice of `rules/state.ts`'s grammar in the viewer, where it would rot
 * silently and, being wrong in the "already managed" direction, would hide a
 * resource that genuinely needs adopting. Counting differing fields needs no
 * grammar at all, generalises to routes and NACL entries on the same seam, and
 * — critically — its answer is only ever used to raise *doubt*, never to
 * declare a match. A false positive costs a warning; it cannot cost adoption.
 */
function differsInOneField(a: string, b: string): boolean {
  const fa = idFields(a);
  const fb = idFields(b);
  if (fa.length !== fb.length || fa.length < 2) return false;
  let diff = 0;
  for (let i = 0; i < fa.length; i += 1) if (fa[i] !== fb[i]) diff += 1;
  return diff === 1;
}

interface Verdict {
  readonly status: NestedStatus;
  readonly claim?: StateClaim | undefined;
  readonly doubt?: string | undefined;
  /**
   * The same doubt as a comment on the emitted block.
   *
   * A pasted `.tf` file is read with no UI around it — the panel's amber
   * callout does not travel, and the Layers note promising the unprovable
   * blocks are "marked in the file" is only true if something marks them. This
   * is that mark. Omitted for a block that is already commented out with its
   * own reason, where a second caveat is noise on a stanza that cannot apply.
   */
  readonly pasteNote?: string | undefined;
}

/** `2 aws_security_group_rule` / `1 aws_route`, for a sentence. */
function countByType(claims: readonly StateClaim[]): string {
  const counts = new Map<string, number>();
  for (const c of claims) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, n]) => `${n} ${type}`)
    .join(' and ');
}

const list = (values: Iterable<string>): string => {
  const all = [...new Set(values)].sort();
  const last = all.pop();
  if (last === undefined) return '';
  return all.length === 0 ? last : `${all.join(', ')} and ${last}`;
};

/**
 * Decide, for each nested resource, whether an imported state already manages
 * it — **and admit it when there is no way to know.**
 *
 * The match key is `importId`, never `id`: `aws_security_group_rule`'s state
 * `id` is a provider-synthesised `sgrule-<hash>` that corresponds to nothing
 * AWS returns, so the composite import id is the only string both sides can
 * derive. `TerraformResourceInstance.importId` documents this.
 *
 * Absence of `importId` is the trap, and it is why this returns three values
 * rather than a boolean. A sidecar written before the field existed carries
 * none, and so does any type whose import id simply *is* its `id` — the reader
 * cannot tell those apart, and neither can this. So state instances are placed
 * against a parent two different ways, and only one of them can prove anything:
 *
 * - **with an `importId`** the instance is self-locating: a nested resource's
 *   composite id opens with its parent's id, so a prefix match places it
 *   against this parent no matter which stack it lives in. These can match a
 *   scanned child exactly, and that is the only evidence that proves `managed`.
 * - **without one** the instance can only be placed by the stack holding it,
 *   so it counts against this parent when that stack manages the parent. It can
 *   never match anything; it can only withhold certainty from everything.
 *
 * The limit that follows, stated because it is real: a nested resource managed
 * by a stack that does *not* manage its parent, in a sidecar predating
 * `importId`, is invisible here and will be offered as unmanaged. Re-running
 * `atlas-scan tf-import` over that state removes the blind spot, which is what
 * the uncertainty sentence tells the reader to do.
 */
function classifyChildren(
  ref: ResourceRef,
  parentId: string,
  children: readonly ResolvedImport[],
  knowledge: TerraformKnowledge,
): { verdicts: Verdict[]; uncertainty?: string } {
  const bindingStacks = new Set(knowledge.terraformFor(ref).map((b) => b.stack));
  const types = new Set(children.map((c) => c.type).filter((t) => t !== ''));

  // Every state instance of a nested type, indexed for matching, and the
  // subset that could belong to *this* parent.
  const byImportId = new Map<string, StateClaim>();
  const local: StateClaim[] = [];
  for (const stack of knowledge.terraform) {
    for (const r of stack.resources) {
      if (!types.has(r.type)) continue;
      const claim: StateClaim = {
        stack: stack.stack,
        repo: stack.repo,
        address: r.address,
        type: r.type,
        importId: r.importId,
      };
      if (r.importId !== undefined && !byImportId.has(r.importId)) byImportId.set(r.importId, claim);
      const mine =
        r.importId === undefined ? bindingStacks.has(stack.stack) : r.importId.startsWith(`${parentId}_`);
      if (mine) local.push(claim);
    }
  }

  const verdicts: Verdict[] = [];
  const matched = new Set<string>();
  for (const child of children) {
    // A child whose id the rule could not build is already emitted commented
    // out; it also cannot be checked against anything, and saying "unmanaged"
    // about a string we admit is incomplete would be the confident half of a
    // guess. Left for the second pass, where it lands on `unproven`.
    const claim = child.verified && child.type !== '' ? byImportId.get(child.id) : undefined;
    if (claim !== undefined) matched.add(child.id);
    verdicts.push(claim === undefined ? { status: 'unmanaged' } : { status: 'managed', claim });
  }

  // What this parent's state says that the scan did not produce. Every one of
  // these is a disagreement between the two sides, and until each is explained
  // no unmatched child can be called unmanaged.
  const pool = local.filter((c) => c.importId === undefined || !matched.has(c.importId));

  // A near-match explains one of them and names it, so the reader can settle it
  // by looking at one address instead of auditing a stack.
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    const verdict = verdicts[i];
    if (child === undefined || verdict === undefined || verdict.status !== 'unmanaged') continue;
    if (!child.verified || child.type === '') continue;
    const near = pool.findIndex(
      (c) => c.importId !== undefined && c.type === child.type && differsInOneField(child.id, c.importId),
    );
    if (near === -1) continue;
    const [claim] = pool.splice(near, 1);
    if (claim === undefined) continue;
    verdicts[i] = {
      status: 'unproven',
      claim,
      doubt:
        `${claim.stack} holds ${claim.address}, whose import id differs from this one in a ` +
        'single field — almost certainly this same resource, written a way the scan cannot ' +
        'reproduce. Check that state before pasting: it is very likely already managed.',
      pasteNote:
        `${PASTE_NOTE_PREFIX} the ${claim.stack} state holds ${claim.address}, whose import ` +
        'id differs from this one in a single field — very likely this same resource written ' +
        'a way a scan cannot reproduce, in which case it is already managed and this block ' +
        'must not be applied',
    };
  }

  // Anything still unexplained withholds certainty from every remaining child.
  const stale = pool.filter((c) => c.importId === undefined);
  const disagreeing = pool.filter((c) => c.importId !== undefined);
  let uncertainty: string | undefined;
  if (pool.length > 0) {
    uncertainty = [
      stale.length === 0
        ? ''
        : `${list(stale.map((c) => c.stack))} recorded ${countByType(stale)} without an import ` +
          'id, so nothing below can be checked against it — that sidecar predates import ids. ' +
          'Re-run `atlas-scan tf-import` on that state to find out.',
      disagreeing.length === 0
        ? ''
        : `${countByType(disagreeing)} in ${list(disagreeing.map((c) => c.stack))} ` +
          `(${list(disagreeing.map((c) => c.address))}) could not be matched to anything this ` +
          'scan found on this resource, so one of the blocks below may already be managed.',
    ]
      .filter((s) => s !== '')
      .join(' ');
    const pasteNote = `${PASTE_NOTE_PREFIX} ${uncertainty.replace(/`/g, '')}`;
    for (let i = 0; i < verdicts.length; i += 1) {
      if (verdicts[i]?.status === 'unmanaged') verdicts[i] = { status: 'unproven', pasteNote };
    }
  }

  // Finally the children whose own id could not be built: unprovable on their
  // own terms, whatever the state says.
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child === undefined || verdicts[i]?.status === 'managed') continue;
    if (child.verified && child.type !== '') continue;
    verdicts[i] = {
      status: 'unproven',
      doubt:
        'the import id below could not be built from the scan, so it cannot be checked against ' +
        'any state — this may already be managed.',
    };
  }

  return uncertainty === undefined ? { verdicts } : { verdicts, uncertainty };
}

/**
 * The parent stanza, carrying an accurate count of what is emitted beside it.
 *
 * `resolveScannedExpanded` appends "N further blocks follow" to the parent's
 * comments, which is right when every child is offered and a lie the moment
 * one is withheld for being already managed. Rebuilding from `resolveScanned`
 * — the same address, without that comment — and restating it here keeps the
 * pasted file's own account of itself true, which matters more than usual
 * because that comment is the reader's only warning that adopting the parent
 * alone leaves its configuration unmanaged.
 */
function parentStanza(
  ref: ResourceRef,
  expanded: ResolvedImport,
  total: number,
  offered: number,
): ResolvedImport {
  if (total === 0) return expanded;
  const withheld = total - offered;
  const note =
    `this resource contains ${total} nested terraform resource${total === 1 ? '' : 's'}; ` +
    (withheld === 0
      ? `all ${total} follow below, and importing this block without them adopts the parent ` +
        'while leaving its configuration unmanaged'
      : offered === 0
        ? `all ${total} are already in terraform state, so none follow below`
        : `${withheld} ${withheld === 1 ? 'is' : 'are'} already in terraform state and ` +
          `${offered === 1 ? 'is' : 'are'} not repeated here, so ${offered} follow${offered === 1 ? 's' : ''} below`);
  const base = resolveScanned(ref);
  return { ...base, comments: [...base.comments, note] };
}

interface ImportPlan {
  readonly parent: ResolvedImport;
  readonly parentManaged: boolean;
  readonly children: readonly ResolvedImport[];
  readonly verdicts: readonly Verdict[];
  /** Children on offer, carrying their `CHECK BEFORE APPLYING` comment. */
  readonly offeredChildren: readonly ResolvedImport[];
  /** `children` index of each entry in `offeredChildren`, in step. */
  readonly offeredIndex: readonly number[];
  readonly uncertainty?: string | undefined;
}

/**
 * One resource expanded, classified, and reduced to what is actually on offer.
 *
 * Shared by the single and bulk forms so the details panel and the Layers
 * button can never disagree about what a paste contains — the defect that made
 * a button promise 31 blocks and deliver 47 was exactly this seam.
 */
function planImport(ref: ResourceRef, knowledge: TerraformKnowledge): ImportPlan {
  const expanded = resolveScannedExpanded(ref);
  const parentManaged = knowledge.terraformFor(ref).length > 0;
  const { verdicts, uncertainty } = classifyChildren(ref, expanded.parent.id, expanded.children, knowledge);
  const offeredChildren: ResolvedImport[] = [];
  const offeredIndex: number[] = [];
  for (let i = 0; i < expanded.children.length; i += 1) {
    const child = expanded.children[i];
    const verdict = verdicts[i];
    if (child === undefined || verdict?.status === 'managed') continue;
    const note = verdict?.pasteNote;
    // First, not last: a reader scanning a wall of stanzas reads the top of
    // each one, and this is the line that decides whether to apply it at all.
    offeredChildren.push(note === undefined ? child : { ...child, comments: [note, ...child.comments] });
    offeredIndex.push(i);
  }
  return {
    parent: parentStanza(ref, expanded.parent, expanded.children.length, offeredChildren.length),
    parentManaged,
    children: expanded.children,
    verdicts,
    offeredChildren,
    offeredIndex,
    uncertainty,
  };
}

/**
 * One resource's import block **and the resources nested inside it**.
 *
 * Never fails: an unknown kind is emitted commented out, and an expander that
 * throws costs its parent nothing — the package reports the failure on the
 * parent rather than losing it.
 *
 * It is called for managed resources too, and that is the point. A security
 * group adopted by a stack whose rules are not is the ordinary shape of drift,
 * and the panel used to offer that reader nothing at all — the group said
 * "claimed by stack X" and its unmanaged rules were never mentioned. What is
 * withheld now is only what is *proven* managed, one nested resource at a time.
 */
export function importBlockFor(ref: ResourceRef, knowledge: TerraformKnowledge): ImportBlock {
  const plan = planImport(ref, knowledge);
  // Dedupe across the family: a group and its rules are emitted together, so
  // two children resolving to the same suggested address collide here exactly
  // as they would in a bulk emit. Only what is emitted takes part — a withheld
  // child cannot collide with anything, and counting it would suffix a sibling
  // for a clash that never reaches the file.
  const offered = plan.parentManaged ? plan.offeredChildren : [plan.parent, ...plan.offeredChildren];
  const all = dedupeAddresses(offered);
  const kids = plan.parentManaged ? all : all.slice(1);
  const resolved = plan.parentManaged ? plan.parent : (all[0] ?? plan.parent);

  const first = kids[0];
  const shared =
    first === undefined
      ? []
      : first.comments.filter(
          (c) => !c.startsWith(PASTE_NOTE_PREFIX) && kids.every((k) => k.comments.includes(c)),
        );
  const sharedSet = new Set(shared);
  // Every child repeats its parent's `account · region` line, because a child
  // pasted on its own has to carry it. On screen the parent stanza is directly
  // above, so hoisting it would state it twice rather than once — drop it from
  // the hoisted list while still stripping it from the rendered children.
  const context = contextComment(resolved.accountId, resolved.region);
  const rendered = new Map<number, ResolvedImport>();
  for (let i = 0; i < plan.offeredIndex.length; i += 1) {
    const at = plan.offeredIndex[i];
    const deduped = kids[i];
    if (at !== undefined && deduped !== undefined) rendered.set(at, deduped);
  }

  return {
    resolved,
    text: all.length === 0 ? '' : all.map(emitBlock).join('\n\n') + '\n',
    parentText: emitBlock(resolved),
    parentManaged: plan.parentManaged,
    offered: all.length,
    children: plan.children.map((child, i) => {
      const verdict = plan.verdicts[i] ?? { status: 'unmanaged' as const };
      const block = rendered.get(i) ?? child;
      return {
        resolved: block,
        text:
          verdict.status === 'managed'
            ? ''
            : emitBlock({
                ...block,
                comments: block.comments.filter(
                  (c) => !sharedSet.has(c) && !c.startsWith(PASTE_NOTE_PREFIX),
                ),
              }),
        status: verdict.status,
        claim: verdict.claim,
        doubt: verdict.doubt,
      };
    }),
    sharedChildComments: shared.filter((c) => c !== context),
    uncertainty: plan.uncertainty,
  };
}

export interface BulkImportBlocks {
  /** The whole file: grouped, deduped, one trailing newline. Ready to paste. */
  readonly text: string;
  /** Every emitted block — parents *and* nested resources — in emission order. */
  readonly blocks: readonly ResolvedImport[];
  /** How many blocks came from a node in the view rather than from expansion. */
  readonly resources: number;
  /** How many blocks are nested resources the graph never drew. */
  readonly nested: number;
  /**
   * Nested resources withheld because an imported state provably manages them.
   * Not an error — the reason the block count is smaller than the rule count,
   * and worth stating so a shrinking number reads as progress.
   */
  readonly alreadyManaged: number;
  /**
   * Blocks offered whose managed status could **not** be established. They are
   * in `text` — hiding them would lose real drift — and a reader has to be told
   * to check them, so the count travels with the file.
   */
  readonly unproven: number;
  /**
   * Nodes contributing only nested blocks: resources terraform already manages
   * whose rules or routes it does not. Counting them as unmanaged resources
   * would overstate the drift; not counting them at all is what let a managed
   * group's unmanaged rules disappear from the bulk paste entirely.
   */
  readonly partiallyManaged: number;
  /** How many carry an id a rule actually computed. */
  readonly withRule: number;
  /** How many are `# VERIFY` fallbacks, including unknown-type blocks. */
  readonly needsVerify: number;
  /** How many are emitted commented out, so they cannot be applied on paste. */
  readonly commentedOut: number;
}

export interface BulkImportOptions {
  /** Account display name for the group headers, e.g. `index.accountLabel`. */
  accountLabel?(accountId: string): string;
}

/**
 * Everything in this view that terraform does not provably manage, in one
 * pasteable file — **including the nested resources inside a parent it does.**
 *
 * `refs` may hold managed resources, and must: a security group in a stack
 * whose rules are not is the ordinary shape of drift, and dropping it here for
 * being managed took its unmanaged rules with it silently. Each ref's parent
 * stanza is emitted only when no state claims it, and each nested resource only
 * when no state provably claims that.
 *
 * Three things here are not "call the single form in a loop", which is why this
 * lives in the model rather than in a component:
 *
 * 1. **Dedupe is a whole-file property.** Synthesised addresses collide —
 *    every VPC has a security group called `default` — and Terraform rejects a
 *    file with two blocks at the same address. `dedupeAddresses` therefore runs
 *    once across the *entire* batch, before grouping, so the `_2` suffix
 *    survives the split into per-account sections.
 * 2. **Grouping is a safety feature, not decoration.** Decision 10 emits no
 *    `provider =` argument because we cannot know the user's alias names, so
 *    the account and region a block came from is the only thing standing
 *    between a bulk paste and an import against the wrong account. The
 *    per-block context comment is folded into the section banner rather than
 *    repeated under it.
 * 3. **Sorting is by family, not by block.** `resolveScannedManyExpanded`
 *    documents that each parent is immediately followed by its own children,
 *    and sorting the flat list would destroy that — every
 *    `aws_security_group_rule` would collect in one alphabetical run, pages
 *    away from the group it belongs to, which is the arrangement most likely to
 *    get a rule pasted without its group or a group pasted without its rules.
 *    So the *families* are sorted and then flattened. A child always shares its
 *    parent's account and region, so a family can never straddle two sections.
 *
 * Order is account → region → parent address, so re-running produces a stable
 * diff.
 */
export function importBlocksFor(
  refs: readonly ResourceRef[],
  knowledge: TerraformKnowledge,
  options: BulkImportOptions = {},
): BulkImportBlocks {
  const families = refs
    .map((ref) => planImport(ref, knowledge))
    .sort(
      (a, b) =>
        (a.parent.accountId ?? '').localeCompare(b.parent.accountId ?? '') ||
        (a.parent.region ?? '').localeCompare(b.parent.region ?? '') ||
        a.parent.address.localeCompare(b.parent.address) ||
        a.parent.id.localeCompare(b.parent.id),
    );
  const nested = families.reduce((n, f) => n + f.offeredChildren.length, 0);
  const alreadyManaged = families.reduce(
    (n, f) => n + f.children.length - f.offeredChildren.length,
    0,
  );
  const unproven = families.reduce(
    (n, f) => n + f.verdicts.filter((v) => v.status === 'unproven').length,
    0,
  );
  const partiallyManaged = families.filter(
    (f) => f.parentManaged && f.offeredChildren.length > 0,
  ).length;
  const resolved = dedupeAddresses(
    families.flatMap((f) => (f.parentManaged ? f.offeredChildren : [f.parent, ...f.offeredChildren])),
  );

  const groups = new Map<string, ResolvedImport[]>();
  for (const item of resolved) {
    // `\u0000` as an escape, never a raw byte: a NUL in the source makes the
    // whole file binary to git and its diffs unreadable.
    const key = `${item.accountId ?? ''}\u0000${item.region ?? ''}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  const sections: string[] = [];
  for (const items of groups.values()) {
    const first = items[0];
    if (first === undefined) continue;
    // The banner already says which account and region these came from — drop
    // the identical per-block comment rather than printing it twice.
    const body = items
      .map((item) => {
        const own = contextComment(item.accountId, item.region);
        const comments = own === undefined ? item.comments : item.comments.filter((c) => c !== own);
        return emitBlock({ ...item, comments });
      })
      .join('\n\n');

    const context = contextComment(first.accountId, first.region);
    if (context === undefined) {
      sections.push(body);
      continue;
    }
    // `accountLabel` may already read "acme-prod (1111…)"; don't nest the id
    // inside its own alias.
    const id = first.accountId ?? '';
    const label = id === '' ? undefined : options.accountLabel?.(id);
    const who =
      label === undefined || label === id ? id : label.includes(id) ? label : `${id} (${label})`;
    const rule = `# ${'-'.repeat(74)}`;
    sections.push(`${rule}\n# ${context.replace(`account ${id}`, `account ${who}`)}\n${rule}\n\n${body}`);
  }

  return {
    text: sections.length === 0 ? '' : sections.join('\n\n') + '\n',
    blocks: resolved,
    resources: resolved.length - nested,
    nested,
    alreadyManaged,
    unproven,
    partiallyManaged,
    withRule: resolved.filter((r) => r.verified).length,
    needsVerify: resolved.filter((r) => !r.verified).length,
    // Two different failures render the same way and a reader about to paste
    // cares only that the block will not apply: an unknown terraform type
    // (`type === ''`) and a known type whose import id could not be built
    // (`commentedOut`, which only expansion produces).
    commentedOut: resolved.filter((r) => r.type === '' || r.commentedOut === true).length,
  };
}

/**
 * Put `text` on the clipboard, resolving to whether it worked.
 *
 * The async Clipboard API is unavailable on `file://`, and this viewer is
 * explicitly built to be opened by double-clicking `site/index.html` — so the
 * `execCommand` path is the one that actually runs for a large share of users,
 * not a legacy afterthought.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* insecure context or denied — fall through */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
