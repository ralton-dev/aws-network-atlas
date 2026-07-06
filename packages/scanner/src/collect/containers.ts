import {
  ECSClient,
  paginateListClusters,
  paginateListServices,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import { EKSClient, paginateListClusters as paginateListEksClusters, DescribeClusterCommand } from '@aws-sdk/client-eks';
import type { RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** ECS services (awsvpc placement) and EKS clusters. */
export async function collectContainers(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const errors = out.errors;

  await guard(errors, 'ecs', 'ListClusters', async () => {
    const ecs = ctx.client(ECSClient, region);
    const clusterArns: string[] = [];
    for await (const page of paginateListClusters({ client: ecs }, {})) {
      clusterArns.push(...(page.clusterArns ?? []));
    }
    for (const clusterArn of clusterArns) {
      await guard(errors, 'ecs', `ListServices(${clusterArn.split('/').pop()})`, async () => {
        const serviceArns: string[] = [];
        for await (const page of paginateListServices({ client: ecs }, { cluster: clusterArn })) {
          serviceArns.push(...(page.serviceArns ?? []));
        }
        // DescribeServices accepts at most 10 services per call.
        for (let i = 0; i < serviceArns.length; i += 10) {
          const res = await ecs.send(
            new DescribeServicesCommand({
              cluster: clusterArn,
              services: serviceArns.slice(i, i + 10),
              include: ['TAGS'],
            }),
          );
          for (const s of res.services ?? []) {
            const tags: Tags = {};
            for (const t of s.tags ?? []) {
              if (t.key) tags[t.key] = t.value ?? '';
            }
            const awsvpc = s.networkConfiguration?.awsvpcConfiguration;
            out.ecsServices.push({
              id: s.serviceArn!,
              arn: s.serviceArn,
              name: s.serviceName,
              tags,
              clusterArn,
              clusterName: clusterArn.split('/').pop(),
              launchType: s.launchType ?? s.capacityProviderStrategy?.[0]?.capacityProvider,
              desiredCount: s.desiredCount,
              runningCount: s.runningCount,
              subnetIds: awsvpc?.subnets ?? [],
              securityGroupIds: awsvpc?.securityGroups ?? [],
              assignPublicIp: awsvpc ? awsvpc.assignPublicIp === 'ENABLED' : undefined,
            });
          }
        }
      });
    }
  });

  await guard(errors, 'eks', 'ListClusters', async () => {
    const eks = ctx.client(EKSClient, region);
    const names: string[] = [];
    for await (const page of paginateListEksClusters({ client: eks }, {})) {
      names.push(...(page.clusters ?? []));
    }
    for (const name of names) {
      await guard(errors, 'eks', `DescribeCluster(${name})`, async () => {
        const res = await eks.send(new DescribeClusterCommand({ name }));
        const c = res.cluster;
        if (!c) return;
        const vpc = c.resourcesVpcConfig;
        out.eksClusters.push({
          id: c.arn ?? name,
          arn: c.arn,
          name: c.name,
          tags: c.tags ?? {},
          version: c.version,
          endpoint: c.endpoint,
          vpcId: vpc?.vpcId,
          subnetIds: vpc?.subnetIds ?? [],
          securityGroupIds: [
            ...(vpc?.securityGroupIds ?? []),
            ...(vpc?.clusterSecurityGroupId ? [vpc.clusterSecurityGroupId] : []),
          ],
          endpointPublicAccess: vpc?.endpointPublicAccess,
          endpointPrivateAccess: vpc?.endpointPrivateAccess,
        });
      });
    }
  });
}
