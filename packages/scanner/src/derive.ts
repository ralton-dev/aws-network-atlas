import type {
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
    out.ecsServices.length === 0 &&
    out.eksClusters.length === 0 &&
    out.elastiCacheClusters.length === 0 &&
    out.peeringConnections.length === 0 &&
    out.transitGateways.length === 0 &&
    out.transitGatewayAttachments.length === 0 &&
    out.vpnConnections.length === 0 &&
    out.vpcEndpoints.length === 0 &&
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

  sortById(out.prefixLists);
  for (const pl of out.prefixLists) pl.cidrs.sort();

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
  }

  sortById(out.vpnGateways);
  for (const vgw of out.vpnGateways) vgw.vpcIds.sort();

  sortById(out.customerGateways);

  sortById(out.vpnConnections);
  for (const vpn of out.vpnConnections) {
    vpn.tunnels.sort((a, b) => str(a.outsideIp).localeCompare(str(b.outsideIp)));
  }

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

  out.generic.sort((a, b) => a.arn.localeCompare(b.arn));
  sortErrors(out.errors);
}
