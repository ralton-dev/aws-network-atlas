#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { verifyAwsCli } from './preflight.js';
import { scanAccount } from './scan.js';
import { bundle, writeAccountSnapshot } from './bundle.js';

const HELP = `atlas-scan — read-only AWS inventory scanner for the network atlas

Usage:
  atlas-scan scan [--profile <name>]... [--region <region>]... [--config <path>]
  atlas-scan bundle [--config <path>]

Commands:
  scan     Verify credentials, scan the configured accounts (READ ONLY),
           write data/accounts/<accountId>.json, then rebuild site/data/.
  bundle   Rebuild site/data/*.js from committed snapshots + annotations
           (run after editing annotations/*.yaml).

Options:
  --profile   AWS config profile to scan (repeatable; overrides atlas.config.json accounts)
  --region    Limit the scan to specific region(s) (repeatable)
  --config    Path to atlas.config.json (default: ./atlas.config.json when present)
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: 'string', multiple: true },
      region: { type: 'string', multiple: true },
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0] ?? 'scan';
  if (values.help || (command !== 'scan' && command !== 'bundle') || positionals.length > 1) {
    if (positionals.length > 1) {
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

  if (command === 'bundle') {
    const res = await bundle(config);
    console.log(`Bundled ${res.accounts} account snapshot(s), ${res.annotations} annotation(s) → site/data/`);
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
  console.log(`Bundled ${res.accounts} account snapshot(s), ${res.annotations} annotation(s) → site/data/`);
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
