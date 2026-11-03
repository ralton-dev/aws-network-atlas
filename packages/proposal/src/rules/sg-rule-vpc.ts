/**
 * `sg-rule-vpc` (decision 48): a security-group rule that references a group
 * in a different VPC. AWS accepts such a reference only across a same-region
 * VPC peering, so a reference to a group in a VPC joined by a live,
 * same-region peering is not reported; anything else is (including a group
 * reached through a transit gateway — the schema does not record whether a
 * TGW has security-group referencing turned on, so that case still warns).
 *
 * The referenced group's VPC comes from its own record, else from the
 * reference's `vpcId` (a group in an unscanned account). A reference whose
 * VPC cannot be known is not reported.
 */
import type { Snapshot } from '@atlas/schema';

import type { DesignRule } from './index.js';
import { arr, byId, isLive, obj, proposalFindings, str, type Finding } from './support.js';

function find(snapshot: Snapshot): Finding[] {
  const groups = byId(snapshot, 'securityGroups');
  const peered = new Set<string>();
  for (const copies of byId(snapshot, 'peeringConnections').values()) {
    const pcx = copies[0]?.item;
    if (!pcx || !isLive(pcx)) continue;
    const req = obj(pcx['requester']);
    const acc = obj(pcx['accepter']);
    const x = str(req['vpcId']);
    const y = str(acc['vpcId']);
    const rx = str(req['region']);
    const ry = str(acc['region']);
    if (!x || !y || (rx && ry && rx !== ry)) continue;
    peered.add(`${x}|${y}`).add(`${y}|${x}`);
  }

  const findings: Finding[] = [];
  for (const [id, copies] of groups) {
    const sg = copies[0]?.item;
    const vpcId = str(sg?.['vpcId']);
    if (!sg || !vpcId) continue;
    for (const direction of ['ingress', 'egress'] as const) {
      arr(sg[direction]).forEach((rule, i) => {
        arr(obj(rule)['securityGroupRefs']).forEach((ref, j) => {
          const groupId = str(obj(ref)['groupId']);
          if (!groupId || groupId === id) return;
          const theirs = str(groups.get(groupId)?.[0]?.item['vpcId']) ?? str(obj(ref)['vpcId']);
          if (!theirs || theirs === vpcId || peered.has(`${vpcId}|${theirs}`)) return;
          findings.push({
            identity: `${id}|${direction}|${groupId}|${vpcId}|${theirs}`,
            message: `security group ${id} (VPC ${vpcId}) has an ${direction} rule referencing ${groupId} in VPC ${theirs}; a rule can reference a group in another VPC only across a same-region peering`,
            involves: [
              { key: id, field: direction, suffix: `[${i}].securityGroupRefs[${j}].groupId` },
              { key: groupId, field: 'vpcId' },
            ],
          });
        });
      });
    }
  }
  return findings;
}

export const sgRuleVpc: DesignRule = {
  code: 'sg-rule-vpc',
  description: 'A security-group rule references a group in a different VPC not joined by a same-region peering.',
  check: (context) => proposalFindings('sg-rule-vpc', context, find),
};
