import { indexChangeSet, type ChangeSet } from '@atlas/proposal';

import type { AtlasEdge, AtlasGraph, AtlasNode, ChangeState } from './graph-types.js';

/**
 * The proposal overlay's post-pass (PROPOSAL-OVERLAY.md, decision 49): the
 * union of the graph built from the current index and the graph built from
 * the proposed one, with each node and edge stamped `changeState`.
 *
 * Both graphs come from the *same* builder (overview, VPC detail or focus),
 * called once per index exactly as `applyTerraformBadges` wraps it in
 * `App.tsx`; this function never looks at an index. It matches by id — the
 * builders' ids are deterministic (`acct:<id>`, `region:<acct>:<region>`,
 * `vpc:<id>`, `edge:<key>`), which is the whole premise; a builder that mints
 * an id from a counter or an array position would make every such node look
 * removed-and-added. For an id in:
 *
 * - **both** graphs: the *proposed* node or edge, stamped `changed` when its
 *   `refId` has an entry in `changes` (added, removed or changed — a shared
 *   resource can be touched in one account's copy only), or when its
 *   `label`, `subtitle` or `parentId` differ (edge: `label`, `source`,
 *   `target`). A node that moved parent — a leaf pushed into another lane
 *   because a display cap shifted (decision 58) — is drawn once, under its
 *   proposed parent, as `changed`.
 * - **proposed only**: stamped `added`.
 * - **current only**: stamped `removed`, under its current parent (which is
 *   either in both graphs or itself removed, so it is always present).
 *
 * Order is parents-before-children like the builders: the proposed graph's
 * nodes in its order, then the removed nodes in the current graph's order.
 * With nothing changed the result therefore deep-equals `current`.
 *
 * Returns a new graph: every node, edge, `data` and `position` object is a
 * fresh copy, so a later pass that writes to `data` (`applyTerraformBadges`
 * does) touches neither input. Nested values (`badges`, `errors`, `routes`,
 * `style`) are shared and must be treated as read-only. An edge with no `data`
 * is copied unstamped — the builders always set `data`, so this is never
 * expected to happen.
 */
export function diffGraphs(current: AtlasGraph, proposed: AtlasGraph, changes: ChangeSet): AtlasGraph {
  const touched = indexChangeSet(changes);
  const touchedRef = (refId: string | undefined): boolean => refId !== undefined && touched.has(refId);

  const currentNodes = new Map(current.nodes.map((n) => [n.id, n]));
  const proposedNodeIds = new Set(proposed.nodes.map((n) => n.id));
  const nodes: AtlasNode[] = [];
  for (const node of proposed.nodes) {
    const was = currentNodes.get(node.id);
    const state: ChangeState | undefined = !was
      ? 'added'
      : touchedRef(node.data.refId) ||
          was.data.label !== node.data.label ||
          was.data.subtitle !== node.data.subtitle ||
          was.parentId !== node.parentId
        ? 'changed'
        : undefined;
    nodes.push(copyNode(node, state));
  }
  for (const node of current.nodes) if (!proposedNodeIds.has(node.id)) nodes.push(copyNode(node, 'removed'));

  const currentEdges = new Map(current.edges.map((e) => [e.id, e]));
  const proposedEdgeIds = new Set(proposed.edges.map((e) => e.id));
  const edges: AtlasEdge[] = [];
  for (const edge of proposed.edges) {
    const was = currentEdges.get(edge.id);
    const state: ChangeState | undefined = !was
      ? 'added'
      : touchedRef(edge.data?.refId) ||
          was.data?.label !== edge.data?.label ||
          was.source !== edge.source ||
          was.target !== edge.target
        ? 'changed'
        : undefined;
    edges.push(copyEdge(edge, state));
  }
  for (const edge of current.edges) if (!proposedEdgeIds.has(edge.id)) edges.push(copyEdge(edge, 'removed'));

  return { nodes, edges };
}

function copyNode(node: AtlasNode, state: ChangeState | undefined): AtlasNode {
  return {
    ...node,
    position: { ...node.position },
    data: state ? { ...node.data, changeState: state } : { ...node.data },
  };
}

function copyEdge(edge: AtlasEdge, state: ChangeState | undefined): AtlasEdge {
  if (!edge.data) return { ...edge };
  return { ...edge, data: state ? { ...edge.data, changeState: state } : { ...edge.data } };
}
