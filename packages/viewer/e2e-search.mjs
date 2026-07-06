// Verify search finds resources by their FIELD VALUES (ref.raw), across
// resource kinds — IPs, CIDRs, domains, endpoints, aliases — not just
// name/id/arn/kind/tags. Runs over the built single-file viewer + fixture.
//   node e2e-search.mjs
import { chromium } from 'playwright';
import path from 'node:path';

const SITE = path.resolve(import.meta.dirname, '../../site/index.html');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`file://${SITE}#/`);
await page.waitForSelector('.resource-node', { timeout: 15000 });
await page.waitForTimeout(800);

// Each case: query → a row with this kind chip + name substring must appear.
// `first: true` additionally asserts it is the TOP result (ranking check).
const CASES = [
  // --- NEW: value-based searches over ref.raw ------------------------------
  { q: 'www.acme.example', kind: 'cloudfront', name: 'prod-web-cdn', why: 'CloudFront alias' },
  { q: '10.0.10.20', kind: 'instance', name: 'prod-app-a-1', why: 'EC2 private IP', shot: '/tmp/atlas-search.png' },
  { q: '10.0.10.0/24', kind: 'subnet', name: 'prod-app-a', why: 'subnet CIDR' },
  { q: 'corp.acme.example', kind: 'resolver-rule', name: 'corp-onprem-forward', why: 'resolver rule domain' },
  { q: 'alias/prod-app-data', kind: 'kms', name: '1234abcd', why: 'KMS alias' },
  { q: '*.acme.example', kind: 'acm', name: 'acme.example', why: 'ACM subject-alternative-name' },
  { q: 'acme.example', kind: 'cloudfront', name: 'prod-web-cdn', why: 'CloudFront alias (bare domain)' },
  { q: '10.0.10.53', kind: 'resolver-endpoint', name: 'prod-outbound', why: 'DNS resolver endpoint IP' },
  { q: '198.51.100.10', kind: 'nat', name: 'prod-nat-a', why: 'NAT gateway public IP' },
  { q: 'dev-postgres.abc.eu-west-1.rds.amazonaws.com', kind: 'rds', name: 'dev-postgres', why: 'RDS endpoint host' },
  { q: 'prod-aurora.cluster-abc', kind: 'rds-cluster', name: 'prod-aurora', why: 'Aurora cluster endpoint (prefix)' },
  { q: '203.0.113.1', kind: 'vpn', name: 'hq-vpn', why: 'VPN tunnel outside IP' },
  // --- EXISTING behaviour must keep working and rank sensibly --------------
  { q: 'prod-vpc', kind: 'vpc', name: 'prod-vpc', first: true, why: 'resource name (must rank #1)' },
  { q: 'vpc-0prod00000000000a1', kind: 'vpc', name: 'prod-vpc', first: true, why: 'resource id' },
  { q: 'i-0prodapp', kind: 'instance', name: 'prod-app-', why: 'instance id prefix' },
  { q: 'dynamodb', kind: 'generic', name: 'prod-sessions', why: 'service keyword' },
  { q: 'env=prod', kind: 'vpc', name: 'prod-vpc', why: 'tag key=value' },
];

for (const c of CASES) {
  await page.fill('.search-bar input', '');
  await page.fill('.search-bar input', c.q);
  await page.waitForTimeout(450);
  const rows = await page.$$eval('.search-result', (els) =>
    els.map((el) => ({
      kind: el.querySelector('.kind-chip')?.textContent ?? '',
      name: el.querySelector('.search-result-name')?.textContent ?? '',
    })),
  );
  if (c.shot) await page.screenshot({ path: c.shot });
  const hitIdx = rows.findIndex((r) => r.kind === c.kind && r.name.includes(c.name));
  const ok = c.first ? hitIdx === 0 : hitIdx >= 0;
  const top = rows.slice(0, 3).map((r) => `${r.kind}:${r.name}`).join(' | ');
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.q.padEnd(45)} → ${c.kind}:${c.name}` +
      `  (${c.why}; hit @${hitIdx}; ${rows.length} rows; top: ${top || '<none>'})`,
  );
  if (!ok)
    problems.push(
      `search "${c.q}" (${c.why}): expected ${c.kind}:${c.name}${c.first ? ' as first row' : ''}, ` +
        `got [${rows.map((r) => `${r.kind}:${r.name}`).join(', ') || 'no results'}]`,
    );
}

console.log('problems:', JSON.stringify(problems));
await browser.close();
process.exit(problems.length > 0 ? 1 : 0);
