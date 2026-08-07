#!/usr/bin/env tsx
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { verifyAwsCli } from './preflight.js';
import { scanAccount } from './scan.js';
import { bundle, readAccountSnapshots, writeAccountSnapshot } from './bundle.js';
import { collectSnapshotKeys, matchReport, tfImport } from './terraform.js';
import { formatSummary, tfBlocks, writeBlocks } from './tf-blocks.js';

const HELP = `atlas-scan — read-only AWS inventory scanner for the network atlas

Usage:
  atlas-scan scan [--profile <name>]... [--region <region>]... [--config <path>]
  atlas-scan bundle [--config <path>]
  atlas-scan tf-import --repo <repo> [--stack <name>] <statefile>... [--config <path>]
  atlas-scan tf-blocks [--out <file>] [--filter <prefix>] <statefile>...

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
  tf-blocks  Generate Terraform \`import\` blocks for the resources in state
             file(s), for moving them into another configuration. HCL goes to
             stdout (redirect it straight into a .tf) and a summary to stderr.
             Import ids come from a per-type rule table, not from the state
             id — aws_sqs_queue imports by queue URL, aws_lambda_function by
             function name, aws_route by <route-table>_<destination>. A type
             with no rule is still emitted, flagged \`# VERIFY\`, because a
             silently dropped resource is the worst outcome of a state move.
             Nothing but identifiers leaves the state file.

Options:
  --profile   AWS config profile to scan (repeatable; overrides atlas.config.json accounts)
  --region    Limit the scan to specific region(s) (repeatable)
  --config    Path to atlas.config.json (default: ./atlas.config.json when present)
  --repo      tf-import: repo/project the state's Terraform code lives in
              (URL or org/repo slug) — required, shown on matched resources
  --stack     tf-import: stack name for a single state file
              (default: derived from the file name; multiple files always derive)
  --out       tf-blocks: write the HCL to this file instead of stdout
  --filter    tf-blocks: emit only addresses starting with this prefix
              (e.g. --filter module.net.) — moving one subtree is the common case

Examples:
  terraform state pull > /tmp/prod-network.tfstate
  atlas-scan tf-import --repo github.com/acme/infra-network --stack prod-network /tmp/prod-network.tfstate
  atlas-scan tf-import --repo github.com/acme/platform states/*.tfstate
  atlas-scan tf-blocks /tmp/prod-network.tfstate > imports.tf
  atlas-scan tf-blocks --filter module.net. --out imports.tf /tmp/prod-network.tfstate
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
      out: { type: 'string' },
      filter: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0] ?? 'scan';
  const takesFiles = command === 'tf-import' || command === 'tf-blocks';
  const knownCommand =
    command === 'scan' || command === 'bundle' || command === 'tf-import' || takesFiles;
  const extraPositionals = !takesFiles && positionals.length > 1;
  if (values.help || !knownCommand || extraPositionals) {
    if (extraPositionals) {
      console.error(`Unexpected arguments: ${positionals.slice(1).join(' ')}\n`);
    }
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  // Before loadConfig: turning a state file into HCL needs no atlas.config.json,
  // no snapshots and no AWS credentials. Requiring any of them would make the
  // command unusable in the target repo, which is where you actually want it.
  if (command === 'tf-blocks') {
    const files = positionals.slice(1);
    if (files.length === 0) {
      throw new Error('tf-blocks: pass at least one Terraform state file');
    }
    const cwd = invocationDir();
    const { hcl, summary } = await tfBlocks({ files, filter: values.filter, cwd });

    // stdout is HCL and nothing else — it is expected to be redirected into a
    // .tf file, so every word of prose goes to stderr.
    if (values.out) {
      const abs = await writeBlocks(hcl, values.out, cwd);
      console.error(`tf-blocks: wrote ${path.relative(cwd, abs) || abs}`);
    } else {
      process.stdout.write(hcl);
    }
    for (const line of formatSummary(summary)) console.error(line);
    return;
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
