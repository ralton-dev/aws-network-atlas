// WAF v2 — READ-ONLY (List*/Get* only). REGIONAL scope is collected per
// region; CLOUDFRONT scope is account-global and served from us-east-1.
import {
  WAFV2Client,
  ListWebACLsCommand,
  GetWebACLCommand,
  ListResourcesForWebACLCommand,
  ListIPSetsCommand,
  GetIPSetCommand,
  ListRuleGroupsCommand,
  GetRuleGroupCommand,
  ResourceType,
  type Statement,
  type Rule,
} from '@aws-sdk/client-wafv2';
import pLimit from 'p-limit';
import type {
  AccountSnapshot,
  RegionSnapshot,
  ScanError,
  WafIpSet,
  WafRuleGroup,
  WafRuleSummary,
  WafWebAcl,
} from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

type WafScope = 'REGIONAL' | 'CLOUDFRONT';

/** Compact one WAF statement into a short descriptor for display/diffing. */
function summarizeStatement(s?: Statement): string | undefined {
  if (!s) return undefined;
  if (s.ManagedRuleGroupStatement) {
    return `managedRuleGroup:${s.ManagedRuleGroupStatement.VendorName}/${s.ManagedRuleGroupStatement.Name}`;
  }
  if (s.RuleGroupReferenceStatement) return `ruleGroup:${s.RuleGroupReferenceStatement.ARN}`;
  if (s.IPSetReferenceStatement) return `ipSet:${s.IPSetReferenceStatement.ARN}`;
  if (s.RateBasedStatement) return `rateBased:${s.RateBasedStatement.Limit}`;
  if (s.GeoMatchStatement) return `geoMatch:${(s.GeoMatchStatement.CountryCodes ?? []).join(',')}`;
  if (s.RegexPatternSetReferenceStatement) {
    return `regexSet:${s.RegexPatternSetReferenceStatement.ARN}`;
  }
  if (s.LabelMatchStatement) return `labelMatch:${s.LabelMatchStatement.Key}`;
  if (s.ByteMatchStatement) return 'byteMatch';
  if (s.SqliMatchStatement) return 'sqliMatch';
  if (s.XssMatchStatement) return 'xssMatch';
  if (s.RegexMatchStatement) return 'regexMatch';
  if (s.SizeConstraintStatement) return 'sizeConstraint';
  if (s.AndStatement) {
    return `and(${(s.AndStatement.Statements ?? []).map(summarizeStatement).join(',')})`;
  }
  if (s.OrStatement) {
    return `or(${(s.OrStatement.Statements ?? []).map(summarizeStatement).join(',')})`;
  }
  if (s.NotStatement) return `not(${summarizeStatement(s.NotStatement.Statement)})`;
  return 'other';
}

function mapWafRule(rule: Rule): WafRuleSummary {
  // A rule carries either its own Action or (for rule-group references) an
  // OverrideAction; "None" means the referenced group's own actions apply.
  let action: string | undefined;
  if (rule.Action) action = Object.keys(rule.Action)[0]?.toUpperCase();
  else if (rule.OverrideAction) {
    action = rule.OverrideAction.None ? 'use-rule-group-actions' : 'COUNT';
  }
  return {
    name: rule.Name ?? '',
    priority: rule.Priority,
    action,
    statement: summarizeStatement(rule.Statement),
  };
}

/** Resource types that can carry a REGIONAL web ACL association. */
const ASSOCIABLE_TYPES = [
  ResourceType.APPLICATION_LOAD_BALANCER,
  ResourceType.API_GATEWAY,
  ResourceType.APPSYNC,
  // Sic: the SDK enum key carries AWS's own typo; the value is correct.
  ResourceType.COGNITIO_USER_POOL,
] as const;

async function collectScope(
  client: WAFV2Client,
  scope: WafScope,
  outAcls: WafWebAcl[],
  outIpSets: WafIpSet[],
  outRuleGroups: WafRuleGroup[],
  errors: ScanError[],
): Promise<void> {
  const limit = pLimit(4);

  await guard(errors, 'wafv2', `ListWebACLs(${scope})`, async () => {
    const acls: Array<{ name: string; id: string; arn?: string }> = [];
    let marker: string | undefined;
    do {
      const res = await client.send(
        new ListWebACLsCommand({ Scope: scope, NextMarker: marker }),
      );
      for (const acl of res.WebACLs ?? []) {
        if (acl.Name && acl.Id) acls.push({ name: acl.Name, id: acl.Id, arn: acl.ARN });
      }
      marker = res.NextMarker && (res.WebACLs ?? []).length > 0 ? res.NextMarker : undefined;
    } while (marker);

    await Promise.all(
      acls.map((acl) =>
        limit(() =>
          guard(errors, 'wafv2', `GetWebACL(${acl.name})`, async () => {
            const res = await client.send(
              new GetWebACLCommand({ Name: acl.name, Id: acl.id, Scope: scope }),
            );
            const detail = res.WebACL;

            // Which resources the ACL protects. Only REGIONAL associations are
            // queryable; CLOUDFRONT associations live on the distribution
            // (CloudFrontDistribution.webAclId).
            const associated: string[] = [];
            if (scope === 'REGIONAL' && detail?.ARN) {
              for (const resourceType of ASSOCIABLE_TYPES) {
                await guard(
                  errors,
                  'wafv2',
                  `ListResourcesForWebACL(${acl.name},${resourceType})`,
                  async () => {
                    const assocRes = await client.send(
                      new ListResourcesForWebACLCommand({
                        WebACLArn: detail.ARN!,
                        ResourceType: resourceType,
                      }),
                    );
                    associated.push(...(assocRes.ResourceArns ?? []));
                  },
                );
              }
            }

            outAcls.push({
              id: detail?.Id ?? acl.id,
              arn: detail?.ARN ?? acl.arn,
              name: detail?.Name ?? acl.name,
              tags: {},
              scope,
              description: detail?.Description || undefined,
              defaultAction: detail?.DefaultAction
                ? Object.keys(detail.DefaultAction)[0]?.toUpperCase()
                : undefined,
              capacity: detail?.Capacity ? Number(detail.Capacity) : undefined,
              rules: (detail?.Rules ?? [])
                .map(mapWafRule)
                .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)),
              associatedResourceArns: associated.sort(),
            });
          }),
        ),
      ),
    );
  });

  await guard(errors, 'wafv2', `ListIPSets(${scope})`, async () => {
    const sets: Array<{ name: string; id: string; arn?: string }> = [];
    let marker: string | undefined;
    do {
      const res = await client.send(new ListIPSetsCommand({ Scope: scope, NextMarker: marker }));
      for (const set of res.IPSets ?? []) {
        if (set.Name && set.Id) sets.push({ name: set.Name, id: set.Id, arn: set.ARN });
      }
      marker = res.NextMarker && (res.IPSets ?? []).length > 0 ? res.NextMarker : undefined;
    } while (marker);

    await Promise.all(
      sets.map((set) =>
        limit(() =>
          guard(errors, 'wafv2', `GetIPSet(${set.name})`, async () => {
            const res = await client.send(
              new GetIPSetCommand({ Name: set.name, Id: set.id, Scope: scope }),
            );
            outIpSets.push({
              id: res.IPSet?.Id ?? set.id,
              arn: res.IPSet?.ARN ?? set.arn,
              name: res.IPSet?.Name ?? set.name,
              tags: {},
              scope,
              description: res.IPSet?.Description || undefined,
              ipAddressVersion: res.IPSet?.IPAddressVersion,
              addresses: [...(res.IPSet?.Addresses ?? [])].sort(),
            });
          }),
        ),
      ),
    );
  });

  await guard(errors, 'wafv2', `ListRuleGroups(${scope})`, async () => {
    const groups: Array<{ name: string; id: string; arn?: string }> = [];
    let marker: string | undefined;
    do {
      const res = await client.send(
        new ListRuleGroupsCommand({ Scope: scope, NextMarker: marker }),
      );
      for (const g of res.RuleGroups ?? []) {
        if (g.Name && g.Id) groups.push({ name: g.Name, id: g.Id, arn: g.ARN });
      }
      marker = res.NextMarker && (res.RuleGroups ?? []).length > 0 ? res.NextMarker : undefined;
    } while (marker);

    await Promise.all(
      groups.map((g) =>
        limit(() =>
          guard(errors, 'wafv2', `GetRuleGroup(${g.name})`, async () => {
            const res = await client.send(
              new GetRuleGroupCommand({ Name: g.name, Id: g.id, Scope: scope }),
            );
            outRuleGroups.push({
              id: res.RuleGroup?.Id ?? g.id,
              arn: res.RuleGroup?.ARN ?? g.arn,
              name: res.RuleGroup?.Name ?? g.name,
              tags: {},
              scope,
              description: res.RuleGroup?.Description || undefined,
              capacity: res.RuleGroup?.Capacity ? Number(res.RuleGroup.Capacity) : undefined,
              rules: (res.RuleGroup?.Rules ?? [])
                .map(mapWafRule)
                .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)),
            });
          }),
        ),
      ),
    );
  });
}

/** REGIONAL-scope WAF (protects ALBs, API Gateways, AppSync, Cognito) for one region. */
export async function collectWaf(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(WAFV2Client, region);
  await collectScope(client, 'REGIONAL', out.wafWebAcls, out.wafIpSets, out.wafRuleGroups, out.errors);
}

/**
 * CLOUDFRONT-scope WAF, collected once per account. The API only answers from
 * us-east-1; in partitions without it (GovCloud/China) the guard records the
 * failure and moves on.
 */
export async function collectWafCloudFront(
  ctx: AwsContext,
  out: AccountSnapshot['global'],
): Promise<void> {
  const client = ctx.client(WAFV2Client, 'us-east-1');
  await collectScope(client, 'CLOUDFRONT', out.wafWebAcls, out.wafIpSets, out.wafRuleGroups, out.errors);
}
