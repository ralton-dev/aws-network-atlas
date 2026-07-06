import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  type NodeChange,
} from '@xyflow/react';
import type { AtlasEdge, AtlasEdgeData, AtlasGraph, AtlasNode } from '../model/graph-types.js';
import {
  clearPositions,
  loadPositions,
  savePositions,
  type HiddenState,
} from '../model/view-state.js';
import { AnnotatedEdge, EdgeLabelClickContext } from './AnnotatedEdge.js';
import { ContainerNode, NoteNode, ResourceNode } from './nodes.js';

const nodeTypes = { resource: ResourceNode, container: ContainerNode, note: NoteNode };
const edgeTypes = { annotated: AnnotatedEdge };

export interface FlowViewProps {
  graph: AtlasGraph;
  /**
   * View identity. App remounts FlowView when it changes (key={viewKey}),
   * which re-seeds node state from the fresh ELK layout and re-applies
   * fitView — a clean reset with no effects needed.
   */
  viewKey: string;
  selectedId?: string;
  selectedEdgeId?: string;
  hidden: HiddenState;
  onNodeClick(node: AtlasNode): void;
  onNodeDoubleClick(node: AtlasNode): void;
  /** Right-click on a node hides it (App owns the hidden state). */
  onNodeHide(node: AtlasNode): void;
  onEdgeClick(edge: AtlasEdge): void;
  onPaneClick(): void;
}

/**
 * Seed the draggable node state from the ELK layout, overlaying any positions
 * the user saved for this view. Ordering (parents before children) and the
 * explicit container width/height in `style` are preserved untouched.
 */
function seedNodes(graph: AtlasGraph, viewKey: string): AtlasNode[] {
  const saved = loadPositions(viewKey);
  if (!saved) return graph.nodes;
  return graph.nodes.map((n) => {
    const pos = saved[n.id];
    return pos ? { ...n, position: pos } : n;
  });
}

export function FlowView(props: FlowViewProps): React.ReactElement {
  // Drag support: React Flow is controlled, so position changes only apply if
  // we hold the nodes in state and feed changes back via onNodesChange.
  const [nodes, setNodes] = useState<AtlasNode[]>(() => seedNodes(props.graph, props.viewKey));
  // Layout was customized (dragged now, or restored from a previous session).
  const [customized, setCustomized] = useState<boolean>(
    () => loadPositions(props.viewKey) !== undefined,
  );
  const [saveTick, setSaveTick] = useState(0);

  const onNodesChange = useCallback((changes: NodeChange<AtlasNode>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onNodeDragStop = useCallback(() => {
    setCustomized(true);
    setSaveTick((t) => t + 1);
  }, []);

  // Persist positions after a drag ends (state already holds the final
  // position by the time this effect runs).
  useEffect(() => {
    if (saveTick === 0) return;
    savePositions(
      props.viewKey,
      Object.fromEntries(nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }])),
    );
  }, [saveTick, nodes, props.viewKey]);

  const resetLayout = useCallback(() => {
    clearPositions(props.viewKey);
    setSaveTick(0);
    setCustomized(false);
    setNodes(props.graph.nodes);
  }, [props.graph.nodes, props.viewKey]);

  // Merge `selected` + `hidden` onto the base state nodes at render time.
  // Nodes are ordered parents-before-children, so one pass suffices to
  // propagate hiddenness down the container hierarchy (hiding a container
  // hides everything inside it).
  const { renderNodes, hiddenIds } = useMemo(() => {
    const { nodeIds, nodeKinds } = props.hidden;
    const hiddenIdsAcc = new Set<string>();
    const rendered = nodes.map((n) => {
      const isHidden =
        nodeIds.has(n.id) ||
        (n.data.refId !== undefined && nodeIds.has(n.data.refId)) ||
        nodeKinds.has(n.data.kind) ||
        (n.parentId !== undefined && hiddenIdsAcc.has(n.parentId));
      if (isHidden) hiddenIdsAcc.add(n.id);
      return {
        ...n,
        hidden: isHidden,
        selected:
          !isHidden &&
          props.selectedId !== undefined &&
          (n.id === props.selectedId || n.data.refId === props.selectedId),
      };
    });
    return { renderNodes: rendered, hiddenIds: hiddenIdsAcc };
  }, [nodes, props.selectedId, props.hidden]);

  // An edge is hidden when either endpoint is hidden or its kind is toggled off.
  const renderEdges = useMemo(
    () =>
      props.graph.edges.map((e) => ({
        ...e,
        hidden:
          hiddenIds.has(e.source) ||
          hiddenIds.has(e.target) ||
          props.hidden.edgeKinds.has(e.data?.edgeKind ?? 'route'),
        selected: props.selectedEdgeId !== undefined && e.id === props.selectedEdgeId,
      })),
    [props.graph.edges, props.selectedEdgeId, props.hidden.edgeKinds, hiddenIds],
  );

  const { onEdgeClick, onNodeHide } = props;
  const onLabelClick = useCallback(
    (id: string, data: AtlasEdgeData) => onEdgeClick({ id, data } as AtlasEdge),
    [onEdgeClick],
  );

  return (
    <EdgeLabelClickContext.Provider value={onLabelClick}>
    <ReactFlow
      nodes={renderNodes}
      edges={renderEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1.15 }}
      minZoom={0.02}
      maxZoom={2.5}
      // d3-zoom's dblclick handler stops propagation before React sees the
      // event, which would break onNodeDoubleClick (our drill-down).
      zoomOnDoubleClick={false}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
      selectNodesOnDrag={false}
      onNodeClick={(_, node) => props.onNodeClick(node as AtlasNode)}
      onNodeDoubleClick={(_, node) => props.onNodeDoubleClick(node as AtlasNode)}
      onNodeDragStop={onNodeDragStop}
      onNodeContextMenu={(event, node) => {
        event.preventDefault();
        onNodeHide(node as AtlasNode);
      }}
      onEdgeClick={(_, edge) => props.onEdgeClick(edge as AtlasEdge)}
      onPaneClick={props.onPaneClick}
    >
      <Background gap={24} size={1.5} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={3} />
      {customized && (
        <Panel position="top-right">
          <button className="flow-reset-btn" onClick={resetLayout} title="Restore the automatic layout">
            Reset layout
          </button>
        </Panel>
      )}
    </ReactFlow>
    </EdgeLabelClickContext.Provider>
  );
}
