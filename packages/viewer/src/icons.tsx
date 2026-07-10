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
import IdentityCenter from 'aws-icons/icons/architecture-service/AWSIAMIdentityCenter.svg?react';
import IamSts from 'aws-icons/icons/resource/AWSIdentityAccessManagementAWSSTS.svg?react';
import Kms from 'aws-icons/icons/architecture-service/AWSKeyManagementService.svg?react';
import Acm from 'aws-icons/icons/architecture-service/AWSCertificateManager.svg?react';
import SecretsManager from 'aws-icons/icons/architecture-service/AWSSecretsManager.svg?react';
// additional network services
import Resolver from 'aws-icons/icons/resource/AmazonRoute53Resolver.svg?react';
import ClientVpn from 'aws-icons/icons/architecture-service/AWSClientVPN.svg?react';
import NetworkFirewall from 'aws-icons/icons/architecture-service/AWSNetworkFirewall.svg?react';
import NetworkFirewallEndpoints from 'aws-icons/icons/resource/AWSNetworkFirewallEndpoints.svg?react';
import DnsFirewall from 'aws-icons/icons/resource/AmazonRoute53ResolverDNSFirewall.svg?react';
import ApiGw from 'aws-icons/icons/architecture-service/AmazonAPIGateway.svg?react';
import CloudFront from 'aws-icons/icons/architecture-service/AmazonCloudFront.svg?react';
import Waf from 'aws-icons/icons/architecture-service/AWSWAF.svg?react';
import GlobalAccelerator from 'aws-icons/icons/architecture-service/AWSGlobalAccelerator.svg?react';
import CloudWan from 'aws-icons/icons/architecture-service/AWSCloudWAN.svg?react';
// AWS Organizations (panel-only)
import Organizations from 'aws-icons/icons/architecture-service/AWSOrganizations.svg?react';
// AWS RAM cross-account resource shares (edge/panel-only)
import ResourceAccessManager from 'aws-icons/icons/architecture-service/AWSResourceAccessManager.svg?react';
import OrganizationsAccount from 'aws-icons/icons/resource/AWSOrganizationsAccount.svg?react';
import OrganizationsOu from 'aws-icons/icons/resource/AWSOrganizationsOrganizationalUnit.svg?react';
import VpcLattice from 'aws-icons/icons/architecture-service/AmazonVPCLattice.svg?react';
import FlowLogs from 'aws-icons/icons/resource/AmazonVPCFlowLogs.svg?react';
import CloudWatchLogs from 'aws-icons/icons/resource/AmazonCloudWatchLogs.svg?react';
// VPC-attached workloads
import Efs from 'aws-icons/icons/architecture-service/AmazonEFS.svg?react';
import Fsx from 'aws-icons/icons/architecture-service/AmazonFSx.svg?react';
import OpenSearch from 'aws-icons/icons/architecture-service/AmazonOpenSearchService.svg?react';
import Msk from 'aws-icons/icons/architecture-service/AmazonManagedStreamingforApacheKafka.svg?react';
import Redshift from 'aws-icons/icons/architecture-service/AmazonRedshift.svg?react';
import AmazonMq from 'aws-icons/icons/architecture-service/AmazonMQ.svg?react';
import RdsProxy from 'aws-icons/icons/resource/AmazonRDSProxyInstance.svg?react';
import Glue from 'aws-icons/icons/architecture-service/AWSGlue.svg?react';
import Dms from 'aws-icons/icons/architecture-service/AWSDatabaseMigrationService.svg?react';
import DataSyncAgent from 'aws-icons/icons/resource/AWSDatasyncAgent.svg?react';
import Firehose from 'aws-icons/icons/architecture-service/AmazonDataFirehose.svg?react';
import Emr from 'aws-icons/icons/architecture-service/AmazonEMR.svg?react';
import Batch from 'aws-icons/icons/architecture-service/AWSBatch.svg?react';
import Neptune from 'aws-icons/icons/architecture-service/AmazonNeptune.svg?react';
import DocumentDb from 'aws-icons/icons/architecture-service/AmazonDocumentDB.svg?react';
import MemoryDb from 'aws-icons/icons/architecture-service/AmazonMemoryDB.svg?react';
import TransferFamily from 'aws-icons/icons/architecture-service/AWSTransferFamily.svg?react';
import Beanstalk from 'aws-icons/icons/architecture-service/AWSElasticBeanstalk.svg?react';
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
import AwsLogo from 'aws-icons/icons/architecture-group/AWSCloudlogo.svg?react';

export type IconComponent = FC<SVGProps<SVGSVGElement>>;

/** The AWS "smile" logo tile — used for open-in-console links. */
export { AwsLogo };

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
  // IAM Identity Center (SSO) + federation providers
  'sso-instance': IdentityCenter,
  'sso-permission-set': IamPermissions,
  'sso-application': IdentityCenter,
  'saml-provider': IamSts,
  'oidc-provider': IamSts,
  kms: Kms,
  acm: Acm,
  secret: SecretsManager,
  // additional network services
  'resolver-endpoint': Resolver,
  'resolver-rule': Resolver,
  'resolver-query-log-config': Resolver,
  'dns-firewall-rule-group': DnsFirewall,
  'client-vpn': ClientVpn,
  'network-firewall': NetworkFirewall,
  'network-firewall-policy': NetworkFirewall,
  'network-firewall-rule-group': NetworkFirewall,
  'network-firewall-tls-config': NetworkFirewall,
  'network-firewall-endpoint': NetworkFirewallEndpoints,
  apigw: ApiGw,
  'apigw-vpc-link': ApiGw,
  'apigw-domain': Globe,
  cloudfront: CloudFront,
  'cloudfront-vpc-origin': CloudFront,
  'waf-web-acl': Waf,
  'waf-ip-set': Waf,
  'waf-rule-group': Waf,
  'global-accelerator': GlobalAccelerator,
  'core-network': CloudWan,
  // AWS Organizations (panel-only kinds; never drawn on the graph)
  org: Organizations,
  'org-ou': OrganizationsOu,
  'org-account': OrganizationsAccount,
  'org-policy': Organizations,
  // AWS RAM resource shares (drawn as cross-account edges; icon for the panel)
  'ram-share': ResourceAccessManager,
  'lattice-service-network': VpcLattice,
  'lattice-service': VpcLattice,
  'flow-log': FlowLogs,
  'log-group': CloudWatchLogs,
  'vpce-service': VpcEndpoints,
  'instance-connect-endpoint': Eni,
  'dhcp-options': RouteTable,
  'dx-connection': DirectConnect,
  'dx-lag': DirectConnect,
  'dx-vif': DirectConnect,
  'tgw-connect-peer': TgwAttachment,
  // VPC-attached workloads
  efs: Efs,
  fsx: Fsx,
  opensearch: OpenSearch,
  msk: Msk,
  redshift: Redshift,
  'redshift-serverless-workgroup': Redshift,
  'redshift-serverless-namespace': Redshift,
  mq: AmazonMq,
  'rds-proxy': RdsProxy,
  'elasticache-serverless': ElastiCacheNode,
  'elasticache-replication-group': ElastiCacheNode,
  'glue-connection': Glue,
  'glue-dev-endpoint': Glue,
  'dms-instance': Dms,
  'datasync-agent': DataSyncAgent,
  firehose: Firehose,
  'emr-cluster': Emr,
  'batch-compute-environment': Batch,
  'neptune-cluster': Neptune,
  'docdb-cluster': DocumentDb,
  'memorydb-cluster': MemoryDb,
  'transfer-server': TransferFamily,
  'beanstalk-environment': Beanstalk,
  // security groups, internet, DNS targets
  sg: Shield,
  internet: Internet,
  'dns-target': HostedZone,
  /** Focus view: trusted accounts rendered as flat nodes. */
  account: AwsAccount,
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
