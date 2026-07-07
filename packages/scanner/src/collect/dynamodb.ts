// DynamoDB — READ-ONLY (List*/Describe* only).
// Tables carry the data-tier posture the tag sweep can't see: key schema,
// billing mode, encryption (SSE/KMS), streams, PITR, TTL, global-table
// replicas (cross-region data flow), and deletion protection.
import {
  DynamoDBClient,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  paginateListTables,
} from '@aws-sdk/client-dynamodb';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Per-region table cap so a huge estate can't stall the scan. */
const MAX_TABLES = 300;

export async function collectDynamoDb(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'dynamodb', 'ListTables', async () => {
    const client = ctx.client(DynamoDBClient, region);

    let count = 0;
    paging: for await (const page of paginateListTables({ client }, {})) {
      for (const tableName of page.TableNames ?? []) {
        if (count >= MAX_TABLES) {
          out.errors.push({
            service: 'dynamodb',
            operation: 'ListTables truncated',
            message: `stopped after ${MAX_TABLES} tables; results for this region are incomplete`,
          });
          break paging;
        }
        count++;

        const detail = await client.send(new DescribeTableCommand({ TableName: tableName }));
        const table = detail.Table;

        // DescribeContinuousBackups / DescribeTimeToLive each get their own
        // try/catch — a missing permission must not lose the table itself.
        let pitrEnabled: boolean | undefined;
        try {
          const backups = await client.send(
            new DescribeContinuousBackupsCommand({ TableName: tableName }),
          );
          pitrEnabled =
            backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
              ?.PointInTimeRecoveryStatus === 'ENABLED';
        } catch {
          pitrEnabled = undefined;
        }

        let ttlEnabled: boolean | undefined;
        try {
          const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName: tableName }));
          ttlEnabled = ttl.TimeToLiveDescription?.TimeToLiveStatus === 'ENABLED';
        } catch {
          ttlEnabled = undefined;
        }

        const keySchema = table?.KeySchema ?? [];
        const partitionKey = keySchema.find((k) => k.KeyType === 'HASH')?.AttributeName;
        const sortKey = keySchema.find((k) => k.KeyType === 'RANGE')?.AttributeName;

        out.dynamoDbTables.push({
          id: tableName,
          arn: table?.TableArn,
          name: tableName,
          // Tags need a separate ListTagsOfResource per table — skipped.
          tags: {},
          status: table?.TableStatus,
          // BillingModeSummary is absent on tables that predate on-demand
          // billing and were never switched — those are provisioned.
          billingMode: table?.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
          itemCount: table?.ItemCount,
          sizeBytes: table?.TableSizeBytes,
          partitionKey,
          sortKey,
          sseType: table?.SSEDescription?.SSEType,
          kmsKey: table?.SSEDescription?.KMSMasterKeyArn,
          streamEnabled: table?.StreamSpecification?.StreamEnabled,
          streamViewType: table?.StreamSpecification?.StreamViewType,
          streamArn: table?.LatestStreamArn,
          pitrEnabled,
          ttlEnabled,
          globalTableReplicas: (table?.Replicas ?? [])
            .map((r) => r.RegionName)
            .filter((r): r is string => !!r),
          deletionProtectionEnabled: table?.DeletionProtectionEnabled,
        });
      }
    }
  });
}
