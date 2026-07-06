import {
  ElasticLoadBalancingV2Client,
  paginateDescribeLoadBalancers,
  paginateDescribeTargetGroups,
  paginateDescribeListeners,
  DescribeTargetHealthCommand,
  DescribeTagsCommand as DescribeTagsV2Command,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  ElasticLoadBalancingClient,
  paginateDescribeLoadBalancers as paginateDescribeClassicLoadBalancers,
} from '@aws-sdk/client-elastic-load-balancing';
import pLimit from 'p-limit';
import type { LoadBalancer, RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

const LB_TYPES = new Set(['application', 'network', 'gateway']);

/** Collect ALB/NLB/GWLB (+ listeners, target groups, target health) and classic ELBs. */
export async function collectElb(ctx: AwsContext, region: string, out: RegionSnapshot): Promise<void> {
  const elbv2 = ctx.client(ElasticLoadBalancingV2Client, region);
  const errors = out.errors;
  const limit = pLimit(4);

  const lbs: LoadBalancer[] = [];
  await guard(errors, 'elbv2', 'DescribeLoadBalancers', async () => {
    for await (const page of paginateDescribeLoadBalancers({ client: elbv2 }, {})) {
      for (const lb of page.LoadBalancers ?? []) {
        lbs.push({
          id: lb.LoadBalancerArn!,
          arn: lb.LoadBalancerArn,
          name: lb.LoadBalancerName,
          tags: {},
          lbType: (LB_TYPES.has(lb.Type ?? '') ? lb.Type : 'application') as LoadBalancer['lbType'],
          scheme: lb.Scheme,
          vpcId: lb.VpcId,
          subnetIds: (lb.AvailabilityZones ?? [])
            .map((z) => z.SubnetId)
            .filter((s): s is string => !!s),
          availabilityZones: (lb.AvailabilityZones ?? [])
            .map((z) => z.ZoneName)
            .filter((z): z is string => !!z),
          securityGroupIds: lb.SecurityGroups ?? [],
          dnsName: lb.DNSName,
          state: lb.State?.Code,
          listeners: [],
        });
      }
    }
  });

  // Tags come from a separate batched API (20 ARNs per call).
  await guard(errors, 'elbv2', 'DescribeTags', async () => {
    for (let i = 0; i < lbs.length; i += 20) {
      const batch = lbs.slice(i, i + 20);
      const res = await elbv2.send(
        new DescribeTagsV2Command({ ResourceArns: batch.map((l) => l.id) }),
      );
      for (const desc of res.TagDescriptions ?? []) {
        const lb = batch.find((l) => l.id === desc.ResourceArn);
        if (!lb) continue;
        const tags: Tags = {};
        for (const t of desc.Tags ?? []) {
          if (t.Key) tags[t.Key] = t.Value ?? '';
        }
        lb.tags = tags;
      }
    }
  });

  await Promise.all(
    lbs.map((lb) =>
      limit(() =>
        guard(errors, 'elbv2', `DescribeListeners(${lb.name ?? lb.id})`, async () => {
          for await (const page of paginateDescribeListeners(
            { client: elbv2 },
            { LoadBalancerArn: lb.id },
          )) {
            for (const l of page.Listeners ?? []) {
              const targetGroupArns = new Set<string>();
              for (const action of l.DefaultActions ?? []) {
                if (action.TargetGroupArn) targetGroupArns.add(action.TargetGroupArn);
                for (const tg of action.ForwardConfig?.TargetGroups ?? []) {
                  if (tg.TargetGroupArn) targetGroupArns.add(tg.TargetGroupArn);
                }
              }
              lb.listeners.push({
                port: l.Port,
                protocol: l.Protocol,
                targetGroupArns: [...targetGroupArns].sort(),
              });
            }
          }
        }),
      ),
    ),
  );
  out.loadBalancers.push(...lbs);

  await guard(errors, 'elbv2', 'DescribeTargetGroups', async () => {
    const tgs: RegionSnapshot['targetGroups'] = [];
    for await (const page of paginateDescribeTargetGroups({ client: elbv2 }, {})) {
      for (const tg of page.TargetGroups ?? []) {
        tgs.push({
          id: tg.TargetGroupArn!,
          arn: tg.TargetGroupArn,
          name: tg.TargetGroupName,
          tags: {},
          protocol: tg.Protocol,
          port: tg.Port,
          vpcId: tg.VpcId,
          targetType: tg.TargetType,
          loadBalancerArns: tg.LoadBalancerArns ?? [],
          targets: [],
        });
      }
    }
    await Promise.all(
      tgs.map((tg) =>
        limit(() =>
          guard(errors, 'elbv2', `DescribeTargetHealth(${tg.name ?? tg.id})`, async () => {
            const res = await elbv2.send(
              new DescribeTargetHealthCommand({ TargetGroupArn: tg.id }),
            );
            for (const d of res.TargetHealthDescriptions ?? []) {
              if (!d.Target?.Id) continue;
              tg.targets.push({
                targetId: d.Target.Id,
                port: d.Target.Port,
                availabilityZone: d.Target.AvailabilityZone,
                health: d.TargetHealth?.State,
              });
            }
          }),
        ),
      ),
    );
    out.targetGroups.push(...tgs);
  });

  // Classic ELBs (rare now, but cheap to include).
  await guard(errors, 'elb', 'DescribeLoadBalancers', async () => {
    const classic = ctx.client(ElasticLoadBalancingClient, region);
    for await (const page of paginateDescribeClassicLoadBalancers({ client: classic }, {})) {
      for (const lb of page.LoadBalancerDescriptions ?? []) {
        out.loadBalancers.push({
          id: lb.LoadBalancerName!,
          name: lb.LoadBalancerName,
          tags: {},
          lbType: 'classic',
          scheme: lb.Scheme,
          vpcId: lb.VPCId,
          subnetIds: lb.Subnets ?? [],
          availabilityZones: lb.AvailabilityZones ?? [],
          securityGroupIds: lb.SecurityGroups ?? [],
          dnsName: lb.DNSName,
          state: undefined,
          listeners: (lb.ListenerDescriptions ?? []).map((ld) => ({
            port: ld.Listener?.LoadBalancerPort,
            protocol: ld.Listener?.Protocol,
            targetGroupArns: [],
          })),
        });
      }
    }
  });
}
