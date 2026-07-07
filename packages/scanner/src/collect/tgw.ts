import {
  EC2Client,
  paginateDescribeTransitGateways,
  paginateDescribeTransitGatewayAttachments,
  paginateDescribeTransitGatewayVpcAttachments,
  paginateDescribeTransitGatewayPeeringAttachments,
  paginateDescribeTransitGatewayRouteTables,
  paginateDescribeTransitGatewayConnectPeers,
  paginateGetTransitGatewayRouteTableAssociations,
  paginateGetTransitGatewayRouteTablePropagations,
  paginateSearchTransitGatewayRoutes,
} from '@aws-sdk/client-ec2';
import type { RegionSnapshot, TgwAttachmentResourceType } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { toTags, nameTag } from '../util.js';

const ATTACHMENT_TYPES = new Set<TgwAttachmentResourceType>([
  'vpc',
  'vpn',
  'direct-connect-gateway',
  'peering',
  'connect',
  'tgw-peering',
]);

function attachmentType(t?: string): TgwAttachmentResourceType {
  return ATTACHMENT_TYPES.has(t as TgwAttachmentResourceType)
    ? (t as TgwAttachmentResourceType)
    : 'other';
}

/** Collect transit gateways, attachments, and TGW route tables for one region. */
export async function collectTgw(ctx: AwsContext, region: string, out: RegionSnapshot): Promise<void> {
  const ec2 = ctx.client(EC2Client, region);
  const errors = out.errors;

  await guard(errors, 'ec2', 'DescribeTransitGateways', async () => {
    for await (const page of paginateDescribeTransitGateways({ client: ec2 }, {})) {
      for (const tgw of page.TransitGateways ?? []) {
        const tags = toTags(tgw.Tags);
        out.transitGateways.push({
          id: tgw.TransitGatewayId!,
          arn: tgw.TransitGatewayArn,
          name: nameTag(tags),
          tags,
          ownerId: tgw.OwnerId,
          state: tgw.State,
          description: tgw.Description,
          amazonSideAsn: tgw.Options?.AmazonSideAsn,
          associationDefaultRouteTableId: tgw.Options?.AssociationDefaultRouteTableId,
          propagationDefaultRouteTableId: tgw.Options?.PropagationDefaultRouteTableId,
        });
      }
    }
  });

  // Subnet placement for VPC attachments; keyed by attachment id.
  const vpcAttachmentSubnets = new Map<string, string[]>();
  await guard(errors, 'ec2', 'DescribeTransitGatewayVpcAttachments', async () => {
    for await (const page of paginateDescribeTransitGatewayVpcAttachments({ client: ec2 }, {})) {
      for (const a of page.TransitGatewayVpcAttachments ?? []) {
        if (a.TransitGatewayAttachmentId) {
          vpcAttachmentSubnets.set(a.TransitGatewayAttachmentId, a.SubnetIds ?? []);
        }
      }
    }
  });

  // Both sides of each peering attachment; the local/remote split is resolved
  // later against the attachment's own TransitGatewayId (intra-region peering
  // means regions can match, so region alone can't identify the remote side).
  const peeringSides = new Map<
    string,
    Array<{ transitGatewayId?: string; accountId?: string; region?: string }>
  >();
  await guard(errors, 'ec2', 'DescribeTransitGatewayPeeringAttachments', async () => {
    for await (const page of paginateDescribeTransitGatewayPeeringAttachments({ client: ec2 }, {})) {
      for (const a of page.TransitGatewayPeeringAttachments ?? []) {
        if (!a.TransitGatewayAttachmentId) continue;
        peeringSides.set(
          a.TransitGatewayAttachmentId,
          [a.RequesterTgwInfo, a.AccepterTgwInfo].map((s) => ({
            transitGatewayId: s?.TransitGatewayId,
            accountId: s?.OwnerId,
            region: s?.Region,
          })),
        );
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeTransitGatewayAttachments', async () => {
    for await (const page of paginateDescribeTransitGatewayAttachments({ client: ec2 }, {})) {
      for (const a of page.TransitGatewayAttachments ?? []) {
        const tags = toTags(a.Tags);
        const id = a.TransitGatewayAttachmentId!;
        // The peer is whichever side is NOT this attachment's own TGW.
        const sides = peeringSides.get(id);
        const peer = sides?.find((s) => s.transitGatewayId !== a.TransitGatewayId) ?? undefined;
        out.transitGatewayAttachments.push({
          id,
          name: nameTag(tags),
          tags,
          transitGatewayId: a.TransitGatewayId ?? '',
          transitGatewayOwnerId: a.TransitGatewayOwnerId,
          resourceOwnerId: a.ResourceOwnerId,
          resourceType: attachmentType(a.ResourceType),
          resourceId: a.ResourceId,
          state: a.State,
          associationRouteTableId: a.Association?.TransitGatewayRouteTableId,
          subnetIds: vpcAttachmentSubnets.get(id) ?? [],
          peer,
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeTransitGatewayRouteTables', async () => {
    for await (const page of paginateDescribeTransitGatewayRouteTables({ client: ec2 }, {})) {
      for (const rt of page.TransitGatewayRouteTables ?? []) {
        const tags = toTags(rt.Tags);
        const id = rt.TransitGatewayRouteTableId!;

        const routes: RegionSnapshot['transitGatewayRouteTables'][number]['routes'] = [];
        await guard(errors, 'ec2', `SearchTransitGatewayRoutes(${id})`, async () => {
          // TransitGatewayRouteTableId AND Filters are both required.
          for await (const routePage of paginateSearchTransitGatewayRoutes(
            { client: ec2 },
            {
              TransitGatewayRouteTableId: id,
              Filters: [{ Name: 'state', Values: ['active', 'blackhole'] }],
            },
          )) {
            for (const r of routePage.Routes ?? []) {
              routes.push({
                destinationCidr: r.DestinationCidrBlock,
                prefixListId: r.PrefixListId,
                attachmentIds: (r.TransitGatewayAttachments ?? [])
                  .map((att) => att.TransitGatewayAttachmentId)
                  .filter((x): x is string => !!x),
                resourceIds: (r.TransitGatewayAttachments ?? [])
                  .map((att) => att.ResourceId)
                  .filter((x): x is string => !!x),
                resourceType: attachmentType(r.TransitGatewayAttachments?.[0]?.ResourceType),
                routeType: r.Type === 'static' ? 'static' : 'propagated',
                state: r.State,
              });
            }
          }
        });

        const associations: Array<{ attachmentId: string; resourceId?: string; resourceType?: string }> = [];
        await guard(errors, 'ec2', `GetTransitGatewayRouteTableAssociations(${id})`, async () => {
          for await (const assocPage of paginateGetTransitGatewayRouteTableAssociations(
            { client: ec2 },
            { TransitGatewayRouteTableId: id },
          )) {
            for (const assoc of assocPage.Associations ?? []) {
              if (assoc.TransitGatewayAttachmentId) {
                associations.push({
                  attachmentId: assoc.TransitGatewayAttachmentId,
                  resourceId: assoc.ResourceId,
                  resourceType: assoc.ResourceType,
                });
              }
            }
          }
        });

        // Propagations explain WHY a propagated route is in the table.
        const propagations: NonNullable<
          RegionSnapshot['transitGatewayRouteTables'][number]['propagations']
        > = [];
        await guard(errors, 'ec2', `GetTransitGatewayRouteTablePropagations(${id})`, async () => {
          for await (const propPage of paginateGetTransitGatewayRouteTablePropagations(
            { client: ec2 },
            { TransitGatewayRouteTableId: id },
          )) {
            for (const prop of propPage.TransitGatewayRouteTablePropagations ?? []) {
              if (prop.TransitGatewayAttachmentId) {
                propagations.push({
                  attachmentId: prop.TransitGatewayAttachmentId,
                  resourceId: prop.ResourceId,
                  resourceType: prop.ResourceType,
                  state: prop.State,
                });
              }
            }
          }
        });

        out.transitGatewayRouteTables.push({
          id,
          name: nameTag(tags),
          tags,
          transitGatewayId: rt.TransitGatewayId ?? '',
          isDefaultAssociation: rt.DefaultAssociationRouteTable ?? false,
          isDefaultPropagation: rt.DefaultPropagationRouteTable ?? false,
          routes,
          associations,
          propagations,
        });
      }
    }
  });

  // GRE/BGP peers on Connect attachments — the attachment alone says nothing
  // about who is actually peered over it.
  await guard(errors, 'ec2', 'DescribeTransitGatewayConnectPeers', async () => {
    for await (const page of paginateDescribeTransitGatewayConnectPeers({ client: ec2 }, {})) {
      for (const peer of page.TransitGatewayConnectPeers ?? []) {
        const tags = toTags(peer.Tags);
        const config = peer.ConnectPeerConfiguration;
        out.transitGatewayConnectPeers.push({
          id: peer.TransitGatewayConnectPeerId!,
          name: nameTag(tags),
          tags,
          attachmentId: peer.TransitGatewayAttachmentId,
          state: peer.State,
          insideCidrBlocks: [...(config?.InsideCidrBlocks ?? [])].sort(),
          peerAddress: config?.PeerAddress,
          transitGatewayAddress: config?.TransitGatewayAddress,
          bgpAsn: config?.BgpConfigurations?.[0]?.PeerAsn,
        });
      }
    }
  });
}
