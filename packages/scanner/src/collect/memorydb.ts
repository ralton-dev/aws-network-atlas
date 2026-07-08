// MemoryDB — READ-ONLY (Describe* only).
// Clusters are VPC-ONLY (private by design — there is no PubliclyAccessible
// field): the cluster carries its VPC security groups directly, and its
// subnet group name resolves to a VPC + subnet list via DescribeSubnetGroups
// — the network posture the tag sweep can't see — plus endpoint, node type,
// shard count, TLS, and KMS encryption.
import {
  MemoryDBClient,
  paginateDescribeClusters,
  paginateDescribeSubnetGroups,
} from '@aws-sdk/client-memorydb';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectMemoryDb(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'memorydb', 'DescribeClusters', async () => {
    const client = ctx.client(MemoryDBClient, region);

    // Subnet-group name -> { vpcId, subnetIds } for resolving cluster placement.
    const subnetGroups = new Map<string, { vpcId?: string; subnetIds: string[] }>();
    for await (const page of paginateDescribeSubnetGroups({ client }, {})) {
      for (const g of page.SubnetGroups ?? []) {
        if (!g.Name) continue;
        subnetGroups.set(g.Name, {
          vpcId: g.VpcId,
          subnetIds: (g.Subnets ?? [])
            .map((s) => s.Identifier)
            .filter((s): s is string => !!s),
        });
      }
    }

    for await (const page of paginateDescribeClusters({ client }, {})) {
      for (const c of page.Clusters ?? []) {
        if (!c.Name) continue;
        const group = c.SubnetGroupName ? subnetGroups.get(c.SubnetGroupName) : undefined;
        out.memoryDbClusters.push({
          id: c.Name,
          arn: c.ARN,
          name: c.Name,
          // Tags need a per-cluster ListTags call — skipped; the detailed
          // key/value sweep already covers tagged clusters.
          tags: {},
          status: c.Status,
          nodeType: c.NodeType,
          engineVersion: c.EngineVersion,
          numberOfShards: c.NumberOfShards,
          tlsEnabled: c.TLSEnabled,
          kmsKeyId: c.KmsKeyId,
          endpoint: c.ClusterEndpoint?.Address,
          port: c.ClusterEndpoint?.Port,
          subnetGroupName: c.SubnetGroupName,
          vpcId: group?.vpcId,
          subnetIds: group?.subnetIds ?? [],
          securityGroupIds: (c.SecurityGroups ?? [])
            .map((s) => s.SecurityGroupId)
            .filter((s): s is string => !!s),
        });
      }
    }
  });
}
