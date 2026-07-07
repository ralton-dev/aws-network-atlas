// Security-posture services — READ-ONLY (Describe*/Get*/List* only).
// Account-level security toggles the sweeps can't see: whether Security Hub
// is on (and which standards it evaluates), whether IAM Access Analyzer
// watches for external/unused access, which resource types Inspector v2
// scans, and whether Macie sensitive-data discovery is enabled. Each is
// usually 0-or-1 per region (analyzers can be several). NOT in the Cloud
// Control sweep; regional, not VPC-attached. Services that are simply not
// enabled throw — the guard records that, which is expected and harmless.
import {
  SecurityHubClient,
  DescribeHubCommand,
  paginateGetEnabledStandards,
} from '@aws-sdk/client-securityhub';
import { AccessAnalyzerClient, paginateListAnalyzers } from '@aws-sdk/client-accessanalyzer';
import { Inspector2Client, BatchGetAccountStatusCommand } from '@aws-sdk/client-inspector2';
import { Macie2Client, GetMacieSessionCommand } from '@aws-sdk/client-macie2';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectSecurityHub(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(SecurityHubClient, region);

  // DescribeHub throws when the account isn't subscribed in this region —
  // the guard records it and no status entry is pushed.
  await guard(out.errors, 'securityhub', 'DescribeHub', async () => {
    const hub = await client.send(new DescribeHubCommand({}));

    // Standards — a failure here must not lose the hub status.
    const enabledStandards: string[] = [];
    try {
      for await (const page of paginateGetEnabledStandards({ client }, {})) {
        for (const sub of page.StandardsSubscriptions ?? []) {
          if (sub.StandardsArn) enabledStandards.push(sub.StandardsArn);
        }
      }
    } catch {
      // keep the hub without standards detail
    }

    out.securityHubStatus.push({
      id: hub.HubArn ?? 'securityhub',
      arn: hub.HubArn,
      name: 'securityhub',
      // Tags need a separate ListTagsForResource call — skipped.
      tags: {},
      enabled: true,
      autoEnableControls: hub.AutoEnableControls,
      controlFindingGenerator: hub.ControlFindingGenerator,
      enabledStandards,
    });
  });
}

export async function collectAccessAnalyzer(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(AccessAnalyzerClient, region);

  // Analyzers (external-access + unused-access; several possible per region).
  await guard(out.errors, 'access-analyzer', 'ListAnalyzers', async () => {
    for await (const page of paginateListAnalyzers({ client }, {})) {
      for (const analyzer of page.analyzers ?? []) {
        if (!analyzer.name) continue;
        out.accessAnalyzers.push({
          id: analyzer.name,
          arn: analyzer.arn,
          name: analyzer.name,
          tags: {},
          analyzerType: analyzer.type,
          status: analyzer.status,
        });
      }
    }
  });
}

export async function collectInspector2(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(Inspector2Client, region);

  // Own-account status only (no accountIds → the calling account).
  await guard(out.errors, 'inspector2', 'BatchGetAccountStatus', async () => {
    const status = await client.send(new BatchGetAccountStatusCommand({}));
    const state = status.accounts?.[0]?.resourceState;
    if (!state) return;
    out.inspectorStatus.push({
      id: 'inspector2',
      name: 'inspector2',
      tags: {},
      ec2: state.ec2?.status,
      ecr: state.ecr?.status,
      lambda: state.lambda?.status,
      lambdaCode: state.lambdaCode?.status,
    });
  });
}

export async function collectMacie2(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(Macie2Client, region);

  // GetMacieSession throws when Macie isn't enabled in this region — the
  // guard records it and no status entry is pushed.
  await guard(out.errors, 'macie2', 'GetMacieSession', async () => {
    const session = await client.send(new GetMacieSessionCommand({}));
    out.macieStatus.push({
      id: 'macie2',
      name: 'macie2',
      tags: {},
      status: session.status,
      findingPublishingFrequency: session.findingPublishingFrequency,
    });
  });
}
