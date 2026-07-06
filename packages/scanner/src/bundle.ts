import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  SNAPSHOT_VERSION,
  type AccountSnapshot,
  type AnnotationMap,
  type AnnotationsFile,
  type Snapshot,
} from '@atlas/schema';
import type { ResolvedConfig } from './config.js';
import { stableStringify } from './stable-json.js';

/**
 * Escape a JSON string for embedding in single quotes inside a classic JS
 * script. JSON.parse('<payload>') parses ~2x faster than a JS object literal
 * in V8, and the escaping sidesteps </script> and U+2028/U+2029 hazards.
 */
export function jsonScriptPayload(globalName: string, value: unknown): string {
  const payload = JSON.stringify(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `window.${globalName}=JSON.parse('${payload}');\n`;
}

export function accountsDir(config: ResolvedConfig): string {
  return path.join(config.rootDir, config.outDir, 'accounts');
}

export function siteDataDir(config: ResolvedConfig): string {
  return path.join(config.rootDir, 'site', 'data');
}

/** Write one account's raw snapshot (the committable source of truth). */
export async function writeAccountSnapshot(
  config: ResolvedConfig,
  snapshot: AccountSnapshot,
): Promise<string> {
  const dir = accountsDir(config);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${snapshot.accountId}.json`);
  await writeFile(file, stableStringify(snapshot) + '\n', 'utf8');
  return file;
}

async function readAccountSnapshots(config: ResolvedConfig): Promise<AccountSnapshot[]> {
  const dir = accountsDir(config);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const accounts: AccountSnapshot[] = [];
  for (const f of files) {
    accounts.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')) as AccountSnapshot);
  }
  return accounts;
}

async function readAnnotations(config: ResolvedConfig): Promise<AnnotationMap> {
  const dir = path.join(config.rootDir, config.annotationsDir);
  const merged: AnnotationMap = {};
  if (!existsSync(dir)) return merged;
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  for (const f of files) {
    const raw = parseYaml(await readFile(path.join(dir, f), 'utf8')) as
      | AnnotationsFile
      | AnnotationMap
      | null;
    if (!raw || typeof raw !== 'object') continue;
    // Support both shapes — and both at once: an { annotations: {...} }
    // wrapper plus bare top-level ARN/id keys in the same file.
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      if (key === 'annotations') {
        for (const [k, v] of Object.entries(value as AnnotationMap)) {
          if (v && typeof v === 'object') merged[k] = v;
        }
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

/**
 * Rebuild the viewer data bundle (site/data/*.js) from the committed raw
 * snapshots and annotation sidecars. Editing an annotation or re-scanning an
 * account only requires re-running this — never a viewer rebuild.
 */
export async function bundle(config: ResolvedConfig): Promise<{ accounts: number; annotations: number }> {
  const accounts = await readAccountSnapshots(config);
  const annotations = await readAnnotations(config);

  const snapshot: Snapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    accounts,
  };

  const dir = siteDataDir(config);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'data.js'), jsonScriptPayload('__ATLAS_DATA__', snapshot), 'utf8');
  await writeFile(
    path.join(dir, 'annotations.js'),
    jsonScriptPayload('__ATLAS_ANNOTATIONS__', annotations),
    'utf8',
  );
  return { accounts: accounts.length, annotations: Object.keys(annotations).length };
}
