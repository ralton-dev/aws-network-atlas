/**
 * The drift-adoption path: turn a scanned resource into an import block.
 *
 * Only the atlas snapshot exists here — there is no Terraform address and no
 * attribute map, so the address is *synthesised* (decision 8: it is a
 * suggestion the user is expected to rename) and composite ids have to be
 * reconstructed from collected fields by the rule.
 *
 * The counterpart of `from-state.ts`. Where a type has a rule on both sides,
 * the two must produce the same string for the same real resource — that
 * agreement is the plan's completion signal and `test/golden.test.ts` asserts it.
 */
import { contextComment, suggestAddress } from './emit.js';
import { ruleForKind } from './rules/registry.js';
import type { ResolvedImport, ScannedSubject } from './types.js';

/**
 * Resolve one scanned resource.
 *
 * Never returns `undefined`: decision 5 says an unresolvable resource is
 * flagged, not dropped. When no rule covers the kind we do not even know the
 * terraform type, so the result carries `type: ''` and the emitter renders it
 * commented out — visible, honest, and impossible to paste by accident.
 */
export function resolveScanned(subject: ScannedSubject): ResolvedImport {
  const rule = ruleForKind(subject.kind);
  const context = contextComment(subject.accountId, subject.region);
  const comments: string[] = [];
  if (context !== undefined) comments.push(context);

  if (rule === undefined) {
    comments.push(
      `VERIFY: no import rule for atlas kind "${subject.kind}" — the terraform ` +
        'resource type is unknown, so the id below is the scanned identifier ' +
        'and is very likely not the import id',
    );
    return {
      type: '',
      address: '',
      id: subject.id,
      comments,
      verified: false,
      addressIsSuggestion: true,
      accountId: subject.accountId,
      region: subject.region,
    };
  }

  const address = suggestAddress(rule.type, subject.name ?? subject.id);
  let id = subject.id;
  let verified = false;
  if (rule.notImportable !== undefined) {
    comments.push(`NOT IMPORTABLE: ${rule.type} — ${rule.notImportable}`);
    comments.push('VERIFY: this block is emitted so the resource is not lost; it will not apply');
  } else if (rule.fromScanned !== undefined) {
    const computed = rule.fromScanned(subject);
    if (computed !== undefined && computed !== '') {
      id = computed;
      verified = true;
    } else {
      comments.push(
        `VERIFY: the ${rule.type} rule could not build an import id from the ` +
          'scanned fields — falling back to the scanned id',
      );
    }
  } else {
    comments.push(
      `VERIFY: ${rule.type} has no scanned-resource rule — import id may not be the scanned id`,
    );
  }

  return {
    type: rule.type,
    address,
    id,
    comments,
    verified,
    addressIsSuggestion: true,
    accountId: subject.accountId,
    region: subject.region,
  };
}

/**
 * Bulk form. Resolution is independent per subject; address collisions are
 * resolved later, by `emitBlocks`, because dedupe is only meaningful across a
 * batch that is emitted together.
 */
export function resolveScannedMany(subjects: readonly ScannedSubject[]): ResolvedImport[] {
  return subjects.map(resolveScanned);
}
