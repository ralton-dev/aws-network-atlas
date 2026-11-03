/**
 * `atlas-scan propose` — the scanner side of PROPOSAL-OVERLAY.md (decisions
 * 44–47, 53).
 *
 * - `validate <file>…` is what the `atlas-propose` skill loops on: it prints
 *   one `<file>: <level> <code> <path>: <message>` line per issue, a closing
 *   count, and exits 1 on any error (warnings too under `--strict`).
 * - `bundle` writes `site/data/proposals.js` and **only** that, so it is safe
 *   in a checkout with no `data/` — where `npm run bundle` would rebuild
 *   `data.js` from zero accounts.
 *
 * Neither needs AWS, `atlas.config.json` or `data/`: they read
 * `site/data/data.js` (the same bytes the viewer shows) and `proposals/`.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validateProposal, type DesignRule, type Issue, type Proposal } from '@atlas/proposal';
import { parseProposal, ProposalParseError, readSiteData } from '@atlas/proposal/read';
import type { Snapshot } from '@atlas/schema';

import { jsonScriptPayload } from './bundle.js';

/** The checkout this scanner lives in. `propose` and `describe` never need a config to find it. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

const PROPOSAL_FILE = /\.ya?ml$/;

/** A proposal's id: its file name without `.yaml` / `.yml` (decision 44). */
export function proposalId(file: string): string {
  return path.basename(file).replace(PROPOSAL_FILE, '');
}

function relativeTo(cwd: string, file: string): string {
  const rel = path.relative(cwd, file);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
}

/** The `Snapshot` in `<root>/site/data/data.js`. */
export async function readSiteSnapshot(rootDir: string = REPO_ROOT): Promise<Snapshot> {
  const file = path.join(rootDir, 'site', 'data', 'data.js');
  if (!existsSync(file)) {
    throw new Error(`no ${relativeTo(rootDir, file)} — run \`npm run fixture\` or \`npm run scan\` first`);
  }
  return readSiteData(await readFile(file, 'utf8'));
}

function formatParseFailure(error: unknown): string {
  if (error instanceof ProposalParseError) {
    return error.issues.map((i) => `${i.path ?? '-'}: ${i.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every `*.yaml` / `*.yml` in `dir`, sorted by file name, parsed. A file that
 * does not parse is reported (with its path) and skipped: one bad proposal
 * must never keep the others out of the viewer. No directory is no proposals.
 * Semantic validity is not checked here — the viewer shows a proposal's
 * issues itself, and `validate` is the place to fix them.
 */
export async function readProposals(
  dir: string,
  report: (message: string) => void = (m) => console.error(m),
): Promise<Proposal[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => PROPOSAL_FILE.test(f)).sort();
  const proposals: Proposal[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      proposals.push(parseProposal(await readFile(file, 'utf8'), proposalId(f)));
    } catch (error) {
      report(`proposals: skipped ${file}: ${formatParseFailure(error)}`);
    }
  }
  return proposals;
}

/** Write `<siteDataDir>/proposals.js` as `window.__ATLAS_PROPOSALS__` (an array, decision 53). */
export async function writeProposalsJs(
  proposals: Proposal[],
  siteDataDir: string = path.join(REPO_ROOT, 'site', 'data'),
): Promise<string> {
  await mkdir(siteDataDir, { recursive: true });
  const file = path.join(siteDataDir, 'proposals.js');
  await writeFile(file, jsonScriptPayload('__ATLAS_PROPOSALS__', proposals), 'utf8');
  return file;
}

/** `propose bundle`: `<root>/proposals/` → `<root>/site/data/proposals.js`, touching nothing else. */
export async function proposeBundle(
  rootDir: string = REPO_ROOT,
  report?: (message: string) => void,
): Promise<{ file: string; proposals: number }> {
  const proposals = await readProposals(path.join(rootDir, 'proposals'), report);
  const file = await writeProposalsJs(proposals, path.join(rootDir, 'site', 'data'));
  return { file, proposals: proposals.length };
}

export interface ValidateFilesOptions {
  files: string[];
  snapshot: Snapshot;
  /** Where relative `files` resolve from, and what printed paths are relative to. */
  cwd: string;
  strict?: boolean;
  /** Passed through to `validateProposal`; tests use `[]` to isolate the core checks from the design rules. */
  rules?: readonly DesignRule[];
}

export interface ValidateFilesResult {
  lines: string[];
  errors: number;
  warnings: number;
  exitCode: 0 | 1;
}

export function formatIssue(file: string, issue: Issue): string {
  return `${file}: ${issue.level} ${issue.code} ${issue.path ?? '-'}: ${issue.message}`;
}

/**
 * `propose validate`: every file parsed and validated against `snapshot`. A
 * file that cannot be read or parsed is a `malformed` error like any other, so
 * the skill sees one format whatever went wrong. Exit 1 on any error
 * (decision 47); `strict` makes every warning an error first.
 */
export async function validateFiles(options: ValidateFilesOptions): Promise<ValidateFilesResult> {
  const lines: string[] = [];
  let errors = 0;
  let warnings = 0;
  for (const given of options.files) {
    const abs = path.resolve(options.cwd, given);
    const shown = relativeTo(options.cwd, abs);
    let issues: Issue[];
    try {
      const proposal = parseProposal(await readFile(abs, 'utf8'), proposalId(abs));
      issues = validateProposal(options.snapshot, proposal, {
        strict: options.strict,
        ...(options.rules ? { rules: options.rules } : {}),
      });
    } catch (error) {
      if (error instanceof ProposalParseError) {
        issues = error.issues;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        issues = [{ level: 'error', code: 'malformed', message: `cannot read the file: ${message}` }];
      }
    }
    for (const issue of issues) {
      if (issue.level === 'error') errors += 1;
      else warnings += 1;
      lines.push(formatIssue(shown, issue));
    }
  }
  const n = options.files.length;
  lines.push(`${errors} error(s), ${warnings} warning(s) in ${n} proposal${n === 1 ? '' : 's'}`);
  return { lines, errors, warnings, exitCode: errors > 0 ? 1 : 0 };
}
