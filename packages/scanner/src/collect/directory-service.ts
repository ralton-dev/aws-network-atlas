// AWS Directory Service — READ-ONLY (Describe* only).
// Managed Microsoft AD / Simple AD / AD Connector are VPC-ATTACHED identity
// infrastructure: domain controllers (or connector endpoints) live as ENIs in
// two subnets behind a Directory Service-managed security group — placement
// the tag sweep can't see when the directory is untagged. DescribeDirectories
// returns the placement on VpcSettings (Simple/Microsoft AD) or
// ConnectSettings (AD Connector), plus the directory DNS IPs. The API returns
// no ARN, so one is constructed from the caller's account id. Tags are not
// returned and are deliberately not fetched per-resource (no N+1
// ListTagsForResource fan-out — it needs ds:List*, and the Redshift
// Serverless / OpenSearch collectors set the no-fan-out precedent).
import {
  DirectoryServiceClient,
  paginateDescribeDirectories,
} from '@aws-sdk/client-directory-service';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Per-region directory cap so a huge estate can't stall the scan. */
const MAX_DIRECTORIES = 100;

export async function collectDirectoryService(
  ctx: AwsContext,
  region: string,
  accountId: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'directory-service', 'DescribeDirectories', async () => {
    const client = ctx.client(DirectoryServiceClient, region);

    let count = 0;
    paging: for await (const page of paginateDescribeDirectories({ client }, {})) {
      for (const d of page.DirectoryDescriptions ?? []) {
        if (!d.DirectoryId) continue;
        if (count >= MAX_DIRECTORIES) {
          out.errors.push({
            service: 'directory-service',
            operation: 'DescribeDirectories truncated',
            message: `stopped after ${MAX_DIRECTORIES} directories; results for this region are incomplete`,
          });
          break paging;
        }
        count++;

        // Simple/Microsoft AD carry VpcSettings; AD Connector carries
        // ConnectSettings (same placement shape). SharedMicrosoftAD carries
        // neither — the directory lives in the OWNER account's VPC, so its
        // placement fields stay empty here rather than pointing at a VPC
        // this snapshot doesn't own.
        const vpc = d.VpcSettings ?? d.ConnectSettings;
        out.directoryServiceDirectories.push({
          id: d.DirectoryId,
          arn: `arn:aws:ds:${region}:${accountId}:directory/${d.DirectoryId}`,
          name: d.Name,
          tags: {},
          shortName: d.ShortName,
          type: d.Type ?? 'UNKNOWN',
          edition: d.Edition,
          size: d.Size,
          stage: d.Stage,
          alias: d.Alias,
          dnsIps: d.DnsIpAddrs ?? [],
          vpcId: vpc?.VpcId,
          subnetIds: vpc?.SubnetIds ?? [],
          securityGroupId: vpc?.SecurityGroupId,
        });
      }
    }
  });
}
