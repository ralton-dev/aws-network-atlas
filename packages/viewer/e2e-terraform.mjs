// Smoke-test the Terraform state mapping (tf-import) over file:// with
// fixture data: "tf" badges on managed nodes, the Terraform section in the
// details panel (address + stack + repo), and the unmanaged callout.
//   node e2e-terraform.mjs
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

// Overview: the two fixture stacks claim the prod + dev VPCs (among others).
const overview = {
  tfBadges: await page.locator('.resource-node .badge', { hasText: /^tf$/ }).count(),
};
console.log('overview:', JSON.stringify(overview));
if (overview.tfBadges < 2) problems.push(`overview: expected ≥2 tf badges, got ${overview.tfBadges}`);

// Managed resource: prod-vpc is claimed by prod-network via module.vpc.aws_vpc.main.
await page.locator('.resource-node', { hasText: 'prod-vpc' }).first().click();
await page.waitForTimeout(400);
const managed = {
  tfSection: await page.locator('.details-panel .terraform').count(),
  address: await page.locator('.details-panel .tf-address', { hasText: 'module.vpc.aws_vpc.main' }).count(),
  stack: await page.locator('.details-panel .tf-origin', { hasText: 'prod-network' }).count(),
  repoLink: await page
    .locator('.details-panel .tf-origin a[href="https://github.com/acme/infra-network"]')
    .count(),
};
console.log('managed:', JSON.stringify(managed));
if (managed.tfSection === 0) problems.push('managed: Terraform section missing');
if (managed.address === 0) problems.push('managed: TF address missing');
if (managed.stack === 0) problems.push('managed: stack name missing');
if (managed.repoLink === 0) problems.push('managed: repo slug not rendered as https link');
await page.locator('.details-panel .close-btn').click();

// Unmanaged resource: nothing claims the shared-services TGW.
await page.locator('.resource-node', { hasText: 'core-tgw' }).first().click();
await page.waitForTimeout(400);
const unmanaged = {
  callout: await page
    .locator('.details-panel .terraform .muted', { hasText: 'Not claimed by any imported state' })
    .count(),
};
console.log('unmanaged:', JSON.stringify(unmanaged));
if (unmanaged.callout === 0) problems.push('unmanaged: "not claimed" callout missing');
await page.locator('.details-panel .close-btn').click();

// VPC detail: badges survive the drill-down (same central post-pass).
await page.locator('.resource-node', { hasText: 'prod-vpc' }).first().dispatchEvent('dblclick');
await page.waitForFunction(() => window.location.hash.startsWith('#/vpc/'), null, { timeout: 10000 });
await page.waitForTimeout(1800);
const detail = {
  tfBadges: await page.locator('.resource-node .badge', { hasText: /^tf$/ }).count(),
};
console.log('vpc-detail:', JSON.stringify(detail));
if (detail.tfBadges === 0) problems.push('vpc-detail: no tf badges after drill-down');

console.log('problems:', JSON.stringify(problems));
await browser.close();
process.exit(problems.length === 0 ? 0 : 1);
