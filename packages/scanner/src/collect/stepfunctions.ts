// Step Functions — READ-ONLY (List*/Describe* only).
// State machines carry orchestration posture the tag sweep can't see: type
// (STANDARD/EXPRESS), execution role, logging/tracing/KMS, and — the
// value-add — the downstream integration ARNs parsed out of the ASL
// definition (which Lambda/SQS/SNS/ECS/etc. each state machine invokes).
import {
  SFNClient,
  DescribeStateMachineCommand,
  paginateListStateMachines,
} from '@aws-sdk/client-sfn';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Per-region state-machine cap so a huge estate can't stall the scan. */
const MAX_STATE_MACHINES = 300;

/** Cap on integration ARNs collected per definition (definitions can be huge). */
const MAX_INTEGRATION_ARNS = 100;

/**
 * Parse an ASL definition for Task-state Resource ARNs. Walks the whole
 * document recursively so nested states (Map iterators, Parallel branches)
 * are covered. Defensive: any parse failure yields an empty list.
 */
function parseIntegrationArns(definition: string | undefined): string[] {
  if (!definition) return [];
  const arns = new Set<string>();
  try {
    const doc: unknown = JSON.parse(definition);
    const walk = (node: unknown): void => {
      if (arns.size >= MAX_INTEGRATION_ARNS) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      const resource = obj['Resource'];
      if (typeof resource === 'string' && resource.startsWith('arn:')) {
        arns.add(resource);
      }
      for (const value of Object.values(obj)) walk(value);
    };
    walk(doc);
  } catch {
    // malformed/oversized definition — keep the state machine itself
  }
  return [...arns];
}

export async function collectStepFunctions(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'sfn', 'ListStateMachines', async () => {
    const client = ctx.client(SFNClient, region);

    let count = 0;
    paging: for await (const page of paginateListStateMachines({ client }, {})) {
      for (const summary of page.stateMachines ?? []) {
        const stateMachineArn = summary.stateMachineArn;
        if (!stateMachineArn) continue;
        if (count >= MAX_STATE_MACHINES) {
          out.errors.push({
            service: 'sfn',
            operation: 'ListStateMachines truncated',
            message: `stopped after ${MAX_STATE_MACHINES} state machines; results for this region are incomplete`,
          });
          break paging;
        }
        count++;

        // DescribeStateMachine carries role/logging/tracing/KMS/definition —
        // a per-machine failure must not lose the machine itself.
        let detail: {
          type?: string;
          status?: string;
          roleArn?: string;
          loggingLevel?: string;
          tracingEnabled?: boolean;
          kmsKeyId?: string;
          integrationResourceArns: string[];
        } = { type: summary.type, integrationResourceArns: [] };
        try {
          const described = await client.send(
            new DescribeStateMachineCommand({ stateMachineArn }),
          );
          detail = {
            type: described.type ?? summary.type,
            status: described.status,
            roleArn: described.roleArn,
            loggingLevel: described.loggingConfiguration?.level,
            tracingEnabled: described.tracingConfiguration?.enabled,
            kmsKeyId: described.encryptionConfiguration?.kmsKeyId,
            integrationResourceArns: parseIntegrationArns(described.definition),
          };
        } catch {
          // keep the ListStateMachines-level fields
        }

        out.sfnStateMachines.push({
          id: stateMachineArn,
          arn: stateMachineArn,
          name: summary.name,
          // Tags need a separate ListTagsForResource per machine — skipped.
          tags: {},
          type: detail.type,
          status: detail.status,
          roleArn: detail.roleArn,
          loggingLevel: detail.loggingLevel,
          tracingEnabled: detail.tracingEnabled,
          kmsKeyId: detail.kmsKeyId,
          integrationResourceArns: detail.integrationResourceArns,
        });
      }
    }
  });
}
