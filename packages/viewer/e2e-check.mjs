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
  // everything-on-canvas additions
  securityLanes: await page.locator('.container-node.style-security').count(),
  internetNode: await page.locator('.resource-node', { hasText: 'Internet' }).count(),
  cloudfront: await page.locator('.resource-node', { hasText: 'prod-web-cdn' }).count(),
  iamRoles: await page.locator('.resource-node', { hasText: 'prod-app-role' }).count(),
  kms: await page.locator('.resource-node', { hasText: 'prod-rds' }).count(),
  secrets: await page.locator('.resource-node', { hasText: 'prod/db' }).count(),
  trustEdges: await page.locator('.edge-label', { hasText: 'assume-role' }).count(),
  dnsEdges: await page.locator('.edge-label', { hasText: 'DNS corp.acme.example' }).count(),
  openSgBadge: await page.locator('.badge', { hasText: 'internet-open SG' }).count(),
  // full-coverage additions
  globalAccelerator: await page.locator('.resource-node', { hasText: 'prod-edge' }).count(),
  wafCloudFront: await page.locator('.resource-node', { hasText: 'prod-waf' }).count(),
  wafRegional: await page.locator('.resource-node', { hasText: 'prod-alb-waf' }).count(),
  dxConnection: await page.locator('.resource-node', { hasText: 'hq-dx-1g' }).count(),
  dxVifEdge: await page.locator('.edge-label', { hasText: 'transit VIF' }).count(),
  // partial-permission scan surfaced as warning badges on containers
  scanWarningBadges: await page.locator('.badge-warning').count(),
  accountIncompleteBadge: await page.locator('.badge-warning', { hasText: 'scan incomplete' }).count(),
  regionErrorBadge: await page.locator('.badge-warning', { hasText: 'scan error' }).count(),
  // AWS Organizations governance tree (drawn under the management account)
  orgLane: await page.locator('.container-node.style-org', { hasText: 'Organization' }).count(),
  orgContainers: await page.locator('.container-node.style-org').count(),
  orgSandboxOu: await page.locator('.container-node.style-org', { hasText: 'Sandbox' }).count(),
  governsEdges: await page.locator('.edge-label-governs').count(),
  // IAM Identity Center + federation (Identity & security lane, management account)
  ssoInstance: await page.locator('.resource-node', { hasText: 'acme-identity-center' }).count(),
  ssoPermissionSet: await page.locator('.resource-node', { hasText: 'AdministratorAccess' }).count(),
  samlProvider: await page.locator('.resource-node', { hasText: 'acme-okta' }).count(),
  oidcProvider: await page.locator('.resource-node', { hasText: 'token.actions.githubusercontent.com' }).count(),
  ssoAssignEdges: await page.locator('.edge-label-sso-assign').count(),
};
console.log('overview:', JSON.stringify(overview));
if (overview.orgLane === 0) problems.push('overview: Organization container not drawn');
if (overview.orgContainers < 4) problems.push('overview: org root/OU/policy containers missing (tree not drawn)');
if (overview.orgSandboxOu === 0) problems.push('overview: Sandbox OU container missing');
if (overview.governsEdges === 0) problems.push('overview: no SCP `governs` attachment edges drawn');
if (overview.ssoInstance === 0) problems.push('overview: Identity Center instance node missing');
if (overview.ssoPermissionSet === 0) problems.push('overview: SSO permission set node missing');
if (overview.samlProvider === 0) problems.push('overview: SAML provider node missing');
if (overview.oidcProvider === 0) problems.push('overview: OIDC provider node missing');
if (overview.ssoAssignEdges === 0) problems.push('overview: no SSO permission-set assignment edges drawn');
if (overview.securityLanes === 0) problems.push('overview: no Identity & security lane');
if (overview.internetNode === 0) problems.push('overview: no Internet node');
if (overview.cloudfront === 0) problems.push('overview: CloudFront distribution missing');
if (overview.trustEdges === 0) problems.push('overview: no cross-account IAM trust edges');
if (overview.globalAccelerator === 0) problems.push('overview: Global Accelerator missing');
if (overview.wafCloudFront === 0) problems.push('overview: CloudFront-scope WAF ACL missing');
if (overview.wafRegional === 0) problems.push('overview: regional WAF ACL missing');
if (overview.dxConnection === 0) problems.push('overview: DX connection missing');
if (overview.dxVifEdge === 0) problems.push('overview: DX VIF edge missing');
if (overview.accountIncompleteBadge === 0) problems.push('overview: account scan-incomplete warning badge missing');
if (overview.regionErrorBadge === 0) problems.push('overview: region scan-error warning badge missing');
await page.screenshot({ path: '/tmp/atlas-everything-overview.png', fullPage: false });

// Click the region's warning badge → details panel lists the denied API calls.
await page.locator('.badge-warning', { hasText: 'scan error' }).first().click();
await page.waitForTimeout(400);
const scanErrors = {
  panelErrors: await page.locator('.details-panel .scan-errors li').count(),
  guardduty: await page.locator('.details-panel .scan-errors li code', { hasText: 'guardduty' }).count(),
};
console.log('scan-errors:', JSON.stringify(scanErrors));
if (scanErrors.panelErrors === 0) problems.push('overview: container scan-error details list missing');
if (scanErrors.guardduty === 0) problems.push('overview: guardduty error not listed in the details panel');
await page.locator('.details-panel .close-btn').click();

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
  // security-on-canvas additions
  sgNodes: await page.locator('.resource-node', { hasText: 'in / ' }).count(),
  openBadges: await page.locator('.badge', { hasText: 'open to internet' }).count(),
  sgRuleLabels: await page.locator('.edge-label.edge-label-sg-rule').count(),
  exposureLabels: await page.locator('.edge-label.edge-label-sg-open').count(),
  securityLane: await page.locator('.container-node.style-security').count(),
  cloudfront: await page.locator('.resource-node', { hasText: 'prod-web-cdn' }).count(),
  clientVpn: await page.locator('.resource-node', { hasText: 'prod-admin-vpn' }).count(),
  firewall: await page.locator('.resource-node', { hasText: 'prod-inspection-fw' }).count(),
  resolver: await page.locator('.resource-node', { hasText: 'prod-outbound' }).count(),
  // the fixture's 3-tier SG chain: internet 443 → alb-sg 8080 → app-sg 5432 → db-sg
  sgRule8080: await page.locator('.edge-label.edge-label-sg-rule', { hasText: 'tcp 8080' }).count(),
  sgRule5432: await page.locator('.edge-label.edge-label-sg-rule', { hasText: 'tcp 5432' }).count(),
  exposure443: await page.locator('.edge-label.edge-label-sg-open', { hasText: 'tcp 443' }).count(),
  // full-coverage additions: firewall policy chain, WAF, EFS, DNS Firewall, flow log
  fwPolicy: await page.locator('.resource-node', { hasText: 'prod-policy' }).count(),
  fwRuleGroups: await page.locator('.resource-node', { hasText: 'prod-egress-domains' }).count(),
  fwPolicyEdge: await page.locator('.edge-label', { hasText: 'firewall policy' }).count(),
  wafEdge: await page.locator('.edge-label', { hasText: 'WAF protects' }).count(),
  efs: await page.locator('.resource-node', { hasText: 'prod-shared-assets' }).count(),
  dnsFirewall: await page.locator('.resource-node', { hasText: 'prod-dns-firewall' }).count(),
  flowLog: await page.locator('.resource-node', { hasText: 'prod-vpc-flow' }).count(),
};
console.log('vpc-detail:', JSON.stringify(detail));
if (detail.fwPolicy === 0) problems.push('vpc: Network Firewall policy node missing');
if (detail.fwRuleGroups === 0) problems.push('vpc: Network Firewall rule group node missing');
if (detail.fwPolicyEdge === 0) problems.push('vpc: firewall → policy edge missing');
if (detail.wafEdge === 0) problems.push('vpc: WAF protects edge missing');
if (detail.efs === 0) problems.push('vpc: EFS file system node missing');
if (detail.dnsFirewall === 0) problems.push('vpc: DNS Firewall rule group node missing');
if (detail.flowLog === 0) problems.push('vpc: flow log node missing');
if (detail.sgNodes === 0) problems.push('vpc: no security group nodes');
if (detail.sgRuleLabels === 0) problems.push('vpc: no SG rule edges');
if (detail.exposureLabels === 0) problems.push('vpc: no internet-exposure edges');
if (detail.sgRule8080 === 0) problems.push('vpc: missing SG rule edge tcp 8080 (alb-sg → app-sg)');
if (detail.sgRule5432 === 0) problems.push('vpc: missing SG rule edge tcp 5432 (app-sg → db-sg)');
if (detail.exposure443 === 0) problems.push('vpc: missing internet-exposure edge tcp 443 (internet → alb-sg)');
if (detail.securityLane === 0) problems.push('vpc: no Security & identity lane');
if (detail.cloudfront === 0) problems.push('vpc: CloudFront missing from Connectivity');
// Rendered edge count must match what the builder produced — React Flow
// SILENTLY drops any edge whose source/target id is not a rendered node.
// The expected numbers come from running the builders directly over the
// same fixture (npx tsx graph-check.mts, which also asserts every edge
// endpoint resolves to a node). Update both together on fixture changes.
const EXPECTED_EDGES = { overview: 37, prodVpc: 72 };
if (overview.edges !== EXPECTED_EDGES.overview)
  problems.push(`overview: ${overview.edges} edges rendered but the builder produced ${EXPECTED_EDGES.overview} — dangling edges dropped?`);
if (detail.edges !== EXPECTED_EDGES.prodVpc)
  problems.push(`vpc: ${detail.edges} edges rendered but the builder produced ${EXPECTED_EDGES.prodVpc} — dangling edges dropped?`);
await page.screenshot({ path: '/tmp/atlas-everything-vpc.png', fullPage: false });
await page.screenshot({ path: '/tmp/atlas-review-vpc.png', fullPage: false });

// SG rule edge click → rules table with the SG-specific columns.
await page.locator('.edge-label.edge-label-sg-open').first().click();
await page.waitForTimeout(400);
const sgRule = {
  rulesTable: await page.locator('.routes-table').count(),
  ruleRows: await page.locator('.routes-table tbody tr').count(),
  sourceHeader: await page.locator('.routes-table thead th', { hasText: 'Source' }).count(),
};
console.log('sg-open-details:', JSON.stringify(sgRule));
if (sgRule.sourceHeader === 0) problems.push('vpc: exposure edge details missing rule columns');
await page.locator('.details-panel .close-btn').click();

// Layers panel: the new kinds must auto-derive rows and toggle edges off/on.
await page.locator('.toolbar-btn', { hasText: 'Layers' }).click();
await page.waitForTimeout(300);
const layers = {
  sgRow: await page.locator('.layer-row', { hasText: 'Security groups' }).count(),
  exposureRow: await page.locator('.layer-row', { hasText: 'Internet exposure' }).count(),
  attachRow: await page.locator('.layer-row', { hasText: 'SG attachments' }).count(),
};
console.log('layers:', JSON.stringify(layers));
if (layers.sgRow === 0 || layers.exposureRow === 0) problems.push('layers: SG rows missing');
const beforeToggle = await page.locator('.edge-label.edge-label-sg-open').count();
await page.locator('.layer-row', { hasText: 'Internet exposure' }).locator('input').click();
await page.waitForTimeout(300);
const afterToggle = await page.locator('.edge-label.edge-label-sg-open').count();
if (!(beforeToggle > 0 && afterToggle === 0)) problems.push('layers: exposure toggle did not hide edges');
await page.locator('.layer-row', { hasText: 'Internet exposure' }).locator('input').click();
await page.waitForTimeout(300);
await page.locator('.layers-panel .close-btn').click();
console.log('layers-toggle:', JSON.stringify({ beforeToggle, afterToggle }));

// Details panel with annotation (Aurora cluster node).
await page.locator('.resource-node', { hasText: 'prod-aurora-writer' }).first().click();
await page.waitForTimeout(500);
const details = {
  panelOpen: (await page.locator('.details-panel').count()) === 1,
};
console.log('details:', JSON.stringify(details));

// Edge click → route breakdown (a route edge with CIDR labels).
await page.locator('.edge-label', { hasText: '0.0.0.0/0' }).first().click();
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
