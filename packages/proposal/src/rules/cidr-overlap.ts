/**
 * `cidr-overlap` (decision 48): two VPCs joined by a peering connection or by
 * a shared transit gateway whose IPv4 CIDRs overlap — traffic between them
 * cannot be routed. Through a TGW every VPC attached to it counts as joined
 * to every other, so two spokes that are each fine against the hub but
 * overlap each other are reported; TGW route-table segmentation is not
 * modelled (an isolated pair still warns).
 *
 * A VPC's CIDRs come from its `vpcs` record, else from the peering side that
 * names it (an unscanned peer). IPv6 blocks are not compared.
 */
import type { Snapshot } from '@atlas/schema';

import type { DesignRule } from './index.js';
import { byId, cidrsOverlap, isLive, obj, parseAll, proposalFindings, str, strs, type Finding, type Involved } from './support.js';

interface Link {
  a: string;
  b: string;
  /** The first connection found joining them, for the message. */
  via: string;
  connections: string[];
  fallback: Map<string, string[]>;
}

function find(snapshot: Snapshot): Finding[] {
  const vpcs = byId(snapshot, 'vpcs');
  const links = new Map<string, Link>();
  const link = (x: string, y: string, via: string, connections: string[], fallback: [string, string[]][] = []): void => {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const id = `${a}|${b}`;
    const existing = links.get(id);
    if (existing) {
      existing.connections.push(...connections);
      for (const [k, v] of fallback) if (!existing.fallback.has(k)) existing.fallback.set(k, v);
    } else {
      links.set(id, { a, b, via, connections: [...connections], fallback: new Map(fallback) });
    }
  };

  const byTgw = new Map<string, { vpc: string; attachment: string }[]>();
  for (const [id, copies] of byId(snapshot, 'transitGatewayAttachments')) {
    const att = copies[0]?.item;
    if (!att || str(att['resourceType']) !== 'vpc' || !isLive(att)) continue;
    const tgw = str(att['transitGatewayId']);
    const vpc = str(att['resourceId']);
    if (!tgw || !vpc) continue;
    const members = byTgw.get(tgw) ?? [];
    members.push({ vpc, attachment: id });
    byTgw.set(tgw, members);
  }
  for (const [tgw, members] of byTgw) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const m = members[i];
        const n = members[j];
        if (m && n) link(m.vpc, n.vpc, `transit gateway ${tgw}`, [m.attachment, n.attachment, tgw]);
      }
    }
  }
  for (const [id, copies] of byId(snapshot, 'peeringConnections')) {
    const pcx = copies[0]?.item;
    if (!pcx || !isLive(pcx)) continue;
    const req = obj(pcx['requester']);
    const acc = obj(pcx['accepter']);
    const x = str(req['vpcId']);
    const y = str(acc['vpcId']);
    if (x && y) link(x, y, `peering ${id}`, [id], [[x, strs(req['cidrBlocks'])], [y, strs(acc['cidrBlocks'])]]);
  }

  const cidrsOf = (vpc: string, l: Link): string[] => {
    const record = vpcs.get(vpc)?.[0]?.item;
    return record ? strs(record['cidrBlocks']) : l.fallback.get(vpc) ?? [];
  };

  const findings: Finding[] = [];
  for (const l of links.values()) {
    const left = parseAll(cidrsOf(l.a, l));
    const right = parseAll(cidrsOf(l.b, l));
    const hit = left.flatMap((x) => right.filter((y) => cidrsOverlap(x, y)).map((y) => [x, y] as const))[0];
    if (!hit) continue;
    const involves: Involved[] = [
      { key: l.a, field: 'cidrBlocks' },
      { key: l.b, field: 'cidrBlocks' },
      ...l.connections.map((key) => ({ key })),
    ];
    findings.push({
      identity: `${l.a}|${l.b}`,
      message: `VPC ${l.a} (${hit[0].text}) and VPC ${l.b} (${hit[1].text}) overlap and are joined by ${l.via}; traffic between the overlapping ranges cannot be routed`,
      involves,
    });
  }
  return findings;
}


export const cidrOverlap: DesignRule = {
  code: 'cidr-overlap',
  description: 'Two VPCs joined by a peering or a shared transit gateway have overlapping IPv4 CIDRs.',
  check: (context) => proposalFindings('cidr-overlap', context, find),
};
