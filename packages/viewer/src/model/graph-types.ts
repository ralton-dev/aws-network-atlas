import type { Node, Edge } from '@xyflow/react';

export type ContainerStyle =
  | 'account'
  | 'region'
  | 'vpc'
  | 'az'
  | 'subnet-public'
  | 'subnet-private'
  | 'external'
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
  /** Overview VPC nodes: double-click opens this VPC's detail view. */
  drillVpcId?: string;
  /** Ghost = referenced by an edge but not scanned. */
  ghost?: boolean;
};

export type AtlasNode = Node<AtlasNodeData>;

export interface RouteDetail {
  /** Where the route comes from — subnet name/id, 'VPC main table', or a TGW route table. */
  from: string;
  dest: string;
  state?: string;
  routeType?: string;
}

export type EdgeKind = 'peering' | 'tgw' | 'vpn' | 'dx' | 'route' | 'assoc';

export type AtlasEdgeData = {
  label?: string;
  edgeKind: EdgeKind;
  /** Full route breakdown, shown in the details panel on edge click. */
  routes?: RouteDetail[];
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
