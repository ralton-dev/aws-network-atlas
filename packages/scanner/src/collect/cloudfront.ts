// CloudFront distributions (account-global) — READ-ONLY (List* only).
import {
  CloudFrontClient,
  paginateListDistributions,
  ListTagsForResourceCommand,
  ListVpcOriginsCommand,
} from '@aws-sdk/client-cloudfront';
import pLimit from 'p-limit';
import type { AccountSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { toTags } from '../util.js';

type CloudFrontDistributionOut = AccountSnapshot['global']['cloudFrontDistributions'][number];

/** CloudFront is global — collected once per account via the home region. */
export async function collectCloudFront(ctx: AwsContext, out: AccountSnapshot['global']): Promise<void> {
  const errors = out.errors;

  await guard(errors, 'cloudfront', 'ListDistributions', async () => {
    const cf = ctx.client(CloudFrontClient, ctx.homeRegion);
    const limit = pLimit(4);

    const distributions: CloudFrontDistributionOut[] = [];
    for await (const page of paginateListDistributions({ client: cf }, {})) {
      for (const d of page.DistributionList?.Items ?? []) {
        if (!d.Id) continue;
        distributions.push({
          id: d.Id,
          arn: d.ARN,
          name: d.Aliases?.Items?.[0] ?? d.DomainName,
          tags: {},
          domainName: d.DomainName,
          aliases: d.Aliases?.Items ?? [],
          enabled: d.Enabled,
          status: d.Status,
          origins: (d.Origins?.Items ?? [])
            .map((o) => o.DomainName)
            .filter((n): n is string => !!n),
          priceClass: d.PriceClass,
          webAclId: d.WebACLId || undefined,
          originDetails: (d.Origins?.Items ?? []).map((o) => ({
            domainName: o.DomainName,
            originType: o.VpcOriginConfig ? ('vpc' as const) : o.S3OriginConfig ? ('s3' as const) : ('custom' as const),
            vpcOriginId: o.VpcOriginConfig?.VpcOriginId,
            originAccessControlId: o.OriginAccessControlId || undefined,
          })),
        });
      }
    }

    // Best-effort tag enrichment: the distribution summary carries no tags.
    await Promise.all(
      distributions.map((d) =>
        limit(() =>
          guard(errors, 'cloudfront', `ListTagsForResource(${d.id})`, async () => {
            if (!d.arn) return;
            const res = await cf.send(new ListTagsForResourceCommand({ Resource: d.arn }));
            d.tags = toTags(res.Tags?.Items);
          }),
        ),
      ),
    );

    out.cloudFrontDistributions.push(...distributions);
  });

  // VPC origins let a distribution reach a private ALB/NLB/EC2 directly —
  // a real topology edge from the CDN into the VPC interior.
  await guard(errors, 'cloudfront', 'ListVpcOrigins', async () => {
    const cf = ctx.client(CloudFrontClient, ctx.homeRegion);
    let marker: string | undefined;
    do {
      const res = await cf.send(new ListVpcOriginsCommand({ Marker: marker }));
      for (const vo of res.VpcOriginList?.Items ?? []) {
        if (!vo.Id) continue;
        out.cloudFrontVpcOrigins.push({
          id: vo.Id,
          arn: vo.Arn,
          name: vo.Name,
          tags: {},
          status: vo.Status,
          endpointArn: vo.OriginEndpointArn,
        });
      }
      marker = res.VpcOriginList?.IsTruncated ? res.VpcOriginList.NextMarker : undefined;
    } while (marker);
  });
}
