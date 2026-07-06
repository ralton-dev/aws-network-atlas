import { useCallback, useMemo } from 'react';
import { Background, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import type { AtlasEdge, AtlasEdgeData, AtlasGraph, AtlasNode } from '../model/graph-types.js';
import { AnnotatedEdge, EdgeLabelClickContext } from './AnnotatedEdge.js';
import { ContainerNode, NoteNode, ResourceNode } from './nodes.js';

const nodeTypes = { resource: ResourceNode, container: ContainerNode, note: NoteNode };
const edgeTypes = { annotated: AnnotatedEdge };

export interface FlowViewProps {
  graph: AtlasGraph;
  /** Remount key — re-applies fitView when the view changes. */
  viewKey: string;
  selectedId?: string;
  selectedEdgeId?: string;
  onNodeClick(node: AtlasNode): void;
  onNodeDoubleClick(node: AtlasNode): void;
  onEdgeClick(edge: AtlasEdge): void;
  onPaneClick(): void;
}

export function FlowView(props: FlowViewProps): React.ReactElement {
  const nodes = useMemo(
    () =>
      props.graph.nodes.map((n) => ({
        ...n,
        selected: props.selectedId !== undefined && (n.id === props.selectedId || n.data.refId === props.selectedId),
      })),
    [props.graph.nodes, props.selectedId],
  );
  const edges = useMemo(
    () =>
      props.graph.edges.map((e) => ({
        ...e,
        selected: props.selectedEdgeId !== undefined && e.id === props.selectedEdgeId,
      })),
    [props.graph.edges, props.selectedEdgeId],
  );

  const { onEdgeClick } = props;
  const onLabelClick = useCallback(
    (id: string, data: AtlasEdgeData) => onEdgeClick({ id, data } as AtlasEdge),
    [onEdgeClick],
  );

  return (
    <EdgeLabelClickContext.Provider value={onLabelClick}>
    <ReactFlow
      key={props.viewKey}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1.15 }}
      minZoom={0.02}
      maxZoom={2.5}
      // d3-zoom's dblclick handler stops propagation before React sees the
      // event, which would break onNodeDoubleClick (our drill-down).
      zoomOnDoubleClick={false}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      selectNodesOnDrag={false}
      onNodeClick={(_, node) => props.onNodeClick(node as AtlasNode)}
      onNodeDoubleClick={(_, node) => props.onNodeDoubleClick(node as AtlasNode)}
      onEdgeClick={(_, edge) => props.onEdgeClick(edge as AtlasEdge)}
      onPaneClick={props.onPaneClick}
    >
      <Background gap={24} size={1.5} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={3} />
    </ReactFlow>
    </EdgeLabelClickContext.Provider>
  );
}
