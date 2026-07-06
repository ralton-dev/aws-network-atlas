import type {
  AccountSnapshot,
  Annotation,
  AnnotationMap,
  RegionSnapshot,
  Snapshot,
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
  all: ResourceRef[];
  /** Keyed by id AND arn. */
  byKey: Map<string, ResourceRef>;
  accountLabel(accountId: string): string;
  annotationFor(ref: ResourceRef): Annotation | undefined;
  findRegion(accountId: string, region: string): RegionSnapshot | undefined;
}

const EMPTY_SNAPSHOT: Snapshot = { version: 1, generatedAt: '', accounts: [] };

function pushRegionRefs(all: ResourceRef[], account: AccountSnapshot, region: RegionSnapshot): void {
  const ctx = { accountId: account.accountId, region: region.region };
  const add = (kind: string, items: Array<Record<string, unknown>>, vpcKey = 'vpcId'): void => {
    for (const item of items) {
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
  add('prefix-list', region.prefixLists as unknown as Array<Record<string, unknown>>);
  add('pcx', region.peeringConnections as unknown as Array<Record<string, unknown>>);
  add('tgw', region.transitGateways as unknown as Array<Record<string, unknown>>);
  add('tgw-attachment', region.transitGatewayAttachments as unknown as Array<Record<string, unknown>>);
  add('tgw-rt', region.transitGatewayRouteTables as unknown as Array<Record<string, unknown>>);
  add('vgw', region.vpnGateways as unknown as Array<Record<string, unknown>>);
  add('cgw', region.customerGateways as unknown as Array<Record<string, unknown>>);
  add('vpn', region.vpnConnections as unknown as Array<Record<string, unknown>>);
  add('lb', region.loadBalancers as unknown as Array<Record<string, unknown>>);
  add('tg', region.targetGroups as unknown as Array<Record<string, unknown>>);
  add('instance', region.instances as unknown as Array<Record<string, unknown>>);
  add('asg', region.autoScalingGroups as unknown as Array<Record<string, unknown>>);
  add('lambda', region.lambdaFunctions as unknown as Array<Record<string, unknown>>);
  add('rds', region.rdsInstances as unknown as Array<Record<string, unknown>>);
  add('rds-cluster', region.rdsClusters as unknown as Array<Record<string, unknown>>);
  add('ecs', region.ecsServices as unknown as Array<Record<string, unknown>>);
  add('eks', region.eksClusters as unknown as Array<Record<string, unknown>>);
  add('elasticache', region.elastiCacheClusters as unknown as Array<Record<string, unknown>>);

  // Lambda vpcId lives inside vpcConfig.
  for (const ref of all) {
    if (ref.kind === 'lambda' && !ref.vpcId) {
      const cfg = ref.raw['vpcConfig'] as { vpcId?: string } | undefined;
      if (cfg?.vpcId) ref.vpcId = cfg.vpcId;
    }
  }

  for (const g of region.generic) {
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

  return {
    snapshot,
    annotations,
    all,
    byKey,
    accountLabel: (accountId) => accountLabels.get(accountId) ?? accountId,
    annotationFor: (ref) =>
      (ref.arn ? annotations[ref.arn] : undefined) ?? annotations[ref.id],
    findRegion: (accountId, region) =>
      snapshot.accounts
        .find((a) => a.accountId === accountId)
        ?.regions.find((r) => r.region === region),
  };
}
