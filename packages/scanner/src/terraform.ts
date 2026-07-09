/**
 * `atlas-scan tf-import` — extract resource identifiers from Terraform state
 * files and write committable data/terraform/<stack>.json sidecars that the
 * bundler merges into the viewer payload.
 *
 * Two input formats are accepted (auto-detected):
 *   - raw state v4, i.e. the *.tfstate file itself or `terraform state pull`
 *   - `terraform show -json` output (format_version + values.root_module)
 *
 * Only identifiers (address, type, id, arn) leave the state file. Raw state
 * attributes routinely contain secrets (DB passwords, private keys…) and are
 * deliberately never persisted.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { TerraformResourceInstance, TerraformStackFile } from '@atlas/schema';
import type { ResolvedConfig } from './config.js';
import { stableStringify } from './stable-json.js';

export function terraformDir(config: ResolvedConfig): string {
  return path.join(config.rootDir, config.outDir, 'terraform');
}

interface ParsedState {
  resources: TerraformResourceInstance[];
  terraformVersion?: string;
  serial?: number;
  lineage?: string;
}

/** `[0]` / `["blue"]` suffix for for_each/count instances, TF-address style. */
function indexSuffix(indexKey: unknown): string {
  if (typeof indexKey === 'number') return `[${indexKey}]`;
  if (typeof indexKey === 'string') return `[${JSON.stringify(indexKey)}]`;
  return '';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Managed AWS-provider resources only: skip data sources and other providers. */
function isManagedAws(mode: unknown, type: unknown): type is string {
  return mode === 'managed' && typeof type === 'string' && type.startsWith('aws_');
}

/** Raw state v4 — the *.tfstate format, also what `terraform state pull` emits. */
function parseRawState(state: Record<string, unknown>): ParsedState {
  const resources: TerraformResourceInstance[] = [];
  for (const res of (state['resources'] as Array<Record<string, unknown>> | undefined) ?? []) {
    if (!isManagedAws(res['mode'], res['type'])) continue;
    const type = res['type'] as string;
    const base = `${res['module'] ? `${String(res['module'])}.` : ''}${type}.${String(res['name'])}`;
    for (const inst of (res['instances'] as Array<Record<string, unknown>> | undefined) ?? []) {
      const attrs = (inst['attributes'] as Record<string, unknown> | undefined) ?? {};
      resources.push({
        address: base + indexSuffix(inst['index_key']),
        type,
        id: str(attrs['id']),
        arn: str(attrs['arn']),
      });
    }
  }
  return {
    resources,
    terraformVersion: str(state['terraform_version']),
    serial: typeof state['serial'] === 'number' ? state['serial'] : undefined,
    lineage: str(state['lineage']),
  };
}

/** `terraform show -json` — values.root_module with nested child_modules. */
function parseShowJson(state: Record<string, unknown>): ParsedState {
  const resources: TerraformResourceInstance[] = [];
  const walk = (mod: Record<string, unknown> | undefined): void => {
    if (!mod) return;
    for (const res of (mod['resources'] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (!isManagedAws(res['mode'], res['type'])) continue;
      const values = (res['values'] as Record<string, unknown> | undefined) ?? {};
      resources.push({
        address: String(res['address']),
        type: res['type'] as string,
        id: str(values['id']),
        arn: str(values['arn']),
      });
    }
    for (const child of (mod['child_modules'] as Array<Record<string, unknown>> | undefined) ?? []) {
      walk(child);
    }
  };
  walk((state['values'] as Record<string, unknown> | undefined)?.['root_module'] as
    | Record<string, unknown>
    | undefined);
  return { resources, terraformVersion: str(state['terraform_version']) };
}

export function parseTerraformState(raw: unknown, sourceLabel: string): ParsedState {
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

/** Stack name → safe, unique-per-stack filename. */
function stackFileName(stack: string): string {
  return `${stack.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`;
}

export interface TfImportOptions {
  files: string[];
  /** Explicit stack name; only valid with a single file (else derived from filename). */
  stack?: string;
  repo: string;
  /** Base dir CLI paths are relative to (the invocation dir). */
  cwd: string;
}

export interface TfImportResult {
  file: string;
  stack: TerraformStackFile;
}

export async function tfImport(
  config: ResolvedConfig,
  opts: TfImportOptions,
): Promise<TfImportResult[]> {
  if (opts.stack !== undefined && opts.files.length > 1) {
    throw new Error(
      '--stack names a single state file; import multiple files without it ' +
        '(stack names derive from the file names) or run tf-import once per stack',
    );
  }

  const results: TfImportResult[] = [];
  const dir = terraformDir(config);
  await mkdir(dir, { recursive: true });

  for (const file of opts.files) {
    const abs = path.resolve(opts.cwd, file);
    const label = path.relative(opts.cwd, abs) || abs;
    const parsed = parseTerraformState(JSON.parse(await readFile(abs, 'utf8')), label);
    const stackName =
      opts.stack ?? path.basename(abs).replace(/\.(tfstate|json)$/i, '').replace(/\.tfstate$/i, '');
    const stack: TerraformStackFile = {
      version: 1,
      stack: stackName,
      repo: opts.repo,
      source: label,
      importedAt: new Date().toISOString(),
      terraformVersion: parsed.terraformVersion,
      serial: parsed.serial,
      lineage: parsed.lineage,
      resources: parsed.resources.sort((a, b) => a.address.localeCompare(b.address)),
    };
    const outFile = path.join(dir, stackFileName(stackName));
    await writeFile(outFile, stableStringify(stack) + '\n', 'utf8');
    results.push({ file: outFile, stack });
  }
  return results;
}

/** All committed stack files, for the bundler and the match report. */
export async function readTerraformStacks(config: ResolvedConfig): Promise<TerraformStackFile[]> {
  const dir = terraformDir(config);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const stacks: TerraformStackFile[] = [];
  for (const f of files) {
    stacks.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')) as TerraformStackFile);
  }
  return stacks;
}

/**
 * Every id/arn the scanner knows about, deep-walked from the raw snapshots.
 * Heuristic on purpose: it only feeds the human-readable match report, never
 * the viewer (which matches per-resource via its own byKey index).
 */
export function collectSnapshotKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectSnapshotKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['id'] === 'string') keys.add(obj['id']);
    if (typeof obj['arn'] === 'string') keys.add(obj['arn']);
    for (const v of Object.values(obj)) {
      if (v !== null && typeof v === 'object') collectSnapshotKeys(v, keys);
    }
  }
  return keys;
}

export interface StackMatchReport {
  stack: string;
  total: number;
  matched: number;
  /** In state but not found by any scan: stale state or an uncollected type. */
  ghosts: TerraformResourceInstance[];
}

export function matchReport(
  stack: TerraformStackFile,
  snapshotKeys: Set<string>,
): StackMatchReport {
  const ghosts = stack.resources.filter(
    (r) => !(r.arn && snapshotKeys.has(r.arn)) && !(r.id && snapshotKeys.has(r.id)),
  );
  return {
    stack: stack.stack,
    total: stack.resources.length,
    matched: stack.resources.length - ghosts.length,
    ghosts,
  };
}
