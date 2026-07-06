import {
  RDSClient,
  paginateDescribeDBInstances,
  paginateDescribeDBClusters,
  paginateDescribeDBSubnetGroups,
} from '@aws-sdk/client-rds';
import {
  ElastiCacheClient,
  paginateDescribeCacheClusters,
  paginateDescribeCacheSubnetGroups,
} from '@aws-sdk/client-elasticache';
import type { RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

function rdsTags(list?: Array<{ Key?: string; Value?: string }>): Tags {
  const tags: Tags = {};
  for (const t of list ?? []) {
    if (t.Key) tags[t.Key] = t.Value ?? '';
  }
  return tags;
}

/** RDS instances/clusters and ElastiCache clusters, resolved to subnets/VPCs. */
export async function collectDataStores(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const errors = out.errors;
  const rds = ctx.client(RDSClient, region);

  // Subnet-group name -> { vpcId, subnetIds } for resolving cluster placement.
  const rdsSubnetGroups = new Map<string, { vpcId?: string; subnetIds: string[] }>();
  await guard(errors, 'rds', 'DescribeDBSubnetGroups', async () => {
    for await (const page of paginateDescribeDBSubnetGroups({ client: rds }, {})) {
      for (const g of page.DBSubnetGroups ?? []) {
        if (!g.DBSubnetGroupName) continue;
        rdsSubnetGroups.set(g.DBSubnetGroupName, {
          vpcId: g.VpcId,
          subnetIds: (g.Subnets ?? [])
            .map((s) => s.SubnetIdentifier)
            .filter((s): s is string => !!s),
        });
      }
    }
  });

  await guard(errors, 'rds', 'DescribeDBInstances', async () => {
    for await (const page of paginateDescribeDBInstances({ client: rds }, {})) {
      for (const db of page.DBInstances ?? []) {
        const group = db.DBSubnetGroup;
        out.rdsInstances.push({
          id: db.DBInstanceIdentifier!,
          arn: db.DBInstanceArn,
          name: db.DBInstanceIdentifier,
          tags: rdsTags(db.TagList),
          engine: db.Engine,
          engineVersion: db.EngineVersion,
          instanceClass: db.DBInstanceClass,
          clusterId: db.DBClusterIdentifier,
          vpcId: group?.VpcId,
          subnetGroupName: group?.DBSubnetGroupName,
          subnetIds: (group?.Subnets ?? [])
            .map((s) => s.SubnetIdentifier)
            .filter((s): s is string => !!s),
          securityGroupIds: (db.VpcSecurityGroups ?? [])
            .map((g) => g.VpcSecurityGroupId)
            .filter((g): g is string => !!g),
          endpoint: db.Endpoint
            ? { address: db.Endpoint.Address, port: db.Endpoint.Port }
            : undefined,
          multiAz: db.MultiAZ,
          publiclyAccessible: db.PubliclyAccessible,
          availabilityZone: db.AvailabilityZone,
        });
      }
    }
  });

  await guard(errors, 'rds', 'DescribeDBClusters', async () => {
    for await (const page of paginateDescribeDBClusters({ client: rds }, {})) {
      for (const c of page.DBClusters ?? []) {
        const group = c.DBSubnetGroup ? rdsSubnetGroups.get(c.DBSubnetGroup) : undefined;
        out.rdsClusters.push({
          id: c.DBClusterIdentifier!,
          arn: c.DBClusterArn,
          name: c.DBClusterIdentifier,
          tags: rdsTags(c.TagList),
          engine: c.Engine,
          engineVersion: c.EngineVersion,
          memberInstanceIds: (c.DBClusterMembers ?? [])
            .map((m) => m.DBInstanceIdentifier)
            .filter((m): m is string => !!m),
          vpcId: group?.vpcId,
          subnetGroupName: c.DBSubnetGroup,
          subnetIds: group?.subnetIds ?? [],
          securityGroupIds: (c.VpcSecurityGroups ?? [])
            .map((g) => g.VpcSecurityGroupId)
            .filter((g): g is string => !!g),
          endpoint: c.Endpoint,
          readerEndpoint: c.ReaderEndpoint,
          multiAz: c.MultiAZ,
        });
      }
    }
  });

  const elasticache = ctx.client(ElastiCacheClient, region);
  const cacheSubnetGroups = new Map<string, { vpcId?: string; subnetIds: string[] }>();
  await guard(errors, 'elasticache', 'DescribeCacheSubnetGroups', async () => {
    for await (const page of paginateDescribeCacheSubnetGroups({ client: elasticache }, {})) {
      for (const g of page.CacheSubnetGroups ?? []) {
        if (!g.CacheSubnetGroupName) continue;
        cacheSubnetGroups.set(g.CacheSubnetGroupName, {
          vpcId: g.VpcId,
          subnetIds: (g.Subnets ?? [])
            .map((s) => s.SubnetIdentifier)
            .filter((s): s is string => !!s),
        });
      }
    }
  });

  await guard(errors, 'elasticache', 'DescribeCacheClusters', async () => {
    for await (const page of paginateDescribeCacheClusters({ client: elasticache }, {})) {
      for (const c of page.CacheClusters ?? []) {
        const group = c.CacheSubnetGroupName
          ? cacheSubnetGroups.get(c.CacheSubnetGroupName)
          : undefined;
        out.elastiCacheClusters.push({
          id: c.CacheClusterId!,
          arn: c.ARN,
          name: c.CacheClusterId,
          tags: {},
          engine: c.Engine,
          nodeType: c.CacheNodeType,
          numNodes: c.NumCacheNodes,
          vpcId: group?.vpcId,
          subnetGroupName: c.CacheSubnetGroupName,
          subnetIds: group?.subnetIds ?? [],
          securityGroupIds: (c.SecurityGroups ?? [])
            .map((g) => g.SecurityGroupId)
            .filter((g): g is string => !!g),
        });
      }
    }
  });
}
