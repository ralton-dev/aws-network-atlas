// Kinesis Data Firehose — READ-ONLY (List*/Describe* only).
// Delivery streams with an in-VPC OpenSearch/Elasticsearch destination are
// VPC-ATTACHED (VpcConfigurationDescription: subnet + SG) — the ENIs Firehose
// creates in the VPC are otherwise anonymous. Also captured: destination type,
// source stream ARN (Kinesis/MSK), and CMK encryption.
import {
  FirehoseClient,
  DescribeDeliveryStreamCommand,
  ListDeliveryStreamsCommand,
  type DestinationDescription,
} from '@aws-sdk/client-firehose';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/**
 * Map the populated *DestinationDescription key of Destinations[0] to a stable
 * destinationType, and surface the in-VPC OpenSearch/Elasticsearch attachment.
 */
function classifyDestination(dest: DestinationDescription | undefined): {
  destinationType?: string;
  subnetIds: string[];
  securityGroupIds: string[];
} {
  const none = { destinationType: undefined, subnetIds: [], securityGroupIds: [] };
  if (!dest) return none;
  // ExtendedS3 before S3: extended-S3 destinations also carry a legacy
  // S3DestinationDescription mirror.
  if (dest.ExtendedS3DestinationDescription) {
    return { ...none, destinationType: 'extendedS3' };
  }
  if (dest.S3DestinationDescription) {
    return { ...none, destinationType: 's3' };
  }
  const opensearchVpc =
    dest.AmazonopensearchserviceDestinationDescription?.VpcConfigurationDescription ??
    dest.ElasticsearchDestinationDescription?.VpcConfigurationDescription;
  if (dest.AmazonopensearchserviceDestinationDescription || dest.ElasticsearchDestinationDescription) {
    return {
      destinationType: dest.AmazonopensearchserviceDestinationDescription
        ? 'opensearch'
        : 'elasticsearch',
      subnetIds: (opensearchVpc?.SubnetIds ?? []).filter((s): s is string => !!s),
      securityGroupIds: (opensearchVpc?.SecurityGroupIds ?? []).filter((s): s is string => !!s),
    };
  }
  if (dest.RedshiftDestinationDescription) return { ...none, destinationType: 'redshift' };
  if (dest.HttpEndpointDestinationDescription) return { ...none, destinationType: 'http' };
  if (dest.SplunkDestinationDescription) return { ...none, destinationType: 'splunk' };
  if (dest.SnowflakeDestinationDescription) return { ...none, destinationType: 'snowflake' };
  return none;
}

export async function collectFirehose(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'firehose', 'ListDeliveryStreams', async () => {
    const client = ctx.client(FirehoseClient, region);

    // ListDeliveryStreams has no SDK paginator: it returns DeliveryStreamNames
    // only and pages on ExclusiveStartDeliveryStreamName + HasMoreDeliveryStreams.
    const names: string[] = [];
    let exclusiveStart: string | undefined;
    for (;;) {
      const page = await client.send(
        new ListDeliveryStreamsCommand(
          exclusiveStart ? { ExclusiveStartDeliveryStreamName: exclusiveStart } : {},
        ),
      );
      for (const name of page.DeliveryStreamNames ?? []) names.push(name);
      if (!page.HasMoreDeliveryStreams || names.length === 0) break;
      exclusiveStart = names[names.length - 1];
    }

    for (const name of names) {
      const described = await client.send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName: name }),
      );
      const d = described.DeliveryStreamDescription;
      if (!d) continue;
      const source = d.Source;
      const { destinationType, subnetIds, securityGroupIds } = classifyDestination(
        d.Destinations?.[0],
      );
      out.firehoseDeliveryStreams.push({
        id: d.DeliveryStreamName ?? name,
        arn: d.DeliveryStreamARN,
        name: d.DeliveryStreamName ?? name,
        // Tags need a separate ListTagsForDeliveryStream per stream — skipped.
        tags: {},
        status: d.DeliveryStreamStatus,
        deliveryStreamType: d.DeliveryStreamType,
        destinationType,
        kmsKeyArn: d.DeliveryStreamEncryptionConfiguration?.KeyARN,
        sourceStreamArn:
          source?.KinesisStreamSourceDescription?.KinesisStreamARN ??
          source?.MSKSourceDescription?.MSKClusterARN,
        // VpcConfigurationDescription carries no VpcId field — the subnet/SG
        // ids are the attachment data; vpcId stays undefined.
        vpcId: undefined,
        subnetIds,
        securityGroupIds,
      });
    }
  });
}
