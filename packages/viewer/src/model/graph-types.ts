import type { Node, Edge } from '@xyflow/react';
import type { ScanError } from '@atlas/schema';

export type ContainerStyle =
  | 'account'
  | 'region'
  | 'vpc'
  | 'az'
  | 'subnet-public'
  | 'subnet-private'
  | 'external'
  | 'security'
  | 'org'
  | 'ghost';

// NOTE: these must stay `type` aliases (not interfaces) — React Flow v12's
// Node<T> generic requires an implicit index signature.
export type AtlasNodeData = {
  label: string;
  subtitle?: string;
  /** Resource kind (icon lookup) or container style discriminator. */
  kind: string;
  isContainer?: boolean;
  containerStyle?: ContainerStyle;
  /** Key into AtlasIndex.byKey for the details panel. */
  refId?: string;
  badges?: string[];
  /**
   * Scan errors carried onto account/region containers (partial-permission
   * scans). Drives the warning badge and the details-panel error list.
   */
  errors?: ScanError[];
  /** Overview VPC nodes: double-click opens this VPC's detail view. */
  drillVpcId?: string;
  /** Ghost = referenced by an edge but not scanned. */
  ghost?: boolean;
  /** Visually emphasized (the center resource of a focus view). */
  emphasis?: boolean;
  /**
   * Terraform state mapping (set only when stacks are imported): true =
   * claimed by an imported stack (drawn with the Terraform mark), false =
   * unmanaged. Drives the managed/unmanaged filter in the Layers panel.
   */
  tfManaged?: boolean;
};

export type AtlasNode = Node<AtlasNodeData>;

export interface RouteDetail {
  /** Where the route comes from — subnet name/id, 'VPC main table', or a TGW route table. */
  from: string;
  dest: string;
  state?: string;
  routeType?: string;
}

export type EdgeKind =
  | 'peering'
  | 'tgw'
  | 'vpn'
  | 'dx'
  | 'route'
  | 'assoc'
  /** Security-group allow rule (SG → SG reference). */
  | 'sg-rule'
  /** World-open ingress: Internet → security group. */
  | 'sg-open'
  /** Security group applies-to (SG → the workload it protects). */
  | 'sg-attach'
  /** Static dependency: workload → IAM role, LB → ACM cert, secret → KMS key… */
  | 'uses'
  /** Cross-account IAM assume-role trust (account → role). */
  | 'trust'
  /** Edge/ingress traffic: internet → CloudFront/API GW/Client VPN → origin. */
  | 'edge-service'
  /** DNS resolution paths: resolver rules, private hosted zone associations. */
  | 'dns'
  /** AWS Organizations policy (SCP/RCP/…) attached to a root / OU / account. */
  | 'governs'
  /** Focus view: where a resource lives (instance → subnet, subnet → VPC…). */
  | 'placement';

export type AtlasEdgeData = {
  label?: string;
  edgeKind: EdgeKind;
  /** Full route breakdown, shown in the details panel on edge click. */
  routes?: RouteDetail[];
  /** Header override for the `routes` table (defaults to From/Destination/State). */
  columns?: [string, string, string];
  /** Underlying resource (pcx-…, tgw-attach-…, vpn-…) for details lookup. */
  refId?: string;
  title?: string;
};

export type AtlasEdge = Edge<AtlasEdgeData>;

export interface AtlasGraph {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

/** Compact "10.0.0.0/8, 10.1.0.0/16 +3" style label from a destination list. */
export function destsLabel(dests: string[], max = 3): string {
  const unique = [...new Set(dests)].sort();
  if (unique.length === 0) return '';
  const shown = unique.slice(0, max);
  const extra = unique.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` +${extra}` : '');
}
