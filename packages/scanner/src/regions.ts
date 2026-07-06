import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import type { AwsContext } from './aws.js';

/**
 * All regions enabled for the account (opt-in-not-required + opted-in).
 * AllRegions: false filters out regions the account has not opted into.
 */
export async function enabledRegions(ctx: AwsContext): Promise<string[]> {
  const ec2 = ctx.client(EC2Client, ctx.homeRegion);
  const res = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
  const regions = (res.Regions ?? [])
    .map((r) => r.RegionName)
    .filter((r): r is string => !!r);
  return regions.sort();
}
