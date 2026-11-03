/**
 * `subnet-in-vpc` (decision 48): a subnet whose IPv4 CIDR is not inside any of
 * its VPC's CIDR blocks — including a subnet that *contains* its VPC (a `/15`
 * in a `/16` starts inside the VPC and is still wrong), and a subnet CIDR that
 * is not a valid IPv4 CIDR at all. A subnet with no `cidrBlock` (IPv6-only)
 * or whose VPC is not in the snapshot is not checked; the reference rule
 * already covers an unresolvable `vpcId`.
 */
import type { Snapshot } from '@atlas/schema';

import type { DesignRule } from './index.js';
import { byId, cidrContains, parseAll, parseCidr, proposalFindings, str, strs, type Finding } from './support.js';

function find(snapshot: Snapshot): Finding[] {
  const vpcs = byId(snapshot, 'vpcs');
  const findings: Finding[] = [];
  for (const [id, copies] of byId(snapshot, 'subnets')) {
    const subnet = copies[0]?.item;
    const vpcId = str(subnet?.['vpcId']);
    const text = str(subnet?.['cidrBlock']);
    const vpc = vpcId ? vpcs.get(vpcId)?.[0]?.item : undefined;
    if (!vpcId || !text || !vpc) continue;
    const involves = [
      { key: id, field: 'cidrBlock' },
      { key: vpcId, field: 'cidrBlocks' },
    ];
    const cidr = parseCidr(text);
    if (!cidr) {
      findings.push({ identity: `${id}|invalid|${text}`, message: `subnet ${id} has CIDR \`${text}\`, which is not a valid IPv4 CIDR`, involves });
      continue;
    }
    const blocks = strs(vpc['cidrBlocks']);
    if (parseAll(blocks).some((outer) => cidrContains(outer, cidr))) continue;
    findings.push({
      identity: `${id}|${text}|${blocks.join(',')}`,
      message: `subnet ${id} (${text}) is not inside its VPC ${vpcId} (${blocks.join(', ') || 'no IPv4 CIDR'})`,
      involves,
    });
  }
  return findings;
}

export const subnetInVpc: DesignRule = {
  code: 'subnet-in-vpc',
  description: "A subnet's IPv4 CIDR is not inside any of its VPC's CIDR blocks.",
  check: (context) => proposalFindings('subnet-in-vpc', context, find),
};
