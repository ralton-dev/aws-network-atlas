// Smoke-test the Terraform state mapping (tf-import) over file:// with
// fixture data: the Terraform mark on managed nodes, the Terraform section in
// the details panel (address + stack + repo), the unmanaged callout, and the
// managed/unmanaged filter in the Layers panel.
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
  tfMarks: await page.locator('.resource-node .tf-mark').count(),
};
console.log('overview:', JSON.stringify(overview));
if (overview.tfMarks < 2) problems.push(`overview: expected ≥2 Terraform marks, got ${overview.tfMarks}`);

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

// Layers panel: the Terraform managed/unmanaged filter.
await page.locator('.toolbar-btn', { hasText: 'Layers' }).click();
await page.waitForTimeout(300);
const visibleProdVpc = () =>
  page.locator('.resource-node:visible', { hasText: 'prod-vpc' }).count();
const visibleCoreTgw = () =>
  page.locator('.resource-node:visible', { hasText: 'core-tgw' }).count();

await page.locator('.layer-row', { hasText: 'Terraform-managed only' }).locator('input').check();
await page.waitForTimeout(400);
const managedOnly = { prodVpc: await visibleProdVpc(), coreTgw: await visibleCoreTgw() };
console.log('filter-managed:', JSON.stringify(managedOnly));
if (managedOnly.prodVpc === 0) problems.push('filter-managed: managed prod-vpc was hidden');
if (managedOnly.coreTgw !== 0) problems.push('filter-managed: unmanaged core-tgw still visible');

await page.locator('.layer-row', { hasText: 'Unmanaged only' }).locator('input').check();
await page.waitForTimeout(400);
const unmanagedOnly = { prodVpc: await visibleProdVpc(), coreTgw: await visibleCoreTgw() };
console.log('filter-unmanaged:', JSON.stringify(unmanagedOnly));
if (unmanagedOnly.prodVpc !== 0) problems.push('filter-unmanaged: managed prod-vpc still visible');
if (unmanagedOnly.coreTgw === 0) problems.push('filter-unmanaged: unmanaged core-tgw was hidden');

await page.locator('.layer-row', { hasText: 'All resources' }).locator('input').check();
await page.waitForTimeout(400);
const allAgain = { prodVpc: await visibleProdVpc(), coreTgw: await visibleCoreTgw() };
console.log('filter-all:', JSON.stringify(allAgain));
if (allAgain.prodVpc === 0 || allAgain.coreTgw === 0) {
  problems.push('filter-all: resources did not come back after resetting the filter');
}
await page.locator('.layers-panel .close-btn').click();

// VPC detail: marks survive the drill-down (same central post-pass).
await page.locator('.resource-node', { hasText: 'prod-vpc' }).first().dispatchEvent('dblclick');
await page.waitForFunction(() => window.location.hash.startsWith('#/vpc/'), null, { timeout: 10000 });
await page.waitForTimeout(1800);
const detail = {
  tfMarks: await page.locator('.resource-node .tf-mark').count(),
};
console.log('vpc-detail:', JSON.stringify(detail));
if (detail.tfMarks === 0) problems.push('vpc-detail: no Terraform marks after drill-down');

console.log('problems:', JSON.stringify(problems));
await browser.close();
process.exit(problems.length === 0 ? 0 : 1);
