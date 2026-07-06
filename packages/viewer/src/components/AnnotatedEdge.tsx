import { createContext, useContext } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import type { AtlasEdge, AtlasEdgeData, EdgeKind } from '../model/graph-types.js';

const EDGE_STYLES: Record<EdgeKind, React.CSSProperties> = {
  peering: { stroke: '#ed7100', strokeDasharray: '7 4', strokeWidth: 1.8 },
  tgw: { stroke: '#8c4fff', strokeWidth: 2 },
  vpn: { stroke: '#dd344c', strokeDasharray: '4 4', strokeWidth: 1.6 },
  dx: { stroke: '#7d8998', strokeWidth: 2 },
  route: { stroke: '#546e7a', strokeWidth: 1.4 },
  assoc: { stroke: '#a7b6bf', strokeDasharray: '2 4', strokeWidth: 1.2 },
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
  const style: React.CSSProperties = {
    ...EDGE_STYLES[kind],
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
            className={`edge-label edge-label-${kind} nodrag nopan ${props.selected ? 'is-selected' : ''}`}
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
