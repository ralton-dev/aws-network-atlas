import type {
  GenericResource,
  NetworkAclEntry,
  RegionSnapshot,
  Route,
  ScanError,
  SecurityGroupRule,
  TransitGatewayRoute,
} from '@atlas/schema';
import { sortById } from './util.js';

const str = (v: string | number | undefined): string => (v === undefined ? '' : String(v));

function sortRoutes(routes: Route[]): void {
  routes.sort((a, b) =>
    `${str(a.destinationCidr)}|${str(a.destinationIpv6Cidr)}|${str(a.destinationPrefixListId)}|${a.targetId}`.localeCompare(
      `${str(b.destinationCidr)}|${str(b.destinationIpv6Cidr)}|${str(b.destinationPrefixListId)}|${b.targetId}`,
    ),
  );
}

function sgRuleKey(r: SecurityGroupRule): string {
  return [
    r.protocol,
    str(r.fromPort),
    str(r.toPort),
    r.cidrs.join(','),
    r.ipv6Cidrs.join(','),
    r.prefixListIds.join(','),
    r.securityGroupRefs.map((g) => g.groupId).join(','),
  ].join('|');
}

function sortSgRules(rules: SecurityGroupRule[]): void {
  for (const r of rules) {
    r.cidrs.sort();
    r.ipv6Cidrs.sort();
    r.prefixListIds.sort();
    r.securityGroupRefs.sort((a, b) => a.groupId.localeCompare(b.groupId));
  }
  rules.sort((a, b) => sgRuleKey(a).localeCompare(sgRuleKey(b)));
}

function naclEntryKey(e: NetworkAclEntry): string {
  return `${e.egress ? 1 : 0}|${String(e.ruleNumber).padStart(6, '0')}`;
}

function tgwRouteKey(r: TransitGatewayRoute): string {
  return `${str(r.destinationCidr)}|${str(r.prefixListId)}|${r.attachmentIds.join(',')}`;
}

export function sortErrors(errors: ScanError[]): void {
  errors.sort((a, b) =>
    `${a.service}:${a.operation}:${a.message}`.localeCompare(`${b.service}:${b.operation}:${b.message}`),
  );
}

/**
 * Post-collection derivations on a region snapshot:
 *  - resolve each subnet's effective route table (explicit assoc, else VPC main)
 *  - mark subnets public when their effective route table has an active IGW route
 *  - detect "empty" regions (never when scan errors occurred — a region full
 *    of permission failures must not silently disappear)
 *  - sort every resource array AND every nested array so identical scans
 *    produce byte-identical, diff-friendly committed output (AWS list APIs
 *    return many of these in unspecified order)
 */
export function deriveRegion(out: RegionSnapshot): void {
  const mainTableByVpc = new Map<string, string>();
  const tableBySubnet = new Map<string, string>();
  for (const rt of out.routeTables) {
    if (rt.isMain && rt.vpcId) mainTableByVpc.set(rt.vpcId, rt.id);
    for (const subnetId of rt.subnetAssociations) tableBySubnet.set(subnetId, rt.id);
  }
  const tablesWithIgwRoute = new Set(
    out.routeTables
      .filter((rt) => rt.routes.some((r) => r.targetType === 'igw' && r.state === 'active'))
      .map((rt) => rt.id),
  );

  for (const subnet of out.subnets) {
    subnet.routeTableId = tableBySubnet.get(subnet.id) ?? mainTableByVpc.get(subnet.vpcId);
    subnet.isPublic = subnet.routeTableId ? tablesWithIgwRoute.has(subnet.routeTableId) : false;
  }

  // DHCP option sets know nothing about their users; VPCs carry the link.
  const dhcpById = new Map(out.dhcpOptions.map((d) => [d.id, d]));
  for (const vpc of out.vpcs) {
    if (vpc.dhcpOptionsId) dhcpById.get(vpc.dhcpOptionsId)?.vpcIds.push(vpc.id);
  }

  // Redshift Serverless workgroups carry subnetIds but only expose a VPC id
  // via their endpoint's VPC endpoints (absent while creating / when the
  // endpoint isn't materialized) — resolve it from a scanned subnet.
  const vpcBySubnet = new Map(out.subnets.map((s) => [s.id, s.vpcId]));
  for (const wg of out.redshiftServerlessWorkgroups) {
    wg.vpcId ??= wg.subnetIds.map((s) => vpcBySubnet.get(s)).find((v) => v !== undefined);
  }

  // A region is "empty" when it has nothing beyond an untouched default VPC
  // AND nothing went wrong while scanning it. Zero ENIs is the strongest
  // resource signal: any real workload creates ENIs.
  out.empty =
    out.errors.length === 0 &&
    out.generic.length === 0 &&
    out.networkInterfaces.length === 0 &&
    out.instances.length === 0 &&
    out.natGateways.length === 0 &&
    out.loadBalancers.length === 0 &&
    out.lambdaFunctions.length === 0 &&
    out.rdsInstances.length === 0 &&
    out.rdsClusters.length === 0 &&
    out.rdsProxies.length === 0 &&
    out.ecsServices.length === 0 &&
    out.eksClusters.length === 0 &&
    out.elastiCacheClusters.length === 0 &&
    out.elastiCacheReplicationGroups.length === 0 &&
    out.elastiCacheServerlessCaches.length === 0 &&
    out.efsFileSystems.length === 0 &&
    out.fsxFileSystems.length === 0 &&
    out.openSearchDomains.length === 0 &&
    out.mskClusters.length === 0 &&
    out.redshiftClusters.length === 0 &&
    out.redshiftServerlessWorkgroups.length === 0 &&
    out.redshiftServerlessNamespaces.length === 0 &&
    out.mqBrokers.length === 0 &&
    out.peeringConnections.length === 0 &&
    out.transitGateways.length === 0 &&
    out.transitGatewayAttachments.length === 0 &&
    out.vpnConnections.length === 0 &&
    out.dxConnections.length === 0 &&
    out.dxVirtualInterfaces.length === 0 &&
    out.vpcEndpoints.length === 0 &&
    out.vpcEndpointServices.length === 0 &&
    out.kmsKeys.length === 0 &&
    out.acmCertificates.length === 0 &&
    out.secrets.length === 0 &&
    out.wafWebAcls.length === 0 &&
    out.wafIpSets.length === 0 &&
    out.wafRuleGroups.length === 0 &&
    out.resolverEndpoints.length === 0 &&
    out.resolverRules.length === 0 &&
    out.dnsFirewallRuleGroups.length === 0 &&
    out.resolverQueryLogConfigs.length === 0 &&
    out.clientVpnEndpoints.length === 0 &&
    out.networkFirewalls.length === 0 &&
    out.networkFirewallPolicies.length === 0 &&
    out.networkFirewallRuleGroups.length === 0 &&
    out.networkFirewallTlsConfigs.length === 0 &&
    out.apiGateways.length === 0 &&
    out.apiGatewayVpcLinks.length === 0 &&
    out.apiGatewayDomainNames.length === 0 &&
    out.latticeServiceNetworks.length === 0 &&
    out.latticeServices.length === 0 &&
    out.latticeTargetGroups.length === 0 &&
    out.latticeResourceGateways.length === 0 &&
    out.latticeResourceConfigurations.length === 0 &&
    out.logGroups.length === 0 &&
    out.flowLogs.length === 0 &&
    out.instanceConnectEndpoints.length === 0 &&
    out.dxLags.length === 0 &&
    out.transitGatewayConnectPeers.length === 0 &&
    // Detailed collections that no longer route through the Cloud Control /
    // tagging sweeps (promoted from generic inventory). Without these a region
    // holding only untagged tables/queues/topics/repos/pools would be dropped.
    out.cognitoUserPools.length === 0 &&
    out.cognitoIdentityPools.length === 0 &&
    out.directoryServiceDirectories.length === 0 &&
    out.ecrRepositories.length === 0 &&
    out.ecrRegistries.length === 0 &&
    out.dynamoDbTables.length === 0 &&
    out.snsTopics.length === 0 &&
    out.sqsQueues.length === 0 &&
    out.eventBuses.length === 0 &&
    out.eventBridgePipes.length === 0 &&
    out.eventBridgeSchedules.length === 0 &&
    out.sfnStateMachines.length === 0 &&
    out.emrClusters.length === 0 &&
    out.batchComputeEnvironments.length === 0 &&
    out.batchJobQueues.length === 0 &&
    out.neptuneClusters.length === 0 &&
    out.docDbClusters.length === 0 &&
    out.memoryDbClusters.length === 0 &&
    out.transferServers.length === 0 &&
    out.beanstalkEnvironments.length === 0 &&
    out.glueConnections.length === 0 &&
    out.glueDevEndpoints.length === 0 &&
    out.glueJobs.length === 0 &&
    out.glueCrawlers.length === 0 &&
    out.glueDatabases.length === 0 &&
    out.dmsReplicationInstances.length === 0 &&
    out.dmsEndpoints.length === 0 &&
    out.dmsReplicationTasks.length === 0 &&
    out.dataSyncAgents.length === 0 &&
    out.dataSyncLocations.length === 0 &&
    out.dataSyncTasks.length === 0 &&
    out.firehoseDeliveryStreams.length === 0 &&
    out.ramResourceShares.length === 0 &&
    out.configRecorders.length === 0 &&
    out.configRules.length === 0 &&
    out.configConformancePacks.length === 0 &&
    out.cloudTrailTrails.length === 0 &&
    out.cloudTrailEventDataStores.length === 0 &&
    out.guardDutyDetectors.length === 0 &&
    out.backupVaults.length === 0 &&
    out.backupPlans.length === 0 &&
    out.securityHubStatus.length === 0 &&
    out.accessAnalyzers.length === 0 &&
    out.inspectorStatus.length === 0 &&
    out.macieStatus.length === 0 &&
    // dhcpOptions deliberately absent: every region has an AWS default set.
    out.vpcs.every((v) => v.isDefault);

  // ---- deterministic ordering, top-level and nested --------------------------

  sortById(out.vpcs);
  for (const v of out.vpcs) {
    v.cidrBlocks.sort();
    v.ipv6CidrBlocks.sort();
  }

  sortById(out.subnets);
  for (const s of out.subnets) s.ipv6CidrBlocks.sort();

  sortById(out.routeTables);
  for (const rt of out.routeTables) {
    rt.subnetAssociations.sort();
    rt.gatewayAssociations.sort();
    sortRoutes(rt.routes);
  }

  sortById(out.internetGateways);
  for (const igw of out.internetGateways) igw.vpcIds.sort();

  sortById(out.egressOnlyInternetGateways);

  sortById(out.natGateways);
  for (const nat of out.natGateways) {
    nat.addresses.sort((a, b) => str(a.privateIp).localeCompare(str(b.privateIp)));
  }

  sortById(out.elasticIps);

  sortById(out.networkAcls);
  for (const acl of out.networkAcls) {
    acl.subnetIds.sort();
    acl.entries.sort((a, b) => naclEntryKey(a).localeCompare(naclEntryKey(b)));
  }

  sortById(out.securityGroups);
  for (const sg of out.securityGroups) {
    sortSgRules(sg.ingress);
    sortSgRules(sg.egress);
  }

  sortById(out.networkInterfaces);
  for (const eni of out.networkInterfaces) {
    eni.privateIps.sort();
    eni.securityGroupIds.sort();
  }

  sortById(out.vpcEndpoints);
  for (const ep of out.vpcEndpoints) {
    ep.subnetIds.sort();
    ep.routeTableIds.sort();
    ep.networkInterfaceIds.sort();
  }

  sortById(out.vpcEndpointServices);
  for (const svc of out.vpcEndpointServices) {
    svc.availabilityZones.sort();
    svc.networkLoadBalancerArns.sort();
    svc.gatewayLoadBalancerArns.sort();
    svc.supportedIpAddressTypes.sort();
    svc.allowedPrincipals.sort();
    svc.connections.sort((a, b) =>
      str(a.vpcEndpointId).localeCompare(str(b.vpcEndpointId)),
    );
  }

  sortById(out.prefixLists);
  for (const pl of out.prefixLists) pl.cidrs.sort();

  sortById(out.flowLogs);
  sortById(out.dhcpOptions);
  for (const d of out.dhcpOptions) d.vpcIds.sort();
  sortById(out.instanceConnectEndpoints);
  for (const ice of out.instanceConnectEndpoints) ice.securityGroupIds.sort();

  sortById(out.peeringConnections);
  for (const pcx of out.peeringConnections) {
    pcx.requester.cidrBlocks.sort();
    pcx.accepter.cidrBlocks.sort();
  }

  sortById(out.transitGateways);

  sortById(out.transitGatewayAttachments);
  for (const att of out.transitGatewayAttachments) att.subnetIds.sort();

  sortById(out.transitGatewayRouteTables);
  for (const rt of out.transitGatewayRouteTables) {
    for (const r of rt.routes) {
      r.attachmentIds.sort();
      r.resourceIds.sort();
    }
    rt.routes.sort((a, b) => tgwRouteKey(a).localeCompare(tgwRouteKey(b)));
    rt.associations.sort((a, b) => a.attachmentId.localeCompare(b.attachmentId));
    rt.propagations?.sort((a, b) => a.attachmentId.localeCompare(b.attachmentId));
  }

  sortById(out.transitGatewayConnectPeers);

  sortById(out.vpnGateways);
  for (const vgw of out.vpnGateways) vgw.vpcIds.sort();

  sortById(out.customerGateways);

  sortById(out.vpnConnections);
  for (const vpn of out.vpnConnections) {
    vpn.tunnels.sort((a, b) => str(a.outsideIp).localeCompare(str(b.outsideIp)));
    vpn.staticRoutes?.sort();
  }

  sortById(out.dxConnections);
  sortById(out.dxLags);
  sortById(out.dxVirtualInterfaces);

  sortById(out.loadBalancers);
  for (const lb of out.loadBalancers) {
    lb.subnetIds.sort();
    lb.availabilityZones.sort();
    lb.securityGroupIds.sort();
    for (const l of lb.listeners) l.targetGroupArns.sort();
    lb.listeners.sort((a, b) =>
      `${str(a.port).padStart(6, '0')}|${str(a.protocol)}`.localeCompare(
        `${str(b.port).padStart(6, '0')}|${str(b.protocol)}`,
      ),
    );
  }

  sortById(out.targetGroups);
  for (const tg of out.targetGroups) {
    tg.loadBalancerArns.sort();
    tg.targets.sort((a, b) =>
      `${a.targetId}|${str(a.port)}`.localeCompare(`${b.targetId}|${str(b.port)}`),
    );
  }

  sortById(out.instances);
  for (const i of out.instances) i.securityGroupIds.sort();

  sortById(out.autoScalingGroups);
  for (const g of out.autoScalingGroups) {
    g.subnetIds.sort();
    g.instanceIds.sort();
    g.loadBalancerTargetGroupArns.sort();
  }

  sortById(out.lambdaFunctions);
  for (const fn of out.lambdaFunctions) {
    fn.vpcConfig?.subnetIds.sort();
    fn.vpcConfig?.securityGroupIds.sort();
  }

  sortById(out.rdsInstances);
  for (const db of out.rdsInstances) {
    db.subnetIds.sort();
    db.securityGroupIds.sort();
  }

  sortById(out.rdsClusters);
  for (const c of out.rdsClusters) {
    c.memberInstanceIds.sort();
    c.subnetIds.sort();
    c.securityGroupIds.sort();
  }

  sortById(out.rdsProxies);
  for (const p of out.rdsProxies) {
    p.subnetIds.sort();
    p.securityGroupIds.sort();
  }

  sortById(out.ecsServices);
  for (const s of out.ecsServices) {
    s.subnetIds.sort();
    s.securityGroupIds.sort();
  }

  sortById(out.eksClusters);
  for (const e of out.eksClusters) {
    e.subnetIds.sort();
    e.securityGroupIds.sort();
  }

  sortById(out.elastiCacheClusters);
  for (const c of out.elastiCacheClusters) {
    c.subnetIds.sort();
    c.securityGroupIds.sort();
  }

  sortById(out.elastiCacheReplicationGroups);
  sortById(out.elastiCacheServerlessCaches);
  for (const c of out.elastiCacheServerlessCaches) {
    c.subnetIds.sort();
    c.securityGroupIds.sort();
  }

  sortById(out.efsFileSystems);
  sortById(out.fsxFileSystems);
  for (const f of out.fsxFileSystems) {
    f.subnetIds.sort();
    f.networkInterfaceIds?.sort();
  }
  sortById(out.openSearchDomains);
  for (const d of out.openSearchDomains) {
    d.subnetIds.sort();
    d.securityGroupIds.sort();
  }
  sortById(out.mskClusters);
  for (const c of out.mskClusters) {
    c.subnetIds.sort();
    c.securityGroupIds.sort();
  }
  sortById(out.redshiftClusters);
  for (const c of out.redshiftClusters) c.securityGroupIds.sort();
  sortById(out.redshiftServerlessWorkgroups);
  for (const w of out.redshiftServerlessWorkgroups) {
    w.subnetIds.sort();
    w.securityGroupIds.sort();
  }
  sortById(out.redshiftServerlessNamespaces);
  sortById(out.mqBrokers);
  for (const b of out.mqBrokers) {
    b.subnetIds.sort();
    b.securityGroupIds.sort();
  }

  sortById(out.kmsKeys);
  for (const k of out.kmsKeys) k.aliases.sort();
  sortById(out.acmCertificates);
  for (const c of out.acmCertificates) {
    c.subjectAlternativeNames.sort();
    c.inUseBy.sort();
  }
  sortById(out.secrets);
  sortById(out.resolverEndpoints);
  for (const e of out.resolverEndpoints) {
    e.subnetIds.sort();
    e.ipAddresses.sort();
    e.securityGroupIds.sort();
  }
  sortById(out.resolverRules);
  for (const r of out.resolverRules) {
    r.targetIps.sort();
    r.vpcAssociationIds.sort();
  }
  sortById(out.clientVpnEndpoints);
  for (const c of out.clientVpnEndpoints) {
    c.dnsServers.sort();
    c.securityGroupIds.sort();
    c.associatedSubnetIds.sort();
  }
  sortById(out.networkFirewalls);
  for (const f of out.networkFirewalls) f.subnetIds.sort();
  sortById(out.networkFirewallPolicies);
  for (const p of out.networkFirewallPolicies) {
    p.statelessRuleGroupRefs.sort((a, b) => a.arn.localeCompare(b.arn));
    p.statefulRuleGroupRefs.sort((a, b) => a.arn.localeCompare(b.arn));
  }
  sortById(out.networkFirewallRuleGroups);
  sortById(out.networkFirewallTlsConfigs);
  sortById(out.wafWebAcls);
  sortById(out.wafIpSets);
  sortById(out.wafRuleGroups);
  sortById(out.dnsFirewallRuleGroups);
  sortById(out.resolverQueryLogConfigs);
  sortById(out.apiGateways);
  for (const a of out.apiGateways) {
    a.stages.sort();
    a.vpcEndpointIds.sort();
    a.routes.sort((x, y) => str(x.routeKey).localeCompare(str(y.routeKey)));
    a.authorizers.sort((x, y) =>
      `${str(x.id)}|${str(x.name)}`.localeCompare(`${str(y.id)}|${str(y.name)}`),
    );
  }
  sortById(out.apiGatewayVpcLinks);
  for (const link of out.apiGatewayVpcLinks) {
    link.targetArns.sort();
    link.subnetIds.sort();
    link.securityGroupIds.sort();
  }
  sortById(out.apiGatewayDomainNames);
  for (const d of out.apiGatewayDomainNames) {
    d.certificateArns.sort();
    d.mappings.sort((a, b) =>
      `${str(a.apiId)}|${str(a.stage)}|${str(a.path)}`.localeCompare(
        `${str(b.apiId)}|${str(b.stage)}|${str(b.path)}`,
      ),
    );
  }
  sortById(out.latticeServiceNetworks);
  sortById(out.latticeServices);
  sortById(out.latticeTargetGroups);
  for (const tg of out.latticeTargetGroups) {
    tg.serviceArns.sort();
    tg.targets?.sort((a, b) => a.id.localeCompare(b.id));
  }
  sortById(out.latticeResourceGateways);
  for (const gw of out.latticeResourceGateways) {
    gw.subnetIds.sort();
    gw.securityGroupIds.sort();
  }
  sortById(out.latticeResourceConfigurations);
  sortById(out.logGroups);
  sortById(out.cognitoUserPools);
  for (const pool of out.cognitoUserPools) {
    pool.identityProviders.sort();
    pool.appClients.sort((a, b) => a.id.localeCompare(b.id));
    for (const c of pool.appClients) {
      c.allowedOAuthFlows.sort();
      c.allowedOAuthScopes.sort();
      c.callbackUrls.sort();
      c.supportedIdentityProviders.sort();
      c.explicitAuthFlows.sort();
    }
  }
  sortById(out.cognitoIdentityPools);
  for (const pool of out.cognitoIdentityPools) {
    pool.cognitoUserPoolProviders.sort();
    pool.samlProviderArns.sort();
    pool.openIdConnectProviderArns.sort();
  }
  sortById(out.directoryServiceDirectories);
  for (const d of out.directoryServiceDirectories) {
    d.subnetIds.sort();
    d.dnsIps.sort();
  }
  sortById(out.dynamoDbTables);
  for (const t of out.dynamoDbTables) t.globalTableReplicas.sort();
  sortById(out.snsTopics);
  for (const t of out.snsTopics) {
    t.subscriptions.sort((a, b) => str(a.arn).localeCompare(str(b.arn)));
  }
  sortById(out.sqsQueues);
  sortById(out.eventBuses);
  for (const bus of out.eventBuses) {
    bus.rules.sort((a, b) => a.name.localeCompare(b.name));
    for (const rule of bus.rules) {
      rule.targets.sort((a, b) =>
        `${str(a.id)}|${str(a.arn)}`.localeCompare(`${str(b.id)}|${str(b.arn)}`),
      );
    }
  }
  sortById(out.eventBridgePipes);
  for (const pipe of out.eventBridgePipes) {
    pipe.vpcSubnetIds.sort();
    pipe.vpcSecurityGroups.sort();
  }
  sortById(out.eventBridgeSchedules);
  sortById(out.sfnStateMachines);
  for (const sm of out.sfnStateMachines) sm.integrationResourceArns.sort();
  sortById(out.emrClusters);
  for (const c of out.emrClusters) {
    c.subnetIds.sort();
    c.securityGroupIds.sort();
  }
  sortById(out.batchComputeEnvironments);
  for (const ce of out.batchComputeEnvironments) {
    ce.subnetIds.sort();
    ce.securityGroupIds.sort();
  }
  sortById(out.batchJobQueues);
  for (const q of out.batchJobQueues) q.computeEnvironmentArns.sort();
  sortById(out.neptuneClusters);
  for (const c of out.neptuneClusters) {
    c.subnetIds.sort();
    c.securityGroupIds.sort();
    c.memberInstanceIds.sort();
  }
  sortById(out.docDbClusters);
  for (const c of out.docDbClusters) {
    c.subnetIds.sort();
    c.securityGroupIds.sort();
    c.memberInstanceIds.sort();
  }
  sortById(out.memoryDbClusters);
  for (const c of out.memoryDbClusters) {
    c.subnetIds.sort();
    c.securityGroupIds.sort();
  }
  sortById(out.transferServers);
  for (const s of out.transferServers) {
    s.protocols.sort();
    s.subnetIds.sort();
    s.securityGroupIds.sort();
  }
  sortById(out.beanstalkEnvironments);
  for (const e of out.beanstalkEnvironments) {
    e.subnetIds.sort();
    e.securityGroupIds.sort();
  }
  sortById(out.glueConnections);
  for (const c of out.glueConnections) c.securityGroupIds.sort();
  sortById(out.glueDevEndpoints);
  for (const e of out.glueDevEndpoints) e.securityGroupIds.sort();
  sortById(out.glueJobs);
  for (const j of out.glueJobs) j.connections.sort();
  sortById(out.glueCrawlers);
  sortById(out.glueDatabases);
  sortById(out.dmsReplicationInstances);
  for (const ri of out.dmsReplicationInstances) {
    ri.subnetIds.sort();
    ri.securityGroupIds.sort();
    ri.privateIps.sort();
    ri.publicIps.sort();
  }
  sortById(out.dmsEndpoints);
  sortById(out.dmsReplicationTasks);
  sortById(out.dataSyncAgents);
  for (const a of out.dataSyncAgents) {
    a.subnetArns.sort();
    a.securityGroupArns.sort();
  }
  sortById(out.dataSyncLocations);
  for (const l of out.dataSyncLocations) l.securityGroupArns.sort();
  sortById(out.dataSyncTasks);
  sortById(out.firehoseDeliveryStreams);
  for (const ds of out.firehoseDeliveryStreams) {
    ds.subnetIds.sort();
    ds.securityGroupIds.sort();
  }
  sortById(out.ramResourceShares);
  for (const share of out.ramResourceShares) {
    share.principals.sort((a, b) => `${a.type}|${a.id}`.localeCompare(`${b.type}|${b.id}`));
    share.resources.sort((a, b) => a.arn.localeCompare(b.arn));
  }
  sortById(out.configRecorders);
  for (const rec of out.configRecorders) rec.recordedResourceTypes.sort();
  sortById(out.configRules);
  sortById(out.configConformancePacks);
  sortById(out.cloudTrailTrails);
  sortById(out.cloudTrailEventDataStores);
  sortById(out.guardDutyDetectors);
  for (const d of out.guardDutyDetectors) {
    d.features.sort((a, b) => str(a.name).localeCompare(str(b.name)));
  }
  sortById(out.backupVaults);
  sortById(out.backupPlans);
  for (const plan of out.backupPlans) {
    for (const rule of plan.rules) rule.copyToDestinations.sort();
    plan.rules.sort((a, b) => str(a.name).localeCompare(str(b.name)));
    plan.selectionResourceTypes.sort();
  }
  sortById(out.securityHubStatus);
  for (const hub of out.securityHubStatus) hub.enabledStandards.sort();
  sortById(out.accessAnalyzers);
  sortById(out.inspectorStatus);
  sortById(out.macieStatus);
  sortById(out.ecrRepositories);
  sortById(out.ecrRegistries);
  for (const reg of out.ecrRegistries) {
    for (const rule of reg.replicationRules) {
      rule.repositoryFilters.sort();
      rule.destinations.sort((a, b) =>
        `${str(a.region)}|${str(a.registryId)}`.localeCompare(`${str(b.region)}|${str(b.registryId)}`),
      );
    }
    reg.replicationRules.sort((a, b) =>
      a.destinations
        .map((d) => `${str(d.region)}|${str(d.registryId)}`)
        .join(',')
        .localeCompare(b.destinations.map((d) => `${str(d.region)}|${str(d.registryId)}`).join(',')),
    );
    reg.pullThroughCacheRules.sort((a, b) =>
      str(a.ecrRepositoryPrefix).localeCompare(str(b.ecrRepositoryPrefix)),
    );
  }

  // The tagging and Cloud Control sweeps run concurrently and can both report
  // the same resource (Cloud Control dedupes against entries present at push
  // time, but the tagging sweep never checks back). Keep one entry per ARN,
  // preferring the tagging entry — its tags are authoritative.
  const genericByArn = new Map<string, GenericResource>();
  for (const g of out.generic) {
    const existing = genericByArn.get(g.arn);
    if (!existing || (existing.source === 'cloudcontrol' && g.source !== 'cloudcontrol')) {
      genericByArn.set(g.arn, g);
    }
  }
  out.generic = [...genericByArn.values()];

  out.generic.sort((a, b) => a.arn.localeCompare(b.arn));
  sortErrors(out.errors);
}
