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
  dhcpOptionsId?: string;
  enableDnsSupport?: boolean;
  enableDnsHostnames?: boolean;
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
  /** The endpoint policy JSON (gateway endpoints: controls S3/DynamoDB access). */
  policyDocument?: string;
}

/** PrivateLink provider side: an endpoint service THIS account exposes. */
export interface VpcEndpointService extends BaseResource {
  serviceName?: string;
  serviceType?: string;
  availabilityZones: string[];
  acceptanceRequired?: boolean;
  managesVpcEndpoints?: boolean;
  networkLoadBalancerArns: string[];
  gatewayLoadBalancerArns: string[];
  supportedIpAddressTypes: string[];
  privateDnsName?: string;
  /** Principals (account/role ARNs or '*') allowed to connect. */
  allowedPrincipals: string[];
  /** Consumer endpoints connected to this service (possibly other accounts). */
  connections: Array<{ vpcEndpointId?: string; ownerAccountId?: string; state?: string }>;
}

export interface FlowLog extends BaseResource {
  /** What is being logged: vpc-…, subnet-…, eni-…, or tgw-…. */
  resourceId?: string;
  trafficType?: string;
  /** cloud-watch-logs | s3 | kinesis-data-firehose. */
  logDestinationType?: string;
  /** Destination ARN (bucket/log group/delivery stream). */
  logDestination?: string;
  logGroupName?: string;
  status?: string;
  maxAggregationInterval?: number;
}

export interface DhcpOptions extends BaseResource {
  /** Raw configuration: key (domain-name-servers, ntp-servers, …) -> values. */
  options: Record<string, string[]>;
  /** VPCs using this option set (derived from Vpc.dhcpOptionsId). */
  vpcIds: string[];
}

/** EC2 Instance Connect Endpoint (SSH/RDP into private instances without a bastion). */
export interface InstanceConnectEndpoint extends BaseResource {
  vpcId?: string;
  subnetId?: string;
  state?: string;
  securityGroupIds: string[];
  preserveClientIp?: boolean;
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
  /** Attachments propagating routes into this table (explains propagated routes). */
  propagations?: Array<{ attachmentId: string; resourceId?: string; resourceType?: string; state?: string }>;
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
  /** Destination CIDRs of static routes over this connection. */
  staticRoutes?: string[];
  staticRoutesOnly?: boolean;
  localIpv4NetworkCidr?: string;
  remoteIpv4NetworkCidr?: string;
}

/** GRE/BGP peer on a Transit Gateway Connect attachment. */
export interface TransitGatewayConnectPeer extends BaseResource {
  attachmentId?: string;
  state?: string;
  insideCidrBlocks: string[];
  peerAddress?: string;
  transitGatewayAddress?: string;
  bgpAsn?: number;
}

// ---------------------------------------------------------------------------
// Direct Connect (regional pieces: physical connections, LAGs, VIFs)
// ---------------------------------------------------------------------------

export interface DxConnection extends BaseResource {
  location?: string;
  bandwidth?: string;
  state?: string;
  vlan?: number;
  partnerName?: string;
  lagId?: string;
  ownerAccount?: string;
}

export interface DxLag extends BaseResource {
  location?: string;
  connectionsBandwidth?: string;
  numberOfConnections?: number;
  connectionIds: string[];
  state?: string;
  ownerAccount?: string;
}

export interface DxVirtualInterface extends BaseResource {
  /** private | public | transit. */
  vifType?: string;
  state?: string;
  vlan?: number;
  bgpAsn?: number;
  amazonSideAsn?: number;
  connectionId?: string;
  directConnectGatewayId?: string;
  virtualGatewayId?: string;
  ownerAccount?: string;
  amazonAddress?: string;
  customerAddress?: string;
  routeFilterPrefixes: string[];
  bgpPeers: Array<{ asn?: number; addressFamily?: string; state?: string; status?: string }>;
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

export interface ListenerRule {
  /** Rule priority ("default" for the listener default action). */
  priority?: string;
  /** Compact conditions, e.g. "host=api.example.com", "path=/v1/*". */
  conditions: string[];
  /** forward | redirect | fixed-response | authenticate-oidc | authenticate-cognito. */
  actionType?: string;
  targetGroupArns: string[];
  /** For redirect actions: compact target, e.g. "https://example.com:443/#{path}". */
  redirect?: string;
  /** For fixed-response actions: the status code. */
  fixedResponseCode?: string;
}

export interface LoadBalancerListener {
  port?: number;
  protocol?: string;
  targetGroupArns: string[];
  /** SNI certificates (default certificate first). */
  certificateArns?: string[];
  /** Non-default routing rules (host/path/header routing). */
  rules?: ListenerRule[];
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
  /** Classic ELBs only: registered instance ids. */
  instanceIds?: string[];
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
  /** IAM instance profile attached to the instance (links to the role it assumes). */
  instanceProfileArn?: string;
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
  /** Execution role the function assumes. */
  roleArn?: string;
  vpcConfig?: { vpcId?: string; subnetIds: string[]; securityGroupIds: string[] };
  /** Function URL, if configured (authType NONE = publicly invokable). */
  functionUrl?: { url?: string; authType?: string };
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
// Cognito (regional): user pools + federated identity pools
// ---------------------------------------------------------------------------

export interface CognitoUserPool extends BaseResource {
  status?: string;
  /** OFF | ON | OPTIONAL. */
  mfaConfiguration?: string;
  passwordMinimumLength?: number;
  /** From UserPoolAddOns. */
  advancedSecurityMode?: string;
  deletionProtection?: string;
  estimatedNumberOfUsers?: number;
  domain?: string;
  /** Provider names from ListIdentityProviders. */
  identityProviders: string[];
  appClients: Array<{
    id: string;
    name?: string;
    allowedOAuthFlows: string[];
    allowedOAuthScopes: string[];
    callbackUrls: string[];
    supportedIdentityProviders: string[];
    explicitAuthFlows: string[];
    generateSecret?: boolean;
  }>;
}

export interface CognitoIdentityPool extends BaseResource {
  allowUnauthenticatedIdentities?: boolean;
  allowClassicFlow?: boolean;
  /** CognitoIdentityProviders[].ClientId (the user-pool app clients trusted). */
  cognitoUserPoolProviders: string[];
  samlProviderArns: string[];
  openIdConnectProviderArns: string[];
  /** From GetIdentityPoolRoles. */
  authenticatedRoleArn?: string;
  unauthenticatedRoleArn?: string;
}

// ---------------------------------------------------------------------------
// ECR (regional): container registries + repositories
// ---------------------------------------------------------------------------

export interface EcrRepository extends BaseResource {
  repositoryUri?: string;
  /** MUTABLE or IMMUTABLE. */
  imageTagMutability?: string;
  /** From imageScanningConfiguration. */
  scanOnPush?: boolean;
  /** AES256 or KMS. */
  encryptionType?: string;
  kmsKey?: string;
  /** Resource policy JSON (cross-account pull/push) — undefined if none. */
  repositoryPolicy?: string;
  /** Lifecycle policy JSON — undefined if none. */
  lifecyclePolicy?: string;
}

/** Registry-level ECR config — one per region-per-account; id = the account/registry id. */
export interface EcrRegistry extends BaseResource {
  replicationRules: Array<{
    destinations: Array<{ region?: string; registryId?: string }>;
    repositoryFilters: string[];
  }>;
  /** Registry policy JSON — undefined if none. */
  registryPolicy?: string;
  pullThroughCacheRules: Array<{ ecrRepositoryPrefix?: string; upstreamRegistryUrl?: string }>;
  /** Scan type + rule count summary, or undefined. */
  scanningConfiguration?: string;
}

// ---------------------------------------------------------------------------
// Messaging (regional): SNS topics + SQS queues
// ---------------------------------------------------------------------------

export interface SnsTopic extends BaseResource {
  displayName?: string;
  fifoTopic?: boolean;
  /** SSE key — undefined means no server-side encryption. */
  kmsMasterKeyId?: string;
  /** Resource policy JSON (cross-account publish/subscribe) — undefined if none. */
  policy?: string;
  subscriptionsConfirmed?: number;
  subscriptions: Array<{
    arn?: string;
    protocol?: string;
    endpoint?: string;
    rawMessageDelivery?: boolean;
  }>;
}

export interface SqsQueue extends BaseResource {
  fifoQueue?: boolean;
  kmsMasterKeyId?: string;
  sqsManagedSseEnabled?: boolean;
  /** Resource policy JSON (cross-account send/receive) — undefined if none. */
  policy?: string;
  /** From RedrivePolicy: the dead-letter queue this queue drains into. */
  deadLetterTargetArn?: string;
  /** From RedrivePolicy. */
  maxReceiveCount?: number;
  visibilityTimeout?: number;
}

// ---------------------------------------------------------------------------
// EventBridge (regional): buses/rules/targets, Pipes, Scheduler schedules
// ---------------------------------------------------------------------------

export interface EventBus extends BaseResource {
  /** Resource policy JSON (cross-account event delivery) — undefined if none. */
  policy?: string;
  rules: Array<{
    name: string;
    state?: string;
    scheduleExpression?: string;
    /** True when the rule matches on an event pattern (pattern body not stored). */
    eventPatternPresent?: boolean;
    roleArn?: string;
    /** Target ARNs = cross-account/cross-region reach. */
    targets: Array<{ id?: string; arn?: string; roleArn?: string }>;
  }>;
}

export interface EventBridgePipe extends BaseResource {
  state?: string;
  roleArn?: string;
  /** Source/enrichment/target ARNs — the event flow this pipe stitches together. */
  source?: string;
  enrichment?: string;
  target?: string;
  /** From SourceParameters.SelfManagedKafkaParameters.Vpc (the one VPC-attached case). */
  vpcSubnetIds: string[];
  vpcSecurityGroups: string[];
}

export interface EventBridgeSchedule extends BaseResource {
  groupName?: string;
  state?: string;
  scheduleExpression?: string;
  kmsKeyArn?: string;
  /** Target ARN + role — cross-account reach. */
  targetArn?: string;
  targetRoleArn?: string;
}

// ---------------------------------------------------------------------------
// Step Functions (regional): state machines
// ---------------------------------------------------------------------------

export interface SfnStateMachine extends BaseResource {
  /** STANDARD | EXPRESS. */
  type?: string;
  status?: string;
  roleArn?: string;
  /** From loggingConfiguration.level. */
  loggingLevel?: string;
  /** From tracingConfiguration.enabled. */
  tracingEnabled?: boolean;
  /** From encryptionConfiguration.kmsKeyId. */
  kmsKeyId?: string;
  /** Task-state Resource ARNs parsed from the ASL definition (downstream services this SM calls). */
  integrationResourceArns: string[];
}

// ---------------------------------------------------------------------------
// Glue (regional): connections, dev endpoints, jobs, crawlers, catalog databases
// ---------------------------------------------------------------------------

/** Glue connection — VPC-ATTACHED via PhysicalConnectionRequirements. */
export interface GlueConnection extends BaseResource {
  /** JDBC | NETWORK | KAFKA | MONGODB | … */
  connectionType?: string;
  /** PhysicalConnectionRequirements.SubnetId. */
  subnetId?: string;
  /** PhysicalConnectionRequirements.SecurityGroupIdList. */
  securityGroupIds: string[];
  availabilityZone?: string;
}

/** Glue dev endpoint — VPC-ATTACHED (vpc/subnet/security groups). */
export interface GlueDevEndpoint extends BaseResource {
  status?: string;
  vpcId?: string;
  subnetId?: string;
  securityGroupIds: string[];
}

export interface GlueJob extends BaseResource {
  glueVersion?: string;
  workerType?: string;
  /** Connections.Connections — names of Glue connections the job uses. */
  connections: string[];
}

export interface GlueCrawler extends BaseResource {
  state?: string;
  databaseName?: string;
}

export interface GlueDatabase extends BaseResource {
  description?: string;
  locationUri?: string;
}

// ---------------------------------------------------------------------------
// DMS (regional): replication instances, endpoints, replication tasks
// ---------------------------------------------------------------------------

/** DMS replication instance — VPC-ATTACHED (subnet group + security groups). */
export interface DmsReplicationInstance extends BaseResource {
  replicationInstanceClass?: string;
  engineVersion?: string;
  status?: string;
  /** ReplicationSubnetGroup.VpcId. */
  vpcId?: string;
  /** ReplicationSubnetGroup.ReplicationSubnetGroupIdentifier. */
  subnetGroupId?: string;
  /** ReplicationSubnetGroup.Subnets[].SubnetIdentifier. */
  subnetIds: string[];
  /** VpcSecurityGroups[].VpcSecurityGroupId. */
  securityGroupIds: string[];
  publiclyAccessible?: boolean;
  multiAz?: boolean;
  kmsKeyId?: string;
  privateIps: string[];
  publicIps: string[];
}

export interface DmsEndpoint extends BaseResource {
  /** SOURCE | TARGET. */
  endpointType?: string;
  engineName?: string;
  serverName?: string;
  port?: number;
  sslMode?: string;
  kmsKeyId?: string;
}

export interface DmsReplicationTask extends BaseResource {
  status?: string;
  migrationType?: string;
  sourceEndpointArn?: string;
  targetEndpointArn?: string;
  replicationInstanceArn?: string;
}

// ---------------------------------------------------------------------------
// DataSync (regional): agents, locations, tasks
// ---------------------------------------------------------------------------

/** DataSync agent — VPC-ATTACHED when EndpointType is PRIVATE_LINK. */
export interface DataSyncAgent extends BaseResource {
  status?: string;
  /** PUBLIC | PRIVATE_LINK | FIPS. */
  endpointType?: string;
  /** PrivateLinkConfig.VpcEndpointId. */
  vpcEndpointId?: string;
  /** PrivateLinkConfig.SubnetArns. */
  subnetArns: string[];
  /** PrivateLinkConfig.SecurityGroupArns. */
  securityGroupArns: string[];
}

/** DataSync location — EFS/FSx locations are VPC-ATTACHED (subnet + SGs). */
export interface DataSyncLocation extends BaseResource {
  /** Derived from the LocationUri scheme (s3/efs/nfs/smb/fsxWindows/…). */
  locationType?: string;
  locationUri?: string;
  /** EFS Ec2Config.SubnetArn (VPC-attached locations). */
  subnetArn?: string;
  /** EFS Ec2Config.SecurityGroupArns / FSx SecurityGroupArns. */
  securityGroupArns: string[];
}

export interface DataSyncTask extends BaseResource {
  status?: string;
  sourceLocationArn?: string;
  destinationLocationArn?: string;
}

// ---------------------------------------------------------------------------
// Kinesis Data Firehose (regional): delivery streams
// ---------------------------------------------------------------------------

/**
 * Firehose delivery stream — VPC-ATTACHED when the destination is an in-VPC
 * OpenSearch/Elasticsearch domain (VpcConfigurationDescription: subnet + SG).
 */
export interface FirehoseDeliveryStream extends BaseResource {
  status?: string;
  /** DirectPut | KinesisStreamAsSource | MSKAsSource. */
  deliveryStreamType?: string;
  /** s3 | extendedS3 | opensearch | elasticsearch | redshift | http | splunk | snowflake. */
  destinationType?: string;
  /** DeliveryStreamEncryptionConfiguration.KeyARN. */
  kmsKeyArn?: string;
  /** KinesisStreamSourceDescription.KinesisStreamARN or MSKSourceDescription.MSKClusterARN. */
  sourceStreamArn?: string;
  // VPC attachment (only when destination is in-VPC OpenSearch/Elasticsearch):
  vpcId?: string;
  /** VpcConfigurationDescription.SubnetIds. */
  subnetIds: string[];
  /** VpcConfigurationDescription.SecurityGroupIds. */
  securityGroupIds: string[];
}

// ---------------------------------------------------------------------------
// AWS Config (regional): recorders, rules, conformance packs
// ---------------------------------------------------------------------------

/**
 * Configuration recorder merged with its status and the region's delivery
 * channel (0-or-1 per region) — whether Config is on, what it records, and
 * where it delivers.
 */
export interface ConfigRecorder extends BaseResource {
  /** From DescribeConfigurationRecorderStatus.recording. */
  recording?: boolean;
  lastStatus?: string;
  roleArn?: string;
  /** recordingGroup.allSupported. */
  allSupported?: boolean;
  includeGlobalResourceTypes?: boolean;
  /** recordingGroup.resourceTypes (when not allSupported). */
  recordedResourceTypes: string[];
  /** From DescribeDeliveryChannels. */
  deliveryS3BucketName?: string;
  deliverySnsTopicArn?: string;
}

export interface ConfigRule extends BaseResource {
  /** Source.Owner (AWS | CUSTOM_LAMBDA | CUSTOM_POLICY) + '/' + SourceIdentifier. */
  source?: string;
  /** ConfigRuleState. */
  state?: string;
}

export interface ConfigConformancePack extends BaseResource {
  status?: string;
}

// ---------------------------------------------------------------------------
// CloudTrail (regional): trails + Lake event data stores
// ---------------------------------------------------------------------------

/**
 * CloudTrail trail merged with its status (GetTrailStatus) and event
 * selectors (GetEventSelectors) — audit-logging posture: whether logging is
 * on, what it covers, and where it delivers.
 */
export interface CloudTrailTrail extends BaseResource {
  homeRegion?: string;
  isMultiRegionTrail?: boolean;
  isOrganizationTrail?: boolean;
  s3BucketName?: string;
  kmsKeyId?: string;
  logFileValidationEnabled?: boolean;
  cloudWatchLogsLogGroupArn?: string;
  snsTopicArn?: string;
  /** From GetTrailStatus. */
  isLogging?: boolean;
  /** From GetEventSelectors. */
  includeManagementEvents?: boolean;
  /** Any data resource selector present. */
  hasDataEvents?: boolean;
}

/** CloudTrail Lake event data store. */
export interface CloudTrailEventDataStore extends BaseResource {
  status?: string;
  multiRegionEnabled?: boolean;
  organizationEnabled?: boolean;
  retentionPeriod?: number;
}

// ---------------------------------------------------------------------------
// GuardDuty (regional): detectors
// ---------------------------------------------------------------------------

/**
 * GuardDuty detector (usually 0-or-1 per region) merged with its feature
 * configuration and publishing destination — threat-detection posture:
 * whether GuardDuty is on, which protection features are enabled, and where
 * findings publish.
 */
export interface GuardDutyDetector extends BaseResource {
  /** ENABLED | DISABLED. */
  status?: string;
  findingPublishingFrequency?: string;
  /** Feature configuration (S3/EKS/RDS/runtime/malware protection etc.). */
  features: Array<{ name?: string; status?: string }>;
  /** From ListPublishingDestinations (S3). */
  publishingDestinationType?: string;
}

// ---------------------------------------------------------------------------
// AWS Backup (regional): vaults + plans
// ---------------------------------------------------------------------------

/**
 * Backup vault merged with its vault-lock settings and whether an access
 * policy is attached — recoverability posture: is anything actually stored,
 * and is it protected from deletion.
 */
export interface BackupVault extends BaseResource {
  numberOfRecoveryPoints?: number;
  /** Vault lock present (LockDate or min/max retention configured). */
  locked?: boolean;
  minRetentionDays?: number;
  maxRetentionDays?: number;
  /** GetBackupVaultAccessPolicy returned a policy. */
  hasAccessPolicy?: boolean;
}

/**
 * Backup plan with its rules (schedule, lifecycle, cross-region/account copy
 * destinations) and a best-effort summary of what its selections cover.
 */
export interface BackupPlan extends BaseResource {
  rules: Array<{
    name?: string;
    targetVault?: string;
    scheduleExpression?: string;
    moveToColdStorageAfterDays?: number;
    deleteAfterDays?: number;
    /** CopyActions[].DestinationBackupVaultArn (cross-region/account). */
    copyToDestinations: string[];
    continuousBackup?: boolean;
  }>;
  /** Union of resource selections summary (best-effort). */
  selectionResourceTypes: string[];
}

// ---------------------------------------------------------------------------
// Identity & access (IAM — account-global)
// ---------------------------------------------------------------------------

export interface IamRole extends BaseResource {
  path?: string;
  /** URL-decoded assume-role (trust) policy JSON document. */
  assumeRolePolicyDocument?: string;
  attachedManagedPolicyArns: string[];
  inlinePolicyNames: string[];
  description?: string;
  maxSessionDuration?: number;
  /** ISO timestamp of RoleLastUsed, if available. */
  lastUsed?: string;
}

export interface IamUser extends BaseResource {
  path?: string;
  groups: string[];
  attachedManagedPolicyArns: string[];
  inlinePolicyNames: string[];
  hasConsoleAccess?: boolean;
  mfaDeviceCount: number;
  accessKeyIds: string[];
  passwordLastUsed?: string;
}

export interface IamGroup extends BaseResource {
  path?: string;
  attachedManagedPolicyArns: string[];
  inlinePolicyNames: string[];
  userNames: string[];
}

export interface IamPolicy extends BaseResource {
  path?: string;
  attachmentCount?: number;
  isAttachable?: boolean;
  /** URL-decoded default-version policy document JSON. */
  defaultVersionDocument?: string;
  description?: string;
}

export interface IamInstanceProfile extends BaseResource {
  path?: string;
  roleNames: string[];
}

// ---------------------------------------------------------------------------
// Security services (regional): KMS, ACM, Secrets Manager
// ---------------------------------------------------------------------------

export interface KmsKey extends BaseResource {
  aliases: string[];
  description?: string;
  /** "AWS" (AWS-managed) or "CUSTOMER" (customer-managed). */
  keyManager?: string;
  keyState?: string;
  keyUsage?: string;
  keySpec?: string;
  rotationEnabled?: boolean;
  multiRegion?: boolean;
}

export interface AcmCertificate extends BaseResource {
  domainName?: string;
  subjectAlternativeNames: string[];
  status?: string;
  /** AMAZON_ISSUED or IMPORTED. */
  certType?: string;
  /** ARNs of resources using the certificate (ELB, CloudFront, …). */
  inUseBy: string[];
  notAfter?: string;
  renewalEligibility?: string;
}

/** Secrets Manager secret METADATA only — the value is never fetched. */
export interface SecretMetadata extends BaseResource {
  description?: string;
  rotationEnabled?: boolean;
  lastRotatedDate?: string;
  lastChangedDate?: string;
  kmsKeyId?: string;
}

// ---------------------------------------------------------------------------
// Additional network services (regional unless noted)
// ---------------------------------------------------------------------------

export interface Route53ResolverEndpoint extends BaseResource {
  /** INBOUND or OUTBOUND. */
  direction?: string;
  vpcId?: string;
  subnetIds: string[];
  ipAddresses: string[];
  securityGroupIds: string[];
  status?: string;
}

export interface Route53ResolverRule extends BaseResource {
  domainName?: string;
  /** FORWARD, SYSTEM, or RECURSIVE. */
  ruleType?: string;
  resolverEndpointId?: string;
  targetIps: string[];
  vpcAssociationIds: string[];
  shareStatus?: string;
}

export interface ClientVpnEndpoint extends BaseResource {
  description?: string;
  vpcId?: string;
  clientCidrBlock?: string;
  dnsServers: string[];
  securityGroupIds: string[];
  associatedSubnetIds: string[];
  status?: string;
  splitTunnel?: boolean;
  /** The endpoint's own route table. */
  routes?: Array<{
    destinationCidr?: string;
    targetSubnet?: string;
    origin?: string;
    status?: string;
    description?: string;
  }>;
  /** Which client groups may reach which destination networks. */
  authorizationRules?: Array<{
    destinationCidr?: string;
    groupId?: string;
    accessAll?: boolean;
    status?: string;
    description?: string;
  }>;
}

export interface NetworkFirewall extends BaseResource {
  vpcId?: string;
  subnetIds: string[];
  firewallPolicyArn?: string;
  deleteProtection?: boolean;
  status?: string;
  /**
   * Per-AZ firewall endpoints (from FirewallStatus.SyncStates). These are the
   * vpce-… ids that inspection route tables point at — the link between a
   * route and this firewall.
   */
  endpoints?: Array<{ availabilityZone?: string; subnetId?: string; endpointId?: string }>;
  /** Where ALERT/FLOW/TLS logs are delivered. */
  logDestinations?: Array<{ logType?: string; destinationType?: string; destination?: string }>;
}

export interface NetworkFirewallPolicy extends BaseResource {
  description?: string;
  statelessDefaultActions: string[];
  statelessFragmentDefaultActions: string[];
  statelessRuleGroupRefs: Array<{ arn: string; priority?: number }>;
  statefulRuleGroupRefs: Array<{ arn: string; priority?: number }>;
  statefulDefaultActions: string[];
  /** DEFAULT_ACTION_ORDER or STRICT_ORDER. */
  statefulRuleOrder?: string;
  tlsInspectionConfigurationArn?: string;
}

export interface NetworkFirewallStatelessRule {
  priority?: number;
  actions: string[];
  sources: string[];
  destinations: string[];
  /** Port specs as "80" or "1024-65535". */
  sourcePorts: string[];
  destinationPorts: string[];
  protocols: number[];
}

export interface NetworkFirewallStatefulRule {
  action?: string;
  protocol?: string;
  source?: string;
  sourcePort?: string;
  direction?: string;
  destination?: string;
  destinationPort?: string;
  /** Suricata rule id (sid), when present. */
  sid?: string;
}

export interface NetworkFirewallRuleGroup extends BaseResource {
  /** STATELESS or STATEFUL. */
  ruleGroupType?: string;
  description?: string;
  capacity?: number;
  consumedCapacity?: number;
  numberOfAssociations?: number;
  statelessRules: NetworkFirewallStatelessRule[];
  statefulRules: NetworkFirewallStatefulRule[];
  /** Raw Suricata rules, when the group is defined as a rules string. */
  rulesString?: string;
  /** Domain-list rules source (allow/deny listed domains). */
  domainList?: { targets: string[]; targetTypes: string[]; action?: string };
}

export interface NetworkFirewallTlsConfig extends BaseResource {
  description?: string;
  certificateArns: string[];
}

// ---------------------------------------------------------------------------
// WAF v2 (REGIONAL per region; CLOUDFRONT scope collected account-globally)
// ---------------------------------------------------------------------------

export interface WafRuleSummary {
  name: string;
  priority?: number;
  /** Rule action (ALLOW/BLOCK/COUNT/CAPTCHA/CHALLENGE) or "use-rule-group-actions". */
  action?: string;
  /**
   * Compact statement descriptor, e.g. "managedRuleGroup:AWS/AWSManagedRulesCommonRuleSet",
   * "ruleGroup:arn:…", "ipSet:arn:…", "rateBased:2000", "geoMatch", "byteMatch", "and(…)".
   */
  statement?: string;
}

export interface WafWebAcl extends BaseResource {
  scope: 'REGIONAL' | 'CLOUDFRONT';
  description?: string;
  defaultAction?: string;
  capacity?: number;
  rules: WafRuleSummary[];
  /**
   * Resources this ACL protects (ALB/API GW/AppSync ARNs). Empty for
   * CLOUDFRONT scope — match via CloudFrontDistribution.webAclId instead.
   */
  associatedResourceArns: string[];
}

export interface WafIpSet extends BaseResource {
  scope: 'REGIONAL' | 'CLOUDFRONT';
  description?: string;
  ipAddressVersion?: string;
  addresses: string[];
}

/** Customer-managed WAF rule group. */
export interface WafRuleGroup extends BaseResource {
  scope: 'REGIONAL' | 'CLOUDFRONT';
  description?: string;
  capacity?: number;
  rules: WafRuleSummary[];
}

// ---------------------------------------------------------------------------
// Route 53 Resolver DNS Firewall & query logging
// ---------------------------------------------------------------------------

export interface DnsFirewallRule {
  name?: string;
  priority?: number;
  /** ALLOW, BLOCK, or ALERT. */
  action?: string;
  blockResponse?: string;
  firewallDomainListId?: string;
  domainListName?: string;
  /** Domains in the list (capped; AWS-managed lists are not expanded). */
  domains: string[];
}

export interface DnsFirewallRuleGroup extends BaseResource {
  status?: string;
  ruleCount?: number;
  shareStatus?: string;
  rules: DnsFirewallRule[];
  vpcAssociations: Array<{ vpcId: string; priority?: number; mutationProtection?: string }>;
}

export interface ResolverQueryLogConfig extends BaseResource {
  destinationArn?: string;
  status?: string;
  shareStatus?: string;
  /** VPCs whose resolver queries are logged to this config. */
  vpcIds: string[];
}

export interface ApiGateway extends BaseResource {
  /** REST, HTTP, or WEBSOCKET. */
  protocolType?: string;
  /** EDGE, REGIONAL, or PRIVATE (REST APIs). */
  endpointType?: string;
  apiEndpoint?: string;
  stages: string[];
  /** For PRIVATE REST APIs: the VPC endpoint ids that can reach it. */
  vpcEndpointIds: string[];
}

/** API Gateway VPC link: connects an API to NLBs (v1) or subnets (v2). */
export interface ApiGatewayVpcLink extends BaseResource {
  version: 'v1' | 'v2';
  status?: string;
  /** v1: the NLB ARNs behind the link. */
  targetArns: string[];
  /** v2: the subnets/SGs the link's ENIs use. */
  subnetIds: string[];
  securityGroupIds: string[];
}

/** API Gateway custom domain (v1 + v2), with which API/stage each path maps to. */
export interface ApiGatewayDomainName extends BaseResource {
  domainName: string;
  endpointTypes: string[];
  certificateArns: string[];
  mappings: Array<{ apiId?: string; stage?: string; path?: string }>;
}

// ---------------------------------------------------------------------------
// VPC Lattice
// ---------------------------------------------------------------------------

export interface LatticeServiceNetwork extends BaseResource {
  numberOfAssociatedServices?: number;
  numberOfAssociatedVpcs?: number;
  authType?: string;
  vpcAssociations: Array<{ vpcId?: string; status?: string }>;
  serviceAssociations: Array<{ serviceArn?: string; serviceName?: string; status?: string }>;
}

export interface LatticeService extends BaseResource {
  dnsEntry?: string;
  customDomainName?: string;
  status?: string;
  authType?: string;
}

// ---------------------------------------------------------------------------
// Observability plumbing
// ---------------------------------------------------------------------------

// Note: storedBytes is deliberately NOT captured — it grows on every scan and
// would churn committed snapshots; retention/KMS/class carry the posture signal.
export interface LogGroup extends BaseResource {
  retentionDays?: number;
  kmsKeyId?: string;
  logGroupClass?: string;
}

// ---------------------------------------------------------------------------
// VPC-attached workloads (previously only visible as anonymous ENIs)
// ---------------------------------------------------------------------------

export interface EfsFileSystem extends BaseResource {
  state?: string;
  encrypted?: boolean;
  performanceMode?: string;
  vpcId?: string;
  mountTargets: Array<{
    id: string;
    subnetId?: string;
    ipAddress?: string;
    availabilityZone?: string;
    securityGroupIds: string[];
  }>;
}

export interface OpenSearchDomain extends BaseResource {
  engineVersion?: string;
  endpoint?: string;
  /** No VPC options = publicly reachable endpoint. */
  inVpc: boolean;
  vpcId?: string;
  subnetIds: string[];
  securityGroupIds: string[];
}

export interface MskCluster extends BaseResource {
  clusterType?: string;
  state?: string;
  kafkaVersion?: string;
  numberOfBrokerNodes?: number;
  subnetIds: string[];
  securityGroupIds: string[];
}

export interface RedshiftCluster extends BaseResource {
  nodeType?: string;
  numberOfNodes?: number;
  state?: string;
  vpcId?: string;
  subnetGroupName?: string;
  subnetIds: string[];
  securityGroupIds: string[];
  publiclyAccessible?: boolean;
  endpoint?: { address?: string; port?: number };
  availabilityZone?: string;
}

export interface MqBroker extends BaseResource {
  engineType?: string;
  deploymentMode?: string;
  state?: string;
  publiclyAccessible?: boolean;
  subnetIds: string[];
  securityGroupIds: string[];
}

/** DynamoDB table detail (DescribeTable + PITR + TTL) — read-only metadata. */
export interface DynamoDbTable extends BaseResource {
  status?: string;
  /** PROVISIONED | PAY_PER_REQUEST. */
  billingMode?: string;
  itemCount?: number;
  sizeBytes?: number;
  /** KeySchema HASH attribute name. */
  partitionKey?: string;
  /** KeySchema RANGE attribute name. */
  sortKey?: string;
  /** From SSEDescription.SSEType (AES256 | KMS). */
  sseType?: string;
  /** SSEDescription.KMSMasterKeyArn. */
  kmsKey?: string;
  streamEnabled?: boolean;
  streamViewType?: string;
  streamArn?: string;
  /** Point-in-time recovery, from DescribeContinuousBackups. */
  pitrEnabled?: boolean;
  /** From DescribeTimeToLive (status ENABLED). */
  ttlEnabled?: boolean;
  /** Replicas[].RegionName — non-empty means a global table. */
  globalTableReplicas: string[];
  deletionProtectionEnabled?: boolean;
}

export interface RdsProxy extends BaseResource {
  engineFamily?: string;
  status?: string;
  endpoint?: string;
  vpcId?: string;
  subnetIds: string[];
  securityGroupIds: string[];
  requireTls?: boolean;
}

export interface ElastiCacheServerlessCache extends BaseResource {
  engine?: string;
  status?: string;
  endpoint?: string;
  subnetIds: string[];
  securityGroupIds: string[];
}

export interface ElastiCacheReplicationGroup extends BaseResource {
  description?: string;
  status?: string;
  memberClusterIds: string[];
  clusterModeEnabled?: boolean;
  automaticFailover?: string;
  primaryEndpoint?: string;
  readerEndpoint?: string;
}

/** CloudFront distributions are account-global. */
export interface CloudFrontDistribution extends BaseResource {
  domainName?: string;
  aliases: string[];
  enabled?: boolean;
  status?: string;
  origins: string[];
  priceClass?: string;
  webAclId?: string;
  /** Per-origin detail: S3 vs custom vs VPC origin (private ALB/NLB/EC2). */
  originDetails?: Array<{
    domainName?: string;
    originType?: 's3' | 'custom' | 'vpc';
    vpcOriginId?: string;
    originAccessControlId?: string;
  }>;
}

/** CloudFront VPC origin: lets a distribution reach a private ALB/NLB/EC2 directly. */
export interface CloudFrontVpcOrigin extends BaseResource {
  status?: string;
  /** ARN of the ALB/NLB/instance inside the VPC. */
  endpointArn?: string;
}

/** Global Accelerator (account-global; API lives in us-west-2). */
export interface GlobalAccelerator extends BaseResource {
  dnsName?: string;
  status?: string;
  enabled?: boolean;
  ipAddressType?: string;
  ipAddresses: string[];
  listeners: Array<{
    protocol?: string;
    portRanges: Array<{ fromPort?: number; toPort?: number }>;
    endpointGroups: Array<{
      region?: string;
      trafficDialPercentage?: number;
      endpoints: Array<{
        endpointId?: string;
        weight?: number;
        clientIpPreservation?: boolean;
        healthState?: string;
      }>;
    }>;
  }>;
}

/** Cloud WAN core network (account-global; routes can target its ARN). */
export interface CoreNetwork extends BaseResource {
  globalNetworkId?: string;
  state?: string;
  description?: string;
  segments: string[];
  edges: Array<{ location?: string; asn?: number }>;
  attachments: Array<{
    id: string;
    type?: string;
    state?: string;
    edgeLocation?: string;
    resourceArn?: string;
    segmentName?: string;
    ownerAccountId?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Global (non-regional) resources
// ---------------------------------------------------------------------------

export interface DnsRecord {
  name: string;
  type: string;
  ttl?: number;
  values: string[];
  /** ALIAS target DNS name (ALB/CloudFront/API GW/…), when the record is an alias. */
  aliasTarget?: string;
}

export interface Route53HostedZone extends BaseResource {
  zoneName: string;
  privateZone: boolean;
  recordCount?: number;
  /** For private zones: the VPCs associated with the zone. */
  vpcAssociations: Array<{ vpcId: string; region: string }>;
  /** A/AAAA/CNAME records (aliases included) — what stitches DNS names to resources. */
  records?: DnsRecord[];
  /** True when the zone exceeded the per-zone record cap and records is partial. */
  recordsTruncated?: boolean;
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
  /**
   * How this resource was discovered:
   * "tagging" — Resource Groups Tagging API (tagged resources only);
   * "cloudcontrol" — Cloud Control API sweep (catches untagged resources).
   */
  source?: 'tagging' | 'cloudcontrol';
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
  vpcEndpointServices: VpcEndpointService[];
  prefixLists: ManagedPrefixList[];
  flowLogs: FlowLog[];
  dhcpOptions: DhcpOptions[];
  instanceConnectEndpoints: InstanceConnectEndpoint[];

  peeringConnections: VpcPeeringConnection[];
  transitGateways: TransitGateway[];
  transitGatewayAttachments: TransitGatewayAttachment[];
  transitGatewayRouteTables: TransitGatewayRouteTable[];
  transitGatewayConnectPeers: TransitGatewayConnectPeer[];
  vpnGateways: VpnGateway[];
  customerGateways: CustomerGateway[];
  vpnConnections: VpnConnection[];
  dxConnections: DxConnection[];
  dxLags: DxLag[];
  dxVirtualInterfaces: DxVirtualInterface[];

  loadBalancers: LoadBalancer[];
  targetGroups: TargetGroup[];

  instances: Ec2Instance[];
  autoScalingGroups: AutoScalingGroup[];
  lambdaFunctions: LambdaFunction[];
  rdsInstances: RdsInstance[];
  rdsClusters: RdsCluster[];
  rdsProxies: RdsProxy[];
  ecsServices: EcsService[];
  eksClusters: EksCluster[];
  elastiCacheClusters: ElastiCacheCluster[];
  elastiCacheReplicationGroups: ElastiCacheReplicationGroup[];
  elastiCacheServerlessCaches: ElastiCacheServerlessCache[];
  efsFileSystems: EfsFileSystem[];
  openSearchDomains: OpenSearchDomain[];
  mskClusters: MskCluster[];
  redshiftClusters: RedshiftCluster[];
  mqBrokers: MqBroker[];
  dynamoDbTables: DynamoDbTable[];

  // security services (regional)
  kmsKeys: KmsKey[];
  acmCertificates: AcmCertificate[];
  secrets: SecretMetadata[];
  wafWebAcls: WafWebAcl[];
  wafIpSets: WafIpSet[];
  wafRuleGroups: WafRuleGroup[];

  // additional network services (regional)
  resolverEndpoints: Route53ResolverEndpoint[];
  resolverRules: Route53ResolverRule[];
  dnsFirewallRuleGroups: DnsFirewallRuleGroup[];
  resolverQueryLogConfigs: ResolverQueryLogConfig[];
  clientVpnEndpoints: ClientVpnEndpoint[];
  networkFirewalls: NetworkFirewall[];
  networkFirewallPolicies: NetworkFirewallPolicy[];
  networkFirewallRuleGroups: NetworkFirewallRuleGroup[];
  networkFirewallTlsConfigs: NetworkFirewallTlsConfig[];
  apiGateways: ApiGateway[];
  apiGatewayVpcLinks: ApiGatewayVpcLink[];
  apiGatewayDomainNames: ApiGatewayDomainName[];
  latticeServiceNetworks: LatticeServiceNetwork[];
  latticeServices: LatticeService[];
  logGroups: LogGroup[];

  // identity services (regional)
  cognitoUserPools: CognitoUserPool[];
  cognitoIdentityPools: CognitoIdentityPool[];

  // container registry (regional)
  ecrRepositories: EcrRepository[];
  ecrRegistries: EcrRegistry[];

  // messaging (regional)
  snsTopics: SnsTopic[];
  sqsQueues: SqsQueue[];

  // eventing (regional)
  eventBuses: EventBus[];
  eventBridgePipes: EventBridgePipe[];
  eventBridgeSchedules: EventBridgeSchedule[];

  // orchestration (regional)
  sfnStateMachines: SfnStateMachine[];

  // Glue (regional)
  glueConnections: GlueConnection[];
  glueDevEndpoints: GlueDevEndpoint[];
  glueJobs: GlueJob[];
  glueCrawlers: GlueCrawler[];
  glueDatabases: GlueDatabase[];

  // DMS (regional)
  dmsReplicationInstances: DmsReplicationInstance[];
  dmsEndpoints: DmsEndpoint[];
  dmsReplicationTasks: DmsReplicationTask[];

  // DataSync (regional)
  dataSyncAgents: DataSyncAgent[];
  dataSyncLocations: DataSyncLocation[];
  dataSyncTasks: DataSyncTask[];

  // Kinesis Data Firehose (regional)
  firehoseDeliveryStreams: FirehoseDeliveryStream[];

  // AWS Config posture (regional)
  configRecorders: ConfigRecorder[];
  configRules: ConfigRule[];
  configConformancePacks: ConfigConformancePack[];

  // CloudTrail posture (regional)
  cloudTrailTrails: CloudTrailTrail[];
  cloudTrailEventDataStores: CloudTrailEventDataStore[];

  // GuardDuty posture (regional)
  guardDutyDetectors: GuardDutyDetector[];

  // AWS Backup posture (regional)
  backupVaults: BackupVault[];
  backupPlans: BackupPlan[];

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
    // IAM is account-global; collected once per account.
    iamRoles: IamRole[];
    iamUsers: IamUser[];
    iamGroups: IamGroup[];
    iamPolicies: IamPolicy[];
    iamInstanceProfiles: IamInstanceProfile[];
    /** CloudFront distributions are account-global. */
    cloudFrontDistributions: CloudFrontDistribution[];
    /** CloudFront VPC origins (distribution → private ALB/NLB/EC2). */
    cloudFrontVpcOrigins: CloudFrontVpcOrigin[];
    /** Global Accelerator accelerators (API in us-west-2). */
    globalAccelerators: GlobalAccelerator[];
    /** Cloud WAN core networks. */
    coreNetworks: CoreNetwork[];
    /** WAF v2 CLOUDFRONT-scope ACLs/sets/groups (API in us-east-1). */
    wafWebAcls: WafWebAcl[];
    wafIpSets: WafIpSet[];
    wafRuleGroups: WafRuleGroup[];
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
    vpcEndpointServices: [],
    prefixLists: [],
    flowLogs: [],
    dhcpOptions: [],
    instanceConnectEndpoints: [],
    peeringConnections: [],
    transitGateways: [],
    transitGatewayAttachments: [],
    transitGatewayRouteTables: [],
    transitGatewayConnectPeers: [],
    vpnGateways: [],
    customerGateways: [],
    vpnConnections: [],
    dxConnections: [],
    dxLags: [],
    dxVirtualInterfaces: [],
    loadBalancers: [],
    targetGroups: [],
    instances: [],
    autoScalingGroups: [],
    lambdaFunctions: [],
    rdsInstances: [],
    rdsClusters: [],
    rdsProxies: [],
    ecsServices: [],
    eksClusters: [],
    elastiCacheClusters: [],
    elastiCacheReplicationGroups: [],
    elastiCacheServerlessCaches: [],
    efsFileSystems: [],
    openSearchDomains: [],
    mskClusters: [],
    redshiftClusters: [],
    mqBrokers: [],
    dynamoDbTables: [],
    kmsKeys: [],
    acmCertificates: [],
    secrets: [],
    wafWebAcls: [],
    wafIpSets: [],
    wafRuleGroups: [],
    resolverEndpoints: [],
    resolverRules: [],
    dnsFirewallRuleGroups: [],
    resolverQueryLogConfigs: [],
    clientVpnEndpoints: [],
    networkFirewalls: [],
    networkFirewallPolicies: [],
    networkFirewallRuleGroups: [],
    networkFirewallTlsConfigs: [],
    apiGateways: [],
    apiGatewayVpcLinks: [],
    apiGatewayDomainNames: [],
    latticeServiceNetworks: [],
    latticeServices: [],
    logGroups: [],
    cognitoUserPools: [],
    cognitoIdentityPools: [],
    ecrRepositories: [],
    ecrRegistries: [],
    snsTopics: [],
    sqsQueues: [],
    eventBuses: [],
    eventBridgePipes: [],
    eventBridgeSchedules: [],
    sfnStateMachines: [],
    glueConnections: [],
    glueDevEndpoints: [],
    glueJobs: [],
    glueCrawlers: [],
    glueDatabases: [],
    dmsReplicationInstances: [],
    dmsEndpoints: [],
    dmsReplicationTasks: [],
    dataSyncAgents: [],
    dataSyncLocations: [],
    dataSyncTasks: [],
    firehoseDeliveryStreams: [],
    configRecorders: [],
    configRules: [],
    configConformancePacks: [],
    cloudTrailTrails: [],
    cloudTrailEventDataStores: [],
    guardDutyDetectors: [],
    backupVaults: [],
    backupPlans: [],
    generic: [],
  };
}

/** Create the empty global (account-level) resource container. */
export function emptyGlobal(): AccountSnapshot['global'] {
  return {
    hostedZones: [],
    directConnectGateways: [],
    s3Buckets: [],
    iamRoles: [],
    iamUsers: [],
    iamGroups: [],
    iamPolicies: [],
    iamInstanceProfiles: [],
    cloudFrontDistributions: [],
    cloudFrontVpcOrigins: [],
    globalAccelerators: [],
    coreNetworks: [],
    wafWebAcls: [],
    wafIpSets: [],
    wafRuleGroups: [],
    errors: [],
  };
}
