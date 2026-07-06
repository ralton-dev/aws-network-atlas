// Additional network services (regional): Route 53 Resolver, Client VPN,
// Network Firewall, API Gateway — READ-ONLY (List*/Get*/Describe* only).
import {
  Route53ResolverClient,
  paginateListResolverEndpoints,
  paginateListResolverRules,
  paginateListResolverRuleAssociations,
  paginateListResolverEndpointIpAddresses,
} from '@aws-sdk/client-route53resolver';
import {
  EC2Client,
  paginateDescribeClientVpnEndpoints,
  paginateDescribeClientVpnTargetNetworks,
} from '@aws-sdk/client-ec2';
import {
  NetworkFirewallClient,
  paginateListFirewalls,
  DescribeFirewallCommand,
} from '@aws-sdk/client-network-firewall';
import {
  APIGatewayClient,
  paginateGetRestApis,
  GetStagesCommand,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client,
  GetApisCommand,
  GetStagesCommand as GetV2StagesCommand,
} from '@aws-sdk/client-apigatewayv2';
import pLimit from 'p-limit';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { toTags, nameTag } from '../util.js';

type ResolverEndpointOut = RegionSnapshot['resolverEndpoints'][number];
type ClientVpnEndpointOut = RegionSnapshot['clientVpnEndpoints'][number];
type ApiGatewayOut = RegionSnapshot['apiGateways'][number];

/**
 * Collect the "edge" network services for one region: Route 53 Resolver
 * endpoints/rules, Client VPN endpoints, Network Firewalls, and API Gateways
 * (REST v1 + HTTP/WebSocket v2).
 */
export async function collectEdgeNetwork(
  ctx: AwsContext,
  region: string,
  _accountId: string,
  out: RegionSnapshot,
): Promise<void> {
  const errors = out.errors;
  const limit = pLimit(4);

  // --- Route 53 Resolver -----------------------------------------------------
  const resolver = ctx.client(Route53ResolverClient, region);

  await guard(errors, 'route53resolver', 'ListResolverEndpoints', async () => {
    const endpoints: ResolverEndpointOut[] = [];
    for await (const page of paginateListResolverEndpoints({ client: resolver }, {})) {
      for (const ep of page.ResolverEndpoints ?? []) {
        if (!ep.Id) continue;
        endpoints.push({
          id: ep.Id,
          arn: ep.Arn,
          name: ep.Name,
          tags: {},
          direction: ep.Direction,
          vpcId: ep.HostVPCId,
          // Filled from ListResolverEndpointIpAddresses below.
          subnetIds: [],
          ipAddresses: [],
          securityGroupIds: ep.SecurityGroupIds ?? [],
          status: ep.Status,
        });
      }
    }
    await Promise.all(
      endpoints.map((ep) =>
        limit(() =>
          guard(errors, 'route53resolver', `ListResolverEndpointIpAddresses(${ep.id})`, async () => {
            for await (const page of paginateListResolverEndpointIpAddresses(
              { client: resolver },
              { ResolverEndpointId: ep.id },
            )) {
              for (const ip of page.IpAddresses ?? []) {
                if (ip.Ip) ep.ipAddresses.push(ip.Ip);
                if (ip.SubnetId && !ep.subnetIds.includes(ip.SubnetId)) ep.subnetIds.push(ip.SubnetId);
              }
            }
          }),
        ),
      ),
    );
    out.resolverEndpoints.push(...endpoints);
  });

  await guard(errors, 'route53resolver', 'ListResolverRules', async () => {
    // Rule id -> associated VPC ids (associations are listed separately).
    const vpcsByRule = new Map<string, string[]>();
    await guard(errors, 'route53resolver', 'ListResolverRuleAssociations', async () => {
      for await (const page of paginateListResolverRuleAssociations({ client: resolver }, {})) {
        for (const assoc of page.ResolverRuleAssociations ?? []) {
          if (!assoc.ResolverRuleId || !assoc.VPCId) continue;
          const list = vpcsByRule.get(assoc.ResolverRuleId) ?? [];
          list.push(assoc.VPCId);
          vpcsByRule.set(assoc.ResolverRuleId, list);
        }
      }
    });
    for await (const page of paginateListResolverRules({ client: resolver }, {})) {
      for (const rule of page.ResolverRules ?? []) {
        if (!rule.Id) continue;
        out.resolverRules.push({
          id: rule.Id,
          arn: rule.Arn,
          name: rule.Name,
          tags: {},
          domainName: rule.DomainName,
          ruleType: rule.RuleType,
          resolverEndpointId: rule.ResolverEndpointId,
          targetIps: (rule.TargetIps ?? []).map((t) => t.Ip).filter((ip): ip is string => !!ip),
          vpcAssociationIds: vpcsByRule.get(rule.Id) ?? [],
          shareStatus: rule.ShareStatus,
        });
      }
    }
  });

  // --- Client VPN ------------------------------------------------------------
  const ec2 = ctx.client(EC2Client, region);

  await guard(errors, 'ec2', 'DescribeClientVpnEndpoints', async () => {
    const endpoints: ClientVpnEndpointOut[] = [];
    for await (const page of paginateDescribeClientVpnEndpoints({ client: ec2 }, {})) {
      for (const ep of page.ClientVpnEndpoints ?? []) {
        if (!ep.ClientVpnEndpointId) continue;
        const tags = toTags(ep.Tags);
        endpoints.push({
          id: ep.ClientVpnEndpointId,
          name: nameTag(tags),
          tags,
          description: ep.Description,
          vpcId: ep.VpcId,
          clientCidrBlock: ep.ClientCidrBlock,
          dnsServers: ep.DnsServers ?? [],
          securityGroupIds: ep.SecurityGroupIds ?? [],
          // Filled from DescribeClientVpnTargetNetworks below.
          associatedSubnetIds: [],
          status: ep.Status?.Code,
          splitTunnel: ep.SplitTunnel,
        });
      }
    }
    await Promise.all(
      endpoints.map((ep) =>
        limit(() =>
          guard(errors, 'ec2', `DescribeClientVpnTargetNetworks(${ep.id})`, async () => {
            for await (const page of paginateDescribeClientVpnTargetNetworks(
              { client: ec2 },
              { ClientVpnEndpointId: ep.id },
            )) {
              for (const t of page.ClientVpnTargetNetworks ?? []) {
                if (t.TargetNetworkId) ep.associatedSubnetIds.push(t.TargetNetworkId);
              }
            }
          }),
        ),
      ),
    );
    out.clientVpnEndpoints.push(...endpoints);
  });

  // --- Network Firewall --------------------------------------------------------
  await guard(errors, 'network-firewall', 'ListFirewalls', async () => {
    const nfw = ctx.client(NetworkFirewallClient, region);
    const firewalls: Array<{ name?: string; arn: string }> = [];
    for await (const page of paginateListFirewalls({ client: nfw }, {})) {
      for (const fw of page.Firewalls ?? []) {
        if (fw.FirewallArn) firewalls.push({ name: fw.FirewallName, arn: fw.FirewallArn });
      }
    }
    await Promise.all(
      firewalls.map((fw) =>
        limit(() =>
          guard(errors, 'network-firewall', `DescribeFirewall(${fw.name ?? fw.arn})`, async () => {
            const res = await nfw.send(new DescribeFirewallCommand({ FirewallArn: fw.arn }));
            const detail = res.Firewall;
            out.networkFirewalls.push({
              id: detail?.FirewallName ?? fw.name ?? fw.arn,
              arn: detail?.FirewallArn ?? fw.arn,
              name: detail?.FirewallName ?? fw.name,
              tags: toTags(detail?.Tags),
              vpcId: detail?.VpcId,
              subnetIds: (detail?.SubnetMappings ?? [])
                .map((m) => m.SubnetId)
                .filter((s): s is string => !!s),
              firewallPolicyArn: detail?.FirewallPolicyArn,
              deleteProtection: detail?.DeleteProtection,
              status: res.FirewallStatus?.Status,
            });
          }),
        ),
      ),
    );
  });

  // --- API Gateway (REST v1) -----------------------------------------------------
  await guard(errors, 'apigateway', 'GetRestApis', async () => {
    const apigw = ctx.client(APIGatewayClient, region);
    const apis: ApiGatewayOut[] = [];
    for await (const page of paginateGetRestApis({ client: apigw }, {})) {
      for (const api of page.items ?? []) {
        if (!api.id) continue;
        apis.push({
          id: api.id,
          name: api.name,
          tags: api.tags ?? {},
          protocolType: 'REST',
          endpointType: api.endpointConfiguration?.types?.[0],
          apiEndpoint: `https://${api.id}.execute-api.${region}.amazonaws.com`,
          // Filled from GetStages below.
          stages: [],
          vpcEndpointIds: api.endpointConfiguration?.vpcEndpointIds ?? [],
        });
      }
    }
    await Promise.all(
      apis.map((api) =>
        limit(() =>
          guard(errors, 'apigateway', `GetStages(${api.id})`, async () => {
            const res = await apigw.send(new GetStagesCommand({ restApiId: api.id }));
            api.stages = (res.item ?? []).map((s) => s.stageName).filter((n): n is string => !!n);
          }),
        ),
      ),
    );
    out.apiGateways.push(...apis);
  });

  // --- API Gateway v2 (HTTP / WebSocket) ------------------------------------------
  await guard(errors, 'apigateway', 'GetApis', async () => {
    const apigwV2 = ctx.client(ApiGatewayV2Client, region);
    const apis: ApiGatewayOut[] = [];
    let nextToken: string | undefined;
    do {
      const res = await apigwV2.send(new GetApisCommand({ NextToken: nextToken }));
      for (const api of res.Items ?? []) {
        if (!api.ApiId) continue;
        apis.push({
          id: api.ApiId,
          name: api.Name,
          tags: api.Tags ?? {},
          protocolType: api.ProtocolType,
          endpointType: undefined,
          apiEndpoint: api.ApiEndpoint,
          // Filled from GetStages below.
          stages: [],
          vpcEndpointIds: [],
        });
      }
      nextToken = res.NextToken;
    } while (nextToken);
    await Promise.all(
      apis.map((api) =>
        limit(() =>
          guard(errors, 'apigateway', `GetStages(${api.id})`, async () => {
            let stagesToken: string | undefined;
            do {
              const res = await apigwV2.send(
                new GetV2StagesCommand({ ApiId: api.id, NextToken: stagesToken }),
              );
              for (const s of res.Items ?? []) {
                if (s.StageName) api.stages.push(s.StageName);
              }
              stagesToken = res.NextToken;
            } while (stagesToken);
          }),
        ),
      ),
    );
    out.apiGateways.push(...apis);
  });
}
