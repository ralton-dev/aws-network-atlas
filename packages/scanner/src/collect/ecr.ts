// ECR — READ-ONLY (Describe*/Get* only).
// Registry-level config (replication rules, registry policy, pull-through
// cache, scanning configuration) governs cross-region/account image flow;
// per-repository detail (resource policy, lifecycle policy, encryption,
// scan-on-push) carries the posture the tag sweep can't see.
import {
  ECRClient,
  DescribeRegistryCommand,
  GetLifecyclePolicyCommand,
  GetRegistryPolicyCommand,
  GetRegistryScanningConfigurationCommand,
  GetRepositoryPolicyCommand,
  paginateDescribePullThroughCacheRules,
  paginateDescribeRepositories,
} from '@aws-sdk/client-ecr';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectEcr(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  // Two independent guard blocks — a permission failure on the registry-level
  // calls must not lose the repositories, and vice versa.
  await guard(out.errors, 'ecr', 'DescribeRegistry', async () => {
    const client = ctx.client(ECRClient, region);
    const registry = await client.send(new DescribeRegistryCommand({}));
    if (!registry.registryId) return;

    // GetRegistryPolicy throws RegistryPolicyNotFoundException when no policy
    // exists — treat that (and missing permission) as undefined so the rest
    // of the registry detail still lands.
    let registryPolicy: string | undefined;
    try {
      const policy = await client.send(new GetRegistryPolicyCommand({}));
      registryPolicy = policy.policyText;
    } catch {
      registryPolicy = undefined;
    }

    const pullThroughCacheRules: RegionSnapshot['ecrRegistries'][number]['pullThroughCacheRules'] = [];
    try {
      for await (const page of paginateDescribePullThroughCacheRules({ client }, {})) {
        for (const rule of page.pullThroughCacheRules ?? []) {
          pullThroughCacheRules.push({
            ecrRepositoryPrefix: rule.ecrRepositoryPrefix,
            upstreamRegistryUrl: rule.upstreamRegistryUrl,
          });
        }
      }
    } catch {
      // Missing ecr:DescribePullThroughCacheRules — keep the rest.
    }

    let scanningConfiguration: string | undefined;
    try {
      const scanning = await client.send(new GetRegistryScanningConfigurationCommand({}));
      const cfg = scanning.scanningConfiguration;
      if (cfg?.scanType) {
        const ruleCount = cfg.rules?.length ?? 0;
        scanningConfiguration = `${cfg.scanType} (${ruleCount} rule${ruleCount === 1 ? '' : 's'})`;
      }
    } catch {
      // Missing ecr:GetRegistryScanningConfiguration — keep the rest.
    }

    out.ecrRegistries.push({
      id: registry.registryId,
      tags: {},
      replicationRules: (registry.replicationConfiguration?.rules ?? []).map((rule) => ({
        destinations: (rule.destinations ?? []).map((d) => ({
          region: d.region,
          registryId: d.registryId,
        })),
        repositoryFilters: (rule.repositoryFilters ?? [])
          .map((f) => f.filter)
          .filter((f): f is string => !!f),
      })),
      registryPolicy,
      pullThroughCacheRules,
      scanningConfiguration,
    });
  });

  await guard(out.errors, 'ecr', 'DescribeRepositories', async () => {
    const client = ctx.client(ECRClient, region);
    for await (const page of paginateDescribeRepositories({ client }, {})) {
      for (const repo of page.repositories ?? []) {
        if (!repo.repositoryName) continue;
        const repositoryName = repo.repositoryName;

        // GetRepositoryPolicy / GetLifecyclePolicy throw *NotFoundException
        // when unset — swallow each independently and record undefined.
        let repositoryPolicy: string | undefined;
        try {
          const policy = await client.send(
            new GetRepositoryPolicyCommand({ repositoryName }),
          );
          repositoryPolicy = policy.policyText;
        } catch {
          repositoryPolicy = undefined;
        }

        let lifecyclePolicy: string | undefined;
        try {
          const policy = await client.send(
            new GetLifecyclePolicyCommand({ repositoryName }),
          );
          lifecyclePolicy = policy.lifecyclePolicyText;
        } catch {
          lifecyclePolicy = undefined;
        }

        out.ecrRepositories.push({
          id: repositoryName,
          arn: repo.repositoryArn,
          name: repositoryName,
          // Tags need a separate ListTagsForResource per repo — skipped.
          tags: {},
          repositoryUri: repo.repositoryUri,
          imageTagMutability: repo.imageTagMutability,
          scanOnPush: repo.imageScanningConfiguration?.scanOnPush,
          encryptionType: repo.encryptionConfiguration?.encryptionType,
          kmsKey: repo.encryptionConfiguration?.kmsKey,
          repositoryPolicy,
          lifecyclePolicy,
        });
      }
    }
  });
}
