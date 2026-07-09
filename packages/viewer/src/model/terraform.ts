import type { AtlasIndex } from '../data.js';
import type { AtlasGraph } from './graph-types.js';

/**
 * Post-pass over a built graph: stamp a "tf" badge on every resource node
 * that some imported Terraform stack claims. Runs centrally (App builds all
 * views through here) so the overview / VPC detail / focus builders don't
 * each need to know about Terraform.
 */
export function applyTerraformBadges(graph: AtlasGraph, index: AtlasIndex): AtlasGraph {
  if (index.terraform.length === 0) return graph;
  for (const node of graph.nodes) {
    if (node.data.isContainer || !node.data.refId) continue;
    const ref = index.byKey.get(node.data.refId);
    if (ref && index.terraformFor(ref).length > 0) {
      node.data.badges = [...(node.data.badges ?? []), 'tf'];
    }
  }
  return graph;
}
