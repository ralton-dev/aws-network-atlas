import { useMemo, useState } from 'react';
import type { AtlasIndex, ResourceRef } from '../data.js';
import type { AtlasGraph, EdgeKind } from '../model/graph-types.js';
import { copyToClipboard, importBlocksFor } from '../model/tf-import.js';
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
  'sso-instance': 'Identity Center instances',
  'sso-permission-set': 'SSO permission sets',
  'sso-application': 'SSO applications',
  'saml-provider': 'SAML providers',
  'oidc-provider': 'OIDC providers',
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
  'sso-assign': 'SSO assignments',
  'ram-share': 'RAM shares',
  'eks-access': 'EKS access',
  placement: 'Placement',
};

const nodeKindLabel = (kind: string): string => NODE_KIND_LABELS[kind] ?? kind;

export interface LayersPanelProps {
  graph: AtlasGraph;
  /** Needed to turn the view's unmanaged nodes back into resources to import. */
  index: AtlasIndex;
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
  const { graph, hidden, index } = props;

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

  // Every unmanaged node in this view, back to the resource it draws.
  // `tfManaged === false` is stamped through this exact lookup by
  // `applyTerraformBadges`, so a node carrying the flag resolves by
  // construction — the guards are for a view rebuilt without re-badging.
  //
  // Deduped by ref identity, not by node: `index.byKey` holds the same
  // `ResourceRef` object under both its id and its ARN, so one resource drawn
  // twice in a view would otherwise yield two import blocks that both adopt
  // it. That is a worse outcome than an undercount, because the second block
  // would be silently renamed `_2` by the dedupe and read as a second
  // resource.
  const unmanagedRefs = useMemo(() => {
    const seen = new Set<ResourceRef>();
    const refs: ResourceRef[] = [];
    for (const n of graph.nodes) {
      if (n.data.tfManaged !== false || n.data.refId === undefined) continue;
      const ref = index.byKey.get(n.data.refId);
      if (ref === undefined || seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
    }
    return refs;
  }, [graph.nodes, index]);

  // The bulk form, not the single form in a loop: dedupe of synthesised
  // addresses is a whole-file property (two `default` security groups, two
  // ECS services called `web`) and has to run across the batch before it is
  // split into per-account sections, or the collisions land in different
  // sections un-suffixed and Terraform rejects the paste.
  const bulk = useMemo(
    () => importBlocksFor(unmanagedRefs, { accountLabel: index.accountLabel }),
    [unmanagedRefs, index],
  );

  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyBulk = (): void => {
    void copyToClipboard(bulk.text).then((ok) => {
      setCopyState(ok ? 'copied' : 'failed');
      window.setTimeout(() => setCopyState('idle'), 1800);
    });
  };

  // The button counts **blocks**, not selected resources.
  //
  // It used to count one per unmanaged node, which was the same number until
  // resources started expanding into the terraform resources nested inside
  // them: a security group's rules are separate resources with their own
  // import ids, and the graph draws none of them. Counting nodes understated
  // what adoption requires — the reader saw "31", pasted, and got 47 blocks.
  // The number that matters to someone about to paste is the number of blocks
  // they are pasting, so that is the number on the button, and the note
  // reconciles it against the unmanaged count sitting directly above it.
  //
  // The shortfall is disclosed in the same breath: a block whose Terraform
  // type could not be determined, or whose import id could not be built, is
  // emitted commented out (decision 5) and will not apply. Counting it as
  // pasteable is exactly the surprise this note exists to prevent.
  const blockCount = bulk.blocks.length;
  const { resources, nested, commentedOut } = bulk;
  const bulkNote =
    copyState === 'copied'
      ? `${blockCount} block${blockCount === 1 ? '' : 's'} copied, grouped by account and region.`
      : copyState === 'failed'
        ? 'The browser refused the clipboard — nothing was copied.'
        : [
            nested === 0
              ? 'One per unmanaged resource in this view.'
              : `${blockCount} blocks for the ${resources} unmanaged resource${resources === 1 ? '' : 's'} in this view — ${nested} are nested resources such as security group rules, which Terraform manages separately and the graph does not draw.`,
            commentedOut === 0
              ? ''
              : `${commentedOut} paste commented out and will not apply; each says why.`,
            'Addresses are suggestions — rename them to suit your module.',
          ]
            .filter((s) => s !== '')
            .join(' ');

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
          <button
            className={copyState === 'copied' ? 'tf-bulk-btn is-copied' : 'tf-bulk-btn'}
            onClick={copyBulk}
            disabled={blockCount === 0}
            title="Copy an import block for every unmanaged resource in this view"
          >
            {copyState === 'copied'
              ? 'Copied'
              : copyState === 'failed'
                ? 'Copy failed'
                : blockCount === 0
                  ? 'Nothing unmanaged to copy'
                  : `Copy ${blockCount} import block${blockCount === 1 ? '' : 's'}`}
          </button>
          {blockCount > 0 && <p className="tf-bulk-note">{bulkNote}</p>}
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
