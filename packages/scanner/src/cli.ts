#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { verifyAwsCli } from './preflight.js';
import { scanAccount } from './scan.js';
import { bundle, readAccountSnapshots, writeAccountSnapshot } from './bundle.js';
import { collectSnapshotKeys, matchReport, tfImport } from './terraform.js';

const HELP = `atlas-scan — read-only AWS inventory scanner for the network atlas

Usage:
  atlas-scan scan [--profile <name>]... [--region <region>]... [--config <path>]
  atlas-scan bundle [--config <path>]
  atlas-scan tf-import --repo <repo> [--stack <name>] <statefile>... [--config <path>]

Commands:
  scan       Verify credentials, scan the configured accounts (READ ONLY),
             write data/accounts/<accountId>.json, then rebuild site/data/.
  bundle     Rebuild site/data/*.js from committed snapshots + annotations +
             Terraform stacks (run after editing annotations/*.yaml).
  tf-import  Extract resource identifiers from Terraform state file(s) and
             write data/terraform/<stack>.json, then rebuild site/data/.
             Accepts raw *.tfstate / \`terraform state pull\` output and
             \`terraform show -json\` output. Only address/type/id/arn are
             kept — state attribute values (which may hold secrets) never
             leave the state file.

Options:
  --profile   AWS config profile to scan (repeatable; overrides atlas.config.json accounts)
  --region    Limit the scan to specific region(s) (repeatable)
  --config    Path to atlas.config.json (default: ./atlas.config.json when present)
  --repo      tf-import: repo/project the state's Terraform code lives in
              (URL or org/repo slug) — required, shown on matched resources
  --stack     tf-import: stack name for a single state file
              (default: derived from the file name; multiple files always derive)

Examples:
  terraform state pull > /tmp/prod-network.tfstate
  atlas-scan tf-import --repo github.com/acme/infra-network --stack prod-network /tmp/prod-network.tfstate
  atlas-scan tf-import --repo github.com/acme/platform states/*.tfstate
`;

function invocationDir(): string {
  return process.env['INIT_CWD'] ?? process.cwd();
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: 'string', multiple: true },
      region: { type: 'string', multiple: true },
      config: { type: 'string' },
      repo: { type: 'string' },
      stack: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0] ?? 'scan';
  const knownCommand = command === 'scan' || command === 'bundle' || command === 'tf-import';
  const extraPositionals = command !== 'tf-import' && positionals.length > 1;
  if (values.help || !knownCommand || extraPositionals) {
    if (extraPositionals) {
      console.error(`Unexpected arguments: ${positionals.slice(1).join(' ')}\n`);
    }
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const config = await loadConfig({
    configPath: values.config,
    profiles: values.profile,
    regions: values.region,
  });

  if (command === 'tf-import') {
    const files = positionals.slice(1);
    if (files.length === 0) {
      throw new Error('tf-import: pass at least one Terraform state file');
    }
    if (!values.repo) {
      throw new Error(
        'tf-import: --repo is required — record which repo/project each state file came from',
      );
    }
    const results = await tfImport(config, {
      files,
      stack: values.stack,
      repo: values.repo,
      cwd: invocationDir(),
    });

    // Match report against whatever snapshots are committed — purely
    // informational; the viewer re-matches per resource at load time.
    const snapshots = await readAccountSnapshots(config);
    const keys = collectSnapshotKeys(snapshots);
    for (const { file, stack } of results) {
      console.log(`[${stack.stack}] wrote ${file} (${stack.resources.length} AWS resource(s), repo: ${stack.repo})`);
      if (snapshots.length === 0) continue;
      const report = matchReport(stack, keys);
      console.log(`[${stack.stack}] matched ${report.matched}/${report.total} against ${snapshots.length} scanned account snapshot(s)`);
      if (report.ghosts.length > 0) {
        console.log(`[${stack.stack}] in state but not found by any scan (stale state, or a type the scanner doesn't collect):`);
        for (const g of report.ghosts.slice(0, 20)) {
          console.log(`  - ${g.address} (${g.arn ?? g.id ?? 'no id'})`);
        }
        if (report.ghosts.length > 20) {
          console.log(`  … and ${report.ghosts.length - 20} more`);
        }
      }
    }

    const res = await bundle(config);
    console.log(`Bundled ${res.accounts} account snapshot(s), ${res.annotations} annotation(s), ${res.terraformStacks} Terraform stack(s) → site/data/`);
    return;
  }

  if (command === 'bundle') {
    const res = await bundle(config);
    console.log(`Bundled ${res.accounts} account snapshot(s), ${res.annotations} annotation(s), ${res.terraformStacks} Terraform stack(s) → site/data/`);
    return;
  }

  const cliVersion = await verifyAwsCli();
  console.log(`AWS CLI detected: ${cliVersion}`);

  // One failing profile (expired SSO, wrong keys) must not abort the others,
  // and the data bundle must be rebuilt for whatever DID get written.
  const failures: string[] = [];
  for (const account of config.accounts) {
    try {
      const snapshot = await scanAccount(
        account,
        { regionConcurrency: config.regionConcurrency, emptyRegions: config.emptyRegions },
        (msg) => console.log(msg),
      );
      const file = await writeAccountSnapshot(config, snapshot);
      const errorCount =
        snapshot.regions.reduce((n, r) => n + r.errors.length, 0) + snapshot.global.errors.length;
      console.log(`[${account.profile}] wrote ${file}${errorCount ? ` (${errorCount} scan error(s) recorded)` : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${account.profile}] FAILED: ${msg}`);
      failures.push(account.profile);
    }
  }

  const res = await bundle(config);
  console.log(`Bundled ${res.accounts} account snapshot(s), ${res.annotations} annotation(s), ${res.terraformStacks} Terraform stack(s) → site/data/`);
  console.log('Open site/index.html (or run: npm run serve) to view the diagram.');
  if (failures.length > 0) {
    console.error(`\nScan failed for profile(s): ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
