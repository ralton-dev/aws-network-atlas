import type { TransitGatewayAttachment, VpcPeeringConnection } from '@atlas/schema';
import { MarkerType } from '@xyflow/react';
import type { AtlasIndex } from '../data.js';
import {
  destsLabel,
  type AtlasEdge,
  type AtlasGraph,
  type AtlasNode,
  type RouteDetail,
} from './graph-types.js';
import { subnetRoutes } from './routes.js';

const EXT_CONTAINER = 'ext:onprem';

interface Builder {
  accounts: Map<string, AtlasNode>;
  regions: Map<string, AtlasNode>;
  leaves: Map<string, AtlasNode>;
  edges: Map<string, AtlasEdge>;
  extUsed: boolean;
}

function ensureGhostAccount(b: Builder, accountId: string): string {
  const id = `acct:${accountId}`;
  if (!b.accounts.has(id)) {
    b.accounts.set(id, {
      id,
      type: 'container',
      position: { x: 0, y: 0 },
      data: {
        label: `Account ${accountId}`,
        subtitle: 'not scanned',
        kind: 'group-account',
        isContainer: true,
        containerStyle: 'ghost',
        ghost: true,
      },
    });
  }
  return id;
}

function ensureVpcNode(
  b: Builder,
  vpcId: string | undefined,
  accountId: string | undefined,
  region: string | undefined,
): string | undefined {
  if (!vpcId) return undefined;
  const id = `vpc:${vpcId}`;
  if (!b.leaves.has(id)) {
    const parent = accountId ? ensureGhostAccount(b, accountId) : undefined;
    b.leaves.set(id, {
      id,
      type: 'resource',
      position: { x: 0, y: 0 },
      parentId: parent,
      width: 210,
      height: 92,
      data: {
        label: vpcId,
        subtitle: region ? `${region} · not scanned` : 'not scanned',
        kind: 'vpc',
        refId: vpcId,
        drillVpcId: undefined,
        ghost: true,
      },
    });
  }
  return id;
}

function ensureTgwNode(b: Builder, tgwId: string | undefined, accountId?: string): string | undefined {
  if (!tgwId) return undefined;
  const id = `tgw:${tgwId}`;
  if (!b.leaves.has(id)) {
    const parent = accountId ? ensureGhostAccount(b, accountId) : undefined;
    b.leaves.set(id, {
      id,
      type: 'resource',
      position: { x: 0, y: 0 },
      parentId: parent,
      width: 150,
      height: 96,
      data: { label: tgwId, subtitle: 'not scanned', kind: 'tgw', refId: tgwId, ghost: true },
    });
  }
  return id;
}

function ensureExt(b: Builder): string {
  b.extUsed = true;
  return EXT_CONTAINER;
}

/** Build the global multi-account overview graph. */
export function buildOverview(index: AtlasIndex): AtlasGraph {
  const b: Builder = {
    accounts: new Map(),
    regions: new Map(),
    leaves: new Map(),
    edges: new Map(),
    extUsed: false,
  };

  // --- scanned accounts, regions, VPCs, TGWs -------------------------------
  for (const account of index.snapshot.accounts) {
    const acctId = `acct:${account.accountId}`;
    b.accounts.set(acctId, {
      id: acctId,
      type: 'container',
      position: { x: 0, y: 0 },
      data: {
        label: account.alias ?? account.accountId,
        subtitle: account.alias ? account.accountId : account.profile,
        kind: 'group-account',
        isContainer: true,
        containerStyle: 'account',
      },
    });

    for (const region of account.regions) {
      const regionId = `region:${account.accountId}:${region.region}`;
      b.regions.set(regionId, {
        id: regionId,
        type: 'container',
        position: { x: 0, y: 0 },
        parentId: acctId,
        data: {
          label: region.region,
          subtitle: region.empty ? '(empty)' : undefined,
          kind: 'group-region',
          isContainer: true,
          containerStyle: region.empty ? 'ghost' : 'region',
        },
      });

      for (const vpc of region.vpcs) {
        const id = `vpc:${vpc.id}`;
        b.leaves.set(id, {
          id,
          type: 'resource',
          position: { x: 0, y: 0 },
          parentId: regionId,
          width: 210,
          height: 92,
          data: {
            label: vpc.name ?? vpc.id,
            subtitle: vpc.cidrBlocks.join(', ') || undefined,
            kind: 'vpc',
            refId: vpc.id,
            drillVpcId: vpc.id,
            badges: [
              ...(vpc.isDefault ? ['default'] : []),
              `${region.subnets.filter((s) => s.vpcId === vpc.id).length} subnets`,
            ],
          },
        });
      }
    }

    if (account.emptyRegions.length > 0) {
      const shown = account.emptyRegions.slice(0, 6);
      const extra = account.emptyRegions.length - shown.length;
      b.leaves.set(`note:${acctId}`, {
        id: `note:${acctId}`,
        type: 'note',
        position: { x: 0, y: 0 },
        parentId: acctId,
        width: 250,
        height: 64,
        data: {
          label: `${account.emptyRegions.length} empty region(s) hidden`,
          subtitle: shown.join(', ') + (extra > 0 ? ` +${extra}` : ''),
          kind: 'note',
        },
      });
    }
  }

  // TGWs: prefer placing under the owner account's region.
  for (const pass of ['owner', 'other'] as const) {
    for (const account of index.snapshot.accounts) {
      for (const region of account.regions) {
        for (const tgw of region.transitGateways) {
          const isOwner = tgw.ownerId === account.accountId;
          if ((pass === 'owner') !== isOwner) continue;
          const id = `tgw:${tgw.id}`;
          if (b.leaves.has(id)) continue;
          b.leaves.set(id, {
            id,
            type: 'resource',
            position: { x: 0, y: 0 },
            parentId: `region:${account.accountId}:${region.region}`,
            width: 150,
            height: 96,
            data: {
              label: tgw.name ?? tgw.id,
              subtitle: tgw.description ?? undefined,
              kind: 'tgw',
              refId: tgw.id,
            },
          });
        }
      }
    }
  }

  // --- peering edges (deduped across accounts by pcx id) -------------------
  const peerings = new Map<string, { pcx: VpcPeeringConnection }>();
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const pcx of region.peeringConnections) {
        if (!peerings.has(pcx.id)) peerings.set(pcx.id, { pcx });
      }
    }
  }
  for (const { pcx } of peerings.values()) {
    const src = ensureVpcNode(b, pcx.requester.vpcId, pcx.requester.accountId, pcx.requester.region);
    const tgt = ensureVpcNode(b, pcx.accepter.vpcId, pcx.accepter.accountId, pcx.accepter.region);
    if (!src || !tgt) continue;

    const routes: RouteDetail[] = [];
    const dests: string[] = [];
    for (const side of [pcx.requester, pcx.accepter]) {
      if (!side.vpcId || !side.accountId || !side.region) continue;
      const regionSnap = index.findRegion(side.accountId, side.region);
      if (!regionSnap) continue;
      for (const r of subnetRoutes(regionSnap, side.vpcId)) {
        if (r.targetId !== pcx.id) continue;
        routes.push({ from: `${side.vpcId} / ${r.from}`, dest: r.dest, state: r.state });
        dests.push(r.dest);
      }
    }

    const statusSuffix = pcx.status && pcx.status !== 'active' ? ` (${pcx.status})` : '';
    b.edges.set(pcx.id, {
      id: `edge:${pcx.id}`,
      source: src,
      target: tgt,
      type: 'annotated',
      markerStart: { type: MarkerType.ArrowClosed },
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        edgeKind: 'peering',
        label: (destsLabel(dests) || 'VPC peering') + statusSuffix,
        title: `VPC peering ${pcx.name ?? pcx.id}`,
        routes,
        refId: pcx.id,
      },
    });
  }

  // --- transit gateway attachment edges ------------------------------------
  const tgwAttachments = new Map<string, TransitGatewayAttachment>();
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const att of region.transitGatewayAttachments) {
        const existing = tgwAttachments.get(att.id);
        // Prefer the copy with subnet detail (visible in the VPC-owner account).
        if (!existing || (existing.subnetIds.length === 0 && att.subnetIds.length > 0)) {
          tgwAttachments.set(att.id, att);
        }
      }
    }
  }

  for (const att of tgwAttachments.values()) {
    if (att.resourceType === 'vpc' && att.resourceId) {
      const src = ensureVpcNode(b, att.resourceId, att.resourceOwnerId, undefined);
      const tgt = ensureTgwNode(b, att.transitGatewayId, att.transitGatewayOwnerId);
      if (!src || !tgt) continue;
      const pairKey = `tgwvpc:${att.resourceId}|${att.transitGatewayId}`;
      if (b.edges.has(pairKey)) continue;

      const routes: RouteDetail[] = [];
      const dests: string[] = [];
      // VPC -> TGW routes, subnet-level (visible when the VPC's account is scanned).
      const vpcRef = index.byKey.get(att.resourceId);
      if (vpcRef) {
        const regionSnap = index.findRegion(vpcRef.accountId, vpcRef.region);
        if (regionSnap) {
          for (const r of subnetRoutes(regionSnap, att.resourceId)) {
            if (r.targetId !== att.transitGatewayId) continue;
            routes.push({ from: r.from, dest: r.dest, state: r.state });
            dests.push(r.dest);
          }
        }
      }
      // TGW -> VPC routes (from the TGW owner's route tables toward this attachment).
      const tgwRef = index.byKey.get(att.transitGatewayId);
      if (tgwRef) {
        const regionSnap = index.findRegion(tgwRef.accountId, tgwRef.region);
        for (const rt of regionSnap?.transitGatewayRouteTables ?? []) {
          for (const route of rt.routes) {
            if (!route.attachmentIds.includes(att.id)) continue;
            routes.push({
              from: `TGW ${rt.name ?? rt.id}`,
              dest: route.destinationCidr ?? route.prefixListId ?? '?',
              state: route.state,
              routeType: route.routeType,
            });
          }
        }
      }

      const stateSuffix = att.state && att.state !== 'available' ? ` (${att.state})` : '';
      b.edges.set(pairKey, {
        id: `edge:${att.id}`,
        source: src,
        target: tgt,
        type: 'annotated',
        markerStart: { type: MarkerType.ArrowClosed },
        markerEnd: { type: MarkerType.ArrowClosed },
        data: {
          edgeKind: 'tgw',
          label: (destsLabel(dests) || 'TGW attachment') + stateSuffix,
          title: `TGW attachment ${att.name ?? att.id}`,
          routes,
          refId: att.id,
        },
      });
    } else if ((att.resourceType === 'peering' || att.resourceType === 'tgw-peering') && att.peer?.transitGatewayId) {
      const a = ensureTgwNode(b, att.transitGatewayId, att.transitGatewayOwnerId);
      const z = ensureTgwNode(b, att.peer.transitGatewayId, att.peer.accountId);
      if (!a || !z) continue;
      const pairKey = 'tgwpeer:' + [a, z].sort().join('|');
      if (b.edges.has(pairKey)) continue;
      b.edges.set(pairKey, {
        id: `edge:${att.id}`,
        source: a,
        target: z,
        type: 'annotated',
        markerStart: { type: MarkerType.ArrowClosed },
        markerEnd: { type: MarkerType.ArrowClosed },
        data: {
          edgeKind: 'tgw',
          label: `TGW peering${att.peer.region ? ` · ${att.peer.region}` : ''}`,
          title: `TGW peering attachment ${att.name ?? att.id}`,
          refId: att.id,
        },
      });
    }
  }

  // --- VPN connections ------------------------------------------------------
  for (const account of index.snapshot.accounts) {
    const vgwVpc = new Map<string, string>();
    for (const region of account.regions) {
      for (const vgw of region.vpnGateways) {
        if (vgw.vpcIds[0]) vgwVpc.set(vgw.id, vgw.vpcIds[0]);
      }
    }
    for (const region of account.regions) {
      for (const vpn of region.vpnConnections) {
        if (b.edges.has(`vpn:${vpn.id}`)) continue;
        let src: string | undefined;
        if (vpn.transitGatewayId) src = ensureTgwNode(b, vpn.transitGatewayId);
        else if (vpn.vpnGatewayId) {
          const vpcId = vgwVpc.get(vpn.vpnGatewayId);
          src = ensureVpcNode(b, vpcId, account.accountId, region.region);
        }
        if (!src || !vpn.customerGatewayId) continue;

        const cgw = region.customerGateways.find((c) => c.id === vpn.customerGatewayId);
        const cgwNodeId = `cgw:${vpn.customerGatewayId}`;
        if (!b.leaves.has(cgwNodeId)) {
          b.leaves.set(cgwNodeId, {
            id: cgwNodeId,
            type: 'resource',
            position: { x: 0, y: 0 },
            parentId: ensureExt(b),
            width: 150,
            height: 96,
            data: {
              label: cgw?.name ?? vpn.customerGatewayId,
              subtitle: cgw?.ipAddress,
              kind: 'cgw',
              refId: vpn.customerGatewayId,
            },
          });
        }
        b.edges.set(`vpn:${vpn.id}`, {
          id: `edge:${vpn.id}`,
          source: src,
          target: cgwNodeId,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'vpn',
            label: `${vpn.name ?? vpn.id}${vpn.state && vpn.state !== 'available' ? ` (${vpn.state})` : ''}`,
            title: `Site-to-Site VPN ${vpn.name ?? vpn.id}`,
            routes: vpn.tunnels.map((t, i) => ({
              from: `tunnel ${i + 1}`,
              dest: t.outsideIp ?? '?',
              state: t.status,
            })),
            refId: vpn.id,
          },
        });
      }
    }
  }

  // --- Direct Connect gateways ---------------------------------------------
  // VGW ids are globally unique; a DX gateway in account A can associate with
  // a VGW owned by account B, so the lookup map must span every scanned account.
  const vgwVpcAll = new Map<string, { vpcId: string; accountId: string; region: string }>();
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const vgw of region.vpnGateways) {
        if (vgw.vpcIds[0]) {
          vgwVpcAll.set(vgw.id, {
            vpcId: vgw.vpcIds[0],
            accountId: account.accountId,
            region: region.region,
          });
        }
      }
    }
  }
  for (const account of index.snapshot.accounts) {
    for (const dxgw of account.global.directConnectGateways) {
      const nodeId = `dxgw:${dxgw.id}`;
      if (!b.leaves.has(nodeId)) {
        b.leaves.set(nodeId, {
          id: nodeId,
          type: 'resource',
          position: { x: 0, y: 0 },
          parentId: ensureExt(b),
          width: 150,
          height: 96,
          data: { label: dxgw.name ?? dxgw.id, subtitle: 'Direct Connect gateway', kind: 'dxgw', refId: dxgw.id },
        });
      }
      for (const assoc of dxgw.associations) {
        let tgt: string | undefined;
        if (assoc.associatedGatewayType === 'transitGateway') {
          tgt = ensureTgwNode(b, assoc.associatedGatewayId, assoc.associatedGatewayOwnerAccount);
        } else if (assoc.associatedGatewayType === 'virtualPrivateGateway' && assoc.associatedGatewayId) {
          const resolved = vgwVpcAll.get(assoc.associatedGatewayId);
          if (resolved) {
            tgt = ensureVpcNode(b, resolved.vpcId, resolved.accountId, resolved.region);
          } else {
            // Unscanned owner account: show a ghost VGW so the link stays visible.
            const ghostId = `vgw:${assoc.associatedGatewayId}`;
            if (!b.leaves.has(ghostId)) {
              b.leaves.set(ghostId, {
                id: ghostId,
                type: 'resource',
                position: { x: 0, y: 0 },
                parentId: assoc.associatedGatewayOwnerAccount
                  ? ensureGhostAccount(b, assoc.associatedGatewayOwnerAccount)
                  : undefined,
                width: 150,
                height: 96,
                data: {
                  label: assoc.associatedGatewayId,
                  subtitle: `VPN gateway${assoc.associatedGatewayRegion ? ` · ${assoc.associatedGatewayRegion}` : ''} · not scanned`,
                  kind: 'vgw',
                  refId: assoc.associatedGatewayId,
                  ghost: true,
                },
              });
            }
            tgt = ghostId;
          }
        }
        if (!tgt) continue;
        const key = `dx:${dxgw.id}|${tgt}`;
        if (b.edges.has(key)) continue;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: nodeId,
          target: tgt,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'dx',
            label: `DX association${assoc.state && assoc.state !== 'associated' ? ` (${assoc.state})` : ''}`,
            title: `Direct Connect gateway ${dxgw.name ?? dxgw.id}`,
            refId: dxgw.id,
          },
        });
      }
    }
  }

  // --- assemble: parents strictly before children ---------------------------
  const nodes: AtlasNode[] = [];
  if (b.extUsed) {
    nodes.push({
      id: EXT_CONTAINER,
      type: 'container',
      position: { x: 0, y: 0 },
      data: {
        label: 'External / on-premises',
        kind: 'group-external',
        isContainer: true,
        containerStyle: 'external',
      },
    });
  }
  nodes.push(...b.accounts.values());
  nodes.push(...b.regions.values());
  nodes.push(...b.leaves.values());

  return { nodes, edges: [...b.edges.values()] };
}
