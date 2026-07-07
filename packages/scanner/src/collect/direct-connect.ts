// Direct Connect regional pieces — READ-ONLY (Describe* only).
// DX *gateways* are global (collect/global.ts); the physical circuits
// (connections/LAGs) and the virtual interfaces that carry BGP live in the
// region of their DX location and are collected here.
import {
  DirectConnectClient,
  DescribeConnectionsCommand,
  DescribeLagsCommand,
  DescribeVirtualInterfacesCommand,
} from '@aws-sdk/client-direct-connect';
import type { RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

function dxTags(list?: Array<{ key?: string; value?: string }>): Tags {
  const tags: Tags = {};
  for (const t of list ?? []) {
    if (t.key) tags[t.key] = t.value ?? '';
  }
  return tags;
}

export async function collectDirectConnect(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const errors = out.errors;
  const dx = ctx.client(DirectConnectClient, region);

  await guard(errors, 'directconnect', 'DescribeConnections', async () => {
    const res = await dx.send(new DescribeConnectionsCommand({}));
    for (const c of res.connections ?? []) {
      if (!c.connectionId) continue;
      out.dxConnections.push({
        id: c.connectionId,
        name: c.connectionName,
        tags: dxTags(c.tags),
        location: c.location,
        bandwidth: c.bandwidth,
        state: c.connectionState,
        vlan: c.vlan,
        partnerName: c.partnerName,
        lagId: c.lagId,
        ownerAccount: c.ownerAccount,
      });
    }
  });

  await guard(errors, 'directconnect', 'DescribeLags', async () => {
    const res = await dx.send(new DescribeLagsCommand({}));
    for (const lag of res.lags ?? []) {
      if (!lag.lagId) continue;
      out.dxLags.push({
        id: lag.lagId,
        name: lag.lagName,
        tags: dxTags(lag.tags),
        location: lag.location,
        connectionsBandwidth: lag.connectionsBandwidth,
        numberOfConnections: lag.numberOfConnections,
        connectionIds: (lag.connections ?? [])
          .map((c) => c.connectionId)
          .filter((c): c is string => !!c)
          .sort(),
        state: lag.lagState,
        ownerAccount: lag.ownerAccount,
      });
    }
  });

  await guard(errors, 'directconnect', 'DescribeVirtualInterfaces', async () => {
    const res = await dx.send(new DescribeVirtualInterfacesCommand({}));
    for (const vif of res.virtualInterfaces ?? []) {
      if (!vif.virtualInterfaceId) continue;
      out.dxVirtualInterfaces.push({
        id: vif.virtualInterfaceId,
        name: vif.virtualInterfaceName,
        tags: dxTags(vif.tags),
        vifType: vif.virtualInterfaceType,
        state: vif.virtualInterfaceState,
        vlan: vif.vlan,
        bgpAsn: vif.asn,
        amazonSideAsn: vif.amazonSideAsn,
        connectionId: vif.connectionId,
        directConnectGatewayId: vif.directConnectGatewayId,
        virtualGatewayId: vif.virtualGatewayId || undefined,
        ownerAccount: vif.ownerAccount,
        amazonAddress: vif.amazonAddress,
        customerAddress: vif.customerAddress,
        routeFilterPrefixes: (vif.routeFilterPrefixes ?? [])
          .map((p) => p.cidr)
          .filter((c): c is string => !!c)
          .sort(),
        bgpPeers: (vif.bgpPeers ?? [])
          .map((p) => ({
            asn: p.asn,
            addressFamily: p.addressFamily as string | undefined,
            state: p.bgpPeerState,
            status: p.bgpStatus,
          }))
          .sort((a, b) => `${a.asn}|${a.addressFamily}`.localeCompare(`${b.asn}|${b.addressFamily}`)),
      });
    }
  });
}
