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
  resolveScannedExpanded,
  type ResolvedImport,
} from 'tf-import-blocks';
import type { ResourceRef } from '../data.js';

/** One nested terraform resource the selected resource contains. */
export interface NestedBlock {
  readonly resolved: ResolvedImport;
  /**
   * The child's HCL **with the comments every sibling repeats removed** — see
   * `sharedChildComments`. Never what gets copied; `ImportBlock.text` is.
   */
  readonly text: string;
}

export interface ImportBlock {
  /** What the rule table made of this resource — type, address, id, comments. */
  readonly resolved: ResolvedImport;
  /**
   * The rendered HCL for **this resource and every nested resource inside it**.
   * This exact string is what the copy button copies: a block pasted into a
   * `.tf` file is read with no UI around it, so every comment stays on it.
   */
  readonly text: string;
  /** The parent stanza alone, for rendering above the children. */
  readonly parentText: string;
  /**
   * Terraform resources the snapshot nests inside this one — a security
   * group's rules today. Empty for almost every kind, so a caller can render
   * the expanded form unconditionally.
   */
  readonly children: readonly NestedBlock[];
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
 * One resource's import block **and the resources nested inside it**.
 *
 * Never fails: an unknown kind is emitted commented out, and an expander that
 * throws costs its parent nothing — the package reports the failure on the
 * parent rather than losing it.
 */
export function importBlockFor(ref: ResourceRef): ImportBlock {
  const { parent, children } = resolveScannedExpanded(ref);
  // Dedupe across the family: a group and its rules are emitted together, so
  // two children resolving to the same suggested address collide here exactly
  // as they would in a bulk emit.
  const all = dedupeAddresses([parent, ...children]);
  const [resolved = parent, ...kids] = all;

  const first = kids[0];
  const shared =
    first === undefined
      ? []
      : first.comments.filter((c) => kids.every((k) => k.comments.includes(c)));
  const sharedSet = new Set(shared);
  // Every child repeats its parent's `account · region` line, because a child
  // pasted on its own has to carry it. On screen the parent stanza is directly
  // above, so hoisting it would state it twice rather than once — drop it from
  // the hoisted list while still stripping it from the rendered children.
  const context = contextComment(resolved.accountId, resolved.region);

  return {
    resolved,
    text: all.map(emitBlock).join('\n\n') + '\n',
    parentText: emitBlock(resolved),
    children: kids.map((child) => ({
      resolved: child,
      text: emitBlock({ ...child, comments: child.comments.filter((c) => !sharedSet.has(c)) }),
    })),
    sharedChildComments: shared.filter((c) => c !== context),
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
 * Every unmanaged resource in one pasteable file — **and every terraform
 * resource nested inside one of them.**
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
  options: BulkImportOptions = {},
): BulkImportBlocks {
  const families = refs
    .map((ref) => resolveScannedExpanded(ref))
    .sort(
      (a, b) =>
        (a.parent.accountId ?? '').localeCompare(b.parent.accountId ?? '') ||
        (a.parent.region ?? '').localeCompare(b.parent.region ?? '') ||
        a.parent.address.localeCompare(b.parent.address) ||
        a.parent.id.localeCompare(b.parent.id),
    );
  const nested = families.reduce((n, f) => n + f.children.length, 0);
  const resolved = dedupeAddresses(families.flatMap((f) => [f.parent, ...f.children]));

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
