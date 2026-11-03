/**
 * `attachment-locality` (decision 48): a VPC attachment to a transit gateway
 * must sit in the same region as its VPC, its subnets and the TGW, and its
 * VPC must be in the account the attachment names (`resourceOwnerId`, else
 * the account whose snapshot holds the attachment). Its subnets must be in
 * the attached VPC, and a `transitGatewayOwnerId` must match the TGW's owner.
 *
 * Shared resources have one copy per account that sees them, so each check
 * passes when *any* copy satisfies it. A VPC, subnet or TGW that is not in the
 * snapshot is not checked here (the reference rule covers it); non-VPC
 * attachments (VPN, peering, Connect) are not checked.
 */
import type { Snapshot } from '@atlas/schema';

import type { DesignRule } from './index.js';
import { byId, isLive, proposalFindings, str, strs, type Finding, type Located } from './support.js';

const where = (copies: Located[], pick: (c: Located) => string): string => [...new Set(copies.map(pick))].join(', ');

function find(snapshot: Snapshot): Finding[] {
  const vpcs = byId(snapshot, 'vpcs');
  const subnets = byId(snapshot, 'subnets');
  const tgws = byId(snapshot, 'transitGateways');
  const findings: Finding[] = [];
  for (const [id, copies] of byId(snapshot, 'transitGatewayAttachments')) {
    const att = copies[0]?.item;
    if (!att || str(att['resourceType']) !== 'vpc' || !isLive(att)) continue;
    const regions = new Set(copies.map((c) => c.region));
    const regionText = [...regions].join(', ');
    const owner = str(att['resourceOwnerId']);
    const accounts = owner ? new Set([owner]) : new Set(copies.map((c) => c.accountId));
    const vpcId = str(att['resourceId']);
    const vpcCopies = vpcId ? vpcs.get(vpcId) : undefined;

    if (vpcId && vpcCopies) {
      const at = [{ key: id, field: 'resourceId' }, { key: vpcId }];
      if (!vpcCopies.some((c) => regions.has(c.region))) {
        findings.push({
          identity: `${id}|vpc-region|${vpcId}`,
          message: `attachment ${id} is in ${regionText} but its VPC ${vpcId} is in ${where(vpcCopies, (c) => c.region)}; a TGW attachment must be in its VPC's region`,
          involves: at,
        });
      }
      if (!vpcCopies.some((c) => accounts.has(c.accountId))) {
        findings.push({
          identity: `${id}|vpc-account|${vpcId}`,
          message: `attachment ${id} says its VPC is in account ${[...accounts].join(', ')} but VPC ${vpcId} is in ${where(vpcCopies, (c) => c.accountId)}`,
          involves: [{ key: id, field: owner ? 'resourceOwnerId' : 'resourceId' }, { key: vpcId }],
        });
      }
    }

    strs(att['subnetIds']).forEach((subnetId, j) => {
      const subnetCopies = subnets.get(subnetId);
      if (!subnetCopies) return;
      const at = [{ key: id, field: 'subnetIds', suffix: `[${j}]` }, { key: subnetId }];
      if (!subnetCopies.some((c) => regions.has(c.region))) {
        findings.push({
          identity: `${id}|subnet-region|${subnetId}`,
          message: `attachment ${id} is in ${regionText} but its subnet ${subnetId} is in ${where(subnetCopies, (c) => c.region)}`,
          involves: at,
        });
      }
      const inVpc = str(subnetCopies[0]?.item['vpcId']);
      if (vpcId && inVpc && inVpc !== vpcId) {
        findings.push({
          identity: `${id}|subnet-vpc|${subnetId}|${inVpc}`,
          message: `attachment ${id} attaches VPC ${vpcId} but its subnet ${subnetId} is in VPC ${inVpc}`,
          involves: at,
        });
      }
    });

    const tgwId = str(att['transitGatewayId']);
    const tgwCopies = tgwId ? tgws.get(tgwId) : undefined;
    if (tgwId && tgwCopies) {
      const at = [{ key: id, field: 'transitGatewayId' }, { key: tgwId }];
      if (!tgwCopies.some((c) => regions.has(c.region))) {
        findings.push({
          identity: `${id}|tgw-region|${tgwId}`,
          message: `attachment ${id} is in ${regionText} but transit gateway ${tgwId} is in ${where(tgwCopies, (c) => c.region)}; reaching another region needs a TGW peering attachment`,
          involves: at,
        });
      }
      const said = str(att['transitGatewayOwnerId']);
      const actual = tgwCopies.map((c) => str(c.item['ownerId'])).find((o) => o !== undefined);
      if (said && actual && said !== actual) {
        findings.push({
          identity: `${id}|tgw-owner|${said}|${actual}`,
          message: `attachment ${id} says transit gateway ${tgwId} is owned by ${said}, but its owner is ${actual}`,
          involves: [{ key: id, field: 'transitGatewayOwnerId' }, { key: tgwId }],
        });
      }
    }
  }
  return findings;
}

export const attachmentLocality: DesignRule = {
  code: 'attachment-locality',
  description: "A TGW VPC attachment's VPC, subnets or transit gateway are in another region or account than the attachment says.",
  check: (context) => proposalFindings('attachment-locality', context, find),
};
