import type {
  AccountSnapshot,
  OrganizationAccount,
  RegionSnapshot,
  TransitGatewayAttachment,
  VpcPeeringConnection,
} from '@atlas/schema';
import { MarkerType } from '@xyflow/react';
import type { AtlasIndex } from '../data.js';
import {
  destsLabel,
  type AtlasEdge,
  type AtlasGraph,
  type AtlasNode,
  type ContainerStyle,
  type RouteDetail,
} from './graph-types.js';
import { s3OriginBucket, trustedAccountPrincipals, worldOpenIngress } from './relations.js';
import { subnetRoutes } from './routes.js';

const EXT_CONTAINER = 'ext:onprem';

/** Per-kind display caps: real estates have hundreds of roles/keys/buckets. */
const CAP_IDENTITY = 8;
const CAP_SERVICES = 6;
/** Org governance caps: real orgs run to thousands of accounts. */
const CAP_ORG_ACCOUNTS = 12;
const CAP_ORG_POLICIES = 20;
const CAP_ORG_POLICY_TARGETS = 30;

interface Builder {
  accounts: Map<string, AtlasNode>;
  /** Second-level containers: region boxes plus per-account lanes. */
  regions: Map<string, AtlasNode>;
  leaves: Map<string, AtlasNode>;
  edges: Map<string, AtlasEdge>;
  extUsed: boolean;
}

function ensureGhostAccount(b: Builder, accountId: string): string {
  const id = `acct:${accountId}`;
  if (!b.accounts.has(id)) {
    b.accounts.set(id, {
      id,
      type: 'container',
      position: { x: 0, y: 0 },
      data: {
        label: `Account ${accountId}`,
        subtitle: 'not scanned',
        kind: 'group-account',
        isContainer: true,
        containerStyle: 'ghost',
        ghost: true,
      },
    });
  }
  return id;
}

function ensureVpcNode(
  b: Builder,
  vpcId: string | undefined,
  accountId: string | undefined,
  region: string | undefined,
): string | undefined {
  if (!vpcId) return undefined;
  const id = `vpc:${vpcId}`;
  if (!b.leaves.has(id)) {
    const parent = accountId ? ensureGhostAccount(b, accountId) : undefined;
    b.leaves.set(id, {
      id,
      type: 'resource',
      position: { x: 0, y: 0 },
      parentId: parent,
      width: 210,
      height: 92,
      data: {
        label: vpcId,
        subtitle: region ? `${region} · not scanned` : 'not scanned',
        kind: 'vpc',
        refId: vpcId,
        drillVpcId: undefined,
        ghost: true,
      },
    });
  }
  return id;
}

function ensureTgwNode(b: Builder, tgwId: string | undefined, accountId?: string): string | undefined {
  if (!tgwId) return undefined;
  const id = `tgw:${tgwId}`;
  if (!b.leaves.has(id)) {
    const parent = accountId ? ensureGhostAccount(b, accountId) : undefined;
    b.leaves.set(id, {
      id,
      type: 'resource',
      position: { x: 0, y: 0 },
      parentId: parent,
      width: 150,
      height: 96,
      data: { label: tgwId, subtitle: 'not scanned', kind: 'tgw', refId: tgwId, ghost: true },
    });
  }
  return id;
}

function ensureExt(b: Builder): string {
  b.extUsed = true;
  return EXT_CONTAINER;
}

function ensureLane(
  b: Builder,
  id: string,
  parentId: string,
  label: string,
  kind: string,
  style: ContainerStyle,
): string {
  if (!b.regions.has(id)) {
    b.regions.set(id, {
      id,
      type: 'container',
      position: { x: 0, y: 0 },
      parentId,
      data: { label, kind, isContainer: true, containerStyle: style },
    });
  }
  return id;
}

function leafNode(
  b: Builder,
  id: string,
  parentId: string | undefined,
  kind: string,
  label: string,
  subtitle?: string,
  refId?: string,
  badges?: string[],
  size?: { w?: number; h?: number },
): string {
  if (!b.leaves.has(id)) {
    b.leaves.set(id, {
      id,
      type: 'resource',
      position: { x: 0, y: 0 },
      parentId,
      width: size?.w ?? 170,
      height: size?.h ?? 92,
      data: {
        label,
        subtitle,
        kind,
        refId,
        badges: badges && badges.length > 0 ? badges : undefined,
      },
    });
  }
  return id;
}

/** The public internet — the anchor for CloudFront/API GW/Client VPN traffic. */
function ensureInternet(b: Builder): string {
  return leafNode(b, 'ext:internet', undefined, 'internet', 'Internet', 'public traffic', undefined, undefined, { w: 150, h: 96 });
}

/** Add up to `cap` items via `add`; summarize the overflow with a note node. */
function addCapped<T>(
  b: Builder,
  items: T[],
  cap: number,
  parentId: string,
  noteId: string,
  kindLabel: string,
  add: (item: T) => void,
): void {
  for (const item of items.slice(0, cap)) add(item);
  const extra = items.length - cap;
  if (extra > 0) {
    b.leaves.set(noteId, {
      id: noteId,
      type: 'note',
      position: { x: 0, y: 0 },
      parentId,
      width: 230,
      height: 58,
      data: { label: `+${extra} more ${kindLabel}`, subtitle: 'use Search or Inventory', kind: 'note' },
    });
  }
}

const iamNodeId = (accountId: string, item: { id: string; arn?: string }): string =>
  `iam:${item.arn ?? `${accountId}:${item.id}`}`;

const ssoNodeId = (accountId: string, item: { id: string; arn?: string }): string =>
  `sso:${item.arn ?? `${accountId}:${item.id}`}`;

/**
 * Account-global resources: an "Identity & security" lane (IAM) and an
 * "Edge & global" lane (CloudFront, Route 53 zones, S3 buckets) per account.
 */
function addAccountGlobal(
  b: Builder,
  index: AtlasIndex,
  account: AccountSnapshot,
  lbByDns: Map<string, { vpcId?: string; name?: string; accountId: string; region: string }>,
): void {
  const acctId = `acct:${account.accountId}`;
  const g = account.global;

  // --- Identity & security lane ---------------------------------------------
  const identityCount =
    g.iamRoles.length + g.iamUsers.length + g.iamGroups.length +
    g.iamPolicies.length + g.iamInstanceProfiles.length +
    g.ssoInstances.length + g.ssoPermissionSets.length + g.ssoApplications.length +
    g.iamSamlProviders.length + g.iamOidcProviders.length;
  if (identityCount > 0) {
    const lane = ensureLane(b, `idn:${account.accountId}`, acctId, 'Identity & security', 'group-security', 'security');
    addCapped(b, g.iamRoles, CAP_IDENTITY, lane, `note:${lane}:roles`, 'IAM roles', (r) =>
      leafNode(b, iamNodeId(account.accountId, r), lane, 'iam-role', r.name ?? r.id, r.description ?? 'IAM role', r.arn ?? r.id),
    );
    addCapped(b, g.iamUsers, CAP_IDENTITY, lane, `note:${lane}:users`, 'IAM users', (u) =>
      leafNode(b, iamNodeId(account.accountId, u), lane, 'iam-user', u.name ?? u.id, 'IAM user', u.arn ?? u.id, [
        ...(u.hasConsoleAccess && u.mfaDeviceCount === 0 ? ['no MFA'] : []),
        ...(u.accessKeyIds.length > 0 ? [`${u.accessKeyIds.length} access key${u.accessKeyIds.length > 1 ? 's' : ''}`] : []),
      ]),
    );
    addCapped(b, g.iamGroups, CAP_IDENTITY, lane, `note:${lane}:groups`, 'IAM groups', (grp) =>
      leafNode(b, iamNodeId(account.accountId, grp), lane, 'iam-group', grp.name ?? grp.id, `${grp.userNames.length} member${grp.userNames.length === 1 ? '' : 's'}`, grp.arn ?? grp.id),
    );
    addCapped(b, g.iamPolicies, CAP_IDENTITY, lane, `note:${lane}:policies`, 'IAM policies', (p) =>
      leafNode(b, iamNodeId(account.accountId, p), lane, 'iam-policy', p.name ?? p.id, 'customer-managed policy', p.arn ?? p.id,
        p.attachmentCount ? [`${p.attachmentCount} attached`] : undefined),
    );
    addCapped(b, g.iamInstanceProfiles, CAP_IDENTITY, lane, `note:${lane}:profiles`, 'instance profiles', (ip) =>
      leafNode(b, iamNodeId(account.accountId, ip), lane, 'iam-instance-profile', ip.name ?? ip.id, 'instance profile', ip.arn ?? ip.id),
    );

    // IAM Identity Center: the instance, its permission sets (assignment
    // edges to drawn org-account nodes are added in addSsoAssignmentEdges,
    // after the org tree exists), and access-portal applications.
    for (const inst of g.ssoInstances) {
      leafNode(b, ssoNodeId(account.accountId, inst), lane, 'sso-instance',
        inst.name ?? 'Identity Center',
        inst.identityStoreId ? `Identity Center · ${inst.identityStoreId}` : 'Identity Center',
        inst.arn ?? inst.id,
        inst.status && inst.status !== 'ACTIVE' ? [inst.status.toLowerCase().replace(/_/g, ' ')] : undefined);
    }
    addCapped(b, g.ssoPermissionSets, CAP_IDENTITY, lane, `note:${lane}:permsets`, 'permission sets', (ps) =>
      leafNode(b, ssoNodeId(account.accountId, ps), lane, 'sso-permission-set', ps.name, 'SSO permission set', ps.arn ?? ps.id,
        ps.assignments.length > 0 ? [`${ps.assignments.length} assignment${ps.assignments.length === 1 ? '' : 's'}`] : undefined),
    );
    addCapped(b, g.ssoApplications, CAP_IDENTITY, lane, `note:${lane}:ssoapps`, 'SSO applications', (app) =>
      leafNode(b, ssoNodeId(account.accountId, app), lane, 'sso-application', app.name ?? app.id, 'Identity Center application', app.arn ?? app.id,
        app.status && app.status !== 'ENABLED' ? [app.status.toLowerCase()] : undefined),
    );

    // IAM federation: SAML + OIDC identity providers.
    addCapped(b, g.iamSamlProviders, CAP_IDENTITY, lane, `note:${lane}:saml`, 'SAML providers', (p) =>
      leafNode(b, iamNodeId(account.accountId, p), lane, 'saml-provider', p.name ?? p.id, 'SAML identity provider', p.arn ?? p.id),
    );
    addCapped(b, g.iamOidcProviders, CAP_IDENTITY, lane, `note:${lane}:oidc`, 'OIDC providers', (p) =>
      leafNode(b, iamNodeId(account.accountId, p), lane, 'oidc-provider', p.name ?? p.id, 'OIDC identity provider', p.arn ?? p.id,
        p.clientIds.length > 0 ? [`${p.clientIds.length} audience${p.clientIds.length === 1 ? '' : 's'}`] : undefined),
    );

    // user → group membership
    for (const u of g.iamUsers) {
      const userNode = iamNodeId(account.accountId, u);
      if (!b.leaves.has(userNode)) continue;
      for (const groupName of u.groups) {
        const group = g.iamGroups.find((grp) => grp.id === groupName || grp.name === groupName);
        const groupNode = group ? iamNodeId(account.accountId, group) : undefined;
        if (!groupNode || !b.leaves.has(groupNode)) continue;
        const key = `iamgrp:${userNode}|${groupNode}`;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: userNode,
          target: groupNode,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { edgeKind: 'uses', label: 'member', title: `${u.name ?? u.id} is a member of ${groupName}`, refId: group?.arn ?? group?.id },
        });
      }
    }
    // instance profile → role
    for (const ip of g.iamInstanceProfiles) {
      const profileNode = iamNodeId(account.accountId, ip);
      if (!b.leaves.has(profileNode)) continue;
      for (const roleName of ip.roleNames) {
        const role = g.iamRoles.find((r) => r.id === roleName || r.name === roleName);
        const roleNode = role ? iamNodeId(account.accountId, role) : undefined;
        if (!roleNode || !b.leaves.has(roleNode)) continue;
        const key = `iamprof:${profileNode}|${roleNode}`;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: profileNode,
          target: roleNode,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { edgeKind: 'uses', title: `${ip.name ?? ip.id} carries role ${roleName}`, refId: role?.arn ?? role?.id },
        });
      }
    }
  }

  // --- Edge & global lane -----------------------------------------------------
  const edgeCount =
    g.cloudFrontDistributions.length + g.hostedZones.length + g.s3Buckets.length +
    (g.globalAccelerators ?? []).length + (g.wafWebAcls ?? []).length +
    (g.coreNetworks ?? []).length;
  if (edgeCount > 0) {
    const lane = ensureLane(b, `glb:${account.accountId}`, acctId, 'Edge & global', 'group-edge', 'external');

    for (const dist of g.cloudFrontDistributions) {
      const cfNode = leafNode(b, `cf:${dist.id}`, lane, 'cloudfront', dist.name ?? dist.id, dist.domainName, dist.arn ?? dist.id, [
        ...(dist.webAclId ? ['WAF'] : []),
        ...(dist.enabled === false ? ['disabled'] : []),
      ]);
      const inet = ensureInternet(b);
      const inKey = `inet-cf:${dist.id}`;
      b.edges.set(inKey, {
        id: `edge:${inKey}`,
        source: inet,
        target: cfNode,
        type: 'annotated',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'edge-service', label: destsLabel(dist.aliases, 2) || 'HTTPS', title: `Internet → CloudFront ${dist.name ?? dist.id}`, refId: dist.arn ?? dist.id },
      });
      for (const origin of dist.origins) {
        const lb = lbByDns.get(origin);
        if (lb?.vpcId) {
          const vpcNode = ensureVpcNode(b, lb.vpcId, lb.accountId, lb.region);
          if (!vpcNode) continue;
          const key = `cforig:${dist.id}|${vpcNode}`;
          b.edges.set(key, {
            id: `edge:${key}`,
            source: cfNode,
            target: vpcNode,
            type: 'annotated',
            markerEnd: { type: MarkerType.ArrowClosed },
            data: { edgeKind: 'edge-service', label: `origin · ${lb.name ?? origin}`, title: `CloudFront origin ${origin}`, refId: dist.arn ?? dist.id },
          });
          continue;
        }
        const bucketName = s3OriginBucket(origin);
        if (bucketName) {
          const owner = index.snapshot.accounts.find((a) =>
            a.global.s3Buckets.some((bk) => bk.name === bucketName || bk.id === bucketName),
          );
          const bucketLane = owner
            ? ensureLane(b, `glb:${owner.accountId}`, `acct:${owner.accountId}`, 'Edge & global', 'group-edge', 'external')
            : lane;
          const s3Node = leafNode(b, `s3:${bucketName}`, bucketLane, 's3', bucketName, 'S3 bucket', bucketName);
          const key = `cforig:${dist.id}|${s3Node}`;
          b.edges.set(key, {
            id: `edge:${key}`,
            source: cfNode,
            target: s3Node,
            type: 'annotated',
            markerEnd: { type: MarkerType.ArrowClosed },
            data: { edgeKind: 'edge-service', label: 'origin', title: `CloudFront origin ${origin}`, refId: dist.arn ?? dist.id },
          });
        }
      }
    }

    for (const zone of g.hostedZones) {
      const zoneNode = leafNode(b, `zone:${account.accountId}:${zone.id}`, lane, 'zone', zone.zoneName,
        `${zone.privateZone ? 'private' : 'public'} zone · ${zone.recordCount ?? '?'} records`, zone.id);
      for (const assoc of zone.vpcAssociations) {
        const vpcNode = ensureVpcNode(b, assoc.vpcId, account.accountId, assoc.region);
        if (!vpcNode) continue;
        const key = `zonedns:${zone.id}|${vpcNode}`;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: zoneNode,
          target: vpcNode,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { edgeKind: 'dns', label: 'private DNS', title: `${zone.zoneName} resolves in ${assoc.vpcId}`, refId: zone.id },
        });
      }
    }

    addCapped(b, g.s3Buckets, CAP_SERVICES, lane, `note:${lane}:s3`, 'S3 buckets', (bucket) =>
      leafNode(b, `s3:${bucket.name ?? bucket.id}`, lane, 's3', bucket.name ?? bucket.id, bucket.region ? `S3 · ${bucket.region}` : 'S3 bucket', bucket.id),
    );

    // Global Accelerator: internet → accelerator → the VPC of each endpoint.
    for (const ga of g.globalAccelerators ?? []) {
      const gaNode = leafNode(b, `ga:${ga.id}`, lane, 'global-accelerator', ga.name ?? ga.id,
        ga.dnsName ?? 'Global Accelerator', ga.arn ?? ga.id,
        ga.enabled === false ? ['disabled'] : undefined);
      const inKey = `inet-ga:${ga.id}`;
      b.edges.set(inKey, {
        id: `edge:${inKey}`,
        source: ensureInternet(b),
        target: gaNode,
        type: 'annotated',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'edge-service', label: 'anycast', title: `Internet → Global Accelerator ${ga.name ?? ga.id}`, refId: ga.arn ?? ga.id },
      });
      for (const listener of ga.listeners) {
        for (const group of listener.endpointGroups) {
          for (const endpoint of group.endpoints) {
            if (!endpoint.endpointId) continue;
            const ref = index.byKey.get(endpoint.endpointId);
            const vpcNode = ref?.vpcId
              ? ensureVpcNode(b, ref.vpcId, ref.accountId, ref.region)
              : undefined;
            if (!vpcNode) continue;
            const key = `gaep:${ga.id}|${vpcNode}`;
            if (b.edges.has(key)) continue;
            b.edges.set(key, {
              id: `edge:${key}`,
              source: gaNode,
              target: vpcNode,
              type: 'annotated',
              markerEnd: { type: MarkerType.ArrowClosed },
              data: { edgeKind: 'edge-service', label: `endpoint · ${ref?.name ?? group.region ?? ''}`.trim(), title: `Accelerator endpoint ${endpoint.endpointId}`, refId: ga.arn ?? ga.id },
            });
          }
        }
      }
    }

    // WAF (CLOUDFRONT scope): the ACL protecting each distribution.
    for (const acl of g.wafWebAcls ?? []) {
      const aclNode = leafNode(b, `waf:${acl.arn ?? acl.id}`, lane, 'waf-web-acl', acl.name ?? acl.id,
        `WAF · ${acl.rules.length} rule${acl.rules.length === 1 ? '' : 's'}`, acl.arn ?? acl.id);
      for (const dist of g.cloudFrontDistributions) {
        if (!dist.webAclId || dist.webAclId !== (acl.arn ?? acl.id)) continue;
        const key = `wafcf:${acl.id}|${dist.id}`;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: aclNode,
          target: `cf:${dist.id}`,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { edgeKind: 'uses', label: 'WAF protects', title: `${acl.name ?? acl.id} protects ${dist.name ?? dist.id}`, refId: acl.arn ?? acl.id },
        });
      }
    }

    // Cloud WAN core networks → the VPCs attached to them.
    for (const cn of g.coreNetworks ?? []) {
      const cnNode = leafNode(b, `corenet:${cn.id}`, lane, 'core-network', cn.name ?? cn.id,
        `Cloud WAN · ${cn.segments.length} segment${cn.segments.length === 1 ? '' : 's'}`, cn.arn ?? cn.id);
      for (const att of cn.attachments) {
        const vpcId = att.resourceArn?.match(/vpc\/(vpc-[0-9a-f]+)/)?.[1];
        if (!vpcId) continue;
        const vpcNode = ensureVpcNode(b, vpcId, att.ownerAccountId, att.edgeLocation);
        if (!vpcNode) continue;
        const key = `cnatt:${cn.id}|${vpcNode}`;
        if (b.edges.has(key)) continue;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: vpcNode,
          target: cnNode,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { edgeKind: 'tgw', label: att.segmentName ? `segment ${att.segmentName}` : 'core network', title: `Cloud WAN attachment ${att.id}`, refId: att.id },
        });
      }
    }
  }
}

/**
 * AWS Organizations governance tree, drawn under the management /
 * delegated-admin account (the only snapshot that carries org data). Renders
 * the Organization → root → OU hierarchy as nested containers, places each
 * member account inside its parent OU/root, and draws every SCP/RCP policy as a
 * node with `governs` edges to the roots/OUs/accounts it is attached to — so
 * the diagram shows which policy actually governs which slice of the estate.
 *
 * Containers are inserted parent-before-child (roots, then OUs ordered by
 * depth): the overview emits all containers before leaves, and React Flow
 * requires a parent node to precede its children.
 */
function addOrganization(b: Builder, account: AccountSnapshot): void {
  const g = account.global;
  const org = (g.organizations ?? [])[0];
  if (!org) return;

  const A = account.accountId;
  const acctId = `acct:${A}`;
  const orgLaneId = `org:${A}:${org.id}`;
  const rootContainerId = (rootId: string): string => `orgroot:${A}:${rootId}`;
  const ouContainerId = (ouId: string): string => `orgou:${A}:${ouId}`;
  const acctLeafId = (id: string): string => `orgacct:${A}:${id}`;
  const polLeafId = (id: string): string => `orgpol:${A}:${id}`;

  // --- Organization lane (outer container) ---
  ensureLane(b, orgLaneId, acctId, `Organization ${org.id}`, 'org', 'org');
  const orgLane = b.regions.get(orgLaneId);
  if (orgLane) {
    orgLane.data.subtitle =
      org.featureSet === 'ALL' ? 'all features'
      : org.featureSet === 'CONSOLIDATED_BILLING' ? 'consolidated billing'
      : undefined;
    orgLane.data.refId = org.arn ?? org.id;
  }

  // --- roots ---
  const roots = org.roots ?? [];
  const rootIds = new Set(roots.map((r) => r.id));
  for (const root of roots) {
    b.regions.set(rootContainerId(root.id), {
      id: rootContainerId(root.id),
      type: 'container',
      position: { x: 0, y: 0 },
      parentId: orgLaneId,
      data: {
        label: root.name ?? 'Root',
        subtitle: root.id,
        kind: 'org',
        isContainer: true,
        containerStyle: 'org',
        refId: root.arn ?? root.id,
      },
    });
  }
  const firstRoot = roots[0];
  const defaultParent = firstRoot ? rootContainerId(firstRoot.id) : orgLaneId;

  // --- OU tree: resolve a parent id to its container, insert shallow-first ---
  const ous = g.organizationalUnits ?? [];
  const ouById = new Map(ous.map((o) => [o.id, o]));
  const containerForParent = (parentId: string | undefined): string => {
    if (parentId && rootIds.has(parentId)) return rootContainerId(parentId);
    if (parentId && ouById.has(parentId)) return ouContainerId(parentId);
    return defaultParent;
  };
  const depthOf = (ouId: string): number => {
    let depth = 0;
    let cur = ouById.get(ouId);
    const seen = new Set<string>();
    while (cur?.parentId && ouById.has(cur.parentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      depth++;
      cur = ouById.get(cur.parentId);
    }
    return depth;
  };
  for (const ou of [...ous].sort((x, y) => depthOf(x.id) - depthOf(y.id))) {
    b.regions.set(ouContainerId(ou.id), {
      id: ouContainerId(ou.id),
      type: 'container',
      position: { x: 0, y: 0 },
      parentId: containerForParent(ou.parentId),
      data: {
        label: ou.name ?? ou.id,
        subtitle: 'OU',
        kind: 'org-ou',
        isContainer: true,
        containerStyle: 'org',
        refId: ou.arn ?? ou.id,
      },
    });
  }

  // --- member accounts, grouped into their parent container, capped per parent ---
  const accounts = g.organizationAccounts ?? [];
  const byParent = new Map<string, OrganizationAccount[]>();
  for (const a of accounts) {
    const c = containerForParent(a.parentId);
    const list = byParent.get(c);
    if (list) list.push(a);
    else byParent.set(c, [a]);
  }
  for (const [container, list] of byParent) {
    addCapped(b, list, CAP_ORG_ACCOUNTS, container, `note:orgacct:${container}`, 'member accounts', (a) => {
      const badges: string[] = [];
      if (a.id === org.masterAccountId) badges.push('management');
      if (a.status && a.status !== 'ACTIVE') badges.push(a.status.toLowerCase().replace(/_/g, ' '));
      leafNode(b, acctLeafId(a.id), container, 'org-account', a.name ?? a.id, a.id, a.arn ?? a.id, badges);
    });
  }

  // --- policies (SCP/RCP/…): a sub-lane of nodes with `governs` edges to targets ---
  const policies = g.organizationPolicies ?? [];
  if (policies.length > 0) {
    const polLaneId = `orgpol-lane:${A}`;
    ensureLane(b, polLaneId, orgLaneId, 'Policies', 'org-policy', 'org');
    const acctIds = new Set(accounts.map((a) => a.id));
    const targetNodeId = (targetId: string): string | undefined =>
      rootIds.has(targetId) ? rootContainerId(targetId)
      : ouById.has(targetId) ? ouContainerId(targetId)
      : acctIds.has(targetId) ? acctLeafId(targetId)
      : undefined;
    addCapped(b, policies, CAP_ORG_POLICIES, polLaneId, `note:orgpol:${A}`, 'policies', (p) => {
      const kindLabel = p.type.replace(/_POLICY$/, '').replace(/_/g, ' ').toLowerCase();
      const badges = [
        ...(p.awsManaged ? ['AWS-managed'] : []),
        `${p.targets.length} target${p.targets.length === 1 ? '' : 's'}`,
      ];
      leafNode(b, polLeafId(p.id), polLaneId, 'org-policy', p.name, kindLabel, p.arn ?? p.id, badges);
      for (const t of p.targets.slice(0, CAP_ORG_POLICY_TARGETS)) {
        const target = targetNodeId(t.targetId);
        if (!target) continue;
        const key = `governs:${A}:${p.id}:${t.targetId}`;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: polLeafId(p.id),
          target,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'governs',
            label: kindLabel,
            title: `${p.name} → ${t.name ?? t.targetId}`,
            refId: p.arn ?? p.id,
          },
        });
      }
    });
  }
}

/**
 * Regional security & edge services: KMS keys, secrets, ACM certs, API
 * gateways, Client VPN endpoints, and resolver-rule DNS forwarding paths.
 */
function addRegionServices(
  b: Builder,
  index: AtlasIndex,
  account: AccountSnapshot,
  region: RegionSnapshot,
): void {
  const regionId = `region:${account.accountId}:${region.region}`;

  // KMS: customer-managed keys as nodes; AWS-managed keys folded into a note.
  const customerKeys = region.kmsKeys.filter((k) => k.keyManager !== 'AWS');
  const awsKeys = region.kmsKeys.filter((k) => k.keyManager === 'AWS');
  addCapped(b, customerKeys, CAP_SERVICES, regionId, `note:${regionId}:kms`, 'KMS keys', (k) =>
    leafNode(b, `kms:${k.id}`, regionId, 'kms', k.aliases[0]?.replace(/^alias\//, '') ?? k.name ?? k.id,
      'KMS · customer-managed', k.arn ?? k.id, k.rotationEnabled ? ['rotation'] : undefined),
  );
  if (awsKeys.length > 0) {
    b.leaves.set(`note:${regionId}:awskms`, {
      id: `note:${regionId}:awskms`,
      type: 'note',
      position: { x: 0, y: 0 },
      parentId: regionId,
      width: 230,
      height: 58,
      data: {
        label: `${awsKeys.length} AWS-managed KMS key${awsKeys.length === 1 ? '' : 's'}`,
        subtitle: destsLabel(awsKeys.flatMap((k) => k.aliases), 3),
        kind: 'note',
      },
    });
  }

  // Secrets (+ the KMS key encrypting them).
  addCapped(b, region.secrets, CAP_SERVICES, regionId, `note:${regionId}:secrets`, 'secrets', (s) => {
    leafNode(b, `secret:${s.id}`, regionId, 'secret', s.name ?? s.id, s.description ?? 'secret', s.arn ?? s.id,
      s.rotationEnabled ? ['rotated'] : ['no rotation']);
    const key = s.kmsKeyId
      ? region.kmsKeys.find((k) => k.id === s.kmsKeyId || k.arn === s.kmsKeyId || k.aliases.includes(s.kmsKeyId!))
      : undefined;
    if (key && b.leaves.has(`kms:${key.id}`)) {
      const edgeKey = `seckms:${s.id}`;
      b.edges.set(edgeKey, {
        id: `edge:${edgeKey}`,
        source: `secret:${s.id}`,
        target: `kms:${key.id}`,
        type: 'annotated',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'uses', label: 'encrypted by', title: `${s.name ?? s.id} encrypted with ${key.aliases[0] ?? key.id}`, refId: key.arn ?? key.id },
      });
    }
  });

  // ACM certificates (+ who uses them, resolved to the consumer's VPC).
  addCapped(b, region.acmCertificates, CAP_SERVICES, regionId, `note:${regionId}:acm`, 'certificates', (cert) => {
    const certNode = leafNode(b, `acm:${cert.id}`, regionId, 'acm', cert.domainName ?? cert.name ?? cert.id,
      [cert.status, cert.certType].filter(Boolean).join(' · ') || 'certificate', cert.arn ?? cert.id,
      cert.inUseBy.length === 0 ? ['unused'] : undefined);
    for (const userArn of cert.inUseBy) {
      const ref = index.byKey.get(userArn);
      if (!ref?.vpcId) continue;
      const vpcNode = ensureVpcNode(b, ref.vpcId, ref.accountId, ref.region);
      if (!vpcNode) continue;
      const key = `certuse:${cert.id}|${vpcNode}`;
      b.edges.set(key, {
        id: `edge:${key}`,
        source: vpcNode,
        target: certNode,
        type: 'annotated',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'uses', label: `TLS · ${ref.name ?? ref.kind}`, title: `${ref.name ?? ref.id} uses certificate ${cert.domainName ?? cert.id}`, refId: cert.arn ?? cert.id },
      });
    }
  });

  // API gateways: public ones hang off the internet; private ones off their VPC.
  addCapped(b, region.apiGateways, CAP_SERVICES, regionId, `note:${regionId}:apigw`, 'API gateways', (api) => {
    const apiNode = leafNode(b, `apigw:${api.id}`, regionId, 'apigw', api.name ?? api.id,
      [api.protocolType, api.endpointType].filter(Boolean).join(' · ') || 'API gateway', api.arn ?? api.id);
    if (api.endpointType === 'PRIVATE') {
      for (const vpceId of api.vpcEndpointIds) {
        const vpce = region.vpcEndpoints.find((e) => e.id === vpceId);
        const vpcNode = vpce ? ensureVpcNode(b, vpce.vpcId, account.accountId, region.region) : undefined;
        if (!vpcNode) continue;
        const key = `apigwpriv:${api.id}|${vpcNode}`;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: vpcNode,
          target: apiNode,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { edgeKind: 'edge-service', label: `private API · ${vpceId}`, title: `Private API ${api.name ?? api.id} via ${vpceId}`, refId: api.arn ?? api.id },
        });
      }
    } else {
      const key = `inet-apigw:${api.id}`;
      b.edges.set(key, {
        id: `edge:${key}`,
        source: ensureInternet(b),
        target: apiNode,
        type: 'annotated',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'edge-service', label: 'public API', title: `Internet → API gateway ${api.name ?? api.id}`, refId: api.arn ?? api.id },
      });
    }
  });

  // Client VPN endpoints: internet → endpoint → its VPC.
  for (const cvpn of region.clientVpnEndpoints) {
    const cvpnNode = leafNode(b, `cvpn:${cvpn.id}`, regionId, 'client-vpn', cvpn.name ?? cvpn.id,
      cvpn.clientCidrBlock ? `clients ${cvpn.clientCidrBlock}` : 'Client VPN', cvpn.arn ?? cvpn.id,
      cvpn.splitTunnel ? ['split tunnel'] : undefined);
    const inKey = `inet-cvpn:${cvpn.id}`;
    b.edges.set(inKey, {
      id: `edge:${inKey}`,
      source: ensureInternet(b),
      target: cvpnNode,
      type: 'annotated',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { edgeKind: 'edge-service', label: 'client VPN', title: `Internet → Client VPN ${cvpn.name ?? cvpn.id}`, refId: cvpn.arn ?? cvpn.id },
    });
    const vpcNode = ensureVpcNode(b, cvpn.vpcId, account.accountId, region.region);
    if (vpcNode) {
      const key = `cvpnvpc:${cvpn.id}`;
      b.edges.set(key, {
        id: `edge:${key}`,
        source: cvpnNode,
        target: vpcNode,
        type: 'annotated',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'vpn', label: cvpn.clientCidrBlock ?? 'client VPN', title: `Client VPN ${cvpn.name ?? cvpn.id} → ${cvpn.vpcId}`, refId: cvpn.arn ?? cvpn.id },
      });
    }
  }

  // WAF (REGIONAL): the ACL protecting each ALB/API/AppSync, resolved to its VPC.
  addCapped(b, region.wafWebAcls ?? [], CAP_SERVICES, regionId, `note:${regionId}:waf`, 'WAF web ACLs', (acl) => {
    const aclNode = leafNode(b, `waf:${acl.arn ?? acl.id}`, regionId, 'waf-web-acl', acl.name ?? acl.id,
      `WAF · ${acl.rules.length} rule${acl.rules.length === 1 ? '' : 's'}`, acl.arn ?? acl.id,
      acl.associatedResourceArns.length === 0 ? ['unattached'] : undefined);
    for (const resourceArn of acl.associatedResourceArns) {
      const ref = index.byKey.get(resourceArn);
      if (!ref?.vpcId) continue;
      const vpcNode = ensureVpcNode(b, ref.vpcId, ref.accountId, ref.region);
      if (!vpcNode) continue;
      const key = `wafprot:${acl.id}|${vpcNode}`;
      if (b.edges.has(key)) continue;
      b.edges.set(key, {
        id: `edge:${key}`,
        source: aclNode,
        target: vpcNode,
        type: 'annotated',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'uses', label: `protects ${ref.name ?? ref.kind}`, title: `${acl.name ?? acl.id} protects ${ref.name ?? resourceArn}`, refId: acl.arn ?? acl.id },
      });
    }
  });

  // API Gateway custom domains → the APIs their mappings serve.
  addCapped(b, region.apiGatewayDomainNames ?? [], CAP_SERVICES, regionId, `note:${regionId}:apigwdom`, 'API custom domains', (d) => {
    const domNode = leafNode(b, `apigwdom:${d.id}`, regionId, 'apigw-domain', d.domainName,
      'API custom domain', d.id);
    for (const mapping of d.mappings) {
      if (!mapping.apiId || !b.leaves.has(`apigw:${mapping.apiId}`)) continue;
      const key = `apimap:${d.id}|${mapping.apiId}|${mapping.stage ?? ''}`;
      if (b.edges.has(key)) continue;
      b.edges.set(key, {
        id: `edge:${key}`,
        source: domNode,
        target: `apigw:${mapping.apiId}`,
        type: 'annotated',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'edge-service', label: mapping.stage ? `stage ${mapping.stage}` : 'custom domain', title: `${d.domainName} → API ${mapping.apiId}`, refId: d.id },
      });
    }
  });

  // Resolver FORWARD rules: VPC → on-prem DNS target (the rule is the edge).
  for (const rule of region.resolverRules) {
    if (rule.ruleType !== 'FORWARD' || rule.targetIps.length === 0) continue;
    const targetNode = leafNode(b, `dnst:${rule.id}`, ensureExt(b), 'dns-target', rule.domainName ?? rule.id,
      rule.targetIps.join(', '), rule.arn ?? rule.id);
    for (const vpcId of rule.vpcAssociationIds) {
      const vpcNode = ensureVpcNode(b, vpcId, account.accountId, region.region);
      if (!vpcNode) continue;
      const key = `rslvr:${rule.id}|${vpcNode}`;
      b.edges.set(key, {
        id: `edge:${key}`,
        source: vpcNode,
        target: targetNode,
        type: 'annotated',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'dns', label: `DNS ${rule.domainName ?? ''}`.trim(), title: `Resolver rule ${rule.name ?? rule.id}`, refId: rule.id },
      });
    }
  }
}

/**
 * Route 53 ALIAS records → the edge resources they point at. Only targets the
 * overview actually draws as nodes (CloudFront, Global Accelerator, API GW,
 * API GW custom domains) — load balancers live on the VPC drill-down, not here.
 * Runs after every account's nodes are built so cross-account aliases resolve.
 */
function addDnsAliasEdges(b: Builder, index: AtlasIndex): void {
  const normalize = (name: string): string => name.toLowerCase().replace(/\.$/, '');

  // dnsName → overview node id, restricted to nodes that exist on the graph
  // (API gateways/domains are capped, so presence in b.leaves is the gate).
  const byDns = new Map<string, string>();
  const register = (dnsName: string | undefined, nodeId: string): void => {
    if (!dnsName || !b.leaves.has(nodeId)) return;
    const key = normalize(dnsName);
    if (key && !byDns.has(key)) byDns.set(key, nodeId);
  };
  for (const account of index.snapshot.accounts) {
    for (const dist of account.global.cloudFrontDistributions) {
      register(dist.domainName, `cf:${dist.id}`);
    }
    for (const ga of account.global.globalAccelerators ?? []) {
      register(ga.dnsName, `ga:${ga.id}`);
    }
    for (const region of account.regions) {
      for (const api of region.apiGateways) {
        register(api.apiEndpoint?.replace(/^https?:\/\//, ''), `apigw:${api.id}`);
      }
      for (const d of region.apiGatewayDomainNames ?? []) {
        register(d.domainName, `apigwdom:${d.id}`);
      }
    }
  }
  if (byDns.size === 0) return;

  for (const account of index.snapshot.accounts) {
    for (const zone of account.global.hostedZones) {
      const zoneNode = `zone:${account.accountId}:${zone.id}`;
      if (!b.leaves.has(zoneNode)) continue;
      for (const record of zone.records ?? []) {
        if (!record.aliasTarget) continue;
        const target = normalize(record.aliasTarget).replace(/^dualstack\./, '');
        const targetNode = byDns.get(target);
        if (!targetNode) continue;
        const key = `zonealias:${zoneNode}|${targetNode}`;
        if (b.edges.has(key)) continue;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: zoneNode,
          target: targetNode,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'dns',
            label: normalize(record.name) || 'alias',
            title: `${record.name} ALIAS → ${record.aliasTarget}`,
            refId: zone.id,
          },
        });
      }
    }
  }
}

/**
 * Identity Center permission-set assignments → the org member accounts they
 * grant access into. Runs after every account's nodes exist (permission sets
 * are drawn in addAccountGlobal, org-account leaves in addOrganization), so
 * both endpoints can be checked; assignments into accounts that are not on
 * the canvas (capped away, or no org data scanned) stay panel-only rather
 * than dangling.
 */
function addSsoAssignmentEdges(b: Builder, index: AtlasIndex): void {
  // accountId → its drawn org-account leaf (namespaced by the org-carrying account).
  const orgAcctNode = new Map<string, string>();
  for (const account of index.snapshot.accounts) {
    for (const a of account.global.organizationAccounts) {
      const nodeId = `orgacct:${account.accountId}:${a.id}`;
      if (b.leaves.has(nodeId) && !orgAcctNode.has(a.id)) orgAcctNode.set(a.id, nodeId);
    }
  }
  if (orgAcctNode.size === 0) return;

  for (const account of index.snapshot.accounts) {
    for (const ps of account.global.ssoPermissionSets) {
      const psNode = ssoNodeId(account.accountId, ps);
      if (!b.leaves.has(psNode)) continue;
      // One edge per (permission set, account) pair; principals fold into the label.
      const byAccount = new Map<string, string[]>();
      for (const a of ps.assignments) {
        const principal = a.principalName ?? a.principalType?.toLowerCase();
        const list = byAccount.get(a.accountId);
        if (list) {
          if (principal) list.push(principal);
        } else {
          byAccount.set(a.accountId, principal ? [principal] : []);
        }
      }
      for (const [accountId, principals] of byAccount) {
        const target = orgAcctNode.get(accountId);
        if (!target) continue;
        const key = `ssoassign:${psNode}|${accountId}`;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: psNode,
          target,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'sso-assign',
            label: destsLabel([...new Set(principals)], 2) || 'assigned',
            title: `${ps.name} assigned in ${index.accountLabel(accountId)}`,
            refId: ps.arn ?? ps.id,
          },
        });
      }
    }
  }
}

/** Cross-account assume-role trust: who can reach into which account. */
function addTrustEdges(b: Builder, index: AtlasIndex): void {
  for (const account of index.snapshot.accounts) {
    for (const role of account.global.iamRoles) {
      const roleNode = iamNodeId(account.accountId, role);
      if (!b.leaves.has(roleNode)) continue;
      for (const principal of trustedAccountPrincipals(role.assumeRolePolicyDocument, account.accountId)) {
        const src = b.accounts.has(`acct:${principal.accountId}`)
          ? `acct:${principal.accountId}`
          : ensureGhostAccount(b, principal.accountId);
        const key = `trust:${principal.accountId}|${roleNode}`;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: src,
          target: roleNode,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'trust',
            label: principal.mfa ? 'assume-role · MFA' : 'assume-role',
            title: `${index.accountLabel(principal.accountId)} can assume ${role.name ?? role.id}`,
            refId: role.arn ?? role.id,
          },
        });
      }
    }
  }
}

/** Build the global multi-account overview graph. */
export function buildOverview(index: AtlasIndex): AtlasGraph {
  const b: Builder = {
    accounts: new Map(),
    regions: new Map(),
    leaves: new Map(),
    edges: new Map(),
    extUsed: false,
  };

  // Load balancers by DNS name — resolves CloudFront origins across accounts.
  const lbByDns = new Map<string, { vpcId?: string; name?: string; accountId: string; region: string }>();
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const lb of region.loadBalancers) {
        if (lb.dnsName) {
          lbByDns.set(lb.dnsName, {
            vpcId: lb.vpcId,
            name: lb.name,
            accountId: account.accountId,
            region: region.region,
          });
        }
      }
    }
  }

  // --- scanned accounts, regions, VPCs, TGWs -------------------------------
  for (const account of index.snapshot.accounts) {
    const acctId = `acct:${account.accountId}`;
    // Roll up partial-scan failures: this account's own account-global errors
    // plus every region's errors. Drives the "scan incomplete" warning badge
    // and the details-panel error list.
    const accountErrors = [
      ...account.global.errors,
      ...account.regions.flatMap((r) => r.errors),
    ];
    b.accounts.set(acctId, {
      id: acctId,
      type: 'container',
      position: { x: 0, y: 0 },
      data: {
        label: account.alias ?? account.accountId,
        subtitle: account.alias ? account.accountId : account.profile,
        kind: 'group-account',
        isContainer: true,
        containerStyle: 'account',
        badges: accountErrors.length > 0
          ? [`⚠ scan incomplete — ${accountErrors.length} error${accountErrors.length === 1 ? '' : 's'}`]
          : undefined,
        errors: accountErrors.length > 0 ? accountErrors : undefined,
      },
    });

    for (const region of account.regions) {
      const regionId = `region:${account.accountId}:${region.region}`;
      b.regions.set(regionId, {
        id: regionId,
        type: 'container',
        position: { x: 0, y: 0 },
        parentId: acctId,
        data: {
          label: region.region,
          subtitle: region.empty ? '(empty)' : undefined,
          kind: 'group-region',
          isContainer: true,
          containerStyle: region.empty ? 'ghost' : 'region',
          // A region whose scan hit permission (or other) errors is only
          // partially populated — flag it so the incomplete data is obvious.
          badges: region.errors.length > 0
            ? [`⚠ ${region.errors.length} scan error${region.errors.length === 1 ? '' : 's'}`]
            : undefined,
          errors: region.errors.length > 0 ? region.errors : undefined,
        },
      });

      for (const vpc of region.vpcs) {
        const id = `vpc:${vpc.id}`;
        const openSgCount = region.securityGroups.filter(
          (g) => g.vpcId === vpc.id && worldOpenIngress(g).length > 0,
        ).length;
        b.leaves.set(id, {
          id,
          type: 'resource',
          position: { x: 0, y: 0 },
          parentId: regionId,
          width: 210,
          height: 92,
          data: {
            label: vpc.name ?? vpc.id,
            subtitle: vpc.cidrBlocks.join(', ') || undefined,
            kind: 'vpc',
            refId: vpc.id,
            drillVpcId: vpc.id,
            badges: [
              ...(vpc.isDefault ? ['default'] : []),
              `${region.subnets.filter((s) => s.vpcId === vpc.id).length} subnets`,
              ...(openSgCount > 0 ? [`${openSgCount} internet-open SG${openSgCount === 1 ? '' : 's'}`] : []),
            ],
          },
        });
      }

      addRegionServices(b, index, account, region);
    }

    addAccountGlobal(b, index, account, lbByDns);
    addOrganization(b, account);

    if (account.emptyRegions.length > 0) {
      const shown = account.emptyRegions.slice(0, 6);
      const extra = account.emptyRegions.length - shown.length;
      b.leaves.set(`note:${acctId}`, {
        id: `note:${acctId}`,
        type: 'note',
        position: { x: 0, y: 0 },
        parentId: acctId,
        width: 250,
        height: 64,
        data: {
          label: `${account.emptyRegions.length} empty region(s) hidden`,
          subtitle: shown.join(', ') + (extra > 0 ? ` +${extra}` : ''),
          kind: 'note',
        },
      });
    }
  }

  // --- cross-account IAM trust edges ----------------------------------------
  addTrustEdges(b, index);

  // --- SSO permission-set assignment edges → drawn org-account nodes ---------
  addSsoAssignmentEdges(b, index);

  // --- Route 53 ALIAS records → CloudFront/GA/API GW nodes -------------------
  addDnsAliasEdges(b, index);

  // TGWs: prefer placing under the owner account's region.
  for (const pass of ['owner', 'other'] as const) {
    for (const account of index.snapshot.accounts) {
      for (const region of account.regions) {
        for (const tgw of region.transitGateways) {
          const isOwner = tgw.ownerId === account.accountId;
          if ((pass === 'owner') !== isOwner) continue;
          const id = `tgw:${tgw.id}`;
          if (b.leaves.has(id)) continue;
          b.leaves.set(id, {
            id,
            type: 'resource',
            position: { x: 0, y: 0 },
            parentId: `region:${account.accountId}:${region.region}`,
            width: 150,
            height: 96,
            data: {
              label: tgw.name ?? tgw.id,
              subtitle: tgw.description ?? undefined,
              kind: 'tgw',
              refId: tgw.id,
            },
          });
        }
      }
    }
  }

  // --- peering edges (deduped across accounts by pcx id) -------------------
  const peerings = new Map<string, { pcx: VpcPeeringConnection }>();
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const pcx of region.peeringConnections) {
        if (!peerings.has(pcx.id)) peerings.set(pcx.id, { pcx });
      }
    }
  }
  for (const { pcx } of peerings.values()) {
    const src = ensureVpcNode(b, pcx.requester.vpcId, pcx.requester.accountId, pcx.requester.region);
    const tgt = ensureVpcNode(b, pcx.accepter.vpcId, pcx.accepter.accountId, pcx.accepter.region);
    if (!src || !tgt) continue;

    const routes: RouteDetail[] = [];
    const dests: string[] = [];
    for (const side of [pcx.requester, pcx.accepter]) {
      if (!side.vpcId || !side.accountId || !side.region) continue;
      const regionSnap = index.findRegion(side.accountId, side.region);
      if (!regionSnap) continue;
      for (const r of subnetRoutes(regionSnap, side.vpcId)) {
        if (r.targetId !== pcx.id) continue;
        routes.push({ from: `${side.vpcId} / ${r.from}`, dest: r.dest, state: r.state });
        dests.push(r.dest);
      }
    }

    const statusSuffix = pcx.status && pcx.status !== 'active' ? ` (${pcx.status})` : '';
    b.edges.set(pcx.id, {
      id: `edge:${pcx.id}`,
      source: src,
      target: tgt,
      type: 'annotated',
      markerStart: { type: MarkerType.ArrowClosed },
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        edgeKind: 'peering',
        label: (destsLabel(dests) || 'VPC peering') + statusSuffix,
        title: `VPC peering ${pcx.name ?? pcx.id}`,
        routes,
        refId: pcx.id,
      },
    });
  }

  // --- transit gateway attachment edges ------------------------------------
  const tgwAttachments = new Map<string, TransitGatewayAttachment>();
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const att of region.transitGatewayAttachments) {
        const existing = tgwAttachments.get(att.id);
        // Prefer the copy with subnet detail (visible in the VPC-owner account).
        if (!existing || (existing.subnetIds.length === 0 && att.subnetIds.length > 0)) {
          tgwAttachments.set(att.id, att);
        }
      }
    }
  }

  for (const att of tgwAttachments.values()) {
    if (att.resourceType === 'vpc' && att.resourceId) {
      const src = ensureVpcNode(b, att.resourceId, att.resourceOwnerId, undefined);
      const tgt = ensureTgwNode(b, att.transitGatewayId, att.transitGatewayOwnerId);
      if (!src || !tgt) continue;
      const pairKey = `tgwvpc:${att.resourceId}|${att.transitGatewayId}`;
      if (b.edges.has(pairKey)) continue;

      const routes: RouteDetail[] = [];
      const dests: string[] = [];
      // VPC -> TGW routes, subnet-level (visible when the VPC's account is scanned).
      const vpcRef = index.byKey.get(att.resourceId);
      if (vpcRef) {
        const regionSnap = index.findRegion(vpcRef.accountId, vpcRef.region);
        if (regionSnap) {
          for (const r of subnetRoutes(regionSnap, att.resourceId)) {
            if (r.targetId !== att.transitGatewayId) continue;
            routes.push({ from: r.from, dest: r.dest, state: r.state });
            dests.push(r.dest);
          }
        }
      }
      // TGW -> VPC routes (from the TGW owner's route tables toward this attachment).
      const tgwRef = index.byKey.get(att.transitGatewayId);
      if (tgwRef) {
        const regionSnap = index.findRegion(tgwRef.accountId, tgwRef.region);
        for (const rt of regionSnap?.transitGatewayRouteTables ?? []) {
          for (const route of rt.routes) {
            if (!route.attachmentIds.includes(att.id)) continue;
            routes.push({
              from: `TGW ${rt.name ?? rt.id}`,
              dest: route.destinationCidr ?? route.prefixListId ?? '?',
              state: route.state,
              routeType: route.routeType,
            });
          }
        }
      }

      const stateSuffix = att.state && att.state !== 'available' ? ` (${att.state})` : '';
      b.edges.set(pairKey, {
        id: `edge:${att.id}`,
        source: src,
        target: tgt,
        type: 'annotated',
        markerStart: { type: MarkerType.ArrowClosed },
        markerEnd: { type: MarkerType.ArrowClosed },
        data: {
          edgeKind: 'tgw',
          label: (destsLabel(dests) || 'TGW attachment') + stateSuffix,
          title: `TGW attachment ${att.name ?? att.id}`,
          routes,
          refId: att.id,
        },
      });
    } else if ((att.resourceType === 'peering' || att.resourceType === 'tgw-peering') && att.peer?.transitGatewayId) {
      const a = ensureTgwNode(b, att.transitGatewayId, att.transitGatewayOwnerId);
      const z = ensureTgwNode(b, att.peer.transitGatewayId, att.peer.accountId);
      if (!a || !z) continue;
      const pairKey = 'tgwpeer:' + [a, z].sort().join('|');
      if (b.edges.has(pairKey)) continue;
      b.edges.set(pairKey, {
        id: `edge:${att.id}`,
        source: a,
        target: z,
        type: 'annotated',
        markerStart: { type: MarkerType.ArrowClosed },
        markerEnd: { type: MarkerType.ArrowClosed },
        data: {
          edgeKind: 'tgw',
          label: `TGW peering${att.peer.region ? ` · ${att.peer.region}` : ''}`,
          title: `TGW peering attachment ${att.name ?? att.id}`,
          refId: att.id,
        },
      });
    }
  }

  // --- VPN connections ------------------------------------------------------
  for (const account of index.snapshot.accounts) {
    const vgwVpc = new Map<string, string>();
    for (const region of account.regions) {
      for (const vgw of region.vpnGateways) {
        if (vgw.vpcIds[0]) vgwVpc.set(vgw.id, vgw.vpcIds[0]);
      }
    }
    for (const region of account.regions) {
      for (const vpn of region.vpnConnections) {
        if (b.edges.has(`vpn:${vpn.id}`)) continue;
        let src: string | undefined;
        if (vpn.transitGatewayId) src = ensureTgwNode(b, vpn.transitGatewayId);
        else if (vpn.vpnGatewayId) {
          const vpcId = vgwVpc.get(vpn.vpnGatewayId);
          src = ensureVpcNode(b, vpcId, account.accountId, region.region);
        }
        if (!src || !vpn.customerGatewayId) continue;

        const cgw = region.customerGateways.find((c) => c.id === vpn.customerGatewayId);
        const cgwNodeId = `cgw:${vpn.customerGatewayId}`;
        if (!b.leaves.has(cgwNodeId)) {
          b.leaves.set(cgwNodeId, {
            id: cgwNodeId,
            type: 'resource',
            position: { x: 0, y: 0 },
            parentId: ensureExt(b),
            width: 150,
            height: 96,
            data: {
              label: cgw?.name ?? vpn.customerGatewayId,
              subtitle: cgw?.ipAddress,
              kind: 'cgw',
              refId: vpn.customerGatewayId,
            },
          });
        }
        b.edges.set(`vpn:${vpn.id}`, {
          id: `edge:${vpn.id}`,
          source: src,
          target: cgwNodeId,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'vpn',
            label: `${vpn.name ?? vpn.id}${vpn.state && vpn.state !== 'available' ? ` (${vpn.state})` : ''}`,
            title: `Site-to-Site VPN ${vpn.name ?? vpn.id}`,
            routes: vpn.tunnels.map((t, i) => ({
              from: `tunnel ${i + 1}`,
              dest: t.outsideIp ?? '?',
              state: t.status,
            })),
            refId: vpn.id,
          },
        });
      }
    }
  }

  // --- Direct Connect gateways ---------------------------------------------
  // VGW ids are globally unique; a DX gateway in account A can associate with
  // a VGW owned by account B, so the lookup map must span every scanned account.
  const vgwVpcAll = new Map<string, { vpcId: string; accountId: string; region: string }>();
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const vgw of region.vpnGateways) {
        if (vgw.vpcIds[0]) {
          vgwVpcAll.set(vgw.id, {
            vpcId: vgw.vpcIds[0],
            accountId: account.accountId,
            region: region.region,
          });
        }
      }
    }
  }
  for (const account of index.snapshot.accounts) {
    for (const dxgw of account.global.directConnectGateways) {
      const nodeId = `dxgw:${dxgw.id}`;
      if (!b.leaves.has(nodeId)) {
        b.leaves.set(nodeId, {
          id: nodeId,
          type: 'resource',
          position: { x: 0, y: 0 },
          parentId: ensureExt(b),
          width: 150,
          height: 96,
          data: { label: dxgw.name ?? dxgw.id, subtitle: 'Direct Connect gateway', kind: 'dxgw', refId: dxgw.id },
        });
      }
      for (const assoc of dxgw.associations) {
        let tgt: string | undefined;
        if (assoc.associatedGatewayType === 'transitGateway') {
          tgt = ensureTgwNode(b, assoc.associatedGatewayId, assoc.associatedGatewayOwnerAccount);
        } else if (assoc.associatedGatewayType === 'virtualPrivateGateway' && assoc.associatedGatewayId) {
          const resolved = vgwVpcAll.get(assoc.associatedGatewayId);
          if (resolved) {
            tgt = ensureVpcNode(b, resolved.vpcId, resolved.accountId, resolved.region);
          } else {
            // Unscanned owner account: show a ghost VGW so the link stays visible.
            const ghostId = `vgw:${assoc.associatedGatewayId}`;
            if (!b.leaves.has(ghostId)) {
              b.leaves.set(ghostId, {
                id: ghostId,
                type: 'resource',
                position: { x: 0, y: 0 },
                parentId: assoc.associatedGatewayOwnerAccount
                  ? ensureGhostAccount(b, assoc.associatedGatewayOwnerAccount)
                  : undefined,
                width: 150,
                height: 96,
                data: {
                  label: assoc.associatedGatewayId,
                  subtitle: `VPN gateway${assoc.associatedGatewayRegion ? ` · ${assoc.associatedGatewayRegion}` : ''} · not scanned`,
                  kind: 'vgw',
                  refId: assoc.associatedGatewayId,
                  ghost: true,
                },
              });
            }
            tgt = ghostId;
          }
        }
        if (!tgt) continue;
        const key = `dx:${dxgw.id}|${tgt}`;
        if (b.edges.has(key)) continue;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: nodeId,
          target: tgt,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'dx',
            label: `DX association${assoc.state && assoc.state !== 'associated' ? ` (${assoc.state})` : ''}`,
            title: `Direct Connect gateway ${dxgw.name ?? dxgw.id}`,
            refId: dxgw.id,
          },
        });
      }
    }
  }

  // --- Direct Connect circuits: connection → (transit/private VIF) → target --
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      const connById = new Map((region.dxConnections ?? []).map((c) => [c.id, c]));
      for (const vif of region.dxVirtualInterfaces ?? []) {
        // The physical circuit the VIF rides.
        const conn = vif.connectionId ? connById.get(vif.connectionId) : undefined;
        const connNodeId = `dxconn:${vif.connectionId ?? vif.id}`;
        if (!b.leaves.has(connNodeId)) {
          b.leaves.set(connNodeId, {
            id: connNodeId,
            type: 'resource',
            position: { x: 0, y: 0 },
            parentId: ensureExt(b),
            width: 170,
            height: 96,
            data: {
              label: conn?.name ?? vif.connectionId ?? 'DX connection',
              subtitle: [conn?.location, conn?.bandwidth].filter(Boolean).join(' · ') || 'Direct Connect circuit',
              kind: 'dx-connection',
              refId: vif.connectionId ?? vif.id,
            },
          });
        }

        // Where the VIF lands: a DX gateway (transit/private) or a VGW's VPC.
        let tgt: string | undefined;
        if (vif.directConnectGatewayId) {
          const dxgwNodeId = `dxgw:${vif.directConnectGatewayId}`;
          if (!b.leaves.has(dxgwNodeId)) {
            b.leaves.set(dxgwNodeId, {
              id: dxgwNodeId,
              type: 'resource',
              position: { x: 0, y: 0 },
              parentId: ensureExt(b),
              width: 150,
              height: 96,
              data: { label: vif.directConnectGatewayId, subtitle: 'Direct Connect gateway', kind: 'dxgw', refId: vif.directConnectGatewayId },
            });
          }
          tgt = dxgwNodeId;
        } else if (vif.virtualGatewayId) {
          const resolved = vgwVpcAll.get(vif.virtualGatewayId);
          if (resolved) tgt = ensureVpcNode(b, resolved.vpcId, resolved.accountId, resolved.region);
        }
        if (!tgt) continue;
        const key = `dxvif:${vif.id}`;
        if (b.edges.has(key)) continue;
        b.edges.set(key, {
          id: `edge:${key}`,
          source: connNodeId,
          target: tgt,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: 'dx',
            label: `${vif.vifType ?? ''} VIF${vif.vlan !== undefined ? ` · vlan ${vif.vlan}` : ''}`.trim(),
            title: `Virtual interface ${vif.name ?? vif.id}${vif.state && vif.state !== 'available' ? ` (${vif.state})` : ''}`,
            routes: (vif.bgpPeers ?? []).map((p) => ({
              from: `BGP AS${p.asn ?? '?'}`,
              dest: p.addressFamily ?? 'ipv4',
              state: p.status ?? p.state,
            })),
            refId: vif.id,
          },
        });
      }
    }
  }

  // --- assemble: parents strictly before children ---------------------------
  const nodes: AtlasNode[] = [];
  if (b.extUsed) {
    nodes.push({
      id: EXT_CONTAINER,
      type: 'container',
      position: { x: 0, y: 0 },
      data: {
        label: 'External / on-premises',
        kind: 'group-external',
        isContainer: true,
        containerStyle: 'external',
      },
    });
  }
  nodes.push(...b.accounts.values());
  nodes.push(...b.regions.values());
  nodes.push(...b.leaves.values());

  return { nodes, edges: [...b.edges.values()] };
}
