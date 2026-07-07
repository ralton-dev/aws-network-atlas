// CloudWatch Logs log groups — READ-ONLY (Describe* only).
// Dedicated collector (paginated, no cap) so that log destinations referenced
// by Network Firewall logging, VPC flow logs, and resolver query logs resolve
// to real resources instead of generic tag-sweep entries — plus retention/KMS
// posture, which the sweeps can't see.
import {
  CloudWatchLogsClient,
  paginateDescribeLogGroups,
} from '@aws-sdk/client-cloudwatch-logs';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectLogs(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'logs', 'DescribeLogGroups', async () => {
    const client = ctx.client(CloudWatchLogsClient, region);
    for await (const page of paginateDescribeLogGroups({ client }, {})) {
      for (const lg of page.logGroups ?? []) {
        if (!lg.logGroupName) continue;
        out.logGroups.push({
          id: lg.logGroupName,
          arn: lg.logGroupArn ?? lg.arn,
          name: lg.logGroupName,
          tags: {},
          retentionDays: lg.retentionInDays,
          kmsKeyId: lg.kmsKeyId,
          logGroupClass: lg.logGroupClass,
        });
      }
    }
  });
}
