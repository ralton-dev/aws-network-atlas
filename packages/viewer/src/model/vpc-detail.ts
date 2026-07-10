import { MarkerType } from '@xyflow/react';
import type { LoadBalancerListener, RegionSnapshot, SecurityGroupRule } from '@atlas/schema';
import type { AtlasIndex } from '../data.js';
import {
  destsLabel,
  type AtlasEdge,
  type AtlasEdgeData,
  type AtlasGraph,
  type AtlasNode,
  type EdgeKind,
  type RouteDetail,
} from './graph-types.js';
import { portLabel, worldOpenIngress } from './relations.js';
import { subnetRoutes, type SubnetRoute } from './routes.js';

const MAX_INSTANCES_PER_SUBNET = 12;
const EXT_CONTAINER = 'ext:connectivity';
const SEC_CONTAINER = 'sec:identity';
const SG_RULE_COLUMNS: [string, string, string] = ['Source', 'Port / protocol', 'Description'];

function leaf(
  id: string,
  parentId: string | undefined,
  kind: string,
  label: string,
  subtitle?: string,
  refId?: string,
  badges?: string[],
): AtlasNode {
  return {
    id,
    type: 'resource',
    position: { x: 0, y: 0 },
    parentId,
    width: 150,
    height: 92,
    data: { label, subtitle, kind, refId: refId ?? id.replace(/^res:/, ''), badges },
  };
}

const MAX_LISTENER_BADGES = 4;

/** Compact listener badges for a load-balancer node: "HTTPS:443", "HTTP:80", … capped with "+N". */
function listenerBadges(listeners: LoadBalancerListener[]): string[] | undefined {
  if (listeners.length === 0) return undefined;
  const labels = [...new Set(
    listeners.map((l) => [l.protocol, l.port].filter((p) => p != null).join(':') || 'listener'),
  )];
  const shown = labels.slice(0, MAX_LISTENER_BADGES);
  const extra = labels.length - shown.length;
  return extra > 0 ? [...shown, `+${extra}`] : shown;
}

/** Build the drill-down graph for a single VPC. */
export function buildVpcDetail(index: AtlasIndex, vpcId: string): AtlasGraph {
  const vpcRef = index.byKey.get(vpcId);
  const region: RegionSnapshot | undefined = vpcRef
    ? index.findRegion(vpcRef.accountId, vpcRef.region)
    : undefined;
  if (!vpcRef || !region) return { nodes: [], edges: [] };

  const vpc = region.vpcs.find((v) => v.id === vpcId);
  if (!vpc) return { nodes: [], edges: [] };

  const containers: AtlasNode[] = [];
  const leaves = new Map<string, AtlasNode>();
  const edges = new Map<string, AtlasEdge>();
  let extUsed = false;

  const vpcNodeId = `vpc:${vpcId}`;
  containers.push({
    id: vpcNodeId,
    type: 'container',
    position: { x: 0, y: 0 },
    data: {
      label: vpc.name ?? vpc.id,
      subtitle: `${vpcRef.accountId} · ${region.region} · ${vpc.cidrBlocks.join(', ')}`,
      kind: 'group-vpc',
      isContainer: true,
      containerStyle: 'vpc',
      refId: vpcId,
    },
  });

  // --- AZ + subnet containers ----------------------------------------------
  const subnets = region.subnets.filter((s) => s.vpcId === vpcId);
  const azs = [...new Set(subnets.map((s) => s.availabilityZone))].sort();
  for (const az of azs) {
    containers.push({
      id: `az:${az}`,
      type: 'container',
      position: { x: 0, y: 0 },
      parentId: vpcNodeId,
      data: { label: az, kind: 'group-az', isContainer: true, containerStyle: 'az' },
    });
  }
  for (const subnet of subnets) {
    containers.push({
      id: `res:${subnet.id}`,
      type: 'container',
      position: { x: 0, y: 0 },
      parentId: `az:${subnet.availabilityZone}`,
      data: {
        label: subnet.name ?? subnet.id,
        subtitle: `${subnet.cidrBlock ?? ''}${subnet.isPublic ? ' · public' : ' · private'}`,
        kind: subnet.isPublic ? 'group-subnet-public' : 'group-subnet-private',
        isContainer: true,
        containerStyle: subnet.isPublic ? 'subnet-public' : 'subnet-private',
        refId: subnet.id,
      },
    });
  }
  const subnetNode = (subnetId: string | undefined): string | undefined =>
    subnetId && subnets.some((s) => s.id === subnetId) ? `res:${subnetId}` : undefined;

  // --- in-subnet resources ---------------------------------------------------
  for (const nat of region.natGateways.filter((n) => n.vpcId === vpcId)) {
    leaves.set(`res:${nat.id}`, leaf(
      `res:${nat.id}`, subnetNode(nat.subnetId) ?? vpcNodeId, 'nat',
      nat.name ?? nat.id, nat.addresses[0]?.publicIp ?? nat.connectivityType, nat.id,
    ));
  }

  const bySubnet = new Map<string, number>();
  for (const inst of region.instances.filter((i) => i.vpcId === vpcId)) {
    const parent = subnetNode(inst.subnetId) ?? vpcNodeId;
    const count = (bySubnet.get(parent) ?? 0) + 1;
    bySubnet.set(parent, count);
    if (count === MAX_INSTANCES_PER_SUBNET) {
      leaves.set(`agg:${parent}`, {
        ...leaf(`agg:${parent}`, parent, 'instance', '… more instances', 'use search to find them'),
        type: 'note',
        height: 60,
      });
    }
    if (count >= MAX_INSTANCES_PER_SUBNET) {
      const aggNode = leaves.get(`agg:${parent}`);
      if (aggNode) aggNode.data.label = `+${count - MAX_INSTANCES_PER_SUBNET + 1} more instances`;
      continue;
    }
    leaves.set(`res:${inst.id}`, leaf(
      `res:${inst.id}`, parent, 'instance',
      inst.name ?? inst.id, inst.privateIp ?? inst.instanceType, inst.id,
      inst.state && inst.state !== 'running' ? [inst.state] : undefined,
    ));
  }

  for (const rds of region.rdsInstances.filter((r) => r.vpcId === vpcId)) {
    // Place in the subnet matching the instance's AZ when resolvable.
    const azSubnet = subnets.find(
      (s) => rds.subnetIds.includes(s.id) && s.availabilityZone === rds.availabilityZone,
    );
    const rdsBadges = [
      ...(rds.multiAz ? ['multi-AZ'] : []),
      ...(rds.publiclyAccessible === true ? ['public'] : []),
    ];
    leaves.set(`res:${rds.id}`, leaf(
      `res:${rds.id}`, azSubnet ? `res:${azSubnet.id}` : vpcNodeId, 'rds',
      rds.name ?? rds.id, rds.engine, rds.id,
      rdsBadges.length > 0 ? rdsBadges : undefined,
    ));
  }

  for (const ep of region.vpcEndpoints.filter((e) => e.vpcId === vpcId)) {
    const shortService = ep.serviceName.split('.').slice(3).join('.') || ep.serviceName;
    const parent = ep.subnetIds.length === 1 ? subnetNode(ep.subnetIds[0]) ?? vpcNodeId : vpcNodeId;
    leaves.set(`res:${ep.id}`, leaf(
      `res:${ep.id}`, parent, 'vpce',
      ep.name ?? shortService, ep.endpointType, ep.id,
    ));
  }

  // --- VPC-wide resources ----------------------------------------------------
  for (const igw of region.internetGateways.filter((g) => g.vpcIds.includes(vpcId))) {
    leaves.set(`res:${igw.id}`, leaf(`res:${igw.id}`, vpcNodeId, 'igw', igw.name ?? igw.id, 'internet gateway', igw.id));
  }
  for (const eigw of region.egressOnlyInternetGateways.filter((g) => g.vpcId === vpcId)) {
    leaves.set(`res:${eigw.id}`, leaf(`res:${eigw.id}`, vpcNodeId, 'eigw', eigw.name ?? eigw.id, 'egress-only IGW', eigw.id));
  }
  for (const vgw of region.vpnGateways.filter((g) => g.vpcIds.includes(vpcId))) {
    leaves.set(`res:${vgw.id}`, leaf(`res:${vgw.id}`, vpcNodeId, 'vgw', vgw.name ?? vgw.id, 'VPN gateway', vgw.id));
  }
  for (const lb of region.loadBalancers.filter((l) => l.vpcId === vpcId)) {
    leaves.set(`res:${lb.id}`, leaf(
      `res:${lb.id}`, vpcNodeId, `lb-${lb.lbType}`,
      lb.name ?? lb.id, `${lb.lbType} · ${lb.scheme ?? ''}`, lb.id,
      listenerBadges(lb.listeners),
    ));
  }
  for (const fn of region.lambdaFunctions) {
    if (fn.vpcConfig?.vpcId !== vpcId && !fn.vpcConfig?.subnetIds.some((s) => subnets.some((x) => x.id === s))) continue;
    leaves.set(`res:${fn.id}`, leaf(`res:${fn.id}`, vpcNodeId, 'lambda', fn.name ?? fn.id, fn.runtime, fn.id));
  }
  for (const c of region.rdsClusters.filter((c) => c.vpcId === vpcId)) {
    leaves.set(`res:${c.id}`, leaf(`res:${c.id}`, vpcNodeId, 'rds-cluster', c.name ?? c.id, c.engine, c.id));
  }
  for (const svc of region.ecsServices) {
    if (!svc.subnetIds.some((s) => subnets.some((x) => x.id === s))) continue;
    leaves.set(`res:${svc.id}`, leaf(`res:${svc.id}`, vpcNodeId, 'ecs', svc.name ?? svc.id, `ECS · ${svc.clusterName ?? ''}`, svc.id));
  }
  for (const eks of region.eksClusters.filter((e) => e.vpcId === vpcId)) {
    leaves.set(`res:${eks.id}`, leaf(`res:${eks.id}`, vpcNodeId, 'eks', eks.name ?? eks.id, `EKS ${eks.version ?? ''}`, eks.id));
  }
  for (const cache of region.elastiCacheClusters.filter((c) => c.vpcId === vpcId)) {
    leaves.set(`res:${cache.id}`, leaf(`res:${cache.id}`, vpcNodeId, 'elasticache', cache.name ?? cache.id, cache.engine, cache.id));
  }
  const inVpcSubnets = (subnetIds: string[]): boolean =>
    subnetIds.some((s) => subnets.some((x) => x.id === s));
  for (const proxy of region.rdsProxies.filter((p) => p.vpcId === vpcId)) {
    leaves.set(`res:${proxy.id}`, leaf(`res:${proxy.id}`, vpcNodeId, 'rds-proxy', proxy.name ?? proxy.id, `RDS Proxy · ${proxy.engineFamily ?? ''}`, proxy.id));
  }
  for (const fs of region.efsFileSystems.filter((f) => f.vpcId === vpcId)) {
    leaves.set(`res:${fs.id}`, leaf(
      `res:${fs.id}`, vpcNodeId, 'efs', fs.name ?? fs.id,
      `EFS · ${fs.mountTargets.length} mount target${fs.mountTargets.length === 1 ? '' : 's'}`, fs.id,
      fs.encrypted === false ? ['unencrypted'] : undefined,
    ));
  }
  for (const fsx of region.fsxFileSystems) {
    // Placed in the first of its subnets that belongs to this VPC (like
    // MemoryDB/Neptune); falls back to the VPC box when the subnets weren't
    // scanned but the file system declares this VPC (like EFS).
    const parent =
      subnetNode(fsx.subnetIds.find((s) => subnets.some((x) => x.id === s))) ??
      (fsx.vpcId === vpcId ? vpcNodeId : undefined);
    if (!parent) continue;
    leaves.set(`res:${fsx.id}`, leaf(
      `res:${fsx.id}`, parent, 'fsx',
      fsx.name ?? fsx.id, `FSx · ${fsx.fileSystemType.toLowerCase()}`, fsx.id,
    ));
  }
  for (const d of region.openSearchDomains.filter((d) => d.vpcId === vpcId)) {
    leaves.set(`res:${d.id}`, leaf(
      `res:${d.id}`, vpcNodeId, 'opensearch', d.name ?? d.id, `OpenSearch ${d.engineVersion ?? ''}`, d.id,
      d.inVpc === false ? ['public'] : undefined,
    ));
  }
  for (const c of region.mskClusters) {
    if (!inVpcSubnets(c.subnetIds)) continue;
    leaves.set(`res:${c.id}`, leaf(`res:${c.id}`, vpcNodeId, 'msk', c.name ?? c.id, `MSK · ${c.clusterType?.toLowerCase() ?? 'kafka'}`, c.id));
  }
  for (const c of region.redshiftClusters.filter((c) => c.vpcId === vpcId)) {
    leaves.set(`res:${c.id}`, leaf(
      `res:${c.id}`, vpcNodeId, 'redshift', c.name ?? c.id, `Redshift · ${c.nodeType ?? ''}`, c.id,
      c.publiclyAccessible ? ['public'] : undefined,
    ));
  }
  for (const wg of region.redshiftServerlessWorkgroups) {
    // Placed in the first of its subnets that belongs to this VPC (like FSx/
    // MemoryDB); falls back to the VPC box when the subnets weren't scanned
    // but the workgroup resolved to this VPC.
    const parent =
      subnetNode(wg.subnetIds.find((s) => subnets.some((x) => x.id === s))) ??
      (wg.vpcId === vpcId ? vpcNodeId : undefined);
    if (!parent) continue;
    leaves.set(`res:${wg.id}`, leaf(
      `res:${wg.id}`, parent, 'redshift-serverless-workgroup',
      wg.name ?? wg.id, `Redshift serverless · ${wg.namespaceName ?? 'workgroup'}`, wg.id,
      wg.publiclyAccessible ? ['public'] : undefined,
    ));
  }
  for (const dir of region.directoryServiceDirectories) {
    // Placed in the first of its subnets that belongs to this VPC (like FSx/
    // Redshift Serverless); falls back to the VPC box when the subnets
    // weren't scanned but the directory declares this VPC.
    const parent =
      subnetNode(dir.subnetIds.find((s) => subnets.some((x) => x.id === s))) ??
      (dir.vpcId === vpcId ? vpcNodeId : undefined);
    if (!parent) continue;
    leaves.set(`res:${dir.id}`, leaf(
      `res:${dir.id}`, parent, 'directory-service',
      dir.name ?? dir.id, `Directory Service · ${dir.type}`, dir.id,
      dir.stage && dir.stage !== 'Active' ? [dir.stage] : undefined,
    ));
  }
  for (const broker of region.mqBrokers) {
    if (!inVpcSubnets(broker.subnetIds)) continue;
    leaves.set(`res:${broker.id}`, leaf(
      `res:${broker.id}`, vpcNodeId, 'mq', broker.name ?? broker.id, `MQ · ${broker.engineType ?? ''}`, broker.id,
      broker.publiclyAccessible ? ['public'] : undefined,
    ));
  }
  for (const cache of region.elastiCacheServerlessCaches) {
    if (!inVpcSubnets(cache.subnetIds)) continue;
    leaves.set(`res:${cache.id}`, leaf(`res:${cache.id}`, vpcNodeId, 'elasticache-serverless', cache.name ?? cache.id, `${cache.engine ?? 'cache'} · serverless`, cache.id));
  }
  for (const ice of region.instanceConnectEndpoints.filter((e) => e.vpcId === vpcId)) {
    leaves.set(`res:${ice.id}`, leaf(
      `res:${ice.id}`, subnetNode(ice.subnetId) ?? vpcNodeId, 'instance-connect-endpoint',
      ice.name ?? ice.id, 'EC2 Instance Connect', ice.id,
    ));
  }
  // DataSync subnet/SG references are ARNs — the id is the last '/' segment.
  const arnResourceId = (arn: string): string => arn.split('/').pop() ?? arn;
  for (const conn of region.glueConnections) {
    const parent = subnetNode(conn.subnetId);
    if (!parent) continue; // only drawn when its subnet is in this VPC
    leaves.set(`res:${conn.id}`, leaf(
      `res:${conn.id}`, parent, 'glue-connection',
      conn.name ?? conn.id, conn.connectionType ?? 'Glue connection', conn.id,
    ));
  }
  for (const ep of region.glueDevEndpoints) {
    const parent = subnetNode(ep.subnetId);
    if (!parent) continue;
    leaves.set(`res:${ep.id}`, leaf(
      `res:${ep.id}`, parent, 'glue-dev-endpoint',
      ep.name ?? ep.id, 'Glue dev endpoint', ep.id,
    ));
  }
  for (const dms of region.dmsReplicationInstances) {
    // Place in the first subnet of its subnet group that belongs to this VPC.
    const parent = subnetNode(dms.subnetIds.find((s) => subnets.some((x) => x.id === s)));
    if (!parent) continue;
    leaves.set(`res:${dms.id}`, leaf(
      `res:${dms.id}`, parent, 'dms-instance',
      dms.name ?? dms.id, dms.replicationInstanceClass ?? 'DMS replication instance', dms.id,
      dms.multiAz ? ['multi-AZ'] : undefined,
    ));
  }
  for (const agent of region.dataSyncAgents) {
    const parent = subnetNode(agent.subnetArns.map(arnResourceId).find((s) => subnets.some((x) => x.id === s)));
    if (!parent) continue;
    leaves.set(`res:${agent.id}`, leaf(
      `res:${agent.id}`, parent, 'datasync-agent',
      agent.name ?? agent.id, 'DataSync agent', agent.id,
    ));
  }
  for (const fh of region.firehoseDeliveryStreams) {
    if (fh.subnetIds.length === 0) continue; // only in-VPC (OpenSearch-destination) streams are drawn
    const parent = subnetNode(fh.subnetIds.find((s) => subnets.some((x) => x.id === s)));
    if (!parent) continue;
    leaves.set(`res:${fh.id}`, leaf(
      `res:${fh.id}`, parent, 'firehose',
      fh.name ?? fh.id, 'Firehose → OpenSearch', fh.id,
    ));
  }
  for (const emr of region.emrClusters) {
    const parent = subnetNode(emr.subnetIds.find((s) => subnets.some((x) => x.id === s)));
    if (!parent) continue;
    leaves.set(`res:${emr.id}`, leaf(
      `res:${emr.id}`, parent, 'emr-cluster',
      emr.name ?? emr.id, emr.releaseLabel ?? 'EMR', emr.id,
    ));
  }
  for (const ce of region.batchComputeEnvironments) {
    const parent = subnetNode(ce.subnetIds.find((s) => subnets.some((x) => x.id === s)));
    if (!parent) continue;
    leaves.set(`res:${ce.id}`, leaf(
      `res:${ce.id}`, parent, 'batch-compute-environment',
      ce.name ?? ce.id, ce.computeType ?? 'Batch', ce.id,
    ));
  }
  for (const np of region.neptuneClusters) {
    const parent = subnetNode(np.subnetIds.find((s) => subnets.some((x) => x.id === s)));
    if (!parent) continue;
    leaves.set(`res:${np.id}`, leaf(
      `res:${np.id}`, parent, 'neptune-cluster',
      np.name ?? np.id, 'Neptune', np.id,
    ));
  }
  for (const dd of region.docDbClusters) {
    const parent = subnetNode(dd.subnetIds.find((s) => subnets.some((x) => x.id === s)));
    if (!parent) continue;
    leaves.set(`res:${dd.id}`, leaf(
      `res:${dd.id}`, parent, 'docdb-cluster',
      dd.name ?? dd.id, 'DocumentDB', dd.id,
    ));
  }
  for (const mdb of region.memoryDbClusters) {
    const parent = subnetNode(mdb.subnetIds.find((s) => subnets.some((x) => x.id === s)));
    if (!parent) continue;
    leaves.set(`res:${mdb.id}`, leaf(
      `res:${mdb.id}`, parent, 'memorydb-cluster',
      mdb.name ?? mdb.id, mdb.nodeType ?? 'MemoryDB', mdb.id,
    ));
  }
  for (const ts of region.transferServers) {
    if (ts.subnetIds.length === 0) continue; // only VPC-endpoint servers are drawn
    const parent = subnetNode(ts.subnetIds.find((s) => subnets.some((x) => x.id === s)));
    if (!parent) continue;
    leaves.set(`res:${ts.id}`, leaf(
      `res:${ts.id}`, parent, 'transfer-server',
      ts.name ?? ts.id, ts.protocols.length > 0 ? ts.protocols.join('/') : 'Transfer', ts.id,
    ));
  }
  for (const eb of region.beanstalkEnvironments) {
    if (eb.subnetIds.length === 0) continue; // only environments with parsed VPC config are drawn
    const parent = subnetNode(eb.subnetIds.find((s) => subnets.some((x) => x.id === s)));
    if (!parent) continue;
    leaves.set(`res:${eb.id}`, leaf(
      `res:${eb.id}`, parent, 'beanstalk-environment',
      eb.name ?? eb.id, eb.tier ?? 'Beanstalk', eb.id,
    ));
  }

  // --- external connectivity nodes + route-derived edges ---------------------
  const ensureExt = (id: string, kind: string, label: string, subtitle?: string, refId?: string): string => {
    extUsed = true;
    if (!leaves.has(id)) {
      leaves.set(id, leaf(id, EXT_CONTAINER, kind, label, subtitle, refId));
    }
    return id;
  };

  let secUsed = false;
  const ensureSec = (id: string, kind: string, label: string, subtitle?: string, refId?: string): string => {
    secUsed = true;
    if (!leaves.has(id)) {
      leaves.set(id, leaf(id, SEC_CONTAINER, kind, label, subtitle, refId));
    }
    return id;
  };

  const internetNode = (): string => ensureExt('inet:public', 'internet', 'Internet', 'public traffic');

  const addEdge = (key: string, source: string, target: string, data: AtlasEdgeData): void => {
    edges.set(key, {
      id: `edge:${key}`,
      source,
      target,
      type: 'annotated',
      markerEnd: { type: MarkerType.ArrowClosed },
      data,
    });
  };

  // --- DNS: resolver endpoints in this VPC + their forwarding rules ----------
  for (const ep of region.resolverEndpoints.filter((e) => e.vpcId === vpcId)) {
    const parent = ep.subnetIds.length === 1 ? subnetNode(ep.subnetIds[0]) ?? vpcNodeId : vpcNodeId;
    leaves.set(`res:${ep.id}`, leaf(
      `res:${ep.id}`, parent, 'resolver-endpoint',
      ep.name ?? ep.id, `${(ep.direction ?? 'resolver').toLowerCase()} resolver`, ep.id,
    ));
    for (const rule of region.resolverRules) {
      if (rule.resolverEndpointId !== ep.id || rule.targetIps.length === 0) continue;
      const target = ensureExt(`dnst:${rule.id}`, 'dns-target', rule.domainName ?? rule.id, rule.targetIps.join(', '), rule.id);
      addEdge(`rslvr:${rule.id}`, `res:${ep.id}`, target, {
        edgeKind: 'dns',
        label: `DNS ${rule.domainName ?? ''}`.trim(),
        title: `Resolver rule ${rule.name ?? rule.id}`,
        refId: rule.id,
      });
    }
  }

  // --- Network Firewall: firewall → policy → rule groups ---------------------
  for (const fw of region.networkFirewalls.filter((f) => f.vpcId === vpcId)) {
    leaves.set(`res:${fw.id}`, leaf(
      `res:${fw.id}`, subnetNode(fw.subnetIds[0]) ?? vpcNodeId, 'network-firewall',
      fw.name ?? fw.id, 'network firewall', fw.id,
      fw.status && fw.status !== 'READY' ? [fw.status] : undefined,
    ));

    const policy = region.networkFirewallPolicies.find(
      (p) => p.arn !== undefined && p.arn === fw.firewallPolicyArn,
    );
    if (!policy) continue;
    const ruleGroupRefs = [
      ...policy.statelessRuleGroupRefs.map((r) => ({ ...r, type: 'stateless' })),
      ...policy.statefulRuleGroupRefs.map((r) => ({ ...r, type: 'stateful' })),
    ];
    const policyNode = ensureSec(
      `nfwp:${policy.arn ?? policy.id}`, 'network-firewall-policy', policy.name ?? policy.id,
      `firewall policy · ${ruleGroupRefs.length} rule group${ruleGroupRefs.length === 1 ? '' : 's'}`,
      policy.arn ?? policy.id,
    );
    addEdge(`fwpol:${fw.id}`, `res:${fw.id}`, policyNode, {
      edgeKind: 'uses',
      label: 'firewall policy',
      title: `${fw.name ?? fw.id} uses policy ${policy.name ?? policy.id}`,
      refId: policy.arn ?? policy.id,
    });
    for (const ref of ruleGroupRefs) {
      const rg = region.networkFirewallRuleGroups.find((r) => r.arn === ref.arn);
      const ruleCount =
        (rg?.statelessRules.length ?? 0) +
        (rg?.statefulRules.length ?? 0) +
        (rg?.domainList ? rg.domainList.targets.length : 0);
      const subtitle = rg
        ? rg.rulesString !== undefined
          ? `${ref.type} · suricata rules`
          : `${ref.type} · ${ruleCount} rule${ruleCount === 1 ? '' : 's'}`
        : `${ref.type} rule group`;
      const rgNode = ensureSec(
        `nfwrg:${ref.arn}`, 'network-firewall-rule-group',
        rg?.name ?? ref.arn.split('/').pop() ?? ref.arn, subtitle, rg?.arn ?? ref.arn,
      );
      addEdge(`polrg:${policy.id}|${ref.arn}`, policyNode, rgNode, {
        edgeKind: 'uses',
        label: ref.priority !== undefined ? `priority ${ref.priority}` : 'rules',
        title: `${policy.name ?? policy.id} evaluates ${rg?.name ?? ref.arn}`,
        refId: rg?.arn ?? ref.arn,
      });
    }
  }

  // --- WAF: web ACLs protecting load balancers in this VPC --------------------
  for (const acl of region.wafWebAcls) {
    for (const resourceArn of acl.associatedResourceArns) {
      if (!leaves.has(`res:${resourceArn}`)) continue;
      const aclNode = ensureSec(
        `waf:${acl.id}`, 'waf-web-acl', acl.name ?? acl.id,
        `WAF · ${acl.rules.length} rule${acl.rules.length === 1 ? '' : 's'}`, acl.arn ?? acl.id,
      );
      addEdge(`wafprot:${acl.id}|${resourceArn}`, aclNode, `res:${resourceArn}`, {
        edgeKind: 'uses',
        label: 'WAF protects',
        title: `${acl.name ?? acl.id} protects ${index.byKey.get(resourceArn)?.name ?? resourceArn}`,
        refId: acl.arn ?? acl.id,
      });
    }
  }

  // --- DNS Firewall rule groups filtering this VPC ----------------------------
  for (const rg of region.dnsFirewallRuleGroups) {
    if (!rg.vpcAssociations.some((a) => a.vpcId === vpcId)) continue;
    const count = rg.ruleCount ?? rg.rules.length;
    ensureSec(
      `dnsfw:${rg.id}`, 'dns-firewall-rule-group', rg.name ?? rg.id,
      `DNS Firewall · ${count} rule${count === 1 ? '' : 's'}`, rg.id,
    );
  }

  // --- Flow logs on this VPC ---------------------------------------------------
  for (const fl of region.flowLogs.filter((f) => f.resourceId === vpcId)) {
    ensureSec(
      `fl:${fl.id}`, 'flow-log', fl.name ?? fl.id,
      `flow logs → ${fl.logGroupName ?? fl.logDestination?.split(':').pop() ?? fl.logDestinationType ?? '?'}`,
      fl.id,
    );
  }

  // --- PrivateLink: endpoint services backed by load balancers here -----------
  for (const svc of region.vpcEndpointServices) {
    const backingLbArns = [...svc.networkLoadBalancerArns, ...svc.gatewayLoadBalancerArns].filter(
      (arn) => leaves.has(`res:${arn}`),
    );
    if (backingLbArns.length === 0) continue;
    const svcNode = ensureExt(
      `vpces:${svc.id}`, 'vpce-service', svc.name ?? svc.serviceName ?? svc.id,
      `PrivateLink · ${svc.connections.length} consumer${svc.connections.length === 1 ? '' : 's'}`,
      svc.id,
    );
    for (const arn of backingLbArns) {
      addEdge(`vpcesvc:${svc.id}|${arn}`, `res:${arn}`, svcNode, {
        edgeKind: 'edge-service',
        label: 'PrivateLink service',
        title: `${svc.serviceName ?? svc.id} exposed via PrivateLink`,
        refId: svc.id,
      });
    }
  }

  // --- Client VPN: remote-access entry point ---------------------------------
  for (const cvpn of region.clientVpnEndpoints.filter((c) => c.vpcId === vpcId)) {
    const node = ensureExt(
      `res:${cvpn.id}`, 'client-vpn', cvpn.name ?? cvpn.id,
      cvpn.clientCidrBlock ? `clients ${cvpn.clientCidrBlock}` : 'Client VPN', cvpn.id,
    );
    addEdge(`inet-cvpn:${cvpn.id}`, internetNode(), node, {
      edgeKind: 'edge-service',
      label: 'client VPN',
      title: `Internet → Client VPN ${cvpn.name ?? cvpn.id}`,
      refId: cvpn.id,
    });
    for (const subnetId of cvpn.associatedSubnetIds) {
      const tgt = subnetNode(subnetId);
      if (!tgt) continue;
      addEdge(`cvpnsub:${cvpn.id}|${subnetId}`, node, tgt, {
        edgeKind: 'vpn',
        label: cvpn.clientCidrBlock ?? 'client VPN',
        title: `Client VPN ${cvpn.name ?? cvpn.id} association`,
        refId: cvpn.id,
      });
    }
  }

  // --- CloudFront: internet → distribution → the origin LB in this VPC -------
  for (const account of index.snapshot.accounts) {
    for (const dist of account.global.cloudFrontDistributions) {
      for (const origin of dist.origins) {
        const lb = region.loadBalancers.find((l) => l.vpcId === vpcId && l.dnsName === origin);
        if (!lb || !leaves.has(`res:${lb.id}`)) continue;
        const cfNode = ensureExt(`cf:${dist.id}`, 'cloudfront', dist.name ?? dist.id, dist.domainName, dist.arn ?? dist.id);
        addEdge(`inet-cf:${dist.id}`, internetNode(), cfNode, {
          edgeKind: 'edge-service',
          label: destsLabel(dist.aliases, 2) || 'HTTPS',
          title: `Internet → CloudFront ${dist.name ?? dist.id}`,
          refId: dist.arn ?? dist.id,
        });
        addEdge(`cforig:${dist.id}|${lb.id}`, cfNode, `res:${lb.id}`, {
          edgeKind: 'edge-service',
          label: 'origin',
          title: `CloudFront origin ${origin}`,
          refId: dist.arn ?? dist.id,
        });
      }
    }
  }

  // --- IGW → internet (completes the egress path) -----------------------------
  for (const igw of region.internetGateways.filter((g) => g.vpcIds.includes(vpcId))) {
    addEdge(`inet-igw:${igw.id}`, `res:${igw.id}`, internetNode(), {
      edgeKind: 'route',
      title: `${igw.name ?? igw.id} → internet`,
      refId: igw.id,
    });
  }

  // --- security groups: nodes, attachments, allow rules, internet exposure ---
  const vpcSgs = region.securityGroups.filter((g) => g.vpcId === vpcId);
  const sgName = (groupId: string): string =>
    region.securityGroups.find((g) => g.id === groupId)?.name ?? index.byKey.get(groupId)?.name ?? groupId;

  for (const sg of vpcSgs) {
    const open = worldOpenIngress(sg);
    leaves.set(`sg:${sg.id}`, {
      ...leaf(`sg:${sg.id}`, vpcNodeId, 'sg', sg.name ?? sg.id, sg.description, sg.id, [
        `${sg.ingress.length} in / ${sg.egress.length} out`,
        ...(open.length > 0 ? ['open to internet'] : []),
      ]),
      width: 190,
      height: 104,
    });
  }

  // Referenced SGs that live outside this VPC (peer VPCs / other accounts).
  const sgRefNode = (ref: { groupId: string; accountId?: string; vpcId?: string }): string => {
    const id = `sg:${ref.groupId}`;
    if (leaves.has(id)) return id;
    const known = index.byKey.get(ref.groupId);
    ensureExt(id, 'sg', known?.name ?? ref.groupId,
      [ref.vpcId ?? known?.vpcId, ref.accountId].filter(Boolean).join(' · ') || 'external security group',
      ref.groupId);
    leaves.get(id)!.data.ghost = true;
    return id;
  };

  // SG → workload "applies to" edges (only for nodes actually on the diagram).
  const sgAttachSources: Array<{ nodeId: string; sgIds: string[] }> = [
    ...region.instances.filter((i) => i.vpcId === vpcId).map((i) => ({ nodeId: `res:${i.id}`, sgIds: i.securityGroupIds })),
    ...region.loadBalancers.filter((l) => l.vpcId === vpcId).map((l) => ({ nodeId: `res:${l.id}`, sgIds: l.securityGroupIds })),
    ...region.rdsInstances.filter((r) => r.vpcId === vpcId).map((r) => ({ nodeId: `res:${r.id}`, sgIds: r.securityGroupIds })),
    ...region.rdsClusters.filter((c) => c.vpcId === vpcId).map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.elastiCacheClusters.filter((c) => c.vpcId === vpcId).map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.lambdaFunctions.map((f) => ({ nodeId: `res:${f.id}`, sgIds: f.vpcConfig?.securityGroupIds ?? [] })),
    ...region.ecsServices.map((s) => ({ nodeId: `res:${s.id}`, sgIds: s.securityGroupIds })),
    ...region.eksClusters.filter((e) => e.vpcId === vpcId).map((e) => ({ nodeId: `res:${e.id}`, sgIds: e.securityGroupIds })),
    ...region.resolverEndpoints.filter((e) => e.vpcId === vpcId).map((e) => ({ nodeId: `res:${e.id}`, sgIds: e.securityGroupIds })),
    ...region.clientVpnEndpoints.filter((c) => c.vpcId === vpcId).map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.rdsProxies.filter((p) => p.vpcId === vpcId).map((p) => ({ nodeId: `res:${p.id}`, sgIds: p.securityGroupIds })),
    ...region.efsFileSystems.filter((f) => f.vpcId === vpcId).map((f) => ({
      nodeId: `res:${f.id}`,
      sgIds: [...new Set(f.mountTargets.flatMap((mt) => mt.securityGroupIds))],
    })),
    ...region.openSearchDomains.filter((d) => d.vpcId === vpcId).map((d) => ({ nodeId: `res:${d.id}`, sgIds: d.securityGroupIds })),
    ...region.mskClusters.map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.redshiftClusters.filter((c) => c.vpcId === vpcId).map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.redshiftServerlessWorkgroups.map((wg) => ({ nodeId: `res:${wg.id}`, sgIds: wg.securityGroupIds })),
    ...region.directoryServiceDirectories.map((d) => ({ nodeId: `res:${d.id}`, sgIds: d.securityGroupId ? [d.securityGroupId] : [] })),
    ...region.mqBrokers.map((broker) => ({ nodeId: `res:${broker.id}`, sgIds: broker.securityGroupIds })),
    ...region.elastiCacheServerlessCaches.map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.instanceConnectEndpoints.filter((e) => e.vpcId === vpcId).map((e) => ({ nodeId: `res:${e.id}`, sgIds: e.securityGroupIds })),
    ...region.glueConnections.map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.glueDevEndpoints.map((e) => ({ nodeId: `res:${e.id}`, sgIds: e.securityGroupIds })),
    ...region.dmsReplicationInstances.map((d) => ({ nodeId: `res:${d.id}`, sgIds: d.securityGroupIds })),
    ...region.dataSyncAgents.map((a) => ({ nodeId: `res:${a.id}`, sgIds: a.securityGroupArns.map(arnResourceId) })),
    ...region.firehoseDeliveryStreams.map((f) => ({ nodeId: `res:${f.id}`, sgIds: f.securityGroupIds })),
    ...region.emrClusters.map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.batchComputeEnvironments.map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.neptuneClusters.map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.docDbClusters.map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.memoryDbClusters.map((c) => ({ nodeId: `res:${c.id}`, sgIds: c.securityGroupIds })),
    ...region.transferServers.map((t) => ({ nodeId: `res:${t.id}`, sgIds: t.securityGroupIds })),
    ...region.beanstalkEnvironments.map((e) => ({ nodeId: `res:${e.id}`, sgIds: e.securityGroupIds })),
  ];
  for (const { nodeId, sgIds } of sgAttachSources) {
    if (!leaves.has(nodeId)) continue;
    for (const sgId of sgIds) {
      if (!leaves.has(`sg:${sgId}`)) continue;
      addEdge(`sgatt:${sgId}|${nodeId}`, `sg:${sgId}`, nodeId, {
        edgeKind: 'sg-attach',
        title: `${sgName(sgId)} applies to ${leaves.get(nodeId)?.data.label ?? nodeId}`,
        refId: sgId,
      });
    }
  }

  // SG ↔ SG allow rules, merged per (source, target) pair.
  const sgRules = new Map<string, { src: string; tgt: string; refId: string; rows: RouteDetail[] }>();
  const addSgRule = (src: string, tgt: string, rule: SecurityGroupRule, refId: string, sourceLabel: string): void => {
    if (src === tgt) return; // self-references stay in the details panel
    const key = `sgrule:${src}|${tgt}`;
    const agg = sgRules.get(key) ?? { src, tgt, refId, rows: [] };
    const row: RouteDetail = { from: sourceLabel, dest: portLabel(rule), state: rule.description };
    if (!agg.rows.some((r) => r.from === row.from && r.dest === row.dest && r.state === row.state)) {
      agg.rows.push(row);
    }
    sgRules.set(key, agg);
  };
  for (const sg of vpcSgs) {
    for (const rule of sg.ingress) {
      for (const ref of rule.securityGroupRefs) {
        addSgRule(sgRefNode(ref), `sg:${sg.id}`, rule, sg.id, sgName(ref.groupId));
      }
    }
    for (const rule of sg.egress) {
      for (const ref of rule.securityGroupRefs) {
        // refId is the rule's *owner* SG (same as ingress) — the referenced group may be external and unresolvable.
        addSgRule(`sg:${sg.id}`, sgRefNode(ref), rule, sg.id, sgName(sg.id));
      }
    }
  }
  for (const [key, agg] of sgRules) {
    addEdge(key, agg.src, agg.tgt, {
      edgeKind: 'sg-rule',
      label: destsLabel(agg.rows.map((r) => r.dest), 2),
      title: `Allows ${leaves.get(agg.src)?.data.label ?? agg.src} → ${leaves.get(agg.tgt)?.data.label ?? agg.tgt}`,
      columns: SG_RULE_COLUMNS,
      routes: agg.rows,
      refId: agg.refId,
    });
  }

  // Internet exposure: world-open ingress gets its own loud edge.
  for (const sg of vpcSgs) {
    const open = worldOpenIngress(sg);
    if (open.length === 0) continue;
    addEdge(`sgopen:${sg.id}`, internetNode(), `sg:${sg.id}`, {
      edgeKind: 'sg-open',
      label: destsLabel(open.map(portLabel), 2),
      title: `Open to internet: ${sg.name ?? sg.id}`,
      columns: SG_RULE_COLUMNS,
      routes: open.map((r) => ({
        from: r.cidrs.includes('0.0.0.0/0') ? '0.0.0.0/0' : '::/0',
        dest: portLabel(r),
        state: r.description,
      })),
      refId: sg.id,
    });
  }

  // --- identity: IAM roles assumed by workloads here, certs on the LBs -------
  const account = index.snapshot.accounts.find((a) => a.accountId === vpcRef.accountId);
  if (account) {
    const roles = account.global.iamRoles;
    const roleByName = new Map(roles.map((r) => [r.name ?? r.id, r]));
    const profileByKey = new Map<string, (typeof account.global.iamInstanceProfiles)[number]>();
    for (const p of account.global.iamInstanceProfiles) {
      profileByKey.set(p.id, p);
      if (p.arn) profileByKey.set(p.arn, p);
    }
    const roleNode = (role: (typeof roles)[number]): string =>
      ensureSec(`iam:${role.arn ?? role.id}`, 'iam-role', role.name ?? role.id, role.description ?? 'IAM role', role.arn ?? role.id);

    for (const inst of region.instances.filter((i) => i.vpcId === vpcId)) {
      if (!inst.instanceProfileArn || !leaves.has(`res:${inst.id}`)) continue;
      const profile = profileByKey.get(inst.instanceProfileArn);
      const role = profile?.roleNames.map((n) => roleByName.get(n)).find((r) => r !== undefined);
      if (!role) continue;
      addEdge(`assume:${inst.id}`, `res:${inst.id}`, roleNode(role), {
        edgeKind: 'uses',
        title: `${inst.name ?? inst.id} assumes ${role.name ?? role.id}`,
        refId: role.arn ?? role.id,
      });
    }
    for (const fn of region.lambdaFunctions) {
      if (!fn.roleArn || !leaves.has(`res:${fn.id}`)) continue;
      const role =
        roles.find((r) => r.arn === fn.roleArn) ?? roleByName.get(fn.roleArn.split('/').pop() ?? '');
      if (!role) continue;
      addEdge(`assume:${fn.id}`, `res:${fn.id}`, roleNode(role), {
        edgeKind: 'uses',
        title: `${fn.name ?? fn.id} assumes ${role.name ?? role.id}`,
        refId: role.arn ?? role.id,
      });
    }
  }

  for (const cert of region.acmCertificates) {
    for (const userArn of cert.inUseBy) {
      if (!leaves.has(`res:${userArn}`)) continue;
      const certNode = ensureSec(
        `acm:${cert.id}`, 'acm', cert.domainName ?? cert.name ?? cert.id,
        [cert.status, cert.notAfter ? `expires ${cert.notAfter.slice(0, 10)}` : undefined]
          .filter(Boolean)
          .join(' · ') || 'certificate',
        cert.arn ?? cert.id,
      );
      addEdge(`certuse:${cert.id}|${userArn}`, `res:${userArn}`, certNode, {
        edgeKind: 'uses',
        label: 'TLS',
        title: `${index.byKey.get(userArn)?.name ?? userArn} uses certificate ${cert.domainName ?? cert.id}`,
        refId: cert.arn ?? cert.id,
      });
    }
  }

  const routes = subnetRoutes(region, vpcId).filter((r) => r.subnetId);
  const grouped = new Map<string, SubnetRoute[]>();
  for (const r of routes) {
    const key = `${r.subnetId}|${r.targetId}`;
    const list = grouped.get(key);
    if (list) list.push(r);
    else grouped.set(key, [r]);
  }

  const peerLabel = (pcxId: string): string => {
    const pcx = region.peeringConnections.find((p) => p.id === pcxId);
    if (!pcx) return pcxId;
    const other = pcx.requester.vpcId === vpcId ? pcx.accepter : pcx.requester;
    return `${other.vpcId ?? pcxId}`;
  };

  for (const [key, group] of grouped) {
    const [subnetId, targetId] = key.split('|') as [string, string];
    const src = subnetNode(subnetId);
    if (!src) continue;
    const sample = group[0]!;

    let tgt: string | undefined;
    let kind: EdgeKind = 'route';
    switch (sample.targetType) {
      case 'igw':
      case 'eigw':
      case 'nat':
      case 'vgw':
      case 'eni':
      case 'instance':
      case 'vpce':
        // Route targets without an on-diagram leaf (ENIs — e.g. NAT
        // instances/appliances — or instances hidden by the per-subnet
        // aggregation cap) still get a node in the Connectivity lane so the
        // route arrow never silently disappears.
        tgt = leaves.has(`res:${targetId}`)
          ? `res:${targetId}`
          : ensureExt(
              `other:${targetId}`,
              sample.targetType,
              index.byKey.get(targetId)?.name ?? targetId,
              sample.targetType,
              targetId,
            );
        break;
      case 'tgw':
        kind = 'tgw';
        tgt = ensureExt(`tgw:${targetId}`, 'tgw', index.byKey.get(targetId)?.name ?? targetId, 'transit gateway', targetId);
        break;
      case 'pcx':
        kind = 'peering';
        tgt = ensureExt(`pcx:${targetId}`, 'pcx', peerLabel(targetId), `peering ${targetId}`, targetId);
        break;
      default:
        tgt = ensureExt(`other:${targetId}`, 'route-table', targetId, sample.targetType);
        break;
    }
    if (!tgt) continue;

    const dests = group.map((r) => r.dest);
    const hasBlackhole = group.some((r) => r.state === 'blackhole');
    edges.set(key, {
      id: `edge:${key}`,
      source: src,
      target: tgt,
      type: 'annotated',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        edgeKind: kind,
        label: destsLabel(dests, 2) + (hasBlackhole ? ' ⚠' : ''),
        title: `Routes ${sample.from} → ${targetId}`,
        routes: group.map((r) => ({ from: r.from, dest: r.dest, state: r.state })),
        refId: targetId,
      },
    });
  }

  // --- LB -> instance target edges (subtle association lines) ---------------
  for (const lb of region.loadBalancers.filter((l) => l.vpcId === vpcId)) {
    const tgArns = new Set(lb.listeners.flatMap((l) => l.targetGroupArns));
    for (const tg of region.targetGroups.filter((t) => t.loadBalancerArns.includes(lb.id) || tgArns.has(t.id))) {
      // Listener-rule routing conditions (host/path) that forward to this target group.
      const conditions = lb.listeners
        .flatMap((l) => l.rules ?? [])
        .filter((r) => r.targetGroupArns.includes(tg.id))
        .flatMap((r) => r.conditions);
      const condLabel = destsLabel(conditions, 2);
      for (const target of tg.targets) {
        const tgtNode = `res:${target.targetId}`;
        if (!leaves.has(tgtNode)) continue;
        const key = `assoc:${lb.id}|${target.targetId}`;
        if (edges.has(key)) continue;
        const portLbl = tg.port ? `${tg.protocol ?? ''} ${tg.port}` : '';
        const label = [portLbl, condLabel].filter(Boolean).join(' · ') || undefined;
        edges.set(key, {
          id: `edge:${key}`,
          source: `res:${lb.id}`,
          target: tgtNode,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'assoc',
            label,
            title: `${lb.name ?? lb.id} → ${target.targetId} (${tg.name ?? 'target group'})`,
            refId: tg.id,
          },
        });
      }
    }
  }

  // --- VPN edges from VGWs in this VPC --------------------------------------
  for (const vpn of region.vpnConnections) {
    if (!vpn.vpnGatewayId || !leaves.has(`res:${vpn.vpnGatewayId}`)) continue;
    const cgw = region.customerGateways.find((c) => c.id === vpn.customerGatewayId);
    const cgwId = ensureExt(`cgw:${vpn.customerGatewayId}`, 'cgw', cgw?.name ?? vpn.customerGatewayId ?? 'customer gateway', cgw?.ipAddress, vpn.customerGatewayId);
    edges.set(`vpn:${vpn.id}`, {
      id: `edge:vpn:${vpn.id}`,
      source: `res:${vpn.vpnGatewayId}`,
      target: cgwId,
      type: 'annotated',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { edgeKind: 'vpn', label: vpn.name ?? vpn.id, title: `VPN ${vpn.name ?? vpn.id}`, refId: vpn.id },
    });
  }

  const nodes: AtlasNode[] = [];
  if (extUsed) {
    nodes.push({
      id: EXT_CONTAINER,
      type: 'container',
      position: { x: 0, y: 0 },
      data: {
        label: 'Connectivity',
        kind: 'group-external',
        isContainer: true,
        containerStyle: 'external',
      },
    });
  }
  if (secUsed) {
    nodes.push({
      id: SEC_CONTAINER,
      type: 'container',
      position: { x: 0, y: 0 },
      data: {
        label: 'Security & identity',
        kind: 'group-security',
        isContainer: true,
        containerStyle: 'security',
      },
    });
  }
  nodes.push(...containers, ...leaves.values());
  return { nodes, edges: [...edges.values()] };
}
