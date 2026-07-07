// EventBridge (buses/rules/targets), EventBridge Pipes, and EventBridge
// Scheduler — READ-ONLY (List*/Describe*/Get* only).
// Buses carry a resource policy (cross-account event delivery); rules carry
// the event pattern/schedule and their target ARNs (cross-account and
// cross-region reach). Pipes stitch source → enrichment → target ARNs and
// can be VPC-attached (self-managed Kafka). Schedules fire at a target ARN
// via a role — more cross-account reach the tag sweep can't see.
import {
  EventBridgeClient,
  DescribeEventBusCommand,
  ListEventBusesCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
} from '@aws-sdk/client-eventbridge';
import { PipesClient, DescribePipeCommand, paginateListPipes } from '@aws-sdk/client-pipes';
import {
  SchedulerClient,
  GetScheduleCommand,
  paginateListScheduleGroups,
  paginateListSchedules,
} from '@aws-sdk/client-scheduler';
import type { EventBus, RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Per-bus rule cap so a rule-heavy bus can't stall the scan. */
const MAX_RULES_PER_BUS = 200;

/** Per-rule target cap (the API itself allows at most 5, but stay defensive). */
const MAX_TARGETS_PER_RULE = 100;

/** Per-region schedule cap (across all schedule groups). */
const MAX_SCHEDULES = 500;

export async function collectEventBridge(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'eventbridge', 'ListEventBuses', async () => {
    const client = ctx.client(EventBridgeClient, region);

    // No paginate* helper exists for the EventBridge client — NextToken loops.
    let busesToken: string | undefined;
    do {
      const busPage = await client.send(new ListEventBusesCommand({ NextToken: busesToken }));
      busesToken = busPage.NextToken;

      for (const bus of busPage.EventBuses ?? []) {
        const busName = bus.Name;
        if (!busName) continue;

        // DescribeEventBus carries the resource policy (cross-account) — a
        // per-bus failure must not lose the bus itself.
        let policy: string | undefined;
        let busArn = bus.Arn;
        try {
          const detail = await client.send(new DescribeEventBusCommand({ Name: busName }));
          policy = detail.Policy || undefined;
          busArn = detail.Arn ?? busArn;
        } catch {
          // keep the ListEventBuses-level fields
        }

        const rules: EventBus['rules'] = [];
        let rulesTruncated = false;
        let rulesToken: string | undefined;
        rulePaging: do {
          const rulePage = await client.send(
            new ListRulesCommand({ EventBusName: busName, NextToken: rulesToken }),
          );
          rulesToken = rulePage.NextToken;

          for (const rule of rulePage.Rules ?? []) {
            const ruleName = rule.Name;
            if (!ruleName) continue;
            if (rules.length >= MAX_RULES_PER_BUS) {
              rulesTruncated = true;
              break rulePaging;
            }

            // ListRules already returns state/schedule/pattern/role — no
            // DescribeRule needed. Only the targets need their own call.
            const targets: EventBus['rules'][number]['targets'] = [];
            let targetsTruncated = false;
            try {
              let targetsToken: string | undefined;
              targetPaging: do {
                const targetPage = await client.send(
                  new ListTargetsByRuleCommand({
                    Rule: ruleName,
                    EventBusName: busName,
                    NextToken: targetsToken,
                  }),
                );
                targetsToken = targetPage.NextToken;
                for (const target of targetPage.Targets ?? []) {
                  if (targets.length >= MAX_TARGETS_PER_RULE) {
                    targetsTruncated = true;
                    break targetPaging;
                  }
                  targets.push({ id: target.Id, arn: target.Arn, roleArn: target.RoleArn });
                }
              } while (targetsToken);
            } catch {
              // a per-rule target failure must not lose the rule itself
            }
            if (targetsTruncated) {
              out.errors.push({
                service: 'eventbridge',
                operation: 'ListTargetsByRule truncated',
                message: `stopped after ${MAX_TARGETS_PER_RULE} targets on rule ${ruleName} (bus ${busName}); target list is incomplete`,
              });
            }

            rules.push({
              name: ruleName,
              state: rule.State,
              scheduleExpression: rule.ScheduleExpression || undefined,
              eventPatternPresent: rule.EventPattern !== undefined ? true : undefined,
              roleArn: rule.RoleArn,
              targets,
            });
          }
        } while (rulesToken);
        if (rulesTruncated) {
          out.errors.push({
            service: 'eventbridge',
            operation: 'ListRules truncated',
            message: `stopped after ${MAX_RULES_PER_BUS} rules on bus ${busName}; rule list is incomplete`,
          });
        }

        out.eventBuses.push({
          id: busName,
          arn: busArn,
          name: busName,
          // Tags need a separate ListTagsForResource per bus — skipped.
          tags: {},
          policy,
          rules,
        });
      }
    } while (busesToken);
  });
}

export async function collectPipes(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'pipes', 'ListPipes', async () => {
    const client = ctx.client(PipesClient, region);

    for await (const page of paginateListPipes({ client }, {})) {
      for (const summary of page.Pipes ?? []) {
        const pipeName = summary.Name;
        if (!pipeName) continue;

        const detail = await client.send(new DescribePipeCommand({ Name: pipeName }));
        const kafkaVpc = detail.SourceParameters?.SelfManagedKafkaParameters?.Vpc;

        out.eventBridgePipes.push({
          id: pipeName,
          arn: detail.Arn ?? summary.Arn,
          name: pipeName,
          // Tags need a separate ListTagsForResource per pipe — skipped.
          tags: {},
          state: detail.CurrentState ?? detail.DesiredState,
          roleArn: detail.RoleArn,
          source: detail.Source,
          enrichment: detail.Enrichment,
          target: detail.Target,
          // Self-managed Kafka is the one VPC-attached pipe source.
          vpcSubnetIds: kafkaVpc?.Subnets ?? [],
          vpcSecurityGroups: kafkaVpc?.SecurityGroup ?? [],
        });
      }
    }
  });
}

export async function collectScheduler(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'scheduler', 'ListScheduleGroups', async () => {
    const client = ctx.client(SchedulerClient, region);

    let count = 0;
    let truncated = false;
    groupPaging: for await (const groupPage of paginateListScheduleGroups({ client }, {})) {
      for (const group of groupPage.ScheduleGroups ?? []) {
        const groupName = group.Name;
        if (!groupName) continue;

        for await (const page of paginateListSchedules({ client }, { GroupName: groupName })) {
          for (const summary of page.Schedules ?? []) {
            const scheduleName = summary.Name;
            if (!scheduleName) continue;
            if (count >= MAX_SCHEDULES) {
              truncated = true;
              break groupPaging;
            }
            count++;

            // GetSchedule carries the expression/state/KMS/target — a
            // per-schedule failure must not lose the rest of the group.
            let schedule: {
              arn?: string;
              state?: string;
              scheduleExpression?: string;
              kmsKeyArn?: string;
              targetArn?: string;
              targetRoleArn?: string;
            } = { arn: summary.Arn, state: summary.State, targetArn: summary.Target?.Arn };
            try {
              const detail = await client.send(
                new GetScheduleCommand({ Name: scheduleName, GroupName: groupName }),
              );
              schedule = {
                arn: detail.Arn ?? summary.Arn,
                state: detail.State ?? summary.State,
                scheduleExpression: detail.ScheduleExpression,
                kmsKeyArn: detail.KmsKeyArn,
                targetArn: detail.Target?.Arn ?? summary.Target?.Arn,
                targetRoleArn: detail.Target?.RoleArn,
              };
            } catch {
              // keep the ListSchedules-level fields
            }

            out.eventBridgeSchedules.push({
              id: scheduleName,
              arn: schedule.arn,
              name: scheduleName,
              // Tags need a separate ListTagsForResource per schedule — skipped.
              tags: {},
              groupName,
              state: schedule.state,
              scheduleExpression: schedule.scheduleExpression,
              kmsKeyArn: schedule.kmsKeyArn,
              targetArn: schedule.targetArn,
              targetRoleArn: schedule.targetRoleArn,
            });
          }
        }
      }
    }
    if (truncated) {
      out.errors.push({
        service: 'scheduler',
        operation: 'ListSchedules truncated',
        message: `stopped after ${MAX_SCHEDULES} schedules; results for this region are incomplete`,
      });
    }
  });
}
