import { MarkerType } from '@xyflow/react';
import type { RegionSnapshot } from '@atlas/schema';
import type { AtlasIndex } from '../data.js';
import {
  destsLabel,
  type AtlasEdge,
  type AtlasGraph,
  type AtlasNode,
  type EdgeKind,
} from './graph-types.js';
import { subnetRoutes, type SubnetRoute } from './routes.js';

const MAX_INSTANCES_PER_SUBNET = 12;
const EXT_CONTAINER = 'ext:connectivity';

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
    leaves.set(`res:${rds.id}`, leaf(
      `res:${rds.id}`, azSubnet ? `res:${azSubnet.id}` : vpcNodeId, 'rds',
      rds.name ?? rds.id, rds.engine, rds.id,
      rds.multiAz ? ['multi-AZ'] : undefined,
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

  // --- external connectivity nodes + route-derived edges ---------------------
  const ensureExt = (id: string, kind: string, label: string, subtitle?: string, refId?: string): string => {
    extUsed = true;
    if (!leaves.has(id)) {
      leaves.set(id, leaf(id, EXT_CONTAINER, kind, label, subtitle, refId));
    }
    return id;
  };

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
      for (const target of tg.targets) {
        const tgtNode = `res:${target.targetId}`;
        if (!leaves.has(tgtNode)) continue;
        const key = `assoc:${lb.id}|${target.targetId}`;
        if (edges.has(key)) continue;
        edges.set(key, {
          id: `edge:${key}`,
          source: `res:${lb.id}`,
          target: tgtNode,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'assoc',
            label: tg.port ? `${tg.protocol ?? ''} ${tg.port}` : undefined,
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
  nodes.push(...containers, ...leaves.values());
  return { nodes, edges: [...edges.values()] };
}
