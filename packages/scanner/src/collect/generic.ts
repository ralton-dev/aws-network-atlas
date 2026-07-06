import {
  ResourceGroupsTaggingAPIClient,
  paginateGetResources,
} from '@aws-sdk/client-resource-groups-tagging-api';
import type { RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { parseArn } from '../util.js';

/**
 * Generic "everything" sweep via the Resource Groups Tagging API.
 *
 * One paginated call returns the ARN + tags of (almost) every resource in the
 * region. Caveat: it only returns resources that are tagged or were tagged at
 * some point — never-tagged resources are invisible to it. The detailed
 * collectors cover the network-relevant types regardless of tags, and
 * S3 buckets get a dedicated global listing.
 */
export async function collectGeneric(ctx: AwsContext, region: string, out: RegionSnapshot): Promise<void> {
  await guard(out.errors, 'tagging', 'GetResources', async () => {
    const client = ctx.client(ResourceGroupsTaggingAPIClient, region);
    for await (const page of paginateGetResources({ client }, { ResourcesPerPage: 100 })) {
      for (const r of page.ResourceTagMappingList ?? []) {
        if (!r.ResourceARN) continue;
        const parsed = parseArn(r.ResourceARN);
        if (!parsed) continue;
        const tags: Tags = {};
        for (const t of r.Tags ?? []) {
          if (t.Key) tags[t.Key] = t.Value ?? '';
        }
        out.generic.push({
          arn: r.ResourceARN,
          service: parsed.service,
          resourceType: parsed.resourceType,
          name: tags['Name'] ?? parsed.resourceName,
          tags,
        });
      }
    }
    out.generic.sort((a, b) => a.arn.localeCompare(b.arn));
  });
}
