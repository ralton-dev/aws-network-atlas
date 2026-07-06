import { MarkerType } from '@xyflow/react';
import type {
  SecurityGroupRule,
  TransitGatewayAttachment,
  VpcPeeringConnection,
} from '@atlas/schema';
import type { AtlasIndex, ResourceRef } from '../data.js';
import {
  destsLabel,
  type AtlasEdge,
  type AtlasEdgeData,
  type AtlasGraph,
  type AtlasNode,
  type EdgeKind,
  type RouteDetail,
} from './graph-types.js';
import { portLabel, s3OriginBucket, trustedAccountPrincipals, worldOpenIngress } from './relations.js';
import { subnetRoutes, type SubnetRoute } from './routes.js';

/**
 * Focus (ego-graph) view: one resource and everything connected to it —
 * its security groups and what they allow, roles, placement, network routing,
 * DNS, load balancing — and NOTHING else from the rest of the estate.
 *
 * Two stages:
 *   1. collectRelations() flattens every relationship the snapshot encodes
 *      into (source, target, edge-data) triples keyed by canonical resource
 *      ids (the same relationships the overview / VPC-detail builders draw).
 *   2. buildFocus() runs a rule-based BFS from the center: ALL relations
 *      incident to the center, then a controlled expansion along meaningful
 *      chains (subnet → its routes, attached SG → its allow rules, LB →
 *      CloudFront → internet, VPC → private DNS, role → trust/policies).
 *      Expansion never walks "container → contents" (that would rebuild the
 *      whole VPC), and fan-out is capped per neighbor kind.
 */

const INTERNET = 'inet:public';
/** Max NEW neighbors of one kind added from a single node (declutter cap). */
const MAX_PER_KIND = 12;
/** Safety net — the chain rules terminate well before this. */
const MAX_DEPTH = 4;
const SG_RULE_COLUMNS: [string, string, string] = ['Source', 'Port / protocol', 'Description'];

interface Relation {
  key: string;
  source: string;
  target: string;
  /** Arrowheads on both ends (peering, TGW attachments). */
  biDir?: boolean;
  data: AtlasEdgeData;
}

// --- relationship index ------------------------------------------------------

function collectRelations(index: AtlasIndex): Relation[] {
  const rels = new Map<string, Relation>();
  const canon = (key: string): string => index.byKey.get(key)?.id ?? key;
  const nameOf = (key: string): string => index.byKey.get(key)?.name ?? key;

  const add = (
    key: string,
    source: string,
    target: string,
    data: AtlasEdgeData,
    biDir = false,
  ): void => {
    const src = canon(source);
    const tgt = canon(target);
    if (src === tgt || rels.has(key)) return;
    rels.set(key, { key, source: src, target: tgt, biDir, data });
  };

  const place = (id: string, parentId: string | undefined, label: string): void => {
    if (!parentId) return;
    add(`place:${id}|${parentId}`, id, parentId, {
      edgeKind: 'placement',
      label,
      title: `${nameOf(id)} ${label} ${nameOf(parentId)}`,
    });
  };

  // SG ↔ SG allow rules, merged per (source, target) pair across all regions.
  const sgRules = new Map<string, { src: string; tgt: string; refId: string; rows: RouteDetail[] }>();
  const addSgRule = (
    src: string,
    tgt: string,
    rule: SecurityGroupRule,
    refId: string,
    sourceLabel: string,
  ): void => {
    if (src === tgt) return; // self-references stay in the details panel
    const key = `sgrule:${src}|${tgt}`;
    const agg = sgRules.get(key) ?? { src, tgt, refId, rows: [] };
    const row: RouteDetail = { from: sourceLabel, dest: portLabel(rule), state: rule.description };
    if (!agg.rows.some((r) => r.from === row.from && r.dest === row.dest && r.state === row.state)) {
      agg.rows.push(row);
    }
    sgRules.set(key, agg);
  };

  // Cross-account lookups (CloudFront origins can live in other accounts).
  const lbByDns = new Map<string, string>();
  const s3ByName = new Map<string, string>();
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const lb of region.loadBalancers) {
        if (lb.dnsName && !lbByDns.has(lb.dnsName)) lbByDns.set(lb.dnsName, lb.id);
      }
    }
    for (const b of account.global.s3Buckets) {
      const name = b.name ?? b.id;
      if (!s3ByName.has(name)) s3ByName.set(name, b.id);
    }
  }

  for (const account of index.snapshot.accounts) {
    const g = account.global;
    const roleByName = new Map(g.iamRoles.map((r) => [r.name ?? r.id, r]));
    const roleByArn = new Map(g.iamRoles.flatMap((r) => (r.arn ? [[r.arn, r] as const] : [])));
    const profileByKey = new Map<string, (typeof g.iamInstanceProfiles)[number]>();
    for (const p of g.iamInstanceProfiles) {
      profileByKey.set(p.id, p);
      if (p.arn) profileByKey.set(p.arn, p);
    }
    const roleKey = (role: { id: string; arn?: string }): string => role.arn ?? role.id;

    for (const region of account.regions) {
      // --- placement ("where does this live") --------------------------------
      for (const s of region.subnets) place(s.id, s.vpcId, 'in VPC');
      for (const sg of region.securityGroups) place(sg.id, sg.vpcId, 'in VPC');
      for (const i of region.instances) place(i.id, i.subnetId, 'in subnet');
      for (const n of region.natGateways) place(n.id, n.subnetId, 'in subnet');
      for (const gw of region.internetGateways) for (const v of gw.vpcIds) place(gw.id, v, 'attached to');
      for (const gw of region.egressOnlyInternetGateways) place(gw.id, gw.vpcId, 'attached to');
      for (const gw of region.vpnGateways) for (const v of gw.vpcIds) place(gw.id, v, 'attached to');
      for (const lb of region.loadBalancers) for (const s of lb.subnetIds) place(lb.id, s, 'in subnet');
      for (const fn of region.lambdaFunctions) {
        const cfg = fn.vpcConfig;
        if (!cfg) continue;
        if (cfg.subnetIds.length > 0) for (const s of cfg.subnetIds) place(fn.id, s, 'in subnet');
        else place(fn.id, cfg.vpcId, 'in VPC');
      }
      for (const r of region.rdsInstances) for (const s of r.subnetIds) place(r.id, s, 'subnet group');
      for (const c of region.rdsClusters) place(c.id, c.vpcId, 'in VPC');
      for (const svc of region.ecsServices) for (const s of svc.subnetIds) place(svc.id, s, 'in subnet');
      for (const e of region.eksClusters) place(e.id, e.vpcId, 'in VPC');
      for (const c of region.elastiCacheClusters) for (const s of c.subnetIds) place(c.id, s, 'subnet group');
      for (const ep of region.vpcEndpoints) {
        if (ep.subnetIds.length > 0) for (const s of ep.subnetIds) place(ep.id, s, 'in subnet');
        else place(ep.id, ep.vpcId, 'in VPC');
      }
      for (const ep of region.resolverEndpoints) for (const s of ep.subnetIds) place(ep.id, s, 'in subnet');
      for (const fw of region.networkFirewalls) for (const s of fw.subnetIds) place(fw.id, s, 'in subnet');

      // --- subnet routing (grouped per subnet|target, like the VPC detail) ---
      for (const vpc of region.vpcs) {
        const grouped = new Map<string, SubnetRoute[]>();
        for (const r of subnetRoutes(region, vpc.id)) {
          if (!r.subnetId) continue;
          const key = `${r.subnetId}|${r.targetId}`;
          const list = grouped.get(key);
          if (list) list.push(r);
          else grouped.set(key, [r]);
        }
        for (const [key, group] of grouped) {
          const [subnetId, targetId] = key.split('|') as [string, string];
          const sample = group[0]!;
          const kind: EdgeKind =
            sample.targetType === 'tgw' ? 'tgw' : sample.targetType === 'pcx' ? 'peering' : 'route';
          const hasBlackhole = group.some((r) => r.state === 'blackhole');
          add(`route:${key}`, subnetId, targetId, {
            edgeKind: kind,
            label: destsLabel(group.map((r) => r.dest), 2) + (hasBlackhole ? ' ⚠' : ''),
            title: `Routes ${sample.from} → ${nameOf(targetId)}`,
            routes: group.map((r) => ({ from: r.from, dest: r.dest, state: r.state })),
            refId: targetId,
          });
        }
      }
      // IGW → internet completes the egress path.
      for (const gw of region.internetGateways) {
        add(`inetigw:${gw.id}`, gw.id, INTERNET, {
          edgeKind: 'route',
          label: 'egress',
          title: `${gw.name ?? gw.id} → internet`,
          refId: gw.id,
        });
      }

      // --- security groups: applies-to, allow rules, internet exposure -------
      const sgAttach: Array<{ id: string; sgIds: string[] }> = [
        ...region.instances.map((i) => ({ id: i.id, sgIds: i.securityGroupIds })),
        ...region.loadBalancers.map((l) => ({ id: l.id, sgIds: l.securityGroupIds })),
        ...region.rdsInstances.map((r) => ({ id: r.id, sgIds: r.securityGroupIds })),
        ...region.rdsClusters.map((c) => ({ id: c.id, sgIds: c.securityGroupIds })),
        ...region.elastiCacheClusters.map((c) => ({ id: c.id, sgIds: c.securityGroupIds })),
        ...region.lambdaFunctions.map((f) => ({ id: f.id, sgIds: f.vpcConfig?.securityGroupIds ?? [] })),
        ...region.ecsServices.map((s) => ({ id: s.id, sgIds: s.securityGroupIds })),
        ...region.eksClusters.map((e) => ({ id: e.id, sgIds: e.securityGroupIds })),
        ...region.resolverEndpoints.map((e) => ({ id: e.id, sgIds: e.securityGroupIds })),
        ...region.clientVpnEndpoints.map((c) => ({ id: c.id, sgIds: c.securityGroupIds })),
      ];
      for (const { id, sgIds } of sgAttach) {
        for (const sgId of sgIds) {
          add(`sgatt:${sgId}|${id}`, sgId, id, {
            edgeKind: 'sg-attach',
            label: 'applies to',
            title: `${nameOf(sgId)} applies to ${nameOf(id)}`,
            refId: sgId,
          });
        }
      }
      for (const sg of region.securityGroups) {
        for (const rule of sg.ingress) {
          for (const ref of rule.securityGroupRefs) {
            addSgRule(ref.groupId, sg.id, rule, sg.id, nameOf(ref.groupId));
          }
        }
        for (const rule of sg.egress) {
          for (const ref of rule.securityGroupRefs) {
            addSgRule(sg.id, ref.groupId, rule, sg.id, nameOf(sg.id));
          }
        }
        const open = worldOpenIngress(sg);
        if (open.length > 0) {
          add(`sgopen:${sg.id}`, INTERNET, sg.id, {
            edgeKind: 'sg-open',
            label: destsLabel(open.map(portLabel), 2),
            title: `Open to internet: ${sg.name ?? sg.id}`,
            columns: SG_RULE_COLUMNS,
            routes: open.map((r) => ({
              from: r.cidrs.includes('0.0.0.0/0') ? '0.0.0.0/0' : '::/0',
              dest: portLabel(r),
              state: r.description,
            })),
            refId: sg.id,
          });
        }
      }

      // --- load balancing & grouping ------------------------------------------
      for (const lb of region.loadBalancers) {
        const tgArns = new Set(lb.listeners.flatMap((l) => l.targetGroupArns));
        for (const tg of region.targetGroups.filter(
          (t) => t.loadBalancerArns.includes(lb.id) || tgArns.has(t.id),
        )) {
          for (const target of tg.targets) {
            add(`assoc:${lb.id}|${target.targetId}`, lb.id, target.targetId, {
              edgeKind: 'assoc',
              label: tg.port ? `${tg.protocol ?? ''} ${tg.port}`.trim() : 'target',
              title: `${lb.name ?? lb.id} → ${nameOf(target.targetId)} (${tg.name ?? 'target group'})`,
              refId: tg.id,
            });
          }
        }
      }
      for (const asg of region.autoScalingGroups) {
        for (const instId of asg.instanceIds) {
          add(`asgmem:${asg.id}|${instId}`, asg.id, instId, {
            edgeKind: 'assoc',
            label: 'ASG member',
            title: `${asg.name ?? asg.id} manages ${nameOf(instId)}`,
            refId: asg.id,
          });
        }
      }
      for (const r of region.rdsInstances) {
        if (!r.clusterId) continue;
        add(`rdsmem:${r.id}`, r.id, r.clusterId, {
          edgeKind: 'assoc',
          label: 'cluster member',
          title: `${r.name ?? r.id} is a member of ${nameOf(r.clusterId)}`,
          refId: r.clusterId,
        });
      }

      // --- identity: workloads → the roles they assume ------------------------
      for (const inst of region.instances) {
        if (!inst.instanceProfileArn) continue;
        const profile = profileByKey.get(inst.instanceProfileArn);
        const role = profile?.roleNames.map((n) => roleByName.get(n)).find((r) => r !== undefined);
        if (!role) continue;
        add(`assume:${inst.id}`, inst.id, roleKey(role), {
          edgeKind: 'uses',
          label: 'assumes role',
          title: `${inst.name ?? inst.id} assumes ${role.name ?? role.id} (via ${profile?.name ?? 'instance profile'})`,
          refId: roleKey(role),
        });
      }
      for (const fn of region.lambdaFunctions) {
        if (!fn.roleArn) continue;
        const role = roleByArn.get(fn.roleArn) ?? roleByName.get(fn.roleArn.split('/').pop() ?? '');
        if (!role) continue;
        add(`assume:${fn.id}`, fn.id, roleKey(role), {
          edgeKind: 'uses',
          label: 'assumes role',
          title: `${fn.name ?? fn.id} assumes ${role.name ?? role.id}`,
          refId: roleKey(role),
        });
      }

      // --- certificates, secrets ----------------------------------------------
      for (const cert of region.acmCertificates) {
        for (const userArn of cert.inUseBy) {
          add(`certuse:${cert.id}|${userArn}`, userArn, cert.id, {
            edgeKind: 'uses',
            label: 'TLS',
            title: `${nameOf(userArn)} uses certificate ${cert.domainName ?? cert.id}`,
            refId: cert.arn ?? cert.id,
          });
        }
      }
      for (const s of region.secrets) {
        const key = s.kmsKeyId
          ? region.kmsKeys.find(
              (k) => k.id === s.kmsKeyId || k.arn === s.kmsKeyId || k.aliases.includes(s.kmsKeyId!),
            )
          : undefined;
        if (!key) continue;
        add(`seckms:${s.id}`, s.id, key.id, {
          edgeKind: 'uses',
          label: 'encrypted by',
          title: `${s.name ?? s.id} encrypted with ${key.aliases[0] ?? key.id}`,
          refId: key.arn ?? key.id,
        });
      }

      // --- edge & DNS services --------------------------------------------------
      for (const api of region.apiGateways) {
        if (api.endpointType === 'PRIVATE') {
          for (const vpceId of api.vpcEndpointIds) {
            add(`apigwpriv:${api.id}|${vpceId}`, vpceId, api.id, {
              edgeKind: 'edge-service',
              label: 'private API',
              title: `Private API ${api.name ?? api.id} via ${vpceId}`,
              refId: api.arn ?? api.id,
            });
          }
        } else {
          add(`inetapi:${api.id}`, INTERNET, api.id, {
            edgeKind: 'edge-service',
            label: 'public API',
            title: `Internet → API gateway ${api.name ?? api.id}`,
            refId: api.arn ?? api.id,
          });
        }
      }
      for (const rule of region.resolverRules) {
        if (rule.targetIps.length === 0) continue;
        const label = `DNS ${rule.domainName ?? ''}`.trim();
        if (rule.resolverEndpointId) {
          add(`rslvrt:${rule.id}`, rule.resolverEndpointId, rule.id, {
            edgeKind: 'dns',
            label,
            title: `Resolver rule ${rule.name ?? rule.id}`,
            refId: rule.id,
          });
        }
        if (rule.ruleType === 'FORWARD') {
          for (const vpcId of rule.vpcAssociationIds) {
            add(`rslvr:${rule.id}|${vpcId}`, vpcId, rule.id, {
              edgeKind: 'dns',
              label,
              title: `Resolver rule ${rule.name ?? rule.id}`,
              refId: rule.id,
            });
          }
        }
      }
      for (const cvpn of region.clientVpnEndpoints) {
        add(`inetcvpn:${cvpn.id}`, INTERNET, cvpn.id, {
          edgeKind: 'edge-service',
          label: 'client VPN',
          title: `Internet → Client VPN ${cvpn.name ?? cvpn.id}`,
          refId: cvpn.id,
        });
        if (cvpn.vpcId) {
          add(`cvpnvpc:${cvpn.id}`, cvpn.id, cvpn.vpcId, {
            edgeKind: 'vpn',
            label: cvpn.clientCidrBlock ?? 'client VPN',
            title: `Client VPN ${cvpn.name ?? cvpn.id} → ${cvpn.vpcId}`,
            refId: cvpn.id,
          });
        }
        for (const subnetId of cvpn.associatedSubnetIds) {
          add(`cvpnsub:${cvpn.id}|${subnetId}`, cvpn.id, subnetId, {
            edgeKind: 'vpn',
            label: cvpn.clientCidrBlock ?? 'client VPN',
            title: `Client VPN ${cvpn.name ?? cvpn.id} association`,
            refId: cvpn.id,
          });
        }
      }
      for (const vpn of region.vpnConnections) {
        const src = vpn.transitGatewayId ?? vpn.vpnGatewayId;
        if (!src || !vpn.customerGatewayId) continue;
        add(`vpn:${vpn.id}`, src, vpn.customerGatewayId, {
          edgeKind: 'vpn',
          label: `${vpn.name ?? vpn.id}${vpn.state && vpn.state !== 'available' ? ` (${vpn.state})` : ''}`,
          title: `Site-to-Site VPN ${vpn.name ?? vpn.id}`,
          routes: vpn.tunnels.map((t, i) => ({
            from: `tunnel ${i + 1}`,
            dest: t.outsideIp ?? '?',
            state: t.status,
          })),
          refId: vpn.id,
        });
      }
    }

    // --- account-global: Route 53, CloudFront, IAM, Direct Connect -----------
    for (const zone of g.hostedZones) {
      for (const assoc of zone.vpcAssociations) {
        add(`zonedns:${zone.id}|${assoc.vpcId}`, zone.id, assoc.vpcId, {
          edgeKind: 'dns',
          label: 'private DNS',
          title: `${zone.zoneName} resolves in ${assoc.vpcId}`,
          refId: zone.id,
        });
      }
    }
    for (const dist of g.cloudFrontDistributions) {
      const cfKey = dist.arn ?? dist.id;
      add(`inetcf:${dist.id}`, INTERNET, cfKey, {
        edgeKind: 'edge-service',
        label: destsLabel(dist.aliases, 2) || 'HTTPS',
        title: `Internet → CloudFront ${dist.name ?? dist.id}`,
        refId: cfKey,
      });
      for (const origin of dist.origins) {
        const lbId = lbByDns.get(origin);
        if (lbId) {
          add(`cforig:${dist.id}|${lbId}`, cfKey, lbId, {
            edgeKind: 'edge-service',
            label: 'origin',
            title: `CloudFront origin ${origin}`,
            refId: cfKey,
          });
          continue;
        }
        const bucketName = s3OriginBucket(origin);
        if (bucketName) {
          const bucketKey = s3ByName.get(bucketName) ?? `s3ext:${bucketName}`;
          add(`cforig:${dist.id}|${bucketKey}`, cfKey, bucketKey, {
            edgeKind: 'edge-service',
            label: 'origin',
            title: `CloudFront origin ${origin}`,
            refId: cfKey,
          });
        }
      }
    }
    for (const u of g.iamUsers) {
      for (const groupName of u.groups) {
        const group = g.iamGroups.find((x) => x.id === groupName || x.name === groupName);
        if (!group) continue;
        add(`iamgrp:${account.accountId}:${u.id}|${group.id}`, u.arn ?? u.id, group.arn ?? group.id, {
          edgeKind: 'uses',
          label: 'member',
          title: `${u.name ?? u.id} is a member of ${groupName}`,
          refId: group.arn ?? group.id,
        });
      }
    }
    for (const p of g.iamInstanceProfiles) {
      for (const roleName of p.roleNames) {
        const role = g.iamRoles.find((r) => r.id === roleName || r.name === roleName);
        if (!role) continue;
        add(`iamprof:${account.accountId}:${p.id}`, p.arn ?? p.id, roleKey(role), {
          edgeKind: 'uses',
          label: 'instance profile',
          title: `${p.name ?? p.id} carries role ${roleName}`,
          refId: roleKey(role),
        });
      }
    }
    for (const role of g.iamRoles) {
      for (const principal of trustedAccountPrincipals(role.assumeRolePolicyDocument, account.accountId)) {
        add(`trust:${principal.accountId}|${roleKey(role)}`, `acct:${principal.accountId}`, roleKey(role), {
          edgeKind: 'trust',
          label: principal.mfa ? 'assume-role · MFA' : 'assume-role',
          title: `${index.accountLabel(principal.accountId)} can assume ${role.name ?? role.id}`,
          refId: roleKey(role),
        });
      }
      for (const policyArn of role.attachedManagedPolicyArns) {
        if (!index.byKey.has(policyArn)) continue; // AWS-managed — noise
        add(`iampol:${roleKey(role)}|${policyArn}`, roleKey(role), policyArn, {
          edgeKind: 'uses',
          label: 'policy',
          title: `${role.name ?? role.id} has policy ${nameOf(policyArn)}`,
          refId: policyArn,
        });
      }
    }
    for (const dxgw of g.directConnectGateways) {
      for (const assoc of dxgw.associations) {
        if (!assoc.associatedGatewayId) continue;
        add(`dx:${dxgw.id}|${assoc.associatedGatewayId}`, dxgw.id, assoc.associatedGatewayId, {
          edgeKind: 'dx',
          label: `DX association${assoc.state && assoc.state !== 'associated' ? ` (${assoc.state})` : ''}`,
          title: `Direct Connect gateway ${dxgw.name ?? dxgw.id}`,
          refId: dxgw.id,
        });
      }
    }
  }

  // --- cross-account: peering (VPC → PCX → VPC) and TGW attachments ----------
  const peerings = new Map<string, VpcPeeringConnection>();
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const pcx of region.peeringConnections) {
        if (!peerings.has(pcx.id)) peerings.set(pcx.id, pcx);
      }
    }
  }
  for (const pcx of peerings.values()) {
    const statusSuffix = pcx.status && pcx.status !== 'active' ? ` (${pcx.status})` : '';
    const label = (pcx.name ?? 'VPC peering') + statusSuffix;
    const title = `VPC peering ${pcx.name ?? pcx.id}`;
    if (pcx.requester.vpcId) {
      add(`pcxleg:${pcx.id}|req`, pcx.requester.vpcId, pcx.id, { edgeKind: 'peering', label, title, refId: pcx.id }, true);
    }
    if (pcx.accepter.vpcId) {
      add(`pcxleg:${pcx.id}|acc`, pcx.id, pcx.accepter.vpcId, { edgeKind: 'peering', label, title, refId: pcx.id }, true);
    }
  }

  const tgwAtts = new Map<string, TransitGatewayAttachment>();
  for (const account of index.snapshot.accounts) {
    for (const region of account.regions) {
      for (const att of region.transitGatewayAttachments) {
        const existing = tgwAtts.get(att.id);
        // Prefer the copy with subnet detail (visible in the VPC-owner account).
        if (!existing || (existing.subnetIds.length === 0 && att.subnetIds.length > 0)) {
          tgwAtts.set(att.id, att);
        }
      }
    }
  }
  for (const att of tgwAtts.values()) {
    if (att.resourceType === 'vpc' && att.resourceId) {
      const routes: RouteDetail[] = [];
      const dests: string[] = [];
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
      add(
        `tgwvpc:${att.resourceId}|${att.transitGatewayId}`,
        att.resourceId,
        att.transitGatewayId,
        {
          edgeKind: 'tgw',
          label: (destsLabel(dests) || 'TGW attachment') + stateSuffix,
          title: `TGW attachment ${att.name ?? att.id}`,
          routes,
          refId: att.id,
        },
        true,
      );
    } else if (
      (att.resourceType === 'peering' || att.resourceType === 'tgw-peering') &&
      att.peer?.transitGatewayId
    ) {
      const pairKey = 'tgwpeer:' + [att.transitGatewayId, att.peer.transitGatewayId].sort().join('|');
      add(pairKey, att.transitGatewayId, att.peer.transitGatewayId, {
        edgeKind: 'tgw',
        label: `TGW peering${att.peer.region ? ` · ${att.peer.region}` : ''}`,
        title: `TGW peering attachment ${att.name ?? att.id}`,
        refId: att.id,
      }, true);
    }
  }

  for (const [key, agg] of sgRules) {
    add(key, agg.src, agg.tgt, {
      edgeKind: 'sg-rule',
      label: destsLabel(agg.rows.map((r) => r.dest), 2),
      title: `Allows ${nameOf(agg.src)} → ${nameOf(agg.tgt)}`,
      columns: SG_RULE_COLUMNS,
      routes: agg.rows,
      refId: agg.refId,
    });
  }

  return [...rels.values()];
}

// --- ego-graph builder ---------------------------------------------------------

/** Kind guesses for referenced-but-unscanned resources (ghost nodes). */
const GHOST_KIND_PREFIXES: Array<[string, string]> = [
  ['sg-', 'sg'],
  ['subnet-', 'subnet'],
  ['vpc-', 'vpc'],
  ['i-', 'instance'],
  ['nat-', 'nat'],
  ['igw-', 'igw'],
  ['eigw-', 'eigw'],
  ['tgw-attach', 'tgw-attachment'],
  ['tgw-rtb-', 'tgw-rt'],
  ['tgw-', 'tgw'],
  ['pcx-', 'pcx'],
  ['vgw-', 'vgw'],
  ['cgw-', 'cgw'],
  ['vpce-', 'vpce'],
  ['eni-', 'eni'],
  ['rtb-', 'route-table'],
];

function guessKind(key: string): string {
  for (const [prefix, kind] of GHOST_KIND_PREFIXES) {
    if (key.startsWith(prefix)) return kind;
  }
  return 'generic';
}

function kindOf(index: AtlasIndex, key: string): string {
  if (key === INTERNET) return 'internet';
  if (key.startsWith('acct:')) return 'account';
  if (key.startsWith('s3ext:')) return 's3';
  return index.byKey.get(key)?.kind ?? guessKind(key);
}

const KIND_PLURALS: Record<string, string> = {
  instance: 'instances',
  sg: 'security groups',
  subnet: 'subnets',
  lambda: 'Lambda functions',
  lb: 'load balancers',
  rds: 'RDS instances',
  eni: 'network interfaces',
  vpce: 'VPC endpoints',
  'iam-role': 'IAM roles',
  secret: 'secrets',
  acm: 'certificates',
  zone: 'Route 53 zones',
  vpc: 'VPCs',
  ecs: 'ECS services',
};

const pluralOf = (kind: string): string => KIND_PLURALS[kind] ?? `${kind} resources`;

/** Short "what is this" line, plus account/region when they differ from the center's. */
function subtitleFor(index: AtlasIndex, ref: ResourceRef, center: ResourceRef | undefined): string {
  const raw = ref.raw;
  let base: string;
  switch (ref.kind) {
    case 'vpc': base = (raw['cidrBlocks'] as string[] | undefined)?.join(', ') || 'VPC'; break;
    case 'subnet':
      base = [raw['cidrBlock'], (raw['isPublic'] as boolean | undefined) ? 'public' : 'private']
        .filter(Boolean).join(' · ');
      break;
    case 'instance': base = (raw['privateIp'] as string | undefined) ?? (raw['instanceType'] as string | undefined) ?? 'EC2 instance'; break;
    case 'sg': base = (raw['description'] as string | undefined) ?? 'security group'; break;
    case 'lb': base = [raw['lbType'], raw['scheme']].filter(Boolean).join(' · ') || 'load balancer'; break;
    case 'nat': base = 'NAT gateway'; break;
    case 'igw': base = 'internet gateway'; break;
    case 'eigw': base = 'egress-only IGW'; break;
    case 'tgw': base = 'transit gateway'; break;
    case 'pcx': base = 'VPC peering'; break;
    case 'vgw': base = 'VPN gateway'; break;
    case 'cgw': base = (raw['ipAddress'] as string | undefined) ?? 'customer gateway'; break;
    case 'dxgw': base = 'Direct Connect gateway'; break;
    case 'iam-role': base = (raw['description'] as string | undefined) ?? 'IAM role'; break;
    case 'iam-user': base = 'IAM user'; break;
    case 'iam-group': base = 'IAM group'; break;
    case 'iam-policy': base = 'IAM policy'; break;
    case 'iam-instance-profile': base = 'instance profile'; break;
    case 'zone': base = `${(raw['privateZone'] as boolean | undefined) ? 'private' : 'public'} zone`; break;
    case 'lambda': base = (raw['runtime'] as string | undefined) ?? 'Lambda function'; break;
    case 'rds':
    case 'rds-cluster': base = (raw['engine'] as string | undefined) ?? ref.kind; break;
    case 'elasticache': base = (raw['engine'] as string | undefined) ?? 'ElastiCache'; break;
    case 'vpce': base = (raw['serviceName'] as string | undefined)?.split('.').slice(3).join('.') || 'VPC endpoint'; break;
    case 'acm': base = (raw['domainName'] as string | undefined) ?? 'certificate'; break;
    case 'kms': base = 'KMS key'; break;
    case 'secret': base = 'secret'; break;
    case 'asg': base = 'Auto Scaling group'; break;
    case 'cloudfront': base = (raw['domainName'] as string | undefined) ?? 'CloudFront'; break;
    case 'apigw': base = [raw['protocolType'], raw['endpointType']].filter(Boolean).join(' · ') || 'API gateway'; break;
    case 'client-vpn': base = (raw['clientCidrBlock'] as string | undefined) ?? 'Client VPN'; break;
    case 'resolver-endpoint': base = `${String(raw['direction'] ?? 'resolver').toLowerCase()} resolver`; break;
    case 's3': base = 'S3 bucket'; break;
    default: base = ref.kind; break;
  }
  const ctx: string[] = [];
  if (center && ref.accountId !== center.accountId) ctx.push(index.accountLabel(ref.accountId));
  if (center && ref.region && ref.region !== center.region) ctx.push(ref.region);
  return [base, ...ctx].filter(Boolean).join(' · ');
}

/**
 * Build the ego graph for one resource: the center, everything connected to
 * it, and controlled continuations of the chains that explain connectivity.
 */
export function buildFocus(index: AtlasIndex, centerKey: string): AtlasGraph {
  const center = index.byKey.get(centerKey);
  const centerId = center?.id ?? centerKey;
  const relations = collectRelations(index);

  const bySource = new Map<string, Relation[]>();
  const byTarget = new Map<string, Relation[]>();
  const push = (map: Map<string, Relation[]>, key: string, rel: Relation): void => {
    const list = map.get(key);
    if (list) list.push(rel);
    else map.set(key, [rel]);
  };
  for (const rel of relations) {
    push(bySource, rel.source, rel);
    push(byTarget, rel.target, rel);
  }
  const outgoing = (key: string): Relation[] => bySource.get(key) ?? [];
  const incoming = (key: string): Relation[] => byTarget.get(key) ?? [];
  const incident = (key: string): Relation[] => [...outgoing(key), ...incoming(key)];

  /**
   * Which relations to follow when a node is REACHED (depth ≥ 1). The rules
   * continue meaningful chains without re-expanding into container contents:
   *   - a subnet exposes its VPC and its route targets, never its residents;
   *   - the center's own SGs expose their allow rules and internet exposure;
   *   - an LB that targets the center exposes its CloudFront path;
   *   - a VPC exposes only its DNS context (private zones, resolver rules);
   *   - a role assumed by the center exposes its trust and policies.
   */
  const pick = (key: string, depth: number, via: EdgeKind | undefined): Relation[] => {
    if (depth === 0) return incident(key);
    switch (kindOf(index, key)) {
      case 'subnet':
        return outgoing(key);
      case 'vpc':
        return incident(key).filter((r) => r.data.edgeKind === 'dns');
      case 'sg':
        return via === 'sg-attach'
          ? incident(key).filter((r) => r.data.edgeKind === 'sg-rule' || r.data.edgeKind === 'sg-open')
          : [];
      case 'pcx':
        return incident(key).filter((r) => r.data.edgeKind === 'peering');
      case 'igw':
        return outgoing(key).filter((r) => r.data.edgeKind === 'route');
      case 'lb':
        return via === 'assoc'
          ? incoming(key).filter((r) => r.data.edgeKind === 'edge-service')
          : [];
      case 'cloudfront':
        return incoming(key).filter((r) => r.data.edgeKind === 'edge-service');
      case 'iam-role':
        return depth === 1
          ? [
              ...incoming(key).filter((r) => r.data.edgeKind === 'trust'),
              ...outgoing(key).filter((r) => r.data.edgeKind === 'uses'),
            ]
          : [];
      case 'rds-cluster':
        return depth === 1 ? incident(key).filter((r) => r.data.edgeKind === 'assoc') : [];
      default:
        return [];
    }
  };

  const selected = new Map<string, Relation>();
  const reached = new Map<string, { depth: number; via?: EdgeKind }>([[centerId, { depth: 0 }]]);
  const notes: AtlasNode[] = [];
  const noteEdges: AtlasEdge[] = [];
  const queue: string[] = [centerId];

  while (queue.length > 0) {
    const key = queue.shift()!;
    const { depth, via } = reached.get(key)!;
    if (depth >= MAX_DEPTH) continue;

    // Edges to already-reached nodes are always kept; edges introducing NEW
    // neighbors are capped per neighbor kind so one busy hub can't explode.
    const newNeighbors = new Map<string, Relation[]>();
    for (const rel of pick(key, depth, via)) {
      const other = rel.source === key ? rel.target : rel.source;
      if (other === key) continue;
      if (reached.has(other)) {
        selected.set(rel.key, rel);
        continue;
      }
      push(newNeighbors, other, rel);
    }
    const byKind = new Map<string, string[]>();
    for (const other of newNeighbors.keys()) {
      const kind = kindOf(index, other);
      const list = byKind.get(kind);
      if (list) list.push(other);
      else byKind.set(kind, [other]);
    }
    for (const [kind, others] of byKind) {
      for (const other of others.slice(0, MAX_PER_KIND)) {
        const rels = newNeighbors.get(other)!;
        for (const rel of rels) selected.set(rel.key, rel);
        reached.set(other, { depth: depth + 1, via: rels[0]!.data.edgeKind });
        queue.push(other);
      }
      const dropped = others.length - MAX_PER_KIND;
      if (dropped > 0) {
        const noteId = `note:focus:${key}:${kind}`;
        notes.push({
          id: noteId,
          type: 'note',
          position: { x: 0, y: 0 },
          width: 230,
          height: 58,
          data: {
            label: `+${dropped} more ${pluralOf(kind)}`,
            subtitle: 'use Search or the VPC diagram',
            kind: 'note',
          },
        });
        noteEdges.push({
          id: `edge:${noteId}`,
          source: key,
          target: noteId,
          type: 'annotated',
          markerEnd: { type: MarkerType.ArrowClosed },
          data: {
            edgeKind: newNeighbors.get(others[MAX_PER_KIND]!)![0]!.data.edgeKind,
            title: `${dropped} more connections not shown`,
          },
        });
      }
    }
  }

  // Closure: relations between two nodes that BOTH made it into the view are
  // free context (SG ↔ LB attachments, internet exposure of a reached SG…) —
  // they explain the picture without growing it.
  for (const rel of relations) {
    if (!selected.has(rel.key) && reached.has(rel.source) && reached.has(rel.target)) {
      selected.set(rel.key, rel);
    }
  }

  // --- materialize nodes -------------------------------------------------------
  const makeNode = (key: string, isCenter = false): AtlasNode => {
    const node: AtlasNode = {
      id: key,
      type: 'resource',
      position: { x: 0, y: 0 },
      width: isCenter ? 230 : 170,
      height: isCenter ? 108 : 92,
      data: { label: key, kind: guessKind(key), refId: key, emphasis: isCenter || undefined },
    };
    if (key === INTERNET) {
      node.data = { ...node.data, kind: 'internet', label: 'Internet', subtitle: 'public traffic' };
      return node;
    }
    if (key.startsWith('acct:')) {
      const accountId = key.slice('acct:'.length);
      node.data = { ...node.data, kind: 'account', label: index.accountLabel(accountId), subtitle: 'AWS account' };
      return node;
    }
    if (key.startsWith('s3ext:')) {
      node.data = {
        ...node.data,
        kind: 's3',
        label: key.slice('s3ext:'.length),
        subtitle: 'S3 bucket · not scanned',
        ghost: true,
      };
      return node;
    }
    const ref = index.byKey.get(key);
    if (!ref) {
      node.data = { ...node.data, subtitle: 'not scanned', ghost: true };
      return node;
    }
    if (ref.kind === 'resolver-rule') {
      node.data = {
        ...node.data,
        kind: 'dns-target',
        label: (ref.raw['domainName'] as string | undefined) ?? ref.name ?? ref.id,
        subtitle: ((ref.raw['targetIps'] as string[] | undefined) ?? []).join(', ') || 'resolver rule',
        refId: ref.id,
      };
      return node;
    }
    const kind = ref.kind === 'lb' ? `lb-${(ref.raw['lbType'] as string | undefined) ?? 'application'}` : ref.kind;
    node.data = {
      ...node.data,
      kind,
      label: ref.name ?? ref.id,
      subtitle: isCenter
        ? [subtitleFor(index, ref, undefined), index.accountLabel(ref.accountId), ref.region]
            .filter(Boolean).join(' · ')
        : subtitleFor(index, ref, center),
      refId: ref.id,
      drillVpcId: ref.kind === 'vpc' ? ref.id : undefined,
    };
    return node;
  };

  const nodes = new Map<string, AtlasNode>();
  nodes.set(centerId, makeNode(centerId, true));
  for (const rel of selected.values()) {
    for (const key of [rel.source, rel.target]) {
      if (!nodes.has(key)) nodes.set(key, makeNode(key));
    }
  }
  if (selected.size === 0) {
    notes.push({
      id: 'note:focus:empty',
      type: 'note',
      position: { x: 0, y: 0 },
      width: 260,
      height: 64,
      data: {
        label: 'No recorded connections',
        subtitle: 'the scan data holds no relationships for this resource',
        kind: 'note',
      },
    });
  }

  const edges: AtlasEdge[] = [...selected.values()].map((rel) => ({
    id: `edge:${rel.key}`,
    source: rel.source,
    target: rel.target,
    type: 'annotated',
    ...(rel.biDir ? { markerStart: { type: MarkerType.ArrowClosed } } : {}),
    markerEnd: { type: MarkerType.ArrowClosed },
    data: rel.data,
  }));

  return { nodes: [...nodes.values(), ...notes], edges: [...edges, ...noteEdges] };
}
