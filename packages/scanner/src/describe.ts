/**
 * `atlas-scan describe` — the `atlas-propose` skill's eyes (decision 54).
 *
 * A compact, capped summary of `site/data/data.js` (the same bytes the viewer
 * shows; never `data/accounts/*.json`): enough for an agent to design a
 * networking change and write its proposal without reading the snapshot. So
 * every resource is printed by its **real id** — the agent copies ids into
 * `key:` and `…Id` fields, and a name there is an `unresolved-reference` — and
 * the header carries `generatedAt`, which the agent copies into
 * `base.generatedAt`. Budget ~2 KB per account; every list stops at `CAP`
 * with `+N more`.
 *
 * `--json` is the same model, structured: `describeSnapshot` builds it and
 * `renderMarkdown` only formats it, so the two cannot disagree.
 */
import type { AccountSnapshot, PeeringSide, RegionSnapshot, Snapshot } from '@atlas/schema';
import { GLOBAL_COLLECTIONS, REGION_COLLECTIONS } from '@atlas/proposal';

/** The most items any one list prints before `+N more`. */
export const CAP = 8;

export interface Capped<T> {
  items: T[];
  /** How many were left out. */
  more: number;
}

function capped<T>(all: readonly T[], cap: number = CAP): Capped<T> {
  return { items: all.slice(0, cap), more: Math.max(0, all.length - cap) };
}

export interface DescribedSubnet {
  id: string;
  cidrBlock?: string;
  availabilityZone: string;
  isPublic: boolean;
}

export interface DescribedVpc {
  id: string;
  name?: string;
  cidrBlocks: string[];
  ipv6CidrBlocks: string[];
  isDefault: boolean;
  subnetCount: number;
  securityGroupCount: number;
  endpointCount: number;
  subnets: Capped<DescribedSubnet>;
}

export interface DescribedTransitGateway {
  id: string;
  name?: string;
  ownerId?: string;
  amazonSideAsn?: number;
  associationDefaultRouteTableId?: string;
  /** Attachments of this TGW recorded in the same account and region. */
  attachments: Capped<DescribedAttachment>;
}

export interface DescribedAttachment {
  id: string;
  transitGatewayId: string;
  resourceType: string;
  resourceId?: string;
  resourceOwnerId?: string;
  state?: string;
}

export interface DescribedPeering {
  id: string;
  name?: string;
  status?: string;
  requester: PeeringSide;
  accepter: PeeringSide;
}

export interface DescribedLoadBalancer {
  id: string;
  name?: string;
  lbType: string;
  scheme?: string;
  vpcId?: string;
}

export interface DescribedRegion {
  region: string;
  vpcs: Capped<DescribedVpc>;
  transitGateways: Capped<DescribedTransitGateway>;
  /** Attachments to a TGW not in `transitGateways` (owned by, or recorded under, another account or region). */
  otherAttachments: Capped<DescribedAttachment>;
  peeringConnections: Capped<DescribedPeering>;
  loadBalancers: Capped<DescribedLoadBalancer>;
}

export interface DescribedHostedZone {
  id: string;
  zoneName: string;
  privateZone: boolean;
  vpcAssociations: Capped<{ vpcId: string; region: string }>;
}

/** One line of the org tree: a root, OU or account, indented by `depth`. */
export interface DescribedOrgNode {
  depth: number;
  kind: 'root' | 'ou' | 'account';
  id: string;
  name?: string;
}

export interface DescribedOrganization {
  id: string;
  masterAccountId?: string;
  tree: Capped<DescribedOrgNode>;
}

export interface DescribedAccount {
  accountId: string;
  alias?: string;
  regions: string[];
  emptyRegions: string[];
  detail: DescribedRegion[];
  hostedZones: Capped<DescribedHostedZone>;
  organizations: DescribedOrganization[];
}

export interface CollectionCount {
  collection: string;
  scope: 'region' | 'global';
  count: number;
}

export interface Description {
  generatedAt: string;
  accounts: DescribedAccount[];
  /** Every non-empty collection across the described accounts (a shared resource counts once per account copy). */
  counts: CollectionCount[];
}

function attachment(a: RegionSnapshot['transitGatewayAttachments'][number]): DescribedAttachment {
  return {
    id: a.id,
    transitGatewayId: a.transitGatewayId,
    resourceType: a.resourceType,
    ...(a.resourceId ? { resourceId: a.resourceId } : {}),
    ...(a.resourceOwnerId ? { resourceOwnerId: a.resourceOwnerId } : {}),
    ...(a.state ? { state: a.state } : {}),
  };
}

function describeRegion(r: RegionSnapshot): DescribedRegion {
  const subnets = r.subnets ?? [];
  const sgs = r.securityGroups ?? [];
  const endpoints = r.vpcEndpoints ?? [];
  const vpcs: DescribedVpc[] = (r.vpcs ?? []).map((v) => {
    const own = subnets.filter((s) => s.vpcId === v.id);
    return {
      id: v.id,
      ...(v.name ? { name: v.name } : {}),
      cidrBlocks: v.cidrBlocks ?? [],
      ipv6CidrBlocks: v.ipv6CidrBlocks ?? [],
      isDefault: v.isDefault,
      subnetCount: own.length,
      securityGroupCount: sgs.filter((s) => s.vpcId === v.id).length,
      endpointCount: endpoints.filter((e) => e.vpcId === v.id).length,
      subnets: capped(
        own.map((s) => ({
          id: s.id,
          ...(s.cidrBlock ? { cidrBlock: s.cidrBlock } : {}),
          availabilityZone: s.availabilityZone,
          isPublic: s.isPublic,
        })),
      ),
    };
  });
  const attachments = r.transitGatewayAttachments ?? [];
  const tgwIds = new Set((r.transitGateways ?? []).map((t) => t.id));
  return {
    region: r.region,
    vpcs: capped(vpcs),
    transitGateways: capped(
      (r.transitGateways ?? []).map((t) => ({
        id: t.id,
        ...(t.name ? { name: t.name } : {}),
        ...(t.ownerId ? { ownerId: t.ownerId } : {}),
        ...(t.amazonSideAsn !== undefined ? { amazonSideAsn: t.amazonSideAsn } : {}),
        ...(t.associationDefaultRouteTableId ? { associationDefaultRouteTableId: t.associationDefaultRouteTableId } : {}),
        attachments: capped(attachments.filter((a) => a.transitGatewayId === t.id).map(attachment)),
      })),
    ),
    otherAttachments: capped(attachments.filter((a) => !tgwIds.has(a.transitGatewayId)).map(attachment)),
    peeringConnections: capped(
      (r.peeringConnections ?? []).map((p) => ({
        id: p.id,
        ...(p.name ? { name: p.name } : {}),
        ...(p.status ? { status: p.status } : {}),
        requester: p.requester,
        accepter: p.accepter,
      })),
    ),
    loadBalancers: capped(
      (r.loadBalancers ?? []).map((lb) => ({
        id: lb.id,
        ...(lb.name ? { name: lb.name } : {}),
        lbType: lb.lbType,
        ...(lb.scheme ? { scheme: lb.scheme } : {}),
        ...(lb.vpcId ? { vpcId: lb.vpcId } : {}),
      })),
    ),
  };
}

function describeOrganizations(account: AccountSnapshot): DescribedOrganization[] {
  const g = account.global;
  const ous = g.organizationalUnits ?? [];
  const members = g.organizationAccounts ?? [];
  return (g.organizations ?? []).map((org) => {
    const nodes: DescribedOrgNode[] = [];
    const walk = (parentId: string, depth: number): void => {
      for (const m of members.filter((a) => a.parentId === parentId)) {
        nodes.push({ depth, kind: 'account', id: m.id, ...(m.name ? { name: m.name } : {}) });
      }
      for (const ou of ous.filter((o) => o.parentId === parentId)) {
        nodes.push({ depth, kind: 'ou', id: ou.id, ...(ou.name ? { name: ou.name } : {}) });
        walk(ou.id, depth + 1);
      }
    };
    for (const root of org.roots ?? []) {
      nodes.push({ depth: 0, kind: 'root', id: root.id, ...(root.name ? { name: root.name } : {}) });
      walk(root.id, 1);
    }
    return {
      id: org.id,
      ...(org.masterAccountId ? { masterAccountId: org.masterAccountId } : {}),
      // An org tree is one list for capping: nineteen accounts in five OUs is ~25 lines.
      tree: capped(nodes, CAP * 4),
    };
  });
}

function describeAccount(a: AccountSnapshot): DescribedAccount {
  return {
    accountId: a.accountId,
    ...(a.alias ? { alias: a.alias } : {}),
    regions: a.regions.map((r) => r.region),
    emptyRegions: a.emptyRegions ?? [],
    detail: a.regions.map(describeRegion),
    hostedZones: capped(
      (a.global.hostedZones ?? []).map((z) => ({
        id: z.id,
        zoneName: z.zoneName,
        privateZone: z.privateZone,
        vpcAssociations: capped(z.vpcAssociations ?? []),
      })),
    ),
    organizations: describeOrganizations(a),
  };
}

function countCollections(accounts: readonly AccountSnapshot[]): CollectionCount[] {
  const length = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  const out: CollectionCount[] = [];
  for (const collection of REGION_COLLECTIONS) {
    const count = accounts.reduce(
      (n, a) => n + a.regions.reduce((m, r) => m + length((r as unknown as Record<string, unknown>)[collection]), 0),
      0,
    );
    if (count > 0) out.push({ collection, scope: 'region', count });
  }
  for (const collection of GLOBAL_COLLECTIONS) {
    const count = accounts.reduce((n, a) => n + length((a.global as unknown as Record<string, unknown>)[collection]), 0);
    if (count > 0) out.push({ collection, scope: 'global', count });
  }
  return out;
}

/**
 * The description of `snapshot`, or of one account in it. `account` matches
 * an account id or alias; an unknown one throws, naming the known ones.
 */
export function describeSnapshot(snapshot: Snapshot, options: { account?: string } = {}): Description {
  let accounts = snapshot.accounts;
  if (options.account !== undefined) {
    const want = options.account;
    accounts = accounts.filter((a) => a.accountId === want || a.alias === want);
    if (accounts.length === 0) {
      const known = snapshot.accounts.map((a) => (a.alias ? `${a.accountId} (${a.alias})` : a.accountId)).join(', ');
      throw new Error(`describe: no account ${want} in site/data/data.js; known: ${known || '(none)'}`);
    }
  }
  return {
    generatedAt: snapshot.generatedAt,
    accounts: accounts.map(describeAccount),
    counts: countCollections(accounts),
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const q = (name: string | undefined): string => (name ? ` ${JSON.stringify(name)}` : '');

function more(c: Capped<unknown>, indent: string): string[] {
  return c.more > 0 ? [`${indent}- +${c.more} more`] : [];
}

function list<T>(lines: string[], label: string, c: Capped<T>, line: (item: T) => string[]): void {
  if (c.items.length === 0) return;
  lines.push(`${label}:`);
  for (const item of c.items) lines.push(...line(item));
  lines.push(...more(c, ''));
}

function side(s: PeeringSide): string {
  return `${s.vpcId ?? '?'} (${s.accountId ?? '?'} ${s.region ?? '?'} ${s.cidrBlocks.join(',') || '?'})`;
}

/** `accountId` is the account the line is printed under: an owner equal to it goes without saying. */
function attachmentLine(a: DescribedAttachment, indent: string, showTgw: boolean, accountId: string): string {
  const target = a.resourceId ? ` ${a.resourceId}` : '';
  const owner = a.resourceOwnerId && a.resourceOwnerId !== accountId ? ` owner ${a.resourceOwnerId}` : '';
  const tgw = showTgw ? ` → ${a.transitGatewayId}` : '';
  return `${indent}- ${a.id}${tgw} ${a.resourceType}${target}${owner}${a.state && a.state !== 'available' ? ` [${a.state}]` : ''}`;
}

function renderAccount(a: DescribedAccount): string[] {
  const lines: string[] = [];
  lines.push(`## ${a.accountId}${a.alias ? ` ${a.alias}` : ''}`, '');
  lines.push(`Regions: ${a.regions.join(', ') || '(none)'}${a.emptyRegions.length ? `. Scanned empty: ${a.emptyRegions.join(', ')}` : ''}.`);
  for (const r of a.detail) {
    lines.push('', `### ${r.region}`);
    list(lines, 'VPCs', r.vpcs, (v) => [
      `- ${v.id}${q(v.name)} ${[...v.cidrBlocks, ...v.ipv6CidrBlocks].join(', ') || '(no CIDR)'}${v.isDefault ? ' default' : ''} — ${v.subnetCount} subnets, ${v.securityGroupCount} SGs, ${v.endpointCount} endpoints`,
      ...v.subnets.items.map((s) => `  - ${s.id} ${s.cidrBlock ?? '(ipv6-only)'} ${s.availabilityZone}${s.isPublic ? ' public' : ''}`),
      ...more(v.subnets, '  '),
    ]);
    list(lines, 'TGWs', r.transitGateways, (t) => [
      `- ${t.id}${q(t.name)}${t.ownerId && t.ownerId !== a.accountId ? ` owner ${t.ownerId}` : ''}${t.amazonSideAsn !== undefined ? ` asn ${t.amazonSideAsn}` : ''}${t.associationDefaultRouteTableId ? ` default-rt ${t.associationDefaultRouteTableId}` : ''}`,
      ...t.attachments.items.map((x) => attachmentLine(x, '  ', false, a.accountId)),
      ...more(t.attachments, '  '),
    ]);
    list(lines, 'TGW attachments', r.otherAttachments, (x) => [attachmentLine(x, '', true, a.accountId)]);
    list(lines, 'Peerings', r.peeringConnections, (p) => [
      `- ${p.id}${q(p.name)} ${side(p.requester)} ↔ ${side(p.accepter)}${p.status && p.status !== 'active' ? ` [${p.status}]` : ''}`,
    ]);
    list(lines, 'Load balancers', r.loadBalancers, (lb) => [
      `- ${lb.id}${q(lb.name)} ${lb.lbType}${lb.scheme ? ` ${lb.scheme}` : ''}${lb.vpcId ? ` in ${lb.vpcId}` : ''}`,
    ]);
  }
  if (a.hostedZones.items.length > 0 || a.organizations.length > 0) {
    lines.push('', '### global');
    list(lines, 'Hosted zones', a.hostedZones, (z) => [
      `- ${z.id} ${z.zoneName} ${z.privateZone ? 'private' : 'public'}${z.vpcAssociations.items.length ? ` → ${z.vpcAssociations.items.map((v) => `${v.vpcId}/${v.region}`).join(', ')}` : ''}${z.vpcAssociations.more ? ` +${z.vpcAssociations.more} more` : ''}`,
    ]);
    for (const org of a.organizations) {
      lines.push(`Organization ${org.id}${org.masterAccountId ? ` (management ${org.masterAccountId})` : ''}:`);
      for (const n of org.tree.items) {
        lines.push(`${'  '.repeat(n.depth)}- ${n.kind === 'account' ? '' : `${n.kind} `}${n.id}${n.name ? ` ${n.name}` : ''}`);
      }
      lines.push(...more(org.tree, ''));
    }
  }
  return lines;
}

/** The markdown `npm run describe` prints. */
export function renderMarkdown(d: Description): string {
  const lines: string[] = [
    '# Atlas estate',
    '',
    `generatedAt: ${d.generatedAt}`,
    '',
    `${d.accounts.length} account(s). Copy generatedAt into \`base.generatedAt\`. Every id here is the real id: copy it verbatim into \`key:\` and \`…Id\` fields. Lists stop at ${CAP} with "+N more".`,
  ];
  for (const a of d.accounts) lines.push('', ...renderAccount(a));
  // Two lines, not a row per collection: a table cost ~2.7 KB on the fixture
  // alone, more than any one account's section.
  lines.push('', '## Counts', '', '| scope | collection count |', '| --- | --- |');
  for (const scope of ['region', 'global'] as const) {
    const row = d.counts.filter((c) => c.scope === scope).map((c) => `${c.collection} ${c.count}`);
    lines.push(`| ${scope} | ${row.join(', ') || '(none)'} |`);
  }
  lines.push(
    '',
    `Collections not listed are empty. ${REGION_COLLECTIONS.length} region and ${GLOBAL_COLLECTIONS.length} global collections exist; a resource's fields are its type in packages/schema/src/snapshot.ts.`,
  );
  return lines.join('\n') + '\n';
}
