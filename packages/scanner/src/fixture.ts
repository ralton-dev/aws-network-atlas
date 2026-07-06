#!/usr/bin/env tsx
/**
 * DEV FIXTURE — writes a synthetic multi-account AWS estate to site/data/ so
 * the viewer can be explored with zero AWS credentials. This is entirely
 * fabricated data (RFC 5737 documentation IPs, placeholder account ids) and
 * never touches data/accounts/ (the real committable snapshots).
 *
 *   npx tsx src/fixture.ts        # from packages/scanner
 *
 * Topology: a Transit Gateway hub-and-spoke.
 *   acme-shared (222…) owns the TGW hub in eu-west-1, terminates the
 *     Site-to-Site VPN and Direct Connect to on-prem.
 *   acme-prod (111…) — big prod VPC in eu-west-1 (3 AZs, ALB→ASG→Aurora,
 *     endpoints, 3 NATs) plus a DR VPC in us-east-1 reached via inter-region
 *     TGW peering.
 *   acme-dev (333…) — a dev VPC, TGW spoke, and directly peered to prod.
 *   A legacy account (444…) is referenced by a peering but not scanned, so it
 *     renders as a dashed "ghost".
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SNAPSHOT_VERSION,
  emptyRegionSnapshot,
  type AccountSnapshot,
  type AnnotationMap,
  type RegionSnapshot,
  type Route,
  type Snapshot,
} from '@atlas/schema';
import { jsonScriptPayload } from './bundle.js';

// ---------------------------------------------------------------------------
// Shared identifiers (kept consistent across accounts so links stitch up)
// ---------------------------------------------------------------------------

const ACCT = { prod: '111111111111', shared: '222222222222', dev: '333333333333', legacy: '444444444444' };
const EU = 'eu-west-1';
const US = 'us-east-1';

const TGW_EU = 'tgw-0a1b2c3d4e5f00001';
const TGW_US = 'tgw-0a1b2c3d4e5f00002';
const TGW_RTB_EU = 'tgw-rtb-0aaaa0000000001';
const DXGW = 'dxgw-0f1e2d3c4b5a00001';
const CGW = 'cgw-0aa11bb22cc330001';

// TGW attachment ids
const ATT = {
  prod: 'tgw-attach-0prod0000000001',
  dev: 'tgw-attach-0dev00000000001',
  sharedVpc: 'tgw-attach-0shr00000000001',
  vpn: 'tgw-attach-0vpn00000000001',
  dx: 'tgw-attach-0dxg00000000001',
  peer: 'tgw-attach-0peer0000000001', // eu<->us TGW peering
};

// ---------------------------------------------------------------------------
// Small factory helpers (fill schema defaults; keep the builders below terse)
// ---------------------------------------------------------------------------

const route = (targetType: Route['targetType'], targetId: string, dest?: string, state: Route['state'] = 'active'): Route => ({
  targetType,
  targetId,
  destinationCidr: dest,
  state,
});

interface SubnetSpec {
  id: string;
  name: string;
  az: string;
  cidr: string;
  public: boolean;
  rtb: string;
}

function addSubnet(r: RegionSnapshot, vpcId: string, s: SubnetSpec): void {
  r.subnets.push({
    id: s.id,
    name: s.name,
    tags: { Name: s.name },
    vpcId,
    cidrBlock: s.cidr,
    ipv6CidrBlocks: [],
    availabilityZone: s.az,
    mapPublicIpOnLaunch: s.public,
    routeTableId: s.rtb,
    isPublic: s.public,
  });
}

function addInstance(
  r: RegionSnapshot,
  o: { id: string; name: string; vpcId: string; subnetId: string; az: string; ip: string; sg: string; type?: string; role?: string },
): void {
  r.instances.push({
    id: o.id,
    name: o.name,
    tags: { Name: o.name, ...(o.role ? { role: o.role } : {}) },
    instanceType: o.type ?? 'm7g.large',
    state: 'running',
    vpcId: o.vpcId,
    subnetId: o.subnetId,
    availabilityZone: o.az,
    privateIp: o.ip,
    securityGroupIds: [o.sg],
  });
}

// ---------------------------------------------------------------------------
// acme-prod — eu-west-1 primary VPC (the showpiece drill-down)
// ---------------------------------------------------------------------------

function prodEuWest1(): RegionSnapshot {
  const r = emptyRegionSnapshot(EU);
  const vpc = 'vpc-0prod00000000000a1';
  const sg = 'sg-0prodapp000000001';
  const albSg = 'sg-0prodalb000000001';

  r.vpcs.push({
    id: vpc,
    name: 'prod-vpc',
    tags: { Name: 'prod-vpc', env: 'prod' },
    cidrBlocks: ['10.0.0.0/16'],
    ipv6CidrBlocks: [],
    isDefault: false,
    state: 'available',
  });

  const rtbPublic = 'rtb-0prodpublic00001';
  const azs = ['a', 'b', 'c'] as const;

  // Public subnets (one per AZ) — share the IGW route table.
  azs.forEach((az, i) =>
    addSubnet(r, vpc, { id: `subnet-0prodpub0000${i}01`, name: `prod-public-${az}`, az: `${EU}${az}`, cidr: `10.0.${i}.0/24`, public: true, rtb: rtbPublic }),
  );
  // Private app subnets (one route table per AZ → its local NAT).
  azs.forEach((az, i) =>
    addSubnet(r, vpc, { id: `subnet-0prodapp0000${i}01`, name: `prod-app-${az}`, az: `${EU}${az}`, cidr: `10.0.1${i}.0/24`, public: false, rtb: `rtb-0prodapp00000${i}01` }),
  );
  // Private db subnets (2 AZs).
  ['a', 'b'].forEach((az, i) =>
    addSubnet(r, vpc, { id: `subnet-0proddb00000${i}01`, name: `prod-db-${az}`, az: `${EU}${az}`, cidr: `10.0.2${i}.0/24`, public: false, rtb: 'rtb-0proddb0000000001' }),
  );

  // IGW + one NAT gateway per AZ (in each public subnet).
  r.internetGateways.push({ id: 'igw-0prod000000000001', name: 'prod-igw', tags: {}, vpcIds: [vpc] });
  azs.forEach((az, i) =>
    r.natGateways.push({
      id: `nat-0prod00000000${i}01`,
      name: `prod-nat-${az}`,
      tags: {},
      vpcId: vpc,
      subnetId: `subnet-0prodpub0000${i}01`,
      connectivityType: 'public',
      state: 'available',
      addresses: [{ publicIp: `198.51.100.${10 + i}`, privateIp: `10.0.${i}.10` }],
    }),
  );
  azs.forEach((az, i) =>
    r.elasticIps.push({ id: `eipalloc-0prod00000${i}01`, tags: {}, publicIp: `198.51.100.${10 + i}`, associationId: `eipassoc-0prod0000${i}` }),
  );

  // Route tables. Private app tables route: local, NAT (per-AZ), TGW (to shared/
  // dev/on-prem CIDRs), and peering to dev.
  r.routeTables.push({
    id: rtbPublic,
    name: 'prod-public',
    tags: {},
    vpcId: vpc,
    isMain: false,
    subnetAssociations: azs.map((_, i) => `subnet-0prodpub0000${i}01`),
    gatewayAssociations: [],
    routes: [route('local', 'local', '10.0.0.0/16'), route('igw', 'igw-0prod000000000001', '0.0.0.0/0')],
  });
  azs.forEach((_, i) =>
    r.routeTables.push({
      id: `rtb-0prodapp00000${i}01`,
      name: `prod-app-${azs[i]}`,
      tags: {},
      vpcId: vpc,
      isMain: false,
      subnetAssociations: [`subnet-0prodapp0000${i}01`],
      gatewayAssociations: [],
      routes: [
        route('local', 'local', '10.0.0.0/16'),
        route('nat', `nat-0prod00000000${i}01`, '0.0.0.0/0'),
        route('tgw', TGW_EU, '10.1.0.0/16'), // shared services
        route('tgw', TGW_EU, '172.16.0.0/12'), // on-prem via VPN/DX
        route('pcx', 'pcx-0proddev000000001', '10.2.0.0/16'), // dev, direct peer
        route('pcx', 'pcx-0prodlegacy0000001', '10.99.0.0/16'), // legacy (ghost)
      ],
    }),
  );
  r.routeTables.push({
    id: 'rtb-0proddb0000000001',
    name: 'prod-db',
    tags: {},
    vpcId: vpc,
    isMain: true,
    subnetAssociations: ['subnet-0proddb0000001', 'subnet-0proddb0000101'].map((_, i) => `subnet-0proddb00000${i}01`),
    gatewayAssociations: [],
    routes: [route('local', 'local', '10.0.0.0/16'), route('tgw', TGW_EU, '10.1.0.0/16')],
  });

  // Security groups.
  r.securityGroups.push(
    {
      id: albSg,
      name: 'prod-alb',
      tags: {},
      vpcId: vpc,
      description: 'public ALB',
      ingress: [{ protocol: 'tcp', fromPort: 443, toPort: 443, cidrs: ['0.0.0.0/0'], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [], description: 'https from internet' }],
      egress: [{ protocol: '-1', cidrs: ['0.0.0.0/0'], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [] }],
    },
    {
      id: sg,
      name: 'prod-app',
      tags: {},
      vpcId: vpc,
      description: 'app tier',
      ingress: [{ protocol: 'tcp', fromPort: 8080, toPort: 8080, cidrs: [], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [{ groupId: albSg }], description: 'from ALB' }],
      egress: [{ protocol: '-1', cidrs: ['0.0.0.0/0'], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [] }],
    },
  );

  // ALB (public) → target group → 6 app instances across 3 AZs.
  const albArn = `arn:aws:elasticloadbalancing:${EU}:${ACCT.prod}:loadbalancer/app/prod-alb/abc123`;
  const tgArn = `arn:aws:elasticloadbalancing:${EU}:${ACCT.prod}:targetgroup/prod-app/def456`;
  const appInstanceIds: string[] = [];
  azs.forEach((az, i) => {
    for (let n = 0; n < 2; n++) {
      const id = `i-0prodapp00${i}${n}000001`;
      appInstanceIds.push(id);
      addInstance(r, { id, name: `prod-app-${az}-${n + 1}`, vpcId: vpc, subnetId: `subnet-0prodapp0000${i}01`, az: `${EU}${az}`, ip: `10.0.1${i}.${20 + n}`, sg, role: 'app' });
    }
  });
  r.loadBalancers.push({
    id: albArn,
    arn: albArn,
    name: 'prod-alb',
    tags: { env: 'prod' },
    lbType: 'application',
    scheme: 'internet-facing',
    vpcId: vpc,
    subnetIds: azs.map((_, i) => `subnet-0prodpub0000${i}01`),
    availabilityZones: azs.map((az) => `${EU}${az}`),
    securityGroupIds: [albSg],
    dnsName: 'prod-alb-123.eu-west-1.elb.amazonaws.com',
    state: 'active',
    listeners: [{ port: 443, protocol: 'HTTPS', targetGroupArns: [tgArn] }],
  });
  r.targetGroups.push({
    id: tgArn,
    arn: tgArn,
    name: 'prod-app',
    tags: {},
    protocol: 'HTTP',
    port: 8080,
    vpcId: vpc,
    targetType: 'instance',
    loadBalancerArns: [albArn],
    targets: appInstanceIds.map((id) => ({ targetId: id, port: 8080, health: 'healthy' })),
  });
  r.autoScalingGroups.push({
    id: 'prod-app-asg',
    arn: `arn:aws:autoscaling:${EU}:${ACCT.prod}:autoScalingGroup:1:autoScalingGroupName/prod-app-asg`,
    name: 'prod-app-asg',
    tags: { env: 'prod' },
    subnetIds: azs.map((_, i) => `subnet-0prodapp0000${i}01`),
    instanceIds: appInstanceIds,
    minSize: 3,
    maxSize: 9,
    desiredCapacity: 6,
    loadBalancerTargetGroupArns: [tgArn],
  });

  // Aurora cluster (writer + reader) multi-AZ in the db subnets.
  r.rdsClusters.push({
    id: 'prod-aurora',
    arn: `arn:aws:rds:${EU}:${ACCT.prod}:cluster:prod-aurora`,
    name: 'prod-aurora',
    tags: { env: 'prod' },
    engine: 'aurora-postgresql',
    engineVersion: '16.4',
    memberInstanceIds: ['prod-aurora-writer', 'prod-aurora-reader'],
    vpcId: vpc,
    subnetGroupName: 'prod-db',
    subnetIds: ['subnet-0proddb0000001', 'subnet-0proddb0000101'].map((_, i) => `subnet-0proddb00000${i}01`),
    securityGroupIds: [sg],
    endpoint: 'prod-aurora.cluster-abc.eu-west-1.rds.amazonaws.com',
    readerEndpoint: 'prod-aurora.cluster-ro-abc.eu-west-1.rds.amazonaws.com',
    multiAz: true,
  });
  ['writer', 'reader'].forEach((role, i) =>
    r.rdsInstances.push({
      id: `prod-aurora-${role}`,
      arn: `arn:aws:rds:${EU}:${ACCT.prod}:db:prod-aurora-${role}`,
      name: `prod-aurora-${role}`,
      tags: {},
      engine: 'aurora-postgresql',
      instanceClass: 'db.r6g.xlarge',
      clusterId: 'prod-aurora',
      vpcId: vpc,
      subnetGroupName: 'prod-db',
      subnetIds: [`subnet-0proddb00000${i}01`],
      securityGroupIds: [sg],
      multiAz: true,
      publiclyAccessible: false,
      availabilityZone: `${EU}${['a', 'b'][i]}`,
    }),
  );

  // ElastiCache, Lambda, endpoints.
  r.elastiCacheClusters.push({
    id: 'prod-redis',
    arn: `arn:aws:elasticache:${EU}:${ACCT.prod}:cluster:prod-redis`,
    name: 'prod-redis',
    tags: {},
    engine: 'redis',
    nodeType: 'cache.r7g.large',
    numNodes: 3,
    vpcId: vpc,
    subnetGroupName: 'prod-cache',
    subnetIds: azs.map((_, i) => `subnet-0prodapp0000${i}01`),
    securityGroupIds: [sg],
  });
  r.lambdaFunctions.push({
    id: `arn:aws:lambda:${EU}:${ACCT.prod}:function:prod-worker`,
    arn: `arn:aws:lambda:${EU}:${ACCT.prod}:function:prod-worker`,
    name: 'prod-worker',
    tags: {},
    runtime: 'nodejs22.x',
    description: 'async job worker',
    vpcConfig: { vpcId: vpc, subnetIds: azs.map((_, i) => `subnet-0prodapp0000${i}01`), securityGroupIds: [sg] },
  });
  r.vpcEndpoints.push(
    { id: 'vpce-0prods30000001', name: 's3-gateway', tags: {}, vpcId: vpc, serviceName: `com.amazonaws.${EU}.s3`, endpointType: 'Gateway', state: 'available', subnetIds: [], routeTableIds: azs.map((_, i) => `rtb-0prodapp00000${i}01`), networkInterfaceIds: [] },
    { id: 'vpce-0prodssm000001', name: 'ssm', tags: {}, vpcId: vpc, serviceName: `com.amazonaws.${EU}.ssm`, endpointType: 'Interface', state: 'available', subnetIds: azs.map((_, i) => `subnet-0prodapp0000${i}01`), routeTableIds: [], networkInterfaceIds: ['eni-0prodssm00000001'], privateDnsEnabled: true },
    { id: 'vpce-0prodecr000001', name: 'ecr-dkr', tags: {}, vpcId: vpc, serviceName: `com.amazonaws.${EU}.ecr.dkr`, endpointType: 'Interface', state: 'available', subnetIds: azs.map((_, i) => `subnet-0prodapp0000${i}01`), routeTableIds: [], networkInterfaceIds: ['eni-0prodecr00000001'], privateDnsEnabled: true },
  );

  // TGW spoke attachment (prod → shared hub).
  r.transitGatewayAttachments.push({
    id: ATT.prod,
    name: 'prod-vpc-attach',
    tags: {},
    transitGatewayId: TGW_EU,
    transitGatewayOwnerId: ACCT.shared,
    resourceOwnerId: ACCT.prod,
    resourceType: 'vpc',
    resourceId: vpc,
    state: 'available',
    subnetIds: azs.map((_, i) => `subnet-0prodapp0000${i}01`),
  });

  // Direct peering prod <-> dev, and prod <-> legacy (ghost).
  r.peeringConnections.push(
    {
      id: 'pcx-0proddev000000001',
      name: 'prod-to-dev',
      tags: {},
      requester: { vpcId: vpc, accountId: ACCT.prod, region: EU, cidrBlocks: ['10.0.0.0/16'] },
      accepter: { vpcId: 'vpc-0dev000000000000a1', accountId: ACCT.dev, region: EU, cidrBlocks: ['10.2.0.0/16'] },
      status: 'active',
    },
    {
      id: 'pcx-0prodlegacy0000001',
      name: 'prod-to-legacy',
      tags: {},
      requester: { vpcId: vpc, accountId: ACCT.prod, region: EU, cidrBlocks: ['10.0.0.0/16'] },
      accepter: { vpcId: 'vpc-0legacy00000000a1', accountId: ACCT.legacy, region: 'eu-central-1', cidrBlocks: ['10.99.0.0/16'] },
      status: 'active',
    },
  );

  r.generic.push(
    { arn: `arn:aws:dynamodb:${EU}:${ACCT.prod}:table/prod-sessions`, service: 'dynamodb', resourceType: 'table', name: 'prod-sessions', tags: { env: 'prod' } },
    { arn: `arn:aws:sqs:${EU}:${ACCT.prod}:prod-jobs`, service: 'sqs', resourceType: '', name: 'prod-jobs', tags: { env: 'prod' } },
    { arn: `arn:aws:secretsmanager:${EU}:${ACCT.prod}:secret:prod/db-abc`, service: 'secretsmanager', resourceType: 'secret', name: 'prod/db', tags: { env: 'prod' } },
  );

  return r;
}

// acme-prod — us-east-1 DR VPC (reached over inter-region TGW peering)
function prodUsEast1(): RegionSnapshot {
  const r = emptyRegionSnapshot(US);
  const vpc = 'vpc-0proddr0000000a1';
  const sg = 'sg-0proddr00000001';
  r.vpcs.push({ id: vpc, name: 'prod-dr-vpc', tags: { Name: 'prod-dr-vpc', env: 'prod', role: 'dr' }, cidrBlocks: ['10.10.0.0/16'], ipv6CidrBlocks: [], isDefault: false, state: 'available' });
  ['a', 'b'].forEach((az, i) =>
    addSubnet(r, vpc, { id: `subnet-0drpriv00000${i}01`, name: `dr-private-${az}`, az: `${US}${az}`, cidr: `10.10.${i}.0/24`, public: false, rtb: 'rtb-0dr00000000000001' }),
  );
  r.routeTables.push({
    id: 'rtb-0dr00000000000001',
    name: 'dr-private',
    tags: {},
    vpcId: vpc,
    isMain: true,
    subnetAssociations: ['subnet-0drpriv0000001', 'subnet-0drpriv0000101'].map((_, i) => `subnet-0drpriv00000${i}01`),
    gatewayAssociations: [],
    routes: [route('local', 'local', '10.10.0.0/16'), route('tgw', TGW_US, '10.0.0.0/8')],
  });
  r.securityGroups.push({ id: sg, name: 'dr-db', tags: {}, vpcId: vpc, description: 'DR db', ingress: [], egress: [] });
  r.rdsInstances.push({
    id: 'prod-aurora-dr-replica',
    arn: `arn:aws:rds:${US}:${ACCT.prod}:db:prod-aurora-dr-replica`,
    name: 'prod-aurora-dr-replica',
    tags: { role: 'dr' },
    engine: 'aurora-postgresql',
    instanceClass: 'db.r6g.large',
    vpcId: vpc,
    subnetGroupName: 'dr-db',
    subnetIds: ['subnet-0drpriv0000001', 'subnet-0drpriv0000101'].map((_, i) => `subnet-0drpriv00000${i}01`),
    securityGroupIds: [sg],
    multiAz: false,
    publiclyAccessible: false,
    availabilityZone: `${US}a`,
  });
  // us-east-1 TGW + its attachment for the DR VPC, and the eu<->us peering.
  r.transitGateways.push({ id: TGW_US, name: 'core-tgw-us', tags: { Name: 'core-tgw-us' }, ownerId: ACCT.shared, state: 'available', description: 'US regional transit gateway', amazonSideAsn: 64513 });
  r.transitGatewayAttachments.push(
    { id: 'tgw-attach-0dr000000000001', name: 'dr-vpc-attach', tags: {}, transitGatewayId: TGW_US, transitGatewayOwnerId: ACCT.shared, resourceOwnerId: ACCT.prod, resourceType: 'vpc', resourceId: vpc, state: 'available', subnetIds: ['subnet-0drpriv0000001', 'subnet-0drpriv0000101'].map((_, i) => `subnet-0drpriv00000${i}01`) },
    { id: ATT.peer, name: 'eu-us-tgw-peering', tags: {}, transitGatewayId: TGW_US, transitGatewayOwnerId: ACCT.shared, resourceOwnerId: ACCT.shared, resourceType: 'tgw-peering', state: 'available', subnetIds: [], peer: { transitGatewayId: TGW_EU, accountId: ACCT.shared, region: EU } },
  );
  r.generic.push({ arn: `arn:aws:s3:::acme-prod-dr-backups`, service: 's3', resourceType: '', name: 'acme-prod-dr-backups', tags: { role: 'dr' } });
  return r;
}

function prodAccount(): AccountSnapshot {
  return {
    accountId: ACCT.prod,
    alias: 'acme-prod',
    profile: 'fixture-prod',
    scannedAt: '2026-07-06T09:15:00.000Z',
    scannerVersion: '0.1.0',
    regions: [prodEuWest1(), prodUsEast1()],
    emptyRegions: ['ap-south-1', 'ap-southeast-2', 'sa-east-1', 'us-west-2'],
    global: {
      hostedZones: [
        { id: 'Z0PRODPRIV0001', name: 'prod.internal.', tags: {}, zoneName: 'prod.internal.', privateZone: true, recordCount: 128, vpcAssociations: [{ vpcId: 'vpc-0prod00000000000a1', region: EU }, { vpcId: 'vpc-0proddr0000000a1', region: US }] },
      ],
      directConnectGateways: [],
      s3Buckets: [{ id: 'acme-prod-artifacts', name: 'acme-prod-artifacts', tags: {}, region: EU, creationDate: '2024-03-01T00:00:00.000Z' }],
      errors: [],
    },
  };
}

// ---------------------------------------------------------------------------
// acme-shared — the network hub (owns the TGW, VPN and Direct Connect)
// ---------------------------------------------------------------------------

function sharedAccount(): AccountSnapshot {
  const r = emptyRegionSnapshot(EU);
  const vpc = 'vpc-0shared00000000a1';
  const sg = 'sg-0shared0000001';

  r.vpcs.push({ id: vpc, name: 'shared-services', tags: { Name: 'shared-services' }, cidrBlocks: ['10.1.0.0/16'], ipv6CidrBlocks: [], isDefault: false, state: 'available' });
  ['a', 'b'].forEach((az, i) =>
    addSubnet(r, vpc, { id: `subnet-0shr0000000${i}01`, name: `shared-${az}`, az: `${EU}${az}`, cidr: `10.1.${i}.0/24`, public: false, rtb: 'rtb-0shared00000001' }),
  );
  r.routeTables.push({
    id: 'rtb-0shared00000001',
    name: 'shared-main',
    tags: {},
    vpcId: vpc,
    isMain: true,
    subnetAssociations: ['subnet-0shr0000000001', 'subnet-0shr0000000101'].map((_, i) => `subnet-0shr0000000${i}01`),
    gatewayAssociations: [],
    routes: [route('local', 'local', '10.1.0.0/16'), route('tgw', TGW_EU, '10.0.0.0/8'), route('tgw', TGW_EU, '172.16.0.0/12')],
  });
  r.securityGroups.push({ id: sg, name: 'shared-core', tags: {}, vpcId: vpc, description: 'shared services', ingress: [{ protocol: 'tcp', fromPort: 53, toPort: 53, cidrs: ['10.0.0.0/8'], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [], description: 'DNS from all spokes' }], egress: [{ protocol: '-1', cidrs: ['0.0.0.0/0'], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [] }] });
  ['a', 'b'].forEach((az, i) =>
    addInstance(r, { id: `i-0shareddns000${i}01`, name: `dns-resolver-${az}`, vpcId: vpc, subnetId: `subnet-0shr0000000${i}01`, az: `${EU}${az}`, ip: `10.1.${i}.10`, sg, type: 't4g.medium', role: 'dns' }),
  );
  r.vpcEndpoints.push({ id: 'vpce-0shrssm0000001', name: 'ssm', tags: {}, vpcId: vpc, serviceName: `com.amazonaws.${EU}.ssm`, endpointType: 'Interface', state: 'available', subnetIds: ['subnet-0shr0000000001', 'subnet-0shr0000000101'].map((_, i) => `subnet-0shr0000000${i}01`), routeTableIds: [], networkInterfaceIds: ['eni-0shrssm000000001'], privateDnsEnabled: true });

  // The TGW hub + its route table (this account owns it).
  r.transitGateways.push({ id: TGW_EU, name: 'core-tgw', tags: { Name: 'core-tgw' }, ownerId: ACCT.shared, state: 'available', description: 'org-wide transit gateway hub', amazonSideAsn: 64512, associationDefaultRouteTableId: TGW_RTB_EU, propagationDefaultRouteTableId: TGW_RTB_EU });
  r.transitGatewayAttachments.push(
    { id: ATT.sharedVpc, name: 'shared-vpc-attach', tags: {}, transitGatewayId: TGW_EU, transitGatewayOwnerId: ACCT.shared, resourceOwnerId: ACCT.shared, resourceType: 'vpc', resourceId: vpc, state: 'available', subnetIds: ['subnet-0shr0000000001', 'subnet-0shr0000000101'].map((_, i) => `subnet-0shr0000000${i}01`) },
    { id: ATT.prod, name: 'prod-vpc-attach', tags: {}, transitGatewayId: TGW_EU, transitGatewayOwnerId: ACCT.shared, resourceOwnerId: ACCT.prod, resourceType: 'vpc', resourceId: 'vpc-0prod00000000000a1', state: 'available', subnetIds: [] },
    { id: ATT.dev, name: 'dev-vpc-attach', tags: {}, transitGatewayId: TGW_EU, transitGatewayOwnerId: ACCT.shared, resourceOwnerId: ACCT.dev, resourceType: 'vpc', resourceId: 'vpc-0dev000000000000a1', state: 'available', subnetIds: [] },
    { id: ATT.vpn, name: 'onprem-vpn-attach', tags: {}, transitGatewayId: TGW_EU, transitGatewayOwnerId: ACCT.shared, resourceOwnerId: ACCT.shared, resourceType: 'vpn', resourceId: 'vpn-0onprem00000001', state: 'available', subnetIds: [] },
    { id: ATT.dx, name: 'dx-attach', tags: {}, transitGatewayId: TGW_EU, transitGatewayOwnerId: ACCT.shared, resourceOwnerId: ACCT.shared, resourceType: 'direct-connect-gateway', resourceId: DXGW, state: 'available', subnetIds: [] },
    { id: ATT.peer, name: 'eu-us-tgw-peering', tags: {}, transitGatewayId: TGW_EU, transitGatewayOwnerId: ACCT.shared, resourceOwnerId: ACCT.shared, resourceType: 'tgw-peering', state: 'available', subnetIds: [], peer: { transitGatewayId: TGW_US, accountId: ACCT.shared, region: US } },
  );
  r.transitGatewayRouteTables.push({
    id: TGW_RTB_EU,
    name: 'core-routes',
    tags: {},
    transitGatewayId: TGW_EU,
    isDefaultAssociation: true,
    isDefaultPropagation: true,
    routes: [
      { destinationCidr: '10.0.0.0/16', attachmentIds: [ATT.prod], resourceIds: ['vpc-0prod00000000000a1'], resourceType: 'vpc', routeType: 'propagated', state: 'active' },
      { destinationCidr: '10.1.0.0/16', attachmentIds: [ATT.sharedVpc], resourceIds: ['vpc-0shared00000000a1'], resourceType: 'vpc', routeType: 'propagated', state: 'active' },
      { destinationCidr: '10.2.0.0/16', attachmentIds: [ATT.dev], resourceIds: ['vpc-0dev000000000000a1'], resourceType: 'vpc', routeType: 'propagated', state: 'active' },
      { destinationCidr: '10.10.0.0/16', attachmentIds: [ATT.peer], resourceIds: [TGW_US], resourceType: 'tgw-peering', routeType: 'static', state: 'active' },
      { destinationCidr: '172.16.0.0/12', attachmentIds: [ATT.vpn], resourceIds: ['vpn-0onprem00000001'], resourceType: 'vpn', routeType: 'static', state: 'active' },
    ],
    associations: [
      { attachmentId: ATT.prod, resourceId: 'vpc-0prod00000000000a1', resourceType: 'vpc' },
      { attachmentId: ATT.dev, resourceId: 'vpc-0dev000000000000a1', resourceType: 'vpc' },
      { attachmentId: ATT.sharedVpc, resourceId: 'vpc-0shared00000000a1', resourceType: 'vpc' },
    ],
  });

  // Site-to-Site VPN + customer gateway (on-prem), TGW-attached.
  r.customerGateways.push({ id: CGW, name: 'hq-firewall', tags: {}, ipAddress: '198.51.100.7', bgpAsn: '65001', state: 'available' });
  r.vpnConnections.push({ id: 'vpn-0onprem00000001', name: 'hq-vpn', tags: {}, transitGatewayId: TGW_EU, customerGatewayId: CGW, state: 'available', category: 'VPN', tunnels: [{ outsideIp: '203.0.113.1', status: 'UP' }, { outsideIp: '203.0.113.2', status: 'UP' }] });

  r.peeringConnections.push({
    id: 'pcx-0proddev000000001',
    name: 'prod-to-dev',
    tags: {},
    requester: { vpcId: 'vpc-0prod00000000000a1', accountId: ACCT.prod, region: EU, cidrBlocks: ['10.0.0.0/16'] },
    accepter: { vpcId: 'vpc-0dev000000000000a1', accountId: ACCT.dev, region: EU, cidrBlocks: ['10.2.0.0/16'] },
    status: 'active',
  });

  r.generic.push({ arn: `arn:aws:route53resolver:${EU}:${ACCT.shared}:resolver-endpoint/rslvr-in-abc`, service: 'route53resolver', resourceType: 'resolver-endpoint', name: 'shared-inbound', tags: {} });

  return {
    accountId: ACCT.shared,
    alias: 'acme-shared',
    profile: 'fixture-shared',
    scannedAt: '2026-07-06T09:16:00.000Z',
    scannerVersion: '0.1.0',
    regions: [r],
    emptyRegions: ['us-east-1', 'ap-south-1'],
    global: {
      hostedZones: [],
      directConnectGateways: [
        { id: DXGW, name: 'corp-dxgw', tags: {}, ownerAccount: ACCT.shared, amazonSideAsn: 64512, state: 'available', associations: [{ associatedGatewayId: TGW_EU, associatedGatewayType: 'transitGateway', associatedGatewayOwnerAccount: ACCT.shared, associatedGatewayRegion: EU, state: 'associated' }] },
      ],
      s3Buckets: [],
      errors: [],
    },
  };
}

// ---------------------------------------------------------------------------
// acme-dev — a spoke VPC, TGW-attached and directly peered to prod
// ---------------------------------------------------------------------------

function devAccount(): AccountSnapshot {
  const r = emptyRegionSnapshot(EU);
  const vpc = 'vpc-0dev000000000000a1';
  const sg = 'sg-0dev0000000001';

  r.vpcs.push({ id: vpc, name: 'dev-vpc', tags: { Name: 'dev-vpc', env: 'dev' }, cidrBlocks: ['10.2.0.0/16'], ipv6CidrBlocks: [], isDefault: false, state: 'available' });
  addSubnet(r, vpc, { id: 'subnet-0devpub00000001', name: 'dev-public-a', az: `${EU}a`, cidr: '10.2.0.0/24', public: true, rtb: 'rtb-0devpublic00001' });
  ['a', 'b'].forEach((az, i) =>
    addSubnet(r, vpc, { id: `subnet-0devpriv0000${i}01`, name: `dev-private-${az}`, az: `${EU}${az}`, cidr: `10.2.1${i}.0/24`, public: false, rtb: 'rtb-0devprivate0001' }),
  );
  r.internetGateways.push({ id: 'igw-0dev0000000000001', name: 'dev-igw', tags: {}, vpcIds: [vpc] });
  r.natGateways.push({ id: 'nat-0dev00000000001', name: 'dev-nat', tags: {}, vpcId: vpc, subnetId: 'subnet-0devpub00000001', connectivityType: 'public', state: 'available', addresses: [{ publicIp: '198.51.100.50', privateIp: '10.2.0.10' }] });
  r.routeTables.push(
    { id: 'rtb-0devpublic00001', name: 'dev-public', tags: {}, vpcId: vpc, isMain: false, subnetAssociations: ['subnet-0devpub00000001'], gatewayAssociations: [], routes: [route('local', 'local', '10.2.0.0/16'), route('igw', 'igw-0dev0000000000001', '0.0.0.0/0')] },
    {
      id: 'rtb-0devprivate0001',
      name: 'dev-private',
      tags: {},
      vpcId: vpc,
      isMain: true,
      subnetAssociations: ['subnet-0devpriv0000001', 'subnet-0devpriv0000101'].map((_, i) => `subnet-0devpriv0000${i}01`),
      gatewayAssociations: [],
      routes: [route('local', 'local', '10.2.0.0/16'), route('nat', 'nat-0dev00000000001', '0.0.0.0/0'), route('pcx', 'pcx-0proddev000000001', '10.0.0.0/16'), route('tgw', TGW_EU, '10.1.0.0/16'), route('tgw', TGW_EU, '172.16.0.0/12')],
    },
  );
  r.securityGroups.push({ id: sg, name: 'dev-app', tags: {}, vpcId: vpc, description: 'dev', ingress: [], egress: [{ protocol: '-1', cidrs: ['0.0.0.0/0'], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [] }] });
  ['a', 'b'].forEach((az, i) =>
    addInstance(r, { id: `i-0devapp00000${i}01`, name: `dev-app-${az}`, vpcId: vpc, subnetId: `subnet-0devpriv0000${i}01`, az: `${EU}${az}`, ip: `10.2.1${i}.20`, sg, type: 't4g.small' }),
  );
  r.rdsInstances.push({ id: 'dev-postgres', arn: `arn:aws:rds:${EU}:${ACCT.dev}:db:dev-postgres`, name: 'dev-postgres', tags: { env: 'dev' }, engine: 'postgres', engineVersion: '16.4', instanceClass: 'db.t4g.medium', vpcId: vpc, subnetGroupName: 'dev-db', subnetIds: ['subnet-0devpriv0000001', 'subnet-0devpriv0000101'].map((_, i) => `subnet-0devpriv0000${i}01`), securityGroupIds: [sg], endpoint: { address: 'dev-postgres.abc.eu-west-1.rds.amazonaws.com', port: 5432 }, multiAz: false, publiclyAccessible: false, availabilityZone: `${EU}a` });

  r.transitGatewayAttachments.push({ id: ATT.dev, name: 'dev-vpc-attach', tags: {}, transitGatewayId: TGW_EU, transitGatewayOwnerId: ACCT.shared, resourceOwnerId: ACCT.dev, resourceType: 'vpc', resourceId: vpc, state: 'available', subnetIds: ['subnet-0devpriv0000001', 'subnet-0devpriv0000101'].map((_, i) => `subnet-0devpriv0000${i}01`) });
  r.peeringConnections.push({
    id: 'pcx-0proddev000000001',
    name: 'prod-to-dev',
    tags: {},
    requester: { vpcId: 'vpc-0prod00000000000a1', accountId: ACCT.prod, region: EU, cidrBlocks: ['10.0.0.0/16'] },
    accepter: { vpcId: vpc, accountId: ACCT.dev, region: EU, cidrBlocks: ['10.2.0.0/16'] },
    status: 'active',
  });
  r.generic.push({ arn: `arn:aws:dynamodb:${EU}:${ACCT.dev}:table/dev-scratch`, service: 'dynamodb', resourceType: 'table', name: 'dev-scratch', tags: { env: 'dev' } });

  return {
    accountId: ACCT.dev,
    alias: 'acme-dev',
    profile: 'fixture-dev',
    scannedAt: '2026-07-06T09:17:00.000Z',
    scannerVersion: '0.1.0',
    regions: [r],
    emptyRegions: [],
    global: { hostedZones: [], directConnectGateways: [], s3Buckets: [{ id: 'acme-dev-sandbox', name: 'acme-dev-sandbox', tags: { env: 'dev' }, region: EU }], errors: [] },
  };
}

// ---------------------------------------------------------------------------
// Assemble + annotations
// ---------------------------------------------------------------------------

const snapshot: Snapshot = {
  version: SNAPSHOT_VERSION,
  generatedAt: '2026-07-06T09:20:00.000Z',
  accounts: [prodAccount(), sharedAccount(), devAccount()],
};

const annotations: AnnotationMap = {
  'vpc-0prod00000000000a1': {
    title: 'Production VPC',
    description: '**Core prod network** (eu-west-1). Hub-and-spoke via `core-tgw`; directly peered to dev for the shared cache.\n\n- On-prem reachable via VPN + Direct Connect through shared-services\n- DR replica in us-east-1 over inter-region TGW peering',
    links: [
      { label: 'Terraform', url: 'https://github.com/acme/infra/blob/main/network/prod-vpc.tf' },
      { label: 'Runbook', url: 'https://wiki.acme.example/prod-vpc' },
    ],
    labels: ['prod', 'networking', 'tier-0'],
  },
  [TGW_EU]: {
    title: 'core-tgw — the network hub',
    description: 'All inter-VPC and on-prem traffic transits here. Owned by **acme-shared**. Peered to `core-tgw-us` for the DR region.',
    links: [{ label: 'Terraform', url: 'https://github.com/acme/infra/blob/main/network/tgw.tf' }],
    labels: ['networking', 'shared'],
  },
  'arn:aws:rds:eu-west-1:111111111111:cluster:prod-aurora': {
    description: 'Primary OLTP store (Aurora PostgreSQL, multi-AZ). Cross-region read replica in us-east-1. Failover drill quarterly.',
    labels: ['tier-0', 'stateful'],
  },
  'pcx-0proddev000000001': {
    description: 'Dev reads the prod product catalog directly over this peer (read-only). Do **not** widen the security groups.',
    labels: ['review-me'],
  },
};

const outDir = path.resolve(import.meta.dirname, '../../../site/data');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'data.js'), jsonScriptPayload('__ATLAS_DATA__', snapshot), 'utf8');
await writeFile(path.join(outDir, 'annotations.js'), jsonScriptPayload('__ATLAS_ANNOTATIONS__', annotations), 'utf8');

const counts = snapshot.accounts.map((a) => `${a.alias}: ${a.regions.reduce((n, reg) => n + reg.vpcs.length, 0)} VPC(s)`);
console.log(`Fixture written to ${outDir}`);
console.log(`  ${snapshot.accounts.length} accounts — ${counts.join(', ')}`);
console.log('  TGW hub-and-spoke, VPC peering, VPN, Direct Connect, inter-region TGW peering, 1 ghost account.');
