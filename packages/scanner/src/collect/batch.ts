// AWS Batch — READ-ONLY (Describe* only).
// Compute environments are VPC-ATTACHED: computeResources carries the subnets
// and security groups the tag sweep can't see — plus managed/unmanaged type,
// EC2/Fargate compute type, vCPU bounds, and the backing ECS cluster. Job
// queues carry priority and the ordered compute-environment ARNs they drain to.
import {
  BatchClient,
  paginateDescribeComputeEnvironments,
  paginateDescribeJobQueues,
} from '@aws-sdk/client-batch';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectBatch(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'batch', 'DescribeComputeEnvironments', async () => {
    const client = ctx.client(BatchClient, region);

    // DescribeComputeEnvironments returns fully detailed environments — no
    // per-id fan-out needed.
    for await (const page of paginateDescribeComputeEnvironments(
      { client },
      { maxResults: 100 },
    )) {
      for (const env of page.computeEnvironments ?? []) {
        const name = env.computeEnvironmentName;
        if (!name) continue;
        out.batchComputeEnvironments.push({
          id: name,
          arn: env.computeEnvironmentArn,
          name,
          // Tags need a separate ListTagsForResource per environment — skipped;
          // the detailed key/value sweep already covers tagged resources.
          tags: {},
          type: env.type,
          state: env.state,
          status: env.status,
          computeType: env.computeResources?.type,
          subnetIds: env.computeResources?.subnets ?? [],
          securityGroupIds: env.computeResources?.securityGroupIds ?? [],
          minvCpus: env.computeResources?.minvCpus,
          maxvCpus: env.computeResources?.maxvCpus,
          ecsClusterArn: env.ecsClusterArn,
        });
      }
    }
  });

  await guard(out.errors, 'batch', 'DescribeJobQueues', async () => {
    const client = ctx.client(BatchClient, region);

    for await (const page of paginateDescribeJobQueues({ client }, { maxResults: 100 })) {
      for (const queue of page.jobQueues ?? []) {
        const name = queue.jobQueueName;
        if (!name) continue;
        out.batchJobQueues.push({
          id: name,
          arn: queue.jobQueueArn,
          name,
          tags: {},
          state: queue.state,
          priority: queue.priority,
          computeEnvironmentArns: (queue.computeEnvironmentOrder ?? [])
            .map((o) => o.computeEnvironment)
            .filter((a): a is string => !!a),
        });
      }
    }
  });
}
