import pLimit from 'p-limit';
import {
  emptyGlobal,
  emptyRegionSnapshot,
  type AccountConfig,
  type AccountSnapshot,
  type RegionSnapshot,
} from '@atlas/schema';
import { AwsContext, resolveHomeRegion } from './aws.js';
import { verifyCredentials, accountAlias } from './preflight.js';
import { enabledRegions } from './regions.js';
import { collectNetwork } from './collect/network.js';
import { collectTgw } from './collect/tgw.js';
import { collectElb } from './collect/elb.js';
import { collectCompute } from './collect/compute.js';
import { collectDataStores } from './collect/data-stores.js';
import { collectContainers } from './collect/containers.js';
import { collectSecurity } from './collect/security.js';
import { collectEdgeNetwork } from './collect/edge-network.js';
import { collectCloudControl } from './collect/cloudcontrol.js';
import { collectGeneric } from './collect/generic.js';
import { collectGlobal } from './collect/global.js';
import { collectIam } from './collect/iam.js';
import { collectCloudFront } from './collect/cloudfront.js';
import { collectWaf, collectWafCloudFront } from './collect/waf.js';
import { collectDnsFirewall } from './collect/dns-firewall.js';
import { collectDirectConnect } from './collect/direct-connect.js';
import { collectVpcWorkloads } from './collect/vpc-workloads.js';
import { collectLattice } from './collect/lattice.js';
import { collectLogs } from './collect/logs.js';
import { collectCognito } from './collect/cognito.js';
import { collectEcr } from './collect/ecr.js';
import { collectDynamoDb } from './collect/dynamodb.js';
import { collectSns, collectSqs } from './collect/messaging.js';
import { collectEventBridge, collectPipes, collectScheduler } from './collect/eventbridge.js';
import { collectStepFunctions } from './collect/stepfunctions.js';
import { collectEmr } from './collect/emr.js';
import { collectBatch } from './collect/batch.js';
import { collectNeptune, collectDocDb } from './collect/graph-doc-db.js';
import { collectMemoryDb } from './collect/memorydb.js';
import { collectTransfer } from './collect/transfer.js';
import { collectBeanstalk } from './collect/beanstalk.js';
import { collectGlue } from './collect/glue.js';
import { collectDms } from './collect/dms.js';
import { collectDataSync } from './collect/datasync.js';
import { collectFirehose } from './collect/firehose.js';
import { collectConfig } from './collect/config-service.js';
import { collectCloudTrail } from './collect/cloudtrail.js';
import { collectGuardDuty } from './collect/guardduty.js';
import { collectBackup } from './collect/backup.js';
import {
  collectAccessAnalyzer,
  collectInspector2,
  collectMacie2,
  collectSecurityHub,
} from './collect/security-posture.js';
import { collectGlobalAccelerator } from './collect/global-accelerator.js';
import { collectCloudWan } from './collect/cloudwan.js';
import { collectOrganizations } from './collect/organizations.js';
import { deriveRegion, sortErrors } from './derive.js';
import { sortById } from './util.js';

const SCANNER_VERSION = '0.1.0';

export interface ScanProgress {
  (message: string): void;
}

/** Scan one account (one profile) across its regions. */
export async function scanAccount(
  account: AccountConfig,
  opts: { regionConcurrency: number; emptyRegions: 'exclude' | 'annotate' },
  progress: ScanProgress,
): Promise<AccountSnapshot> {
  const ctx = new AwsContext(account.profile, await resolveHomeRegion(account.profile));

  progress(`[${account.profile}] verifying credentials…`);
  const identity = await verifyCredentials(ctx);
  const alias = account.name ?? (await accountAlias(ctx));
  progress(`[${account.profile}] account ${identity.accountId}${alias ? ` (${alias})` : ''} — ${identity.arn}`);

  let regions: string[];
  if (account.regions && account.regions.length > 0) {
    regions = [...new Set(account.regions)].sort();
  } else {
    progress(`[${account.profile}] discovering enabled regions…`);
    regions = [...new Set(await enabledRegions(ctx))];
  }
  const excluded = new Set(account.excludeRegions ?? []);
  regions = regions.filter((r) => !excluded.has(r));
  progress(`[${account.profile}] scanning ${regions.length} region(s): ${regions.join(', ')}`);

  const limit = pLimit(opts.regionConcurrency);
  const regionSnapshots = await Promise.all(
    regions.map((region) =>
      limit(async (): Promise<RegionSnapshot> => {
        const out = emptyRegionSnapshot(region);
        // Different collectors hit different service APIs; run them together.
        // Within EC2, adaptive retry + client caching keeps throttling in check.
        await Promise.all([
          collectNetwork(ctx, region, identity.accountId, out),
          collectTgw(ctx, region, out),
          collectElb(ctx, region, out),
          collectCompute(ctx, region, out),
          collectDataStores(ctx, region, out),
          collectContainers(ctx, region, out),
          collectSecurity(ctx, region, out),
          collectEdgeNetwork(ctx, region, identity.accountId, out),
          collectWaf(ctx, region, out),
          collectDnsFirewall(ctx, region, out),
          collectDirectConnect(ctx, region, out),
          collectVpcWorkloads(ctx, region, out),
          collectLattice(ctx, region, out),
          collectLogs(ctx, region, out),
          collectCognito(ctx, region, out),
          collectEcr(ctx, region, out),
          collectDynamoDb(ctx, region, out),
          collectSns(ctx, region, out),
          collectSqs(ctx, region, out),
          collectEventBridge(ctx, region, out),
          collectPipes(ctx, region, out),
          collectScheduler(ctx, region, out),
          collectStepFunctions(ctx, region, out),
          collectEmr(ctx, region, out),
          collectBatch(ctx, region, out),
          collectNeptune(ctx, region, out),
          collectDocDb(ctx, region, out),
          collectMemoryDb(ctx, region, out),
          collectTransfer(ctx, region, out),
          collectBeanstalk(ctx, region, out),
          collectGlue(ctx, region, out),
          collectDms(ctx, region, out),
          collectDataSync(ctx, region, out),
          collectFirehose(ctx, region, out),
          collectConfig(ctx, region, out),
          collectCloudTrail(ctx, region, out),
          collectGuardDuty(ctx, region, out),
          collectBackup(ctx, region, out),
          collectSecurityHub(ctx, region, out),
          collectAccessAnalyzer(ctx, region, out),
          collectInspector2(ctx, region, out),
          collectMacie2(ctx, region, out),
          collectGeneric(ctx, region, out),
          collectCloudControl(ctx, region, out),
        ]);
        deriveRegion(out);
        progress(
          `[${account.profile}] ${region}: ${out.vpcs.length} VPCs, ${out.subnets.length} subnets, ` +
            `${out.instances.length} instances, ${out.generic.length} tagged resources` +
            (out.empty ? ' (empty)' : '') +
            (out.errors.length > 0 ? ` — ${out.errors.length} error(s)` : ''),
        );
        return out;
      }),
    ),
  );

  const global = emptyGlobal();
  progress(
    `[${account.profile}] collecting global resources (Route 53, DX, S3, IAM, CloudFront, WAF, Global Accelerator, Cloud WAN, Organizations)…`,
  );
  await Promise.all([
    collectGlobal(ctx, global),
    collectIam(ctx, global),
    collectCloudFront(ctx, global),
    collectWafCloudFront(ctx, global),
    collectGlobalAccelerator(ctx, global),
    collectCloudWan(ctx, global),
    collectOrganizations(ctx, global),
  ]);
  global.hostedZones.sort((a, b) => a.id.localeCompare(b.id));
  for (const z of global.hostedZones) {
    z.vpcAssociations.sort((a, b) => `${a.vpcId}|${a.region}`.localeCompare(`${b.vpcId}|${b.region}`));
  }
  global.directConnectGateways.sort((a, b) => a.id.localeCompare(b.id));
  for (const gw of global.directConnectGateways) {
    gw.associations.sort((a, b) =>
      `${a.associatedGatewayId ?? ''}|${a.associatedGatewayType ?? ''}`.localeCompare(
        `${b.associatedGatewayId ?? ''}|${b.associatedGatewayType ?? ''}`,
      ),
    );
  }
  global.s3Buckets.sort((a, b) => a.id.localeCompare(b.id));
  // Deterministic ordering for the account-global collections (nested arrays
  // too — AWS list order is unspecified, and snapshots are committed to git).
  sortById(global.iamRoles);
  for (const r of global.iamRoles) {
    r.attachedManagedPolicyArns.sort();
    r.inlinePolicyNames.sort();
  }
  sortById(global.iamUsers);
  for (const u of global.iamUsers) {
    u.groups.sort();
    u.attachedManagedPolicyArns.sort();
    u.inlinePolicyNames.sort();
    u.accessKeyIds.sort();
  }
  sortById(global.iamGroups);
  for (const g of global.iamGroups) {
    g.attachedManagedPolicyArns.sort();
    g.inlinePolicyNames.sort();
    g.userNames.sort();
  }
  sortById(global.iamPolicies);
  sortById(global.iamInstanceProfiles);
  for (const p of global.iamInstanceProfiles) p.roleNames.sort();
  sortById(global.cloudFrontDistributions);
  for (const d of global.cloudFrontDistributions) {
    d.aliases.sort();
    d.origins.sort();
    d.originDetails?.sort((a, b) => (a.domainName ?? '').localeCompare(b.domainName ?? ''));
  }
  sortById(global.cloudFrontVpcOrigins);
  sortById(global.globalAccelerators);
  sortById(global.coreNetworks);
  sortById(global.organizations);
  for (const o of global.organizations) {
    o.roots.sort((a, b) => a.id.localeCompare(b.id));
    for (const r of o.roots) r.policyTypes.sort((a, b) => a.type.localeCompare(b.type));
    o.availablePolicyTypes?.sort((a, b) => a.type.localeCompare(b.type));
    o.trustedServices.sort();
    o.delegatedAdministrators.sort((a, b) => a.id.localeCompare(b.id));
    for (const d of o.delegatedAdministrators) d.services?.sort();
  }
  sortById(global.organizationalUnits);
  sortById(global.organizationAccounts);
  sortById(global.organizationPolicies);
  for (const p of global.organizationPolicies) {
    p.targets.sort((a, b) => a.targetId.localeCompare(b.targetId));
  }
  sortById(global.wafWebAcls);
  sortById(global.wafIpSets);
  sortById(global.wafRuleGroups);
  sortErrors(global.errors);

  const keep = regionSnapshots.filter((r) => !r.empty);
  const emptyRegions = regionSnapshots.filter((r) => r.empty).map((r) => r.region);
  const regionsOut =
    opts.emptyRegions === 'exclude'
      ? keep
      : regionSnapshots; // annotate mode keeps them, flagged empty: true

  return {
    accountId: identity.accountId,
    alias,
    profile: account.profile,
    scannedAt: new Date().toISOString(),
    scannerVersion: SCANNER_VERSION,
    regions: regionsOut.sort((a, b) => a.region.localeCompare(b.region)),
    emptyRegions: emptyRegions.sort(),
    global,
  };
}
