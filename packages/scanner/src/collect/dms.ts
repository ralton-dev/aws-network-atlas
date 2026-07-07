// DMS (Database Migration Service) — READ-ONLY (Describe* only).
// Replication instances are VPC-ATTACHED (subnet group + security groups) —
// the ENIs DMS creates in the VPC are otherwise anonymous. Endpoints carry the
// source/target database coordinates; replication tasks wire source endpoint →
// instance → target endpoint, which is the migration data flow.
// Each resource type gets its own guard() block so a single permission gap
// doesn't lose the others.
import {
  DatabaseMigrationServiceClient,
  paginateDescribeEndpoints,
  paginateDescribeReplicationInstances,
  paginateDescribeReplicationTasks,
} from '@aws-sdk/client-database-migration-service';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectDms(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(DatabaseMigrationServiceClient, region);

  await guard(out.errors, 'dms', 'DescribeReplicationInstances', async () => {
    for await (const page of paginateDescribeReplicationInstances({ client }, {})) {
      for (const ri of page.ReplicationInstances ?? []) {
        const id = ri.ReplicationInstanceIdentifier;
        if (!id) continue;
        const subnetGroup = ri.ReplicationSubnetGroup;
        out.dmsReplicationInstances.push({
          id,
          arn: ri.ReplicationInstanceArn,
          name: id,
          // Tags need a separate ListTagsForResource per ARN — skipped.
          tags: {},
          replicationInstanceClass: ri.ReplicationInstanceClass,
          engineVersion: ri.EngineVersion,
          status: ri.ReplicationInstanceStatus,
          vpcId: subnetGroup?.VpcId,
          subnetGroupId: subnetGroup?.ReplicationSubnetGroupIdentifier,
          subnetIds: (subnetGroup?.Subnets ?? [])
            .map((s) => s.SubnetIdentifier)
            .filter((s): s is string => !!s),
          securityGroupIds: (ri.VpcSecurityGroups ?? [])
            .map((sg) => sg.VpcSecurityGroupId)
            .filter((sg): sg is string => !!sg),
          publiclyAccessible: ri.PubliclyAccessible,
          multiAz: ri.MultiAZ,
          kmsKeyId: ri.KmsKeyId,
          privateIps: (ri.ReplicationInstancePrivateIpAddresses ?? []).filter(
            (ip): ip is string => !!ip,
          ),
          publicIps: (ri.ReplicationInstancePublicIpAddresses ?? []).filter(
            (ip): ip is string => !!ip,
          ),
        });
      }
    }
  });

  await guard(out.errors, 'dms', 'DescribeEndpoints', async () => {
    for await (const page of paginateDescribeEndpoints({ client }, {})) {
      for (const ep of page.Endpoints ?? []) {
        const id = ep.EndpointIdentifier;
        if (!id) continue;
        out.dmsEndpoints.push({
          id,
          arn: ep.EndpointArn,
          name: id,
          tags: {},
          endpointType: ep.EndpointType,
          engineName: ep.EngineName,
          serverName: ep.ServerName,
          port: ep.Port,
          sslMode: ep.SslMode,
          kmsKeyId: ep.KmsKeyId,
        });
      }
    }
  });

  await guard(out.errors, 'dms', 'DescribeReplicationTasks', async () => {
    for await (const page of paginateDescribeReplicationTasks({ client }, {})) {
      for (const task of page.ReplicationTasks ?? []) {
        const id = task.ReplicationTaskIdentifier;
        if (!id) continue;
        out.dmsReplicationTasks.push({
          id,
          arn: task.ReplicationTaskArn,
          name: id,
          tags: {},
          status: task.Status,
          migrationType: task.MigrationType,
          sourceEndpointArn: task.SourceEndpointArn,
          targetEndpointArn: task.TargetEndpointArn,
          replicationInstanceArn: task.ReplicationInstanceArn,
        });
      }
    }
  });
}
