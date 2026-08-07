/**
 * The HCL emitter. Owns string escaping (decision 9), address sanitising and
 * collision dedupe (decision 8), and the comment forms (decisions 5 and 10).
 *
 * Everything here is string building — this package has no runtime
 * dependencies and deliberately no HCL library (decision 13).
 */
import type { ResolvedImport } from './types.js';

/**
 * Escape a value for an HCL quoted string.
 *
 * Backslash first, then the quote, then the two template openers. `${` is the
 * hazard decision 9 names: an import id containing it is otherwise interpolated
 * by Terraform at parse time. `%{` is the directive form of the same problem
 * (`%{if …}`) and is escaped for the same reason — S3 keys and tag values can
 * contain either.
 */
export function escapeHcl(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // Replacer *functions*, not replacement strings: in a replacement string
    // `$$` means a literal `$`, so the obvious `.replace(/\$\{/g, '$${')`
    // silently emits `${` and defeats the escape entirely.
    .replace(/\$\{/g, () => '$${')
    .replace(/%\{/g, () => '%%{');
}

/**
 * Coerce arbitrary text into an HCL identifier: `[A-Za-z_][A-Za-z0-9_-]*`.
 * Invalid characters become `_`; a result that cannot start an identifier is
 * prefixed with `r_` (decision 8).
 */
export function sanitizeLabel(raw: string): string {
  const mapped = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (mapped === '') return 'resource';
  return /^[A-Za-z_]/.test(mapped) ? mapped : `r_${mapped}`;
}

/** `<tf_type>.<sanitised name or id>` — a *suggestion*, per decision 8. */
export function suggestAddress(type: string, nameOrId: string): string {
  return `${type}.${sanitizeLabel(nameOrId)}`;
}

/**
 * `account <id> · region <region>` (decision 10). No `provider =` argument is
 * ever emitted — we cannot know the user's alias names, so the honest
 * mitigation for importing into the wrong provider is to say which account and
 * region the id came from.
 *
 * Returns `undefined` when neither is known, which is the common case for a
 * raw state file: nothing but an `arn` attribute tells us where a resource
 * lives, and plenty of types have no ARN. A line reading `account unknown ·
 * region unknown` carries no information an absent line does not.
 */
export function contextComment(
  accountId: string | undefined,
  region: string | undefined,
): string | undefined {
  const haveAccount = accountId !== undefined && accountId !== '';
  const haveRegion = region !== undefined;
  if (!haveAccount && !haveRegion) return undefined;
  const acct = haveAccount ? accountId : 'unknown';
  const reg = !haveRegion ? 'unknown' : region === '' ? 'global' : region;
  return `account ${acct} · region ${reg}`;
}

/**
 * Which provider *configuration* a state resource was managed through. Not the
 * provider itself (always `aws` here) — the config address, which is the only
 * place a state file says anything about **which account** a resource is in
 * when it has no ARN attribute to disclose it.
 */
export interface ProviderProvenance {
  /** Provider local name, e.g. `aws`. */
  readonly localName: string;
  /** Configuration alias, when the address carried one. */
  readonly alias?: string | undefined;
  /** Module the provider is configured in, e.g. `module.legacy`. */
  readonly module?: string | undefined;
}

/**
 * `source provider aws.usw2 — …` (decision 10, serving its intent rather than
 * only its letter).
 *
 * Decision 10 forbids a `provider =` argument because we cannot know the user's
 * alias names, and mitigates the wrong-account paste with a comment. The only
 * comment that existed was `account · region`, computed from an `arn`
 * attribute — so every type without one was silent, which on a two-account
 * state is most of the dangerous half. An alias is not an attribute value, so
 * naming it keeps decision 6 intact and closes most of that gap.
 *
 * Returns `undefined` for the root default provider: that is the provider the
 * target configuration already uses, so a line about it is noise, and its
 * absence is what leaves single-provider output unchanged.
 *
 * `addressInModule` changes the advice, not the warning. Verified against
 * terraform on `main` (2026-08-08), `internal/configs/import.go:80-90`: a
 * `provider` argument in an import block whose `to` address is inside a module
 * is rejected outright — "The provider argument can only be specified in import
 * blocks that will generate configuration" — and the user is directed to the
 * module block's `providers` argument instead. Advice that ignored that would
 * send someone to paste a configuration terraform refuses.
 */
export function providerComment(
  provider: ProviderProvenance,
  addressInModule: boolean,
): string | undefined {
  const aliased = provider.alias !== undefined && provider.alias !== '';
  const inModule = provider.module !== undefined && provider.module !== '';
  if (!aliased && !inModule) return undefined;

  const label =
    (inModule ? `${provider.module ?? ''}.` : '') +
    provider.localName +
    (aliased ? `.${provider.alias ?? ''}` : '');
  const why = aliased
    ? 'an aliased provider in the source state, so this resource is very likely not in the ' +
      'account or region your default provider points at'
    : 'configured inside that module rather than at the root, so it may not be the account ' +
      'your default provider points at';
  const how = addressInModule
    ? "an import block whose to = address is inside a module cannot take a provider argument, " +
      "so select the provider with the module block's providers argument"
    : `add provider = ${provider.localName}.<your alias> to this block if the target ` +
      'configuration aliases it too';
  return `source provider ${label} — ${why}; ${how}`;
}

/** One `import { … }` block, or a commented-out stanza when the type is unknown. */
export function emitBlock(item: ResolvedImport): string {
  const body = [
    'import {',
    `  to = ${item.address}`,
    `  id = "${escapeHcl(item.id)}"`,
    '}',
  ];
  const lines = item.comments.map((c) => `# ${c}`);
  // No terraform type means no writable address: comment the whole stanza so
  // it survives a bulk paste as visible evidence rather than as broken HCL.
  lines.push(...(item.type === '' ? body.map((l) => `# ${l}`) : body));
  return lines.join('\n');
}

/**
 * Resolve address collisions among *suggested* addresses (decision 8): the
 * second `aws_security_group.default` in a bulk emit becomes
 * `aws_security_group.default_2`, the third `_3`.
 *
 * Addresses that came from a state file are authoritative and never renamed —
 * if two of those collide, the state is malformed and hiding it would be worse
 * than emitting it.
 */
export function dedupeAddresses(items: readonly ResolvedImport[]): ResolvedImport[] {
  const taken = new Set<string>();
  for (const item of items) if (!item.addressIsSuggestion) taken.add(item.address);
  const out: ResolvedImport[] = [];
  for (const item of items) {
    if (!item.addressIsSuggestion) {
      out.push(item);
      continue;
    }
    let address = item.address;
    let n = 1;
    while (taken.has(address)) address = `${item.address}_${++n}`;
    taken.add(address);
    out.push(address === item.address ? item : { ...item, address });
  }
  return out;
}

/**
 * The whole file: blocks separated by a blank line, dedupe applied across the
 * batch, one trailing newline. Callers that want a stable diff should sort
 * before calling — this function preserves the order it is given.
 */
export function emitBlocks(items: readonly ResolvedImport[]): string {
  if (items.length === 0) return '';
  return dedupeAddresses(items).map(emitBlock).join('\n\n') + '\n';
}
