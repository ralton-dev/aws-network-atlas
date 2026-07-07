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
  paginateDescribeClientVpnRoutes,
  paginateDescribeClientVpnAuthorizationRules,
} from '@aws-sdk/client-ec2';
import {
  NetworkFirewallClient,
  paginateListFirewalls,
  paginateListFirewallPolicies,
  paginateListRuleGroups,
  paginateListTLSInspectionConfigurations,
  DescribeFirewallCommand,
  DescribeFirewallPolicyCommand,
  DescribeRuleGroupCommand,
  DescribeLoggingConfigurationCommand,
  DescribeTLSInspectionConfigurationCommand,
  type StatelessRule,
  type StatefulRule,
} from '@aws-sdk/client-network-firewall';
import {
  APIGatewayClient,
  paginateGetRestApis,
  paginateGetVpcLinks,
  paginateGetDomainNames,
  GetStagesCommand,
  GetBasePathMappingsCommand,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client,
  GetApisCommand,
  GetStagesCommand as GetV2StagesCommand,
  GetVpcLinksCommand as GetV2VpcLinksCommand,
  GetDomainNamesCommand as GetV2DomainNamesCommand,
  GetApiMappingsCommand,
} from '@aws-sdk/client-apigatewayv2';
import pLimit from 'p-limit';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { toTags, nameTag } from '../util.js';

type ResolverEndpointOut = RegionSnapshot['resolverEndpoints'][number];
type ClientVpnEndpointOut = RegionSnapshot['clientVpnEndpoints'][number];
type ApiGatewayOut = RegionSnapshot['apiGateways'][number];
type NfwStatelessRuleOut = RegionSnapshot['networkFirewallRuleGroups'][number]['statelessRules'][number];
type NfwStatefulRuleOut = RegionSnapshot['networkFirewallRuleGroups'][number]['statefulRules'][number];

const portSpec = (p: { FromPort?: number; ToPort?: number }): string =>
  p.FromPort === p.ToPort ? String(p.FromPort ?? '') : `${p.FromPort ?? 0}-${p.ToPort ?? 65535}`;

function mapStatelessRule(rule: StatelessRule): NfwStatelessRuleOut {
  const match = rule.RuleDefinition?.MatchAttributes;
  return {
    priority: rule.Priority,
    actions: rule.RuleDefinition?.Actions ?? [],
    sources: (match?.Sources ?? []).map((s) => s.AddressDefinition).filter((s): s is string => !!s),
    destinations: (match?.Destinations ?? [])
      .map((d) => d.AddressDefinition)
      .filter((d): d is string => !!d),
    sourcePorts: (match?.SourcePorts ?? []).map(portSpec),
    destinationPorts: (match?.DestinationPorts ?? []).map(portSpec),
    protocols: match?.Protocols ?? [],
  };
}

function mapStatefulRule(rule: StatefulRule): NfwStatefulRuleOut {
  const sid = (rule.RuleOptions ?? []).find((o) => o.Keyword === 'sid')?.Settings?.[0];
  return {
    action: rule.Action,
    protocol: rule.Header?.Protocol,
    source: rule.Header?.Source,
    sourcePort: rule.Header?.SourcePort,
    direction: rule.Header?.Direction,
    destination: rule.Header?.Destination,
    destinationPort: rule.Header?.DestinationPort,
    sid,
  };
}

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
        limit(async () => {
          await guard(errors, 'ec2', `DescribeClientVpnTargetNetworks(${ep.id})`, async () => {
            for await (const page of paginateDescribeClientVpnTargetNetworks(
              { client: ec2 },
              { ClientVpnEndpointId: ep.id },
            )) {
              for (const t of page.ClientVpnTargetNetworks ?? []) {
                if (t.TargetNetworkId) ep.associatedSubnetIds.push(t.TargetNetworkId);
              }
            }
          });
          // The endpoint's own route table: what connected clients can reach.
          await guard(errors, 'ec2', `DescribeClientVpnRoutes(${ep.id})`, async () => {
            const routes: NonNullable<ClientVpnEndpointOut['routes']> = [];
            for await (const page of paginateDescribeClientVpnRoutes(
              { client: ec2 },
              { ClientVpnEndpointId: ep.id },
            )) {
              for (const r of page.Routes ?? []) {
                routes.push({
                  destinationCidr: r.DestinationCidr,
                  targetSubnet: r.TargetSubnet,
                  origin: r.Origin,
                  status: r.Status?.Code,
                  description: r.Description || undefined,
                });
              }
            }
            ep.routes = routes;
          });
          // Authorization rules: which client groups may reach which networks.
          await guard(errors, 'ec2', `DescribeClientVpnAuthorizationRules(${ep.id})`, async () => {
            const rules: NonNullable<ClientVpnEndpointOut['authorizationRules']> = [];
            for await (const page of paginateDescribeClientVpnAuthorizationRules(
              { client: ec2 },
              { ClientVpnEndpointId: ep.id },
            )) {
              for (const r of page.AuthorizationRules ?? []) {
                rules.push({
                  destinationCidr: r.DestinationCidr,
                  groupId: r.GroupId || undefined,
                  accessAll: r.AccessAll,
                  status: r.Status?.Code,
                  description: r.Description || undefined,
                });
              }
            }
            ep.authorizationRules = rules;
          });
        }),
      ),
    );
    out.clientVpnEndpoints.push(...endpoints);
  });

  // --- Network Firewall --------------------------------------------------------
  const nfw = ctx.client(NetworkFirewallClient, region);

  await guard(errors, 'network-firewall', 'ListFirewalls', async () => {
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

            // SyncStates carry the per-AZ firewall endpoints (vpce-…) that
            // inspection route tables point at — without them a route through
            // the firewall is unattributable.
            const endpoints = Object.entries(res.FirewallStatus?.SyncStates ?? {})
              .map(([az, sync]) => ({
                availabilityZone: az,
                subnetId: sync.Attachment?.SubnetId,
                endpointId: sync.Attachment?.EndpointId,
              }))
              .sort((a, b) => a.availabilityZone.localeCompare(b.availabilityZone));

            const logDestinations: NonNullable<
              RegionSnapshot['networkFirewalls'][number]['logDestinations']
            > = [];
            await guard(
              errors,
              'network-firewall',
              `DescribeLoggingConfiguration(${fw.name ?? fw.arn})`,
              async () => {
                const logRes = await nfw.send(
                  new DescribeLoggingConfigurationCommand({ FirewallArn: fw.arn }),
                );
                for (const cfg of logRes.LoggingConfiguration?.LogDestinationConfigs ?? []) {
                  // LogDestination is a string map, e.g. {bucketName}, {logGroup}, {deliveryStream}.
                  const destination = Object.values(cfg.LogDestination ?? {}).sort().join(':');
                  logDestinations.push({
                    logType: cfg.LogType,
                    destinationType: cfg.LogDestinationType,
                    destination: destination || undefined,
                  });
                }
                logDestinations.sort((a, b) =>
                  `${a.logType}|${a.destination}`.localeCompare(`${b.logType}|${b.destination}`),
                );
              },
            );

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
              endpoints,
              logDestinations,
            });
          }),
        ),
      ),
    );
  });

  // Policies and rule groups are listed independently of firewalls so that
  // unreferenced rule groups are inventoried too.
  await guard(errors, 'network-firewall', 'ListFirewallPolicies', async () => {
    const policies: Array<{ name?: string; arn: string }> = [];
    for await (const page of paginateListFirewallPolicies({ client: nfw }, {})) {
      for (const p of page.FirewallPolicies ?? []) {
        if (p.Arn) policies.push({ name: p.Name, arn: p.Arn });
      }
    }
    await Promise.all(
      policies.map((p) =>
        limit(() =>
          guard(errors, 'network-firewall', `DescribeFirewallPolicy(${p.name ?? p.arn})`, async () => {
            const res = await nfw.send(
              new DescribeFirewallPolicyCommand({ FirewallPolicyArn: p.arn }),
            );
            const meta = res.FirewallPolicyResponse;
            const policy = res.FirewallPolicy;
            out.networkFirewallPolicies.push({
              id: meta?.FirewallPolicyName ?? p.name ?? p.arn,
              arn: meta?.FirewallPolicyArn ?? p.arn,
              name: meta?.FirewallPolicyName ?? p.name,
              tags: toTags(meta?.Tags),
              description: meta?.Description,
              statelessDefaultActions: policy?.StatelessDefaultActions ?? [],
              statelessFragmentDefaultActions: policy?.StatelessFragmentDefaultActions ?? [],
              statelessRuleGroupRefs: (policy?.StatelessRuleGroupReferences ?? [])
                .filter((r) => r.ResourceArn)
                .map((r) => ({ arn: r.ResourceArn!, priority: r.Priority })),
              statefulRuleGroupRefs: (policy?.StatefulRuleGroupReferences ?? [])
                .filter((r) => r.ResourceArn)
                .map((r) => ({ arn: r.ResourceArn!, priority: r.Priority })),
              statefulDefaultActions: policy?.StatefulDefaultActions ?? [],
              statefulRuleOrder: policy?.StatefulEngineOptions?.RuleOrder,
              tlsInspectionConfigurationArn: policy?.TLSInspectionConfigurationArn,
            });
          }),
        ),
      ),
    );
  });

  await guard(errors, 'network-firewall', 'ListRuleGroups', async () => {
    const groups: Array<{ name?: string; arn: string }> = [];
    for await (const page of paginateListRuleGroups({ client: nfw }, {})) {
      for (const g of page.RuleGroups ?? []) {
        if (g.Arn) groups.push({ name: g.Name, arn: g.Arn });
      }
    }
    await Promise.all(
      groups.map((g) =>
        limit(() =>
          guard(errors, 'network-firewall', `DescribeRuleGroup(${g.name ?? g.arn})`, async () => {
            const res = await nfw.send(new DescribeRuleGroupCommand({ RuleGroupArn: g.arn }));
            const meta = res.RuleGroupResponse;
            const source = res.RuleGroup?.RulesSource;
            const domainSource = source?.RulesSourceList;
            out.networkFirewallRuleGroups.push({
              id: meta?.RuleGroupName ?? g.name ?? g.arn,
              arn: meta?.RuleGroupArn ?? g.arn,
              name: meta?.RuleGroupName ?? g.name,
              tags: toTags(meta?.Tags),
              ruleGroupType: meta?.Type,
              description: meta?.Description,
              capacity: meta?.Capacity,
              consumedCapacity: meta?.ConsumedCapacity,
              numberOfAssociations: meta?.NumberOfAssociations,
              statelessRules: (source?.StatelessRulesAndCustomActions?.StatelessRules ?? []).map(
                mapStatelessRule,
              ),
              statefulRules: (source?.StatefulRules ?? []).map(mapStatefulRule),
              rulesString: source?.RulesString,
              domainList: domainSource
                ? {
                    targets: domainSource.Targets ?? [],
                    targetTypes: domainSource.TargetTypes ?? [],
                    action: domainSource.GeneratedRulesType,
                  }
                : undefined,
            });
          }),
        ),
      ),
    );
  });

  await guard(errors, 'network-firewall', 'ListTLSInspectionConfigurations', async () => {
    const configs: Array<{ name?: string; arn: string }> = [];
    for await (const page of paginateListTLSInspectionConfigurations({ client: nfw }, {})) {
      for (const c of page.TLSInspectionConfigurations ?? []) {
        if (c.Arn) configs.push({ name: c.Name, arn: c.Arn });
      }
    }
    await Promise.all(
      configs.map((c) =>
        limit(() =>
          guard(
            errors,
            'network-firewall',
            `DescribeTLSInspectionConfiguration(${c.name ?? c.arn})`,
            async () => {
              const res = await nfw.send(
                new DescribeTLSInspectionConfigurationCommand({
                  TLSInspectionConfigurationArn: c.arn,
                }),
              );
              const meta = res.TLSInspectionConfigurationResponse;
              const certArns = new Set<string>();
              for (const cfg of res.TLSInspectionConfiguration?.ServerCertificateConfigurations ??
                []) {
                for (const cert of cfg.ServerCertificates ?? []) {
                  if (cert.ResourceArn) certArns.add(cert.ResourceArn);
                }
                if (cfg.CertificateAuthorityArn) certArns.add(cfg.CertificateAuthorityArn);
              }
              out.networkFirewallTlsConfigs.push({
                id: meta?.TLSInspectionConfigurationName ?? c.name ?? c.arn,
                arn: meta?.TLSInspectionConfigurationArn ?? c.arn,
                name: meta?.TLSInspectionConfigurationName ?? c.name,
                tags: toTags(meta?.Tags),
                description: meta?.Description,
                certificateArns: [...certArns].sort(),
              });
            },
          ),
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

  // --- API Gateway VPC links (the API ↔ VPC-interior connection) -------------------
  await guard(errors, 'apigateway', 'GetVpcLinks(v1)', async () => {
    const apigw = ctx.client(APIGatewayClient, region);
    for await (const page of paginateGetVpcLinks({ client: apigw }, {})) {
      for (const link of page.items ?? []) {
        if (!link.id) continue;
        out.apiGatewayVpcLinks.push({
          id: link.id,
          name: link.name,
          tags: link.tags ?? {},
          version: 'v1',
          status: link.status,
          targetArns: link.targetArns ?? [],
          subnetIds: [],
          securityGroupIds: [],
        });
      }
    }
  });

  await guard(errors, 'apigateway', 'GetVpcLinks(v2)', async () => {
    const apigwV2 = ctx.client(ApiGatewayV2Client, region);
    let nextToken: string | undefined;
    do {
      const res = await apigwV2.send(new GetV2VpcLinksCommand({ NextToken: nextToken }));
      for (const link of res.Items ?? []) {
        if (!link.VpcLinkId) continue;
        out.apiGatewayVpcLinks.push({
          id: link.VpcLinkId,
          name: link.Name,
          tags: link.Tags ?? {},
          version: 'v2',
          status: link.VpcLinkStatus,
          targetArns: [],
          subnetIds: link.SubnetIds ?? [],
          securityGroupIds: link.SecurityGroupIds ?? [],
        });
      }
      nextToken = res.NextToken;
    } while (nextToken);
  });

  // --- API Gateway custom domains (what DNS records actually point at) -------------
  // The v2 GetDomainNames API also returns v1-created domains, so collect v1
  // first and let the v2 pass skip names it has already seen.
  const seenDomains = new Set<string>();

  await guard(errors, 'apigateway', 'GetDomainNames(v1)', async () => {
    const apigw = ctx.client(APIGatewayClient, region);
    const domains: RegionSnapshot['apiGatewayDomainNames'] = [];
    for await (const page of paginateGetDomainNames({ client: apigw }, {})) {
      for (const d of page.items ?? []) {
        if (!d.domainName || seenDomains.has(d.domainName)) continue;
        seenDomains.add(d.domainName);
        domains.push({
          id: d.domainName,
          name: d.domainName,
          tags: d.tags ?? {},
          domainName: d.domainName,
          endpointTypes: (d.endpointConfiguration?.types ?? []) as string[],
          certificateArns: [d.certificateArn, d.regionalCertificateArn].filter(
            (c): c is string => !!c,
          ),
          mappings: [],
        });
      }
    }
    await Promise.all(
      domains.map((d) =>
        limit(() =>
          guard(errors, 'apigateway', `GetBasePathMappings(${d.domainName})`, async () => {
            const res = await apigw.send(
              new GetBasePathMappingsCommand({ domainName: d.domainName }),
            );
            d.mappings = (res.items ?? []).map((m) => ({
              apiId: m.restApiId,
              stage: m.stage,
              path: m.basePath === '(none)' ? undefined : m.basePath,
            }));
          }),
        ),
      ),
    );
    out.apiGatewayDomainNames.push(...domains);
  });

  await guard(errors, 'apigateway', 'GetDomainNames(v2)', async () => {
    const apigwV2 = ctx.client(ApiGatewayV2Client, region);
    const domains: RegionSnapshot['apiGatewayDomainNames'] = [];
    let nextToken: string | undefined;
    do {
      const res = await apigwV2.send(new GetV2DomainNamesCommand({ NextToken: nextToken }));
      for (const d of res.Items ?? []) {
        if (!d.DomainName || seenDomains.has(d.DomainName)) continue;
        seenDomains.add(d.DomainName);
        domains.push({
          id: d.DomainName,
          name: d.DomainName,
          tags: d.Tags ?? {},
          domainName: d.DomainName,
          endpointTypes: (d.DomainNameConfigurations ?? [])
            .map((c) => c.EndpointType as string | undefined)
            .filter((t): t is string => !!t),
          certificateArns: (d.DomainNameConfigurations ?? [])
            .map((c) => c.CertificateArn)
            .filter((c): c is string => !!c),
          mappings: [],
        });
      }
      nextToken = res.NextToken;
    } while (nextToken);
    await Promise.all(
      domains.map((d) =>
        limit(() =>
          guard(errors, 'apigateway', `GetApiMappings(${d.domainName})`, async () => {
            let mapToken: string | undefined;
            do {
              const res = await apigwV2.send(
                new GetApiMappingsCommand({ DomainName: d.domainName, NextToken: mapToken }),
              );
              for (const m of res.Items ?? []) {
                d.mappings.push({
                  apiId: m.ApiId,
                  stage: m.Stage,
                  path: m.ApiMappingKey || undefined,
                });
              }
              mapToken = res.NextToken;
            } while (mapToken);
          }),
        ),
      ),
    );
    out.apiGatewayDomainNames.push(...domains);
  });
}
