import type { FC, SVGProps } from 'react';

// Official AWS Architecture Icons, deep-imported from the aws-icons package
// (only these files end up in the bundle). Resource icons are 48x48,
// group icons 32x32 — both scale cleanly.
import Ec2Instance from 'aws-icons/icons/resource/AmazonEC2Instance.svg?react';
import AutoScaling from 'aws-icons/icons/resource/AmazonEC2AutoScaling.svg?react';
import ElasticIp from 'aws-icons/icons/resource/AmazonEC2ElasticIPAddress.svg?react';
import LambdaFn from 'aws-icons/icons/resource/AWSLambdaLambdaFunction.svg?react';
import RdsInstance from 'aws-icons/icons/resource/AmazonAuroraAmazonRDSInstance.svg?react';
import AuroraInstance from 'aws-icons/icons/resource/AmazonAuroraInstance.svg?react';
import ElastiCacheNode from 'aws-icons/icons/resource/AmazonElastiCacheCacheNode.svg?react';
import EcsService from 'aws-icons/icons/resource/AmazonElasticContainerServiceService.svg?react';
import S3Bucket from 'aws-icons/icons/resource/AmazonSimpleStorageServiceBucket.svg?react';
import HostedZone from 'aws-icons/icons/resource/AmazonRoute53HostedZone.svg?react';
import RouteTable from 'aws-icons/icons/resource/AmazonRoute53RouteTable.svg?react';
import InternetGw from 'aws-icons/icons/resource/AmazonVPCInternetGateway.svg?react';
import NatGw from 'aws-icons/icons/resource/AmazonVPCNATGateway.svg?react';
import VpcEndpoints from 'aws-icons/icons/resource/AmazonVPCEndpoints.svg?react';
import Eni from 'aws-icons/icons/resource/AmazonVPCElasticNetworkInterface.svg?react';
import Nacl from 'aws-icons/icons/resource/AmazonVPCNetworkAccessControlList.svg?react';
import Peering from 'aws-icons/icons/resource/AmazonVPCPeeringConnection.svg?react';
import VpnGw from 'aws-icons/icons/resource/AmazonVPCVPNGateway.svg?react';
import VpnConn from 'aws-icons/icons/resource/AmazonVPCVPNConnection.svg?react';
import CustomerGw from 'aws-icons/icons/resource/AmazonVPCCustomerGateway.svg?react';
import TgwAttachment from 'aws-icons/icons/resource/AWSTransitGatewayAttachment.svg?react';
import DxGateway from 'aws-icons/icons/resource/AWSDirectConnectGateway.svg?react';
import Alb from 'aws-icons/icons/resource/ElasticLoadBalancingApplicationLoadBalancer.svg?react';
import Nlb from 'aws-icons/icons/resource/ElasticLoadBalancingNetworkLoadBalancer.svg?react';
import Clb from 'aws-icons/icons/resource/ElasticLoadBalancingClassicLoadBalancer.svg?react';
import Gwlb from 'aws-icons/icons/resource/ElasticLoadBalancingGatewayLoadBalancer.svg?react';
import TransitGw from 'aws-icons/icons/architecture-service/AWSTransitGateway.svg?react';
import Eks from 'aws-icons/icons/architecture-service/AmazonElasticKubernetesService.svg?react';
import DirectConnect from 'aws-icons/icons/architecture-service/AWSDirectConnect.svg?react';
import VpcService from 'aws-icons/icons/architecture-service/AmazonVirtualPrivateCloud.svg?react';
// identity & security
import IamService from 'aws-icons/icons/architecture-service/AWSIdentityandAccessManagement.svg?react';
import IamRole from 'aws-icons/icons/resource/AWSIdentityAccessManagementRole.svg?react';
import IamPermissions from 'aws-icons/icons/resource/AWSIdentityAccessManagementPermissions.svg?react';
import Kms from 'aws-icons/icons/architecture-service/AWSKeyManagementService.svg?react';
import Acm from 'aws-icons/icons/architecture-service/AWSCertificateManager.svg?react';
import SecretsManager from 'aws-icons/icons/architecture-service/AWSSecretsManager.svg?react';
// additional network services
import Resolver from 'aws-icons/icons/resource/AmazonRoute53Resolver.svg?react';
import ClientVpn from 'aws-icons/icons/architecture-service/AWSClientVPN.svg?react';
import NetworkFirewall from 'aws-icons/icons/architecture-service/AWSNetworkFirewall.svg?react';
import ApiGw from 'aws-icons/icons/architecture-service/AmazonAPIGateway.svg?react';
import CloudFront from 'aws-icons/icons/architecture-service/AmazonCloudFront.svg?react';
// security groups, internet, on-prem DNS targets
import Shield from 'aws-icons/icons/resource/Shield.svg?react';
import Internet from 'aws-icons/icons/resource/Internetalt1.svg?react';
import Globe from 'aws-icons/icons/resource/Globe.svg?react';
// Group icons (container headers)
import VpcGroup from 'aws-icons/icons/architecture-group/VirtualprivatecloudVPC.svg?react';
import PublicSubnet from 'aws-icons/icons/architecture-group/Publicsubnet.svg?react';
import PrivateSubnet from 'aws-icons/icons/architecture-group/Privatesubnet.svg?react';
import AwsAccount from 'aws-icons/icons/architecture-group/AWSAccount.svg?react';
import RegionGroup from 'aws-icons/icons/architecture-group/Region.svg?react';
import DataCenter from 'aws-icons/icons/architecture-group/Corporatedatacenter.svg?react';

export type IconComponent = FC<SVGProps<SVGSVGElement>>;

/** Icon per resource/container kind used in graph nodes and panels. */
export const ICONS: Record<string, IconComponent> = {
  instance: Ec2Instance,
  asg: AutoScaling,
  eip: ElasticIp,
  lambda: LambdaFn,
  rds: RdsInstance,
  'rds-cluster': AuroraInstance,
  elasticache: ElastiCacheNode,
  ecs: EcsService,
  eks: Eks,
  s3: S3Bucket,
  zone: HostedZone,
  'route-table': RouteTable,
  igw: InternetGw,
  eigw: InternetGw,
  nat: NatGw,
  vpce: VpcEndpoints,
  eni: Eni,
  nacl: Nacl,
  pcx: Peering,
  vgw: VpnGw,
  vpn: VpnConn,
  cgw: CustomerGw,
  tgw: TransitGw,
  'tgw-attachment': TgwAttachment,
  'tgw-rt': RouteTable,
  dxgw: DxGateway,
  dx: DirectConnect,
  vpc: VpcService,
  'lb-application': Alb,
  'lb-network': Nlb,
  'lb-classic': Clb,
  'lb-gateway': Gwlb,
  // identity & security
  'iam-role': IamRole,
  'iam-user': IamService,
  'iam-group': IamService,
  'iam-policy': IamPermissions,
  'iam-instance-profile': IamRole,
  kms: Kms,
  acm: Acm,
  secret: SecretsManager,
  // additional network services
  'resolver-endpoint': Resolver,
  'resolver-rule': Resolver,
  'client-vpn': ClientVpn,
  'network-firewall': NetworkFirewall,
  apigw: ApiGw,
  cloudfront: CloudFront,
  // security groups, internet, DNS targets
  sg: Shield,
  internet: Internet,
  'dns-target': HostedZone,
  // container headers
  'group-vpc': VpcGroup,
  'group-subnet-public': PublicSubnet,
  'group-subnet-private': PrivateSubnet,
  'group-account': AwsAccount,
  'group-region': RegionGroup,
  'group-external': DataCenter,
  'group-security': IamService,
  'group-edge': Globe,
};

export function iconFor(kind: string): IconComponent | undefined {
  return ICONS[kind];
}
