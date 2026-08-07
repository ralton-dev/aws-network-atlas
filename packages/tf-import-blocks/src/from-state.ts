/**
 * The state-move path: read a Terraform state, resolve each resource to a
 * `(type, import-id)` pair, emit import blocks for the target configuration.
 *
 * Two input formats are accepted, auto-detected — the same two
 * `atlas-scan tf-import` already accepts:
 *   - raw state v4, i.e. the *.tfstate file itself or `terraform state pull`
 *   - `terraform show -json` output (format_version + values.root_module)
 *
 * Only identifiers leave the state file (decision 6). Rules may *read* any
 * attribute to compute an import id, but nothing is written out except the
 * computed id, the address, and the account/region the ARN disclosed. Raw
 * state attributes routinely contain secrets and are never copied verbatim.
 */
import { contextComment } from './emit.js';
import { ruleForType } from './rules/registry.js';
import { parseArn, str, type ResolvedImport, type StateAttributes } from './types.js';

/** One resource instance lifted out of a state file. */
export interface StateResource {
  /** Full Terraform address including module path and index key. */
  readonly address: string;
  readonly type: string;
  readonly attributes: StateAttributes;
  /**
   * True when `attributes` came from the pre-0.12 `attributes_flat` map rather
   * than from `attributes`. Every value is then a string and every list or
   * nested block has been flattened to `key.#` / `key.0` keys, which a rule
   * expecting a real list cannot read — so a rule that declines on one of these
   * has a reason worth reporting rather than a defect worth chasing.
   */
  readonly legacyFlatmap?: boolean | undefined;
  /**
   * The source state marks this object tainted, so Terraform will destroy and
   * recreate it on the next apply *there*.
   *
   * Unlike a deposed object this one is **emitted**, and the difference is the
   * whole of the reasoning. A deposed object has a live sibling at the same
   * address, so emitting it is both invalid HCL and the adoption of something
   * scheduled for destruction — and there is a correct block to emit instead. A
   * tainted object is the only object at its address, it exists right now, and
   * its id is the real id. Dropping it would lose a resource from a state move
   * with nothing put in its place, which decision 5 forbids outright.
   *
   * Taint is state metadata rather than a property of the remote object, so it
   * does not travel through an import: the adopting state gets a clean entry.
   * The reader still has to be told, because the *source* configuration will
   * replace the object on its next apply.
   */
  readonly tainted?: boolean | undefined;
}

export interface StateSkipCounts {
  /**
   * Orphans of an interrupted create-before-destroy replace. Raw v4 spells this
   * `instances[].deposed`; `terraform show -json` spells it `deposed_key` on a
   * separate resource entry. Both are counted here.
   */
  readonly deposed: number;
  /** `mode: "data"` — decision 11. */
  readonly dataSources: number;
  /** Resources from another provider — decision 11. */
  readonly nonAws: number;
}

export interface ParsedStateFile {
  readonly resources: StateResource[];
  readonly terraformVersion?: string | undefined;
  readonly skipped: StateSkipCounts;
  /**
   * Resources emitted carrying a tainted flag. Deliberately **not** a member of
   * `skipped`: nothing was skipped, and pooling an emitted-and-flagged resource
   * with a dropped one would make both numbers lies. Counts blocks in the
   * output, so a tainted object that is also deposed counts only as deposed.
   */
  readonly tainted: number;
}

/** `[0]` / `["blue"]` suffix for for_each/count instances, TF-address style. */
function indexSuffix(indexKey: unknown): string {
  if (typeof indexKey === 'number') return `[${indexKey}]`;
  if (typeof indexKey === 'string') return `[${JSON.stringify(indexKey)}]`;
  return '';
}

/**
 * Managed AWS-provider resources only. Same predicate as
 * `scanner/src/terraform.ts`'s `isManagedAws`, reimplemented rather than
 * imported because this package takes no `@atlas/*` dependency (decisions 1
 * and 11). If that predicate ever changes, this one has to change with it.
 */
function isManagedAws(mode: unknown, type: unknown): type is string {
  return mode === 'managed' && typeof type === 'string' && type.startsWith('aws_');
}

function classifySkip(mode: unknown, type: unknown): keyof StateSkipCounts | undefined {
  if (mode === 'data') return 'dataSources';
  if (typeof type === 'string' && !type.startsWith('aws_')) return 'nonAws';
  return undefined;
}

/**
 * A deposed object is the *old* half of an interrupted create-before-destroy
 * replace. It shares an address with the live object and is scheduled for
 * destruction, so importing it would both collide and adopt something Terraform
 * is about to delete. Skip, and count — decision 5 forbids a silent drop.
 *
 * The two input formats spell it differently and the difference is the whole
 * defect this function exists to close (verified against terraform on `main`,
 * 2026-08-08):
 *
 *   - raw v4 (`states/statefile/version4.go:705`) nests the deposed object as a
 *     further entry in the resource's own `instances[]`, keyed `deposed`.
 *   - `terraform show -json` (`command/jsonstate/state.go:114`, marshalled at
 *     lines ~481-529) has no nesting: it appends a **separate resource entry**
 *     whose `address` is assigned `current.Address`, i.e. byte for byte the same
 *     address as the live object, and sets `deposed_key`.
 *
 * Reading only the v4 spelling therefore looked correct on every fixture while
 * emitting two `import` blocks at one address for any real state caught
 * mid-replace — HCL Terraform rejects — and reporting `deposed: 0` for it.
 */
function deposedKey(entry: Record<string, unknown>): string | undefined {
  return str(entry['deposed']) ?? str(entry['deposed_key']);
}

/**
 * A raw-v4 instance carries **either** `attributes` (raw JSON, written by every
 * provider since 0.12) **or** `attributes_flat` (`map[string]string`, the
 * pre-0.12 flatmap that terraform still round-trips until the resource is next
 * written) — `version4.go:708-709`, and they are mutually exclusive.
 *
 * Reading only `attributes` therefore saw `{}` for a legacy instance and
 * emitted `id = ""` with a comment blaming the *rule*, while the state id sat
 * one key away. Most import ids survive the flatmap intact, because ids and
 * names are scalars and a flatmap's scalars are top-level keys; what does not
 * survive is a list, which is why the fact is carried forward rather than
 * silently normalised away.
 */
function instanceAttributes(inst: Record<string, unknown>): {
  attributes: StateAttributes;
  legacyFlatmap: boolean;
} {
  const attributes = inst['attributes'];
  if (attributes !== null && typeof attributes === 'object' && !Array.isArray(attributes)) {
    return { attributes: attributes as StateAttributes, legacyFlatmap: false };
  }
  const flat = inst['attributes_flat'];
  if (flat !== null && typeof flat === 'object' && !Array.isArray(flat)) {
    return { attributes: flat as StateAttributes, legacyFlatmap: true };
  }
  return { attributes: {}, legacyFlatmap: false };
}

/** Raw state v4 — the *.tfstate format, also what `terraform state pull` emits. */
function parseRawState(state: Record<string, unknown>): ParsedStateFile {
  const resources: StateResource[] = [];
  const skipped = { deposed: 0, dataSources: 0, nonAws: 0 };
  let taintedCount = 0;
  for (const res of (state['resources'] as Array<Record<string, unknown>> | undefined) ?? []) {
    if (!isManagedAws(res['mode'], res['type'])) {
      const bucket = classifySkip(res['mode'], res['type']);
      if (bucket !== undefined && bucket !== 'deposed') {
        skipped[bucket] += ((res['instances'] as unknown[] | undefined) ?? []).length || 1;
      }
      continue;
    }
    const type = res['type'] as string;
    const base = `${res['module'] ? `${String(res['module'])}.` : ''}${type}.${String(res['name'])}`;
    for (const inst of (res['instances'] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (deposedKey(inst) !== undefined) {
        skipped.deposed += 1;
        continue;
      }
      const { attributes, legacyFlatmap } = instanceAttributes(inst);
      // `status: "tainted"` — version4.go:704. The only other status is the
      // empty one, so anything else is a terraform we do not know and is left
      // unflagged rather than guessed at.
      const tainted = inst['status'] === 'tainted';
      if (tainted) taintedCount += 1;
      resources.push({
        address: base + indexSuffix(inst['index_key']),
        type,
        attributes,
        legacyFlatmap,
        tainted,
      });
    }
  }
  return {
    resources,
    terraformVersion: str(state['terraform_version']),
    skipped,
    tainted: taintedCount,
  };
}

/** `terraform show -json` — values.root_module with nested child_modules. */
function parseShowJson(state: Record<string, unknown>): ParsedStateFile {
  const resources: StateResource[] = [];
  const skipped = { deposed: 0, dataSources: 0, nonAws: 0 };
  let taintedCount = 0;
  const walk = (mod: Record<string, unknown> | undefined): void => {
    if (!mod) return;
    for (const res of (mod['resources'] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (!isManagedAws(res['mode'], res['type'])) {
        const bucket = classifySkip(res['mode'], res['type']);
        if (bucket !== undefined && bucket !== 'deposed') skipped[bucket] += 1;
        continue;
      }
      // Same address as the live entry, `deposed_key` the only difference — so
      // this is the branch whose absence produced two blocks at one address.
      if (deposedKey(res) !== undefined) {
        skipped.deposed += 1;
        continue;
      }
      // `"tainted": true` on the resource entry — jsonstate/state.go:111. Read
      // after the deposed check, so a deposed object that is also tainted (
      // terraform sets both, state.go ~526) counts once, as deposed.
      const tainted = res['tainted'] === true;
      if (tainted) taintedCount += 1;
      resources.push({
        address: String(res['address']),
        type: res['type'] as string,
        attributes: (res['values'] as Record<string, unknown> | undefined) ?? {},
        tainted,
      });
    }
    for (const child of (mod['child_modules'] as Array<Record<string, unknown>> | undefined) ?? []) {
      walk(child);
    }
  };
  walk(
    (state['values'] as Record<string, unknown> | undefined)?.['root_module'] as
      | Record<string, unknown>
      | undefined,
  );
  return {
    resources,
    terraformVersion: str(state['terraform_version']),
    skipped,
    tainted: taintedCount,
  };
}

export function parseStateFile(raw: unknown, sourceLabel: string): ParsedStateFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: not a JSON object — expected a Terraform state file`);
  }
  const state = raw as Record<string, unknown>;
  if (Array.isArray(state['resources']) && typeof state['version'] === 'number') {
    if (state['version'] !== 4) {
      throw new Error(
        `${sourceLabel}: unsupported state version ${String(state['version'])} — ` +
          'only v4 (Terraform ≥ 0.12) is supported; run `terraform state pull` with a current CLI',
      );
    }
    return parseRawState(state);
  }
  if (typeof state['format_version'] === 'string' && 'values' in state) {
    return parseShowJson(state);
  }
  throw new Error(
    `${sourceLabel}: unrecognized format — expected raw state v4 (terraform state pull) ` +
      'or `terraform show -json` output',
  );
}

/**
 * Resolve one state resource to an import block.
 *
 * With an empty rule table this is exactly the naive implementation the plan
 * warns about — `id = <the state's id attribute>` for every type, flagged with
 * `# VERIFY`. It stops being naive the moment `rules/state.ts` is filled; no
 * caller has to change.
 */
export function resolveStateResource(res: StateResource): ResolvedImport {
  const rule = ruleForType(res.type);
  const stateId = str(res.attributes['id']) ?? '';
  const arn = parseArn(res.attributes['arn']);
  // An ARN with an empty region field (S3, IAM) has not told us the resource is
  // global — it has told us nothing. `undefined` says that; `''` would claim it.
  const accountId = arn?.accountId ? arn.accountId : undefined;
  const region = arn?.region ? arn.region : undefined;
  const comments: string[] = [];
  const context = contextComment(accountId, region);
  if (context !== undefined) comments.push(context);
  if (res.tainted === true) {
    comments.push(
      'TAINTED in the source state — the object exists and the id below is the real one, so ' +
        'this import is sound (taint is state metadata and does not travel with it), but the ' +
        'source configuration will destroy and recreate it on its next apply',
    );
  }

  let id = stateId;
  let verified = false;
  if (rule?.notImportable !== undefined) {
    comments.push(`NOT IMPORTABLE: ${res.type} — ${rule.notImportable}`);
    comments.push('VERIFY: this block is emitted so the resource is not lost; it will not apply');
  } else if (rule?.fromState !== undefined) {
    const computed = rule.fromState(res.attributes);
    if (computed !== undefined && computed !== '') {
      id = computed;
      verified = true;
    } else {
      comments.push(
        `VERIFY: the ${res.type} rule could not compute an import id from this state — ` +
          'falling back to the state id' +
          // Name the real reason. "The rule could not compute an id" sends a
          // reader to check a rule that is working correctly; the flatmap is
          // what withheld the list it needed.
          (res.legacyFlatmap === true
            ? ' (this instance is stored in the pre-0.12 flatmap format, which ' +
              'flattens every list and nested block to `key.#`/`key.0` entries a ' +
              'rule cannot read)'
            : ''),
      );
    }
  } else {
    comments.push(`VERIFY: no rule for ${res.type} — import id may not be the state id`);
  }

  return {
    type: res.type,
    address: res.address,
    id,
    comments,
    verified,
    addressIsSuggestion: false,
    accountId,
    region,
  };
}

/**
 * Every importable resource in a state file, sorted by address so re-running
 * produces a stable diff.
 */
export function importsFromState(raw: unknown, sourceLabel: string): ResolvedImport[] {
  return parseStateFile(raw, sourceLabel)
    .resources.map(resolveStateResource)
    .sort((a, b) => a.address.localeCompare(b.address));
}
