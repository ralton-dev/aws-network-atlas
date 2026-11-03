/**
 * `atlas-scan propose` — the validator the skill loops on, and the bundle step
 * that puts proposals in front of the viewer without touching `data.js`.
 *
 * Most of this drives the exported functions against a temp checkout (fast,
 * and the temp root proves nothing reads the real repo). One test spawns the
 * real CLI, because decision 47's exit codes are the contract the skill
 * actually sees and a function's return value is not an exit code.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { emptyGlobal, emptyRegionSnapshot, type AccountSnapshot, type Snapshot } from '@atlas/schema';
import { readScriptPayload, readSiteData } from '@atlas/proposal/read';

import { bundle, jsonScriptPayload } from '../src/bundle.js';
import type { ResolvedConfig } from '../src/config.js';
import { proposeBundle, readProposals, validateFiles, writeProposalsJs } from '../src/propose.js';

const SCANNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SCANNER, '../..');
const GENERATED_AT = '2026-07-06T09:20:00.000Z';

function miniSnapshot(): Snapshot {
  const region = emptyRegionSnapshot('eu-west-1');
  region.vpcs.push({ id: 'vpc-0aaa00000000000a1', name: 'core', cidrBlocks: ['10.0.0.0/16'], ipv6CidrBlocks: [], isDefault: false, tags: {} });
  const account: AccountSnapshot = {
    accountId: '111111111111',
    alias: 'acme-core',
    profile: 'core',
    scannedAt: GENERATED_AT,
    scannerVersion: 'test',
    regions: [region],
    emptyRegions: [],
    global: emptyGlobal(),
  };
  return { version: 1, generatedAt: GENERATED_AT, accounts: [account] };
}

const GOOD = `version: 1
title: Add a spoke VPC
base:
  generatedAt: "${GENERATED_AT}"
changes:
  - op: add
    account: "111111111111"
    region: eu-west-1
    collection: vpcs
    resource:
      id: proposed-vpc-spoke
      name: spoke
      cidrBlocks: ["10.40.0.0/16"]
      ipv6CidrBlocks: []
      isDefault: false
      tags: {}
`;

/** The defect decision 45 exists for: an id that looks scanned. */
const BAD = GOOD.replace('proposed-vpc-spoke', 'vpc-0spoke0000000001');

/** Not YAML at all — the bundle must report it and carry on. */
const BROKEN = 'version: 1\ntitle: [unclosed\n';

async function tempCheckout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-propose-'));
  await mkdir(path.join(root, 'site', 'data'), { recursive: true });
  await writeFile(path.join(root, 'site', 'data', 'data.js'), jsonScriptPayload('__ATLAS_DATA__', miniSnapshot()), 'utf8');
  await mkdir(path.join(root, 'proposals'));
  return root;
}

test('validate: a good proposal is 0 errors, 0 warnings and exit 0', async () => {
  const root = await tempCheckout();
  try {
    const file = path.join(root, 'proposals', 'spoke.yaml');
    await writeFile(file, GOOD, 'utf8');
    const res = await validateFiles({ files: [file], snapshot: miniSnapshot(), cwd: root, rules: [] });
    assert.equal(res.exitCode, 0);
    assert.equal(res.errors, 0);
    assert.equal(res.warnings, 0);
    assert.match(res.lines.at(-1) ?? '', /^0 error\(s\), 0 warning\(s\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validate: a non-proposed id is exit 1, naming the file and the accessor path', async () => {
  const root = await tempCheckout();
  try {
    const file = path.join(root, 'proposals', 'spoke.yaml');
    await writeFile(file, BAD, 'utf8');
    const res = await validateFiles({ files: [file], snapshot: miniSnapshot(), cwd: root, rules: [] });
    assert.equal(res.exitCode, 1);
    assert.equal(res.errors, 1);
    const line = res.lines.find((l) => l.includes('not-proposed-id'));
    assert.ok(line, res.lines.join('\n'));
    assert.match(line, /^proposals\/spoke\.yaml: error not-proposed-id changes\[0\]\.resource\.id: /);
    assert.match(res.lines.at(-1) ?? '', /^1 error\(s\), 0 warning\(s\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validate: a stale base warns (exit 0) and --strict makes it exit 1', async () => {
  const root = await tempCheckout();
  try {
    const file = path.join(root, 'proposals', 'spoke.yaml');
    await writeFile(file, GOOD.replace(GENERATED_AT, '2020-01-01T00:00:00.000Z'), 'utf8');
    const lax = await validateFiles({ files: [file], snapshot: miniSnapshot(), cwd: root, rules: [] });
    assert.equal(lax.exitCode, 0);
    assert.equal(lax.warnings, 1);
    assert.ok(lax.lines.some((l) => l.includes('warning stale base.generatedAt')), lax.lines.join('\n'));
    const strict = await validateFiles({ files: [file], snapshot: miniSnapshot(), cwd: root, rules: [], strict: true });
    assert.equal(strict.exitCode, 1);
    assert.ok(strict.lines.some((l) => l.includes('error stale base.generatedAt')), strict.lines.join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validate: unparseable YAML and a missing file are errors with a path, never a throw', async () => {
  const root = await tempCheckout();
  try {
    const broken = path.join(root, 'proposals', 'broken.yaml');
    await writeFile(broken, BROKEN, 'utf8');
    const res = await validateFiles({
      files: [broken, path.join(root, 'proposals', 'nope.yaml')],
      snapshot: miniSnapshot(),
      cwd: root,
      rules: [],
    });
    assert.equal(res.exitCode, 1);
    assert.ok(res.lines.some((l) => /^proposals\/broken\.yaml: error malformed line \d+, column \d+: /.test(l)), res.lines.join('\n'));
    assert.ok(res.lines.some((l) => /^proposals\/nope\.yaml: error malformed -: /.test(l)), res.lines.join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readProposals: no proposals/ directory is an empty list', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-propose-'));
  try {
    assert.deepEqual(await readProposals(path.join(root, 'proposals')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readProposals: sorted by file name, a broken file reported with its path and skipped', async () => {
  const root = await tempCheckout();
  try {
    await writeFile(path.join(root, 'proposals', 'b-spoke.yaml'), GOOD, 'utf8');
    await writeFile(path.join(root, 'proposals', 'a-spoke.yml'), GOOD, 'utf8');
    await writeFile(path.join(root, 'proposals', 'c-broken.yaml'), BROKEN, 'utf8');
    await writeFile(path.join(root, 'proposals', 'notes.md'), '# not a proposal', 'utf8');
    const reported: string[] = [];
    const proposals = await readProposals(path.join(root, 'proposals'), (msg) => reported.push(msg));
    assert.deepEqual(proposals.map((p) => p.id), ['a-spoke', 'b-spoke']);
    assert.equal(reported.length, 1);
    assert.match(reported[0] ?? '', /c-broken\.yaml/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('propose bundle writes proposals.js and nothing else', async () => {
  const root = await tempCheckout();
  try {
    await writeFile(path.join(root, 'proposals', 'spoke.yaml'), GOOD, 'utf8');
    await writeFile(path.join(root, 'proposals', 'zz-broken.yaml'), BROKEN, 'utf8');
    const dataDir = path.join(root, 'site', 'data');
    const before = await readFile(path.join(dataDir, 'data.js'), 'utf8');

    const res = await proposeBundle(root, () => {});
    assert.equal(res.proposals, 1);
    assert.deepEqual((await readdir(dataDir)).sort(), ['data.js', 'proposals.js']);
    assert.equal(await readFile(path.join(dataDir, 'data.js'), 'utf8'), before);

    const text = await readFile(path.join(dataDir, 'proposals.js'), 'utf8');
    assert.match(text, /^window\.__ATLAS_PROPOSALS__=JSON\.parse\('/);
    const payload = readScriptPayload(text) as Array<{ id: string; title: string }>;
    assert.equal(payload.length, 1);
    assert.equal(payload[0]?.id, 'spoke');
    assert.equal(payload[0]?.title, 'Add a spoke VPC');
    // The snapshot is still readable and untouched — the trap `npm run bundle` falls into.
    assert.equal(readSiteData(before).accounts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the full bundle() writes proposals.js as its fourth file and counts it', async () => {
  // Against a temp root only: `npm run bundle` in the real checkout would
  // rebuild data.js from zero accounts (PROPOSAL-OVERLAY.md, Standing rules).
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-bundle-'));
  try {
    await mkdir(path.join(root, 'proposals'));
    await writeFile(path.join(root, 'proposals', 'spoke.yaml'), GOOD, 'utf8');
    const config = { accounts: [], rootDir: root, outDir: 'data', annotationsDir: 'annotations', emptyRegions: 'exclude', regionConcurrency: 1 } as unknown as ResolvedConfig;
    const res = await bundle(config);
    assert.equal(res.proposals, 1);
    const dataDir = path.join(root, 'site', 'data');
    assert.deepEqual((await readdir(dataDir)).sort(), ['annotations.js', 'data.js', 'proposals.js', 'terraform.js']);
    const payload = readScriptPayload(await readFile(path.join(dataDir, 'proposals.js'), 'utf8')) as Array<{ id: string }>;
    assert.deepEqual(payload.map((p) => p.id), ['spoke']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeProposalsJs with nothing writes an empty array, not a missing file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-propose-'));
  try {
    const file = await writeProposalsJs([], path.join(root, 'site', 'data'));
    assert.deepEqual(readScriptPayload(await readFile(file, 'utf8')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the CLI exits 0 on a good proposal and 1 on a bad one (against the committed fixture)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atlas-propose-cli-'));
  try {
    // The fixture's dev account; a CIDR nothing in the fixture uses.
    const good = GOOD.replace('111111111111', '333333333333').replace('10.40.0.0/16', '10.77.0.0/16');
    const generatedAt = readSiteData(await readFile(path.join(REPO_ROOT, 'site', 'data', 'data.js'), 'utf8')).generatedAt;
    await writeFile(path.join(dir, 'good.yaml'), good.replace(GENERATED_AT, generatedAt), 'utf8');
    await writeFile(path.join(dir, 'bad.yaml'), good.replace(GENERATED_AT, generatedAt).replace('proposed-vpc-spoke', 'vpc-0spoke0000000001'), 'utf8');

    const run = (file: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'propose', 'validate', path.join(dir, file)], {
        cwd: SCANNER,
        encoding: 'utf8',
        env: { ...process.env, INIT_CWD: dir },
      });
    const ok = run('good.yaml');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /0 error\(s\)/);
    const bad = run('bad.yaml');
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /^bad\.yaml: error not-proposed-id changes\[0\]\.resource\.id: /m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
