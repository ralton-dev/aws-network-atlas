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
 * flagged, not dropped. Two independent things can go missing and the comments
 * must say which:
 *
 *  - **the type** — no rule covers the kind, or the rule's `typeFromScanned`
 *    could not tell which of several provider resources this subject is. The
 *    result carries `type: ''` and the emitter renders the whole stanza
 *    commented out: visible, honest, and impossible to paste by accident.
 *  - **the id** — a rule owns the type but could not build the import id from
 *    the collected fields, so the block falls back to the scanned identifier.
 *
 * They are genuinely separate. Most kinds that span several terraform types
 * share one id form across all of them, so the id is usually *right* when the
 * type is unknown; and a rule can know its type exactly while lacking a field
 * the composite id needs. Reporting one failure as the other is what sends a
 * reader to check the half that was never in doubt.
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

  // The type and the id are resolved independently, and either can fail on its
  // own. `typeFromScanned` is authoritative when a rule declares it — including
  // when it answers `undefined`, which is why this is not `?? rule.type`.
  const type = rule.typeFromScanned === undefined ? rule.type : rule.typeFromScanned(subject);
  // Comments have to name something even when the type is unknown; the declared
  // type at least names the provider family the reader should look in.
  const named = type ?? rule.type;

  let id = subject.id;
  let idFromRule = false;
  // Held back rather than pushed, so the type problem is always stated first:
  // a reader who has just been told the type is unknown reads "could not build
  // an import id" as the second half of one story, not as the whole of it.
  let idProblem: string | undefined;
  if (rule.notImportable !== undefined) {
    comments.push(`NOT IMPORTABLE: ${named} — ${rule.notImportable}`);
    comments.push('VERIFY: this block is emitted so the resource is not lost; it will not apply');
  } else if (rule.fromScanned !== undefined) {
    const computed = rule.fromScanned(subject);
    if (computed !== undefined && computed !== '') {
      id = computed;
      idFromRule = true;
    } else {
      idProblem =
        `VERIFY: the ${named} rule could not build an import id from the ` +
        'scanned fields — falling back to the scanned id';
    }
  } else {
    idProblem = `VERIFY: ${named} has no scanned-resource rule — import id may not be the scanned id`;
  }

  if (type === undefined) {
    // The defect this branch exists to fix: these kinds used to emit the
    // dominant type with a comment blaming the *id*, which for most of them was
    // exactly right. A user checked the id, found it correct, and pasted a
    // block that imported an HTTP API as a REST API. Name the half that is
    // actually missing, and list the candidates so the block is recoverable.
    const choices = rule.typeChoices ?? [];
    comments.push(
      `VERIFY: the terraform resource type could not be determined — atlas kind ` +
        `"${subject.kind}" covers several provider resources and the scanned ` +
        'fields do not identify one for this resource, so the block below is ' +
        'commented out' +
        (choices.length > 0 ? `. Candidates: ${choices.join(', ')}` : '') +
        // Only claimable because a rule whose candidates disagree about the id
        // form declines the id too when it cannot place the type — see the
        // `default:` arms in the `lb` and `datasync-location` rules.
        (idFromRule ? '. The id below is right whichever of those it is' : ''),
    );
  }
  if (idProblem !== undefined) comments.push(idProblem);

  return {
    type: type ?? '',
    // No type means no writable address, the same as the no-rule path above.
    address: type === undefined ? '' : suggestAddress(type, subject.name ?? subject.id),
    id,
    comments,
    // A block that cannot be pasted is never verified, however right its id is.
    verified: type !== undefined && idFromRule,
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
