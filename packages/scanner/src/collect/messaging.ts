// Messaging (SNS + SQS) — READ-ONLY (List*/Get* only).
// Topics and queues carry integration posture the tag sweep can't see:
// resource policies (cross-account publish/send), encryption (KMS/SSE),
// subscription fan-out destinations, and DLQ redrive wiring.
import {
  SNSClient,
  GetSubscriptionAttributesCommand,
  GetTopicAttributesCommand,
  paginateListSubscriptionsByTopic,
  paginateListTopics,
} from '@aws-sdk/client-sns';
import { SQSClient, GetQueueAttributesCommand, paginateListQueues } from '@aws-sdk/client-sqs';
import type { RegionSnapshot, SnsTopic } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Per-topic subscription cap so a huge fan-out can't stall the scan. */
const MAX_SUBSCRIPTIONS_PER_TOPIC = 200;

export async function collectSns(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'sns', 'ListTopics', async () => {
    const client = ctx.client(SNSClient, region);

    for await (const page of paginateListTopics({ client }, {})) {
      for (const summary of page.Topics ?? []) {
        const topicArn = summary.TopicArn;
        if (!topicArn) continue;

        const detail = await client.send(new GetTopicAttributesCommand({ TopicArn: topicArn }));
        const attrs = detail.Attributes ?? {};

        const subscriptionsConfirmed =
          attrs['SubscriptionsConfirmed'] !== undefined
            ? Number(attrs['SubscriptionsConfirmed'])
            : undefined;

        const subscriptions: SnsTopic['subscriptions'] = [];
        // Only walk subscriptions when the topic reports confirmed ones —
        // saves a paginated call per idle topic.
        if (subscriptionsConfirmed !== undefined && subscriptionsConfirmed > 0) {
          let truncated = false;
          subPaging: for await (const subPage of paginateListSubscriptionsByTopic(
            { client },
            { TopicArn: topicArn },
          )) {
            for (const sub of subPage.Subscriptions ?? []) {
              // Pending subscriptions have the literal 'PendingConfirmation'
              // instead of an ARN and support no attribute calls.
              const subArn = sub.SubscriptionArn;
              if (!subArn || !subArn.startsWith('arn:')) continue;
              if (subscriptions.length >= MAX_SUBSCRIPTIONS_PER_TOPIC) {
                truncated = true;
                break subPaging;
              }

              // A per-subscription failure must not lose the topic itself.
              let rawMessageDelivery: boolean | undefined;
              let protocol = sub.Protocol;
              let endpoint = sub.Endpoint;
              try {
                const subDetail = await client.send(
                  new GetSubscriptionAttributesCommand({ SubscriptionArn: subArn }),
                );
                const subAttrs = subDetail.Attributes ?? {};
                protocol = subAttrs['Protocol'] ?? protocol;
                endpoint = subAttrs['Endpoint'] ?? endpoint;
                if (subAttrs['RawMessageDelivery'] !== undefined) {
                  rawMessageDelivery = subAttrs['RawMessageDelivery'] === 'true';
                }
              } catch {
                // keep the ListSubscriptionsByTopic-level fields
              }

              subscriptions.push({ arn: subArn, protocol, endpoint, rawMessageDelivery });
            }
          }
          if (truncated) {
            out.errors.push({
              service: 'sns',
              operation: 'ListSubscriptionsByTopic truncated',
              message: `stopped after ${MAX_SUBSCRIPTIONS_PER_TOPIC} subscriptions on ${topicArn}; subscription list is incomplete`,
            });
          }
        }

        out.snsTopics.push({
          id: topicArn,
          arn: topicArn,
          // Topic ARNs end in the topic name: arn:aws:sns:region:acct:name
          name: topicArn.split(':').pop() ?? topicArn,
          // Tags need a separate ListTagsForResource per topic — skipped.
          tags: {},
          displayName: attrs['DisplayName'] || undefined,
          fifoTopic: attrs['FifoTopic'] !== undefined ? attrs['FifoTopic'] === 'true' : undefined,
          kmsMasterKeyId: attrs['KmsMasterKeyId'] || undefined,
          policy: attrs['Policy'] || undefined,
          subscriptionsConfirmed,
          subscriptions,
        });
      }
    }
  });
}

export async function collectSqs(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'sqs', 'ListQueues', async () => {
    const client = ctx.client(SQSClient, region);

    for await (const page of paginateListQueues({ client }, { MaxResults: 1000 })) {
      for (const queueUrl of page.QueueUrls ?? []) {
        const detail = await client.send(
          new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }),
        );
        const attrs = detail.Attributes ?? {};

        // RedrivePolicy is a JSON string: {"deadLetterTargetArn":…,"maxReceiveCount":…}
        let deadLetterTargetArn: string | undefined;
        let maxReceiveCount: number | undefined;
        if (attrs['RedrivePolicy']) {
          try {
            const redrive = JSON.parse(attrs['RedrivePolicy']) as {
              deadLetterTargetArn?: string;
              maxReceiveCount?: number | string;
            };
            deadLetterTargetArn = redrive.deadLetterTargetArn;
            maxReceiveCount =
              redrive.maxReceiveCount !== undefined ? Number(redrive.maxReceiveCount) : undefined;
          } catch {
            // malformed redrive policy — keep the queue without DLQ detail
          }
        }

        const queueArn = attrs['QueueArn'];
        out.sqsQueues.push({
          id: queueArn ?? queueUrl,
          arn: queueArn,
          // Queue URLs end in the queue name: https://sqs.region…/acct/name
          name: queueUrl.split('/').pop() ?? queueUrl,
          // Tags need a separate ListQueueTags per queue — skipped.
          tags: {},
          fifoQueue: attrs['FifoQueue'] !== undefined ? attrs['FifoQueue'] === 'true' : undefined,
          kmsMasterKeyId: attrs['KmsMasterKeyId'] || undefined,
          sqsManagedSseEnabled:
            attrs['SqsManagedSseEnabled'] !== undefined
              ? attrs['SqsManagedSseEnabled'] === 'true'
              : undefined,
          policy: attrs['Policy'] || undefined,
          deadLetterTargetArn,
          maxReceiveCount,
          visibilityTimeout:
            attrs['VisibilityTimeout'] !== undefined
              ? Number(attrs['VisibilityTimeout'])
              : undefined,
        });
      }
    }
  });
}
