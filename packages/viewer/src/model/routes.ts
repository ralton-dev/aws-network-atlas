import type { RegionSnapshot, Route } from '@atlas/schema';
import type { RouteDetail } from './graph-types.js';

export interface SubnetRoute extends RouteDetail {
  subnetId?: string;
  targetId: string;
  targetType: Route['targetType'];
}

function destOf(r: Route): string {
  return r.destinationCidr ?? r.destinationIpv6Cidr ?? r.destinationPrefixListId ?? '?';
}

/**
 * Resolve a VPC's routes at subnet granularity: for every subnet, walk its
 * effective route table (explicit association or VPC main) and emit one
 * SubnetRoute per non-local route. This is what powers the "arrows annotated
 * with subnets/CIDRs" requirement.
 */
export function subnetRoutes(region: RegionSnapshot, vpcId: string): SubnetRoute[] {
  const tablesById = new Map(region.routeTables.map((rt) => [rt.id, rt]));
  const out: SubnetRoute[] = [];

  for (const subnet of region.subnets) {
    if (subnet.vpcId !== vpcId || !subnet.routeTableId) continue;
    const rt = tablesById.get(subnet.routeTableId);
    if (!rt) continue;
    for (const r of rt.routes) {
      if (r.targetType === 'local') continue;
      out.push({
        subnetId: subnet.id,
        from: subnet.name ?? subnet.id,
        dest: destOf(r),
        state: r.state,
        targetId: r.targetId,
        targetType: r.targetType,
      });
    }
  }

  // Route tables in this VPC with no subnet users still matter (e.g. main
  // table routing for future subnets, or gateway associations) — attribute
  // them to the table itself.
  const usedTables = new Set(
    region.subnets.filter((s) => s.vpcId === vpcId).map((s) => s.routeTableId),
  );
  for (const rt of region.routeTables) {
    if (rt.vpcId !== vpcId || usedTables.has(rt.id)) continue;
    for (const r of rt.routes) {
      if (r.targetType === 'local') continue;
      out.push({
        from: `${rt.name ?? rt.id}${rt.isMain ? ' (main, no subnets)' : ' (unassociated)'}`,
        dest: destOf(r),
        state: r.state,
        targetId: r.targetId,
        targetType: r.targetType,
      });
    }
  }

  return out;
}

/** Group subnet routes by their target id (e.g. one bucket per NAT/TGW/PCX). */
export function groupByTarget(routes: SubnetRoute[]): Map<string, SubnetRoute[]> {
  const map = new Map<string, SubnetRoute[]>();
  for (const r of routes) {
    const list = map.get(r.targetId);
    if (list) list.push(r);
    else map.set(r.targetId, [r]);
  }
  return map;
}
