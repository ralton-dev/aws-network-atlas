import {
  EC2Client,
  paginateDescribeVpcs,
  paginateDescribeSubnets,
  paginateDescribeRouteTables,
  paginateDescribeInternetGateways,
  paginateDescribeEgressOnlyInternetGateways,
  paginateDescribeNatGateways,
  paginateDescribeNetworkAcls,
  paginateDescribeSecurityGroups,
  paginateDescribeNetworkInterfaces,
  paginateDescribeVpcEndpoints,
  paginateDescribeManagedPrefixLists,
  paginateGetManagedPrefixListEntries,
  paginateDescribeVpcPeeringConnections,
  DescribeAddressesCommand,
  DescribeVpnGatewaysCommand,
  DescribeCustomerGatewaysCommand,
  DescribeVpnConnectionsCommand,
  type Route as SdkRoute,
  type IpPermission,
} from '@aws-sdk/client-ec2';
import type {
  RegionSnapshot,
  Route,
  RouteTargetType,
  SecurityGroupRule,
  VpcEndpoint,
} from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { toTags, nameTag } from '../util.js';

function mapRoute(r: SdkRoute): Route {
  let targetType: RouteTargetType = 'other';
  let targetId = '';
  if (r.NatGatewayId) [targetType, targetId] = ['nat', r.NatGatewayId];
  else if (r.TransitGatewayId) [targetType, targetId] = ['tgw', r.TransitGatewayId];
  else if (r.VpcPeeringConnectionId) [targetType, targetId] = ['pcx', r.VpcPeeringConnectionId];
  else if (r.EgressOnlyInternetGatewayId) [targetType, targetId] = ['eigw', r.EgressOnlyInternetGatewayId];
  else if (r.NetworkInterfaceId) [targetType, targetId] = ['eni', r.NetworkInterfaceId];
  else if (r.InstanceId) [targetType, targetId] = ['instance', r.InstanceId];
  else if (r.CarrierGatewayId) [targetType, targetId] = ['carrier', r.CarrierGatewayId];
  else if (r.LocalGatewayId) [targetType, targetId] = ['localGateway', r.LocalGatewayId];
  else if (r.CoreNetworkArn) [targetType, targetId] = ['coreNetwork', r.CoreNetworkArn];
  else if (r.GatewayId) {
    const g = r.GatewayId;
    if (g === 'local') [targetType, targetId] = ['local', g];
    else if (g.startsWith('igw-')) [targetType, targetId] = ['igw', g];
    else if (g.startsWith('vgw-')) [targetType, targetId] = ['vgw', g];
    else if (g.startsWith('vpce-')) [targetType, targetId] = ['vpce', g];
    else [targetType, targetId] = ['other', g];
  }
  return {
    destinationCidr: r.DestinationCidrBlock,
    destinationIpv6Cidr: r.DestinationIpv6CidrBlock,
    destinationPrefixListId: r.DestinationPrefixListId,
    targetType,
    targetId,
    state: r.State === 'blackhole' ? 'blackhole' : 'active',
    origin: r.Origin,
  };
}

function mapSgRules(perms: IpPermission[] | undefined): SecurityGroupRule[] {
  return (perms ?? []).map((p) => {
    const description =
      p.IpRanges?.find((r) => r.Description)?.Description ??
      p.Ipv6Ranges?.find((r) => r.Description)?.Description ??
      p.UserIdGroupPairs?.find((g) => g.Description)?.Description;
    return {
      protocol: p.IpProtocol ?? '-1',
      fromPort: p.FromPort,
      toPort: p.ToPort,
      cidrs: (p.IpRanges ?? []).map((r) => r.CidrIp).filter((c): c is string => !!c),
      ipv6Cidrs: (p.Ipv6Ranges ?? []).map((r) => r.CidrIpv6).filter((c): c is string => !!c),
      prefixListIds: (p.PrefixListIds ?? []).map((r) => r.PrefixListId).filter((c): c is string => !!c),
      securityGroupRefs: (p.UserIdGroupPairs ?? [])
        .filter((g) => g.GroupId)
        .map((g) => ({ groupId: g.GroupId!, accountId: g.UserId, vpcId: g.VpcId })),
      description,
    };
  });
}

const ENDPOINT_TYPES = new Set(['Interface', 'Gateway', 'GatewayLoadBalancer', 'Resource', 'ServiceNetwork']);

/** Collect all EC2 networking primitives for one region into `out`. */
export async function collectNetwork(
  ctx: AwsContext,
  region: string,
  accountId: string,
  out: RegionSnapshot,
): Promise<void> {
  const ec2 = ctx.client(EC2Client, region);
  const errors = out.errors;

  await guard(errors, 'ec2', 'DescribeVpcs', async () => {
    for await (const page of paginateDescribeVpcs({ client: ec2 }, {})) {
      for (const v of page.Vpcs ?? []) {
        const tags = toTags(v.Tags);
        out.vpcs.push({
          id: v.VpcId!,
          name: nameTag(tags),
          tags,
          cidrBlocks: (v.CidrBlockAssociationSet ?? [])
            .filter((a) => a.CidrBlockState?.State === 'associated')
            .map((a) => a.CidrBlock)
            .filter((c): c is string => !!c),
          ipv6CidrBlocks: (v.Ipv6CidrBlockAssociationSet ?? [])
            .filter((a) => a.Ipv6CidrBlockState?.State === 'associated')
            .map((a) => a.Ipv6CidrBlock)
            .filter((c): c is string => !!c),
          isDefault: v.IsDefault ?? false,
          state: v.State,
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeSubnets', async () => {
    for await (const page of paginateDescribeSubnets({ client: ec2 }, {})) {
      for (const s of page.Subnets ?? []) {
        const tags = toTags(s.Tags);
        out.subnets.push({
          id: s.SubnetId!,
          arn: s.SubnetArn,
          name: nameTag(tags),
          tags,
          vpcId: s.VpcId ?? '',
          cidrBlock: s.CidrBlock,
          ipv6CidrBlocks: (s.Ipv6CidrBlockAssociationSet ?? [])
            .map((a) => a.Ipv6CidrBlock)
            .filter((c): c is string => !!c),
          availabilityZone: s.AvailabilityZone ?? '',
          availabilityZoneId: s.AvailabilityZoneId,
          availableIpAddressCount: s.AvailableIpAddressCount,
          mapPublicIpOnLaunch: s.MapPublicIpOnLaunch ?? false,
          // routeTableId + isPublic are resolved in the derive step.
          isPublic: false,
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeRouteTables', async () => {
    for await (const page of paginateDescribeRouteTables({ client: ec2 }, {})) {
      for (const rt of page.RouteTables ?? []) {
        const tags = toTags(rt.Tags);
        out.routeTables.push({
          id: rt.RouteTableId!,
          name: nameTag(tags),
          tags,
          vpcId: rt.VpcId ?? '',
          isMain: (rt.Associations ?? []).some((a) => a.Main === true),
          subnetAssociations: (rt.Associations ?? [])
            .map((a) => a.SubnetId)
            .filter((s): s is string => !!s),
          gatewayAssociations: (rt.Associations ?? [])
            .map((a) => a.GatewayId)
            .filter((g): g is string => !!g),
          routes: (rt.Routes ?? []).map(mapRoute),
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeInternetGateways', async () => {
    for await (const page of paginateDescribeInternetGateways({ client: ec2 }, {})) {
      for (const igw of page.InternetGateways ?? []) {
        const tags = toTags(igw.Tags);
        out.internetGateways.push({
          id: igw.InternetGatewayId!,
          name: nameTag(tags),
          tags,
          vpcIds: (igw.Attachments ?? []).map((a) => a.VpcId).filter((v): v is string => !!v),
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeEgressOnlyInternetGateways', async () => {
    for await (const page of paginateDescribeEgressOnlyInternetGateways({ client: ec2 }, {})) {
      for (const eigw of page.EgressOnlyInternetGateways ?? []) {
        const tags = toTags(eigw.Tags);
        out.egressOnlyInternetGateways.push({
          id: eigw.EgressOnlyInternetGatewayId!,
          name: nameTag(tags),
          tags,
          vpcId: eigw.Attachments?.[0]?.VpcId,
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeNatGateways', async () => {
    for await (const page of paginateDescribeNatGateways({ client: ec2 }, {})) {
      for (const nat of page.NatGateways ?? []) {
        const tags = toTags(nat.Tags);
        out.natGateways.push({
          id: nat.NatGatewayId!,
          name: nameTag(tags),
          tags,
          vpcId: nat.VpcId ?? '',
          subnetId: nat.SubnetId ?? '',
          connectivityType: nat.ConnectivityType === 'private' ? 'private' : 'public',
          state: nat.State,
          addresses: (nat.NatGatewayAddresses ?? []).map((a) => ({
            publicIp: a.PublicIp,
            privateIp: a.PrivateIp,
            allocationId: a.AllocationId,
          })),
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeAddresses', async () => {
    const res = await ec2.send(new DescribeAddressesCommand({}));
    for (const a of res.Addresses ?? []) {
      const tags = toTags(a.Tags);
      out.elasticIps.push({
        id: a.AllocationId ?? a.PublicIp ?? '',
        name: nameTag(tags),
        tags,
        publicIp: a.PublicIp,
        privateIp: a.PrivateIpAddress,
        instanceId: a.InstanceId,
        networkInterfaceId: a.NetworkInterfaceId,
        associationId: a.AssociationId,
      });
    }
  });

  await guard(errors, 'ec2', 'DescribeNetworkAcls', async () => {
    for await (const page of paginateDescribeNetworkAcls({ client: ec2 }, {})) {
      for (const acl of page.NetworkAcls ?? []) {
        const tags = toTags(acl.Tags);
        out.networkAcls.push({
          id: acl.NetworkAclId!,
          name: nameTag(tags),
          tags,
          vpcId: acl.VpcId ?? '',
          isDefault: acl.IsDefault ?? false,
          subnetIds: (acl.Associations ?? []).map((a) => a.SubnetId).filter((s): s is string => !!s),
          entries: (acl.Entries ?? []).map((e) => ({
            ruleNumber: e.RuleNumber ?? 0,
            protocol: e.Protocol ?? '-1',
            ruleAction: e.RuleAction === 'deny' ? 'deny' : 'allow',
            egress: e.Egress ?? false,
            cidrBlock: e.CidrBlock,
            ipv6CidrBlock: e.Ipv6CidrBlock,
            portFrom: e.PortRange?.From,
            portTo: e.PortRange?.To,
          })),
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeSecurityGroups', async () => {
    for await (const page of paginateDescribeSecurityGroups({ client: ec2 }, {})) {
      for (const sg of page.SecurityGroups ?? []) {
        const tags = toTags(sg.Tags);
        out.securityGroups.push({
          id: sg.GroupId!,
          name: sg.GroupName ?? nameTag(tags),
          tags,
          vpcId: sg.VpcId,
          description: sg.Description,
          ingress: mapSgRules(sg.IpPermissions),
          egress: mapSgRules(sg.IpPermissionsEgress),
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeNetworkInterfaces', async () => {
    for await (const page of paginateDescribeNetworkInterfaces({ client: ec2 }, {})) {
      for (const eni of page.NetworkInterfaces ?? []) {
        const tags = toTags(eni.TagSet);
        out.networkInterfaces.push({
          id: eni.NetworkInterfaceId!,
          name: nameTag(tags),
          tags,
          vpcId: eni.VpcId,
          subnetId: eni.SubnetId,
          availabilityZone: eni.AvailabilityZone,
          description: eni.Description,
          interfaceType: eni.InterfaceType,
          privateIps: (eni.PrivateIpAddresses ?? [])
            .map((p) => p.PrivateIpAddress)
            .filter((p): p is string => !!p),
          publicIp: eni.Association?.PublicIp,
          securityGroupIds: (eni.Groups ?? []).map((g) => g.GroupId).filter((g): g is string => !!g),
          status: eni.Status,
          attachedTo: eni.Attachment?.InstanceId,
          requesterId: eni.RequesterId,
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeVpcEndpoints', async () => {
    for await (const page of paginateDescribeVpcEndpoints({ client: ec2 }, {})) {
      for (const ep of page.VpcEndpoints ?? []) {
        const tags = toTags(ep.Tags);
        out.vpcEndpoints.push({
          id: ep.VpcEndpointId!,
          name: nameTag(tags),
          tags,
          vpcId: ep.VpcId ?? '',
          serviceName: ep.ServiceName ?? '',
          endpointType: (ENDPOINT_TYPES.has(ep.VpcEndpointType ?? '')
            ? ep.VpcEndpointType
            : 'other') as VpcEndpoint['endpointType'],
          state: ep.State,
          subnetIds: ep.SubnetIds ?? [],
          routeTableIds: ep.RouteTableIds ?? [],
          networkInterfaceIds: ep.NetworkInterfaceIds ?? [],
          privateDnsEnabled: ep.PrivateDnsEnabled,
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeManagedPrefixLists', async () => {
    for await (const page of paginateDescribeManagedPrefixLists({ client: ec2 }, {})) {
      for (const pl of page.PrefixLists ?? []) {
        const tags = toTags(pl.Tags);
        const cidrs: string[] = [];
        // AWS-managed lists (e.g. every S3 CIDR) are huge and not ours — skip entries.
        if (pl.OwnerId === accountId && pl.PrefixListId) {
          await guard(errors, 'ec2', `GetManagedPrefixListEntries(${pl.PrefixListId})`, async () => {
            for await (const entryPage of paginateGetManagedPrefixListEntries(
              { client: ec2 },
              { PrefixListId: pl.PrefixListId! },
            )) {
              for (const e of entryPage.Entries ?? []) {
                if (e.Cidr) cidrs.push(e.Cidr);
              }
            }
          });
        }
        out.prefixLists.push({
          id: pl.PrefixListId!,
          arn: pl.PrefixListArn,
          name: pl.PrefixListName ?? nameTag(tags),
          tags,
          cidrs,
          ownerId: pl.OwnerId,
          maxEntries: pl.MaxEntries,
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeVpcPeeringConnections', async () => {
    for await (const page of paginateDescribeVpcPeeringConnections({ client: ec2 }, {})) {
      for (const pcx of page.VpcPeeringConnections ?? []) {
        const tags = toTags(pcx.Tags);
        out.peeringConnections.push({
          id: pcx.VpcPeeringConnectionId!,
          name: nameTag(tags),
          tags,
          requester: {
            vpcId: pcx.RequesterVpcInfo?.VpcId,
            accountId: pcx.RequesterVpcInfo?.OwnerId,
            region: pcx.RequesterVpcInfo?.Region,
            cidrBlocks: (pcx.RequesterVpcInfo?.CidrBlockSet ?? [])
              .map((c) => c.CidrBlock)
              .filter((c): c is string => !!c),
          },
          accepter: {
            vpcId: pcx.AccepterVpcInfo?.VpcId,
            accountId: pcx.AccepterVpcInfo?.OwnerId,
            region: pcx.AccepterVpcInfo?.Region,
            cidrBlocks: (pcx.AccepterVpcInfo?.CidrBlockSet ?? [])
              .map((c) => c.CidrBlock)
              .filter((c): c is string => !!c),
          },
          status: pcx.Status?.Code,
        });
      }
    }
  });

  await guard(errors, 'ec2', 'DescribeVpnGateways', async () => {
    const res = await ec2.send(new DescribeVpnGatewaysCommand({}));
    for (const vgw of res.VpnGateways ?? []) {
      const tags = toTags(vgw.Tags);
      out.vpnGateways.push({
        id: vgw.VpnGatewayId!,
        name: nameTag(tags),
        tags,
        vpcIds: (vgw.VpcAttachments ?? [])
          .filter((a) => a.State === 'attached')
          .map((a) => a.VpcId)
          .filter((v): v is string => !!v),
        amazonSideAsn: vgw.AmazonSideAsn,
        state: vgw.State,
      });
    }
  });

  await guard(errors, 'ec2', 'DescribeCustomerGateways', async () => {
    const res = await ec2.send(new DescribeCustomerGatewaysCommand({}));
    for (const cgw of res.CustomerGateways ?? []) {
      const tags = toTags(cgw.Tags);
      out.customerGateways.push({
        id: cgw.CustomerGatewayId!,
        name: nameTag(tags),
        tags,
        ipAddress: cgw.IpAddress,
        bgpAsn: cgw.BgpAsn,
        state: cgw.State,
      });
    }
  });

  await guard(errors, 'ec2', 'DescribeVpnConnections', async () => {
    const res = await ec2.send(new DescribeVpnConnectionsCommand({}));
    for (const vpn of res.VpnConnections ?? []) {
      const tags = toTags(vpn.Tags);
      out.vpnConnections.push({
        id: vpn.VpnConnectionId!,
        name: nameTag(tags),
        tags,
        vpnGatewayId: vpn.VpnGatewayId,
        transitGatewayId: vpn.TransitGatewayId,
        customerGatewayId: vpn.CustomerGatewayId,
        state: vpn.State,
        category: vpn.Category,
        tunnels: (vpn.VgwTelemetry ?? []).map((t) => ({
          outsideIp: t.OutsideIpAddress,
          status: t.Status,
          statusMessage: t.StatusMessage,
        })),
      });
    }
  });
}
