/**
 * The snapshot data model — the contract between the scanner (producer)
 * and the viewer (consumer). Scanner output is committed to git, so field
 * names and shapes should stay stable; bump SNAPSHOT_VERSION on breaking
 * changes.
 */

export const SNAPSHOT_VERSION = 1;

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export type Tags = Record<string, string>;

export interface BaseResource {
  /** AWS-native identifier (vpc-…, subnet-…, i-…, arn for ARN-only types). */
  id: string;
  arn?: string;
  /** Human name: the Name tag, or the service-native name where one exists. */
  name?: string;
  tags: Tags;
}

export interface ScanError {
  service: string;
  operation: string;
  message: string;
}

// ---------------------------------------------------------------------------
// VPC building blocks
// ---------------------------------------------------------------------------

export interface Vpc extends BaseResource {
  cidrBlocks: string[];
  ipv6CidrBlocks: string[];
  isDefault: boolean;
  state?: string;
}

export interface Subnet extends BaseResource {
  vpcId: string;
  cidrBlock?: string;
  ipv6CidrBlocks: string[];
  availabilityZone: string;
  availabilityZoneId?: string;
  availableIpAddressCount?: number;
  mapPublicIpOnLaunch: boolean;
  /** Route table that applies to this subnet (explicit association, else the VPC main table). */
  routeTableId?: string;
  /** True when the effective route table has a route to an internet gateway. */
  isPublic: boolean;
}

export type RouteTargetType =
  | 'local'
  | 'igw'
  | 'eigw'
  | 'nat'
  | 'tgw'
  | 'pcx'
  | 'vgw'
  | 'eni'
  | 'instance'
  | 'vpce'
  | 'carrier'
  | 'localGateway'
  | 'coreNetwork'
  | 'other';

export interface Route {
  destinationCidr?: string;
  destinationIpv6Cidr?: string;
  destinationPrefixListId?: string;
  targetType: RouteTargetType;
  targetId: string;
  state: 'active' | 'blackhole';
  origin?: string;
}

export interface RouteTable extends BaseResource {
  vpcId: string;
  isMain: boolean;
  /** Subnets explicitly associated with this table. */
  subnetAssociations: string[];
  /** Gateways (IGW/VGW) associated for edge routing. */
  gatewayAssociations: string[];
  routes: Route[];
}

export interface InternetGateway extends BaseResource {
  /** VPCs this IGW is attached to (0 or 1 in practice). */
  vpcIds: string[];
}

export interface EgressOnlyInternetGateway extends BaseResource {
  vpcId?: string;
}

export interface NatGateway extends BaseResource {
  vpcId: string;
  subnetId: string;
  connectivityType: 'public' | 'private';
  state?: string;
  addresses: Array<{ publicIp?: string; privateIp?: string; allocationId?: string }>;
}

export interface ElasticIp extends BaseResource {
  publicIp?: string;
  privateIp?: string;
  instanceId?: string;
  networkInterfaceId?: string;
  associationId?: string;
}

export interface NetworkAclEntry {
  ruleNumber: number;
  protocol: string;
  ruleAction: 'allow' | 'deny';
  egress: boolean;
  cidrBlock?: string;
  ipv6CidrBlock?: string;
  portFrom?: number;
  portTo?: number;
}

export interface NetworkAcl extends BaseResource {
  vpcId: string;
  isDefault: boolean;
  subnetIds: string[];
  entries: NetworkAclEntry[];
}

export interface SecurityGroupRule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidrs: string[];
  ipv6Cidrs: string[];
  prefixListIds: string[];
  /** References to other security groups (possibly in peer accounts). */
  securityGroupRefs: Array<{ groupId: string; accountId?: string; vpcId?: string }>;
  description?: string;
}

export interface SecurityGroup extends BaseResource {
  vpcId?: string;
  description?: string;
  ingress: SecurityGroupRule[];
  egress: SecurityGroupRule[];
}

export interface NetworkInterface extends BaseResource {
  vpcId?: string;
  subnetId?: string;
  availabilityZone?: string;
  description?: string;
  interfaceType?: string;
  privateIps: string[];
  publicIp?: string;
  securityGroupIds: string[];
  status?: string;
  attachedTo?: string;
  requesterId?: string;
}

export interface VpcEndpoint extends BaseResource {
  vpcId: string;
  serviceName: string;
  endpointType: 'Interface' | 'Gateway' | 'GatewayLoadBalancer' | 'Resource' | 'ServiceNetwork' | 'other';
  state?: string;
  subnetIds: string[];
  routeTableIds: string[];
  networkInterfaceIds: string[];
  privateDnsEnabled?: boolean;
}

export interface ManagedPrefixList extends BaseResource {
  cidrs: string[];
  ownerId?: string;
  maxEntries?: number;
}

// ---------------------------------------------------------------------------
// Cross-VPC / cross-account connectivity
// ---------------------------------------------------------------------------

export interface PeeringSide {
  vpcId?: string;
  accountId?: string;
  region?: string;
  cidrBlocks: string[];
}

export interface VpcPeeringConnection extends BaseResource {
  requester: PeeringSide;
  accepter: PeeringSide;
  status?: string;
}

export interface TransitGateway extends BaseResource {
  ownerId?: string;
  state?: string;
  description?: string;
  amazonSideAsn?: number;
  associationDefaultRouteTableId?: string;
  propagationDefaultRouteTableId?: string;
}

export type TgwAttachmentResourceType =
  | 'vpc'
  | 'vpn'
  | 'direct-connect-gateway'
  | 'peering'
  | 'connect'
  | 'tgw-peering'
  | 'other';

export interface TransitGatewayAttachment extends BaseResource {
  transitGatewayId: string;
  transitGatewayOwnerId?: string;
  resourceOwnerId?: string;
  resourceType: TgwAttachmentResourceType;
  resourceId?: string;
  state?: string;
  associationRouteTableId?: string;
  /** For VPC attachments: the subnets the attachment ENIs live in. */
  subnetIds: string[];
  /** For TGW peering attachments: the peer transit gateway details. */
  peer?: { transitGatewayId?: string; accountId?: string; region?: string };
}

export interface TransitGatewayRoute {
  destinationCidr?: string;
  prefixListId?: string;
  attachmentIds: string[];
  resourceIds: string[];
  resourceType?: TgwAttachmentResourceType;
  routeType: 'static' | 'propagated';
  state?: string;
}

export interface TransitGatewayRouteTable extends BaseResource {
  transitGatewayId: string;
  isDefaultAssociation: boolean;
  isDefaultPropagation: boolean;
  routes: TransitGatewayRoute[];
  associations: Array<{ attachmentId: string; resourceId?: string; resourceType?: string }>;
}

export interface VpnGateway extends BaseResource {
  vpcIds: string[];
  amazonSideAsn?: number;
  state?: string;
}

export interface CustomerGateway extends BaseResource {
  ipAddress?: string;
  bgpAsn?: string;
  state?: string;
}

export interface VpnConnection extends BaseResource {
  vpnGatewayId?: string;
  transitGatewayId?: string;
  customerGatewayId?: string;
  state?: string;
  category?: string;
  tunnels: Array<{ outsideIp?: string; status?: string; statusMessage?: string }>;
}

export interface DirectConnectGateway extends BaseResource {
  ownerAccount?: string;
  amazonSideAsn?: number;
  state?: string;
  /** VGWs/TGWs this DX gateway is associated with. */
  associations: Array<{
    associatedGatewayId?: string;
    associatedGatewayType?: 'virtualPrivateGateway' | 'transitGateway' | string;
    associatedGatewayOwnerAccount?: string;
    associatedGatewayRegion?: string;
    state?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Load balancing
// ---------------------------------------------------------------------------

export interface LoadBalancerListener {
  port?: number;
  protocol?: string;
  targetGroupArns: string[];
}

export interface LoadBalancer extends BaseResource {
  lbType: 'application' | 'network' | 'gateway' | 'classic';
  scheme?: string;
  vpcId?: string;
  subnetIds: string[];
  availabilityZones: string[];
  securityGroupIds: string[];
  dnsName?: string;
  state?: string;
  listeners: LoadBalancerListener[];
}

export interface TargetGroup extends BaseResource {
  protocol?: string;
  port?: number;
  vpcId?: string;
  targetType?: string;
  loadBalancerArns: string[];
  targets: Array<{ targetId: string; port?: number; availabilityZone?: string; health?: string }>;
}

// ---------------------------------------------------------------------------
// Placed workloads (resources that live inside subnets / VPCs)
// ---------------------------------------------------------------------------

export interface Ec2Instance extends BaseResource {
  instanceType?: string;
  state?: string;
  vpcId?: string;
  subnetId?: string;
  availabilityZone?: string;
  privateIp?: string;
  publicIp?: string;
  securityGroupIds: string[];
  imageId?: string;
  launchTime?: string;
  platform?: string;
}

export interface AutoScalingGroup extends BaseResource {
  subnetIds: string[];
  instanceIds: string[];
  minSize?: number;
  maxSize?: number;
  desiredCapacity?: number;
  loadBalancerTargetGroupArns: string[];
}

export interface LambdaFunction extends BaseResource {
  runtime?: string;
  description?: string;
  vpcConfig?: { vpcId?: string; subnetIds: string[]; securityGroupIds: string[] };
}

export interface RdsInstance extends BaseResource {
  engine?: string;
  engineVersion?: string;
  instanceClass?: string;
  clusterId?: string;
  vpcId?: string;
  subnetGroupName?: string;
  subnetIds: string[];
  securityGroupIds: string[];
  endpoint?: { address?: string; port?: number };
  multiAz?: boolean;
  publiclyAccessible?: boolean;
  availabilityZone?: string;
}

export interface RdsCluster extends BaseResource {
  engine?: string;
  engineVersion?: string;
  memberInstanceIds: string[];
  vpcId?: string;
  subnetGroupName?: string;
  subnetIds: string[];
  securityGroupIds: string[];
  endpoint?: string;
  readerEndpoint?: string;
  multiAz?: boolean;
}

export interface EcsService extends BaseResource {
  clusterArn: string;
  clusterName?: string;
  launchType?: string;
  desiredCount?: number;
  runningCount?: number;
  subnetIds: string[];
  securityGroupIds: string[];
  assignPublicIp?: boolean;
}

export interface EksCluster extends BaseResource {
  version?: string;
  endpoint?: string;
  vpcId?: string;
  subnetIds: string[];
  securityGroupIds: string[];
  endpointPublicAccess?: boolean;
  endpointPrivateAccess?: boolean;
}

export interface ElastiCacheCluster extends BaseResource {
  engine?: string;
  nodeType?: string;
  numNodes?: number;
  vpcId?: string;
  subnetGroupName?: string;
  subnetIds: string[];
  securityGroupIds: string[];
}

// ---------------------------------------------------------------------------
// Global (non-regional) resources
// ---------------------------------------------------------------------------

export interface Route53HostedZone extends BaseResource {
  zoneName: string;
  privateZone: boolean;
  recordCount?: number;
  /** For private zones: the VPCs associated with the zone. */
  vpcAssociations: Array<{ vpcId: string; region: string }>;
}

export interface S3Bucket extends BaseResource {
  region?: string;
  creationDate?: string;
}

// ---------------------------------------------------------------------------
// Generic "everything" inventory
// ---------------------------------------------------------------------------

/**
 * A resource discovered by the generic sweep (Resource Groups Tagging API).
 * These are not placed on the network diagram (unless a detailed collector
 * also captured them) but are searchable and listed per account/region.
 */
export interface GenericResource {
  arn: string;
  /** Service extracted from the ARN, e.g. "s3", "dynamodb". */
  service: string;
  /** Resource type extracted from the ARN, e.g. "table", "function". */
  resourceType: string;
  name?: string;
  tags: Tags;
}

// ---------------------------------------------------------------------------
// Snapshot containers
// ---------------------------------------------------------------------------

export interface RegionSnapshot {
  region: string;
  /** True when the region has no resources worth showing (see scanner heuristics). */
  empty: boolean;
  errors: ScanError[];

  vpcs: Vpc[];
  subnets: Subnet[];
  routeTables: RouteTable[];
  internetGateways: InternetGateway[];
  egressOnlyInternetGateways: EgressOnlyInternetGateway[];
  natGateways: NatGateway[];
  elasticIps: ElasticIp[];
  networkAcls: NetworkAcl[];
  securityGroups: SecurityGroup[];
  networkInterfaces: NetworkInterface[];
  vpcEndpoints: VpcEndpoint[];
  prefixLists: ManagedPrefixList[];

  peeringConnections: VpcPeeringConnection[];
  transitGateways: TransitGateway[];
  transitGatewayAttachments: TransitGatewayAttachment[];
  transitGatewayRouteTables: TransitGatewayRouteTable[];
  vpnGateways: VpnGateway[];
  customerGateways: CustomerGateway[];
  vpnConnections: VpnConnection[];

  loadBalancers: LoadBalancer[];
  targetGroups: TargetGroup[];

  instances: Ec2Instance[];
  autoScalingGroups: AutoScalingGroup[];
  lambdaFunctions: LambdaFunction[];
  rdsInstances: RdsInstance[];
  rdsClusters: RdsCluster[];
  ecsServices: EcsService[];
  eksClusters: EksCluster[];
  elastiCacheClusters: ElastiCacheCluster[];

  generic: GenericResource[];
}

export interface AccountSnapshot {
  accountId: string;
  /** IAM account alias if one exists, else a config-provided display name. */
  alias?: string;
  /** The AWS config profile used to scan this account. */
  profile: string;
  scannedAt: string;
  scannerVersion: string;
  regions: RegionSnapshot[];
  /** Regions that were enabled but skipped/empty (kept out of `regions`). */
  emptyRegions: string[];
  global: {
    hostedZones: Route53HostedZone[];
    /** DX gateways are global entities; collected once per account. */
    directConnectGateways: DirectConnectGateway[];
    /** Buckets are global-namespace; ListBuckets catches untagged ones the tagging sweep misses. */
    s3Buckets: S3Bucket[];
    errors: ScanError[];
  };
}

/** The bundle the viewer consumes: all scanned accounts merged. */
export interface Snapshot {
  version: number;
  generatedAt: string;
  accounts: AccountSnapshot[];
}

/** Create an empty region snapshot (scanner convenience). */
export function emptyRegionSnapshot(region: string): RegionSnapshot {
  return {
    region,
    empty: false,
    errors: [],
    vpcs: [],
    subnets: [],
    routeTables: [],
    internetGateways: [],
    egressOnlyInternetGateways: [],
    natGateways: [],
    elasticIps: [],
    networkAcls: [],
    securityGroups: [],
    networkInterfaces: [],
    vpcEndpoints: [],
    prefixLists: [],
    peeringConnections: [],
    transitGateways: [],
    transitGatewayAttachments: [],
    transitGatewayRouteTables: [],
    vpnGateways: [],
    customerGateways: [],
    vpnConnections: [],
    loadBalancers: [],
    targetGroups: [],
    instances: [],
    autoScalingGroups: [],
    lambdaFunctions: [],
    rdsInstances: [],
    rdsClusters: [],
    ecsServices: [],
    eksClusters: [],
    elastiCacheClusters: [],
    generic: [],
  };
}
