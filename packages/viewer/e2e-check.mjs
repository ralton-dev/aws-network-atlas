// Smoke-test the built single-file viewer over file:// with fixture data.
//   node e2e-check.mjs
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
await page.waitForTimeout(1200);

const overview = {
  resourceNodes: await page.locator('.resource-node').count(),
  containers: await page.locator('.container-node').count(),
  edges: await page.locator('.react-flow__edge').count(),
  edgeLabels: await page.locator('.edge-label').count(),
  ghosts: await page.locator('.resource-node.is-ghost').count(),
};
console.log('overview:', JSON.stringify(overview));
await page.screenshot({ path: '/tmp/atlas-overview.png' });

// Drill into the prod VPC (dispatch dblclick directly — edge labels can
// overlap the node's hitbox in the small fixture graph).
await page.locator('.resource-node', { hasText: 'prod-vpc' }).first().dispatchEvent('dblclick');
await page.waitForFunction(() => window.location.hash.startsWith('#/vpc/'), null, { timeout: 10000 });
await page.waitForTimeout(1800);
const detail = {
  url: page.url().split('#')[1],
  subnets: await page
    .locator('.container-node.style-subnet-public, .container-node.style-subnet-private')
    .count(),
  azContainers: await page.locator('.container-node.style-az').count(),
  resourceNodes: await page.locator('.resource-node').count(),
  edges: await page.locator('.react-flow__edge').count(),
};
console.log('vpc-detail:', JSON.stringify(detail));
await page.screenshot({ path: '/tmp/atlas-vpc.png' });

// Details panel with annotation (the VPC container header click).
await page.locator('.resource-node', { hasText: 'prod-postgres' }).first().click();
await page.waitForTimeout(500);
const details = {
  panelOpen: (await page.locator('.details-panel').count()) === 1,
  hasAnnotation: (await page.locator('.details-panel .annotation').count()) === 1,
  annotationText: await page.locator('.details-panel .annotation').textContent().catch(() => null),
};
console.log('details:', JSON.stringify(details));
await page.screenshot({ path: '/tmp/atlas-details.png' });

// Edge click → route breakdown.
await page.locator('.edge-label').first().click();
await page.waitForTimeout(400);
console.log(
  'edge-details:',
  JSON.stringify({
    routesTable: await page.locator('.routes-table').count(),
    routeRows: await page.locator('.routes-table tbody tr').count(),
  }),
);

// Search across the "everything" inventory (a DynamoDB table not on the diagram).
await page.fill('.search-bar input', 'prod-sessions');
await page.waitForTimeout(500);
const searchCount = await page.locator('.search-result').count();
console.log('search:', JSON.stringify({ results: searchCount }));
await page.screenshot({ path: '/tmp/atlas-search.png' });
if (searchCount > 0) {
  await page.locator('.search-result').first().click();
  await page.waitForTimeout(400);
  console.log(
    'search-pick:',
    JSON.stringify({ panelShowsArn: await page.locator('.details-panel .arn').count() }),
  );
}

// Back to overview via breadcrumb.
await page.locator('.crumb', { hasText: 'Overview' }).click();
await page.waitForTimeout(1200);
console.log('back-to-overview:', JSON.stringify({ hash: page.url().split('#')[1] }));

console.log('problems:', JSON.stringify(problems));
await browser.close();
process.exit(problems.length > 0 ? 1 : 0);
