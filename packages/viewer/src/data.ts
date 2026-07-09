import {
  emptyGlobal,
  emptyRegionSnapshot,
  type AccountSnapshot,
  type Annotation,
  type AnnotationMap,
  type RegionSnapshot,
  type Snapshot,
  type TerraformBinding,
  type TerraformStackFile,
} from '@atlas/schema';

/** A uniform handle on any scanned resource, for search/details/navigation. */
export interface ResourceRef {
  kind: string;
  id: string;
  arn?: string;
  name?: string;
  accountId: string;
  region: string; // '' for account-global resources
  /** VPC this resource belongs to, when known (drives drill-down navigation). */
  vpcId?: string;
  raw: Record<string, unknown>;
}

export interface AtlasIndex {
  snapshot: Snapshot;
  annotations: AnnotationMap;
  /** Imported Terraform stacks (tf-import); empty when none imported. */
  terraform: TerraformStackFile[];
  all: ResourceRef[];
  /** Keyed by id AND arn. */
  byKey: Map<string, ResourceRef>;
  accountLabel(accountId: string): string;
  annotationFor(ref: ResourceRef): Annotation | undefined;
  /** Terraform instances claiming this resource (>1 = claimed by several stacks). */
  terraformFor(ref: ResourceRef): TerraformBinding[];
  findRegion(accountId: string, region: string): RegionSnapshot | undefined;
}

const EMPTY_SNAPSHOT: Snapshot = { version: 1, generatedAt: '', accounts: [] };

function pushRegionRefs(all: ResourceRef[], account: AccountSnapshot, region: RegionSnapshot): void {
  const ctx = { accountId: account.accountId, region: region.region };
  // `?? []` throughout: collections added in later scanner versions are absent
  // from older committed snapshots, and the viewer must still load them.
  const add = (kind: string, items: Array<Record<string, unknown>> | undefined, vpcKey = 'vpcId'): void => {
    for (const item of items ?? []) {
      all.push({
        kind,
        id: String(item['id'] ?? ''),
        arn: item['arn'] as string | undefined,
        name: item['name'] as string | undefined,
        vpcId: (item[vpcKey] as string | undefined) ?? undefined,
        raw: item,
        ...ctx,
      });
    }
  };

  add('vpc', region.vpcs as unknown as Array<Record<string, unknown>>, 'id');
  add('subnet', region.subnets as unknown as Array<Record<string, unknown>>);
  add('route-table', region.routeTables as unknown as Array<Record<string, unknown>>);
  add('igw', region.internetGateways as unknown as Array<Record<string, unknown>>);
  add('eigw', region.egressOnlyInternetGateways as unknown as Array<Record<string, unknown>>);
  add('nat', region.natGateways as unknown as Array<Record<string, unknown>>);
  add('eip', region.elasticIps as unknown as Array<Record<string, unknown>>);
  add('nacl', region.networkAcls as unknown as Array<Record<string, unknown>>);
  add('sg', region.securityGroups as unknown as Array<Record<string, unknown>>);
  add('eni', region.networkInterfaces as unknown as Array<Record<string, unknown>>);
  add('vpce', region.vpcEndpoints as unknown as Array<Record<string, unknown>>);
  add('vpce-service', region.vpcEndpointServices as unknown as Array<Record<string, unknown>>);
  add('prefix-list', region.prefixLists as unknown as Array<Record<string, unknown>>);
  add('flow-log', region.flowLogs as unknown as Array<Record<string, unknown>>);
  add('dhcp-options', region.dhcpOptions as unknown as Array<Record<string, unknown>>);
  add('instance-connect-endpoint', region.instanceConnectEndpoints as unknown as Array<Record<string, unknown>>);
  add('pcx', region.peeringConnections as unknown as Array<Record<string, unknown>>);
  add('tgw', region.transitGateways as unknown as Array<Record<string, unknown>>);
  add('tgw-attachment', region.transitGatewayAttachments as unknown as Array<Record<string, unknown>>);
  add('tgw-rt', region.transitGatewayRouteTables as unknown as Array<Record<string, unknown>>);
  add('tgw-connect-peer', region.transitGatewayConnectPeers as unknown as Array<Record<string, unknown>>);
  add('vgw', region.vpnGateways as unknown as Array<Record<string, unknown>>);
  add('cgw', region.customerGateways as unknown as Array<Record<string, unknown>>);
  add('vpn', region.vpnConnections as unknown as Array<Record<string, unknown>>);
  add('dx-connection', region.dxConnections as unknown as Array<Record<string, unknown>>);
  add('dx-lag', region.dxLags as unknown as Array<Record<string, unknown>>);
  add('dx-vif', region.dxVirtualInterfaces as unknown as Array<Record<string, unknown>>);
  add('lb', region.loadBalancers as unknown as Array<Record<string, unknown>>);
  add('tg', region.targetGroups as unknown as Array<Record<string, unknown>>);
  add('instance', region.instances as unknown as Array<Record<string, unknown>>);
  add('asg', region.autoScalingGroups as unknown as Array<Record<string, unknown>>);
  add('lambda', region.lambdaFunctions as unknown as Array<Record<string, unknown>>);
  add('rds', region.rdsInstances as unknown as Array<Record<string, unknown>>);
  add('rds-cluster', region.rdsClusters as unknown as Array<Record<string, unknown>>);
  add('rds-proxy', region.rdsProxies as unknown as Array<Record<string, unknown>>);
  add('ecs', region.ecsServices as unknown as Array<Record<string, unknown>>);
  add('eks', region.eksClusters as unknown as Array<Record<string, unknown>>);
  add('elasticache', region.elastiCacheClusters as unknown as Array<Record<string, unknown>>);
  add('elasticache-replication-group', region.elastiCacheReplicationGroups as unknown as Array<Record<string, unknown>>);
  add('elasticache-serverless', region.elastiCacheServerlessCaches as unknown as Array<Record<string, unknown>>);
  add('efs', region.efsFileSystems as unknown as Array<Record<string, unknown>>);
  add('opensearch', region.openSearchDomains as unknown as Array<Record<string, unknown>>);
  add('msk', region.mskClusters as unknown as Array<Record<string, unknown>>);
  add('redshift', region.redshiftClusters as unknown as Array<Record<string, unknown>>);
  add('mq', region.mqBrokers as unknown as Array<Record<string, unknown>>);
  add('dynamodb-table', region.dynamoDbTables as unknown as Array<Record<string, unknown>>);
  // security services
  add('kms', region.kmsKeys as unknown as Array<Record<string, unknown>>);
  add('acm', region.acmCertificates as unknown as Array<Record<string, unknown>>);
  add('secret', region.secrets as unknown as Array<Record<string, unknown>>);
  add('waf-web-acl', region.wafWebAcls as unknown as Array<Record<string, unknown>>);
  add('waf-ip-set', region.wafIpSets as unknown as Array<Record<string, unknown>>);
  add('waf-rule-group', region.wafRuleGroups as unknown as Array<Record<string, unknown>>);
  // additional network services
  add('resolver-endpoint', region.resolverEndpoints as unknown as Array<Record<string, unknown>>);
  add('resolver-rule', region.resolverRules as unknown as Array<Record<string, unknown>>);
  add('dns-firewall-rule-group', region.dnsFirewallRuleGroups as unknown as Array<Record<string, unknown>>);
  add('resolver-query-log-config', region.resolverQueryLogConfigs as unknown as Array<Record<string, unknown>>);
  add('client-vpn', region.clientVpnEndpoints as unknown as Array<Record<string, unknown>>);
  add('network-firewall', region.networkFirewalls as unknown as Array<Record<string, unknown>>);
  add('network-firewall-policy', region.networkFirewallPolicies as unknown as Array<Record<string, unknown>>);
  add('network-firewall-rule-group', region.networkFirewallRuleGroups as unknown as Array<Record<string, unknown>>);
  add('network-firewall-tls-config', region.networkFirewallTlsConfigs as unknown as Array<Record<string, unknown>>);
  add('apigw', region.apiGateways as unknown as Array<Record<string, unknown>>);
  add('apigw-vpc-link', region.apiGatewayVpcLinks as unknown as Array<Record<string, unknown>>);
  add('apigw-domain', region.apiGatewayDomainNames as unknown as Array<Record<string, unknown>>);
  add('lattice-service-network', region.latticeServiceNetworks as unknown as Array<Record<string, unknown>>);
  add('lattice-service', region.latticeServices as unknown as Array<Record<string, unknown>>);
  add('log-group', region.logGroups as unknown as Array<Record<string, unknown>>);
  // identity services
  add('cognito-user-pool', region.cognitoUserPools as unknown as Array<Record<string, unknown>>);
  add('cognito-identity-pool', region.cognitoIdentityPools as unknown as Array<Record<string, unknown>>);
  // container registry
  add('ecr-repository', region.ecrRepositories as unknown as Array<Record<string, unknown>>);
  add('ecr-registry', region.ecrRegistries as unknown as Array<Record<string, unknown>>);
  // messaging
  add('sns-topic', region.snsTopics as unknown as Array<Record<string, unknown>>);
  add('sqs-queue', region.sqsQueues as unknown as Array<Record<string, unknown>>);
  // eventing
  add('event-bus', region.eventBuses as unknown as Array<Record<string, unknown>>);
  add('eventbridge-pipe', region.eventBridgePipes as unknown as Array<Record<string, unknown>>);
  add('eventbridge-schedule', region.eventBridgeSchedules as unknown as Array<Record<string, unknown>>);
  // orchestration
  add('sfn-state-machine', region.sfnStateMachines as unknown as Array<Record<string, unknown>>);
  // EMR
  add('emr-cluster', region.emrClusters as unknown as Array<Record<string, unknown>>);
  // Batch
  add('batch-compute-environment', region.batchComputeEnvironments as unknown as Array<Record<string, unknown>>);
  add('batch-job-queue', region.batchJobQueues as unknown as Array<Record<string, unknown>>);
  // Neptune + DocumentDB
  add('neptune-cluster', region.neptuneClusters as unknown as Array<Record<string, unknown>>);
  add('docdb-cluster', region.docDbClusters as unknown as Array<Record<string, unknown>>);
  // MemoryDB
  add('memorydb-cluster', region.memoryDbClusters as unknown as Array<Record<string, unknown>>);
  // Transfer Family
  add('transfer-server', region.transferServers as unknown as Array<Record<string, unknown>>);
  // Elastic Beanstalk
  add('beanstalk-environment', region.beanstalkEnvironments as unknown as Array<Record<string, unknown>>);
  // Glue
  add('glue-connection', region.glueConnections as unknown as Array<Record<string, unknown>>);
  add('glue-dev-endpoint', region.glueDevEndpoints as unknown as Array<Record<string, unknown>>);
  add('glue-job', region.glueJobs as unknown as Array<Record<string, unknown>>);
  add('glue-crawler', region.glueCrawlers as unknown as Array<Record<string, unknown>>);
  add('glue-database', region.glueDatabases as unknown as Array<Record<string, unknown>>);
  // DMS
  add('dms-replication-instance', region.dmsReplicationInstances as unknown as Array<Record<string, unknown>>);
  add('dms-endpoint', region.dmsEndpoints as unknown as Array<Record<string, unknown>>);
  add('dms-replication-task', region.dmsReplicationTasks as unknown as Array<Record<string, unknown>>);
  // DataSync
  add('datasync-agent', region.dataSyncAgents as unknown as Array<Record<string, unknown>>);
  add('datasync-location', region.dataSyncLocations as unknown as Array<Record<string, unknown>>);
  add('datasync-task', region.dataSyncTasks as unknown as Array<Record<string, unknown>>);
  // Kinesis Data Firehose
  add('firehose-delivery-stream', region.firehoseDeliveryStreams as unknown as Array<Record<string, unknown>>);
  // AWS Config posture
  add('config-recorder', region.configRecorders as unknown as Array<Record<string, unknown>>);
  add('config-rule', region.configRules as unknown as Array<Record<string, unknown>>);
  add('config-conformance-pack', region.configConformancePacks as unknown as Array<Record<string, unknown>>);
  // CloudTrail posture
  add('cloudtrail-trail', region.cloudTrailTrails as unknown as Array<Record<string, unknown>>);
  add('cloudtrail-event-data-store', region.cloudTrailEventDataStores as unknown as Array<Record<string, unknown>>);
  // GuardDuty posture
  add('guardduty-detector', region.guardDutyDetectors as unknown as Array<Record<string, unknown>>);
  // AWS Backup posture
  add('backup-vault', region.backupVaults as unknown as Array<Record<string, unknown>>);
  add('backup-plan', region.backupPlans as unknown as Array<Record<string, unknown>>);
  // Security posture (Security Hub / Access Analyzer / Inspector / Macie)
  add('securityhub', region.securityHubStatus as unknown as Array<Record<string, unknown>>);
  add('access-analyzer', region.accessAnalyzers as unknown as Array<Record<string, unknown>>);
  add('inspector2', region.inspectorStatus as unknown as Array<Record<string, unknown>>);
  add('macie2', region.macieStatus as unknown as Array<Record<string, unknown>>);

  // Lambda vpcId lives inside vpcConfig.
  for (const ref of all) {
    if (ref.kind === 'lambda' && !ref.vpcId) {
      const cfg = ref.raw['vpcConfig'] as { vpcId?: string } | undefined;
      if (cfg?.vpcId) ref.vpcId = cfg.vpcId;
    }
  }

  for (const g of region.generic ?? []) {
    all.push({
      kind: 'generic',
      id: g.arn,
      arn: g.arn,
      name: g.name,
      raw: g as unknown as Record<string, unknown>,
      ...ctx,
    });
  }
}

export function buildIndex(): AtlasIndex {
  const snapshot = window.__ATLAS_DATA__ ?? EMPTY_SNAPSHOT;
  const annotations = window.__ATLAS_ANNOTATIONS__ ?? {};
  const terraform = window.__ATLAS_TERRAFORM__ ?? [];

  // Normalize once at load: snapshots committed by older scanner versions
  // predate some collections, so fill every missing array from the empty
  // factories. Downstream graph builders can then index any collection
  // without per-site `?? []` guards.
  for (const account of snapshot.accounts) {
    account.regions = account.regions.map((r) => ({ ...emptyRegionSnapshot(r.region), ...r }));
    account.global = { ...emptyGlobal(), ...account.global };
  }

  const all: ResourceRef[] = [];
  for (const account of snapshot.accounts) {
    for (const region of account.regions) {
      pushRegionRefs(all, account, region);
    }
    for (const z of account.global.hostedZones) {
      all.push({
        kind: 'zone', id: z.id, name: z.zoneName, accountId: account.accountId, region: '',
        raw: z as unknown as Record<string, unknown>,
      });
    }
    for (const gw of account.global.directConnectGateways) {
      all.push({
        kind: 'dxgw', id: gw.id, name: gw.name, accountId: account.accountId, region: '',
        raw: gw as unknown as Record<string, unknown>,
      });
    }
    for (const b of account.global.s3Buckets) {
      all.push({
        kind: 's3', id: b.id, name: b.name, accountId: account.accountId, region: b.region ?? '',
        raw: b as unknown as Record<string, unknown>,
      });
    }
    // IAM + CloudFront are account-global (region '').
    const globalKinds: Array<[string, Array<{ id: string; arn?: string; name?: string }> | undefined]> = [
      ['iam-role', account.global.iamRoles],
      ['iam-user', account.global.iamUsers],
      ['iam-group', account.global.iamGroups],
      ['iam-policy', account.global.iamPolicies],
      ['iam-instance-profile', account.global.iamInstanceProfiles],
      ['cloudfront', account.global.cloudFrontDistributions],
      ['cloudfront-vpc-origin', account.global.cloudFrontVpcOrigins],
      ['global-accelerator', account.global.globalAccelerators],
      ['core-network', account.global.coreNetworks],
      // AWS Organizations governance (panel-only; populated only in the
      // management / delegated-admin account's snapshot).
      ['org', account.global.organizations],
      ['org-ou', account.global.organizationalUnits],
      ['org-account', account.global.organizationAccounts],
      ['org-policy', account.global.organizationPolicies],
      ['waf-web-acl', account.global.wafWebAcls],
      ['waf-ip-set', account.global.wafIpSets],
      ['waf-rule-group', account.global.wafRuleGroups],
    ];
    for (const [kind, items] of globalKinds) {
      for (const item of items ?? []) {
        all.push({
          kind, id: item.id, arn: item.arn, name: item.name,
          accountId: account.accountId, region: '',
          raw: item as unknown as Record<string, unknown>,
        });
      }
    }
  }

  const byKey = new Map<string, ResourceRef>();
  // Shared resources (TGWs, RAM-shared subnets…) appear in several accounts'
  // snapshots; the owner account's copy is authoritative (it alone carries
  // route tables, descriptions, etc.), regardless of snapshot order.
  const isOwnedCopy = (ref: ResourceRef): boolean => {
    const ownerId = (ref.raw['ownerId'] ?? ref.raw['resourceOwnerId']) as string | undefined;
    return ownerId === undefined || ownerId === ref.accountId;
  };
  const put = (key: string, ref: ResourceRef): void => {
    const existing = byKey.get(key);
    if (!existing || (!isOwnedCopy(existing) && isOwnedCopy(ref))) byKey.set(key, ref);
  };
  for (const ref of all) {
    if (ref.id) put(ref.id, ref);
    if (ref.arn) put(ref.arn, ref);
  }

  const accountLabels = new Map<string, string>();
  for (const a of snapshot.accounts) {
    accountLabels.set(a.accountId, a.alias ? `${a.alias} (${a.accountId})` : a.accountId);
  }

  // Terraform state instances, keyed by id AND arn like byKey — a scanned
  // resource matches on either. The same key appearing in several stacks is
  // preserved (it's a real smell worth surfacing, not a dedupe case).
  const tfByKey = new Map<string, TerraformBinding[]>();
  for (const stack of terraform) {
    for (const res of stack.resources) {
      const binding: TerraformBinding = {
        stack: stack.stack,
        repo: stack.repo,
        address: res.address,
        type: res.type,
      };
      for (const key of new Set([res.id, res.arn])) {
        if (!key) continue;
        const existing = tfByKey.get(key);
        if (existing) existing.push(binding);
        else tfByKey.set(key, [binding]);
      }
    }
  }
  const terraformFor = (ref: ResourceRef): TerraformBinding[] => {
    const byArn = ref.arn ? tfByKey.get(ref.arn) : undefined;
    const byId = tfByKey.get(ref.id);
    if (!byArn) return byId ?? [];
    if (!byId || byId === byArn) return byArn;
    // Distinct hits on both keys (id-keyed + arn-keyed stacks): merge, dedupe.
    return [...new Set([...byArn, ...byId])];
  };

  return {
    snapshot,
    annotations,
    terraform,
    all,
    byKey,
    accountLabel: (accountId) => accountLabels.get(accountId) ?? accountId,
    annotationFor: (ref) =>
      (ref.arn ? annotations[ref.arn] : undefined) ?? annotations[ref.id],
    terraformFor,
    findRegion: (accountId, region) =>
      snapshot.accounts
        .find((a) => a.accountId === accountId)
        ?.regions.find((r) => r.region === region),
  };
}
