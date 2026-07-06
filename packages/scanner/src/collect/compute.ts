import { EC2Client, paginateDescribeInstances } from '@aws-sdk/client-ec2';
import {
  AutoScalingClient,
  paginateDescribeAutoScalingGroups,
} from '@aws-sdk/client-auto-scaling';
import { LambdaClient, paginateListFunctions } from '@aws-sdk/client-lambda';
import type { RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { toTags, nameTag } from '../util.js';

/** EC2 instances, Auto Scaling groups, and Lambda functions. */
export async function collectCompute(ctx: AwsContext, region: string, out: RegionSnapshot): Promise<void> {
  const errors = out.errors;

  await guard(errors, 'ec2', 'DescribeInstances', async () => {
    const ec2 = ctx.client(EC2Client, region);
    for await (const page of paginateDescribeInstances({ client: ec2 }, {})) {
      for (const reservation of page.Reservations ?? []) {
        for (const i of reservation.Instances ?? []) {
          if (i.State?.Name === 'terminated') continue;
          const tags = toTags(i.Tags);
          out.instances.push({
            id: i.InstanceId!,
            name: nameTag(tags),
            tags,
            instanceType: i.InstanceType,
            state: i.State?.Name,
            vpcId: i.VpcId,
            subnetId: i.SubnetId,
            availabilityZone: i.Placement?.AvailabilityZone,
            privateIp: i.PrivateIpAddress,
            publicIp: i.PublicIpAddress,
            securityGroupIds: (i.SecurityGroups ?? [])
              .map((g) => g.GroupId)
              .filter((g): g is string => !!g),
            imageId: i.ImageId,
            launchTime: i.LaunchTime?.toISOString(),
            platform: i.PlatformDetails,
          });
        }
      }
    }
  });

  await guard(errors, 'autoscaling', 'DescribeAutoScalingGroups', async () => {
    const asg = ctx.client(AutoScalingClient, region);
    for await (const page of paginateDescribeAutoScalingGroups({ client: asg }, {})) {
      for (const g of page.AutoScalingGroups ?? []) {
        const tags: Tags = {};
        for (const t of g.Tags ?? []) {
          if (t.Key) tags[t.Key] = t.Value ?? '';
        }
        out.autoScalingGroups.push({
          id: g.AutoScalingGroupName!,
          arn: g.AutoScalingGroupARN,
          name: g.AutoScalingGroupName,
          tags,
          subnetIds: (g.VPCZoneIdentifier ?? '').split(',').filter((s) => s !== ''),
          instanceIds: (g.Instances ?? [])
            .map((i) => i.InstanceId)
            .filter((i): i is string => !!i),
          minSize: g.MinSize,
          maxSize: g.MaxSize,
          desiredCapacity: g.DesiredCapacity,
          loadBalancerTargetGroupArns: g.TargetGroupARNs ?? [],
        });
      }
    }
  });

  await guard(errors, 'lambda', 'ListFunctions', async () => {
    const lambda = ctx.client(LambdaClient, region);
    for await (const page of paginateListFunctions({ client: lambda }, {})) {
      for (const fn of page.Functions ?? []) {
        out.lambdaFunctions.push({
          id: fn.FunctionArn ?? fn.FunctionName!,
          arn: fn.FunctionArn,
          name: fn.FunctionName,
          tags: {}, // ListFunctions doesn't return tags; the generic sweep fills the search index.
          runtime: fn.Runtime,
          description: fn.Description || undefined,
          vpcConfig:
            fn.VpcConfig?.SubnetIds && fn.VpcConfig.SubnetIds.length > 0
              ? {
                  vpcId: fn.VpcConfig.VpcId,
                  subnetIds: fn.VpcConfig.SubnetIds,
                  securityGroupIds: fn.VpcConfig.SecurityGroupIds ?? [],
                }
              : undefined,
        });
      }
    }
  });
}
