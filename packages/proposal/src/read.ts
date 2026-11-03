/**
 * Text → typed values, for Node callers only (the scanner's `propose` and
 * `describe`, tests). This is the one module that imports `yaml`; the
 * package's main entry does not re-export it, so the viewer never bundles it.
 */
import type { Snapshot } from '@atlas/schema';
import { parse as parseYaml, YAMLParseError } from 'yaml';

import type { Issue, Proposal } from './types.js';
import { checkProposalShape } from './validate.js';

/** Thrown by `parseProposal`; `issues` are `malformed` errors with paths, ready to print. */
export class ProposalParseError extends Error {
  constructor(
    readonly id: string,
    readonly issues: Issue[],
  ) {
    super(`proposal ${id}: ${issues.map((i) => `${i.path ?? '-'}: ${i.message}`).join('; ')}`);
    this.name = 'ProposalParseError';
  }
}

/**
 * Parse the text of `proposals/<id>.yaml` into a `Proposal` whose `id` is
 * `id` (the file stem — decision 44; the YAML must not carry its own `id`).
 * Throws `ProposalParseError` for invalid YAML (one issue with the line and
 * column) or a value of the wrong shape (one issue per problem). Semantic
 * checks — ids, keys, references — are `validateProposal`'s, not this.
 */
export function parseProposal(text: string, id: string): Proposal {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const at = error.linePos?.[0];
      const where = at ? `line ${at.line}, column ${at.col}` : undefined;
      throw new ProposalParseError(id, [
        { level: 'error', code: 'malformed', message: `not valid YAML: ${error.message.split('\n')[0] ?? error.message}`, ...(where ? { path: where } : {}) },
      ]);
    }
    throw error;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'id' in value) {
    throw new ProposalParseError(id, [
      { level: 'error', code: 'malformed', path: 'id', message: 'do not write `id`; a proposal\'s id is its file name' },
    ]);
  }
  const withId = value !== null && typeof value === 'object' && !Array.isArray(value) ? { id, ...value } : value;
  const issues = checkProposalShape(withId);
  if (issues.length > 0) throw new ProposalParseError(id, issues);
  return withId as Proposal;
}

/**
 * The value inside a `site/data/*.js` file, which `bundle.ts`'s
 * `jsonScriptPayload` writes as `window.<NAME>=JSON.parse('<payload>');`.
 * The payload is `JSON.stringify(value)` with `\` doubled, `'` escaped as
 * `\'`, and U+2028/U+2029 written as ` `/` `; this undoes exactly
 * that and `JSON.parse`s the result. No `eval`, no `Function`. Throws on
 * anything else.
 */
export function readScriptPayload(text: string): unknown {
  const open = "JSON.parse('";
  const start = text.indexOf(open);
  if (start < 0 || !/^\s*window\.[A-Za-z_$][\w$]*\s*=\s*$/.test(text.slice(0, start))) {
    throw new Error("expected a `window.NAME=JSON.parse('…');` script");
  }
  let out = '';
  let i = start + open.length;
  for (;;) {
    const c = text[i];
    if (c === undefined) throw new Error('unterminated JSON.parse string');
    if (c === "'") break;
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === '\\' || next === "'") {
      out += next;
      i += 2;
    } else if (next === 'u' && (text.startsWith('2028', i + 2) || text.startsWith('2029', i + 2))) {
      out += text.startsWith('2028', i + 2) ? ' ' : ' ';
      i += 6;
    } else {
      throw new Error(`unexpected escape \\${next ?? ''} at offset ${i}`);
    }
  }
  if (!/^\);?\s*$/.test(text.slice(i + 1))) throw new Error('unexpected text after the JSON.parse string');
  return JSON.parse(out);
}

/**
 * The `Snapshot` in `site/data/data.js` — the same bytes the viewer shows.
 * Checks only that it has `generatedAt` and an `accounts` list.
 */
export function readSiteData(text: string): Snapshot {
  const value = readScriptPayload(text) as Partial<Snapshot> | null;
  if (!value || typeof value !== 'object' || !Array.isArray(value.accounts) || typeof value.generatedAt !== 'string') {
    throw new Error('site data is not a snapshot (expected `generatedAt` and `accounts`)');
  }
  return value as Snapshot;
}
