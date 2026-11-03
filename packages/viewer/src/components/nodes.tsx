import { Handle, Position, type NodeProps } from '@xyflow/react';
import { iconFor } from '../icons.js';
import type { AtlasNode, ChangeState } from '../model/graph-types.js';

function EdgeHandles(): React.ReactElement {
  return (
    <>
      <Handle type="target" position={Position.Left} className="atlas-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="atlas-handle" isConnectable={false} />
    </>
  );
}

function initials(kind: string): string {
  return kind.slice(0, 3).toUpperCase();
}

/** The Terraform mark, overlaid on nodes claimed by an imported state. */
export function TerraformMark({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <span className="tf-mark" title="Managed by Terraform" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size - 4} height={size - 4} aria-label="Terraform">
        <path
          fill="currentColor"
          d="M1.44 0v7.575l6.561 3.79V3.787Zm21.12 4.227-6.561 3.791v7.574l6.56-3.787ZM8.72 4.23v7.575l6.561 3.787V8.018Zm0 8.405v7.575L15.28 24v-7.578Z"
        />
      </svg>
    </span>
  );
}

/**
 * The class a proposal's change state adds to a node (`is-added` /
 * `is-removed` / `is-changed`), with its leading space, or `''` when the node
 * carries no `changeState`. Appended to the existing class string rather than
 * joined into it, so a graph that never passed through `diffGraphs` renders
 * the exact class attribute it did before proposals existed.
 */
function changeClass(state: ChangeState | undefined): string {
  return state === undefined ? '' : ` is-${state}`;
}

/** The word a container's header shows for its change state, beside the subtitle. */
const CHANGE_WORD: Record<ChangeState, string> = {
  added: 'proposed',
  removed: 'to remove',
  changed: 'changed',
};

export function ResourceNode({ data, selected }: NodeProps<AtlasNode>): React.ReactElement {
  const Icon = iconFor(data.kind);
  return (
    <div
      className={[
        'resource-node',
        selected ? 'is-selected' : '',
        data.ghost ? 'is-ghost' : '',
        data.drillVpcId ? 'is-drillable' : '',
        data.emphasis ? 'is-emphasized' : '',
      ].join(' ') + changeClass(data.changeState)}
      title={data.drillVpcId ? 'Double-click to open VPC diagram' : undefined}
    >
      <EdgeHandles />
      <div className="resource-icon">
        {Icon ? <Icon width={34} height={34} /> : <span className="icon-fallback">{initials(data.kind)}</span>}
        {data.tfManaged === true && <TerraformMark />}
      </div>
      <div className="resource-text">
        <div className="resource-label">{data.label}</div>
        {data.subtitle && <div className="resource-subtitle">{data.subtitle}</div>}
        {data.badges && data.badges.length > 0 && (
          <div className="resource-badges">
            {data.badges.map((badge) => (
              <span key={badge} className="badge">{badge}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ContainerNode({ data, selected }: NodeProps<AtlasNode>): React.ReactElement {
  const Icon = iconFor(data.kind);
  return (
    <div
      className={
        `container-node style-${data.containerStyle ?? 'region'} ${selected ? 'is-selected' : ''}` +
        changeClass(data.changeState)
      }
    >
      <EdgeHandles />
      <div className="container-header">
        {Icon && <Icon width={22} height={22} />}
        <span className="container-label">{data.label}</span>
        {data.subtitle && <span className="container-subtitle">{data.subtitle}</span>}
        {data.changeState && (
          <span className={`container-change change-${data.changeState}`}>
            {CHANGE_WORD[data.changeState]}
          </span>
        )}
        {data.badges && data.badges.length > 0 && (
          <div className="container-badges">
            {data.badges.map((badge) => (
              <span key={badge} className="badge badge-warning">{badge}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function NoteNode({ data }: NodeProps<AtlasNode>): React.ReactElement {
  // A `+N more` note is stamped like any node (decision 58: a cap can shift
  // between the two graphs), so it takes the same class.
  return (
    <div className={'note-node' + changeClass(data.changeState)}>
      <EdgeHandles />
      <div className="resource-label">{data.label}</div>
      {data.subtitle && <div className="resource-subtitle">{data.subtitle}</div>}
    </div>
  );
}
