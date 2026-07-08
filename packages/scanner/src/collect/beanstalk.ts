// Elastic Beanstalk — READ-ONLY (Describe* only).
// Environments are VPC-ATTACHED, but the vpc/subnets/security groups are
// buried in the environment's configuration OptionSettings (namespaced
// key/value pairs with comma-separated list values) rather than on the
// environment itself — DescribeConfigurationSettings digs them out, plus
// app name, status, health, tier, CNAME, and solution stack.
import {
  ElasticBeanstalkClient,
  DescribeEnvironmentsCommand,
  DescribeConfigurationSettingsCommand,
  type ConfigurationOptionSetting,
} from '@aws-sdk/client-elastic-beanstalk';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Split a comma-separated OptionSettings value into trimmed, non-empty parts. */
function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function collectBeanstalk(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'elasticbeanstalk', 'DescribeEnvironments', async () => {
    const client = ctx.client(ElasticBeanstalkClient, region);

    let nextToken: string | undefined;
    do {
      const page = await client.send(
        new DescribeEnvironmentsCommand({ IncludeDeleted: false, NextToken: nextToken }),
      );
      nextToken = page.NextToken;

      for (const env of page.Environments ?? []) {
        const envId = env.EnvironmentId;
        if (!envId) continue;

        // A per-environment failure must not lose the rest of the page.
        try {
          // The VPC posture lives in configuration OptionSettings.
          // DescribeConfigurationSettings is per-env with low throttle limits
          // and a large payload — its failure must not lose the environment.
          let options: ConfigurationOptionSetting[] = [];
          try {
            const config = await client.send(
              new DescribeConfigurationSettingsCommand({
                ApplicationName: env.ApplicationName,
                EnvironmentName: env.EnvironmentName,
              }),
            );
            options = config.ConfigurationSettings?.[0]?.OptionSettings ?? [];
          } catch {
            // keep the environment with empty VPC fields
          }

          const opt = (namespace: string, name: string): string | undefined =>
            options.find((o) => o.Namespace === namespace && o.OptionName === name)?.Value;

          out.beanstalkEnvironments.push({
            id: envId,
            arn: env.EnvironmentArn,
            name: env.EnvironmentName ?? envId,
            // Tags require a separate ListTagsForResource per env; the
            // detailed key/value sweep already covers tagged environments — skipped.
            tags: {},
            applicationName: env.ApplicationName,
            status: env.Status,
            health: env.Health,
            tier: env.Tier?.Name,
            cname: env.CNAME,
            solutionStackName: env.SolutionStackName,
            vpcId: opt('aws:ec2:vpc', 'VPCId'),
            subnetIds: [
              ...new Set([...csv(opt('aws:ec2:vpc', 'Subnets')), ...csv(opt('aws:ec2:vpc', 'ELBSubnets'))]),
            ],
            securityGroupIds: [
              ...new Set([
                ...csv(opt('aws:autoscaling:launchconfiguration', 'SecurityGroups')),
                ...csv(opt('aws:elbv2:loadbalancer', 'SecurityGroups')),
                ...csv(opt('aws:elb:loadbalancer', 'SecurityGroups')),
              ]),
            ],
            elbScheme: opt('aws:ec2:vpc', 'ELBScheme'),
          });
        } catch {
          // keep the DescribeEnvironments-level fields
          out.beanstalkEnvironments.push({
            id: envId,
            arn: env.EnvironmentArn,
            name: env.EnvironmentName ?? envId,
            tags: {},
            applicationName: env.ApplicationName,
            status: env.Status,
            health: env.Health,
            tier: env.Tier?.Name,
            cname: env.CNAME,
            solutionStackName: env.SolutionStackName,
            subnetIds: [],
            securityGroupIds: [],
          });
        }
      }
    } while (nextToken);
  });
}
