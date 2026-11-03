/**
 * `route-target` (decision 48): a route whose target does not resolve — no
 * resource of the route's `targetType` has that `targetId` — or resolves to
 * one the route table's VPC cannot use: an internet, egress-only or VPN
 * gateway not attached to the VPC; a NAT gateway, endpoint, interface or
 * instance in another VPC; a peering the VPC is not a side of; a transit
 * gateway the VPC has no live attachment to.
 *
 * `local` routes and target types with no scanned collection (`carrier`,
 * `localGateway`, `coreNetwork`, `other`) are not checked. A route the
 * proposal did not write can still be reported when the proposal removed or
 * moved its target — that problem is the proposal's.
 */
import type { Snapshot } from '@atlas/schema';

import { stableStringify } from '../stable-json.js';
import type { DesignRule } from './index.js';
import { arr, byId, isLive, obj, proposalFindings, str, strs, type Finding, type Item, type Located } from './support.js';

type Lookup = (collection: string) => Map<string, Located[]>;

interface Target {
  collection: string;
  noun: string;
  /** Whether a VPC may route to this target; `undefined` when the record cannot tell. */
  usableFrom(target: Item, vpcId: string, lookup: Lookup): boolean | undefined;
}

const vpcField = (target: Item, vpcId: string): boolean | undefined => {
  const v = str(target['vpcId']);
  return v === undefined ? undefined : v === vpcId;
};
const vpcList = (target: Item, vpcId: string): boolean => strs(target['vpcIds']).includes(vpcId);

const TARGETS: Record<string, Target> = {
  igw: { collection: 'internetGateways', noun: 'internet gateway', usableFrom: vpcList },
  eigw: { collection: 'egressOnlyInternetGateways', noun: 'egress-only internet gateway', usableFrom: vpcField },
  nat: { collection: 'natGateways', noun: 'NAT gateway', usableFrom: vpcField },
  vgw: { collection: 'vpnGateways', noun: 'VPN gateway', usableFrom: vpcList },
  vpce: { collection: 'vpcEndpoints', noun: 'VPC endpoint', usableFrom: vpcField },
  eni: { collection: 'networkInterfaces', noun: 'network interface', usableFrom: vpcField },
  instance: { collection: 'instances', noun: 'instance', usableFrom: vpcField },
  pcx: {
    collection: 'peeringConnections',
    noun: 'peering connection',
    usableFrom: (pcx, vpcId) => isLive(pcx) && [obj(pcx['requester']), obj(pcx['accepter'])].some((side) => side['vpcId'] === vpcId),
  },
  tgw: {
    collection: 'transitGateways',
    noun: 'transit gateway',
    usableFrom: (tgw, vpcId, lookup) => {
      for (const copies of lookup('transitGatewayAttachments').values()) {
        const att = copies[0]?.item;
        if (att && att['transitGatewayId'] === tgw['id'] && att['resourceType'] === 'vpc' && att['resourceId'] === vpcId && isLive(att)) return true;
      }
      return false;
    },
  },
};

function find(snapshot: Snapshot): Finding[] {
  const lookups = new Map<string, Map<string, Located[]>>();
  const lookup: Lookup = (collection) => {
    let found = lookups.get(collection);
    if (!found) lookups.set(collection, (found = byId(snapshot, collection)));
    return found;
  };
  const findings: Finding[] = [];
  for (const [id, copies] of byId(snapshot, 'routeTables')) {
    const table = copies[0]?.item;
    const vpcId = str(table?.['vpcId']);
    if (!table || !vpcId) continue;
    arr(table['routes']).forEach((value, i) => {
      const route = obj(value);
      const type = str(route['targetType']);
      const targetId = str(route['targetId']);
      const spec = type ? TARGETS[type] : undefined;
      if (!spec || !targetId || targetId === 'local') return;
      const destination = str(route['destinationCidr']) ?? str(route['destinationIpv6Cidr']) ?? str(route['destinationPrefixListId']) ?? '(no destination)';
      const involves = [{ key: id, field: 'routes', suffix: `[${i}].targetId` }, { key: targetId }];
      const identity = (problem: string): string => `${id}|${stableStringify(route)}|${problem}`;
      const target = lookup(spec.collection).get(targetId);
      if (!target) {
        findings.push({
          identity: identity('missing'),
          message: `route table ${id} routes ${destination} to ${targetId}, but there is no ${spec.noun} with that id`,
          involves,
        });
        return;
      }
      const usable = target.map((c) => spec.usableFrom(c.item, vpcId, lookup));
      if (usable.includes(true) || usable.every((u) => u === undefined)) return;
      findings.push({
        identity: identity('elsewhere'),
        message: `route table ${id} (VPC ${vpcId}) routes ${destination} to ${spec.noun} ${targetId}, which VPC ${vpcId} is not attached to or part of`,
        involves,
      });
    });
  }
  return findings;
}

export const routeTarget: DesignRule = {
  code: 'route-target',
  description: "A route's target does not exist, or is not usable from the route table's VPC.",
  check: (context) => proposalFindings('route-target', context, find),
};
