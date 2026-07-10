import {
  ECSClient,
  paginateListClusters,
  paginateListServices,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import {
  EKSClient,
  paginateListClusters as paginateListEksClusters,
  DescribeClusterCommand,
  paginateListAccessEntries,
  DescribeAccessEntryCommand,
  paginateListAssociatedAccessPolicies,
  paginateListPodIdentityAssociations,
  DescribePodIdentityAssociationCommand,
  paginateListIdentityProviderConfigs,
  DescribeIdentityProviderConfigCommand,
} from '@aws-sdk/client-eks';
import pLimit from 'p-limit';
import type { EksCluster, RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Per-cluster caps on the EKS access surface (declutter + API-cost bound). */
const MAX_ACCESS_ENTRIES_PER_CLUSTER = 100;
const MAX_POD_IDENTITY_ASSOCIATIONS_PER_CLUSTER = 100;
const MAX_IDENTITY_PROVIDER_CONFIGS_PER_CLUSTER = 20;
/** Concurrent clusters fanned out to for the access-surface calls. */
const EKS_CLUSTER_CONCURRENCY = 4;

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
    const clusters: Array<{ name: string; cluster: EksCluster }> = [];
    for (const name of names) {
      await guard(errors, 'eks', `DescribeCluster(${name})`, async () => {
        const res = await eks.send(new DescribeClusterCommand({ name }));
        const c = res.cluster;
        if (!c) return;
        const vpc = c.resourcesVpcConfig;
        const cluster: EksCluster = {
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
        };
        out.eksClusters.push(cluster);
        clusters.push({ name, cluster });
      });
    }

    // IAM → Kubernetes access surface, fanned out per cluster. Each cluster's
    // three call families are guarded independently so one failing cluster
    // (or one missing permission) doesn't sink the rest.
    const limit = pLimit(EKS_CLUSTER_CONCURRENCY);
    await Promise.all(
      clusters.map(({ name, cluster }) =>
        limit(async () => {
          await guard(errors, 'eks', `ListAccessEntries(${name})`, async () => {
            const principalArns: string[] = [];
            paging: for await (const page of paginateListAccessEntries({ client: eks }, { clusterName: name })) {
              for (const arn of page.accessEntries ?? []) {
                if (principalArns.length >= MAX_ACCESS_ENTRIES_PER_CLUSTER) break paging;
                principalArns.push(arn);
              }
            }
            const entries: NonNullable<EksCluster['accessEntries']> = [];
            for (const principalArn of principalArns) {
              const res = await eks.send(new DescribeAccessEntryCommand({ clusterName: name, principalArn }));
              const entry = res.accessEntry;
              const accessPolicies: NonNullable<NonNullable<EksCluster['accessEntries']>[number]['accessPolicies']> = [];
              for await (const page of paginateListAssociatedAccessPolicies(
                { client: eks },
                { clusterName: name, principalArn },
              )) {
                for (const p of page.associatedAccessPolicies ?? []) {
                  if (!p.policyArn) continue;
                  accessPolicies.push({
                    policyArn: p.policyArn,
                    scopeType: p.accessScope?.type,
                    namespaces: p.accessScope?.namespaces?.length ? p.accessScope.namespaces : undefined,
                  });
                }
              }
              entries.push({
                principalArn,
                type: entry?.type,
                kubernetesGroups: entry?.kubernetesGroups?.length ? entry.kubernetesGroups : undefined,
                username: entry?.username,
                accessPolicies: accessPolicies.length > 0 ? accessPolicies : undefined,
              });
            }
            if (entries.length > 0) cluster.accessEntries = entries;
          });

          await guard(errors, 'eks', `ListPodIdentityAssociations(${name})`, async () => {
            const summaries: Array<{ namespace: string; serviceAccount: string; associationId?: string; associationArn?: string }> = [];
            paging: for await (const page of paginateListPodIdentityAssociations({ client: eks }, { clusterName: name })) {
              for (const a of page.associations ?? []) {
                if (summaries.length >= MAX_POD_IDENTITY_ASSOCIATIONS_PER_CLUSTER) break paging;
                summaries.push({
                  namespace: a.namespace ?? '',
                  serviceAccount: a.serviceAccount ?? '',
                  associationId: a.associationId,
                  associationArn: a.associationArn,
                });
              }
            }
            const associations: NonNullable<EksCluster['podIdentityAssociations']> = [];
            for (const s of summaries) {
              // The roleArn only surfaces on Describe.
              let roleArn: string | undefined;
              if (s.associationId) {
                const res = await eks.send(
                  new DescribePodIdentityAssociationCommand({ clusterName: name, associationId: s.associationId }),
                );
                roleArn = res.association?.roleArn;
              }
              associations.push({
                namespace: s.namespace,
                serviceAccount: s.serviceAccount,
                roleArn,
                associationArn: s.associationArn,
              });
            }
            if (associations.length > 0) cluster.podIdentityAssociations = associations;
          });

          await guard(errors, 'eks', `ListIdentityProviderConfigs(${name})`, async () => {
            const refs: Array<{ name: string; type: string }> = [];
            paging: for await (const page of paginateListIdentityProviderConfigs({ client: eks }, { clusterName: name })) {
              for (const c of page.identityProviderConfigs ?? []) {
                if (refs.length >= MAX_IDENTITY_PROVIDER_CONFIGS_PER_CLUSTER) break paging;
                if (c.name && c.type) refs.push({ name: c.name, type: c.type });
              }
            }
            const configs: NonNullable<EksCluster['identityProviderConfigs']> = [];
            for (const ref of refs) {
              const res = await eks.send(
                new DescribeIdentityProviderConfigCommand({ clusterName: name, identityProviderConfig: ref }),
              );
              const oidc = res.identityProviderConfig?.oidc;
              configs.push({
                name: ref.name,
                type: ref.type,
                issuerUrl: oidc?.issuerUrl,
                clientId: oidc?.clientId,
              });
            }
            if (configs.length > 0) cluster.identityProviderConfigs = configs;
          });
        }),
      ),
    );
  });
}
