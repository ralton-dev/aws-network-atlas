// AWS Config — READ-ONLY (Describe* only).
// Governance posture the sweeps can't see: whether the configuration recorder
// is on and what it records (all-supported vs an explicit type list), where
// snapshots deliver (S3 bucket / SNS topic from the region's 0-or-1 delivery
// channel), plus the Config rules (managed/custom + state) and conformance
// packs deployed in the region. NOT in the Cloud Control sweep; regional,
// not VPC-attached.
import {
  ConfigServiceClient,
  DescribeConfigurationRecordersCommand,
  DescribeConfigurationRecorderStatusCommand,
  DescribeDeliveryChannelsCommand,
  paginateDescribeConfigRules,
  paginateDescribeConformancePacks,
  paginateDescribeConformancePackStatus,
} from '@aws-sdk/client-config-service';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectConfig(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(ConfigServiceClient, region);

  // Recorders + status + delivery channel, merged per recorder name.
  await guard(out.errors, 'config', 'DescribeConfigurationRecorders', async () => {
    const described = await client.send(new DescribeConfigurationRecordersCommand({}));
    const recorders = described.ConfigurationRecorders ?? [];
    if (recorders.length === 0) return;

    // Status by recorder name — a failure here must not lose the recorder.
    const statusByName = new Map<string, { recording?: boolean; lastStatus?: string }>();
    try {
      const statuses = await client.send(new DescribeConfigurationRecorderStatusCommand({}));
      for (const s of statuses.ConfigurationRecordersStatus ?? []) {
        if (s.name) statusByName.set(s.name, { recording: s.recording, lastStatus: s.lastStatus });
      }
    } catch {
      // keep the recorders without status
    }

    // Delivery channel is 0-or-1 per region — apply its bucket/SNS to the recorder(s).
    let deliveryS3BucketName: string | undefined;
    let deliverySnsTopicArn: string | undefined;
    try {
      const channels = await client.send(new DescribeDeliveryChannelsCommand({}));
      const channel = channels.DeliveryChannels?.[0];
      deliveryS3BucketName = channel?.s3BucketName;
      deliverySnsTopicArn = channel?.snsTopicARN;
    } catch {
      // keep the recorders without delivery detail
    }

    for (const r of recorders) {
      if (!r.name) continue;
      const status = statusByName.get(r.name);
      out.configRecorders.push({
        id: r.name,
        name: r.name,
        // Config recorders carry no tags.
        tags: {},
        recording: status?.recording,
        lastStatus: status?.lastStatus,
        roleArn: r.roleARN,
        allSupported: r.recordingGroup?.allSupported,
        includeGlobalResourceTypes: r.recordingGroup?.includeGlobalResourceTypes,
        // resourceTypes is an SDK enum array; store the plain string values.
        recordedResourceTypes: (r.recordingGroup?.resourceTypes ?? [])
          .filter((t) => !!t)
          .map((t) => String(t)),
        deliveryS3BucketName,
        deliverySnsTopicArn,
      });
    }
  });

  // Rules (managed + custom) — paginated.
  await guard(out.errors, 'config', 'DescribeConfigRules', async () => {
    for await (const page of paginateDescribeConfigRules({ client }, {})) {
      for (const rule of page.ConfigRules ?? []) {
        if (!rule.ConfigRuleName) continue;
        out.configRules.push({
          id: rule.ConfigRuleName,
          arn: rule.ConfigRuleArn,
          name: rule.ConfigRuleName,
          tags: {},
          source: rule.Source?.Owner
            ? `${rule.Source.Owner}${rule.Source.SourceIdentifier ? '/' + rule.Source.SourceIdentifier : ''}`
            : undefined,
          state: rule.ConfigRuleState,
        });
      }
    }
  });

  // Conformance packs — paginated; status by pack name is best-effort.
  await guard(out.errors, 'config', 'DescribeConformancePacks', async () => {
    const statusByName = new Map<string, string | undefined>();
    try {
      for await (const page of paginateDescribeConformancePackStatus({ client }, {})) {
        for (const s of page.ConformancePackStatusDetails ?? []) {
          if (s.ConformancePackName) {
            statusByName.set(s.ConformancePackName, s.ConformancePackState);
          }
        }
      }
    } catch {
      // keep the packs without status
    }
    for await (const page of paginateDescribeConformancePacks({ client }, {})) {
      for (const pack of page.ConformancePackDetails ?? []) {
        if (!pack.ConformancePackName) continue;
        out.configConformancePacks.push({
          id: pack.ConformancePackName,
          arn: pack.ConformancePackArn,
          name: pack.ConformancePackName,
          tags: {},
          status: statusByName.get(pack.ConformancePackName),
        });
      }
    }
  });
}
