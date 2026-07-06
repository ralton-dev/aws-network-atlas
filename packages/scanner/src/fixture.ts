#!/usr/bin/env tsx
/**
 * DEV FIXTURE — writes a synthetic two-account snapshot to site/data/ so the
 * viewer can be exercised without AWS credentials. Never touches
 * data/accounts/ (the committable real snapshots).
 *
 *   npx tsx src/fixture.ts        # from packages/scanner
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SNAPSHOT_VERSION,
  emptyRegionSnapshot,
  type AccountSnapshot,
  type AnnotationMap,
  type Snapshot,
} from '@atlas/schema';
import { jsonScriptPayload } from './bundle.js';

const REGION = 'eu-west-1';

function prodAccount(): AccountSnapshot {
  const r = emptyRegionSnapshot(REGION);

  r.vpcs.push({
    id: 'vpc-0prod0000000000001',
    name: 'prod-vpc',
    tags: { Name: 'prod-vpc', env: 'prod' },
    cidrBlocks: ['10.0.0.0/16'],
    ipv6CidrBlocks: [],
    isDefault: false,
    state: 'available',
  });

  const subnets = [
    { id: 'subnet-0pub00000000000a1', name: 'prod-public-a', az: 'eu-west-1a', cidr: '10.0.0.0/24', pub: true },
    { id: 'subnet-0pub00000000000b1', name: 'prod-public-b', az: 'eu-west-1b', cidr: '10.0.1.0/24', pub: true },
    { id: 'subnet-0priv0000000000a1', name: 'prod-private-a', az: 'eu-west-1a', cidr: '10.0.10.0/24', pub: false },
    { id: 'subnet-0priv0000000000b1', name: 'prod-private-b', az: 'eu-west-1b', cidr: '10.0.11.0/24', pub: false },
  ];
  for (const s of subnets) {
    r.subnets.push({
      id: s.id,
      name: s.name,
      tags: { Name: s.name },
      vpcId: 'vpc-0prod0000000000001',
      cidrBlock: s.cidr,
      ipv6CidrBlocks: [],
      availabilityZone: s.az,
      mapPublicIpOnLaunch: s.pub,
      routeTableId: s.pub ? 'rtb-0public0000000001' : `rtb-0private000000000${s.az.endsWith('a') ? 'a' : 'b'}`,
      isPublic: s.pub,
    });
  }

  r.internetGateways.push({
    id: 'igw-0prod0000000000001',
    name: 'prod-igw',
    tags: {},
    vpcIds: ['vpc-0prod0000000000001'],
  });

  r.natGateways.push(
    {
      id: 'nat-0prod00000000000a1',
      name: 'prod-nat-a',
      tags: {},
      vpcId: 'vpc-0prod0000000000001',
      subnetId: 'subnet-0pub00000000000a1',
      connectivityType: 'public',
      state: 'available',
      addresses: [{ publicIp: '52.31.10.11', privateIp: '10.0.0.11' }],
    },
    {
      id: 'nat-0prod00000000000b1',
      name: 'prod-nat-b',
      tags: {},
      vpcId: 'vpc-0prod0000000000001',
      subnetId: 'subnet-0pub00000000000b1',
      connectivityType: 'public',
      state: 'available',
      addresses: [{ publicIp: '52.31.10.12', privateIp: '10.0.1.11' }],
    },
  );

  r.routeTables.push(
    {
      id: 'rtb-0public0000000001',
      name: 'prod-public',
      tags: {},
      vpcId: 'vpc-0prod0000000000001',
      isMain: false,
      subnetAssociations: ['subnet-0pub00000000000a1', 'subnet-0pub00000000000b1'],
      gatewayAssociations: [],
      routes: [
        { targetType: 'local', targetId: 'local', destinationCidr: '10.0.0.0/16', state: 'active' },
        { targetType: 'igw', targetId: 'igw-0prod0000000000001', destinationCidr: '0.0.0.0/0', state: 'active' },
      ],
    },
    {
      id: 'rtb-0private000000000a',
      name: 'prod-private-a',
      tags: {},
      vpcId: 'vpc-0prod0000000000001',
      isMain: false,
      subnetAssociations: ['subnet-0priv0000000000a1'],
      gatewayAssociations: [],
      routes: [
        { targetType: 'local', targetId: 'local', destinationCidr: '10.0.0.0/16', state: 'active' },
        { targetType: 'nat', targetId: 'nat-0prod00000000000a1', destinationCidr: '0.0.0.0/0', state: 'active' },
        { targetType: 'pcx', targetId: 'pcx-0prodshared000001', destinationCidr: '10.1.0.0/16', state: 'active' },
        { targetType: 'tgw', targetId: 'tgw-0shared0000000001', destinationCidr: '172.16.0.0/12', state: 'active' },
        { targetType: 'pcx', targetId: 'pcx-0prodghost0000001', destinationCidr: '10.99.0.0/16', state: 'active' },
      ],
    },
    {
      id: 'rtb-0private000000000b',
      name: 'prod-private-b',
      tags: {},
      vpcId: 'vpc-0prod0000000000001',
      isMain: false,
      subnetAssociations: ['subnet-0priv0000000000b1'],
      gatewayAssociations: [],
      routes: [
        { targetType: 'local', targetId: 'local', destinationCidr: '10.0.0.0/16', state: 'active' },
        { targetType: 'nat', targetId: 'nat-0prod00000000000b1', destinationCidr: '0.0.0.0/0', state: 'active' },
        { targetType: 'pcx', targetId: 'pcx-0prodshared000001', destinationCidr: '10.1.0.0/16', state: 'active' },
        { targetType: 'tgw', targetId: 'tgw-0shared0000000001', destinationCidr: '172.16.0.0/12', state: 'active' },
        { targetType: 'vpce', targetId: 'vpce-0s3gateway000001', destinationPrefixListId: 'pl-6da54004', state: 'active' },
      ],
    },
  );

  for (let i = 0; i < 5; i++) {
    const subnet = subnets[i % 2 === 0 ? 2 : 3]!;
    r.instances.push({
      id: `i-0prodapp000000000${i}1`,
      name: `prod-app-${i + 1}`,
      tags: { Name: `prod-app-${i + 1}`, env: 'prod' },
      instanceType: 'm7g.large',
      state: 'running',
      vpcId: 'vpc-0prod0000000000001',
      subnetId: subnet.id,
      availabilityZone: subnet.az,
      privateIp: `10.0.1${i % 2 === 0 ? 0 : 1}.${20 + i}`,
      securityGroupIds: ['sg-0prodapp0000000001'],
    });
  }

  r.securityGroups.push({
    id: 'sg-0prodapp0000000001',
    name: 'prod-app',
    tags: {},
    vpcId: 'vpc-0prod0000000000001',
    description: 'prod app instances',
    ingress: [
      {
        protocol: 'tcp', fromPort: 8080, toPort: 8080,
        cidrs: [], ipv6Cidrs: [], prefixListIds: [],
        securityGroupRefs: [{ groupId: 'sg-0prodalb0000000001' }],
        description: 'from ALB',
      },
    ],
    egress: [
      { protocol: '-1', cidrs: ['0.0.0.0/0'], ipv6Cidrs: [], prefixListIds: [], securityGroupRefs: [] },
    ],
  });

  r.loadBalancers.push({
    id: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/app/prod-alb/abc123',
    arn: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/app/prod-alb/abc123',
    name: 'prod-alb',
    tags: { env: 'prod' },
    lbType: 'application',
    scheme: 'internet-facing',
    vpcId: 'vpc-0prod0000000000001',
    subnetIds: ['subnet-0pub00000000000a1', 'subnet-0pub00000000000b1'],
    availabilityZones: ['eu-west-1a', 'eu-west-1b'],
    securityGroupIds: ['sg-0prodalb0000000001'],
    dnsName: 'prod-alb-123.eu-west-1.elb.amazonaws.com',
    state: 'active',
    listeners: [{ port: 443, protocol: 'HTTPS', targetGroupArns: ['arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/prod-app/def456'] }],
  });
  r.targetGroups.push({
    id: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/prod-app/def456',
    arn: 'arn:aws:elasticloadbalancing:eu-west-1:111111111111:targetgroup/prod-app/def456',
    name: 'prod-app',
    tags: {},
    protocol: 'HTTP',
    port: 8080,
    vpcId: 'vpc-0prod0000000000001',
    targetType: 'instance',
    loadBalancerArns: ['arn:aws:elasticloadbalancing:eu-west-1:111111111111:loadbalancer/app/prod-alb/abc123'],
    targets: [
      { targetId: 'i-0prodapp0000000001', port: 8080, health: 'healthy' },
      { targetId: 'i-0prodapp0000000011', port: 8080, health: 'healthy' },
    ],
  });

  r.rdsInstances.push({
    id: 'prod-postgres',
    arn: 'arn:aws:rds:eu-west-1:111111111111:db:prod-postgres',
    name: 'prod-postgres',
    tags: { env: 'prod' },
    engine: 'postgres',
    engineVersion: '16.4',
    instanceClass: 'db.r6g.large',
    vpcId: 'vpc-0prod0000000000001',
    subnetGroupName: 'prod-db',
    subnetIds: ['subnet-0priv0000000000a1', 'subnet-0priv0000000000b1'],
    securityGroupIds: ['sg-0prodapp0000000001'],
    endpoint: { address: 'prod-postgres.abc.eu-west-1.rds.amazonaws.com', port: 5432 },
    multiAz: true,
    publiclyAccessible: false,
    availabilityZone: 'eu-west-1a',
  });

  r.lambdaFunctions.push({
    id: 'arn:aws:lambda:eu-west-1:111111111111:function:prod-worker',
    arn: 'arn:aws:lambda:eu-west-1:111111111111:function:prod-worker',
    name: 'prod-worker',
    tags: {},
    runtime: 'nodejs22.x',
    vpcConfig: {
      vpcId: 'vpc-0prod0000000000001',
      subnetIds: ['subnet-0priv0000000000a1', 'subnet-0priv0000000000b1'],
      securityGroupIds: ['sg-0prodapp0000000001'],
    },
  });

  r.vpcEndpoints.push(
    {
      id: 'vpce-0s3gateway000001',
      name: 's3-gateway',
      tags: {},
      vpcId: 'vpc-0prod0000000000001',
      serviceName: 'com.amazonaws.eu-west-1.s3',
      endpointType: 'Gateway',
      state: 'available',
      subnetIds: [],
      routeTableIds: ['rtb-0private000000000b'],
      networkInterfaceIds: [],
    },
    {
      id: 'vpce-0ssm000000000001',
      name: 'ssm',
      tags: {},
      vpcId: 'vpc-0prod0000000000001',
      serviceName: 'com.amazonaws.eu-west-1.ssm',
      endpointType: 'Interface',
      state: 'available',
      subnetIds: ['subnet-0priv0000000000a1', 'subnet-0priv0000000000b1'],
      routeTableIds: [],
      networkInterfaceIds: ['eni-0ssm0000000000001'],
      privateDnsEnabled: true,
    },
  );

  // Cross-account TGW shared from this (owner) account.
  r.transitGateways.push({
    id: 'tgw-0shared0000000001',
    name: 'core-tgw',
    tags: { Name: 'core-tgw' },
    ownerId: '111111111111',
    state: 'available',
    description: 'org-wide transit gateway',
    amazonSideAsn: 64512,
  });
  r.transitGatewayAttachments.push(
    {
      id: 'tgw-attach-0prod00001',
      name: 'prod-vpc-attachment',
      tags: {},
      transitGatewayId: 'tgw-0shared0000000001',
      transitGatewayOwnerId: '111111111111',
      resourceOwnerId: '111111111111',
      resourceType: 'vpc',
      resourceId: 'vpc-0prod0000000000001',
      state: 'available',
      subnetIds: ['subnet-0priv0000000000a1', 'subnet-0priv0000000000b1'],
    },
    {
      id: 'tgw-attach-0shared001',
      name: 'shared-vpc-attachment',
      tags: {},
      transitGatewayId: 'tgw-0shared0000000001',
      transitGatewayOwnerId: '111111111111',
      resourceOwnerId: '222222222222',
      resourceType: 'vpc',
      resourceId: 'vpc-0shared0000000001',
      state: 'available',
      subnetIds: [],
    },
    {
      id: 'tgw-attach-0vpn000001',
      name: 'onprem-vpn',
      tags: {},
      transitGatewayId: 'tgw-0shared0000000001',
      transitGatewayOwnerId: '111111111111',
      resourceOwnerId: '111111111111',
      resourceType: 'vpn',
      resourceId: 'vpn-0onprem0000000001',
      state: 'available',
      subnetIds: [],
    },
  );
  r.transitGatewayRouteTables.push({
    id: 'tgw-rtb-0core00000001',
    name: 'core-routes',
    tags: {},
    transitGatewayId: 'tgw-0shared0000000001',
    isDefaultAssociation: true,
    isDefaultPropagation: true,
    routes: [
      { destinationCidr: '10.0.0.0/16', attachmentIds: ['tgw-attach-0prod00001'], resourceIds: ['vpc-0prod0000000000001'], resourceType: 'vpc', routeType: 'propagated', state: 'active' },
      { destinationCidr: '10.1.0.0/16', attachmentIds: ['tgw-attach-0shared001'], resourceIds: ['vpc-0shared0000000001'], resourceType: 'vpc', routeType: 'propagated', state: 'active' },
      { destinationCidr: '172.16.0.0/12', attachmentIds: ['tgw-attach-0vpn000001'], resourceIds: ['vpn-0onprem0000000001'], resourceType: 'vpn', routeType: 'static', state: 'active' },
    ],
    associations: [
      { attachmentId: 'tgw-attach-0prod00001', resourceId: 'vpc-0prod0000000000001', resourceType: 'vpc' },
      { attachmentId: 'tgw-attach-0shared001', resourceId: 'vpc-0shared0000000001', resourceType: 'vpc' },
    ],
  });

  r.customerGateways.push({
    id: 'cgw-0onprem0000000001',
    name: 'hq-firewall',
    tags: {},
    ipAddress: '198.51.100.7',
    bgpAsn: '65001',
    state: 'available',
  });
  r.vpnConnections.push({
    id: 'vpn-0onprem0000000001',
    name: 'hq-vpn',
    tags: {},
    transitGatewayId: 'tgw-0shared0000000001',
    customerGatewayId: 'cgw-0onprem0000000001',
    state: 'available',
    category: 'VPN',
    tunnels: [
      { outsideIp: '52.31.99.1', status: 'UP' },
      { outsideIp: '52.31.99.2', status: 'UP' },
    ],
  });

  // Peering to the scanned shared account + to an unscanned ghost account.
  r.peeringConnections.push(
    {
      id: 'pcx-0prodshared000001',
      name: 'prod-to-shared',
      tags: {},
      requester: { vpcId: 'vpc-0prod0000000000001', accountId: '111111111111', region: REGION, cidrBlocks: ['10.0.0.0/16'] },
      accepter: { vpcId: 'vpc-0shared0000000001', accountId: '222222222222', region: REGION, cidrBlocks: ['10.1.0.0/16'] },
      status: 'active',
    },
    {
      id: 'pcx-0prodghost0000001',
      name: 'prod-to-legacy',
      tags: {},
      requester: { vpcId: 'vpc-0prod0000000000001', accountId: '111111111111', region: REGION, cidrBlocks: ['10.0.0.0/16'] },
      accepter: { vpcId: 'vpc-0legacy000000001', accountId: '333333333333', region: 'eu-central-1', cidrBlocks: ['10.99.0.0/16'] },
      status: 'active',
    },
  );

  r.generic.push(
    {
      arn: 'arn:aws:dynamodb:eu-west-1:111111111111:table/prod-sessions',
      service: 'dynamodb', resourceType: 'table', name: 'prod-sessions',
      tags: { env: 'prod' },
    },
    {
      arn: 'arn:aws:sqs:eu-west-1:111111111111:prod-jobs',
      service: 'sqs', resourceType: '', name: 'prod-jobs',
      tags: { env: 'prod' },
    },
  );

  return {
    accountId: '111111111111',
    alias: 'acme-prod',
    profile: 'fixture-prod',
    scannedAt: '2026-07-06T08:30:00.000Z',
    scannerVersion: '0.1.0',
    regions: [r],
    emptyRegions: ['ap-south-1', 'us-west-2'],
    global: {
      hostedZones: [
        {
          id: 'Z0PRODPRIVATE1', name: 'prod.internal.', tags: {},
          zoneName: 'prod.internal.', privateZone: true, recordCount: 42,
          vpcAssociations: [{ vpcId: 'vpc-0prod0000000000001', region: REGION }],
        },
      ],
      directConnectGateways: [],
      s3Buckets: [
        { id: 'acme-prod-artifacts', name: 'acme-prod-artifacts', tags: {}, region: REGION, creationDate: '2024-03-01T00:00:00.000Z' },
      ],
      errors: [],
    },
  };
}

function sharedAccount(): AccountSnapshot {
  const r = emptyRegionSnapshot(REGION);

  r.vpcs.push({
    id: 'vpc-0shared0000000001',
    name: 'shared-services',
    tags: { Name: 'shared-services' },
    cidrBlocks: ['10.1.0.0/16'],
    ipv6CidrBlocks: [],
    isDefault: false,
    state: 'available',
  });
  r.subnets.push(
    {
      id: 'subnet-0shr00000000000a', name: 'shared-a', tags: {},
      vpcId: 'vpc-0shared0000000001', cidrBlock: '10.1.0.0/24', ipv6CidrBlocks: [],
      availabilityZone: 'eu-west-1a', mapPublicIpOnLaunch: false,
      routeTableId: 'rtb-0shared0000000001', isPublic: false,
    },
    {
      id: 'subnet-0shr00000000000b', name: 'shared-b', tags: {},
      vpcId: 'vpc-0shared0000000001', cidrBlock: '10.1.1.0/24', ipv6CidrBlocks: [],
      availabilityZone: 'eu-west-1b', mapPublicIpOnLaunch: false,
      routeTableId: 'rtb-0shared0000000001', isPublic: false,
    },
  );
  r.routeTables.push({
    id: 'rtb-0shared0000000001',
    name: 'shared-main',
    tags: {},
    vpcId: 'vpc-0shared0000000001',
    isMain: true,
    subnetAssociations: [],
    gatewayAssociations: [],
    routes: [
      { targetType: 'local', targetId: 'local', destinationCidr: '10.1.0.0/16', state: 'active' },
      { targetType: 'pcx', targetId: 'pcx-0prodshared000001', destinationCidr: '10.0.0.0/16', state: 'active' },
      { targetType: 'tgw', targetId: 'tgw-0shared0000000001', destinationCidr: '0.0.0.0/0', state: 'active' },
    ],
  });
  r.instances.push(
    {
      id: 'i-0shared00000000001', name: 'dns-forwarder', tags: { role: 'dns' },
      instanceType: 't4g.small', state: 'running',
      vpcId: 'vpc-0shared0000000001', subnetId: 'subnet-0shr00000000000a',
      availabilityZone: 'eu-west-1a', privateIp: '10.1.0.10', securityGroupIds: [],
    },
  );
  r.elastiCacheClusters.push({
    id: 'shared-redis',
    name: 'shared-redis',
    tags: {},
    engine: 'redis',
    nodeType: 'cache.t4g.medium',
    numNodes: 2,
    vpcId: 'vpc-0shared0000000001',
    subnetGroupName: 'shared-cache',
    subnetIds: ['subnet-0shr00000000000a', 'subnet-0shr00000000000b'],
    securityGroupIds: [],
  });
  // Same peering + TGW attachment as seen from the accepter side (dedupe test).
  r.peeringConnections.push({
    id: 'pcx-0prodshared000001',
    name: 'prod-to-shared',
    tags: {},
    requester: { vpcId: 'vpc-0prod0000000000001', accountId: '111111111111', region: REGION, cidrBlocks: ['10.0.0.0/16'] },
    accepter: { vpcId: 'vpc-0shared0000000001', accountId: '222222222222', region: REGION, cidrBlocks: ['10.1.0.0/16'] },
    status: 'active',
  });
  r.transitGatewayAttachments.push({
    id: 'tgw-attach-0shared001',
    name: 'shared-vpc-attachment',
    tags: {},
    transitGatewayId: 'tgw-0shared0000000001',
    transitGatewayOwnerId: '111111111111',
    resourceOwnerId: '222222222222',
    resourceType: 'vpc',
    resourceId: 'vpc-0shared0000000001',
    state: 'available',
    subnetIds: ['subnet-0shr00000000000a', 'subnet-0shr00000000000b'],
  });

  return {
    accountId: '222222222222',
    alias: 'acme-shared',
    profile: 'fixture-shared',
    scannedAt: '2026-07-06T08:31:00.000Z',
    scannerVersion: '0.1.0',
    regions: [r],
    emptyRegions: [],
    global: { hostedZones: [], directConnectGateways: [], s3Buckets: [], errors: [] },
  };
}

const snapshot: Snapshot = {
  version: SNAPSHOT_VERSION,
  generatedAt: '2026-07-06T08:32:00.000Z',
  accounts: [prodAccount(), sharedAccount()],
};

const annotations: AnnotationMap = {
  'vpc-0prod0000000000001': {
    title: 'Production VPC',
    description:
      '**Core prod network.** All workloads live here.\n\n- Peered to `shared-services`\n- On-prem reachable via the core TGW',
    links: [
      { label: 'Terraform', url: 'https://github.com/acme/infra/blob/main/network/prod-vpc.tf' },
      { label: 'Runbook', url: 'https://wiki.acme.example/prod-vpc' },
    ],
    labels: ['prod', 'networking'],
  },
  'arn:aws:rds:eu-west-1:111111111111:db:prod-postgres': {
    description: 'Primary OLTP database. Multi-AZ. Failover drill quarterly.',
    labels: ['tier-0'],
  },
};

const outDir = path.resolve(import.meta.dirname, '../../../site/data');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'data.js'), jsonScriptPayload('__ATLAS_DATA__', snapshot), 'utf8');
await writeFile(path.join(outDir, 'annotations.js'), jsonScriptPayload('__ATLAS_ANNOTATIONS__', annotations), 'utf8');
console.log(`Fixture written to ${outDir} (2 accounts, cross-account TGW/peering, ghost account).`);
