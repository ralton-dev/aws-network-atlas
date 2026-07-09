import { CloudControlClient, paginateListResources } from '@aws-sdk/client-cloudcontrol';
import pLimit from 'p-limit';
import type { RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/**
 * Cloud Control API untagged-resource discovery (regional).
 *
 * The Resource Groups Tagging API sweep (collect/generic.ts) only sees
 * resources that are (or once were) tagged. This collector runs Cloud Control
 * `ListResources` over a curated list of common TypeNames to catch untagged
 * resources, and merges them into out.generic with source: 'cloudcontrol',
 * deduped by ARN against the tagging sweep (which runs concurrently) and
 * within this collector's own results.
 *
 * READ-ONLY: only ListResources is ever called. Cloud Control proxies the
 * downstream service, so it inherits that service's throttling and needs the
 * underlying read permissions; missing permissions and unsupported types
 * (UnsupportedActionException) surface as per-type ScanErrors via guard and
 * never abort the scan.
 */

/**
 * TypeNames that support account-wide ListResources with no required parent
 * identifier and are commonly untagged / not covered by dedicated collectors.
 *
 * Deliberately NOT listed: AWS::S3::Bucket — Cloud Control's S3 list is
 * account-global (ListAllMyBuckets), so a per-region sweep would repeat every
 * bucket in every region; the dedicated global ListBuckets collector already
 * catches untagged buckets.
 */
const TYPE_NAMES = [
  'AWS::CloudFormation::Stack',
  'AWS::Athena::WorkGroup',
  'AWS::ECS::Cluster',
  // Kinesis streams are log + flow-log destinations; without this an untagged
  // stream is invisible. (Firehose delivery streams moved to a dedicated
  // collector — collect/firehose.ts.)
  'AWS::Kinesis::Stream',
  // Note: AWS::Logs::LogGroup moved to a dedicated collector (collect/logs.ts)
  // — paginated with no cap, plus retention/KMS detail.

  // --- 2026-07-09 coverage-mechanism audit: tag-INDEPENDENT catches for
  //     high-value under-collected types that support account-wide
  //     ListResources with no parent identifier. These were previously
  //     tag-only (untagged instances invisible) or entirely uncollected.
  //     Unsupported types self-report as guarded per-type ScanErrors, so any
  //     that a real account rejects can be pruned from a live scan.
  // Supply chain / CI-CD (privileged roles, external Git trust)
  'AWS::CodeBuild::Project',
  'AWS::CodeArtifact::Repository',
  'AWS::CodeStarConnections::Connection',
  // Identity / external trust roots
  'AWS::RolesAnywhere::TrustAnchor',
  'AWS::ACMPCA::CertificateAuthority',
  // Serverless / shadow data stores (untagged = invisible today)
  'AWS::OpenSearchServerless::Collection',
  'AWS::NeptuneGraph::Graph',
  'AWS::DocDBElastic::Cluster',
  'AWS::Timestream::InfluxDBInstance',
  'AWS::S3::AccessPoint',
  'AWS::HealthLake::FHIRDatastore',
  // Public / network-facing workloads
  'AWS::AppRunner::Service',
  'AWS::AppSync::GraphQLApi',
  'AWS::Amplify::App',
  'AWS::MWAA::Environment',
  'AWS::Grafana::Workspace',
  'AWS::Lightsail::Instance',
  'AWS::SageMaker::NotebookInstance',
  'AWS::Synthetics::Canary',
  'AWS::KinesisAnalyticsV2::Application',
  // Security / governance / ZTNA
  'AWS::EC2::VerifiedAccessInstance',
  'AWS::CloudFormation::StackSet',
  'AWS::SecurityLake::DataLake',
  // Wiring / integration / DNS / messaging (Lambda event edges are untaggable)
  'AWS::Lambda::EventSourceMapping',
  'AWS::ServiceDiscovery::PrivateDnsNamespace',
  'AWS::SSM::Document',
  'AWS::SES::EmailIdentity',
  'AWS::AppFlow::Flow',
  // Contact center (PII-heavy platform)
  'AWS::Connect::Instance',
] as const;

/** Per-TypeName result cap so a huge estate can't stall the scan. */
const MAX_PER_TYPE = 500;

/** Cloud Control fans out to downstream services that throttle — keep it low. */
const TYPE_CONCURRENCY = 3;

type Props = Record<string, unknown>;

function parseProperties(raw: string | undefined): Props {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Props;
  } catch {
    // Malformed Properties JSON — fall through to an empty object.
  }
  return {};
}

/**
 * Derive a stable unique key for the resource: a real ARN when one is
 * available (an "Arn"-ish property, or an ARN-shaped Identifier), otherwise a
 * synthetic `cloudcontrol:<TypeName>:<Identifier>` string. It only needs to be
 * unique for search/dedupe.
 */
function deriveArn(typeName: string, identifier: string, props: Props): string {
  const direct = props['Arn'] ?? props['arn'];
  if (typeof direct === 'string' && direct.startsWith('arn:')) return direct;
  // Some schemas expose the ARN under a prefixed key (e.g. SNS TopicArn).
  for (const [key, value] of Object.entries(props)) {
    if (key.toLowerCase().endsWith('arn') && typeof value === 'string' && value.startsWith('arn:')) {
      return value;
    }
  }
  if (identifier.startsWith('arn:')) return identifier;
  return `cloudcontrol:${typeName}:${identifier}`;
}

/** Map a Properties.Tags value ([{Key,Value}] array or plain object) to Tags. */
function extractTags(props: Props): Tags {
  const tags: Tags = {};
  const raw = props['Tags'] ?? props['tags'];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry === 'object') {
        const { Key, Value } = entry as { Key?: unknown; Value?: unknown };
        if (typeof Key === 'string') tags[Key] = typeof Value === 'string' ? Value : '';
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') tags[key] = value;
    }
  }
  return tags;
}

export async function collectCloudControl(ctx: AwsContext, region: string, out: RegionSnapshot): Promise<void> {
  const client = ctx.client(CloudControlClient, region);

  // Dedupe against out.generic. The tagging sweep pushes concurrently, so
  // instead of snapshotting once we lazily sync the seen-set with any entries
  // that appeared since the last check (our own pushes included).
  const seen = new Set<string>();
  let synced = 0;
  const syncSeen = () => {
    while (synced < out.generic.length) {
      const entry = out.generic[synced++];
      if (entry) seen.add(entry.arn);
    }
  };

  const limit = pLimit(TYPE_CONCURRENCY);
  await Promise.all(
    TYPE_NAMES.map((typeName) =>
      limit(() =>
        // Each TypeName gets its own guard: an unsupported type
        // (UnsupportedActionException) or missing downstream permission is
        // recorded as a ScanError without aborting the other types.
        guard(out.errors, 'cloudcontrol', typeName, async () => {
          const [, serviceToken = '', typeToken = ''] = typeName.split('::');
          const service = serviceToken.toLowerCase();
          const resourceType = typeToken.toLowerCase();

          let count = 0;
          paging: for await (const page of paginateListResources({ client }, { TypeName: typeName })) {
            for (const desc of page.ResourceDescriptions ?? []) {
              const identifier = desc.Identifier;
              if (!identifier) continue;
              if (count >= MAX_PER_TYPE) {
                out.errors.push({
                  service: 'cloudcontrol',
                  operation: `${typeName} truncated`,
                  message: `stopped after ${MAX_PER_TYPE} resources; results for this type are incomplete`,
                });
                break paging;
              }
              count++;

              const props = parseProperties(desc.Properties);
              const arn = deriveArn(typeName, identifier, props);
              syncSeen();
              if (seen.has(arn)) continue;
              seen.add(arn);

              const name = props['Name'] ?? props['TableName'];
              out.generic.push({
                arn,
                service,
                resourceType,
                name: typeof name === 'string' ? name : identifier,
                tags: extractTags(props),
                source: 'cloudcontrol',
              });
            }
          }
          // Do not sort — the caller sorts out.generic once all collectors finish.
        }),
      ),
    ),
  );
}
