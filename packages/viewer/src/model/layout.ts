import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { AtlasGraph, AtlasNode } from './graph-types.js';

const elk = new ELK();

const CONTAINER_PADDING = '[top=44.0,left=20.0,bottom=20.0,right=20.0]';

const ROOT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  // One layout pass across the whole Account>Region>VPC>AZ>Subnet hierarchy,
  // so cross-container edges (subnet -> TGW) position sensibly and every
  // container gets sized from its contents.
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.spacing.nodeNode': '28',
  'elk.spacing.componentComponent': '56',
  'elk.spacing.edgeLabel': '6',
};

const CONTAINER_OPTIONS: Record<string, string> = {
  'elk.padding': CONTAINER_PADDING,
  // Keep empty containers (e.g. subnets with nothing in them) visible.
  'elk.nodeSize.constraints': 'MINIMUM_SIZE',
  'elk.nodeSize.minimum': '(220.0,84.0)',
};

/**
 * Auto-layout via ELK: converts React Flow's flat parentId list into ELK's
 * nested structure, runs one layered layout pass, then copies positions
 * (ELK child coordinates are parent-relative — exactly React Flow's model)
 * and computed container sizes back onto the nodes.
 */
export async function layoutGraph(graph: AtlasGraph): Promise<AtlasGraph> {
  if (graph.nodes.length === 0) return graph;

  const childrenOf = new Map<string | undefined, AtlasNode[]>();
  for (const node of graph.nodes) {
    const list = childrenOf.get(node.parentId);
    if (list) list.push(node);
    else childrenOf.set(node.parentId, [node]);
  }

  const toElk = (node: AtlasNode): ElkNode => {
    const children = childrenOf.get(node.id);
    if (node.data.isContainer) {
      return {
        id: node.id,
        layoutOptions: CONTAINER_OPTIONS,
        children: (children ?? []).map(toElk),
      };
    }
    return { id: node.id, width: node.width ?? 150, height: node.height ?? 92 };
  };

  const elkEdges: ElkExtendedEdge[] = graph.edges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));

  const root: ElkNode = {
    id: 'root',
    layoutOptions: ROOT_OPTIONS,
    children: (childrenOf.get(undefined) ?? []).map(toElk),
    edges: elkEdges,
  };

  const laidOut = await elk.layout(root);

  // Collect positions/sizes, then emit nodes parents-before-children.
  const geo = new Map<string, { x: number; y: number; w?: number; h?: number }>();
  const walk = (elkNode: ElkNode): void => {
    for (const child of elkNode.children ?? []) {
      geo.set(child.id, {
        x: child.x ?? 0,
        y: child.y ?? 0,
        w: child.width,
        h: child.height,
      });
      walk(child);
    }
  };
  walk(laidOut);

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ordered: AtlasNode[] = [];
  const emit = (parentId: string | undefined): void => {
    for (const node of childrenOf.get(parentId) ?? []) {
      const g = geo.get(node.id);
      const updated: AtlasNode = {
        ...node,
        position: g ? { x: g.x, y: g.y } : node.position,
      };
      if (node.data.isContainer && g?.w && g.h) {
        updated.width = g.w;
        updated.height = g.h;
        updated.style = { ...node.style, width: g.w, height: g.h };
      }
      ordered.push(updated);
      if (byId.has(node.id)) emit(node.id);
    }
  };
  emit(undefined);

  return { nodes: ordered, edges: graph.edges };
}
