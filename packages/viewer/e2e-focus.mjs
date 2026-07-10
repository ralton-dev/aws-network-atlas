// Smoke-test the focus / connections view over file:// with fixture data.
//   node e2e-focus.mjs
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

// Expected counts come from the builder over the same fixture (graph-check.mts
// output). React Flow silently drops dangling edges, so a mismatch here means
// edges vanished between builder and canvas. Update together on fixture changes.
const EXPECTED = { instance: { nodes: 25, edges: 40 }, sg: { nodes: 18, edges: 22 } };

await page.goto(`file://${SITE}#/`);
await page.waitForSelector('.resource-node', { timeout: 15000 });
await page.waitForTimeout(1000);

// --- reach an EC2 instance via Search, then "Focus on connections" ----------
await page.fill('.search-bar input', 'prod-app-a-1');
await page.waitForTimeout(500);
// Field-value search also matches the ASG (instanceIds) — pick the instance row.
await page
  .locator('.search-result', { has: page.locator('.search-result-name', { hasText: 'prod-app-a-1' }) })
  .first()
  .click();
await page.waitForTimeout(1500);
await page.locator('.link-btn', { hasText: 'Focus on connections' }).click();
await page.waitForFunction(() => window.location.hash.startsWith('#/focus/'), null, { timeout: 10000 });
await page.waitForTimeout(1800);

const instanceFocus = {
  hash: page.url().split('#')[1],
  nodes: await page.locator('.resource-node').count(),
  edges: await page.locator('.react-flow__edge').count(),
  center: await page.locator('.resource-node.is-emphasized').count(),
  centerIsInstance: await page.locator('.resource-node.is-emphasized', { hasText: 'prod-app-a-1' }).count(),
  role: await page.locator('.resource-node', { hasText: 'prod-app-role' }).count(),
  sg: await page.locator('.resource-node', { hasText: 'app tier' }).count(),
  subnet: await page.locator('.resource-node', { hasText: 'prod-app-a' }).count(),
  nat: await page.locator('.resource-node', { hasText: 'prod-nat-a' }).count(),
  tgw: await page.locator('.resource-node', { hasText: 'core-tgw' }).count(),
  cdn: await page.locator('.resource-node', { hasText: 'prod-web-cdn' }).count(),
  ghostVpc: await page.locator('.resource-node.is-ghost', { hasText: 'vpc-0legacy' }).count(),
  // relationship labels on the edges
  assumesRole: await page.locator('.edge-label', { hasText: 'assumes role' }).count(),
  appliesTo: await page.locator('.edge-label', { hasText: 'applies to' }).count(),
  inSubnet: await page.locator('.edge-label', { hasText: 'in subnet' }).count(),
  privateDns: await page.locator('.edge-label', { hasText: 'private DNS' }).count(),
  asgMember: await page.locator('.edge-label', { hasText: 'ASG member' }).count(),
  lbTarget: await page.locator('.edge-label', { hasText: 'HTTP 8080' }).count(),
  cfOrigin: await page.locator('.edge-label', { hasText: 'origin' }).count(),
  // scoping: the dev VPC appears via the peering leg, but NOT its internals
  devVpc: await page.locator('.resource-node', { hasText: 'dev-vpc' }).count(),
  devNat: await page.locator('.resource-node', { hasText: 'dev-nat' }).count(),
  breadcrumb: await page.locator('.crumb', { hasText: 'Focus: prod-app-a-1' }).count(),
};
console.log('instance-focus:', JSON.stringify(instanceFocus));
if (!instanceFocus.hash?.startsWith('/focus/')) problems.push('instance: not on a focus route');
if (instanceFocus.center !== 1) problems.push('instance: expected exactly one emphasized center');
if (instanceFocus.centerIsInstance !== 1) problems.push('instance: center is not prod-app-a-1');
for (const k of ['role', 'sg', 'subnet', 'nat', 'tgw', 'cdn', 'ghostVpc', 'devVpc']) {
  if (instanceFocus[k] === 0) problems.push(`instance: expected neighbor missing (${k})`);
}
for (const k of ['assumesRole', 'appliesTo', 'inSubnet', 'privateDns', 'asgMember', 'lbTarget', 'cfOrigin']) {
  if (instanceFocus[k] === 0) problems.push(`instance: expected edge label missing (${k})`);
}
if (instanceFocus.devNat !== 0) problems.push('instance: scope leak — dev VPC NAT pulled in');
if (instanceFocus.nodes !== EXPECTED.instance.nodes)
  problems.push(`instance: ${instanceFocus.nodes} nodes rendered, builder produced ${EXPECTED.instance.nodes}`);
if (instanceFocus.edges !== EXPECTED.instance.edges)
  problems.push(`instance: ${instanceFocus.edges} edges rendered, builder produced ${EXPECTED.instance.edges} — dangling edges dropped?`);
if (instanceFocus.breadcrumb === 0) problems.push('instance: focus breadcrumb missing');
await page.screenshot({ path: '/tmp/atlas-focus-review.png', fullPage: false });

// --- hop to the security group's own focus from inside the view -------------
// Exact label match: 'app tier' alone also matches the IAM role's subtitle.
await page
  .locator('.resource-node', { has: page.locator('.resource-label', { hasText: /^prod-app$/ }) })
  .first()
  .click();
await page.waitForTimeout(500);
await page.locator('.link-btn', { hasText: 'Focus on connections' }).click();
await page.waitForFunction(() => window.location.hash.includes('sg-0prodapp'), null, { timeout: 10000 });
await page.waitForTimeout(1800);

const sgFocus = {
  hash: page.url().split('#')[1],
  nodes: await page.locator('.resource-node').count(),
  edges: await page.locator('.react-flow__edge').count(),
  centerIsSg: await page.locator('.resource-node.is-emphasized', { hasText: 'app tier' }).count(),
  instances: await page.locator('.resource-node', { hasText: 'prod-app-a-1' }).count(),
  dbSg: await page.locator('.resource-node', { hasText: 'database tier' }).count(),
  albSg: await page.locator('.resource-node', { hasText: 'public ALB' }).count(),
  ruleIn: await page.locator('.edge-label.edge-label-sg-rule', { hasText: 'tcp 8080' }).count(),
  ruleOut: await page.locator('.edge-label.edge-label-sg-rule', { hasText: 'tcp 5432' }).count(),
  appliesTo: await page.locator('.edge-label', { hasText: 'applies to' }).count(),
};
console.log('sg-focus:', JSON.stringify(sgFocus));
if (sgFocus.centerIsSg !== 1) problems.push('sg: center is not the prod-app SG');
for (const k of ['instances', 'dbSg', 'albSg', 'ruleIn', 'ruleOut', 'appliesTo']) {
  if (sgFocus[k] === 0) problems.push(`sg: expected neighbor/edge missing (${k})`);
}
if (sgFocus.nodes !== EXPECTED.sg.nodes)
  problems.push(`sg: ${sgFocus.nodes} nodes rendered, builder produced ${EXPECTED.sg.nodes}`);
if (sgFocus.edges !== EXPECTED.sg.edges)
  problems.push(`sg: ${sgFocus.edges} edges rendered, builder produced ${EXPECTED.sg.edges} — dangling edges dropped?`);
await page.screenshot({ path: '/tmp/atlas-focus-sg.png', fullPage: false });

// --- back-navigation: breadcrumb → VPC, browser back → focus, crumb → overview
await page.locator('.crumb', { hasText: 'prod-vpc' }).click();
await page.waitForFunction(() => window.location.hash.startsWith('#/vpc/'), null, { timeout: 10000 });
await page.waitForTimeout(1200);
const afterCrumb = page.url().split('#')[1];
await page.goBack();
await page.waitForFunction(() => window.location.hash.startsWith('#/focus/'), null, { timeout: 10000 });
await page.waitForTimeout(1200);
const afterBack = {
  hash: page.url().split('#')[1],
  center: await page.locator('.resource-node.is-emphasized').count(),
};
await page.locator('.crumb', { hasText: 'Overview' }).click();
await page.waitForFunction(() => window.location.hash === '#/' || window.location.hash === '', null, { timeout: 10000 });
await page.waitForTimeout(1000);
const overviewNodes = await page.locator('.resource-node').count();
console.log('navigation:', JSON.stringify({ afterCrumb, afterBack, overviewNodes }));
if (!afterCrumb?.startsWith('/vpc/')) problems.push('nav: VPC breadcrumb did not open the VPC view');
if (!afterBack.hash?.startsWith('/focus/') || afterBack.center !== 1)
  problems.push('nav: browser back did not restore the focus view');
if (overviewNodes === 0) problems.push('nav: overview breadcrumb did not restore the overview');

console.log('problems:', JSON.stringify(problems));
await browser.close();
process.exit(problems.length > 0 ? 1 : 0);
