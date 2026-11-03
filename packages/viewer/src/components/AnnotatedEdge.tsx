import { createContext, useContext } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import type { AtlasEdge, AtlasEdgeData, ChangeState, EdgeKind } from '../model/graph-types.js';

const EDGE_STYLES: Record<EdgeKind, React.CSSProperties> = {
  peering: { stroke: '#ed7100', strokeDasharray: '7 4', strokeWidth: 1.8 },
  tgw: { stroke: '#8c4fff', strokeWidth: 2 },
  vpn: { stroke: '#dd344c', strokeDasharray: '4 4', strokeWidth: 1.6 },
  dx: { stroke: '#7d8998', strokeWidth: 2 },
  route: { stroke: '#546e7a', strokeWidth: 1.4 },
  assoc: { stroke: '#a7b6bf', strokeDasharray: '2 4', strokeWidth: 1.2 },
  'sg-rule': { stroke: '#b01e63', strokeWidth: 1.8 },
  'sg-open': { stroke: '#d13212', strokeWidth: 2.4 },
  'sg-attach': { stroke: '#d3a8c0', strokeDasharray: '2 4', strokeWidth: 1.1 },
  uses: { stroke: '#8fa3b0', strokeDasharray: '2 4', strokeWidth: 1.1 },
  trust: { stroke: '#b91c1c', strokeDasharray: '5 4', strokeWidth: 1.5 },
  'edge-service': { stroke: '#0972d3', strokeWidth: 2 },
  dns: { stroke: '#1f7a4d', strokeDasharray: '3 5', strokeWidth: 1.5 },
  governs: { stroke: '#c2277a', strokeDasharray: '5 3', strokeWidth: 1.7 },
  'sso-assign': { stroke: '#7a5195', strokeDasharray: '4 4', strokeWidth: 1.5 },
  'ram-share': { stroke: '#0e7490', strokeDasharray: '5 4', strokeWidth: 1.6 },
  'eks-access': { stroke: '#326ce5', strokeDasharray: '4 3', strokeWidth: 1.5 },
  placement: { stroke: '#9aa5b1', strokeDasharray: '6 4', strokeWidth: 1.2 },
};

/**
 * A proposal's change state, layered over the kind's style (decision 49):
 * green dashed for added, red dashed for removed, amber for changed. The
 * stroke width is the kind's own, so a TGW still reads heavier than an assoc;
 * only colour and dash say "planned". A changed edge keeps its kind's dash so
 * a changed peering still looks like a peering.
 */
const CHANGE_STYLES: Record<ChangeState, React.CSSProperties> = {
  added: { stroke: '#1d8102', strokeDasharray: '6 4' },
  removed: { stroke: '#d91515', strokeDasharray: '6 4' },
  changed: { stroke: '#d98f00' },
};

/**
 * Edge labels are HTML rendered in a portal, outside React Flow's edge click
 * handling — clicking one must explicitly select the edge, so FlowView
 * provides the handler via context.
 */
export const EdgeLabelClickContext = createContext<
  ((id: string, data: AtlasEdgeData) => void) | undefined
>(undefined);

export function AnnotatedEdge(props: EdgeProps<AtlasEdge>): React.ReactElement {
  const onLabelClick = useContext(EdgeLabelClickContext);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    borderRadius: 12,
  });
  const kind = props.data?.edgeKind ?? 'route';
  // Read from `data`, never `props.style`: this component ignores the latter.
  const changeState = props.data?.changeState;
  const style: React.CSSProperties = {
    ...EDGE_STYLES[kind],
    ...(changeState ? CHANGE_STYLES[changeState] : {}),
    ...(props.selected ? { strokeWidth: 3 } : {}),
  };

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
        style={style}
        interactionWidth={16}
      />
      {props.data?.label && (
        <EdgeLabelRenderer>
          <div
            className={
              `edge-label edge-label-${kind} nodrag nopan ${props.selected ? 'is-selected' : ''}` +
              (changeState ? ` is-${changeState}` : '')
            }
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={() => props.data && onLabelClick?.(props.id, props.data)}
          >
            {props.data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
