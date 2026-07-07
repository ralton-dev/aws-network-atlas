// Route 53 Resolver DNS Firewall + query logging — READ-ONLY (List* only).
// The "other" rules engine next to Network Firewall: domain-level filtering
// applied per VPC.
import {
  Route53ResolverClient,
  paginateListFirewallRuleGroups,
  paginateListFirewallRules,
  paginateListFirewallRuleGroupAssociations,
  paginateListFirewallDomainLists,
  paginateListFirewallDomains,
  paginateListResolverQueryLogConfigs,
  paginateListResolverQueryLogConfigAssociations,
} from '@aws-sdk/client-route53resolver';
import pLimit from 'p-limit';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Cap on domains expanded per domain list — enough to show intent, diff-safe. */
const MAX_DOMAINS_PER_LIST = 100;

export async function collectDnsFirewall(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const errors = out.errors;
  const resolver = ctx.client(Route53ResolverClient, region);
  const limit = pLimit(4);

  await guard(errors, 'route53resolver', 'ListFirewallRuleGroups', async () => {
    // Domain list id -> {name, domains}; AWS-managed lists are not expanded
    // (they're huge and their content is AWS's, not this account's).
    const domainLists = new Map<string, { name?: string; managed: boolean; domains: string[] }>();
    await guard(errors, 'route53resolver', 'ListFirewallDomainLists', async () => {
      for await (const page of paginateListFirewallDomainLists({ client: resolver }, {})) {
        for (const dl of page.FirewallDomainLists ?? []) {
          if (!dl.Id) continue;
          domainLists.set(dl.Id, {
            name: dl.Name,
            managed: !!dl.ManagedOwnerName,
            domains: [],
          });
        }
      }
      await Promise.all(
        [...domainLists.entries()]
          .filter(([, v]) => !v.managed)
          .map(([id, v]) =>
            limit(() =>
              guard(errors, 'route53resolver', `ListFirewallDomains(${v.name ?? id})`, async () => {
                paging: for await (const page of paginateListFirewallDomains(
                  { client: resolver },
                  { FirewallDomainListId: id },
                )) {
                  for (const domain of page.Domains ?? []) {
                    if (v.domains.length >= MAX_DOMAINS_PER_LIST) break paging;
                    v.domains.push(domain);
                  }
                }
                v.domains.sort();
              }),
            ),
          ),
      );
    });

    // Rule group id -> VPC associations.
    const assocsByGroup = new Map<
      string,
      Array<{ vpcId: string; priority?: number; mutationProtection?: string }>
    >();
    await guard(errors, 'route53resolver', 'ListFirewallRuleGroupAssociations', async () => {
      for await (const page of paginateListFirewallRuleGroupAssociations({ client: resolver }, {})) {
        for (const assoc of page.FirewallRuleGroupAssociations ?? []) {
          if (!assoc.FirewallRuleGroupId || !assoc.VpcId) continue;
          const list = assocsByGroup.get(assoc.FirewallRuleGroupId) ?? [];
          list.push({
            vpcId: assoc.VpcId,
            priority: assoc.Priority,
            mutationProtection: assoc.MutationProtection,
          });
          assocsByGroup.set(assoc.FirewallRuleGroupId, list);
        }
      }
    });

    const groups: RegionSnapshot['dnsFirewallRuleGroups'] = [];
    for await (const page of paginateListFirewallRuleGroups({ client: resolver }, {})) {
      for (const g of page.FirewallRuleGroups ?? []) {
        if (!g.Id) continue;
        groups.push({
          id: g.Id,
          arn: g.Arn,
          name: g.Name,
          tags: {},
          status: undefined,
          ruleCount: undefined,
          shareStatus: g.ShareStatus,
          rules: [],
          vpcAssociations: (assocsByGroup.get(g.Id) ?? []).sort((a, b) =>
            a.vpcId.localeCompare(b.vpcId),
          ),
        });
      }
    }
    await Promise.all(
      groups.map((g) =>
        limit(() =>
          guard(errors, 'route53resolver', `ListFirewallRules(${g.name ?? g.id})`, async () => {
            for await (const page of paginateListFirewallRules(
              { client: resolver },
              { FirewallRuleGroupId: g.id },
            )) {
              for (const r of page.FirewallRules ?? []) {
                const dl = r.FirewallDomainListId
                  ? domainLists.get(r.FirewallDomainListId)
                  : undefined;
                g.rules.push({
                  name: r.Name,
                  priority: r.Priority,
                  action: r.Action,
                  blockResponse: r.BlockResponse,
                  firewallDomainListId: r.FirewallDomainListId,
                  domainListName: dl?.name,
                  domains: dl?.domains ?? [],
                });
              }
            }
            g.rules.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
            g.ruleCount = g.rules.length;
          }),
        ),
      ),
    );
    out.dnsFirewallRuleGroups.push(...groups);
  });

  await guard(errors, 'route53resolver', 'ListResolverQueryLogConfigs', async () => {
    // Config id -> VPC ids whose queries it logs.
    const vpcsByConfig = new Map<string, string[]>();
    await guard(errors, 'route53resolver', 'ListResolverQueryLogConfigAssociations', async () => {
      for await (const page of paginateListResolverQueryLogConfigAssociations(
        { client: resolver },
        {},
      )) {
        for (const assoc of page.ResolverQueryLogConfigAssociations ?? []) {
          if (!assoc.ResolverQueryLogConfigId || !assoc.ResourceId) continue;
          const list = vpcsByConfig.get(assoc.ResolverQueryLogConfigId) ?? [];
          list.push(assoc.ResourceId);
          vpcsByConfig.set(assoc.ResolverQueryLogConfigId, list);
        }
      }
    });
    for await (const page of paginateListResolverQueryLogConfigs({ client: resolver }, {})) {
      for (const cfg of page.ResolverQueryLogConfigs ?? []) {
        if (!cfg.Id) continue;
        out.resolverQueryLogConfigs.push({
          id: cfg.Id,
          arn: cfg.Arn,
          name: cfg.Name,
          tags: {},
          destinationArn: cfg.DestinationArn,
          status: cfg.Status,
          shareStatus: cfg.ShareStatus,
          vpcIds: (vpcsByConfig.get(cfg.Id) ?? []).sort(),
        });
      }
    }
  });
}
