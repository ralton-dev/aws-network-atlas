// Neptune + DocumentDB — READ-ONLY (Describe* only).
// Both are RDS-style cluster services and VPC-ATTACHED: the cluster carries
// its VPC security groups directly, and its subnet group name resolves to a
// VPC + subnet list via DescribeDBSubnetGroups — the network posture the tag
// sweep can't see — plus endpoints, engine version, encryption, and members.
//
// CAUTION: Neptune's DescribeDBClusters is backed by the shared RDS control
// plane and returns clusters of ALL engines, so we filter to Engine ===
// 'neptune'. DocumentDB honors the engine filter server-side, but we still
// double-check Engine === 'docdb'.
import {
  NeptuneClient,
  paginateDescribeDBClusters as paginateNeptuneClusters,
  paginateDescribeDBSubnetGroups as paginateNeptuneSubnetGroups,
} from '@aws-sdk/client-neptune';
import {
  DocDBClient,
  paginateDescribeDBClusters as paginateDocDbClusters,
  paginateDescribeDBSubnetGroups as paginateDocDbSubnetGroups,
} from '@aws-sdk/client-docdb';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectNeptune(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'neptune', 'DescribeDBClusters', async () => {
    const client = ctx.client(NeptuneClient, region);

    // Subnet-group name -> { vpcId, subnetIds } for resolving cluster placement.
    const subnetGroups = new Map<string, { vpcId?: string; subnetIds: string[] }>();
    for await (const page of paginateNeptuneSubnetGroups({ client }, {})) {
      for (const g of page.DBSubnetGroups ?? []) {
        if (!g.DBSubnetGroupName) continue;
        subnetGroups.set(g.DBSubnetGroupName, {
          vpcId: g.VpcId,
          subnetIds: (g.Subnets ?? [])
            .map((s) => s.SubnetIdentifier)
            .filter((s): s is string => !!s),
        });
      }
    }

    for await (const page of paginateNeptuneClusters({ client }, {})) {
      for (const c of page.DBClusters ?? []) {
        // The shared DB pool returns clusters of every engine here.
        if (c.Engine !== 'neptune') continue;
        if (!c.DBClusterIdentifier) continue;
        const group = c.DBSubnetGroup ? subnetGroups.get(c.DBSubnetGroup) : undefined;
        out.neptuneClusters.push({
          id: c.DBClusterIdentifier,
          arn: c.DBClusterArn,
          name: c.DBClusterIdentifier,
          // Tags need a per-cluster ListTagsForResource — skipped; the
          // detailed key/value sweep already covers tagged clusters.
          tags: {},
          status: c.Status,
          engineVersion: c.EngineVersion,
          endpoint: c.Endpoint,
          readerEndpoint: c.ReaderEndpoint,
          port: c.Port,
          subnetGroupName: c.DBSubnetGroup,
          vpcId: group?.vpcId,
          subnetIds: group?.subnetIds ?? [],
          securityGroupIds: (c.VpcSecurityGroups ?? [])
            .map((g) => g.VpcSecurityGroupId)
            .filter((g): g is string => !!g),
          storageEncrypted: c.StorageEncrypted,
          kmsKeyId: c.KmsKeyId,
          multiAz: c.MultiAZ,
          memberInstanceIds: (c.DBClusterMembers ?? [])
            .map((m) => m.DBInstanceIdentifier)
            .filter((m): m is string => !!m),
        });
      }
    }
  });
}

export async function collectDocDb(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'docdb', 'DescribeDBClusters', async () => {
    const client = ctx.client(DocDBClient, region);

    // Subnet-group name -> { vpcId, subnetIds } for resolving cluster placement.
    const subnetGroups = new Map<string, { vpcId?: string; subnetIds: string[] }>();
    for await (const page of paginateDocDbSubnetGroups({ client }, {})) {
      for (const g of page.DBSubnetGroups ?? []) {
        if (!g.DBSubnetGroupName) continue;
        subnetGroups.set(g.DBSubnetGroupName, {
          vpcId: g.VpcId,
          subnetIds: (g.Subnets ?? [])
            .map((s) => s.SubnetIdentifier)
            .filter((s): s is string => !!s),
        });
      }
    }

    // DocumentDB honors the server-side engine filter; keep the client-side
    // Engine check as a belt-and-braces guard against shared-pool leakage.
    for await (const page of paginateDocDbClusters(
      { client },
      { Filters: [{ Name: 'engine', Values: ['docdb'] }] },
    )) {
      for (const c of page.DBClusters ?? []) {
        if (c.Engine !== 'docdb') continue;
        if (!c.DBClusterIdentifier) continue;
        const group = c.DBSubnetGroup ? subnetGroups.get(c.DBSubnetGroup) : undefined;
        out.docDbClusters.push({
          id: c.DBClusterIdentifier,
          arn: c.DBClusterArn,
          name: c.DBClusterIdentifier,
          tags: {},
          status: c.Status,
          engineVersion: c.EngineVersion,
          endpoint: c.Endpoint,
          readerEndpoint: c.ReaderEndpoint,
          port: c.Port,
          subnetGroupName: c.DBSubnetGroup,
          vpcId: group?.vpcId,
          subnetIds: group?.subnetIds ?? [],
          securityGroupIds: (c.VpcSecurityGroups ?? [])
            .map((g) => g.VpcSecurityGroupId)
            .filter((g): g is string => !!g),
          storageEncrypted: c.StorageEncrypted,
          kmsKeyId: c.KmsKeyId,
          multiAz: c.MultiAZ,
          memberInstanceIds: (c.DBClusterMembers ?? [])
            .map((m) => m.DBInstanceIdentifier)
            .filter((m): m is string => !!m),
        });
      }
    }
  });
}
