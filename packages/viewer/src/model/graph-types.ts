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

/**
 * How a node or edge differs between the scanned estate and an active proposal
 * (PROPOSAL-OVERLAY.md, decision 49). Stamped only by `diffGraphs`
 * (`model/diff.ts`), which unions the graph built from the current index with
 * the graph built from the proposed one:
 *
 * - `added` — only in the proposed graph: a `proposed-` resource, an account
 *   or region the proposal creates, or an edge or note that exists only
 *   because of one. Hidden in the *current* mode.
 * - `removed` — only in the current graph. Hidden in the *proposed* mode.
 * - `changed` — in both, and its `refId` is in the proposal's `ChangeSet`, or
 *   its `label`, `subtitle` or `parentId` differ (for an edge: `label`,
 *   `source` or `target`). The data drawn is the *proposed* graph's.
 *
 * **Absent means unchanged** — the field is not present at all, never
 * `undefined`. A graph that never passed through `diffGraphs` (no proposal
 * active) carries no `changeState` anywhere and must render exactly as it did
 * before proposals existed. A renderer (WP-4) styles from this field only;
 * it must not infer state from a `proposed-` id.
 */
export type ChangeState = 'added' | 'removed' | 'changed';

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
  /**
   * Set on a ghost account container that stands for a scanned account the
   * current selection leaves out; clicking it adds the account. Absent on
   * genuinely unscanned accounts.
   */
  addAccountId?: string;
  /** Visually emphasized (the center resource of a focus view). */
  emphasis?: boolean;
  /**
   * Terraform state mapping (set only when stacks are imported): true =
   * claimed by an imported stack (drawn with the Terraform mark), false =
   * unmanaged. Drives the managed/unmanaged filter in the Layers panel.
   */
  tfManaged?: boolean;
  /** Set only while a proposal is active; absent = unchanged. See `ChangeState`. */
  changeState?: ChangeState;
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
  /** Identity Center permission set assigned into an org member account. */
  | 'sso-assign'
  /** AWS RAM resource share: owning account → the principal it shares with. */
  | 'ram-share'
  /**
   * EKS IAM↔Kubernetes access surface: access-entry principal → cluster,
   * cluster → pod-identity role, cluster → OIDC identity provider.
   */
  | 'eks-access'
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
  /** Set only while a proposal is active; absent = unchanged. See `ChangeState`. */
  changeState?: ChangeState;
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
