import {
  Route53Client,
  paginateListHostedZones,
  ListResourceRecordSetsCommand,
  GetHostedZoneCommand,
} from '@aws-sdk/client-route-53';
import {
  DirectConnectClient,
  DescribeDirectConnectGatewaysCommand,
  DescribeDirectConnectGatewayAssociationsCommand,
} from '@aws-sdk/client-direct-connect';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';
import type { AccountSnapshot, DnsRecord } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Record types worth stitching to resources; NS/SOA/TXT/MX are noise here. */
const RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME']);

/** Per-zone cap on collected records — keeps giant zones diff- and size-safe. */
const MAX_RECORDS_PER_ZONE = 2000;

/**
 * Per-zone cap on records SCANNED (all types, before filtering). Without this
 * a zone dominated by TXT/MX/NS records would be paginated in full even though
 * few records survive the type filter — deadly against Route 53's ~5 rps limit.
 */
const MAX_SCANNED_RECORDS_PER_ZONE = 10000;

/**
 * Global (non-regional) resources, collected once per account:
 * Route 53 hosted zones, Direct Connect gateways, S3 buckets.
 */
export async function collectGlobal(ctx: AwsContext, out: AccountSnapshot['global']): Promise<void> {
  const errors = out.errors;

  await guard(errors, 'route53', 'ListHostedZones', async () => {
    const r53 = ctx.client(Route53Client, ctx.homeRegion);
    // Route 53 has a hard ~5 req/s account limit — keep per-zone calls slow.
    const limit = pLimit(2);
    const zones: Array<{ id: string; name: string; privateZone: boolean; recordCount?: number }> = [];
    for await (const page of paginateListHostedZones({ client: r53 }, {})) {
      for (const z of page.HostedZones ?? []) {
        if (!z.Id || !z.Name) continue;
        zones.push({
          id: z.Id.replace('/hostedzone/', ''),
          name: z.Name,
          privateZone: z.Config?.PrivateZone ?? false,
          recordCount: z.ResourceRecordSetCount,
        });
      }
    }
    await Promise.all(
      zones.map((z) =>
        limit(() =>
          guard(errors, 'route53', `GetHostedZone(${z.name})`, async () => {
            // ListHostedZones omits private-zone VPC associations; fetch per zone.
            let vpcAssociations: Array<{ vpcId: string; region: string }> = [];
            if (z.privateZone) {
              const res = await r53.send(new GetHostedZoneCommand({ Id: z.id }));
              vpcAssociations = (res.VPCs ?? [])
                .filter((v) => v.VPCId)
                .map((v) => ({ vpcId: v.VPCId!, region: v.VPCRegion ?? '' }));
            }

            // A/AAAA/CNAME records (aliases included) are what stitch DNS
            // names to ALBs/CloudFront/APIs. Capped per zone; a truncated
            // zone is flagged rather than silently partial.
            const records: DnsRecord[] = [];
            let recordsTruncated = false;
            await guard(errors, 'route53', `ListResourceRecordSets(${z.name})`, async () => {
              // Zones too large to scan within the rate limit are skipped whole.
              if ((z.recordCount ?? 0) > MAX_SCANNED_RECORDS_PER_ZONE) {
                recordsTruncated = true;
                return;
              }
              // No standard paginator: this API pages by (name, type, identifier).
              let startName: string | undefined;
              let startType: string | undefined;
              let startIdentifier: string | undefined;
              let scanned = 0;
              paging: do {
                const page = await r53.send(
                  new ListResourceRecordSetsCommand({
                    HostedZoneId: z.id,
                    StartRecordName: startName,
                    StartRecordType: startType as never,
                    StartRecordIdentifier: startIdentifier,
                  }),
                );
                for (const rr of page.ResourceRecordSets ?? []) {
                  if (++scanned > MAX_SCANNED_RECORDS_PER_ZONE) {
                    recordsTruncated = true;
                    break paging;
                  }
                  if (!rr.Name || !rr.Type || !RECORD_TYPES.has(rr.Type)) continue;
                  if (records.length >= MAX_RECORDS_PER_ZONE) {
                    recordsTruncated = true;
                    break paging;
                  }
                  records.push({
                    name: rr.Name,
                    type: rr.Type,
                    ttl: rr.TTL,
                    values: (rr.ResourceRecords ?? [])
                      .map((v) => v.Value)
                      .filter((v): v is string => !!v),
                    aliasTarget: rr.AliasTarget?.DNSName,
                  });
                }
                if (!page.IsTruncated) break;
                startName = page.NextRecordName;
                startType = page.NextRecordType;
                startIdentifier = page.NextRecordIdentifier;
              } while (startName);
              records.sort((a, b) => `${a.name}|${a.type}`.localeCompare(`${b.name}|${b.type}`));
            });

            out.hostedZones.push({
              id: z.id,
              name: z.name,
              tags: {},
              zoneName: z.name,
              privateZone: z.privateZone,
              recordCount: z.recordCount,
              vpcAssociations,
              records,
              recordsTruncated: recordsTruncated || undefined,
            });
          }),
        ),
      ),
    );
  });

  await guard(errors, 'directconnect', 'DescribeDirectConnectGateways', async () => {
    const dx = ctx.client(DirectConnectClient, ctx.homeRegion);
    let nextToken: string | undefined;
    do {
      const res = await dx.send(new DescribeDirectConnectGatewaysCommand({ nextToken }));
      for (const gw of res.directConnectGateways ?? []) {
        if (!gw.directConnectGatewayId) continue;
        const associations: NonNullable<
          AccountSnapshot['global']['directConnectGateways'][number]['associations']
        > = [];
        await guard(
          errors,
          'directconnect',
          `DescribeDirectConnectGatewayAssociations(${gw.directConnectGatewayId})`,
          async () => {
            let assocToken: string | undefined;
            do {
              const assocRes = await dx.send(
                new DescribeDirectConnectGatewayAssociationsCommand({
                  directConnectGatewayId: gw.directConnectGatewayId,
                  nextToken: assocToken,
                }),
              );
              for (const a of assocRes.directConnectGatewayAssociations ?? []) {
                associations.push({
                  associatedGatewayId: a.associatedGateway?.id,
                  associatedGatewayType: a.associatedGateway?.type,
                  associatedGatewayOwnerAccount: a.associatedGateway?.ownerAccount,
                  associatedGatewayRegion: a.associatedGateway?.region,
                  state: a.associationState,
                });
              }
              assocToken = assocRes.nextToken;
            } while (assocToken);
          },
        );
        out.directConnectGateways.push({
          id: gw.directConnectGatewayId,
          name: gw.directConnectGatewayName,
          tags: {},
          ownerAccount: gw.ownerAccount,
          amazonSideAsn: gw.amazonSideAsn,
          state: gw.directConnectGatewayState,
          associations,
        });
      }
      nextToken = res.nextToken;
    } while (nextToken);
  });

  await guard(errors, 's3', 'ListBuckets', async () => {
    const s3 = ctx.client(S3Client, ctx.homeRegion);
    const res = await s3.send(new ListBucketsCommand({}));
    for (const b of res.Buckets ?? []) {
      if (!b.Name) continue;
      out.s3Buckets.push({
        id: b.Name,
        name: b.Name,
        tags: {},
        region: b.BucketRegion,
        creationDate: b.CreationDate?.toISOString(),
      });
    }
  });
}
