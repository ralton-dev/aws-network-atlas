// VPC-attached data/messaging services that previously showed up only as
// anonymous ENIs: EFS, OpenSearch, MSK, Redshift, Amazon MQ.
// READ-ONLY (List*/Describe* only).
import {
  EFSClient,
  paginateDescribeFileSystems,
  paginateDescribeMountTargets,
  DescribeMountTargetSecurityGroupsCommand,
} from '@aws-sdk/client-efs';
import {
  OpenSearchClient,
  ListDomainNamesCommand,
  DescribeDomainsCommand,
} from '@aws-sdk/client-opensearch';
import { KafkaClient, paginateListClustersV2 } from '@aws-sdk/client-kafka';
import { RedshiftClient, paginateDescribeClusters } from '@aws-sdk/client-redshift';
import { MqClient, paginateListBrokers, DescribeBrokerCommand } from '@aws-sdk/client-mq';
import pLimit from 'p-limit';
import type { RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

function kvTags(list?: Array<{ Key?: string; Value?: string }>): Tags {
  const tags: Tags = {};
  for (const t of list ?? []) {
    if (t.Key) tags[t.Key] = t.Value ?? '';
  }
  return tags;
}

export async function collectVpcWorkloads(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const errors = out.errors;
  const limit = pLimit(4);

  // --- EFS -------------------------------------------------------------------
  await guard(errors, 'efs', 'DescribeFileSystems', async () => {
    const efs = ctx.client(EFSClient, region);
    const fileSystems: RegionSnapshot['efsFileSystems'] = [];
    for await (const page of paginateDescribeFileSystems({ client: efs }, {})) {
      for (const fs of page.FileSystems ?? []) {
        if (!fs.FileSystemId) continue;
        fileSystems.push({
          id: fs.FileSystemId,
          arn: fs.FileSystemArn,
          name: fs.Name,
          tags: kvTags(fs.Tags),
          state: fs.LifeCycleState,
          encrypted: fs.Encrypted,
          performanceMode: fs.PerformanceMode,
          mountTargets: [],
        });
      }
    }
    await Promise.all(
      fileSystems.map((fs) =>
        limit(() =>
          guard(errors, 'efs', `DescribeMountTargets(${fs.id})`, async () => {
            for await (const page of paginateDescribeMountTargets(
              { client: efs },
              { FileSystemId: fs.id },
            )) {
              for (const mt of page.MountTargets ?? []) {
                if (!mt.MountTargetId) continue;
                let securityGroupIds: string[] = [];
                await guard(
                  errors,
                  'efs',
                  `DescribeMountTargetSecurityGroups(${mt.MountTargetId})`,
                  async () => {
                    const sgRes = await efs.send(
                      new DescribeMountTargetSecurityGroupsCommand({
                        MountTargetId: mt.MountTargetId!,
                      }),
                    );
                    securityGroupIds = (sgRes.SecurityGroups ?? []).sort();
                  },
                );
                fs.vpcId ??= mt.VpcId;
                fs.mountTargets.push({
                  id: mt.MountTargetId,
                  subnetId: mt.SubnetId,
                  ipAddress: mt.IpAddress,
                  availabilityZone: mt.AvailabilityZoneName,
                  securityGroupIds,
                });
              }
            }
            fs.mountTargets.sort((a, b) => a.id.localeCompare(b.id));
          }),
        ),
      ),
    );
    out.efsFileSystems.push(...fileSystems);
  });

  // --- OpenSearch --------------------------------------------------------------
  await guard(errors, 'opensearch', 'ListDomainNames', async () => {
    const os = ctx.client(OpenSearchClient, region);
    const names = ((await os.send(new ListDomainNamesCommand({}))).DomainNames ?? [])
      .map((d) => d.DomainName)
      .filter((n): n is string => !!n);
    // DescribeDomains accepts at most 5 domains per call.
    for (let i = 0; i < names.length; i += 5) {
      await guard(errors, 'opensearch', `DescribeDomains(${names.slice(i, i + 5).join(',')})`, async () => {
        const res = await os.send(
          new DescribeDomainsCommand({ DomainNames: names.slice(i, i + 5) }),
        );
        for (const d of res.DomainStatusList ?? []) {
          if (!d.DomainName) continue;
          const vpc = d.VPCOptions;
          out.openSearchDomains.push({
            id: d.DomainName,
            arn: d.ARN,
            name: d.DomainName,
            tags: {},
            engineVersion: d.EngineVersion,
            endpoint: d.Endpoint ?? Object.values(d.Endpoints ?? {})[0],
            inVpc: !!vpc?.VPCId,
            vpcId: vpc?.VPCId,
            subnetIds: vpc?.SubnetIds ?? [],
            securityGroupIds: vpc?.SecurityGroupIds ?? [],
          });
        }
      });
    }
  });

  // --- MSK ---------------------------------------------------------------------
  await guard(errors, 'kafka', 'ListClustersV2', async () => {
    const kafka = ctx.client(KafkaClient, region);
    for await (const page of paginateListClustersV2({ client: kafka }, {})) {
      for (const c of page.ClusterInfoList ?? []) {
        if (!c.ClusterArn) continue;
        const provisioned = c.Provisioned;
        const serverlessVpc = c.Serverless?.VpcConfigs?.[0];
        out.mskClusters.push({
          id: c.ClusterArn,
          arn: c.ClusterArn,
          name: c.ClusterName,
          tags: c.Tags ?? {},
          clusterType: c.ClusterType,
          state: c.State,
          kafkaVersion: provisioned?.CurrentBrokerSoftwareInfo?.KafkaVersion,
          numberOfBrokerNodes: provisioned?.NumberOfBrokerNodes,
          subnetIds:
            provisioned?.BrokerNodeGroupInfo?.ClientSubnets ?? serverlessVpc?.SubnetIds ?? [],
          securityGroupIds:
            provisioned?.BrokerNodeGroupInfo?.SecurityGroups ?? serverlessVpc?.SecurityGroupIds ?? [],
        });
      }
    }
  });

  // --- Redshift ------------------------------------------------------------------
  await guard(errors, 'redshift', 'DescribeClusters', async () => {
    const redshift = ctx.client(RedshiftClient, region);
    for await (const page of paginateDescribeClusters({ client: redshift }, {})) {
      for (const c of page.Clusters ?? []) {
        if (!c.ClusterIdentifier) continue;
        out.redshiftClusters.push({
          id: c.ClusterIdentifier,
          name: c.ClusterIdentifier,
          tags: kvTags(c.Tags),
          nodeType: c.NodeType,
          numberOfNodes: c.NumberOfNodes,
          state: c.ClusterStatus,
          vpcId: c.VpcId,
          subnetGroupName: c.ClusterSubnetGroupName,
          subnetIds: [],
          securityGroupIds: (c.VpcSecurityGroups ?? [])
            .map((g) => g.VpcSecurityGroupId)
            .filter((g): g is string => !!g),
          publiclyAccessible: c.PubliclyAccessible,
          endpoint: c.Endpoint
            ? { address: c.Endpoint.Address, port: c.Endpoint.Port }
            : undefined,
          availabilityZone: c.AvailabilityZone,
        });
      }
    }
  });

  // --- Amazon MQ -------------------------------------------------------------------
  await guard(errors, 'mq', 'ListBrokers', async () => {
    const mq = ctx.client(MqClient, region);
    const brokerIds: string[] = [];
    for await (const page of paginateListBrokers({ client: mq }, {})) {
      for (const b of page.BrokerSummaries ?? []) {
        if (b.BrokerId) brokerIds.push(b.BrokerId);
      }
    }
    await Promise.all(
      brokerIds.map((brokerId) =>
        limit(() =>
          guard(errors, 'mq', `DescribeBroker(${brokerId})`, async () => {
            const b = await mq.send(new DescribeBrokerCommand({ BrokerId: brokerId }));
            out.mqBrokers.push({
              id: b.BrokerId ?? brokerId,
              arn: b.BrokerArn,
              name: b.BrokerName,
              tags: b.Tags ?? {},
              engineType: b.EngineType as string | undefined,
              deploymentMode: b.DeploymentMode,
              state: b.BrokerState,
              publiclyAccessible: b.PubliclyAccessible,
              subnetIds: b.SubnetIds ?? [],
              securityGroupIds: b.SecurityGroups ?? [],
            });
          }),
        ),
      ),
    );
  });
}
