import { useMemo } from 'react';
import type { AtlasGraph, EdgeKind } from '../model/graph-types.js';
import { hiddenCount, type HiddenState, type TfFilter } from '../model/view-state.js';
import { TerraformMark } from './nodes.js';

const NODE_KIND_LABELS: Record<string, string> = {
  'group-account': 'Account containers',
  'group-region': 'Region containers',
  'group-vpc': 'VPC container',
  'group-az': 'Availability zones',
  'group-subnet-public': 'Public subnets',
  'group-subnet-private': 'Private subnets',
  'group-external': 'External / connectivity',
  'group-security': 'Security & identity lanes',
  'group-edge': 'Edge & global lanes',
  account: 'Accounts',
  asg: 'Auto Scaling groups',
  vpc: 'VPCs',
  subnet: 'Subnets',
  tgw: 'Transit gateways',
  cgw: 'Customer gateways',
  dxgw: 'Direct Connect gateways',
  vgw: 'VPN gateways',
  nat: 'NAT gateways',
  igw: 'Internet gateways',
  eigw: 'Egress-only IGWs',
  instance: 'EC2 instances',
  rds: 'RDS instances',
  'rds-cluster': 'RDS clusters',
  vpce: 'VPC endpoints',
  lambda: 'Lambda functions',
  ecs: 'ECS services',
  eks: 'EKS clusters',
  elasticache: 'ElastiCache',
  pcx: 'Peering connections',
  'lb-application': 'Application LBs',
  'lb-network': 'Network LBs',
  'lb-gateway': 'Gateway LBs',
  'lb-classic': 'Classic LBs',
  sg: 'Security groups',
  internet: 'Internet',
  cloudfront: 'CloudFront',
  apigw: 'API gateways',
  'client-vpn': 'Client VPN endpoints',
  'network-firewall': 'Network firewalls',
  'resolver-endpoint': 'Resolver endpoints',
  'dns-target': 'DNS targets',
  kms: 'KMS keys',
  acm: 'ACM certificates',
  secret: 'Secrets',
  'iam-role': 'IAM roles',
  'iam-user': 'IAM users',
  'iam-group': 'IAM groups',
  'iam-policy': 'IAM policies',
  'iam-instance-profile': 'Instance profiles',
  s3: 'S3 buckets',
  zone: 'Route 53 zones',
  note: 'Notes',
};

const EDGE_KIND_LABELS: Record<EdgeKind, string> = {
  peering: 'VPC peering',
  tgw: 'Transit gateway',
  vpn: 'VPN',
  dx: 'Direct Connect',
  route: 'Routes',
  assoc: 'LB associations',
  'sg-rule': 'SG allow rules',
  'sg-open': 'Internet exposure',
  'sg-attach': 'SG attachments',
  uses: 'Uses / depends on',
  trust: 'IAM trust',
  'edge-service': 'Edge traffic',
  dns: 'DNS',
  governs: 'SCP / policy attachments',
  placement: 'Placement',
};

const nodeKindLabel = (kind: string): string => NODE_KIND_LABELS[kind] ?? kind;

export interface LayersPanelProps {
  graph: AtlasGraph;
  hidden: HiddenState;
  onToggleNodeKind(kind: string): void;
  onToggleEdgeKind(kind: EdgeKind): void;
  /** Show only Terraform-managed / only unmanaged resources (undefined = all). */
  onSetTfFilter(filter?: TfFilter): void;
  /** Un-hide the individually hidden nodes (keeps kind toggles). */
  onShowHiddenNodes(): void;
  /** Reset everything hidden in this view. */
  onShowAll(): void;
  onClose(): void;
}

/**
 * Declutter panel: toggle whole kinds of nodes/edges present in the current
 * view on and off, and reset anything hidden (including individually hidden
 * nodes from right-click / the details panel).
 */
export function LayersPanel(props: LayersPanelProps): React.ReactElement {
  const { graph, hidden } = props;

  const nodeKinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of graph.nodes) counts.set(n.data.kind, (counts.get(n.data.kind) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => nodeKindLabel(a).localeCompare(nodeKindLabel(b)));
  }, [graph.nodes]);

  const edgeKinds = useMemo(() => {
    const counts = new Map<EdgeKind, number>();
    for (const e of graph.edges) {
      const kind = e.data?.edgeKind ?? 'route';
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) =>
      EDGE_KIND_LABELS[a].localeCompare(EDGE_KIND_LABELS[b]),
    );
  }, [graph.edges]);

  // tfManaged is only stamped when Terraform stacks are imported, so absence
  // of the flag on every node means no tf-import yet → hide the section.
  const tf = useMemo(() => {
    let managed = 0;
    let unmanaged = 0;
    for (const n of graph.nodes) {
      if (n.data.tfManaged === true) managed += 1;
      else if (n.data.tfManaged === false) unmanaged += 1;
    }
    return { present: managed + unmanaged > 0, managed, unmanaged };
  }, [graph.nodes]);

  const tfChoices: Array<{ value?: TfFilter; label: string; count?: number }> = [
    { label: 'All resources' },
    { value: 'managed', label: 'Terraform-managed only', count: tf.managed },
    { value: 'unmanaged', label: 'Unmanaged only', count: tf.unmanaged },
  ];

  return (
    <aside className="layers-panel">
      <header>
        <h2>Layers</h2>
        <button className="close-btn" onClick={props.onClose} title="Close">×</button>
      </header>

      {tf.present && (
        <>
          <h3 className="tf-heading"><TerraformMark size={15} /> Terraform</h3>
          {tfChoices.map(({ value, label, count }) => (
            <label key={value ?? 'all'} className="layer-row">
              <input
                type="radio"
                name="tf-filter"
                checked={hidden.tfFilter === value}
                onChange={() => props.onSetTfFilter(value)}
              />
              <span className="layer-label">{label}</span>
              {count !== undefined && <span className="count">{count}</span>}
            </label>
          ))}
        </>
      )}

      <h3>Nodes</h3>
      {nodeKinds.map(([kind, count]) => {
        const isHidden = hidden.nodeKinds.has(kind);
        return (
          <label key={kind} className={isHidden ? 'layer-row is-hidden' : 'layer-row'}>
            <input
              type="checkbox"
              checked={!isHidden}
              onChange={() => props.onToggleNodeKind(kind)}
            />
            <span className="layer-label">{nodeKindLabel(kind)}</span>
            <span className="count">{count}</span>
          </label>
        );
      })}

      {edgeKinds.length > 0 && <h3>Connections</h3>}
      {edgeKinds.map(([kind, count]) => {
        const isHidden = hidden.edgeKinds.has(kind);
        return (
          <label key={kind} className={isHidden ? 'layer-row is-hidden' : 'layer-row'}>
            <input
              type="checkbox"
              checked={!isHidden}
              onChange={() => props.onToggleEdgeKind(kind)}
            />
            <span className="layer-label">{EDGE_KIND_LABELS[kind]}</span>
            <span className="count">{count}</span>
          </label>
        );
      })}

      {hidden.nodeIds.size > 0 && (
        <div className="layers-hidden-note">
          <span className="layer-label">
            {hidden.nodeIds.size} node{hidden.nodeIds.size === 1 ? '' : 's'} hidden individually
          </span>
          <button className="mini-btn" onClick={props.onShowHiddenNodes}>Show</button>
        </div>
      )}

      <button
        className="show-all-btn"
        onClick={props.onShowAll}
        disabled={hiddenCount(hidden) === 0}
      >
        Show all
      </button>
    </aside>
  );
}
